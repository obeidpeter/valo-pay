import { DatabaseLimitError } from './database-limits';
import { markRolledBack } from './transaction-outcome';

/**
 * A per-process cap on how many transactions one lane (a lender, or a tenant)
 * may hold at once. Requests for a busy lender used to take a connection each
 * and then wait for its lock, until they held the whole pool and every other
 * tenant, and the readiness check, waited behind them. A request past the cap
 * waits here, in arrival order and without a connection, for at most the wait
 * limit (or the wait it is given), then is turned away with a 503 that says
 * nothing was saved.
 */
export function createLenderGate(options: { capacity: number; waitMs: () => number; maxWaiting?: number }) {
  const maxWaiting = options.maxWaiting ?? 50;
  const lanes = new Map<string, { active: number; waiting: Array<() => void> }>();
  const busy = (write: boolean) => markRolledBack(new DatabaseLimitError('lender_busy', { write }));
  /** Leaving hands the slot to the longest waiter, or frees it; a second call does nothing. */
  function leaver(lender: string, lane: { active: number; waiting: Array<() => void> }): () => void {
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const next = lane.waiting.shift();
      if (next) next();
      else if (--lane.active === 0) lanes.delete(lender);
    };
  }
  return {
    /** Resolves with the function that leaves once the request's transaction has ended. */
    enter(lender: string, write: boolean, waitMs = options.waitMs()): Promise<() => void> {
      let lane = lanes.get(lender);
      if (!lane) lanes.set(lender, lane = { active: 0, waiting: [] });
      const current = lane;
      if (current.active < options.capacity) { current.active += 1; return Promise.resolve(leaver(lender, current)); }
      if (current.waiting.length >= maxWaiting) return Promise.reject(busy(write));
      return new Promise((resolve, reject) => {
        const grant = () => { clearTimeout(timer); resolve(leaver(lender, current)); };
        const timer = setTimeout(() => {
          const at = current.waiting.indexOf(grant);
          if (at >= 0) current.waiting.splice(at, 1);
          reject(busy(write));
        }, waitMs);
        current.waiting.push(grant);
      });
    },
    /** How many transactions hold the lender's slots and how many wait, for tests. */
    load(lender: string): { active: number; waiting: number } {
      const lane = lanes.get(lender);
      return { active: lane?.active ?? 0, waiting: lane?.waiting.length ?? 0 };
    },
  };
}
