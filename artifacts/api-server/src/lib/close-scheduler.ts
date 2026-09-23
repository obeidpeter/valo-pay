/**
 * REC-01: the daily close runs at each merchant's configured WAT time.  This
 * scheduler, which the API runs on its background worker thread
 * (background.ts) so a long close never holds up a request, looks for due
 * closes every tick and runs each one in its own system transaction through
 * the scoped repository, so a close never bypasses the tenant predicate or the
 * merchant lock, and one lender's failure never touches another.  A close
 * missed while the process was down runs at the first tick after recovery and
 * is recorded as late (NFR-AVA-02); when several business dates were missed,
 * each gets its own catch-up close, one per pass, oldest first.  Every run
 * carries a correlation id in its log lines (NFR-OBS-01).
 *
 * A pass reads due lenders in batches until none is left or its time budget
 * is spent, in a fair order (dueScheduledCloses): staff and signed-in lenders
 * before anonymous sandboxes and, within each, lenders being retried after
 * the rest, then one lender per workspace per turn.  A
 * failed close is recorded on the lender and retried after 2, 4, 8 … minutes,
 * at most hourly, so a lender that keeps failing never holds the others back;
 * the close stays pending until an attempt succeeds.  An anonymous sandbox
 * nobody has changed for closeRules.idleSandboxDays has its automatic close
 * switched off instead of run.  A stop ends the pass after the lender in
 * progress; the rest are still due at the next start.
 */
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { closeRules } from "@workspace/valopay-schema";
import { SYSTEM_ACTOR_PREFIX, appendAudit, dueScheduledCloses, inMerchantAsSystem, initialiseCloseCursors, loadState, recordScheduledCloseFailure, sandboxInactiveFor, saveState, settleChanges } from "./valopay-store";
import { runDailyClose } from "../domain/actions";
import { pauseIdleSandboxClose, scheduledCloseDue } from "../domain/close";
import { enrolEligibleFailures } from "../domain/policy-engine";
import { bindCloseReviewBasis } from '../domain/close-review';

/** The system actor recorded on a scheduled close. */
export const SCHEDULED_CLOSE_ACTOR = `${SYSTEM_ACTOR_PREFIX}scheduled close`;

/** One lender closed by a pass. */
export interface ClosedMerchant { merchantId: string; closeId: string; late: boolean; delayMinutes: number | null }

/** What the scheduler is doing, for /api/healthz: whether it ticks, when it last looked, and what its last pass that found work did. */
export interface SchedulerStatus {
  state: "not_started" | "running" | "off" | "stopped";
  intervalMs: number | null;
  ticks: number;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastRun: { runId: string; at: string; durationMs: number; initialised: number; batches: number; examined: number; closed: number; skipped: number; paused: number; failed: number } | null;
}
const status: SchedulerStatus = { state: "not_started", intervalMs: null, ticks: 0, lastTickAt: null, lastSuccessAt: null, lastErrorAt: null, lastRun: null };
/** A copy of the scheduler's state, for the health answer. */
export function schedulerStatus(): SchedulerStatus & { observedAt: string } { return { ...structuredClone(status), observedAt: new Date().toISOString() }; }
/**
 * One change to the scheduler's state: it started, a pass began, a pass
 * returned (with its counts when it found work) or failed, it stopped, or this
 * process schedules no closes.
 */
export type SchedulerEvent =
  | { type: "started"; intervalMs: number }
  | { type: "ticked"; at: string }
  | { type: "succeeded"; at: string; run: SchedulerStatus["lastRun"] }
  | { type: "failed"; at: string }
  | { type: "stopped" }
  | { type: "off" };
const observers = new Set<(event: SchedulerEvent) => void>();
/**
 * Applies a change to this thread's scheduler state and passes it to the
 * observers. The scheduler runs on the background worker thread, which
 * observes its own changes and posts them to the main thread; the main thread
 * applies them here, so /api/healthz and the console read the state where they
 * answer (background-worker.ts).
 */
export function applySchedulerEvent(event: SchedulerEvent): void {
  if (event.type === "started") { status.state = "running"; status.intervalMs = event.intervalMs; }
  else if (event.type === "ticked") { status.ticks += 1; status.lastTickAt = event.at; }
  else if (event.type === "succeeded") { status.lastSuccessAt = event.at; status.lastErrorAt = null; if (event.run) status.lastRun = event.run; }
  else if (event.type === "failed") status.lastErrorAt = event.at;
  else if (event.type === "stopped") status.state = "stopped";
  else status.state = "off";
  for (const observer of observers) observer(event);
}
/** Calls `observer` with every later change to this thread's scheduler state; returns what ends that. */
export function observeScheduler(observer: (event: SchedulerEvent) => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}
/** Recorded when the process is told not to schedule closes (VALOPAY_CLOSE_SCHEDULER=off), so the health answer says so. */
export function markSchedulerOff(): void { applySchedulerEvent({ type: "off" }); }
/** What one scheduler pass did. */
export interface CloseRun {
  runId: string;
  /** Legacy merchants given a cursor on this pass. */
  initialised: number;
  /** Batches of due lenders read. */
  batches: number;
  /** Due lenders the pass took up; each ends closed, skipped, paused or failed. */
  examined: number;
  closed: ClosedMerchant[];
  /** Due when read, but closed meanwhile, waiting for a retry, or locked by a request or another instance. */
  skipped: string[];
  /** Lenders of idle anonymous sandboxes whose automatic close was switched off instead of run. */
  paused: string[];
  /** Failed closes; once recorded, `failures` counts the failed attempts at this close time and `retryAt` is the next. */
  failed: Array<{ merchantId: string; error: string; failures?: number; retryAt?: string }>;
}

/** How a pass runs.  `onlyMerchantIds` limits it to the lenders named, for tests and operator tooling. */
export interface CloseRunOptions {
  batchSize?: number;
  log?: Logger;
  /** No lender's close starts after this long; default closeRules.passBudgetSeconds. */
  budgetMs?: number;
  /** Once aborted, the pass ends after the lender in progress. */
  signal?: AbortSignal;
  onlyMerchantIds?: readonly string[];
}

type Outcome = Omit<ClosedMerchant, "merchantId"> | { paused: true };

/**
 * One pass: give legacy merchants a cursor, then close due merchants batch
 * after batch, each in its own transaction, until none is due, the budget is
 * spent or the pass is told to stop.  Paused and failed lenders leave the due
 * set by themselves (a failure is recorded with its retry time); a skipped
 * lender, or a failure that could not be recorded, is left out of the pass's
 * later batches.  So is a closed lender: one still owed missed business dates
 * stays due, and gets one catch-up close per pass, the oldest date first.
 */
export async function runDueCloses(options: CloseRunOptions = {}): Promise<CloseRun> {
  const run: CloseRun = { runId: randomUUID(), initialised: 0, batches: 0, examined: 0, closed: [], skipped: [], paused: [], failed: [] };
  const started = Date.now();
  const batchSize = options.batchSize ?? closeRules.batchSize, budgetMs = options.budgetMs ?? closeRules.passBudgetSeconds * 1000;
  const log = options.log?.child({ job: "scheduled_close", runId: run.runId });
  const spent = () => options.signal?.aborted === true || Date.now() - started >= budgetMs;
  run.initialised = await initialiseCloseCursors();
  const exclude = new Set<string>();
  while (!spent()) {
    const due = await dueScheduledCloses(batchSize, { exclude: [...exclude], only: options.onlyMerchantIds });
    run.batches += 1;
    for (const merchantId of due) {
      if (spent()) break;
      run.examined += 1;
      try {
        const outcome = await inMerchantAsSystem<Outcome | null>(merchantId, SCHEDULED_CLOSE_ACTOR, async (ctx) => {
          const state = await loadState(ctx, merchantId, "update");
          // Re-checked under the lock: a person or another instance may have closed since the batch was read, or recorded a failure.
          if (!scheduledCloseDue(state, ctx.now)) return null;
          if (state.settings.anonymousWorkspace === true && await sandboxInactiveFor(ctx, closeRules.idleSandboxDays)) {
            pauseIdleSandboxClose(state, ctx.now);
            appendAudit(state, ctx, "daily_close.paused", "settings", `Automatic daily close paused: nobody changed this sandbox for ${closeRules.idleSandboxDays} days. Switch it on again in Settings to resume.`, settleChanges(ctx, state));
            await saveState(ctx, state);
            return { paused: true };
          }
          const result = runDailyClose(state, ctx, "scheduled");
          enrolEligibleFailures(state, ctx);
          if(result.record?.kind==='closes')bindCloseReviewBasis(state,result.record);
          appendAudit(state, ctx, "daily_close", result.record!.id, result.message, settleChanges(ctx, state));
          await saveState(ctx, state);
          const schedule = result.data.schedule as { late?: boolean; delayMinutes?: number | null } | undefined;
          return { closeId: result.record!.id, late: schedule?.late === true, delayMinutes: schedule?.delayMinutes ?? null };
        });
        if (!outcome) {
          run.skipped.push(merchantId);
          exclude.add(merchantId);
        } else if ("paused" in outcome) {
          run.paused.push(merchantId);
          log?.info({ merchantId, idleDays: closeRules.idleSandboxDays }, "scheduled daily close paused for an idle sandbox");
        } else {
          run.closed.push({ merchantId, ...outcome });
          exclude.add(merchantId);
          log?.info({ merchantId, ...outcome }, "scheduled daily close completed");
        }
      } catch (error) {
        const retry = await recordScheduledCloseFailure(merchantId).catch((recordError: unknown) => {
          log?.error({ merchantId, err: recordError }, "scheduled close failure could not be recorded");
          return undefined;
        });
        if (!retry) exclude.add(merchantId);
        run.failed.push({ merchantId, error: error instanceof Error ? error.message : String(error), ...(retry ? { failures: retry.failures, retryAt: retry.retryAt } : {}) });
        log?.error({ merchantId, err: error, failures: retry?.failures, retryAt: retry?.retryAt }, "scheduled daily close failed");
      }
    }
    if (due.length < batchSize) break;
  }
  if (run.initialised) log?.info({ initialised: run.initialised }, "close cursors initialised for merchants that had none");
  // One line per pass that found work, with its duration; a quiet pass is a debug line so the log is not a metronome.
  const summary = { event: "close.run", durationMs: Date.now() - started, initialised: run.initialised, batches: run.batches, examined: run.examined, closed: run.closed.length, skipped: run.skipped.length, paused: run.paused.length, failed: run.failed.length };
  if (run.examined || run.failed.length) log?.info(summary, "scheduled close pass finished"); else log?.debug(summary, "scheduled close pass found nothing due");
  return run;
}

/**
 * How long a one-shot pass (close-pass.ts) may keep starting closes. A host
 * that runs no in-process scheduler runs it every few minutes, so it can
 * drain a longer backlog than an in-process pass, which must finish before
 * the next tick; a close that has started is always finished.
 */
export const ONE_SHOT_PASS_BUDGET_MS = 10 * 60_000;
/** What a one-shot pass did, and the exit status that says so. */
export interface OneShotCloseRun {
  /** 0: every due lender was closed, paused or left to another process; 2: the pass finished but at least one close failed (recorded and retried by a later pass); 1: the pass could not run, or was stopped before it finished. */
  exitCode: 0 | 1 | 2;
  run: CloseRun | null;
}

/**
 * The scheduled daily close run once, for a host that runs no in-process
 * scheduler (VALOPAY_CLOSE_SCHEDULER=off), such as a Replit Scheduled
 * Deployment next to an Autoscale deployment: the same pass the tick loop
 * runs (runDueCloses), through the same repository, locks and audit, with a
 * longer budget, ending with one close.one_shot line that carries its exit
 * status. Another process closing at the same time never closes the same
 * lender twice (SKIP LOCKED, and each close re-checks under its lock).
 */
export async function runClosePassOnce(options: CloseRunOptions = {}, pass: (options: CloseRunOptions) => Promise<CloseRun> = runDueCloses): Promise<OneShotCloseRun> {
  const started = Date.now();
  try {
    const run = await pass({ ...options, budgetMs: options.budgetMs ?? ONE_SHOT_PASS_BUDGET_MS });
    const stopped = options.signal?.aborted === true;
    const exitCode = stopped ? 1 : run.failed.length ? 2 : 0;
    const fields = { event: "close.one_shot", exitCode, runId: run.runId, durationMs: Date.now() - started, stopped, examined: run.examined, closed: run.closed.length, skipped: run.skipped.length, paused: run.paused.length, failed: run.failed.length };
    if (exitCode === 0) options.log?.info(fields, "One-shot close pass finished");
    else options.log?.error(fields, stopped ? "One-shot close pass stopped before it finished; the lenders it did not reach are still due" : "One-shot close pass finished, but some closes failed; each is retried by a later pass");
    return { exitCode, run };
  } catch (error) {
    options.log?.error({ event: "close.one_shot", exitCode: 1, durationMs: Date.now() - started, err: error }, "One-shot close pass could not read what was due");
    return { exitCode: 1, run: null };
  }
}

/** The running scheduler: stop it, run a pass now, or wait for the pass in progress. */
export interface CloseScheduler {
  /** Stops the timers and ends the pass in progress after the lender it is closing. */
  stop(): void;
  /** Runs a pass now, or joins the pass already running. */
  tick(): Promise<CloseRun | null>;
  /** Waits for the pass in progress, if any, without starting one: what a shutdown does before it ends the pool. */
  settle(): Promise<void>;
}

/**
 * Starts the tick loop.  Ticks never overlap, and the timers are unreferenced
 * so they never hold the process open.  A pass's budget is at most three
 * quarters of the interval, so it has finished by the next tick.
 */
export function startCloseScheduler(options: { intervalMs?: number; firstDelayMs?: number } & Omit<CloseRunOptions, "signal"> = {}): CloseScheduler {
  const intervalMs = options.intervalMs ?? closeRules.tickSeconds * 1000;
  const budgetMs = options.budgetMs ?? Math.min(closeRules.passBudgetSeconds * 1000, Math.round(intervalMs * 0.75));
  const stopping = new AbortController();
  let running: Promise<CloseRun | null> | null = null;
  const tick = (): Promise<CloseRun | null> => {
    if (running) return running;
    applySchedulerEvent({ type: "ticked", at: new Date().toISOString() });
    const started = Date.now();
    running = runDueCloses({ batchSize: options.batchSize, log: options.log, onlyMerchantIds: options.onlyMerchantIds, budgetMs, signal: stopping.signal })
      .then((run) => {
        const at = new Date().toISOString();
        applySchedulerEvent({ type: "succeeded", at, run: run.examined || run.failed.length ? { runId: run.runId, at, durationMs: Date.now() - started, initialised: run.initialised, batches: run.batches, examined: run.examined, closed: run.closed.length, skipped: run.skipped.length, paused: run.paused.length, failed: run.failed.length } : null });
        return run;
      })
      .catch((error: unknown) => { applySchedulerEvent({ type: "failed", at: new Date().toISOString() }); options.log?.error({ event: "close.tick_failed", err: error }, "scheduled close tick failed"); return null; })
      .finally(() => { running = null; });
    return running;
  };
  // The first look comes soon after start, so a close missed while the process was down catches up (NFR-AVA-02).
  const first = setTimeout(tick, options.firstDelayMs ?? Math.min(intervalMs, 5_000));
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  applySchedulerEvent({ type: "started", intervalMs });
  options.log?.info({ event: "scheduler.started", intervalMs, batchSize: options.batchSize ?? closeRules.batchSize, passBudgetMs: budgetMs }, "scheduled daily close running");
  return {
    stop() { clearTimeout(first); clearInterval(timer); stopping.abort(); applySchedulerEvent({ type: "stopped" }); },
    tick,
    settle() { return running ? running.then(() => undefined) : Promise.resolve(); },
  };
}
