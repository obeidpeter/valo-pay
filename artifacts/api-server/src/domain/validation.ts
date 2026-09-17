import {
  ABSOLUTE_TICKET_FLOOR_KOBO, PLATFORM_OWNER, activationWorkflows, defaultStatus, describeIssues,
  editableKinds, exceptionCatalogue, exceptionTransitions, experimentRules, isActionOnlyStatus, mandateTransitions, normaliseFailureCode,
  normaliseOwner, policyGuardrails, recordDataSchemas, recordStatuses, resolveExceptionType, roles, isKnownFailureCode,
} from "@workspace/valopay-schema";
import { assertNoRealBankDetails, findRecord, masked, recordsOf } from "./records";
import type { Context, DomainState, ValopayRecord } from "./types";
import { addBusinessDays } from "./calendar";
import { countedAttempts, minimumTicketKobo } from "./policy-engine";

const roleSet = new Set<string>(roles);
const editable = new Set<string>(editableKinds);
const statuses: Record<string, readonly string[]> = recordStatuses;

function requireRole(ctx: Context, allowed: string[]): void {
  if (!roleSet.has(ctx.role)) throw new Error("Unknown demo role.");
  if (!allowed.includes(ctx.role)) throw new Error(`${ctx.role} is not permitted to make this change.`);
}

function positiveInteger(value: unknown, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be an integer in kobo.`);
  }
}

function isoDate(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value) || Number.isNaN(Date.parse(value))) {
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

/** Typed data fields per kind from the shared schema; coerced values are written back so what is stored is what was validated. */
function parseData(kind: string, data: Record<string, any>): void {
  const schema = (recordDataSchemas as Record<string, { safeParse: (value: unknown) => { success: true; data: Record<string, unknown> } | { success: false; error: any } }>)[kind];
  if (!schema) return;
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`Invalid ${kind} data: ${describeIssues(result.error)}`);
  Object.assign(data, result.data);
}

/** The cutover contract (DEB-11) is complete only when steps 1 to 6 are recorded. */
export function cutoverComplete(cutover: ValopayRecord): boolean {
  const data = cutover.data;
  return cutover.status === "ready" && data.incumbentDisabled === true && data.externalAttemptsImported === true && data.dualRunComplete === true && Boolean(data.accountableUser) && Boolean(data.confirmation);
}

function assertTransition(kind: string, from: string, to: string): void {
  if (from === to) return;
  if (kind === "cutovers" && to === "handed_back") throw new Error("Hand-back is recorded by the hand_back action.");
  if (kind === "mandates") {
    const allowed = mandateTransitions[from as keyof typeof mandateTransitions] ?? [];
    if (!allowed.includes(to as never)) throw new Error(`A ${from} mandate cannot move to ${to}.`);
    if (to === "cancelled" || to === "suspended") throw new Error("Cancel or suspend a mandate through its action so the reason is recorded.");
    return;
  }
  if (kind === "exceptions") {
    const allowed = exceptionTransitions[from as keyof typeof exceptionTransitions] ?? [];
    if (!allowed.includes(to as never)) throw new Error(to === "resolved" ? "Resolve an exception through its action with a controlled resolution code." : `A ${from} exception cannot move to ${to}.`);
    return;
  }
  if (["policies", "templates", "experiments"].includes(kind)) {
    throw new Error("Lifecycle status transitions can only be performed by the domain action.");
  }
  if (["due-items", "attempts", "observations", "settlement-batches", "payments", "allocations"].includes(kind)) {
    throw new Error(`${kind} status is derived by the platform and cannot be set directly.`);
  }
  if (isActionOnlyStatus(kind, to)) throw new Error("This protected status can only be set by its domain action.");
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
  if (!editable.has(kind)) throw new Error(`${kind} cannot be created or edited directly.`);
  if (!roleSet.has(ctx.role) || ctx.role === "Read-only") throw new Error("This demo role has read-only access.");
  if (input.merchantId && input.merchantId !== state.merchant.id) throw new Error("Records cannot be linked across tenants.");
  if (input.amountKobo !== undefined) positiveInteger(input.amountKobo, "amountKobo", true);
  if (input.status && statuses[kind] && !statuses[kind].includes(input.status)) {
    throw new Error(`Invalid ${kind} status. Allowed: ${statuses[kind].join(", ")}.`);
  }
  const data: Record<string, any> = input.data || (input.data = {});
  const existing = isUpdate && input.id ? findRecord(state, input.id, kind) : undefined;
  if (isUpdate && !existing) throw new Error("An update requires the existing record id.");
  if (existing?.status === "approved" && (kind === "policies" || kind === "templates")) {
    throw new Error("Approved versions are immutable; create a new version instead.");
  }
  if (existing && input.status && input.status !== existing.status) assertTransition(kind, existing.status, input.status);
  if (!isUpdate && input.status && isActionOnlyStatus(kind, input.status)) {
    throw new Error(`New ${kind} records cannot start ${input.status}; that status is set by a domain action.`);
  }
  if (kind === "due-items" && data.owner !== undefined) data.owner = normaliseOwner(data.owner) ?? data.owner;
  if (kind === "settlement-batches") {
    if (!data.batchReference && input.reference) data.batchReference = input.reference;
    if (!input.reference && data.batchReference) input.reference = String(data.batchReference);
  }
  if (kind === "exceptions" && data.type !== undefined) {
    const type = resolveExceptionType(data.type);
    if (!type && !isUpdate) throw new Error(`Unknown exception type. Use one of: ${Object.keys(exceptionCatalogue).join(", ")}.`);
    if (type) {
      data.type = type;
      if (!isUpdate) {
        data.owner ||= exceptionCatalogue[type].owner;
        data.severity ||= exceptionCatalogue[type].severity;
        data.dueBy ||= addBusinessDays(state, ctx.now, exceptionCatalogue[type].slaBusinessDays);
      }
    }
  }
  parseData(kind, data);

  if (kind === "customers") {
    requireRole(ctx, ["Admin", "Operations", "Finance"]);
    if (data.accountMasked !== undefined && !masked(data.accountMasked)) throw new Error("Customer account identifiers must be masked.");
    if (data.phoneMasked !== undefined && !masked(data.phoneMasked)) throw new Error("Customer phone identifiers must be masked.");
  }
  if (kind === "mandates") {
    requireRole(ctx, ["Admin", "Operations"]);
    parent(state, input.customerId, "customers", "A mandate customer");
    positiveInteger(input.amountKobo, "Mandate limit");
    if (!activationWorkflows.includes(data.workflow)) throw new Error("Select a supported activation workflow.");
    if (data.policyId) parent(state, data.policyId, "policies", "mandate policyId");
    if (data.origin === "imported" && !data.consentGaps) throw new Error("Imported mandates must record consent gaps.");
    if (existing && ["consentEvidence", "workflow", "origin"].some((key) => JSON.stringify(data[key]) !== JSON.stringify(existing.data[key]))) {
      throw new Error("Consent provenance is immutable. Reissue the mandate with a new consent record.");
    }
  }
  if (kind === "due-items") {
    requireRole(ctx, ["Admin", "Operations", "Finance"]);
    parent(state, input.customerId, "customers", "A due item customer");
    positiveInteger(input.amountKobo, "Due amount");
    const amount = Number(input.amountKobo);
    if (amount < ABSOLUTE_TICKET_FLOOR_KOBO) throw new Error("Debits under ₦5,000 are refused with no override.");
    const minimum = minimumTicketKobo(state);
    if (amount < minimum) {
      const override = data.overrideReason || data.adminOverrideReason;
      const preserved = existing && existing.amountKobo === input.amountKobo && (existing.data.overrideReason || existing.data.adminOverrideReason) === override;
      if (!override || (!preserved && ctx.role !== "Admin")) throw new Error(`Debits from ₦5,000 to below the merchant minimum of ₦${(minimum / 100).toLocaleString("en-NG")} require a recorded merchant Admin override reason.`);
    }
    if (!isUpdate && input.status !== "scheduled") throw new Error("New due items start scheduled. Payment status is derived from allocations.");
    if (!normaliseOwner(data.owner)) throw new Error("A due item requires a valid execution owner: valopay, lms, merchant_manual or provider_auto.");
    if (data.mandateId) {
      const mandate = parent(state, data.mandateId, "mandates", "dueItem mandateId");
      if (mandate.customerId !== input.customerId) throw new Error("A due item mandate must belong to the same customer.");
    }
    if (data.owner === PLATFORM_OWNER && !recordsOf(state, "cutovers").some(cutoverComplete)) {
      throw new Error("Valo ownership is blocked until a cutover contract is complete through the dual-run day with an accountable user and written confirmation (DEB-11).");
    }
    if (data.outstandingKobo !== undefined && (!Number.isInteger(data.outstandingKobo) || data.outstandingKobo < 0 || data.outstandingKobo > input.amountKobo!)) {
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
    if (input.status === "failed") {
      if (data.failureCode !== undefined && !isKnownFailureCode(data.failureCode)) data.rawFailureCode = String(data.failureCode);
      data.failureCode = normaliseFailureCode(data.failureCode);
    }
    if (!Number.isInteger(data.number) || data.number < 1) data.number = countedAttempts(state, due.id).length + 1;
  }
  if (kind === "observations") {
    requireRole(ctx, ["Admin", "Operations", "Finance"]);
    if (!input.reference) throw new Error("Observations require a canonical provider reference.");
    if (input.customerId) parent(state, input.customerId, "customers", "observation customer");
    if (isUpdate) throw new Error("Observation evidence is immutable; record a correction as new evidence.");
    if (data.paymentId !== undefined || data.resolutionKey !== undefined || input.status === "resolved") {
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
    if (data.reviewer !== undefined && data.reviewer !== existing?.data.reviewer) throw new Error("Policy reviewer metadata is server-owned.");
    const maxAttempts = data.maxAttempts ?? policyGuardrails.defaultMaxAttempts;
    const spacing = data.spacingHours ?? policyGuardrails.defaultSpacingHours;
    const firstNotice = data.firstNoticeHours ?? policyGuardrails.defaultFirstNoticeHours;
    const retryNotice = data.retryNoticeHours ?? policyGuardrails.defaultRetryNoticeHours;
    [maxAttempts, spacing, firstNotice, retryNotice].forEach((value) => {
      if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error("Policy numeric inputs must be finite integers.");
    });
    if (maxAttempts > policyGuardrails.maxAttemptsCeiling || maxAttempts < 1 || spacing < policyGuardrails.minSpacingHours || firstNotice < policyGuardrails.minFirstNoticeHours || retryNotice < policyGuardrails.minRetryNoticeHours || data.partialAllowed === true) {
      throw new Error(`Policy violates the immutable guardrails: at most ${policyGuardrails.maxAttemptsCeiling} attempts, ${policyGuardrails.minSpacingHours}-hour spacing and notice floors, no partial debits.`);
    }
    if (data.author !== ctx.actor) throw new Error("The policy author must be the acting demo persona.");
  }
  if (kind === "templates") {
    requireRole(ctx, ["Admin"]);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("Templates are created as drafts only.");
    if (data.reviewer !== undefined && data.reviewer !== existing?.data.reviewer) throw new Error("Template reviewer metadata is server-owned.");
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
    if (!Number.isFinite(holdout) || holdout < experimentRules.minimumHoldoutShare || holdout > experimentRules.maximumHoldoutShare || !Number.isInteger(data.minPerArm) || !data.seed) {
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
  if (kind === "cutovers") {
    requireRole(ctx, ["Admin"]);
    if (input.status === "ready" && existing?.status !== "ready") {
      const candidate = { ...(existing ?? { id: "", merchantId: "", kind, name: "", reference: "", amountKobo: 0, customerId: "", createdAt: "", updatedAt: "" }), status: "ready", data } as ValopayRecord;
      if (!cutoverComplete(candidate)) throw new Error("A cutover is ready only when the incumbent is disabled in writing, external attempts are imported, the dual-run day is complete, and an accountable user has confirmed (DEB-11 steps 1 to 6).");
    }
    if (input.status === "handed_back" && existing?.status !== "handed_back") throw new Error("Hand-back is recorded by the hand_back action.");
  }
  if (["evidence", "experiments"].includes(kind)) requireRole(ctx, ["Admin"]);
  if (["commercial", "costs", "settlement-batches"].includes(kind)) requireRole(ctx, ["Admin", "Finance"]);
  if (kind === "settlement-batches") {
    for (const key of ["grossKobo", "feeKobo", "netKobo"]) positiveInteger(data[key], key, true);
    if (data.grossKobo - data.feeKobo !== data.netKobo) throw new Error("Batch net must equal gross minus fees.");
    if (!isUpdate && input.status !== (defaultStatus["settlement-batches"] ?? "pending")) throw new Error("Batches start pending; reconciliation determines the outcome.");
  }
}

export function assertActionRole(ctx: Context, allowed: string[]): void {
  requireRole(ctx, allowed);
}
