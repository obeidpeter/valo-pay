/**
 * NFR-OBS-02 alerts computed from the lender's state: the conditions the TRD
 * routes to the on-call phone that this sandbox can observe.  Alerts are
 * derived on every read and frozen into each daily close; they are never
 * stored on their own.
 */
import { counted, alertRules, deadlinePassed, isBillableChannel, isOpenException, paymentAwaitsAllocation, type AlertSeverity } from "@workspace/valopay-schema";
import { recordsOf } from "./records";
import type { DomainState } from "./types";
import { paymentObservedAt } from "./reconciliation";
import { closeSchedule, owedCloseDates, positionMismatches } from "./close";
import { attemptTime } from "./policy-engine";
import { collectionSucceeded, monthOf } from "./billing";
import { exportHealth } from '../lib/export-jobs';

const DAY_MS = 24 * 60 * 60 * 1000, HOUR_MS = 60 * 60 * 1000;

export interface Alert {
  key: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  count?: number;
  since?: string;
  linkedRecordId?: string;
}
export interface AuditVerification { valid: boolean; count: number; headHash: string }

const order: Record<AlertSeverity, number> = { critical: 0, high: 1, medium: 2, info: 3 };
const setting = (state: DomainState, key: string, fallback: number): number => {
  const value = Number(state.settings[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export function buildAlerts(state: DomainState, now: string, audit?: AuditVerification | null): Alert[] {
  const alerts: Alert[] = [];
  const nowMs = Date.parse(now);
  const stalledExports = recordsOf(state, 'exports').filter(record => exportHealth(record, now).stalled);
  if (stalledExports.length) alerts.push({ key: 'exports_stalled', severity: 'medium', title: 'Exports need a status check', detail: `${counted(stalledExports.length, 'saved export has', 'saved exports have')} stopped reporting progress or reached a recovery deadline. Open saved exports to check its stage and retry the same job when available. Do not create another export to replace an uncertain request.`, count: stalledExports.length, linkedRecordId: stalledExports[0]!.id, since: exportHealth(stalledExports[0]!, now).lastProgressAt });
  if (audit && !audit.valid) {
    alerts.push({ key: "audit_chain_broken", severity: "critical", title: "Audit log verification failed", detail: `The check stopped at entry ${audit.count + 1} because its order or verification hash did not match. Ask an administrator to investigate.`, count: audit.count });
  }
  // An instruction dispatched in observation mode must never happen (NFR-OBS-02, DEB-10).
  if (state.merchant.mode !== "instruction") {
    const handedBack = recordsOf(state, "cutovers").filter((item) => item.status === "handed_back").map((item) => String(item.data.handedBackAt || item.createdAt)).sort().at(-1) ?? "";
    const dispatched = recordsOf(state, "attempts").filter((item) => item.data.source === "valo" && ["sent", "succeeded", "failed", "unknown", "reversed"].includes(item.status) && attemptTime(item) > handedBack);
    if (dispatched.length) alerts.push({ key: "instruction_in_observation_mode", severity: "critical", title: "Collection instruction recorded in observation mode", detail: `${counted(dispatched.length, "Valo Pay collection attempt was", "Valo Pay collection attempts were")} recorded while the lender was in observation mode. This mode must not send collection instructions. Investigate before continuing.`, count: dispatched.length, linkedRecordId: dispatched[0]!.id, since: attemptTime(dispatched[0]!) });
  }
  const drift = positionMismatches(state);
  if (drift.length) alerts.push({ key: "position_drift", severity: "high", title: "Stored balances do not match payment allocations", detail: `${counted(drift.length, "instalment has", "instalments have")} an unpaid amount that does not match the confirmed payment allocations. Review reconciliation to investigate.`, count: drift.length, linkedRecordId: drift[0]!.dueItemId });
  const threshold = setting(state, "unallocatedAlertThreshold", alertRules.unallocatedThreshold);
  // Money waiting for Finance as the Finance queue and the daily close count it: an unallocated payment, or the unapplied rest of one applied in part.
  const aged = recordsOf(state, "payments").filter((item) => paymentAwaitsAllocation(item) && nowMs - paymentObservedAt(item) >= DAY_MS);
  if (aged.length > threshold) alerts.push({ key: "unallocated_over_threshold", severity: "high", title: "Too many payments are waiting for allocation", detail: `${counted(aged.length, "payment has", "payments have")} money that has waited at least 24 hours to be assigned to an instalment, including the unapplied rest of a payment applied in part. The lender's alert limit is ${threshold}. Review the payments waiting in the Finance queue.`, count: aged.length });
  // A date-only deadline lasts its whole WAT day, as in the queues (deadlinePassed).
  const overdue = recordsOf(state, "exceptions").filter((item) => isOpenException(item.status) && deadlinePassed(item.data.dueBy, nowMs));
  if (overdue.length) alerts.push({ key: "exceptions_overdue", severity: "medium", title: "Exceptions past their deadline", detail: `${counted(overdue.length, "open exception is", "open exceptions are")} overdue. Review each item with its assigned owner. Deadlines are calculated in business days.`, count: overdue.length, linkedRecordId: overdue[0]!.id });
  const deferred = recordsOf(state, "exceptions").filter((item) => isOpenException(item.status) && item.data.type === "notice_not_evidenced");
  if (deferred.length) alerts.push({ key: "attempts_deferred", severity: "medium", title: "Collection attempts delayed: notice evidence missing", detail: `${counted(deferred.length, "planned attempt passed its", "planned attempts passed their")} notice deadline without a record that the provider accepted the customer notice. Review the missing evidence before a retry.`, count: deferred.length, linkedRecordId: deferred[0]!.id });
  // This WAT month's message cost per collection: a direct debit collected by webhook or settlement line counts.
  const month = monthOf(now);
  const cost = recordsOf(state, "notifications").filter((item) => monthOf(String(item.data.submittedAt || item.createdAt)) === month).reduce((sum, item) => sum + Number(item.data.costKobo || 0), 0);
  const collections = recordsOf(state, "payments").filter((item) => monthOf(String(item.data.observedAt || item.createdAt)) === month && isBillableChannel(item.data.channel) && collectionSucceeded(item)).length;
  const costCeiling = setting(state, "notificationCostAlertKobo", alertRules.notificationCostPerCollectionKobo);
  if (collections > 0 && cost / collections > costCeiling) alerts.push({ key: "notification_cost", severity: "medium", title: "Message cost exceeds the alert limit", detail: `Message costs average NGN ${(cost / collections / 100).toFixed(2)} per successful collection this month. The alert limit is NGN ${(costCeiling / 100).toFixed(2)}. Review message costs and settings.`, count: collections });
  const lastClose = recordsOf(state, "closes").map((item) => String(item.data.closedAt || item.createdAt)).sort().at(-1);
  if (!lastClose) alerts.push({ key: "close_overdue", severity: "medium", title: "No daily close yet", detail: "A daily close reconciles payment records and saves a dated summary. Run one to check whether the books are complete." });
  else if (nowMs - Date.parse(lastClose) > alertRules.closeOverdueHours * HOUR_MS) alerts.push({ key: "close_overdue", severity: "medium", title: "Daily close overdue", detail: `The last close was ${Math.floor((nowMs - Date.parse(lastClose)) / HOUR_MS)} hours ago. A close is due every day at the time set for this lender. Review the schedule or run a daily close.`, since: lastClose });
  // A scheduled close that has not run well past its time is the close analogue of a missed execution window (NFR-OBS-02).
  const schedule = closeSchedule(state, now);
  if (schedule.missed) {
    // Each missed business date gets its own catch-up close, oldest first; the alert names the dates still owed.
    const owed = owedCloseDates(state, now, 5), dates = new Intl.ListFormat("en-GB").format(owed.total > owed.dates.length ? [...owed.dates, `${owed.total - owed.dates.length} more`] : owed.dates);
    alerts.push({ key: "close_missed", severity: "high", title: "Scheduled daily close missed", detail: `The automatic close due at ${schedule.time} WAT is ${counted(schedule.overdueMinutes, "minute")} late. ${owed.total === 1 ? "Business date" : "Business dates"} still to close: ${dates}. The scheduler may have stopped or the close may have failed. Check the schedule and run a daily close if needed.`, count: owed.total, since: schedule.nextAt });
  }
  const switches = Object.entries((state.settings.policyKillSwitches || {}) as Record<string, unknown>).filter(([, on]) => on === true).map(([id]) => id);
  if (state.merchant.killSwitch || switches.length) alerts.push({ key: "kill_switch_active", severity: "info", title: state.merchant.killSwitch ? "Lender emergency stop is on" : "A policy emergency stop is on", detail: state.merchant.killSwitch ? "No collection instructions will be planned until an administrator turns off the emergency stop." : `The emergency stop is on for ${counted(switches.length, "policy version")}. No collection instructions will be planned under those versions until an administrator turns it off.`, count: switches.length || undefined });
  return alerts.sort((a, b) => order[a.severity] - order[b.severity] || a.key.localeCompare(b.key));
}
