import { closeRules, closeTimeOf, isOpenException, nextCloseInstant } from "@workspace/valopay-schema";
import { recordsOf } from "./records";
import type { Context, DomainState, ValopayRecord } from "./types";
import { paymentObservedAt } from "./reconciliation";

const DAY_MS = 24 * 60 * 60 * 1000, MINUTE_MS = 60 * 1000;

/** REC-01: the daily close schedule as the console, the alerts and the scheduler see it. */
export interface CloseSchedule {
  /** Configured WAT time, HH:MM. */
  time: string;
  /** Whether the automatic close is on (settings.scheduledCloseEnabled, default true). */
  enabled: boolean;
  /** The next scheduled instant: the stored cursor, or derived from the time for a merchant that has none yet. */
  nextAt: string;
  /** True when the automatic close is on and its scheduled instant passed more than closeRules.lateAfterMinutes ago without a close. */
  missed: boolean;
  overdueMinutes: number;
  lateAfterMinutes: number;
  lastAt: string | null;
  lastTrigger: string | null;
}

/** The scheduler cursor the merchant carries (settings.nextCloseAt), when it is a valid instant. */
export function storedCloseCursor(state: DomainState): string | null {
  const value = state.settings.nextCloseAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Whether the scheduled close is due now: the automatic close is on and the stored cursor is at or before `now`. */
export function scheduledCloseDue(state: DomainState, now: string): boolean {
  const cursor = storedCloseCursor(state);
  return state.settings.scheduledCloseEnabled !== false && cursor !== null && Date.parse(cursor) <= Date.parse(now);
}

/**
 * After a settings change, the cursor restarts from the next occurrence only
 * when the close time changed or the automatic close was switched on.  Saving
 * unchanged settings never moves it, so a pending missed close stays pending
 * and is still caught up; switching the close off leaves the cursor for the
 * next switch-on to replace.
 */
export function rescheduleAfterSettings(state: DomainState, previous: { time: string; enabled: boolean }, now: string): boolean {
  const time = closeTimeOf(state.settings), enabled = state.settings.scheduledCloseEnabled !== false;
  if (time === previous.time && (!enabled || previous.enabled)) return false;
  state.settings.nextCloseAt = nextCloseInstant(now, time);
  return true;
}

export function closeSchedule(state: DomainState, now: string): CloseSchedule {
  const time = closeTimeOf(state.settings);
  const enabled = state.settings.scheduledCloseEnabled !== false;
  const cursor = storedCloseCursor(state);
  const overdueMinutes = cursor ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(cursor)) / MINUTE_MS)) : 0;
  const last = recordsOf(state, "closes").sort((a, b) => String(a.data.closedAt || a.createdAt).localeCompare(String(b.data.closedAt || b.createdAt))).at(-1);
  return {
    time, enabled, nextAt: cursor ?? nextCloseInstant(now, time),
    missed: enabled && overdueMinutes > closeRules.lateAfterMinutes, overdueMinutes, lateAfterMinutes: closeRules.lateAfterMinutes,
    lastAt: last ? String(last.data.closedAt || last.createdAt) : null, lastTrigger: last ? String(last.data.schedule?.trigger ?? "manual") : null,
  };
}

/** REC-05: a customer position is derived from due items, confirmed allocations and payments; no stored balance is authoritative. */
export interface CustomerPosition {
  customerId: string;
  obligationsKobo: number;
  allocatedKobo: number;
  outstandingKobo: number;
  unallocatedKobo: number;
}

export function positionFor(state: DomainState, customerId: string): CustomerPosition {
  const related = state.records.filter((record) => record.customerId === customerId);
  const obligationsKobo = related.filter((record) => record.kind === "due-items" && record.status !== "cancelled").reduce((sum, record) => sum + record.amountKobo, 0);
  const allocatedKobo = related.filter((record) => record.kind === "allocations" && record.status === "confirmed").reduce((sum, record) => sum + record.amountKobo, 0);
  const unallocatedKobo = related.filter((record) => record.kind === "payments").reduce((sum, record) => sum + Math.max(0, record.amountKobo - Number(record.data.allocatedKobo || 0)), 0);
  return { customerId, obligationsKobo, allocatedKobo, outstandingKobo: Math.max(0, obligationsKobo - allocatedKobo), unallocatedKobo };
}

/** REC-05: rebuild each due item's outstanding balance from confirmed allocations and compare it with the stored view. */
export function positionMismatches(state: DomainState): Array<{ dueItemId: string; reference: string; customerId: string; storedOutstandingKobo: number; rebuiltOutstandingKobo: number }> {
  return recordsOf(state, "due-items").flatMap((due) => {
    if (due.data.outstandingKobo === undefined || due.status === "cancelled") return [];
    const applied = recordsOf(state, "allocations").filter((item) => item.status === "confirmed" && item.data.dueItemId === due.id).reduce((sum, item) => sum + item.amountKobo, 0);
    const rebuilt = Math.max(0, due.amountKobo - applied);
    return rebuilt === Number(due.data.outstandingKobo) ? [] : [{ dueItemId: due.id, reference: due.reference, customerId: due.customerId, storedOutstandingKobo: Number(due.data.outstandingKobo), rebuiltOutstandingKobo: rebuilt }];
  });
}

export function positionSnapshot(state: DomainState): Map<string, CustomerPosition> {
  return new Map(recordsOf(state, "customers").map((customer) => [customer.id, positionFor(state, customer.id)]));
}

const sumOf = (items: ValopayRecord[]) => ({ count: items.length, kobo: items.reduce((sum, item) => sum + item.amountKobo, 0) });
const inPeriod = (at: string | undefined, from: string | null, to: string) => Boolean(at) && (from === null || String(at) > from) && String(at) <= to;

/** What the close needs to remember from before reconciliation ran. */
export interface OpeningSnapshot {
  since: string | null;
  unallocated: { count: number; kobo: number };
  positions: Map<string, CustomerPosition>;
}

export function openingSnapshot(state: DomainState): OpeningSnapshot {
  const closes = recordsOf(state, "closes").map((close) => String(close.data.closedAt || close.createdAt)).sort();
  return { since: closes.at(-1) ?? null, unallocated: sumOf(recordsOf(state, "payments").filter((item) => item.status === "unallocated")), positions: positionSnapshot(state) };
}

/**
 * REC-07 daily close report: opening unallocated, observations received by
 * source and the Payments they resolved to, allocated by rule, proposed,
 * unallocated, variances, exceptions opened and closed, and the customer
 * positions that changed, plus the REC-05 position rebuild check.
 */
export function buildCloseReport(state: DomainState, ctx: Context, opening: OpeningSnapshot, reconciled: Record<string, any>): Record<string, any> {
  const to = ctx.now, from = opening.since;
  const payments = recordsOf(state, "payments"), dueItems = recordsOf(state, "due-items");

  const received = recordsOf(state, "observations").filter((item) => inPeriod(item.createdAt, from, to));
  const bySource: Record<string, { received: number; resolved: number; unresolved: number; paymentsResolvedTo: number; batchesResolvedTo: number }> = {};
  for (const observation of received) {
    const source = String(observation.data.source || "manual");
    const row = (bySource[source] ||= { received: 0, resolved: 0, unresolved: 0, paymentsResolvedTo: 0, batchesResolvedTo: 0 });
    row.received += 1;
    if (observation.status === "resolved") row.resolved += 1; else row.unresolved += 1;
  }
  for (const source of Object.keys(bySource)) {
    const rows = received.filter((item) => String(item.data.source || "manual") === source && item.status === "resolved");
    bySource[source]!.paymentsResolvedTo = new Set(rows.map((item) => item.data.paymentId).filter(Boolean)).size;
    bySource[source]!.batchesResolvedTo = new Set(rows.map((item) => item.data.resolvedTo).filter((value) => typeof value === "string" && value.startsWith("batch:"))).size;
  }
  const paymentsResolved = new Set(received.filter((item) => item.status === "resolved" && item.data.paymentId).map((item) => item.data.paymentId)).size;

  const confirmed = recordsOf(state, "allocations").filter((item) => item.status === "confirmed" && inPeriod(item.updatedAt, from, to));
  const allocatedByRule: Record<string, { count: number; kobo: number; automatic: number }> = {};
  for (const allocation of confirmed) {
    const row = (allocatedByRule[String(allocation.data.rule)] ||= { count: 0, kobo: 0, automatic: 0 });
    row.count += 1; row.kobo += allocation.amountKobo; if (allocation.data.automatic === true) row.automatic += 1;
  }

  const unallocated = payments.filter((item) => item.status === "unallocated");
  const variances = recordsOf(state, "settlement-batches").filter((item) => item.status === "variance").map((batch) => ({
    batchId: batch.id, reference: batch.reference, feeVarianceKobo: Number(batch.data.feeVarianceKobo || 0), netKobo: Number(batch.data.netKobo || 0),
    statementNetKobo: batch.data.statementNetKobo ?? null, explanation: batch.data.explanation ?? null,
  }));

  const exceptions = recordsOf(state, "exceptions");
  const opened = exceptions.filter((item) => inPeriod(item.createdAt, from, to));
  const closed = exceptions.filter((item) => !isOpenException(item.status) && inPeriod(String(item.data.resolvedAt || item.updatedAt), from, to));
  const byType = (items: ValopayRecord[]) => items.reduce<Record<string, number>>((acc, item) => { acc[String(item.data.type)] = (acc[String(item.data.type)] || 0) + 1; return acc; }, {});

  const after = positionSnapshot(state);
  const customers = new Map(recordsOf(state, "customers").map((customer) => [customer.id, customer.name]));
  const positionsChanged = [...after.entries()].flatMap(([customerId, position]) => {
    const before = opening.positions.get(customerId);
    const changed = !before || (["obligationsKobo", "allocatedKobo", "outstandingKobo", "unallocatedKobo"] as const).some((key) => before[key] !== position[key]);
    return changed ? [{ customerId, customerName: customers.get(customerId) ?? "", before: before ?? null, after: position }] : [];
  });
  const mismatches = positionMismatches(state);

  return {
    period: { from, to },
    openingUnallocated: opening.unallocated,
    observations: { received: received.length, bySource, paymentsResolvedTo: paymentsResolved, canonicalPaymentsCreated: Number(reconciled.canonicalPayments || 0) },
    allocatedByRule,
    allocated: sumOf(confirmed),
    proposed: sumOf(payments.filter((item) => item.status === "proposed")),
    unallocated: { ...sumOf(unallocated), olderThan24Hours: unallocated.filter((item) => Date.parse(to) - paymentObservedAt(item) >= DAY_MS).length },
    possibleDuplicates: sumOf(payments.filter((item) => item.status === "possible_duplicate")),
    variances: { count: variances.length, feeVarianceKobo: variances.reduce((sum, item) => sum + item.feeVarianceKobo, 0), batches: variances },
    exceptions: {
      opened: { count: opened.length, byType: byType(opened) }, closed: { count: closed.length, byType: byType(closed) },
      openAtClose: exceptions.filter((item) => isOpenException(item.status)).length,
      overdueAtClose: exceptions.filter((item) => isOpenException(item.status) && Date.parse(String(item.data.dueBy)) < Date.parse(to)).length,
    },
    retryDecisions: { recorded: Number(reconciled.retryDecisionsRecorded || 0), finalAttempts: Number(reconciled.finalAttemptExceptions || 0), disputesFrozen: Number(reconciled.disputesFrozen || 0), noticesNotEvidenced: Number(reconciled.noticesNotEvidenced || 0) },
    customerPositionsChanged: positionsChanged,
    positionRebuild: { customersChecked: after.size, dueItemsChecked: dueItems.length, mismatches, alert: mismatches.length > 0 },
    reconciliation: reconciled,
  };
}
