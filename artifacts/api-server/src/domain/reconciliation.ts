import { DEFAULT_PROVIDER_FEE, SETTLEMENT_BATCH_TOLERANCE_KOBO, SETTLEMENT_ITEM_TOLERANCE_KOBO, exceptionCatalogue, isKobo, isOpenException, normaliseFailureCode, normaliseRefundStatus, normaliseReversalStatus, providerFeeKobo, resolveExceptionType, type ExceptionType, type ProviderFeeSchedule, type PaymentChannel } from "@workspace/valopay-schema";
import { findRecord, makeRecord, recordsOf, touch } from "./records";
import type { Context, DomainState, TypedRecord, ValopayRecord } from "./types";
import { addBusinessDays } from "./calendar";
import { approvedPolicyFor, attemptTime, attemptsFor, enrolEligibleFailures, evaluateRetry, recordRetryDecision } from "./policy-engine";

const DAY_MS = 24 * 60 * 60 * 1000;
/** ING-05: a second Payment for the same payer and amount inside this window is held as a possible duplicate. */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
/** REC-04: unallocated Payments older than this become exceptions. */
export const UNALLOCATED_AGE_MS = DAY_MS;

export const paymentReversed = (payment: TypedRecord<"payments">): boolean => normaliseReversalStatus(payment.data.reversalStatus) === "reversed";
export const paymentRefunded = (payment: TypedRecord<"payments">): boolean => normaliseRefundStatus(payment.data.refundStatus) === "refunded";
export const paymentObservedAt = (payment: TypedRecord<"payments">): number => Date.parse(String(payment.data.observedAt || payment.createdAt));

/** The four independent status dimensions of a Payment (TRD 4.2), written in one vocabulary; legacy spellings are normalised. */
export function paymentDimensions(payment: TypedRecord<"payments">): void {
  payment.data.collectionStatus ||= "received";
  payment.data.settlementStatus ||= "unsettled";
  payment.data.reversalStatus = normaliseReversalStatus(payment.data.reversalStatus);
  payment.data.refundStatus = normaliseRefundStatus(payment.data.refundStatus);
  if (!isKobo(payment.data.allocatedKobo)) payment.data.allocatedKobo = 0;
}

/** CON-09: the provider fee schedule for a connection, falling back to the merchant's default provider, then the plan's sourced rail fee. */
export function feeScheduleFor(state: DomainState, provider: unknown): ProviderFeeSchedule {
  const schedules = (state.settings.providerFeeSchedule || {}) as Record<string, { bps?: unknown; capKobo?: unknown }>;
  const configured = schedules[String(provider)] || schedules[state.merchant.provider];
  if (configured && Number.isFinite(Number(configured.bps))) {
    const cap = Number(configured.capKobo);
    return { bps: Number(configured.bps), capKobo: Number.isSafeInteger(cap) && cap >= 0 ? cap : Number.MAX_SAFE_INTEGER };
  }
  const legacy = Number(state.settings.providerFeeBps);
  if (Number.isFinite(legacy) && state.settings.providerFeeBps !== undefined) return { bps: legacy, capKobo: Number.MAX_SAFE_INTEGER };
  return DEFAULT_PROVIDER_FEE;
}

/** Appendix A: one open exception per (type, linked record), with the catalogue's owner, severity and business-day SLA. */
export function raiseException(state: DomainState, ctx: Context, type: ExceptionType, options: { linkedRecordId?: string; customerId?: string; amountKobo?: number; notes: string }): TypedRecord<"exceptions"> {
  const definition = exceptionCatalogue[type];
  const linkedRecordId = options.linkedRecordId || "";
  const existing = recordsOf(state, "exceptions").find((item) => isOpenException(item.status) && item.data.linkedRecordId === linkedRecordId && resolveExceptionType(item.data.type) === type);
  if (existing) return existing;
  return makeRecord(state, "exceptions", {
    name: definition.title, status: "open", customerId: options.customerId || "", amountKobo: options.amountKobo || 0, createdAt: ctx.now,
    data: { type, severity: definition.severity, owner: definition.owner, slaBusinessDays: definition.slaBusinessDays, dueBy: addBusinessDays(state, ctx.now, definition.slaBusinessDays), notes: options.notes, linkedRecordId },
  });
}

function outstanding(due: TypedRecord<"due-items">): number {
  return Number.isInteger(due.data.outstandingKobo) ? Number(due.data.outstandingKobo) : due.amountKobo;
}

function channelFor(source: unknown): PaymentChannel {
  switch (source) {
    case "webhook": case "settlement": return "direct_debit";
    case "transfer": return "transfer";
    case "card": return "card";
    case "statement": return "statement";
    default: return "manual";
  }
}

function cancelUnsentAttempts(state: DomainState, dueItemId: string, now: string): void {
  recordsOf(state, "attempts").filter((item) => item.data.dueItemId === dueItemId && item.status === "scheduled").forEach((item) => {
    item.status = "cancelled";
    item.data.cancellationReason = "Due item settled by another channel; no instruction was sent.";
    touch(item, now);
  });
}

function settlementBatch(state: DomainState, ctx: Context, observation: TypedRecord<"observations">, payment: TypedRecord<"payments">): void {
  const batchReference = String(observation.data.batchReference || "");
  if (!batchReference) return;
  const provider = String(observation.data.provider || payment.data.providerConnection || state.merchant.provider);
  const schedule = feeScheduleFor(state, provider);
  let batch = recordsOf(state, "settlement-batches").find((item) => item.reference === batchReference);
  if (!batch) {
    batch = makeRecord(state, "settlement-batches", {
      name: `Settlement batch ${batchReference}`, status: "pending", reference: batchReference, createdAt: ctx.now,
      data: { provider, batchReference, providerConnection: payment.data.providerConnection, lineObservationIds: [], linePaymentIds: [], grossKobo: 0, feeKobo: 0, netKobo: 0, expectedFeeKobo: 0, feeSchedule: schedule },
    });
  }
  const lineIds = batch.data.lineObservationIds as string[];
  const linePaymentIds = (batch.data.linePaymentIds ||= []) as string[];
  if (lineIds.includes(observation.id)) return;
  observation.data.settlementBatchId = batch.id;
  // ING-05: a repeated settlement line for a Payment already in the batch is evidence, and adds nothing to the batch totals.
  if (linePaymentIds.includes(payment.id)) { observation.data.duplicateSettlementLine = true; return; }
  linePaymentIds.push(payment.id);
  const gross = payment.amountKobo;
  const expectedFee = providerFeeKobo(gross, schedule);
  const statedFee = isKobo(observation.data.feeKobo) ? observation.data.feeKobo : gross > observation.amountKobo ? gross - observation.amountKobo : expectedFee;
  lineIds.push(observation.id);
  batch.data.grossKobo = Number(batch.data.grossKobo || 0) + gross;
  batch.data.feeKobo = Number(batch.data.feeKobo || 0) + statedFee;
  batch.data.expectedFeeKobo = Number(batch.data.expectedFeeKobo || 0) + expectedFee;
  batch.data.netKobo = Number(batch.data.grossKobo) - Number(batch.data.feeKobo);
  batch.data.feeVarianceKobo = Number(batch.data.feeKobo) - Number(batch.data.expectedFeeKobo);
  observation.data.assumedFeeKobo = statedFee;
  observation.data.expectedFeeKobo = expectedFee;
  if (Math.abs(statedFee - expectedFee) > SETTLEMENT_ITEM_TOLERANCE_KOBO) observation.data.feeVarianceKobo = statedFee - expectedFee;
  touch(batch, ctx.now);
}

/** ING-07: a batch whose fees do not reconcile to the schedule is a variance exception, never forced. */
function checkBatchFees(state: DomainState, ctx: Context): number {
  let variances = 0;
  for (const batch of recordsOf(state, "settlement-batches")) {
    const variance = Number(batch.data.feeVarianceKobo || 0);
    if (Math.abs(variance) <= SETTLEMENT_BATCH_TOLERANCE_KOBO) continue;
    if (batch.status !== "variance") { batch.status = "variance"; touch(batch, ctx.now); }
    batch.data.explanation = `Provider fees of ${batch.data.feeKobo} kobo differ from the schedule's ${batch.data.expectedFeeKobo} kobo by ${variance} kobo.`;
    raiseException(state, ctx, "settlement_variance", { linkedRecordId: batch.id, notes: batch.data.explanation });
    variances += 1;
  }
  return variances;
}

/** ING-03 (3): a statement credit whose reference matches a settlement batch resolves to the batch, never to a customer. */
function matchSettlementStatements(state: DomainState, ctx: Context): number {
  let matched = 0;
  recordsOf(state, "observations").filter((item) => item.status === "unresolved" && item.data.source === "statement" && item.data.batchReference).forEach((statement) => {
    const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === statement.data.batchReference);
    if (!batch) return; // It may arrive before the settlement file; leave it for the next close.
    statement.status = "resolved";
    statement.data.resolvedTo = `batch:${batch.id}`;
    statement.data.resolutionKey = "settlement_batch_net_credit";
    batch.data.statementObservationId = statement.id;
    batch.data.statementNetKobo = statement.amountKobo;
    const feeVariance = Math.abs(Number(batch.data.feeVarianceKobo || 0)) > SETTLEMENT_BATCH_TOLERANCE_KOBO;
    if (statement.amountKobo === Number(batch.data.netKobo) && !feeVariance) {
      batch.status = "reconciled";
      batch.data.explanation = "Statement credit matched the settlement batch net total; it was not allocated to a customer.";
    } else {
      batch.status = "variance";
      batch.data.explanation = statement.amountKobo === Number(batch.data.netKobo)
        ? "Statement credit matched the batch net, but the provider fees differ from the fee schedule."
        : "Statement credit differs from gross settlement lines less recorded fees.";
      raiseException(state, ctx, "settlement_variance", { linkedRecordId: batch.id, notes: batch.data.explanation });
    }
    touch(statement, ctx.now); touch(batch, ctx.now);
    matched += 1;
  });
  return matched;
}

export function allocatePayment(
  state: DomainState,
  ctx: Context,
  payment: TypedRecord<"payments">,
  due: TypedRecord<"due-items">,
  amount: number,
  rule: string,
  confidence: "certain" | "probable" | "manual",
  automatic: boolean,
  explanation?: string,
): TypedRecord<"allocations"> {
  if (!Number.isInteger(amount) || amount <= 0 || amount > payment.amountKobo - Number(payment.data.allocatedKobo || 0)) {
    throw new Error("Allocation exceeds the remaining canonical payment amount.");
  }
  const remaining = outstanding(due);
  if (amount > remaining) throw new Error("Allocation exceeds the due item's remaining balance.");
  const allocation = makeRecord(state, "allocations", {
    name: `Allocation ${rule}`, status: confidence === "probable" ? "proposed" : "confirmed",
    customerId: payment.customerId || due.customerId, amountKobo: amount, createdAt: ctx.now,
    data: { paymentId: payment.id, dueItemId: due.id, rule, confidence, automatic, explanation: explanation ?? `${rule} matched this canonical payment.`, reviewed: null },
  });
  if (confidence === "probable") {
    payment.status = "proposed";
    payment.data.proposedDueItemId = due.id;
    payment.data.proposedAmountKobo = amount;
  } else {
    applyConfirmedAllocation(state, ctx, allocation);
  }
  touch(payment, ctx.now);
  return allocation;
}

export function applyConfirmedAllocation(state: DomainState, ctx: Context, allocation: TypedRecord<"allocations">): void {
  const payment = findRecord(state, String(allocation.data.paymentId), "payments");
  const due = findRecord(state, String(allocation.data.dueItemId), "due-items");
  if (allocation.status === "superseded") throw new Error("A superseded allocation cannot be confirmed.");
  const amount = allocation.amountKobo;
  if (allocation.status !== "confirmed" && amount > payment.amountKobo - Number(payment.data.allocatedKobo || 0)) {
    throw new Error("Allocation exceeds remaining canonical payment amount.");
  }
  allocation.status = "confirmed";
  allocation.data.confirmedAt ||= ctx.now;
  paymentDimensions(payment);
  payment.data.allocatedKobo = Number(payment.data.allocatedKobo || 0) + amount;
  const remaining = Math.max(0, outstanding(due) - amount);
  due.data.outstandingKobo = remaining;
  due.status = remaining === 0 ? "paid" : "partially_paid";
  const unapplied = payment.amountKobo - Number(payment.data.allocatedKobo);
  if (unapplied === 0) payment.status = "allocated";
  else if (remaining === 0) {
    // 7.3: the excess is unapplied credit on the customer position and an exception; never auto-applied elsewhere.
    payment.status = "overpaid";
    raiseException(state, ctx, "overpayment", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: unapplied, notes: `${unapplied} kobo remains unapplied after due item ${due.reference} was settled.` });
  } else payment.status = "partial";
  if (!payment.data.proposedDueItemId || payment.data.proposedDueItemId === due.id) { delete payment.data.proposedDueItemId; delete payment.data.proposedAmountKobo; }
  touch(allocation, ctx.now); touch(payment, ctx.now); touch(due, ctx.now);
  if (remaining === 0) cancelUnsentAttempts(state, due.id, ctx.now);
}

/** REC-09: a wrong automatic allocation is superseded and the due item and payment are reopened. */
export function supersedeAllocation(state: DomainState, ctx: Context, allocation: TypedRecord<"allocations">, reason: string): void {
  if (allocation.status !== "confirmed") { allocation.status = "superseded"; touch(allocation, ctx.now); return; }
  const payment = findRecord(state, String(allocation.data.paymentId), "payments");
  const due = findRecord(state, String(allocation.data.dueItemId), "due-items");
  allocation.status = "superseded";
  allocation.data.supersededReason = reason;
  payment.data.allocatedKobo = Math.max(0, Number(payment.data.allocatedKobo || 0) - allocation.amountKobo);
  payment.status = Number(payment.data.allocatedKobo) === 0 ? "unallocated" : "partial";
  const restored = Math.min(due.amountKobo, outstanding(due) + allocation.amountKobo);
  due.data.outstandingKobo = restored;
  if (!["in_dispute", "cancelled", "closed"].includes(due.status)) due.status = restored === due.amountKobo ? (attemptsFor(state, due.id).length ? "in_collection" : "scheduled") : "partially_paid";
  touch(allocation, ctx.now); touch(payment, ctx.now); touch(due, ctx.now);
}

function reversePayment(state: DomainState, ctx: Context, payment: TypedRecord<"payments">): void {
  if (payment.data.reversalApplied) return;
  payment.data.reversalStatus = "reversed";
  payment.data.reversedAt = ctx.now;
  payment.data.reversalApplied = true;
  recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id && item.status === "confirmed").forEach((allocation) => {
    const due = findRecord(state, String(allocation.data.dueItemId), "due-items");
    due.data.outstandingKobo = Math.min(due.amountKobo, outstanding(due) + allocation.amountKobo);
    due.status = "in_dispute";
    allocation.status = "superseded";
    allocation.data.supersededReason = "Payment reversed by the provider.";
    touch(allocation, ctx.now); touch(due, ctx.now);
  });
  payment.status = "unallocated";
  payment.data.allocatedKobo = 0;
  touch(payment, ctx.now);
}

/** ING-03: every observation resolves to one canonical Payment by its strong keys; the batch leg of a statement never becomes a customer Payment. */
function canonicalPayment(state: DomainState, ctx: Context, observation: TypedRecord<"observations">): TypedRecord<"payments"> | undefined {
  const source = String(observation.data.source);
  const ref = observation.reference;
  if (source === "statement" && (observation.data.batchReference || observation.data.resolutionKey === "batch")) return undefined;
  const prior = recordsOf(state, "payments").find((item) => item.reference === ref || item.data.providerReference === ref || item.id === observation.data.paymentId);
  const gross = Number(observation.data.grossAmountKobo ?? observation.amountKobo);
  const observedAt = String(observation.data.occurredAt || observation.createdAt);
  const payment = prior || makeRecord(state, "payments", {
    name: "Canonical payment", status: "unallocated", reference: ref, customerId: observation.customerId, createdAt: ctx.now,
    amountKobo: gross,
    data: {
      providerReference: ref, providerConnection: observation.data.provider || state.merchant.provider, currency: "NGN", channel: channelFor(source),
      narration: observation.data.narration, virtualAccountCustomerId: observation.data.virtualAccountCustomerId, dueItemId: observation.data.dueItemId,
      observedAt, collectionStatus: source === "webhook" ? "succeeded" : "received", settlementStatus: "unsettled", reversalStatus: "none", refundStatus: "none",
      allocatedKobo: 0, canonical: true,
    },
  });
  paymentDimensions(payment);
  if (prior && source === "webhook" && gross > payment.amountKobo && Number(payment.data.allocatedKobo) === 0) payment.amountKobo = gross;
  if (!payment.data.observedAt || Date.parse(observedAt) < Date.parse(String(payment.data.observedAt))) payment.data.observedAt = observedAt;
  if (!payment.data.dueItemId && observation.data.dueItemId) payment.data.dueItemId = observation.data.dueItemId;
  if (!payment.customerId && observation.customerId) payment.customerId = observation.customerId;
  if (observation.data.narration) payment.data.narration = observation.data.narration;
  if (observation.data.virtualAccountCustomerId) payment.data.virtualAccountCustomerId = observation.data.virtualAccountCustomerId;
  if (source === "webhook") payment.data.collectionStatus = "succeeded";
  if (source === "settlement") {
    payment.data.settlementStatus = "settled";
    payment.data.settledAt ||= observedAt;
    settlementBatch(state, ctx, observation, payment);
  }
  if (observation.data.reversed === true || observation.data.reversalStatus === "reversed") reversePayment(state, ctx, payment);
  observation.status = "resolved";
  observation.data.paymentId = payment.id;
  observation.data.resolutionKey = prior ? "canonical_provider_reference" : "new_canonical_provider_reference";
  touch(observation, ctx.now); touch(payment, ctx.now);
  return payment;
}

/** The due item a Payment was collected for, by its strong keys: the attempt's provider debit reference, then the observation's explicit link. */
export function intendedDueItem(state: DomainState, payment: TypedRecord<"payments">): { due: TypedRecord<"due-items">; key: string } | undefined {
  const byAttempt = recordsOf(state, "attempts").find((attempt) => attempt.data.providerReference ? attempt.data.providerReference === payment.reference : Boolean(attempt.reference) && attempt.reference === payment.reference);
  const candidate = byAttempt
    ? { id: String(byAttempt.data.dueItemId), key: byAttempt.data.providerReference ? "attempt_provider_reference" : "attempt_reference" }
    : payment.data.dueItemId ? { id: String(payment.data.dueItemId), key: "observation_due_item" } : undefined;
  if (!candidate) return undefined;
  const due = recordsOf(state, "due-items").find((record) => record.id === candidate.id);
  if (!due || (payment.customerId && due.customerId !== payment.customerId)) return undefined;
  return { due, key: candidate.key };
}

/** Section 7.2 rule ladder, applied to canonical Payments, never to observations. */
function matchPayment(state: DomainState, ctx: Context, payment: TypedRecord<"payments">): void {
  if (payment.status !== "unallocated" || paymentReversed(payment)) return;
  const sameConnection = String(payment.data.providerConnection || state.merchant.provider) === String(state.merchant.provider) || Boolean(payment.data.providerConnection);
  const currencyOk = String(payment.data.currency || "NGN") === "NGN";
  const intended = intendedDueItem(state, payment);
  // ING-05 (b): a second Payment for a due item that is already paid is held, never allocated.
  if (intended && outstanding(intended.due) === 0) {
    payment.status = "possible_duplicate";
    payment.data.explanation = `Due item ${intended.due.reference} is already paid; this second payment is held for Finance (${intended.key}).`;
    raiseException(state, ctx, "suspected_duplicate", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: payment.amountKobo, notes: payment.data.explanation });
    return;
  }
  // ING-05 (a): the later of two near-identical Payments from the same payer inside two minutes is held, never allocated.
  const observedBefore = (item: TypedRecord<"payments">) => {
    const delta = paymentObservedAt(item) - paymentObservedAt(payment);
    return delta < 0 || (delta === 0 && `${item.createdAt}${item.id}` < `${payment.createdAt}${payment.id}`);
  };
  const twin = recordsOf(state, "payments").find((item) =>
    item.id !== payment.id && item.reference !== payment.reference && payment.customerId && item.customerId === payment.customerId &&
    item.amountKobo === payment.amountKobo && item.status !== "possible_duplicate" && !paymentReversed(item) &&
    observedBefore(item) && paymentObservedAt(payment) - paymentObservedAt(item) <= DUPLICATE_WINDOW_MS,
  );
  if (twin) {
    payment.status = "possible_duplicate";
    payment.data.explanation = `Near-identical to payment ${twin.reference} from the same payer within two minutes; held for Finance.`;
    raiseException(state, ctx, "suspected_duplicate", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: payment.amountKobo, notes: payment.data.explanation });
    return;
  }
  const dues = recordsOf(state, "due-items").filter((item) => item.customerId === payment.customerId && outstanding(item) > 0 && !["in_dispute", "unpaid_final", "cancelled", "closed"].includes(item.status));
  // R1: provider reference, same tenant and connection, NGN, gross amount equals the attempt (due) amount.
  if (intended && currencyOk && sameConnection && payment.amountKobo === intended.due.amountKobo && outstanding(intended.due) >= payment.amountKobo) {
    allocatePayment(state, ctx, payment, intended.due, payment.amountKobo, "R1", "certain", true, `Provider reference ${payment.reference} resolved to instalment ${intended.due.reference} by ${intended.key}; currency and gross amount match.`);
    return;
  }
  // R2: dedicated virtual account, exact amount of the oldest outstanding due item.
  const virtualAccountDues = dues.filter((due) => String(payment.data.virtualAccountCustomerId || "") === due.customerId).sort((a, b) => String(a.data.dueDate).localeCompare(String(b.data.dueDate)));
  if (virtualAccountDues.length && virtualAccountDues[0]!.amountKobo === payment.amountKobo && outstanding(virtualAccountDues[0]!) === payment.amountKobo) {
    allocatePayment(state, ctx, payment, virtualAccountDues[0]!, payment.amountKobo, "R2", "certain", true, "Dedicated virtual account credit equals the oldest outstanding instalment.");
    return;
  }
  // R3: dedicated virtual account, different amount: proposed as partial or overpayment against the oldest outstanding item.
  if (virtualAccountDues.length && payment.amountKobo !== virtualAccountDues[0]!.amountKobo) {
    const oldest = virtualAccountDues[0]!;
    allocatePayment(state, ctx, payment, oldest, Math.min(payment.amountKobo, outstanding(oldest)), "R3", "probable", false, payment.amountKobo < oldest.amountKobo ? "Virtual account credit is less than the oldest instalment; proposed as a partial payment." : "Virtual account credit exceeds the oldest instalment; proposed with the excess as unapplied credit.");
    return;
  }
  // R4: a due item's external reference in the narration; certain only if unique within the tenant.
  const narration = String(payment.data.narration || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const exact = narration ? dues.filter((due) => due.reference && narration.includes(due.reference.toLowerCase().replace(/[^a-z0-9]/g, "")) && due.amountKobo === payment.amountKobo) : [];
  if (exact.length === 1) { allocatePayment(state, ctx, payment, exact[0]!, payment.amountKobo, "R4", "certain", true, `Narration carries the unique reference ${exact[0]!.reference} and the amount matches.`); return; }
  if (exact.length > 1) { allocatePayment(state, ctx, payment, exact[0]!, payment.amountKobo, "R4", "probable", false, "Narration reference is not unique within the tenant; proposed for Finance."); return; }
  // R5: amount, payer and a five-day window around the due date.
  const near = dues.filter((due) => due.amountKobo === payment.amountKobo && Math.abs(Date.parse(String(due.data.dueDate)) - paymentObservedAt(payment)) <= 5 * DAY_MS);
  if (near.length === 1) allocatePayment(state, ctx, payment, near[0]!, payment.amountKobo, "R5", "probable", false, "Amount and payer match one instalment within five days of its due date; Finance confirmation required.");
}

/**
 * Section 6.3, applied by the close to every open obligation under an approved
 * policy: the arm is assigned at the first eligible failure, every decision is
 * recorded (RET-03), give-up rows become exceptions so the LMS can be told
 * (REC-04), and a notice not evidenced by its deadline defers the attempt.
 */
function applyDecisions(state: DomainState, ctx: Context): { finalFailures: number; disputes: number; decisionsRecorded: number; deferred: number } {
  let finalFailures = 0, disputes = 0, decisionsRecorded = 0, deferred = 0;
  enrolEligibleFailures(state, ctx);
  for (const due of recordsOf(state, "due-items").filter((item) => ["scheduled", "in_collection", "partially_paid"].includes(item.status))) {
    const policy = approvedPolicyFor(state, due);
    if (!policy) continue;
    const decision = evaluateRetry(state, ctx, due, policy);
    if (decision.decision === "not_eligible") continue; // Nothing happened to this item; there is no decision to record.
    if (recordRetryDecision(state, ctx, due, decision)) decisionsRecorded += 1;
    if (decision.decision === "give_up") {
      due.status = "unpaid_final"; due.data.giveUpRule = decision.rule; touch(due, ctx.now);
      const type: ExceptionType = decision.inputs.code === "MANDATE_LIMIT_EXCEEDED" ? "mandate_limit_exceeded" : "unpaid_after_final_attempt";
      raiseException(state, ctx, type, { linkedRecordId: due.id, customerId: due.customerId, amountKobo: outstanding(due), notes: `${due.reference}: ${decision.reason}` });
      finalFailures += 1;
    } else if (decision.decision === "stop" && decision.rule === "customer_disputed") {
      due.status = "in_dispute"; touch(due, ctx.now);
      raiseException(state, ctx, "customer_dispute", { linkedRecordId: due.id, customerId: due.customerId, amountKobo: outstanding(due), notes: `${due.reference}: the customer disputed the debit.` });
      disputes += 1;
    } else if (decision.decision === "defer") {
      raiseException(state, ctx, "notice_not_evidenced", { linkedRecordId: due.id, customerId: due.customerId, amountKobo: outstanding(due), notes: `${due.reference}: ${decision.reason}` });
      deferred += 1;
    }
  }
  return { finalFailures, disputes, decisionsRecorded, deferred };
}

export function reconcile(state: DomainState, ctx: Context): { message: string; data: Record<string, any> } {
  const observations = recordsOf(state, "observations").filter((item) => item.status === "unresolved");
  const exceptionsBefore = recordsOf(state, "exceptions").length;
  const resolved = observations.map((item) => canonicalPayment(state, ctx, item)).filter(Boolean) as TypedRecord<"payments">[];
  const statementBatchesMatched = matchSettlementStatements(state, ctx);
  const feeVariances = checkBatchFees(state, ctx);
  const allocationsBefore = new Set(recordsOf(state, "allocations").map((item) => item.id));
  recordsOf(state, "payments").filter((item) => item.status === "unallocated").forEach((payment) => matchPayment(state, ctx, payment));
  const now = Date.parse(ctx.now);
  const aged = recordsOf(state, "payments").filter((item) => item.status === "unallocated" && now - paymentObservedAt(item) >= UNALLOCATED_AGE_MS);
  aged.forEach((payment) => raiseException(state, ctx, "unallocated_payment", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: payment.amountKobo, notes: "No certain or confirmed allocation after 24 hours." }));
  const giveUps = applyDecisions(state, ctx);
  const unknownOutcomes = recordsOf(state, "attempts").filter((attempt) => attempt.status === "unknown" && now - Date.parse(attemptTime(attempt)) >= DAY_MS);
  unknownOutcomes.forEach((attempt) => raiseException(state, ctx, "unknown_outcome", { linkedRecordId: attempt.id, customerId: attempt.customerId, amountKobo: attempt.amountKobo, notes: "TIMEOUT_UNKNOWN unresolved for 24 hours; the provider must confirm the outcome by reference." }));
  const mappingNeeded = recordsOf(state, "attempts").filter((attempt) => attempt.status === "failed" && normaliseFailureCode(attempt.data.failureCode) === "UNKNOWN" && attempt.data.rawFailureCode);
  mappingNeeded.forEach((attempt) => raiseException(state, ctx, "mapping_needed", { linkedRecordId: attempt.id, customerId: attempt.customerId, amountKobo: attempt.amountKobo, notes: `Provider code "${attempt.data.rawFailureCode}" is not in the failure-code mapping.` }));
  const newAllocations = recordsOf(state, "allocations").filter((item) => !allocationsBefore.has(item.id));
  const allocationsByRule: Record<string, number> = {};
  for (const allocation of newAllocations) allocationsByRule[String(allocation.data.rule)] = (allocationsByRule[String(allocation.data.rule)] || 0) + 1;
  const observationsBySource: Record<string, number> = {};
  for (const observation of observations.filter((item) => item.status === "resolved")) observationsBySource[String(observation.data.source)] = (observationsBySource[String(observation.data.source)] || 0) + 1;
  return {
    message: "Observations resolved to canonical payments and matched; no external settlement or instruction was performed.",
    data: {
      observationsResolved: observations.filter((item) => item.status === "resolved").length, observationsBySource, canonicalPayments: resolved.length,
      settlementStatementsMatched: statementBatchesMatched, settlementVariances: feeVariances, allocationsByRule,
      proposed: recordsOf(state, "payments").filter((item) => item.status === "proposed").length,
      unallocated: recordsOf(state, "payments").filter((item) => item.status === "unallocated").length,
      possibleDuplicates: recordsOf(state, "payments").filter((item) => item.status === "possible_duplicate").length,
      agedUnallocated: aged.length, finalAttemptExceptions: giveUps.finalFailures, disputesFrozen: giveUps.disputes, noticesNotEvidenced: giveUps.deferred, retryDecisionsRecorded: giveUps.decisionsRecorded, unknownOutcomes: unknownOutcomes.length,
      exceptionsOpened: recordsOf(state, "exceptions").length - exceptionsBefore,
    },
  };
}
