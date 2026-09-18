import {
  ABSOLUTE_TICKET_FLOOR_KOBO, PLATFORM_OWNER, activationWorkflows, defaultStatus, describeIssues,
  editableKinds, exceptionCatalogue, exceptionTransitions, experimentRules, isActionOnlyStatus, mandateTransitions, normaliseFailureCode,
  normaliseOwner, policyGuardrails, recordDataSchemas, recordStatuses, resolveExceptionType, roles, isKnownFailureCode,
} from "@workspace/valopay-schema";
import { assertNoRealBankDetails, findRecord, masked, recordsOf } from "./records";
import type { Context, DomainState, RecordOf, TypedRecord, ValopayRecord } from "./types";
import { addBusinessDays } from "./calendar";
import { countedAttempts, minimumTicketKobo, policySummary } from "./policy-engine";

const roleSet = new Set<string>(roles);
const editable = new Set<string>(editableKinds);
const statuses: Record<string, readonly string[]> = recordStatuses;

function requireRole(ctx: Context, allowed: string[]): void {
  if (!roleSet.has(ctx.role)) throw new Error("This demo role is not recognised. Choose one of the available roles.");
  if (!allowed.includes(ctx.role)) throw new Error(`${ctx.role} is not permitted to make this change.`);
}

function positiveInteger(value: unknown, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a whole number in kobo (100 kobo = ₦1).`);
  }
}

function isoDate(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must use YYYY-MM-DD or a UTC timestamp such as 2026-09-18T07:00:00Z.`);
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

function parent<K extends string>(state: DomainState, id: unknown, kind: K, label: string): RecordOf<K> {
  if (typeof id !== "string" || !id) throw new Error(`${label} is required.`);
  const item = findRecord(state, id, kind);
  if (item.merchantId !== state.merchant.id) throw new Error(`${label} belongs to another lender workspace. Choose a record from this workspace.`);
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
export function cutoverComplete(cutover: TypedRecord<"cutovers">): boolean {
  const data = cutover.data;
  return cutover.status === "ready" && data.incumbentDisabled === true && data.externalAttemptsImported === true && data.dualRunComplete === true && Boolean(data.accountableUser) && Boolean(data.confirmation);
}

function assertTransition(kind: string, from: string, to: string): void {
  if (from === to) return;
  if (kind === "cutovers" && to === "handed_back") throw new Error("Use Return collection ownership to hand this back to the configured fallback owner.");
  if (kind === "mandates") {
    const allowed = mandateTransitions[from as keyof typeof mandateTransitions] ?? [];
    if (!allowed.includes(to as never)) throw new Error(`A ${from} mandate cannot move to ${to}.`);
    if (to === "cancelled" || to === "suspended") throw new Error("Cancel or suspend a mandate through its action so the reason is recorded.");
    return;
  }
  if (kind === "exceptions") {
    const allowed = exceptionTransitions[from as keyof typeof exceptionTransitions] ?? [];
    if (!allowed.includes(to as never)) throw new Error(to === "resolved" ? "Use Resolve exception and choose a resolution from the list." : `A ${from} exception cannot move to ${to}.`);
    return;
  }
  if (["policies", "templates", "experiments"].includes(kind)) {
    throw new Error("Use the action for this record to change its status.");
  }
  if (["due-items", "attempts", "observations", "settlement-batches", "payments", "allocations"].includes(kind)) {
    throw new Error(`${kind} status is derived by the platform and cannot be set directly.`);
  }
  if (isActionOnlyStatus(kind, to)) throw new Error("Use the action for this record to set this status.");
}

export function validateRecord(
  state: DomainState,
  ctx: Context,
  kind: string,
  input: Partial<ValopayRecord> & { data?: Record<string, any> },
  isUpdate = false,
): void {
  // A data field named like an object's own machinery is refused before anything else looks at the
  // object: JSON can carry such a key, and code that copies fields would otherwise inherit from it.
  for (const key of Object.keys(input.data ?? {})) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error(`data.${key} is not an allowed field.`);
  }
  assertNoRealBankDetails(input);
  validateDates(input);
  if (!editable.has(kind)) throw new Error(`${kind} cannot be created or edited directly.`);
  if (!roleSet.has(ctx.role) || ctx.role === "Read-only") throw new Error("This demo role has read-only access.");
  if (input.merchantId && input.merchantId !== state.merchant.id) throw new Error("Linked records must belong to the same lender workspace.");
  if (input.amountKobo !== undefined) positiveInteger(input.amountKobo, "amountKobo", true);
  if (input.status && statuses[kind] && !statuses[kind].includes(input.status)) {
    throw new Error(`Invalid ${kind} status. Allowed: ${statuses[kind].join(", ")}.`);
  }
  const data: Record<string, any> = input.data || (input.data = {});
  const existing = isUpdate && input.id ? findRecord(state, input.id, kind) : undefined;
  if (isUpdate && !existing) throw new Error("An update requires the existing record id.");
  if (existing?.status === "approved" && (kind === "policies" || kind === "templates")) {
    throw new Error("Approved versions cannot be edited. Create a new draft version instead.");
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
    if (data.accountMasked !== undefined && !masked(data.accountMasked)) throw new Error("Mask the account number, for example •••• 1234. Do not enter a full account number.");
    if (data.phoneMasked !== undefined && !masked(data.phoneMasked)) throw new Error("Mask the phone number, for example +234 •••• 32. Do not enter a full phone number.");
  }
  if (kind === "mandates") {
    requireRole(ctx, ["Admin", "Operations"]);
    parent(state, input.customerId, "customers", "A mandate customer");
    positiveInteger(input.amountKobo, "Mandate limit");
    if (!activationWorkflows.includes(data.workflow)) throw new Error("Select a supported activation workflow.");
    const consentKeys = ["consentPolicyId", "consentPolicyVersion", "consentPolicySummary", "policyVersionHistory"] as const;
    if (data.policyId) {
      const policy = parent(state, data.policyId, "policies", "mandate policyId");
      // RET-07 and MAN-02: the consent record carries the policy version and its text as it stood.  A mandate that
      // predates pinning is pinned to the version it has been running under on its next write; callers never set these.
      if (!existing?.data.consentPolicyId) {
        data.consentPolicyId = policy.id;
        data.consentPolicyVersion = Number(policy.data.version || 1);
        data.consentPolicySummary = policySummary(policy);
      }
    } else if (!existing) {
      for (const key of consentKeys) delete data[key];
    }
    if (!existing?.data.policyVersionHistory && !existing?.data.consentPolicyId) delete data.policyVersionHistory;
    if (data.origin === "imported" && !data.consentGaps) throw new Error("For an imported mandate, record any missing consent evidence. Use an empty list if nothing is missing.");
    if (existing && ["consentEvidence", "workflow", "origin"].some((key) => JSON.stringify(data[key]) !== JSON.stringify(existing.data[key]))) {
      throw new Error("Existing consent evidence cannot be changed. Reissue the mandate with a new consent record.");
    }
    if (existing?.data.policyId && data.policyId !== existing.data.policyId) throw new Error("Use Apply policy version to change the version for this mandate and record the required notice and consent.");
    if (existing && consentKeys.some((key) => existing.data[key] !== undefined && JSON.stringify(data[key]) !== JSON.stringify(existing.data[key]))) {
      throw new Error("Use Apply policy version to update the version covered by consent.");
    }
  }
  if (kind === "due-items") {
    requireRole(ctx, ["Admin", "Operations", "Finance"]);
    parent(state, input.customerId, "customers", "A due item customer");
    positiveInteger(input.amountKobo, "Due amount");
    const amount = Number(input.amountKobo);
    if (amount < ABSOLUTE_TICKET_FLOOR_KOBO) throw new Error("The minimum debit is ₦5,000. Amounts below this cannot be approved.");
    const minimum = minimumTicketKobo(state);
    if (amount < minimum) {
      const override = data.overrideReason || data.adminOverrideReason;
      const preserved = existing && existing.amountKobo === input.amountKobo && (existing.data.overrideReason || existing.data.adminOverrideReason) === override;
      if (!override || (!preserved && ctx.role !== "Admin")) throw new Error(`Debits from ₦5,000 to below the lender minimum of ₦${(minimum / 100).toLocaleString("en-NG")} need an Admin to record an override reason.`);
    }
    if (!isUpdate && input.status !== "scheduled") throw new Error("New instalments must start as scheduled. Their payment status updates when payments are allocated.");
    if (!normaliseOwner(data.owner)) throw new Error("Choose who is responsible for collecting this instalment: Valo Pay, the loan management system, the lender team or the provider.");
    if (data.mandateId) {
      const mandate = parent(state, data.mandateId, "mandates", "dueItem mandateId");
      if (mandate.customerId !== input.customerId) throw new Error("Choose a mandate that belongs to the customer on this instalment.");
    }
    if (data.owner === PLATFORM_OWNER && !recordsOf(state, "cutovers").some(cutoverComplete)) {
      throw new Error("Valo Pay cannot take collection ownership until the handover agreement and parallel-run day are complete, with a named responsible user and written confirmation.");
    }
    if (data.outstandingKobo !== undefined && (!Number.isInteger(data.outstandingKobo) || data.outstandingKobo < 0 || data.outstandingKobo > input.amountKobo!)) {
      throw new Error("Outstanding balance cannot exceed the due amount.");
    }
  }
  if (kind === "attempts") {
    requireRole(ctx, ["Admin", "Operations"]);
    if (isUpdate) throw new Error("Recorded debit attempts cannot be edited.");
    const due = parent(state, data.dueItemId, "due-items", "attempt dueItemId");
    if (due.customerId !== input.customerId) throw new Error("The debit attempt and instalment must belong to the same customer.");
    if (input.amountKobo !== due.amountKobo) throw new Error("The debit attempt amount must match the instalment amount.");
    if (data.source !== "external" || data.simulated !== true) {
      throw new Error("Only sample records of external debit attempts can be imported. They cannot be edited later, and no debit instruction is available.");
    }
    if (input.status === "failed") {
      if (data.failureCode !== undefined && !isKnownFailureCode(data.failureCode)) data.rawFailureCode = String(data.failureCode);
      data.failureCode = normaliseFailureCode(data.failureCode);
    }
    if (!Number.isInteger(data.number) || data.number < 1) data.number = countedAttempts(state, due.id).length + 1;
  }
  if (kind === "observations") {
    requireRole(ctx, ["Admin", "Operations", "Finance"]);
    if (!input.reference) throw new Error("Enter the original provider reference for this payment evidence.");
    if (input.customerId) parent(state, input.customerId, "customers", "observation customer");
    if (isUpdate) throw new Error("Saved payment evidence cannot be edited. Add a new record to correct it.");
    if (data.paymentId !== undefined || data.resolutionKey !== undefined || input.status === "resolved") {
      throw new Error("Valo Pay determines how payment evidence is matched. Do not set its resolution when creating it.");
    }
    if (data.dueItemId) {
      const due = parent(state, data.dueItemId, "due-items", "observation dueItemId");
      if (due.customerId !== input.customerId) throw new Error("The payment evidence and linked instalment must belong to the same customer.");
    }
  }
  if (kind === "policies") {
    requireRole(ctx, ["Admin"]);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("Policies are created as drafts only.");
    if (data.reviewer !== undefined && data.reviewer !== existing?.data.reviewer) throw new Error("The policy reviewer is recorded during approval and cannot be changed here.");
    const maxAttempts = data.maxAttempts ?? policyGuardrails.defaultMaxAttempts;
    const spacing = data.spacingHours ?? policyGuardrails.defaultSpacingHours;
    const firstNotice = data.firstNoticeHours ?? policyGuardrails.defaultFirstNoticeHours;
    const retryNotice = data.retryNoticeHours ?? policyGuardrails.defaultRetryNoticeHours;
    [maxAttempts, spacing, firstNotice, retryNotice].forEach((value) => {
      if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error("Enter whole numbers for the policy limits and timings.");
    });
    if (maxAttempts > policyGuardrails.maxAttemptsCeiling || maxAttempts < 1 || spacing < policyGuardrails.minSpacingHours || firstNotice < policyGuardrails.minFirstNoticeHours || retryNotice < policyGuardrails.minRetryNoticeHours || data.partialAllowed === true) {
      throw new Error(`Use no more than ${policyGuardrails.maxAttemptsCeiling} attempts, at least ${policyGuardrails.minSpacingHours} hours between attempts and for each notice period, and no partial debits. These limits cannot be overridden.`);
    }
    if (data.author !== ctx.actor) throw new Error("The policy author must match the current demo user.");
  }
  if (kind === "templates") {
    requireRole(ctx, ["Admin"]);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("Templates are created as drafts only.");
    if (data.reviewer !== undefined && data.reviewer !== existing?.data.reviewer) throw new Error("The template reviewer is recorded during approval and cannot be changed here.");
    if (data.author !== ctx.actor) throw new Error("The template author must match the current demo user.");
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
      throw new Error("Set the comparison group to 10–50%, enter a whole-number minimum sample for each group, and provide an assignment seed.");
    }
    parent(state, data.policyId, "policies", "experiment policyId");
  }
  if (kind === "exceptions" && data.linkedRecordId) {
    const linked = state.records.find((item) => item.id === data.linkedRecordId);
    if (!linked || linked.merchantId !== state.merchant.id) throw new Error("Link the exception to a record in this lender workspace.");
  }
  if (kind === "commercial" && data.designPartner && !data.signedFullPriceTerms) {
    // A discounted design-partner entry is allowed, but it cannot be treated as proof of a real Test 3 sale.
    data.realTest3Qualified = false;
  }
  if (kind === "cutovers") {
    requireRole(ctx, ["Admin"]);
    if (input.status === "ready" && existing?.status !== "ready") {
      const candidate = { ...(existing ?? { id: "", merchantId: "", kind, name: "", reference: "", amountKobo: 0, customerId: "", createdAt: "", updatedAt: "" }), status: "ready", data } as TypedRecord<"cutovers">;
      if (!cutoverComplete(candidate)) throw new Error("The handover is ready only after the previous collection system is disabled in writing, external attempts are imported, the parallel-run day is complete, and a named responsible user has confirmed.");
    }
    if (input.status === "handed_back" && existing?.status !== "handed_back") throw new Error("Use Return collection ownership to hand this back to the configured fallback owner.");
  }
  if (["evidence", "experiments"].includes(kind)) requireRole(ctx, ["Admin"]);
  if (["commercial", "costs", "settlement-batches"].includes(kind)) requireRole(ctx, ["Admin", "Finance"]);
  if (kind === "settlement-batches") {
    for (const key of ["grossKobo", "feeKobo", "netKobo"]) positiveInteger(data[key], key, true);
    if (data.grossKobo - data.feeKobo !== data.netKobo) throw new Error("The net settlement amount must equal the gross amount minus fees.");
    if (!isUpdate && input.status !== (defaultStatus["settlement-batches"] ?? "pending")) throw new Error("New settlement batches must start as pending. Reconciliation updates their status.");
  }
}

export function assertActionRole(ctx: Context, allowed: string[]): void {
  requireRole(ctx, allowed);
}
