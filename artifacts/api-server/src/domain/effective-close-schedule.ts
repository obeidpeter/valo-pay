import { closeSchedule } from "./close";
import type { DomainState } from "./types";

/** Only process health is exposed here; no other lender's runs or errors. */
export interface CloseRuntime {
  state: "not_started" | "running" | "off" | "stopped";
  intervalMs: number | null;
  lastTickAt: string | null;
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  /** Clock from the process that owns this heartbeat, separate from the database schedule clock. */
  observedAt?: string;
}

/** A requested lender schedule is effective only while its service is healthy. */
export function effectiveCloseSchedule(state: DomainState, now: string, runtime: CloseRuntime) {
  const schedule = closeSchedule(state, now);
  const lastSuccessAt = runtime.lastSuccessAt ?? null;
  const failed = Boolean(runtime.lastErrorAt && (!lastSuccessAt || runtime.lastErrorAt >= lastSuccessAt));
  const stale = lastSuccessAt !== null && Date.parse(runtime.observedAt ?? now) - Date.parse(lastSuccessAt) > Math.max(120_000, (runtime.intervalMs ?? 60_000) * 3);
  const serviceIssue = runtime.state !== "running" ? null : failed ? "failed" : !lastSuccessAt ? "starting" : stale ? "delayed" : null;
  const automatic = schedule.enabled && runtime.state === "running" && serviceIssue === null;
  return {
    ...schedule,
    runtimeState: runtime.state,
    automatic,
    nextAt: automatic ? schedule.nextAt : null,
    // Preserve overdue work when the service is unhealthy, but not when scheduling is deliberately off.
    missed: schedule.missed && runtime.state !== "off",
    serviceIssue,
    lastCheckedAt: lastSuccessAt,
    lastErrorAt: runtime.lastErrorAt ?? null,
  };
}
