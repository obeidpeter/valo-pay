import { conditionClearedCode, heldEvidenceOf, isOpenException, resolveExceptionType, unseenReversalOf } from "@workspace/valopay-schema";
import { indexedPass, recordsWhere } from "./record-index";
import type { DomainState, TypedRecord } from "./types";

/** The effective decision is shared by reconciliation and guards that run before its first migration pass. */
export function latestEvidenceResolution(state: DomainState, observation: TypedRecord<"observations">): TypedRecord<"exceptions"> | undefined {
  const resolvedAt = (item: TypedRecord<"exceptions">) => String(item.data.resolvedAt || item.updatedAt);
  let latest: TypedRecord<"exceptions"> | undefined;
  const renewals: TypedRecord<"exceptions">[] = [];
  for (const exception of recordsWhere(state, "exceptions", "data.linkedRecordId", observation.id)) {
    const code = exception.data.resolutionCode;
    if (isOpenException(exception.status) || !code || code === conditionClearedCode) continue;
    const type = resolveExceptionType(exception.data.type);
    const decides = type === "suspected_duplicate" ? heldEvidenceOf(exception.data.condition)?.observationId === observation.id : type === "provider_status_mismatch" && unseenReversalOf(exception.data.condition) === observation.id;
    if (decides && exception.data.legacyResolutionReview && exception.data.resolutionRuleVersion !== undefined) renewals.push(exception);
    if (decides && (!latest || resolvedAt(exception) >= resolvedAt(latest))) latest = exception;
  }
  // Explicit renewal supersedes the decision it names even across historical host clock skew.
  const seen = new Set<string>();
  while (latest && !seen.has(latest.id)) {
    seen.add(latest.id);
    const id = latest.id;
    const renewed = renewals.find((item) => (item.data.legacyResolutionReview as { priorExceptionId?: string }).priorExceptionId === id);
    if (!renewed) break;
    latest = renewed;
  }
  return latest;
}

function observationNeedsReview(state: DomainState, observation: TypedRecord<"observations">): boolean {
  if (observation.data.reversed !== true && observation.data.reversalStatus !== "reversed") return false;
  if (recordsWhere(state, "exceptions", "data.linkedRecordId", observation.id).some((item) => item.data.legacyResolutionReview && isOpenException(item.status))) return true;
  const latest = latestEvidenceResolution(state, observation);
  return !!latest && resolveExceptionType(latest.data.type) === "provider_status_mismatch" && latest.data.resolutionRuleVersion === undefined;
}

function referenceNeedsReview(state: DomainState, reference: unknown): boolean {
  return typeof reference === "string" && !!reference && recordsWhere(state, "observations", "reference", reference).some((observation) => observationNeedsReview(state, observation));
}

const storedHold = (record: TypedRecord<"payments"> | TypedRecord<"due-items">): boolean => Array.isArray(record.data.legacyReversalReviewIds) && record.data.legacyReversalReviewIds.length > 0;

/** No action may apply ambiguous historical money while waiting for the first reconciliation to materialise its hold. */
export function paymentNeedsReversalReview(state: DomainState, payment: TypedRecord<"payments">): boolean {
  return indexedPass(state, () => storedHold(payment) || referenceNeedsReview(state, payment.reference) || referenceNeedsReview(state, payment.data.providerReference));
}

/** Follow evidence, provider references and recorded allocations; do not infer a hold from a customer's other obligations. */
export function dueNeedsReversalReview(state: DomainState, due: TypedRecord<"due-items">): boolean {
  return indexedPass(state, () => {
    if (storedHold(due)) return true;
    if (recordsWhere(state, "observations", "data.dueItemId", due.id).some((observation) => observationNeedsReview(state, observation))) return true;
    if (recordsWhere(state, "attempts", "data.dueItemId", due.id).some((attempt) => referenceNeedsReview(state, attempt.reference) || referenceNeedsReview(state, attempt.data.providerReference))) return true;
    const payments = [
      ...recordsWhere(state, "payments", "data.dueItemId", due.id),
      ...recordsWhere(state, "payments", "data.proposedDueItemId", due.id),
      ...recordsWhere(state, "allocations", "data.dueItemId", due.id).flatMap((allocation) => recordsWhere(state, "payments", "id", allocation.data.paymentId)),
    ];
    return payments.some((payment) => paymentNeedsReversalReview(state, payment));
  });
}
