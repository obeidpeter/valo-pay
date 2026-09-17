// Shared fixtures for the offline golden tests.  Everything here is synthetic
// and pure: no database, no network, fixed instants in West Africa Time.
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import type { Context, DomainState, ValopayRecord } from "../src/domain/types.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
/** ISO instant for a WAT wall-clock time. */
export const wat = (isoWithoutZone: string): string => new Date(Date.parse(`${isoWithoutZone}Z`) - HOUR).toISOString();
/** WAT wall-clock string for an ISO instant. */
export const toWat = (iso: string | null): string => (iso ? new Date(Date.parse(iso) + HOUR).toISOString().slice(0, 19) : "n/a");

export const ctxAt = (now: string, role = "Admin"): Context => ({ actor: `Sandbox ${role}`, role, now });

export interface Fixture {
  state: DomainState;
  policy: ValopayRecord;
  customer: ValopayRecord;
  mandate: ValopayRecord;
  due: ValopayRecord;
  cutover: ValopayRecord;
}

export function approvePolicy(policy: ValopayRecord): ValopayRecord {
  policy.status = "approved";
  policy.data.author = "Sandbox Admin";
  policy.data.reviewer = "Sandbox Compliance reviewer";
  policy.data.approvedAt = "2027-01-15T09:00:00.000Z";
  return policy;
}

export function completeCutover(state: DomainState): ValopayRecord {
  return makeRecord(state, "cutovers", {
    name: "Cohort 1 cutover", status: "ready",
    data: { inventory: "LMS scheduler; provider recurring plan", incumbentDisabled: true, externalAttemptsImported: true, dualRunComplete: true, accountableUser: "Ops lead", fallbackOwner: "lms", confirmation: "Signed by the merchant Admin" },
  });
}

/** A merchant in instruction mode with an approved policy, an active mandate and one owner-valo due item that failed its first attempt. */
export function liveFixture(options: { dueIndex?: number; merchantId?: string; failureAt?: string; failureCode?: string; withFailure?: boolean } = {}): Fixture {
  const state = seedMerchant(options.merchantId ?? "golden-merchant");
  const policy = approvePolicy(recordsOf(state, "policies")[0]!);
  const cutover = completeCutover(state);
  state.merchant.mode = "instruction";
  state.merchant.preLiveReady = true;
  const dues = recordsOf(state, "due-items");
  const due = dues[options.dueIndex ?? 4]!; // Ngozi Eze · instalment 5, ₦25,000, scheduled
  const mandate = recordsOf(state, "mandates").find((item) => item.id === due.data.mandateId)!;
  mandate.status = "active";
  mandate.data.consentGaps = [];
  due.data.owner = "valopay";
  const customer = recordsOf(state, "customers").find((item) => item.id === due.customerId)!;
  if (options.withFailure !== false) {
    addAttempt(state, due, { status: "failed", failureCode: options.failureCode ?? "INSUFFICIENT_FUNDS", occurredAt: options.failureAt ?? wat("2027-06-28T06:16:00") });
    due.status = "in_collection";
  }
  return { state, policy, customer, mandate, due, cutover };
}

export function addAttempt(state: DomainState, due: ValopayRecord, input: { status: string; failureCode?: string; occurredAt: string; source?: string; providerReference?: string; noticeId?: string }): ValopayRecord {
  const number = recordsOf(state, "attempts").filter((item) => item.data.dueItemId === due.id).length + 1;
  return makeRecord(state, "attempts", {
    name: `attempt ${number}`, status: input.status, customerId: due.customerId, amountKobo: due.amountKobo,
    data: { dueItemId: due.id, number, source: input.source ?? "external", simulated: true, failureCode: input.failureCode, occurredAt: input.occurredAt, providerReference: input.providerReference, noticeId: input.noticeId },
  });
}

/** A required notice with real provider acceptance evidence (NOT-10); makeRecord marks records synthetic, so it is cleared here. */
export function addNotice(state: DomainState, due: ValopayRecord, acceptedAt: string, purpose = "failed_debit"): ValopayRecord {
  const notice = makeRecord(state, "notifications", { name: purpose, status: "accepted", customerId: due.customerId, data: { purpose, channel: "sms", class: "required", acceptedAt, deliveredAt: acceptedAt } });
  notice.data.synthetic = false;
  return notice;
}

export function addObservation(state: DomainState, input: { reference: string; amountKobo: number; source: string; customerId?: string; dueItemId?: string; eventId: string; occurredAt?: string; batchReference?: string; feeKobo?: number; grossAmountKobo?: number; narration?: string; reversed?: boolean; virtualAccountCustomerId?: string; createdAt?: string }): ValopayRecord {
  const { reference, amountKobo, customerId, createdAt, ...data } = input;
  return makeRecord(state, "observations", { name: `${data.source} ${reference}`, status: "unresolved", reference, amountKobo, customerId: customerId ?? "", createdAt, data: { provider: "Sandbox Rail", ...data } });
}

export function addHoliday(state: DomainState, date: string): ValopayRecord {
  return makeRecord(state, "calendar", { name: "Public holiday", status: "active", data: { date } });
}

export const outstandingOf = (due: ValopayRecord): number => Number.isInteger(due.data.outstandingKobo) ? Number(due.data.outstandingKobo) : due.amountKobo;
