/**
 * NFR-OBS-02 alerts computed from the lender's state: the conditions the TRD
 * routes to the on-call phone that this sandbox can observe.  Alerts are
 * derived on every read and frozen into each daily close; they are never
 * stored on their own.
 */
import { alertRules, isBillableChannel, isOpenException, type AlertSeverity } from "@workspace/valopay-schema";
import { recordsOf } from "./records";
import type { DomainState } from "./types";
import { paymentObservedAt } from "./reconciliation";
import { positionMismatches } from "./close";
import { attemptTime } from "./policy-engine";
import { monthOf } from "./billing";

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
  if (audit && !audit.valid) {
    alerts.push({ key: "audit_chain_broken", severity: "critical", title: "Audit chain broken", detail: `Verification stopped at entry ${audit.count + 1}: a sequence, previous hash or digest does not verify (AUD-04).`, count: audit.count });
  }
  // An instruction dispatched in observation mode must never happen (NFR-OBS-02, DEB-10).
  if (state.merchant.mode !== "instruction") {
    const handedBack = recordsOf(state, "cutovers").filter((item) => item.status === "handed_back").map((item) => String(item.data.handedBackAt || item.createdAt)).sort().at(-1) ?? "";
    const dispatched = recordsOf(state, "attempts").filter((item) => item.data.source === "valo" && ["sent", "succeeded", "failed", "unknown", "reversed"].includes(item.status) && attemptTime(item) > handedBack);
    if (dispatched.length) alerts.push({ key: "instruction_in_observation_mode", severity: "critical", title: "Instruction dispatched in observation mode", detail: `${dispatched.length} platform-sourced attempt(s) exist while the merchant is not in instruction mode; this must never happen.`, count: dispatched.length, linkedRecordId: dispatched[0]!.id, since: attemptTime(dispatched[0]!) });
  }
  const drift = positionMismatches(state);
  if (drift.length) alerts.push({ key: "position_drift", severity: "high", title: "Customer position rebuild differs from the stored view", detail: `${drift.length} due item(s) carry an outstanding balance that the confirmed allocations do not reproduce (REC-05).`, count: drift.length, linkedRecordId: drift[0]!.dueItemId });
  const threshold = setting(state, "unallocatedAlertThreshold", alertRules.unallocatedThreshold);
  const aged = recordsOf(state, "payments").filter((item) => item.status === "unallocated" && nowMs - paymentObservedAt(item) >= DAY_MS);
  if (aged.length > threshold) alerts.push({ key: "unallocated_over_threshold", severity: "high", title: "Unallocated Payments over the threshold", detail: `${aged.length} Payments have been unallocated for more than 24 hours; the merchant threshold is ${threshold}.`, count: aged.length });
  const overdue = recordsOf(state, "exceptions").filter((item) => isOpenException(item.status) && Date.parse(String(item.data.dueBy)) < nowMs);
  if (overdue.length) alerts.push({ key: "exceptions_overdue", severity: "medium", title: "Exceptions past their deadline", detail: `${overdue.length} open exception(s) are past the business-day deadline their type carries (EXC-02).`, count: overdue.length, linkedRecordId: overdue[0]!.id });
  const deferred = recordsOf(state, "exceptions").filter((item) => isOpenException(item.status) && item.data.type === "notice_not_evidenced");
  if (deferred.length) alerts.push({ key: "attempts_deferred", severity: "medium", title: "Attempts deferred for missing notice evidence", detail: `${deferred.length} planned attempt(s) passed their notice deadline without provider acceptance (NOT-10).`, count: deferred.length, linkedRecordId: deferred[0]!.id });
  const month = monthOf(now);
  const cost = recordsOf(state, "notifications").filter((item) => monthOf(String(item.data.submittedAt || item.createdAt)) === month).reduce((sum, item) => sum + Number(item.data.costKobo || 0), 0);
  const collections = recordsOf(state, "payments").filter((item) => monthOf(String(item.data.observedAt || item.createdAt)) === month && isBillableChannel(item.data.channel) && item.data.collectionStatus === "succeeded").length;
  const costCeiling = setting(state, "notificationCostAlertKobo", alertRules.notificationCostPerCollectionKobo);
  if (collections > 0 && cost / collections > costCeiling) alerts.push({ key: "notification_cost", severity: "medium", title: "Notification cost per collection over the ceiling", detail: `NGN ${(cost / collections / 100).toFixed(2)} per successful collection this month against a ceiling of NGN ${(costCeiling / 100).toFixed(2)} (NOT-06).`, count: collections });
  const lastClose = recordsOf(state, "closes").map((item) => String(item.data.closedAt || item.createdAt)).sort().at(-1);
  if (!lastClose) alerts.push({ key: "close_overdue", severity: "medium", title: "No daily close yet", detail: "The books are not known complete until a daily close has run (REC-01)." });
  else if (nowMs - Date.parse(lastClose) > alertRules.closeOverdueHours * HOUR_MS) alerts.push({ key: "close_overdue", severity: "medium", title: "Daily close overdue", detail: `The last close was ${Math.floor((nowMs - Date.parse(lastClose)) / HOUR_MS)} hours ago; the close is due daily at the configured time (REC-01).`, since: lastClose });
  const switches = Object.entries((state.settings.policyKillSwitches || {}) as Record<string, unknown>).filter(([, on]) => on === true).map(([id]) => id);
  if (state.merchant.killSwitch || switches.length) alerts.push({ key: "kill_switch_active", severity: "info", title: state.merchant.killSwitch ? "Merchant kill switch is on" : "A policy-version kill switch is on", detail: state.merchant.killSwitch ? "No instruction is planned until an Admin releases the switch (DEB-06)." : `Policy version switch on for ${switches.length} version(s); those items wait for release (DEB-06).`, count: switches.length || undefined });
  return alerts.sort((a, b) => order[a.severity] - order[b.severity] || a.key.localeCompare(b.key));
}
