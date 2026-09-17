import { findRecord, makeRecord, recordsOf, touch } from "./records";
import type { Context, DomainState, ValopayRecord } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

function settlementBatch(state: DomainState, ctx: Context, observation: ValopayRecord, payment: ValopayRecord): void {
  const batchReference = String(observation.data.batchReference || "");
  if (!batchReference) return;
  let batch = recordsOf(state, "settlement-batches").find((item) => item.reference === batchReference);
  if (!batch) {
    batch = makeRecord(state, "settlement-batches", {
      name: "Synthetic settlement batch", status: "pending", reference: batchReference,
      data: { provider: observation.data.provider || state.merchant.provider, providerConnection: payment.data.providerConnection, lineObservationIds: [], grossKobo: 0, feeKobo: 0, netKobo: 0 },
    });
  }
  const lineIds = batch.data.lineObservationIds as string[];
  if (!lineIds.includes(observation.id)) {
    const gross = payment.amountKobo;
    const statedFee = Number(observation.data.feeKobo);
    const inferredFee = gross > observation.amountKobo ? gross - observation.amountKobo : Math.floor((gross * Number(state.settings.providerFeeBps || 30)) / 10_000);
    const fee = Number.isSafeInteger(statedFee) && statedFee >= 0 ? statedFee : inferredFee;
    lineIds.push(observation.id);
    batch.data.grossKobo = Number(batch.data.grossKobo || 0) + gross;
    batch.data.feeKobo = Number(batch.data.feeKobo || 0) + fee;
    batch.data.netKobo = Number(batch.data.grossKobo) - Number(batch.data.feeKobo);
    observation.data.settlementBatchId = batch.id;
    observation.data.assumedFeeKobo = fee;
    touch(batch, ctx.now);
  }
}

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
    if (statement.amountKobo === Number(batch.data.netKobo)) {
      batch.status = "reconciled";
      batch.data.explanation = "Statement credit matched the settlement batch net total; it was not allocated to a customer.";
    } else {
      batch.status = "variance";
      batch.data.explanation = "Statement credit differs from gross settlement lines less recorded fees.";
      exception(state, ctx, batch, "settlement_variance", batch.data.explanation, batch.id);
    }
    touch(statement, ctx.now); touch(batch, ctx.now);
    matched += 1;
  });
  return matched;
}

function exception(state: DomainState, ctx: Context, payment: ValopayRecord | undefined, type: string, notes: string, linkedRecordId?: string): ValopayRecord {
  const linkedId = linkedRecordId || payment?.id || "";
  const existing = recordsOf(state, "exceptions").find((item) => item.status !== "closed" && item.data.linkedRecordId === linkedId && item.data.type === type);
  return existing || makeRecord(state, "exceptions", {
    name: type.replaceAll("_", " "),
    status: "open", customerId: payment?.customerId || "", amountKobo: payment?.amountKobo || 0,
    data: { type, severity: type.includes("duplicate") ? "high" : "medium", owner: "Finance", notes, linkedRecordId: linkedId, dueBy: ctx.now },
  });
}

function outstanding(due: ValopayRecord): number {
  return Number.isInteger(due.data.outstandingKobo) ? Number(due.data.outstandingKobo) : due.amountKobo;
}

function paymentDimensions(payment: ValopayRecord): void {
  payment.data.collectionStatus ||= "received";
  payment.data.settlementStatus ||= "unsettled";
  payment.data.reversalStatus ||= "not_reversed";
  payment.data.refundStatus ||= "not_refunded";
}

function cancelUnsentAttempts(state: DomainState, dueItemId: string, now: string): void {
  recordsOf(state, "attempts").filter((item) => item.data.dueItemId === dueItemId && item.status === "scheduled").forEach((item) => {
    item.status = "cancelled";
    item.data.cancellationReason = "Due item settled by another channel; no instruction was sent.";
    touch(item, now);
  });
}

export function allocatePayment(
  state: DomainState,
  ctx: Context,
  payment: ValopayRecord,
  due: ValopayRecord,
  amount: number,
  rule: string,
  confidence: "certain" | "probable" | "manual",
  automatic: boolean,
): ValopayRecord {
  if (!Number.isInteger(amount) || amount <= 0 || amount > payment.amountKobo - Number(payment.data.allocatedKobo || 0)) {
    throw new Error("Allocation exceeds the remaining canonical payment amount.");
  }
  const remaining = outstanding(due);
  if (amount > remaining) throw new Error("Allocation exceeds the due item's remaining balance.");
  const allocation = makeRecord(state, "allocations", {
    name: `Allocation ${rule}`, status: confidence === "probable" ? "proposed" : "confirmed",
    customerId: payment.customerId, amountKobo: amount,
    data: { paymentId: payment.id, dueItemId: due.id, rule, confidence, automatic, explanation: `${rule} matched this synthetic canonical payment.`, reviewed: null },
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

export function applyConfirmedAllocation(state: DomainState, ctx: Context, allocation: ValopayRecord): void {
  const payment = findRecord(state, String(allocation.data.paymentId), "payments");
  const due = findRecord(state, String(allocation.data.dueItemId), "due-items");
  if (allocation.status === "superseded") throw new Error("A superseded allocation cannot be confirmed.");
  const amount = allocation.amountKobo;
  if (amount > payment.amountKobo - Number(payment.data.allocatedKobo || 0) && allocation.status !== "confirmed") {
    throw new Error("Allocation exceeds remaining canonical payment amount.");
  }
  allocation.status = "confirmed";
  payment.data.allocatedKobo = Number(payment.data.allocatedKobo || 0) + amount;
  const remaining = Math.max(0, outstanding(due) - amount);
  due.data.outstandingKobo = remaining;
  due.status = remaining === 0 ? "paid" : "partially_paid";
  payment.status = payment.data.allocatedKobo === payment.amountKobo ? "allocated" : "partial";
  if (payment.amountKobo > payment.data.allocatedKobo) {
    payment.status = "partial";
  }
  paymentDimensions(payment);
  touch(allocation, ctx.now); touch(payment, ctx.now); touch(due, ctx.now);
  if (remaining === 0) cancelUnsentAttempts(state, due.id, ctx.now);
}

function reversePayment(state: DomainState, ctx: Context, payment: ValopayRecord): void {
  if (payment.data.reversalApplied) return;
  payment.data.reversalStatus = "reversed";
  payment.data.reversalApplied = true;
  recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id && item.status === "confirmed").forEach((allocation) => {
    const due = findRecord(state, String(allocation.data.dueItemId), "due-items");
    due.data.outstandingKobo = outstanding(due) + allocation.amountKobo;
    due.status = "in_dispute";
    allocation.status = "superseded";
    touch(allocation, ctx.now); touch(due, ctx.now);
  });
  payment.status = "unallocated";
  payment.data.allocatedKobo = 0;
  touch(payment, ctx.now);
}

function canonicalPayment(state: DomainState, ctx: Context, observation: ValopayRecord): ValopayRecord | undefined {
  const source = observation.data.source;
  const ref = observation.reference;
  const prior = recordsOf(state, "payments").find((item) => item.reference === ref || item.data.providerReference === ref || item.id === observation.data.paymentId);
  if (source === "statement" && (observation.data.batchReference || observation.data.resolutionKey === "batch")) {
    return undefined;
  }
  const payment = prior || makeRecord(state, "payments", {
    name: "Canonical synthetic payment", status: "unallocated", reference: ref, customerId: observation.customerId,
    amountKobo: Number(observation.data.grossAmountKobo ?? observation.amountKobo),
    data: { providerReference: ref, providerConnection: observation.data.provider || state.merchant.provider, currency: "NGN", channel: source, narration: observation.data.narration, virtualAccountCustomerId: observation.data.virtualAccountCustomerId, collectionStatus: source === "webhook" ? "succeeded" : "received", settlementStatus: "unsettled", reversalStatus: "not_reversed", refundStatus: "not_refunded", allocatedKobo: 0, canonical: true },
  });
  paymentDimensions(payment);
  if (prior && source === "webhook" && Number(observation.data.grossAmountKobo ?? observation.amountKobo) > payment.amountKobo) {
    payment.amountKobo = Number(observation.data.grossAmountKobo ?? observation.amountKobo);
  }
  if (observation.data.narration) payment.data.narration = observation.data.narration;
  if (observation.data.virtualAccountCustomerId) payment.data.virtualAccountCustomerId = observation.data.virtualAccountCustomerId;
  if (source === "settlement") payment.data.settlementStatus = "settled";
  if (source === "settlement") settlementBatch(state, ctx, observation, payment);
  if (observation.data.reversed === true || observation.data.reversalStatus === "reversed") reversePayment(state, ctx, payment);
  observation.status = "resolved";
  observation.data.paymentId = payment.id;
  observation.data.resolutionKey = prior ? "canonical_provider_reference" : "new_canonical_provider_reference";
  touch(observation, ctx.now); touch(payment, ctx.now);
  return payment;
}

function matchPayment(state: DomainState, ctx: Context, payment: ValopayRecord): void {
  if (payment.status === "allocated" || payment.status === "proposed" || payment.status === "possible_duplicate" || payment.data.reversalStatus === "reversed") return;
  const dues = recordsOf(state, "due-items").filter((item) => item.customerId === payment.customerId && outstanding(item) > 0 && !["in_dispute", "unpaid_final"].includes(item.status));
  const duplicate = recordsOf(state, "payments").some((item) => item.id !== payment.id && item.customerId === payment.customerId && item.amountKobo === payment.amountKobo && item.status === "allocated" && Math.abs(Date.parse(item.createdAt) - Date.parse(payment.createdAt)) < 5 * DAY_MS);
  if (duplicate) {
    payment.status = "possible_duplicate";
    exception(state, ctx, payment, "possible_duplicate", "Near-identical payment is held for Finance; it was not auto-allocated.");
    return;
  }
  const attemptMatches = recordsOf(state, "attempts").filter((item) =>
    item.reference === payment.reference &&
    item.amountKobo === payment.amountKobo &&
    String(payment.data.currency || "NGN") === "NGN" &&
    String(item.data.providerConnection || state.merchant.provider) === String(payment.data.providerConnection || state.merchant.provider),
  );
  if (attemptMatches.length === 1) {
    const attempt = attemptMatches[0];
    const due = findRecord(state, String(attempt.data.dueItemId), "due-items");
    if (outstanding(due) >= payment.amountKobo) { allocatePayment(state, ctx, payment, due, payment.amountKobo, "R1", "certain", true); return; }
  }
  const virtualExact = dues.filter((due) =>
    due.amountKobo === payment.amountKobo &&
    String(payment.data.virtualAccountCustomerId || "") === due.customerId,
  );
  if (virtualExact.length === 1) { allocatePayment(state, ctx, payment, virtualExact[0], payment.amountKobo, "R2", "certain", true); return; }
  const narration = String(payment.data.narration || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const exact = dues.filter((due) => narration.includes(due.reference.toLowerCase().replace(/[^a-z0-9]/g, "")) && due.amountKobo === payment.amountKobo);
  if (exact.length === 1) { allocatePayment(state, ctx, payment, exact[0], payment.amountKobo, "R4", "certain", true); return; }
  if (exact.length > 1) { allocatePayment(state, ctx, payment, exact[0], payment.amountKobo, "R4", "probable", false); return; }
  const near = dues.filter((due) => due.amountKobo === payment.amountKobo && Math.abs(Date.parse(String(due.data.dueDate)) - Date.parse(payment.createdAt)) <= 5 * DAY_MS);
  if (near.length === 1) allocatePayment(state, ctx, payment, near[0], payment.amountKobo, "R5", "probable", false);
}

export function reconcile(state: DomainState, ctx: Context): { message: string; data: Record<string, any> } {
  const observations = recordsOf(state, "observations").filter((item) => item.status === "unresolved");
  const resolved = observations.map((item) => canonicalPayment(state, ctx, item)).filter(Boolean) as ValopayRecord[];
  const statementBatchesMatched = matchSettlementStatements(state, ctx);
  recordsOf(state, "payments").filter((item) => item.status === "unallocated").forEach((payment) => matchPayment(state, ctx, payment));
  const aged = recordsOf(state, "payments").filter((item) => item.status === "unallocated" && Date.parse(ctx.now) - Date.parse(item.createdAt) >= DAY_MS);
  aged.forEach((payment) => exception(state, ctx, payment, "unallocated_payment", "No certain or confirmed allocation after 24 hours."));
  const finalFailures = recordsOf(state, "due-items").filter((due) => {
    const policy = recordsOf(state, "policies").find((item) => item.id === due.data.policyId && item.status === "approved");
    const failures = recordsOf(state, "attempts").filter((item) => item.data.dueItemId === due.id && item.status === "failed").length;
    return due.status !== "paid" && policy && failures >= Number(policy.data.maxAttempts || 3);
  });
  finalFailures.forEach((due) => {
    due.status = "unpaid_final"; touch(due, ctx.now);
    exception(state, ctx, undefined, "unpaid_after_final_attempt", `Due item ${due.reference} exhausted its synthetic policy attempts.`, due.id);
  });
  return { message: "Synthetic observations reconciled; no external settlement or instruction was performed.", data: { observationsResolved: observations.filter((item) => item.status === "resolved").length, canonicalPayments: resolved.length, settlementStatementsMatched: statementBatchesMatched, agedUnallocated: aged.length, finalAttemptExceptions: finalFailures.length } };
}