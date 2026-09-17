import { assertNoRealBankDetails, findRecord, masked, recordsOf } from "./records";
import type { Context, DomainState, ValopayRecord } from "./types";

const roles = new Set(["Admin", "Operations", "Finance", "Compliance reviewer", "Read-only"]);
const editableKinds = new Set([
  "customers", "mandates", "due-items", "attempts", "observations", "exceptions",
  "policies", "templates", "cutovers", "commercial", "reviews", "evidence",
  "experiments", "costs", "calendar", "settlement-batches",
]);
const statuses: Record<string, string[]> = {
  customers: ["active"],
  mandates: ["active", "pending_activation", "suspended", "cancelled", "expired"],
  "due-items": ["scheduled", "in_collection", "paid", "partially_paid", "unpaid_final", "in_dispute"],
  attempts: ["succeeded", "failed", "unknown", "scheduled", "cancelled"],
  observations: ["resolved", "unresolved"],
  "settlement-batches": ["pending", "reconciled", "variance"],
  payments: ["allocated", "partial", "overpaid", "proposed", "unallocated", "possible_duplicate"],
  allocations: ["confirmed", "proposed", "superseded"],
  exceptions: ["open", "assigned", "in_progress", "resolved", "closed"],
  policies: ["draft", "submitted", "approved", "rejected"],
  templates: ["draft", "submitted", "approved"],
  experiments: ["draft", "preregistered", "closed"],
};

function requireRole(ctx: Context, allowed: string[]): void {
  if (!roles.has(ctx.role)) throw new Error("Unknown demo role.");
  if (!allowed.includes(ctx.role)) throw new Error(`${ctx.role} is not permitted to make this change.`);
}

function requireData(data: Record<string, any>, key: string): void {
  if (data[key] === undefined || data[key] === null || data[key] === "") {
    throw new Error(`${key} is required.`);
  }
}

function positiveInteger(value: unknown, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be an integer in kobo.`);
  }
}

function isoDate(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date or UTC ISO timestamp.`);
  }
}

function validateDates(value: unknown, key = ""): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => {
      if (/(At|Date|Deadline)$/.test(childKey) && child !== undefined && child !== null) isoDate(child, childKey);
      validateDates(child, childKey);
    });
  } else if (Array.isArray(value)) value.forEach((child) => validateDates(child, key));
}

function parent(state: DomainState, id: unknown, kind: string, label: string): ValopayRecord {
  if (typeof id !== "string" || !id) throw new Error(`${label} is required.`);
  const item = findRecord(state, id, kind);
  if (item.merchantId !== state.merchant.id) throw new Error(`${label} belongs to another tenant.`);
  return item;
}

export function validateRecord(
  state: DomainState,
  ctx: Context,
  kind: string,
  input: Partial<ValopayRecord> & { data?: Record<string, any> },
  isUpdate = false,
): void {
  assertNoRealBankDetails(input);
  validateDates(input);
  if (!editableKinds.has(kind)) throw new Error(`${kind} cannot be created or edited directly.`);
  if (!roles.has(ctx.role) || ctx.role === "Read-only") throw new Error("This demo role has read-only access.");
  if (input.merchantId && input.merchantId !== state.merchant.id) throw new Error("Records cannot be linked across tenants.");
  if (input.amountKobo !== undefined) positiveInteger(input.amountKobo, "amountKobo", true);
  if (input.status && statuses[kind] && !statuses[kind].includes(input.status)) {
    throw new Error(`Invalid ${kind} status.`);
  }
  const data = input.data || {};
  const existing = isUpdate && input.id ? findRecord(state, input.id, kind) : undefined;
  if (isUpdate && !existing) throw new Error("An update requires the existing record id.");
  if (existing?.status === "approved" && (kind === "policies" || kind === "templates")) {
    throw new Error("Approved versions are immutable; create a new version instead.");
  }
  if (isUpdate && input.status && ["paid", "resolved", "approved", "preregistered"].includes(input.status) && input.status !== existing?.status) {
    throw new Error("This protected status can only be set by its domain action.");
  }
  if (isUpdate && ["policies", "templates", "experiments"].includes(kind) && input.status && input.status !== existing?.status) {
    throw new Error("Lifecycle status transitions can only be performed by the domain action.");
  }

  if (kind === "customers") {
    requireRole(ctx, ["Admin", "Operations", "Finance"]);
    requireData(data, "consentProvenance");
    if (data.accountMasked !== undefined && !masked(data.accountMasked)) {
      throw new Error("Customer account identifiers must be masked.");
    }
    if (data.phoneMasked !== undefined && !masked(data.phoneMasked)) {
      throw new Error("Customer phone identifiers must be masked.");
    }
  }
  if (kind === "mandates") {
    requireRole(ctx, ["Admin", "Operations"]);
    parent(state, input.customerId, "customers", "A mandate customer");
    positiveInteger(input.amountKobo, "Mandate limit");
    requireData(data, "workflow");
    if(!["transfer_to_activate","hosted_consent"].includes(data.workflow))throw new Error("Select a supported activation workflow.");
    requireData(data, "consentEvidence");
    if (data.policyId) parent(state, data.policyId, "policies", "mandate policyId");
    if (data.origin === "imported" && !data.consentGaps) throw new Error("Imported mandates must record consent gaps.");
    if(existing&&["consentEvidence","workflow","origin"].some(key=>JSON.stringify(data[key])!==JSON.stringify(existing.data[key])))throw new Error("Consent provenance is immutable. Reissue the mandate with a new consent record.");
  }
  if (kind === "due-items") {
    requireRole(ctx, ["Admin", "Operations", "Finance"]);
    parent(state, input.customerId, "customers", "A due item customer");
    positiveInteger(input.amountKobo, "Due amount");
    if(Number(input.amountKobo)<500000)throw new Error("Debits under ₦5,000 are refused with no override.");
    if(Number(input.amountKobo)<1000000){
      const override=data.overrideReason||data.adminOverrideReason;
      const preserved=existing&&existing.amountKobo===input.amountKobo&&(existing.data.overrideReason||existing.data.adminOverrideReason)===override;
      if(!override||(!preserved&&ctx.role!=="Admin"))throw new Error("Debits from ₦5,000 to below ₦10,000 require a recorded merchant Admin override reason.");
    }
    if(!isUpdate&&input.status!=="scheduled")throw new Error("New due items start scheduled. Payment status is derived from allocations.");
    if(existing&&input.status!==existing.status)throw new Error("Due-item status is derived from collection and reconciliation actions.");
    if (!["lms", "merchant_manual", "provider_auto", "valopay"].includes(data.owner)) throw new Error("A due item requires a valid owner.");
    requireData(data, "dueDate");
    isoDate(data.dueDate, "dueDate");
    if (data.mandateId) {
      const mandate = parent(state, data.mandateId, "mandates", "dueItem mandateId");
      if (mandate.customerId !== input.customerId) throw new Error("A due item mandate must belong to the same customer.");
    }
    if (data.owner === "valopay" && !recordsOf(state, "cutovers").some((item) => item.status === "ready" && item.data.confirmation && item.data.accountableUser)) {
      throw new Error("Valo ownership is blocked until a ready synthetic cutover has accountable confirmation.");
    }
    if (data.outstandingKobo !== undefined && (!Number.isInteger(data.outstandingKobo) || data.outstandingKobo<0 || data.outstandingKobo > input.amountKobo!)) {
      throw new Error("Outstanding balance cannot exceed the due amount.");
    }
  }
  if (kind === "attempts") {
    requireRole(ctx, ["Admin", "Operations"]);
    if (isUpdate) throw new Error("Attempt facts are immutable.");
    const due = parent(state, data.dueItemId, "due-items", "attempt dueItemId");
    if (due.customerId !== input.customerId) throw new Error("Attempt customer must match its due item.");
    if (input.amountKobo !== due.amountKobo) throw new Error("Attempt amount must match the due item amount.");
    if (data.source !== "external" || data.simulated !== true) {
      throw new Error("Attempts may only be immutable synthetic external imported facts; no debit instruction is available.");
    }
    if (data.occurredAt) isoDate(data.occurredAt, "attempt occurredAt");
  }
  if (kind === "observations") {
    requireRole(ctx, ["Admin", "Operations", "Finance"]);
    requireData(data, "source");
    if (!["webhook", "settlement", "statement", "transfer", "card"].includes(data.source)) {
      throw new Error("Observation source is invalid.");
    }
    if (!input.reference) throw new Error("Observations require a canonical provider reference.");
    if(input.customerId)parent(state, input.customerId, "customers", "observation customer");
    if(isUpdate)throw new Error("Observation evidence is immutable; record a correction as new evidence.");
    if (data.paymentId !== undefined || data.resolutionKey !== undefined || (!isUpdate && input.status === "resolved")) {
      throw new Error("Observation resolution is server-owned and cannot be supplied on create.");
    }
    if (data.dueItemId) {
      const due = parent(state, data.dueItemId, "due-items", "observation dueItemId");
      if (due.customerId !== input.customerId) throw new Error("Observation due item must belong to its customer.");
    }
  }
  if (kind === "policies") {
    requireRole(ctx, ["Admin"]);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("Policies are created as drafts only.");
    if (data.reviewer !== undefined&&data.reviewer!==existing?.data.reviewer) throw new Error("Policy reviewer metadata is server-owned.");
    const maxAttempts = data.maxAttempts ?? 3;
    const spacing = data.spacingHours ?? 48;
    const firstNotice = data.firstNoticeHours ?? 48;
    const retryNotice = data.retryNoticeHours ?? 24;
    [maxAttempts, spacing, firstNotice, retryNotice].forEach((value) => {
      if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error("Policy numeric inputs must be finite integers.");
    });
    if (maxAttempts > 4 || maxAttempts < 1 || spacing < 24 || firstNotice < 24 || retryNotice < 24 || data.partialAllowed === true) {
      throw new Error("Policy violates the immutable attempt, spacing, notice, or partial-debit guardrails.");
    }
    if (data.author !== ctx.actor) throw new Error("The policy author must be the acting demo persona.");
  }
  if (kind === "templates") {
    requireRole(ctx, ["Admin"]);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("Templates are created as drafts only.");
    if (data.reviewer !== undefined&&data.reviewer!==existing?.data.reviewer) throw new Error("Template reviewer metadata is server-owned.");
    if (data.author !== ctx.actor) throw new Error("The template author must be the acting demo persona.");
    const text = String(data.text || "");
    for (const field of ["{{amount}}", "{{date}}", "{{merchant}}", "{{contact}}"]) {
      if (!text.includes(field)) throw new Error(`Template text must include ${field}.`);
    }
  }
  if (kind === "experiments") {
    requireRole(ctx, ["Admin"]);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("Experiments are created as drafts only.");
    const holdout = Number(data.holdoutShare);
    if (!Number.isFinite(holdout) || holdout < 0.1 || holdout > 0.5 || !Number.isInteger(data.minPerArm) || !data.seed) {
      throw new Error("Experiment requires a 10–50% holdout, integer minimum per arm, and seed.");
    }
    parent(state, data.policyId, "policies", "experiment policyId");
  }
  if (kind === "exceptions" && data.linkedRecordId) {
    const linked = state.records.find((item) => item.id === data.linkedRecordId);
    if (!linked || linked.merchantId !== state.merchant.id) throw new Error("Exception linkedRecordId must belong to this tenant.");
  }
  if (kind === "commercial" && data.designPartner && !data.signedFullPriceTerms) {
    // A discounted design-partner entry is allowed, but it cannot be treated as proof of a real Test 3 sale.
    data.realTest3Qualified = false;
  }
  if(["cutovers","evidence","experiments"].includes(kind))requireRole(ctx,["Admin"]);
  if(["commercial","costs","settlement-batches"].includes(kind))requireRole(ctx,["Admin","Finance"]);
  if(kind==="settlement-batches"){
    for(const key of ["grossKobo","feeKobo","netKobo"])positiveInteger(data[key],key,true);
    if(data.grossKobo-data.feeKobo!==data.netKobo)throw new Error("Batch net must equal gross minus fees.");
    if(!isUpdate&&input.status!=="pending")throw new Error("Batches start pending; reconciliation determines the outcome.");
    if(existing&&input.status!==existing.status)throw new Error("Batch status is set by reconciliation.");
    requireData(data,"batchReference");
  }
}

export function assertActionRole(ctx: Context, allowed: string[]): void {
  requireRole(ctx, allowed);
}