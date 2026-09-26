import { isDeepStrictEqual } from "node:util";
import type { ConnectedActionResult } from "@workspace/valopay-schema";
import { cashView } from "./connected-cash-service";
import { cashEvidenceHash } from "./connected-cash";
import { creditView } from "./connected-credit-service";
import type { Context, DomainState, ValopayRecord } from "./types";

function refuse(status: 403 | 409, detail: string): never {
  throw Object.assign(new Error(`This request already completed, but its saved response is no longer available under the current permissions or review. ${detail} The action has not been run again.`), { status });
}
const sameRecord = (state: DomainState, saved: ValopayRecord): ValopayRecord => {
  const current = state.records.find((record) => record.id === saved.id && record.kind === saved.kind && record.merchantId === state.merchant.id);
  if (!current || !isDeepStrictEqual(current, saved)) return refuse(409, "Open the current record to see what changed.");
  return current;
};

const receiptPurposes = (kind: string): string[] | undefined =>
  kind === "connected-cash-vat" ? ["merchant_account_read", "erp_draft"] :
  ["connected-cash-workspace", "connected-cash-forecasts"].includes(kind) ? ["merchant_account_read"] : undefined;
function currentReceiptAuthority(state: DomainState, ctx: Context, purposes: string[]) {
  const at = Date.parse(ctx.now);
  if (!Number.isFinite(at)) return undefined;
  const snapshots = [];
  for (const purpose of purposes) {
    const grants = state.records.filter((r) => r.kind === "connected-consents" && r.merchantId === state.merchant.id &&
      r.status === "active" && r.data.purpose === purpose && r.data.subjectId === "sme" &&
      r.data.entityId === `${state.merchant.id}:sme` && Number.isSafeInteger(r.data.version) && r.data.version > 0 &&
      Date.parse(String(r.data.validFrom ?? r.createdAt)) <= at && Date.parse(String(r.data.expiresAt)) > at);
    if (grants.length !== 1) return undefined;
    const grant = grants[0]!;
    snapshots.push({ purpose, id: grant.id, version: grant.data.version,
      hash: cashEvidenceHash({ merchantId: grant.merchantId, createdAt: grant.createdAt, data: grant.data }) });
  }
  return snapshots;
}
/** Record the authority at creation, not at first replay. ERP and payroll
 * already retain their preparation/checker snapshots in their domain service. */
export function bindConnectedReplayAuthority(state: DomainState, ctx: Context, action: string, result: unknown): void {
  if (!action.startsWith("cash.")) return;
  const record = (result as { record?: ValopayRecord }).record;
  const purposes = record && receiptPurposes(record.kind);
  if (!record || !purposes) return;
  const authority = currentReceiptAuthority(state, ctx, purposes);
  if (!authority) throw Object.assign(new Error("Current scoped permission is required before saving this response."), { status: 403 });
  record.data.replayAuthority = authority;
}

/** An idempotency receipt proves an earlier outcome; it does not grant future
 * access to a score or reusable bank/ERP file. Check a locked current snapshot
 * without executing the command, changing its receipt, or replacing its outcome.
 * Ordinary consent/payment receipts remain historical status evidence. */
export function assertConnectedReplayAllowed(state: DomainState, ctx: Context, action: string, saved: ConnectedActionResult): void {
  if (!action.startsWith("credit.") && !action.startsWith("cash.")) return;
  if (state.settings.environment !== "sandbox" || !ctx.actor.startsWith("Sandbox ")) refuse(403, "This response is restricted to synthetic sandbox access.");
  if (action.startsWith("credit.")) {
    const record = sameRecord(state, saved.record as ValopayRecord);
    const view = creditView(state, ctx);
    if (action === "credit.review" ? !view.canReview : !view.canAssess) refuse(403, "Your current role cannot access this action's response.");
    const assessmentId = action === "credit.review" ? record.data.assessmentRecordId : record.id;
    const assessment = view.assessments.find((item) => item.id === assessmentId);
    if (!assessment) refuse(409, "The assessment is unavailable.");
    // An assessment already blocked at creation may legitimately have no
    // grants. It is safe to replay only its original unscored, redacted result.
    const original = action === "credit.assess" ? record.data.result : undefined;
    const originallyRedacted = original?.state === "blocked" && original.features === null && original.score === null && original.affordability === null;
    if (assessment.permissionRestricted && !originallyRedacted) refuse(403, "Permission was revoked, expired or replaced. Obtain current authority and prepare a new assessment.");
    return;
  }

  const financeOnly = ["cash.erp.review", "cash.erp.export", "cash.vat.export", "cash.payroll.approve", "cash.payroll.export", "cash.payroll.reconcile"].includes(action);
  const roles = financeOnly ? ["Finance"] : action === "cash.forecast" ? ["Admin", "Operations", "Finance"] : ["Admin", "Operations"];
  if (!roles.includes(ctx.role)) refuse(403, "Your current role cannot access this action's response.");
  const view = cashView(state, ctx);
  const needsErp = action.startsWith("cash.erp.") || action === "cash.vat.export";
  const needsPayroll = action.startsWith("cash.payroll.");
  // Finance can still reconcile retained outcomes after revocation. A full
  // historical receipt includes more than that minimal status view, so refuse
  // replay and direct the caller to the current desk rather than disclose it.
  if (!view.permissions.read || (needsErp && !view.permissions.erp) || (needsPayroll && !view.permissions.payroll)) refuse(403, "Open the current desk for permitted records and retained outcome status.");
  const outcome = saved.record as { record?: ValopayRecord; data: Record<string, unknown> };
  if (!outcome.record) return; // cash.initialize can already be initialised.
  const record = sameRecord(state, outcome.record);
  const purposes = receiptPurposes(record.kind);
  if (purposes) {
    const authority = currentReceiptAuthority(state, ctx, purposes);
    if (!Array.isArray(record.data.replayAuthority) || !authority || !isDeepStrictEqual(record.data.replayAuthority, authority))
      refuse(409, "The original permission changed or cannot be established. Prepare a current view or export.");
  }
  if (record.kind === "connected-cash-erp") {
    const current = view.erpDrafts.find((draft) => draft.id === record.id);
    if (!current || current.status === "review_required") refuse(409, "The ERP permission or approval changed. Refresh its review.");
    if (action === "cash.erp.export" && (!current.manifest || !isDeepStrictEqual(current.manifest, outcome.data.manifest))) refuse(409, "The ERP mapping, accounting period, receipt or reviewed file changed. Prepare a current export.");
  }
  if (record.kind === "connected-cash-payroll") {
    const current = view.payrollPlans.find((plan) => plan.id === record.id);
    if (!current || current.status === "review_required") refuse(409, "The payroll permission or approval changed. Refresh its review.");
    if (action === "cash.payroll.export" && (!current.manifest || !isDeepStrictEqual(current.manifest, outcome.data.manifest))) refuse(409, "The payroll funding, item outcomes or approved file changed. Review the current plan.");
  }
}
