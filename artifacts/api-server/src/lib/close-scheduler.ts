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

export const SCHEDULED_CLOSE_ACTOR = `${SYSTEM_ACTOR_PREFIX}scheduled close`;

export interface ClosedMerchant { merchantId: string; closeId: string; late: boolean; delayMinutes: number | null }
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
  return run;
}

export interface CloseScheduler {
  stop(): void;
  /** Runs a pass now, or joins the pass already running. */
  tick(): Promise<CloseRun | null>;
}

/** Starts the tick loop.  Ticks never overlap, and the timers are unreferenced so they never hold the process open. */
export function startCloseScheduler(options: { intervalMs?: number; firstDelayMs?: number; batchSize?: number; log?: Logger } = {}): CloseScheduler {
  const intervalMs = options.intervalMs ?? closeRules.tickSeconds * 1000;
  let running: Promise<CloseRun | null> | null = null;
  const tick = (): Promise<CloseRun | null> => {
    if (running) return running;
    running = runDueCloses(options)
      .catch((error: unknown) => { options.log?.error({ err: error }, "scheduled close tick failed"); return null; })
      .finally(() => { running = null; });
    return running;
  };
  // The first look comes soon after start, so a close missed while the process was down catches up (NFR-AVA-02).
  const first = setTimeout(tick, options.firstDelayMs ?? Math.min(intervalMs, 5_000));
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  options.log?.info({ intervalMs, batchSize: options.batchSize ?? closeRules.batchSize }, "scheduled daily close running");
  return { stop() { clearTimeout(first); clearInterval(timer); }, tick };
}
