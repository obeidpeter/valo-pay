import { buildAlerts, type AuditVerification } from "../domain/alerts";
import { buildOverview, buildReports } from "../domain/reports";
import { effectiveCloseSchedule, type CloseRuntime } from "../domain/effective-close-schedule";
import type { DomainState } from "../domain/types";
import { getSettings } from "./valopay-readiness";
import { settingsRevision } from "./edit-versions";

/** Public console projections combine lender preferences with the actual running service. */
export function buildConsoleOverview(state: DomainState, now: string, audit: AuditVerification, runtime: CloseRuntime) {
  const schedule = effectiveCloseSchedule(state, now, runtime);
  const alerts = buildAlerts(state, now, audit).filter(alert => alert.key !== "close_missed" || schedule.missed);
  return { ...buildOverview(state, now, alerts), lastClose: schedule.lastAt ?? "", nextClose: schedule.nextAt ?? "", closeSchedule: schedule };
}

export function buildConsoleReports(state: DomainState, now: string, runtime: CloseRuntime) {
  const report = buildReports(state, now);
  return { ...report, operational: { ...report.operational, closeSchedule: effectiveCloseSchedule(state, now, runtime) } };
}

export function buildConsoleSettings(state: DomainState, role: string, now: string, runtime: CloseRuntime) {
  return { ...getSettings(state, role), revision: settingsRevision(state.settings), closeSchedule: effectiveCloseSchedule(state, now, runtime) };
}
