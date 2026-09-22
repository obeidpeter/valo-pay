import { makeRecord, touch } from "./records";
import type {
  ActionResult,
  Context,
  DomainState,
  ValopayRecord,
} from "./types";
import {
  approvePayrollPlan,
  buildErpDraft,
  cashEvidenceHash,
  consolidateCashPositions,
  exportPayrollManifest,
  forecastCash,
  guardErpDispatch,
  payrollPlanSummary,
  preparePayrollFundingPlan,
  refreshPayrollFundingPlan,
  reconcileVatEvidence,
  reviewErpDraft,
  transitionPayrollItem,
  type CashAccount,
  type CashCommitment,
  type CashObservation,
  type CurrencyScope,
  type ErpDraft,
  type ErpDraftInput,
  type PayrollPlan,
  type PayrollRun,
  type VatBankAllocation,
  type VatControlInput,
  type VatInvoiceEvidence,
} from "./connected-cash";

const DAY = 86_400_000;
const entityScope = (state: DomainState): CurrencyScope => ({
  tenantId: state.merchant.id,
  legalEntityId: `${state.merchant.id}:sme`,
  currency: "NGN",
});
type Purpose = "merchant_account_read" | "erp_draft" | "payroll_prepare";
function permission(
  state: DomainState,
  purpose: Purpose,
  now: string,
): boolean {
  return state.records.some(
    (r) =>
      r.merchantId === state.merchant.id &&
      r.kind === "connected-consents" &&
      r.status === "active" &&
      r.data.purpose === purpose &&
      r.data.subjectId === "sme" &&
      r.data.entityId === entityScope(state).legalEntityId &&
      Date.parse(String(r.data.expiresAt)) > Date.parse(now),
  );
}
/** A refusal the HTTP layer answers with its own status; a plain error would read as a 400. */
const refusal = (message: string, status: number): Error =>
  Object.assign(new Error(message), { status });
function requirePermission(
  state: DomainState,
  purpose: Purpose,
  now: string,
): void {
  if (!permission(state, purpose, now))
    throw refusal(
      `Enable the SME ${purpose.replaceAll("_", " ")} permission in Connected Banking before continuing.`,
      403,
    );
}
function ownRecords(state: DomainState, kind: string): ValopayRecord[] {
  return state.records.filter(
    (r) =>
      r.merchantId === state.merchant.id &&
      r.kind === kind &&
      r.data.entityId === entityScope(state).legalEntityId,
  );
}
function ownRecord(
  state: DomainState,
  kind: string,
  id?: string,
): ValopayRecord {
  const record = ownRecords(state, kind).find((r) => r.id === id);
  if (!record) throw refusal("This SME record was not found.", 404);
  return record;
}
function requireRole(ctx: Context, roles: string[]): void {
  if (!roles.includes(ctx.role))
    throw refusal(`This action requires ${roles.join(" or ")} access.`, 403);
}
function minor(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Enter a whole, non-negative amount in kobo.");
  return value;
}
function stored(state: DomainState) {
  return ownRecords(state, "connected-cash-workspace")[0];
}
function sample(state: DomainState, now: string) {
  const scope = entityScope(state);
  const future = (days: number) =>
    new Date(Date.parse(now) + days * DAY).toISOString();
  const accounts: CashAccount[] = [
    {
      ...scope,
      id: "sample-operating",
      name: "Operating account · •• 1024",
      source: "Sample bank statement",
      sourceDefinition: "Bank-reported booked and available balance",
      authorised: true,
      bookedMinor: 1_850_000_000,
      availableMinor: 1_790_000_000,
      pendingMinor: -60_000_000,
      balanceAsOf: now,
      fetchedAt: now,
      coverageComplete: true,
    },
    {
      ...scope,
      id: "sample-reserve",
      name: "Reserve account · •• 2086",
      source: "Sample bank statement",
      sourceDefinition: "Bank-reported booked and available balance",
      authorised: true,
      bookedMinor: 630_000_000,
      availableMinor: 630_000_000,
      pendingMinor: 0,
      balanceAsOf: now,
      fetchedAt: now,
      coverageComplete: true,
    },
  ];
  const commitments: CashCommitment[] = [
    {
      ...scope,
      id: "sample-invoice",
      label: "Customer invoice receipts",
      direction: "inflow",
      amountMinor: 840_000_000,
      dueAt: future(5),
      knownAt: now,
      approved: true,
      source: "invoice",
      version: "1",
    },
    {
      ...scope,
      id: "sample-supplier",
      label: "Approved supplier bills",
      direction: "outflow",
      amountMinor: 660_000_000,
      dueAt: future(6),
      knownAt: now,
      approved: true,
      source: "bill",
      version: "1",
    },
    {
      ...scope,
      id: "sample-payroll",
      label: "Approved net-pay run",
      direction: "outflow",
      amountMinor: 360_000_000,
      dueAt: future(7),
      knownAt: now,
      approved: true,
      source: "payroll",
      version: "1",
    },
    {
      ...scope,
      id: "sample-month-end",
      label: "Month-end invoice receipts",
      direction: "inflow",
      amountMinor: 1_040_000_000,
      dueAt: future(24),
      knownAt: now,
      approved: true,
      source: "invoice",
      version: "1",
    },
    {
      ...scope,
      id: "sample-rent",
      label: "Rent and utilities assumption",
      direction: "outflow",
      amountMinor: 290_000_000,
      dueAt: future(21),
      knownAt: now,
      approved: true,
      source: "recurring_assumption",
      version: "1",
    },
  ];
  const observations: CashObservation[] = [
    {
      ...scope,
      id: "sample-transfer-out",
      sourceReference: "sample-transfer-out",
      accountId: accounts[0]!.id,
      amountMinor: -200_000_000,
      status: "booked",
      occurredAt: now,
      observedAt: now,
      internalTransferId: "sample-own-transfer",
    },
    {
      ...scope,
      id: "sample-transfer-in",
      sourceReference: "sample-transfer-in",
      accountId: accounts[1]!.id,
      amountMinor: 200_000_000,
      status: "booked",
      occurredAt: now,
      observedAt: now,
      internalTransferId: "sample-own-transfer",
    },
  ];
  const erpInput: ErpDraftInput = {
    scope,
    maker: "not yet prepared",
    postingDate: now,
    canonicalReceiptId: "sample-erp-receipt",
    bankReference: "SAMPLE-BANK-RECEIPT",
    grossMinor: 1_075_000,
    feeMinor: 5_000,
    netMinor: 1_070_000,
    mapping: {
      ...scope,
      companyId: "sample-xero-company",
      provider: "xero",
      version: "finance-mapping-v1",
      active: true,
      contactId: "sample-contact",
      bankLedgerCode: "090",
      revenueAccountCode: "200",
      feeAccountCode: "404",
      taxCode: "SAMPLE-APPROVED-VAT",
      financeApproved: true,
    },
    invoices: [
      {
        ...scope,
        id: "INV-SAMPLE-204",
        companyId: "sample-xero-company",
        contactId: "sample-contact",
        version: "1",
        outstandingMinor: 1_500_000,
        taxCode: "SAMPLE-APPROVED-VAT",
      },
    ],
    allocations: [
      {
        invoiceId: "INV-SAMPLE-204",
        invoiceVersion: "1",
        amountMinor: 1_075_000,
      },
    ],
    creditNotes: [
      {
        id: "CN-SAMPLE-12",
        invoiceId: "INV-SAMPLE-204",
        amountMinor: 100_000,
        approved: true,
        version: "1",
      },
    ],
    source: "synthetic",
  };
  const period = now.slice(0, 7);
  const vatInvoices: VatInvoiceEvidence[] = [
    {
      ...scope,
      id: "SAMPLE-SALES-01",
      kind: "sales_invoice",
      netMinor: 10_000_000,
      vatMinor: 750_000,
      taxCode: "SAMPLE-STANDARD",
      invoiceDate: now,
      taxPeriod: period,
      approvedTaxBasis: true,
      evidenceValidated: true,
      inputRecoveryApproved: false,
      eInvoiceRequired: false,
    },
    {
      ...scope,
      id: "SAMPLE-PURCHASE-01",
      kind: "purchase_invoice",
      netMinor: 4_000_000,
      vatMinor: 300_000,
      taxCode: "SAMPLE-STANDARD",
      invoiceDate: now,
      taxPeriod: period,
      approvedTaxBasis: true,
      evidenceValidated: true,
      inputRecoveryApproved: false,
      eInvoiceRequired: false,
    },
  ];
  const vatAllocations: VatBankAllocation[] = [
    {
      ...scope,
      id: "sample-sales-payment",
      invoiceId: "SAMPLE-SALES-01",
      amountMinor: 5_000_000,
      category: "invoice_payment",
      evidenceReference: "SAMPLE-BANK-01",
    },
    {
      ...scope,
      id: "sample-loan-proceeds",
      amountMinor: 25_000_000,
      category: "loan_proceeds",
      evidenceReference: "SAMPLE-LOAN-01",
    },
  ];
  const vatControl: VatControlInput = {
    period,
    configurationVersion: "sample-tax-treatment-v1",
    openingPayableMinor: 0,
    approvedAdjustmentMinor: 0,
    ledgerClosingPayableMinor: 750_000,
    remittancesMinor: 0,
    authorisedRemittanceEvidence: false,
  };
  const payrollRun: PayrollRun = {
    ...scope,
    id: "SAMPLE-NET-PAY",
    version: "1",
    approved: true,
    sourceApprover: "Sample payroll owner",
    sourceHash: cashEvidenceHash("Synthetic approved net-pay run v1"),
    approvedTotalMinor: 360_000_000,
    items: [
      {
        id: "payroll-one",
        employeeReference: "SAMPLE-EMP-01",
        beneficiaryReference: "Sample employee · •• 2041",
        beneficiaryVersion: "1",
        netMinor: 140_000_000,
      },
      {
        id: "payroll-two",
        employeeReference: "SAMPLE-EMP-02",
        beneficiaryReference: "Sample employee · •• 3052",
        beneficiaryVersion: "1",
        netMinor: 120_000_000,
      },
      {
        id: "payroll-three",
        employeeReference: "SAMPLE-EMP-03",
        beneficiaryReference: "Sample employee · •• 4063",
        beneficiaryVersion: "1",
        netMinor: 100_000_000,
      },
    ],
  };
  return {
    scope,
    accounts,
    commitments,
    observations,
    erpInput,
    vatInvoices,
    vatAllocations,
    vatControl,
    payrollRun,
    createdAt: now,
  };
}
type CashWorkspace = ReturnType<typeof sample>;
function workspace(state: DomainState, ctx: Context): CashWorkspace {
  return (
    (stored(state)?.data.workspace as CashWorkspace | undefined) ??
    sample(state, ctx.now)
  );
}
export function cashView(state: DomainState, ctx: Context) {
  const data = workspace(state, ctx);
  const read = permission(state, "merchant_account_read", ctx.now);
  const accounts = data.accounts.map((a) => ({
    ...a,
    authorised: read || !stored(state),
  }));
  const positions = consolidateCashPositions(
    data.scope,
    accounts,
    data.observations,
    ctx.now,
  );
  const position = positions.find((p) => p.currency === "NGN");
  const savedForecast = ownRecords(state, "connected-cash-forecasts").at(-1);
  const forecast =
    !stored(state) || read
      ? (savedForecast?.data.forecast ??
        forecastCash(data.scope, position?.bookedMinor ?? 0, data.commitments, {
          asOf: ctx.now,
          version: "sample-preview",
          openingQualified: position?.qualified ?? false,
          bufferMinor: 150_000_000,
        }))
      : null;
  const erp = permission(state, "erp_draft", ctx.now);
  const payroll = permission(state, "payroll_prepare", ctx.now);
  const vat =
    !stored(state) || (read && erp)
      ? reconcileVatEvidence(
          data.scope,
          data.vatInvoices,
          data.vatAllocations,
          data.vatControl,
        )
      : null;
  return {
    initialised: !!stored(state),
    scope: data.scope,
    name: "Sample SME · Trading company",
    accounts: read || !stored(state) ? accounts : [],
    positions,
    commitments: read || !stored(state) ? data.commitments : [],
    forecast,
    erpDrafts:
      read && erp
        ? ownRecords(state, "connected-cash-erp").map((r) => ({
            id: r.id,
            status: r.status,
            name: r.name,
            createdAt: r.createdAt,
            draft: r.data.draft,
            manifest: r.data.manifest,
          }))
        : [],
    vat,
    vatExports:
      read && erp
        ? ownRecords(state, "connected-cash-vat").map((r) => ({
            id: r.id,
            createdAt: r.createdAt,
            schedule: r.data.schedule,
            reviewer: r.data.reviewer,
          }))
        : [],
    payrollPlans:
      read && payroll
        ? ownRecords(state, "connected-cash-payroll").map((r) => ({
            id: r.id,
            status: r.status,
            plan: r.data.plan as PayrollPlan,
            summary: payrollPlanSummary(r.data.plan as PayrollPlan),
            manifest: r.data.manifest,
          }))
        : [],
    payrollReconciliation:
      ctx.role === "Finance" && !(read && payroll)
        ? ownRecords(state, "connected-cash-payroll").flatMap((r) => {
            const plan = r.data.plan as PayrollPlan;
            const items = plan.items
              .filter((item) =>
                ["exported", "submitted", "unknown", "succeeded"].includes(
                  item.status,
                ),
              )
              .map(({ id, employeeReference, netMinor, status }) => ({
                id,
                employeeReference,
                netMinor,
                status,
              }));
            return items.length ? [{ id: r.id, runId: plan.runId, items }] : [];
          })
        : [],
    permissions: { read, erp, payroll },
    limitations: [
      "Sample SME data is separate from lender and borrower records.",
      "Bank connections, ERP posting, tax submission and payroll payments are not enabled.",
      "Forecasts and funding buffers do not reserve money.",
    ],
  };
}

export function runCashAction(
  state: DomainState,
  ctx: Context,
  input: {
    action: string;
    recordId?: string;
    reason: string;
    data: Record<string, unknown>;
  },
): ActionResult {
  if (state.settings.environment !== "sandbox")
    throw refusal(
      "Cash Desk actions currently support synthetic sandbox workspaces only.",
      403,
    );
  if (!input.reason?.trim())
    throw new Error(
      "Enter a reason for this action so the review trail is clear.",
    );
  const scope = entityScope(state);
  let record: ValopayRecord | undefined;
  let message = "";
  let resultData: Record<string, unknown> = {};
  const store = (
    kind: string,
    name: string,
    status: string,
    data: Record<string, unknown>,
  ) =>
    makeRecord(state, kind, {
      name,
      status,
      createdAt: ctx.now,
      data: {
        ...data,
        entityId: scope.legalEntityId,
        actor: ctx.actor,
        reason: input.reason,
      },
    });
  if (input.action === "cash.initialize") {
    requireRole(ctx, ["Admin", "Operations"]);
    requirePermission(state, "merchant_account_read", ctx.now);
    if (stored(state))
      return {
        message: "The sample Cash Desk is already ready.",
        data: { synthetic: true },
      };
    record = store(
      "connected-cash-workspace",
      "Sample SME Cash Desk",
      "active",
      { workspace: sample(state, ctx.now) },
    );
    message = "Sample SME accounts and approved planning inputs are ready.";
  } else {
    if (!stored(state)) throw new Error("Set up the sample Cash Desk first.");
    // Recording retained outcomes is not new account access or payroll preparation.
    // Finance may reconcile a previously approved/exported item after revocation;
    // its immutable item identity and permitted transition still apply below.
    if (input.action !== "cash.payroll.reconcile")
      requirePermission(state, "merchant_account_read", ctx.now);
    const data = workspace(state, ctx);
    if (input.action === "cash.refresh_sample") {
      requireRole(ctx, ["Admin", "Operations"]);
      record = stored(state)!;
      const refreshed = structuredClone(data);
      refreshed.accounts = refreshed.accounts.map((a) => ({
        ...a,
        balanceAsOf: ctx.now,
        fetchedAt: ctx.now,
      }));
      record.data.workspace = refreshed;
      touch(record, ctx.now);
      message =
        "Sample balance timestamps refreshed. This did not contact a bank.";
    } else if (input.action === "cash.forecast") {
      requireRole(ctx, ["Admin", "Operations", "Finance"]);
      const positions = consolidateCashPositions(
        scope,
        data.accounts,
        data.observations,
        ctx.now,
      );
      const position = positions[0]!;
      const value = forecastCash(
        scope,
        position.bookedMinor,
        data.commitments,
        {
          asOf: ctx.now,
          openingQualified: position.qualified,
          version: `sample-${ownRecords(state, "connected-cash-forecasts").length + 1}`,
          bufferMinor: minor(input.data.bufferMinor, 150_000_000),
          downsideInflowBps: minor(input.data.downsideInflowBps, 7000),
          downsideDelayDays: minor(input.data.downsideDelayDays, 7),
        },
      );
      record = store(
        "connected-cash-forecasts",
        "30-day cash forecast",
        "planning_estimate",
        { forecast: value },
      );
      message = "Base and downside forecasts saved with their input version.";
    } else if (input.action === "cash.erp.prepare") {
      requireRole(ctx, ["Admin", "Operations"]);
      requirePermission(state, "erp_draft", ctx.now);
      if (ownRecords(state, "connected-cash-erp").length)
        throw new Error(
          "The sample receipt already has a draft. Review that draft to avoid duplicates.",
        );
      const draft = buildErpDraft({ ...data.erpInput, maker: ctx.actor });
      record = store(
        "connected-cash-erp",
        "Invoice receipt · INV-SAMPLE-204",
        draft.status,
        { draft },
      );
      message =
        "The receipt, fee and credit note reconcile. A different Finance reviewer must approve the export.";
    } else if (
      input.action === "cash.erp.review" ||
      input.action === "cash.erp.export"
    ) {
      requireRole(ctx, ["Finance"]);
      requirePermission(state, "erp_draft", ctx.now);
      record = ownRecord(state, "connected-cash-erp", input.recordId);
      if (input.action === "cash.erp.review") {
        record.data.draft = reviewErpDraft(
          record.data.draft as ErpDraft,
          ctx.actor,
        );
        record.status = "reviewed";
        message = "Finance review recorded. The ERP has not been changed.";
      } else {
        const draft = record.data.draft as ErpDraft;
        const guard = guardErpDispatch(
          draft,
          {
            scope,
            mapping: data.erpInput.mapping,
            invoices: data.erpInput.invoices,
            readAuthorised: true,
          },
          [],
        );
        if (!guard.exportAllowed) throw new Error(guard.reasons.join(" "));
        const manifest = {
          schema: "valo.erp.review-export.v1",
          companyId: draft.input.mapping.companyId,
          invoiceAllocations: draft.input.allocations,
          creditNotes: draft.input.creditNotes,
          grossMinor: draft.input.grossMinor,
          netMinor: draft.input.netMinor,
          feeMinor: draft.input.feeMinor,
          mappingVersion: draft.input.mapping.version,
          requestHash: draft.requestHash,
          reviewer: draft.review!.reviewer,
          status: "not_posted",
          synthetic: true,
        };
        record.data.manifest = {
          ...manifest,
          manifestHash: cashEvidenceHash(manifest),
        };
        record.status = "exported";
        resultData = { manifest: record.data.manifest };
        message =
          "Reviewed ERP export prepared. Downloading it does not post a receipt.";
      }
      touch(record, ctx.now);
    } else if (input.action === "cash.vat.export") {
      requireRole(ctx, ["Finance"]);
      requirePermission(state, "erp_draft", ctx.now);
      const schedule = reconcileVatEvidence(
        scope,
        data.vatInvoices,
        data.vatAllocations,
        data.vatControl,
      );
      record = store(
        "connected-cash-vat",
        "VAT evidence review schedule",
        schedule.status,
        { schedule, reviewer: ctx.actor },
      );
      resultData = { manifest: schedule };
      message =
        "VAT review schedule saved with its evidence gaps. No return or payment was submitted.";
    } else if (input.action === "cash.payroll.prepare") {
      requireRole(ctx, ["Admin", "Operations"]);
      requirePermission(state, "payroll_prepare", ctx.now);
      if (ownRecords(state, "connected-cash-payroll").length)
        throw new Error(
          "This approved run already has a funding plan. Review its existing items before creating a correction.",
        );
      const plan = preparePayrollFundingPlan({
        scope,
        run: data.payrollRun,
        importedHash: data.payrollRun.sourceHash,
        maker: ctx.actor,
        sourceAccount: data.accounts[0]!,
        paymentDate: new Date(
          Date.parse(data.createdAt) + 7 * DAY,
        ).toISOString(),
        asOf: ctx.now,
        commitmentsMinor: 660_000_000,
        estimatedFeesMinor: 15_000,
        bufferMinor: 150_000_000,
      });
      record = store(
        "connected-cash-payroll",
        "Approved net-pay funding plan",
        plan.fundingStatus,
        { plan },
      );
      message =
        "Funding plan prepared from approved net pay. Ask a different Finance reviewer to check it.";
    } else if (input.action === "cash.payroll.refresh") {
      requireRole(ctx, ["Admin", "Operations"]);
      requirePermission(state, "payroll_prepare", ctx.now);
      record = ownRecord(state, "connected-cash-payroll", input.recordId);
      const oldPlan = record.data.plan as PayrollPlan;
      const sourceAccount = data.accounts.find(
        (a) => a.id === oldPlan.sourceAccountId,
      );
      if (!sourceAccount) throw new Error("The source account was not found.");
      const revised = refreshPayrollFundingPlan(
        oldPlan,
        sourceAccount,
        ctx.now,
        ctx.actor,
      );
      record.data.revisions = [
        ...(Array.isArray(record.data.revisions) ? record.data.revisions : []),
        {
          plan: structuredClone(oldPlan),
          replacedAt: ctx.now,
          reason: input.reason,
        },
      ];
      record.data.plan = revised;
      delete record.data.manifest;
      record.status = revised.fundingStatus;
      touch(record, ctx.now);
      message =
        "Funding review refreshed. Previous outcomes remain unchanged and a different Finance checker must approve this version.";
    } else if (
      input.action === "cash.payroll.approve" ||
      input.action === "cash.payroll.export" ||
      input.action === "cash.payroll.reconcile"
    ) {
      requireRole(ctx, ["Finance"]);
      if (input.action !== "cash.payroll.reconcile")
        requirePermission(state, "payroll_prepare", ctx.now);
      record = ownRecord(state, "connected-cash-payroll", input.recordId);
      let plan = record.data.plan as PayrollPlan;
      const checkCurrentFunding = () => {
        const source = data.accounts.find((a) => a.id === plan.sourceAccountId);
        if (
          !source ||
          source.balanceAsOf !== plan.balanceAsOf ||
          source.availableMinor !== plan.availableMinor ||
          !source.authorised ||
          !source.coverageComplete ||
          Date.parse(ctx.now) - Date.parse(plan.balanceAsOf) > 60 * 60_000
        )
          throw new Error(
            "The funding snapshot is stale or changed. Refresh sample balances and the payroll review, then obtain a new checker approval.",
          );
      };
      if (input.action === "cash.payroll.approve") {
        checkCurrentFunding();
        plan = approvePayrollPlan(plan, ctx.actor);
        record.status = "approved";
        message =
          "Checker approval saved. Bank authorisation is still separate.";
      } else if (input.action === "cash.payroll.export") {
        // Check freshness again at export; a prior green funding snapshot is not permanent authority.
        checkCurrentFunding();
        const manifest = exportPayrollManifest(plan);
        if (!manifest.itemCount)
          throw new Error(
            "No unsent items remain. Reconcile submitted or unknown outcomes before further work.",
          );
        record.data.manifest = manifest;
        resultData = { manifest };
        for (const item of plan.items.filter((i) => i.status === "planned"))
          plan = transitionPayrollItem(plan, item.id, {
            status: "exported",
            reference: manifest.manifestHash,
            amountMinor: item.netMinor,
            beneficiaryVersion: item.beneficiaryVersion,
            source: "export",
          });
        record.status = "exported_unpaid";
        message =
          "Approved bank export prepared. All exported items remain unpaid until bank evidence is recorded.";
      } else {
        const item = plan.items.find((i) => i.id === input.data.itemId);
        if (!item) throw new Error("Select a payroll item.");
        const status = String(input.data.status);
        if (!["succeeded", "failed", "unknown", "reversed"].includes(status))
          throw new Error("Choose a supported sample bank outcome.");
        plan = transitionPayrollItem(plan, item.id, {
          status: status as "succeeded" | "failed" | "unknown" | "reversed",
          reference: `SAMPLE-${status}-${item.id}`,
          amountMinor: item.netMinor,
          beneficiaryVersion: item.beneficiaryVersion,
          source: "synthetic_bank_evidence",
          lookupConfirmedNotSubmitted:
            input.data.lookupConfirmedNotSubmitted === true,
        });
        // Retain the historical export, but never offer it as the current bank file after item outcomes change.
        if (record.data.manifest) {
          record.data.exportHistory = [
            ...(Array.isArray(record.data.exportHistory)
              ? record.data.exportHistory
              : []),
            { manifest: record.data.manifest, supersededAt: ctx.now },
          ];
          delete record.data.manifest;
        }
        record.status = payrollPlanSummary(plan).status;
        message =
          "Sample bank outcome recorded for this item only. No payment was initiated.";
      }
      record.data.plan = plan;
      touch(record, ctx.now);
    } else throw new Error("Unknown Cash Desk action.");
  }
  return {
    message,
    record,
    data: {
      ...resultData,
      synthetic: true,
      externalInstructionPerformed: false,
    },
  };
}
