import assert from "node:assert/strict";
import type { ConnectedActionResult } from "@workspace/valopay-schema";
import { assertConnectedReplayAllowed, bindConnectedReplayAuthority } from "../src/domain/connected-replay.js";
import { runCashAction } from "../src/domain/connected-cash-service.js";
import { runCreditAction } from "../src/domain/connected-credit-service.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import type { Context } from "../src/domain/types.js";

const now = "2026-09-26T10:00:00.000Z";
const operations: Context = { actor: "Sandbox Operations", role: "Operations", now };
const finance: Context = { actor: "Sandbox Finance", role: "Finance", now };
const reason = "Verify receipt access under current authority";
const response = (record: unknown) => structuredClone({ message: "Sample workspace updated.", record, mode: "synthetic", externalInstructionPerformed: false }) as ConnectedActionResult;
let checks = 0;
const denied = (fn: () => void, status: number) => {
  assert.throws(fn, (error: any) => error.status === status && /already completed/.test(error.message) && /not been run again/.test(error.message));
  checks++;
};
function fixture() {
  const state = seedMerchant("replay-authority-fixture");
  const customerId = recordsOf(state, "customers")[0]!.id;
  const grant = (purpose: string, sme = true) => makeRecord(state, "connected-consents", {
    name: `Synthetic ${purpose}`, status: "active", createdAt: now,
    data: { purpose, subjectId: sme ? "sme" : customerId, entityId: sme ? `${state.merchant.id}:sme` : state.merchant.id, version: 1, expiresAt: "2026-10-26T10:00:00.000Z" },
  });
  const cashGrants = Object.fromEntries(["merchant_account_read", "erp_draft", "payroll_prepare"].map((purpose) => [purpose, grant(purpose)]));
  const cash = (action: string, ctx = operations, recordId?: string, data: Record<string, unknown> = {}) => {
    const result = runCashAction(state, ctx, { action, recordId, data, reason });
    bindConnectedReplayAuthority(state, ctx, action, result);
    return result;
  };
  const erpExport = () => {
    cash("cash.initialize");
    const prepared = cash("cash.erp.prepare").record!;
    cash("cash.erp.review", finance, prepared.id);
    return response(cash("cash.erp.export", finance, prepared.id));
  };
  const payrollExport = () => {
    cash("cash.initialize");
    const prepared = cash("cash.payroll.prepare").record!;
    cash("cash.payroll.approve", finance, prepared.id);
    return response(cash("cash.payroll.export", finance, prepared.id));
  };
  const credit = () => response(runCreditAction(state, operations, { action: "credit.assess", data: { customerId, scenario: "ready" }, reason }));
  return { state, customerId, grant, cashGrants, cash, erpExport, payrollExport, credit };
}
{
  const f = fixture(), saved = f.erpExport(), before = structuredClone(f.state);
  assertConnectedReplayAllowed(f.state, finance, "cash.erp.export", saved);
  assert.deepEqual(f.state, before, "replay guard is read-only and never re-executes export");
  checks += 2;
  f.cashGrants.erp_draft!.status = "revoked";
  denied(() => assertConnectedReplayAllowed(f.state, finance, "cash.erp.export", saved), 403);
  f.grant("erp_draft");
  denied(() => assertConnectedReplayAllowed(f.state, finance, "cash.erp.export", saved), 409);
}
for (const change of ["mapping", "closed_period", "recorded_receipt"] as const) {
  const f = fixture(), saved = f.erpExport();
  const input = f.state.records.find((record) => record.kind === "connected-cash-workspace")!.data.workspace.erpInput;
  if (change === "mapping") input.mapping.version = "changed-mapping";
  else if (change === "closed_period") input.closedThrough = input.postingDate;
  else input.alreadyRecordedReceiptIds = [input.canonicalReceiptId];
  denied(() => assertConnectedReplayAllowed(f.state, finance, "cash.erp.export", saved), 409);
}
{
  const f = fixture(), saved = f.payrollExport();
  assertConnectedReplayAllowed(f.state, finance, "cash.payroll.export", saved);
  checks++;
  denied(() => assertConnectedReplayAllowed(f.state, { ...finance, now: "2026-09-26T12:00:00.000Z" }, "cash.payroll.export", saved), 409);
  const record = (saved.record as any).record;
  f.cash("cash.payroll.reconcile", finance, record.id, { itemId: "payroll-one", status: "unknown" });
  denied(() => assertConnectedReplayAllowed(f.state, finance, "cash.payroll.export", saved), 409);
}
{
  const f = fixture(), saved = f.payrollExport();
  f.cashGrants.payroll_prepare!.data.version = 2;
  denied(() => assertConnectedReplayAllowed(f.state, finance, "cash.payroll.export", saved), 409);
  denied(() => assertConnectedReplayAllowed(f.state, operations, "cash.payroll.export", saved), 403);
}
{
  const f = fixture();
  f.grant("account_read", false);
  const creditGrant = f.grant("credit_assessment", false);
  const saved = f.credit();
  assert.ok((saved.record as any).data.result.score);
  assertConnectedReplayAllowed(f.state, operations, "credit.assess", saved);
  checks += 2;
  creditGrant.status = "revoked";
  denied(() => assertConnectedReplayAllowed(f.state, operations, "credit.assess", saved), 403);
  f.grant("credit_assessment", false);
  denied(() => assertConnectedReplayAllowed(f.state, operations, "credit.assess", saved), 403);
}
{
  const f = fixture(), saved = f.credit();
  const result = (saved.record as any).data.result;
  assert.deepEqual([result.state, result.score, result.features, result.affordability], ["blocked", null, null, null]);
  assertConnectedReplayAllowed(f.state, operations, "credit.assess", saved);
  checks += 2;
  denied(() => assertConnectedReplayAllowed(f.state, { ...operations, role: "Read-only" }, "credit.assess", saved), 403);
}
for (const action of ["cash.initialize", "cash.forecast", "cash.vat.export"]) {
  const f = fixture();
  if (action !== "cash.initialize") f.cash("cash.initialize");
  const ctx = action === "cash.vat.export" ? finance : operations;
  const saved = response(f.cash(action, ctx));
  assertConnectedReplayAllowed(f.state, ctx, action, saved);
  checks++;
  const original = (saved.record as any).record;
  const legacy = structuredClone(saved), legacyState = structuredClone(f.state);
  delete (legacy.record as any).record.data.replayAuthority;
  delete legacyState.records.find((r) => r.id === original.id)!.data.replayAuthority;
  denied(() => assertConnectedReplayAllowed(legacyState, ctx, action, legacy), 409);
  f.cashGrants.merchant_account_read!.status = "revoked";
  denied(() => assertConnectedReplayAllowed(f.state, ctx, action, saved), 403);
  f.grant("merchant_account_read");
  denied(() => assertConnectedReplayAllowed(f.state, ctx, action, saved), 409);
}
console.log(`Connected receipt replay: ${checks} checks passed for current authority, frozen output, stale files, role changes and safely redacted blocked assessments.`);
