/**
 * REC-01: the daily close runs at each merchant's configured WAT time.  This
 * in-process scheduler looks for due closes every tick and runs each one in
 * its own system transaction through the scoped repository, so a close never
 * bypasses the tenant predicate or the merchant lock, and one lender's failure
 * never touches another.  A close missed while the process was down runs at
 * the first tick after recovery and is recorded as late (NFR-AVA-02); every
 * run carries a correlation id in its log lines (NFR-OBS-01).
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
/** Recorded when the process is told not to schedule closes (VALOPAY_CLOSE_SCHEDULER=off), so the health answer says so. */
export function markSchedulerOff(): void { status.state = "off"; }
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
 * spent or the pass is told to stop.  Closed, paused and failed lenders leave
 * the due set by themselves (a failure is recorded with its retry time); a
 * skipped lender, or a failure that could not be recorded, is left out of the
 * pass's later batches.
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
    status.ticks += 1;
    status.lastTickAt = new Date().toISOString();
    const started = Date.now();
    running = runDueCloses({ batchSize: options.batchSize, log: options.log, onlyMerchantIds: options.onlyMerchantIds, budgetMs, signal: stopping.signal })
      .then((run) => {
        status.lastSuccessAt = new Date().toISOString();
        status.lastErrorAt = null;
        if (run.examined || run.failed.length) status.lastRun = { runId: run.runId, at: new Date().toISOString(), durationMs: Date.now() - started, initialised: run.initialised, batches: run.batches, examined: run.examined, closed: run.closed.length, skipped: run.skipped.length, paused: run.paused.length, failed: run.failed.length };
        return run;
      })
      .catch((error: unknown) => { status.lastErrorAt = new Date().toISOString(); options.log?.error({ event: "close.tick_failed", err: error }, "scheduled close tick failed"); return null; })
      .finally(() => { running = null; });
    return running;
  };
  // The first look comes soon after start, so a close missed while the process was down catches up (NFR-AVA-02).
  const first = setTimeout(tick, options.firstDelayMs ?? Math.min(intervalMs, 5_000));
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  status.state = "running";
  status.intervalMs = intervalMs;
  options.log?.info({ event: "scheduler.started", intervalMs, batchSize: options.batchSize ?? closeRules.batchSize, passBudgetMs: budgetMs }, "scheduled daily close running");
  return {
    stop() { clearTimeout(first); clearInterval(timer); stopping.abort(); status.state = "stopped"; },
    tick,
    settle() { return running ? running.then(() => undefined) : Promise.resolve(); },
  };
}
