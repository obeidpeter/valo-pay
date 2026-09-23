import { useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  CheckCircle2,
  FileCheck2,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import {
  ConnectedFrame,
  ConnectedPanel,
  ConnectedStatus,
  ConnectedRecovery,
} from "@/components/connected-frame";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Loading } from "@/components/loading";
import { LoadProblem } from "@/components/load-problem";
import { useConnected } from "@/lib/connected";
import { formatCount, formatDate, formatKobo, formatNumber } from "@/lib/formatters";
import { nairaToKobo } from "@/lib/money-input";
import { useFormDraft, useUnsavedChanges } from "@/lib/unsaved-changes";
import { useWorkspace } from "@/lib/workspace-context";

interface Assessment {
  id: string;
  customerId: string;
  customerName: string;
  createdAt: string;
  createdBy: string;
  scenario: string;
  permissionRestricted: boolean;
  result: {
    id: string;
    version: number;
    state: string;
    assessedAsOf: string;
    snapshotHash: string;
    previousResultId: string | null;
    evidence: {
      status: string;
      sourceCount: number;
      coverageDays: number;
      earliestSourceAsOf: string | null;
      latestSourceAsOf: string | null;
      issues: { code: string; message: string; severity: string }[];
    };
    score: {
      value: number;
      maximum: number;
      rulecardVersion: string;
      factors: {
        code: string;
        label: string;
        points: number;
        maximum: number;
        reason: string;
      }[];
    } | null;
    affordability: {
      monthlyCapacityKobo: number;
      peakScheduledMonthlyKobo: number;
      stressedMonthlyIncomeKobo: number;
      baselineResidualKobo: number;
      stressedResidualKobo: number;
      indicativePrincipalCapacityKobo: number;
      requestedPrincipalKobo: number;
      scheduledTotalKobo: number;
      termDays: number;
      debtServiceBps: number | null;
      repaymentMonths: {
        month: string;
        amountKobo: number;
        stressedAfterPaymentKobo: number;
      }[];
      scheduleAffordable: boolean;
    } | null;
    features: {
      sustainableMonthlyIncomeKobo: number;
      essentialMonthlyKobo: number;
      verifiedCommitmentsMonthlyKobo: number;
      declaredCommitmentsMonthlyKobo: number;
      liquidityBufferKobo: number | null;
      includedTransactionRefs: string[];
      excludedTransactions: { reference: string; reason: string }[];
      duplicatesIgnored: number;
      monthlyIncomeKobo: number[];
    } | null;
    policy: {
      id: string;
      version: number;
      recommendation: string;
      reasons: string[];
    };
  };
  reviews: {
    id: string;
    reviewer: string;
    reviewedAt: string;
    outcome: string;
    rationale: string;
    applicantExplanation: string;
    override: boolean;
    overrideRationale: string | null;
  }[];
}
interface CreditDeskView {
  canAssess: boolean;
  canReview: boolean;
  actor: string;
  customers: {
    id: string;
    name: string;
    reference: string;
    permissions: { accountRead: boolean; creditAssessment: boolean };
  }[];
  assessments: Assessment[];
  model: {
    name: string;
    version: string;
    status: string;
    validation: string;
    weights: { label: string; maximum: number }[];
  };
  gate: { id: string; enabled: boolean; requirements: string[] };
}
const scenarios = [
  [
    "ready",
    "Complete evidence",
    "Three income cycles, reviewed costs and commitments.",
  ],
  [
    "thin_file",
    "Short history",
    "Show why a month of records cannot stand in for three.",
  ],
  [
    "stale",
    "Out-of-date evidence",
    "Ask for a refresh before the result can be used.",
  ],
  [
    "refused",
    "Optional permission refused",
    "Refusal leaves the score unavailable; it is not bad credit.",
  ],
  [
    "high_commitments",
    "High existing repayments",
    "A strong rule score cannot bypass affordability.",
  ],
] as const;
const recommendationLabels: Record<string, string> = {
  review_recommended: "Ready for lender review",
  policy_not_met: "Policy checks not met",
  insufficient_evidence: "More evidence needed",
};
const outcomeLabels: Record<string, string> = {
  approve: "Sample approval recorded",
  decline: "Sample decline recorded",
  request_information: "More information requested",
};

export default function CreditDeskPage() {
  const api = useConnected(),
    { merchantId } = useWorkspace();
  return <CreditDeskContent key={merchantId} api={api} />;
}
function CreditDeskContent({ api }: { api: ReturnType<typeof useConnected> }) {
  const [customerId, setCustomerId] = useState(""),
    [scenario, setScenario] = useState("ready"),
    [selectedId, setSelectedId] = useState("");
  const [principal, setPrincipal] = useState("240000"),
    [repayment, setRepayment] = useState("90000"),
    [months, setMonths] = useState("3");
  const [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const [tab, setTab] = useState<"assessment" | "evidence" | "history">(
    "assessment",
  );
  const [amountErrors, setAmountErrors] = useState<Record<string, string>>({});
  // An assessment typed but not run is a draft: leaving asks first.
  const draft = useFormDraft({ customerId, scenario, principal, repayment, months, reason });
  if (api.isLoading) return <Loading what="Credit Desk" />;
  if (!api.data)
    return (
      <>
        <LoadProblem
          what="Credit Desk"
          error={api.error}
          retry={() => void api.refetch()}
        />
        <ConnectedRecovery recovery={api} />
      </>
    );
  const data = api.data.credit as CreditDeskView;
  const customer =
    data.customers.find((item) => item.id === customerId) ?? data.customers[0];
  const selected =
    data.assessments.find((item) => item.id === selectedId) ??
    data.assessments[0];
  const result = selected?.result;
  const completeCount = data.assessments.filter(
    (item) => item.result.score && !item.reviews.length,
  ).length;
  const assess = async () => {
    setError("");
    setSuccess("");
    const errors: Record<string, string> = {};
    const parse = (id: string, value: string) => {
      try {
        const kobo = nairaToKobo(value);
        if (kobo < 100 || kobo > 100_000_000_000)
          throw new Error("Enter an amount from ₦1.00 to ₦1,000,000,000.00.");
        return kobo;
      } catch (failure) {
        errors[id] = (failure as Error).message;
        return 0;
      }
    };
    const principalKobo = parse("credit-principal", principal),
      repaymentKobo = parse("credit-repayment", repayment);
    setAmountErrors(errors);
    if (Object.keys(errors).length) {
      document.getElementById(Object.keys(errors)[0])?.focus();
      return;
    }
    if (!customer) {
      setError("Choose an applicant before running an assessment.");
      return;
    }
    draft.sending({ customerId, scenario, principal, repayment, months, reason: "" });
    try {
      await api.run(
        "credit.assess",
        {
          customerId: customer.id,
          scenario,
          principalKobo,
          repaymentKobo,
          termMonths: Number(months),
        },
        undefined,
        reason,
      );
      setSelectedId("");
      setTab("assessment");
      setSuccess(
        "A new immutable sample assessment has been recorded. Review its evidence and explanations below.",
      );
      setReason("");
      draft.saved();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <ConnectedFrame
      title="Credit Desk"
      description="Turn authorised evidence into a clear assessment. Keep the lender’s decision separate."
      recovery={api}
      onReleased={() => setError("")}
      onRecovered={() => {
        setError("");
        setReason("");
        setSelectedId("");
        setTab("assessment");
        draft.saved();
      }}
    >
      <div className="connected-metrics">
        <div className="connected-metric">
          <span>Sample assessments</span>
          <strong>{formatNumber(data.assessments.length)}</strong>
        </div>
        <div className="connected-metric">
          <span>Awaiting a reviewer</span>
          <strong>{formatNumber(completeCount)}</strong>
        </div>
        <div className="connected-metric">
          <span>Decision model</span>
          <strong className="!text-xl">Human review</strong>
        </div>
      </div>
      <p className="connected-note">
        <ShieldCheck className="inline mr-2" size={16} aria-hidden="true" />
        Explore automatic rule scoring and capacity calculations using sample
        evidence. The rules are unvalidated. No real borrower is assessed, no
        credit is issued and no money moves.
      </p>
      {error && !api.hasUnconfirmedOutcome && (
        <p className="connected-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="connected-note" role="status">
          {success}
        </p>
      )}
      <div className="connected-grid">
        <ConnectedPanel
          title="Prepare an assessment"
          description="Choose a sample case and the lender’s proposed repayment schedule."
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void assess();
            }}
          >
            <div>
              <label htmlFor="credit-customer">Applicant</label>
              <select
                id="credit-customer"
                value={customer?.id ?? ""}
                onChange={(event) => setCustomerId(event.target.value)}
                required
              >
                {data.customers.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name} · {item.reference}
                  </option>
                ))}
              </select>
            </div>
            {customer && (
              <div className="rounded-lg border p-3 text-sm space-y-2">
                <p className="font-medium">Separate permissions</p>
                <p>
                  Account reading:{" "}
                  {customer.permissions.accountRead ? "Active" : "Required"}
                </p>
                <p>
                  Credit assessment:{" "}
                  {customer.permissions.creditAssessment
                    ? "Active"
                    : "Required"}
                </p>
                {(!customer.permissions.accountRead ||
                  !customer.permissions.creditAssessment) && (
                  <Link
                    href="/connections"
                    className="font-medium underline underline-offset-4"
                  >
                    Set up sample permissions{" "}
                    <ArrowRight
                      size={13}
                      className="inline"
                      aria-hidden="true"
                    />
                  </Link>
                )}
                <p className="text-xs text-muted-foreground">
                  Missing permissions produce a blocked assessment. They never
                  authorise a payment.
                </p>
              </div>
            )}
            <div>
              <label htmlFor="credit-scenario">Evidence scenario</label>
              <select
                id="credit-scenario"
                value={scenario}
                onChange={(event) => setScenario(event.target.value)}
              >
                {scenarios.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {scenarios.find(([value]) => value === scenario)?.[2]}
              </p>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="credit-principal">
                  Requested principal (₦)
                </label>
                <input
                  id="credit-principal"
                  inputMode="decimal"
                  aria-invalid={!!amountErrors["credit-principal"]}
                  aria-describedby={
                    amountErrors["credit-principal"]
                      ? "credit-principal-error"
                      : undefined
                  }
                  value={principal}
                  onChange={(event) => setPrincipal(event.target.value)}
                  required
                />
                {amountErrors["credit-principal"] && (
                  <p
                    id="credit-principal-error"
                    className="mt-2 text-xs text-destructive"
                    role="alert"
                  >
                    {amountErrors["credit-principal"]}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="credit-repayment">
                  Repayment per period (₦)
                </label>
                <input
                  id="credit-repayment"
                  inputMode="decimal"
                  aria-invalid={!!amountErrors["credit-repayment"]}
                  aria-describedby={
                    amountErrors["credit-repayment"]
                      ? "credit-repayment-error"
                      : undefined
                  }
                  value={repayment}
                  onChange={(event) => setRepayment(event.target.value)}
                  required
                />
                {amountErrors["credit-repayment"] && (
                  <p
                    id="credit-repayment-error"
                    className="mt-2 text-xs text-destructive"
                    role="alert"
                  >
                    {amountErrors["credit-repayment"]}
                  </p>
                )}
              </div>
            </div>
            <div>
              <label htmlFor="credit-term">Number of 30-day repayments</label>
              <select
                id="credit-term"
                value={months}
                onChange={(event) => setMonths(event.target.value)}
              >
                {[1, 2, 3, 6, 9, 12, 18, 24].map((value) => (
                  <option key={value} value={value}>
                    {formatCount(value, "repayment")}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Include all charges. Payments falling in the same calendar month
                are combined for the affordability check.
              </p>
            </div>
            <div>
              <label htmlFor="credit-reason">Reason for this assessment</label>
              <textarea
                id="credit-reason"
                rows={2}
                minLength={8}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Describe the application or calculation you are reviewing"
                required
              />
            </div>
            <Button
              type="submit"
              busy={api.pending}
              busyLabel="Calculating…"
              disabled={!data.canAssess || !api.canWrite || !customer}
            >
              <FileCheck2 aria-hidden="true" /> Run sample assessment
            </Button>
            {!data.canAssess && (
              <p className="text-xs text-muted-foreground">
                Switch to Admin or Operations to prepare an assessment.
              </p>
            )}
          </form>
        </ConnectedPanel>
        <ConnectedPanel
          title="Assessment workspace"
          description="Each run creates a new version. Earlier results and reviews remain traceable."
        >
          {!selected ? (
            <div className="py-12 text-center">
              <FileCheck2
                size={36}
                className="mx-auto mb-4 text-muted-foreground"
                aria-hidden="true"
              />
              <h3 className="font-semibold">Start with a sample application</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Grant both permissions, choose a scenario and run an assessment
                to inspect the score, capacity and independent policy checks.
              </p>
            </div>
          ) : (
            <>
              <div className="mb-4">
                <label htmlFor="credit-result">Assessment version</label>
                <select
                  id="credit-result"
                  value={selected.id}
                  onChange={(event) => {
                    setSelectedId(event.target.value);
                    setTab("assessment");
                  }}
                >
                  {data.assessments.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.customerName} · v{item.result.version} ·{" "}
                      {recommendationLabels[
                        item.result.policy.recommendation
                      ] ?? item.result.policy.recommendation}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
                <div>
                  <h3 className="text-xl font-semibold">
                    {selected.customerName}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Version {result!.version} · {formatDate(selected.createdAt)}
                  </p>
                </div>
                <ConnectedStatus status={result!.state} />
              </div>
              <Tabs
                value={tab}
                onValueChange={(value) => setTab(value as typeof tab)}
              >
                <TabsList
                  className="flex w-full justify-start gap-2 mb-5 h-auto flex-wrap"
                  aria-label="Assessment details"
                >
                  {(["assessment", "evidence", "history"] as const).map(
                    (value) => (
                      <TabsTrigger
                        key={value}
                        value={value}
                        className="min-h-10"
                      >
                        {value === "assessment"
                          ? "Assessment"
                          : value === "evidence"
                            ? "Evidence"
                            : "Review history"}
                      </TabsTrigger>
                    ),
                  )}
                </TabsList>
                <TabsContent value="assessment">
                  {result!.score ? (
                    <div className="flex items-center gap-5 mb-5 rounded-xl bg-muted/50 p-5">
                      <div className="text-5xl tracking-tight font-semibold tabular-nums">
                        {result!.score.value}
                        <span className="text-base text-muted-foreground">
                          {" "}
                          /100
                        </span>
                      </div>
                      <div>
                        <p className="font-semibold">Illustrative rule score</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Not a probability of default.
                          <br />
                          Not a lending decision.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="connected-note mb-4">
                      <h3 className="font-semibold">Score unavailable</h3>
                      <p className="mt-2 text-sm">
                        {selected.permissionRestricted
                          ? "Permission changed or ended. Create a new assessment with valid authority."
                          : "Resolve the evidence issues below. Missing data or refusing an optional connection does not mean a score of zero."}
                      </p>
                    </div>
                  )}
                  <div className="mb-5">
                    <h3 className="font-semibold">
                      {recommendationLabels[result!.policy.recommendation]}
                    </h3>
                    {result!.policy.reasons.map((message) => (
                      <p
                        key={message}
                        className="text-sm text-muted-foreground mt-2"
                      >
                        {message}
                      </p>
                    ))}
                  </div>
                  {result!.evidence.issues.length > 0 && (
                    <div className="space-y-2 mb-5">
                      {result!.evidence.issues.map((issue, index) => (
                        <p
                          key={`${issue.code}-${index}`}
                          className={`rounded-md border p-3 text-sm ${issue.severity === "blocking" ? "border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/20" : "bg-muted/30"}`}
                        >
                          {issue.message}
                        </p>
                      ))}
                    </div>
                  )}
                  {result!.affordability && (
                    <>
                      <h3 className="font-semibold mb-3">
                        Capacity for the proposed schedule
                      </h3>
                      <dl className="space-y-3 text-sm mb-5">
                        <Amount
                          label="Stressed monthly income"
                          value={
                            result!.affordability.stressedMonthlyIncomeKobo
                          }
                        />
                        <Amount
                          label="Monthly repayment capacity"
                          value={result!.affordability.monthlyCapacityKobo}
                          strong
                        />
                        <Amount
                          label="Highest scheduled monthly payment"
                          value={result!.affordability.peakScheduledMonthlyKobo}
                        />
                        <Amount
                          label="Principal supported by this schedule"
                          value={
                            result!.affordability
                              .indicativePrincipalCapacityKobo
                          }
                        />
                        <Amount
                          label="Total repayment, including charges"
                          value={result!.affordability.scheduledTotalKobo}
                        />
                      </dl>
                      <p className="text-xs text-muted-foreground mb-5">
                        Income is reduced by 20% in this illustrative policy.
                        Essential costs, existing repayments, a ₦50,000 buffer
                        and a 40% debt-service limit constrain capacity. The
                        principal estimate proportionally scales this schedule;
                        it is not a loan offer.
                      </p>
                    </>
                  )}
                  {result!.score && (
                    <div className="space-y-4">
                      <h3 className="font-semibold">
                        Why the score looks this way
                      </h3>
                      {result!.score.factors.map((factor) => (
                        <div key={factor.code}>
                          <div className="flex justify-between gap-3 text-sm mb-2">
                            <span>{factor.label}</span>
                            <strong className="tabular-nums">
                              {factor.points}/{factor.maximum}
                            </strong>
                          </div>
                          <div
                            className="h-1.5 rounded-full bg-muted overflow-hidden"
                            aria-hidden="true"
                          >
                            <div
                              className="h-full bg-primary rounded-full"
                              style={{
                                width: `${(100 * factor.points) / factor.maximum}%`,
                              }}
                            />
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {factor.reason}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="evidence" className="space-y-5">
                  <dl className="text-sm space-y-3">
                    <div className="flex justify-between gap-3">
                      <dt>Source accounts</dt>
                      <dd>{formatNumber(result!.evidence.sourceCount)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>Complete history</dt>
                      <dd>{formatCount(result!.evidence.coverageDays, "day")}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        Oldest source update
                      </dt>
                      <dd>
                        {result!.evidence.earliestSourceAsOf
                          ? formatDate(result!.evidence.earliestSourceAsOf)
                          : "Unavailable"}
                      </dd>
                    </div>
                  </dl>
                  {result!.features && (
                    <>
                      <dl className="text-sm space-y-3">
                        <Amount
                          label="Sustainable income per 30 days"
                          value={result!.features.sustainableMonthlyIncomeKobo}
                        />
                        <Amount
                          label="Reviewed essential costs"
                          value={result!.features.essentialMonthlyKobo}
                        />
                        <Amount
                          label="Verified existing repayments"
                          value={
                            result!.features.verifiedCommitmentsMonthlyKobo
                          }
                        />
                        <Amount
                          label="Declared existing repayments"
                          value={
                            result!.features.declaredCommitmentsMonthlyKobo
                          }
                        />
                        <Amount
                          label="Median observed liquidity"
                          value={result!.features.liquidityBufferKobo ?? 0}
                        />
                      </dl>
                      <p className="text-sm">
                        {formatCount(
                          result!.features.includedTransactionRefs.length,
                          "included observation",
                        )}{" "}
                        ·{" "}
                        {formatNumber(
                          result!.features.excludedTransactions.length,
                        )}{" "}
                        excluded ·{" "}
                        {formatCount(
                          result!.features.duplicatesIgnored,
                          "duplicate observation",
                        )}{" "}
                        ignored.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Matched own-account transfers, loan proceeds, refunds
                        and asset sales do not count as recurring income.
                        Unclear classifications need review.
                      </p>
                      {result!.features.excludedTransactions.length > 0 && (
                        <details>
                          <summary className="cursor-pointer text-sm font-medium">
                            Excluded observations
                          </summary>
                          <ul className="mt-3 space-y-2 text-xs">
                            {result!.features.excludedTransactions.map(
                              (item) => (
                                <li key={item.reference} className="break-all">
                                  {item.reference} —{" "}
                                  {item.reason.replaceAll("_", " ")}
                                </li>
                              ),
                            )}
                          </ul>
                        </details>
                      )}
                    </>
                  )}
                  <div className="border-t pt-4">
                    <p className="text-xs font-medium">
                      Immutable evidence fingerprint
                    </p>
                    <p className="break-all text-xs text-muted-foreground mt-2 font-mono">
                      {result!.snapshotHash}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Rulecard{" "}
                      {result!.score?.rulecardVersion ?? data.model.version} ·
                      Policy version {result!.policy.version}
                    </p>
                  </div>
                </TabsContent>
                <TabsContent value="history" className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Prepared by {selected.createdBy}.{" "}
                    {result!.previousResultId
                      ? `This version supersedes an earlier immutable assessment.`
                      : "This is the first assessment version."}
                  </p>
                  {selected.reviews.length === 0 ? (
                    <p className="text-sm">
                      No reviewer outcome has been recorded for this version.
                    </p>
                  ) : (
                    selected.reviews.map((review) => (
                      <article className="connected-record" key={review.id}>
                        <h3>
                          <CheckCircle2
                            size={16}
                            className="inline mr-2"
                            aria-hidden="true"
                          />
                          {outcomeLabels[review.outcome]}
                        </h3>
                        <p className="mt-2">
                          {review.reviewer} · {formatDate(review.reviewedAt)}
                        </p>
                        <p className="mt-3">{review.rationale}</p>
                        <p className="mt-3">
                          <strong>Applicant explanation:</strong>{" "}
                          {review.applicantExplanation}
                        </p>
                        {review.override && (
                          <p className="mt-3">
                            <strong>Policy override:</strong>{" "}
                            {review.overrideRationale}
                          </p>
                        )}
                        <p className="mt-3 text-xs">
                          Simulated reviewer authentication. This is not an
                          actual lending decision.
                        </p>
                      </article>
                    ))
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}
        </ConnectedPanel>
      </div>
      {selected && (
        <ReviewPanel
          key={selected.id}
          assessment={selected}
          canReview={
            data.canReview && api.canWrite && selected.createdBy !== data.actor
          }
          pending={api.pending}
          onReview={async (reviewData) => {
            draft.sending(null);
            await api.run(
              "credit.review",
              reviewData,
              selected.id,
              "Record a reasoned synthetic lender review",
            );
            setTab("history");
            setSuccess(
              "The separate sample review is recorded. The assessment and its score are unchanged.",
            );
          }}
        />
      )}
      <ConnectedPanel
        title="Model governance"
        description="The sandbox makes proposed controls testable. It does not satisfy the approval gate for lending."
      >
        <div className="connected-subgrid">
          <div className="connected-record">
            <h3>{data.model.name}</h3>
            <p className="mt-2">
              {data.model.validation}. Every missing mandatory feature keeps the
              score unavailable; its weight is never redistributed.
            </p>
          </div>
          <div className="connected-record">
            <h3>
              <LockKeyhole
                size={16}
                className="inline mr-2"
                aria-hidden="true"
              />
              Live use is gated
            </h3>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              {data.gate.requirements.map((requirement) => (
                <li key={requirement}>{requirement}</li>
              ))}
            </ul>
          </div>
        </div>
      </ConnectedPanel>
    </ConnectedFrame>
  );
}
function Amount({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between gap-5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`tabular-nums text-right ${strong ? "font-semibold" : ""}`}
      >
        {formatKobo(value)}
      </dd>
    </div>
  );
}
function ReviewPanel({
  assessment,
  canReview,
  pending,
  onReview,
}: {
  assessment: Assessment;
  canReview: boolean;
  pending: boolean;
  onReview: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [outcome, setOutcome] = useState(""),
    [rationale, setRationale] = useState(""),
    [explanation, setExplanation] = useState(""),
    [override, setOverride] = useState(""),
    [error, setError] = useState("");
  // A review typed but not recorded is a draft: leaving asks first.
  useUnsavedChanges(
    !assessment.reviews.length &&
      Boolean(outcome || rationale || explanation || override),
  );
  const needsOverride =
    outcome === "approve" &&
    assessment.result.policy.recommendation === "policy_not_met";
  const usable = !!assessment.result.score && !assessment.permissionRestricted;
  return (
    <ConnectedPanel
      title="Record a separate reviewer outcome"
      description="Read the evidence and calculations first. The outcome is a sandbox exercise; it cannot issue a loan."
    >
      {assessment.reviews.length ? (
        <p className="text-sm text-muted-foreground">
          This version already has an immutable review. Open Review history to
          read it, or prepare a new assessment with updated terms or evidence.
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            try {
              await onReview({
                expectedAssessmentVersion: assessment.result.version,
                outcome,
                rationale,
                applicantExplanation: explanation,
                reasonCodes: [
                  outcome === "request_information"
                    ? "evidence_review_required"
                    : "reviewer_evidence_assessment",
                ],
                ...(needsOverride ? { overrideRationale: override } : {}),
              });
              setOutcome("");
              setRationale("");
              setExplanation("");
              setOverride("");
            } catch (failure) {
              setError((failure as Error).message);
            }
          }}
        >
          {!canReview && (
            <p className="connected-note">
              A different reviewer must complete this step. Switch from the
              assessor to Finance, Compliance reviewer or a different permitted
              role using the workspace role selector. Authentication here is
              simulated.
            </p>
          )}
          {error && (
            <p className="connected-error" role="alert">
              {error}
            </p>
          )}
          <div>
            <label htmlFor="credit-review-outcome">Reviewer outcome</label>
            <select
              id="credit-review-outcome"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
              required
              disabled={!canReview}
            >
              <option value="">Choose after reviewing the evidence</option>
              <option value="request_information">
                Request more information
              </option>
              <option value="approve" disabled={!usable}>
                Record sample approval
              </option>
              <option value="decline" disabled={!usable}>
                Record sample decline
              </option>
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              To amend terms, prepare a new assessment with the changed
              schedule. Evidence gaps cannot be converted to a decline.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="credit-review-rationale">
                What did you review?
              </label>
              <textarea
                id="credit-review-rationale"
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                minLength={20}
                maxLength={4000}
                rows={3}
                placeholder="Explain the evidence and why it supports your outcome"
                required
                disabled={!canReview}
              />
            </div>
            <div>
              <label htmlFor="credit-applicant-explanation">
                Explanation for the applicant
              </label>
              <textarea
                id="credit-applicant-explanation"
                value={explanation}
                onChange={(event) => setExplanation(event.target.value)}
                minLength={20}
                maxLength={4000}
                rows={3}
                placeholder="Use clear reasons that an applicant could understand and question"
                required
                disabled={!canReview}
              />
            </div>
          </div>
          {needsOverride && (
            <div>
              <label htmlFor="credit-override">
                Reason for overriding the policy
              </label>
              <textarea
                id="credit-override"
                value={override}
                onChange={(event) => setOverride(event.target.value)}
                minLength={30}
                maxLength={4000}
                rows={3}
                placeholder="Explain the additional evidence and why the policy recommendation is being overridden"
                required
                disabled={!canReview}
              />
            </div>
          )}
          <Button
            type="submit"
            variant="outline"
            disabled={!canReview || !outcome || assessment.permissionRestricted}
            busy={pending}
            busyLabel="Recording review…"
          >
            Record sample review
          </Button>
        </form>
      )}
    </ConnectedPanel>
  );
}
