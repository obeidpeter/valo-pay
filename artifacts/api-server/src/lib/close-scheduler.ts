/**
 * REC-01: the daily close runs at each merchant's configured WAT time.  This
 * in-process scheduler looks for due closes every tick and runs each one in
 * its own system transaction through the scoped repository, so a close never
 * bypasses the tenant predicate or the merchant lock, and one lender's failure
 * never touches another.  A close missed while the process was down runs at
 * the first tick after recovery and is recorded as late (NFR-AVA-02); every
 * run carries a correlation id in its log lines (NFR-OBS-01).
 */
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { closeRules } from "@workspace/valopay-schema";
import { SYSTEM_ACTOR_PREFIX, appendAudit, canonical, digest, dueScheduledCloses, inMerchantAsSystem, initialiseCloseCursors, loadState, saveState } from "./valopay-store";
import { runDailyClose } from "../domain/actions";
import { scheduledCloseDue } from "../domain/close";
import { enrolEligibleFailures } from "../domain/policy-engine";

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
  lastRun: { runId: string; at: string; durationMs: number; initialised: number; examined: number; closed: number; skipped: number; failed: number } | null;
}
const status: SchedulerStatus = { state: "not_started", intervalMs: null, ticks: 0, lastTickAt: null, lastRun: null };
/** A copy of the scheduler's state, for the health answer. */
export function schedulerStatus(): SchedulerStatus { return structuredClone(status); }
/** Recorded when the process is told not to schedule closes (VALOPAY_CLOSE_SCHEDULER=off), so the health answer says so. */
export function markSchedulerOff(): void { status.state = "off"; }
/** What one scheduler pass did. */
export interface CloseRun {
  runId: string;
  /** Legacy merchants given a cursor on this pass. */
  initialised: number;
  /** Merchants the batch found due. */
  examined: number;
  closed: ClosedMerchant[];
  /** Due when read, but closed meanwhile or locked by a request or another instance. */
  skipped: string[];
  failed: Array<{ merchantId: string; error: string }>;
}

/** One pass: give legacy merchants a cursor, then close every due merchant in the batch, each in its own transaction. */
export async function runDueCloses(options: { batchSize?: number; log?: Logger } = {}): Promise<CloseRun> {
  const run: CloseRun = { runId: randomUUID(), initialised: 0, examined: 0, closed: [], skipped: [], failed: [] };
  const started = Date.now();
  const log = options.log?.child({ job: "scheduled_close", runId: run.runId });
  run.initialised = await initialiseCloseCursors();
  const due = await dueScheduledCloses(options.batchSize ?? closeRules.batchSize);
  run.examined = due.length;
  for (const merchantId of due) {
    try {
      const outcome = await inMerchantAsSystem(merchantId, SCHEDULED_CLOSE_ACTOR, async (ctx) => {
        const state = await loadState(ctx, merchantId, "update");
        // Re-checked under the lock: a person or another instance may have closed since the batch was read.
        if (!scheduledCloseDue(state, ctx.now)) return null;
        const before = structuredClone(state);
        const result = runDailyClose(state, ctx, "scheduled");
        enrolEligibleFailures(state, ctx);
        appendAudit(state, ctx, "daily_close", result.record!.id, result.message, { beforeDigest: digest(canonical(before)), afterDigest: digest(canonical(state)) });
        await saveState(ctx, state);
        const schedule = result.data.schedule as { late?: boolean; delayMinutes?: number | null } | undefined;
        return { closeId: result.record!.id, late: schedule?.late === true, delayMinutes: schedule?.delayMinutes ?? null };
      });
      if (outcome) {
        run.closed.push({ merchantId, ...outcome });
        log?.info({ merchantId, ...outcome }, "scheduled daily close completed");
      } else {
        run.skipped.push(merchantId);
      }
    } catch (error) {
      run.failed.push({ merchantId, error: error instanceof Error ? error.message : String(error) });
      log?.error({ merchantId, err: error }, "scheduled daily close failed");
    }
  }
  if (run.initialised) log?.info({ initialised: run.initialised }, "close cursors initialised for merchants that had none");
  // One line per pass that found work, with its duration; a quiet pass is a debug line so the log is not a metronome.
  const summary = { event: "close.run", durationMs: Date.now() - started, initialised: run.initialised, examined: run.examined, closed: run.closed.length, skipped: run.skipped.length, failed: run.failed.length };
  if (run.examined || run.failed.length) log?.info(summary, "scheduled close pass finished"); else log?.debug(summary, "scheduled close pass found nothing due");
  return run;
}

/** The running scheduler: stop it, run a pass now, or wait for the pass in progress. */
export interface CloseScheduler {
  stop(): void;
  /** Runs a pass now, or joins the pass already running. */
  tick(): Promise<CloseRun | null>;
  /** Waits for the pass in progress, if any, without starting one: what a shutdown does before it ends the pool. */
  settle(): Promise<void>;
}

/** Starts the tick loop.  Ticks never overlap, and the timers are unreferenced so they never hold the process open. */
export function startCloseScheduler(options: { intervalMs?: number; firstDelayMs?: number; batchSize?: number; log?: Logger } = {}): CloseScheduler {
  const intervalMs = options.intervalMs ?? closeRules.tickSeconds * 1000;
  let running: Promise<CloseRun | null> | null = null;
  const tick = (): Promise<CloseRun | null> => {
    if (running) return running;
    status.ticks += 1;
    status.lastTickAt = new Date().toISOString();
    const started = Date.now();
    running = runDueCloses(options)
      .then((run) => {
        if (run.examined || run.failed.length) status.lastRun = { runId: run.runId, at: new Date().toISOString(), durationMs: Date.now() - started, initialised: run.initialised, examined: run.examined, closed: run.closed.length, skipped: run.skipped.length, failed: run.failed.length };
        return run;
      })
      .catch((error: unknown) => { options.log?.error({ event: "close.tick_failed", err: error }, "scheduled close tick failed"); return null; })
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
  options.log?.info({ event: "scheduler.started", intervalMs, batchSize: options.batchSize ?? closeRules.batchSize }, "scheduled daily close running");
  return {
    stop() { clearTimeout(first); clearInterval(timer); status.state = "stopped"; },
    tick,
    settle() { return running ? running.then(() => undefined) : Promise.resolve(); },
  };
}
