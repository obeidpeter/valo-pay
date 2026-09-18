import React, { useState } from 'react';
import { EmptyRow, EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetReports, usePerformAction, getGetReportsQueryKey, useCreateExport, useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { BarChart3, Download, FileText, CheckSquare, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatKobo, formatDate } from '@/lib/formatters';
import { RecordDialog } from '@/components/record-dialog';

type Unknown = Record<string, unknown> | undefined;
const isScalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const scalarEntries = (record: Unknown): Array<[string, unknown]> => Object.entries(record || {}).filter(([, value]) => isScalar(value));
const billingLines = (record: Unknown): Array<Record<string, any>> => Array.isArray(record?.lines) ? (record!.lines as Array<Record<string, any>>) : [];
const experimentRows = (record: Unknown): Array<Record<string, any>> => Array.isArray(record?.results) ? (record!.results as Array<Record<string, any>>) : [];
const labelOf = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/^./, first => first.toUpperCase()).trim();
const percent = (value: unknown) => typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'n/a';
const invoiceRows = (record: Unknown): Array<Record<string, any>> => Array.isArray(record?.invoices) ? (record!.invoices as Array<Record<string, any>>) : [];
const adjustmentRows = (record: Unknown): Array<Record<string, any>> => Array.isArray(record?.pendingAdjustments) ? (record!.pendingAdjustments as Array<Record<string, any>>) : [];
/** REC-07: the close report fields, in the order the TRD lists them. */
function closeReportChips(report: Record<string, any>): Array<[string, string]> {
  const money = (row: any) => `${row?.count ?? 0} · ${formatKobo(Number(row?.kobo || 0))}`;
  const bySource = Object.entries(report.observations?.bySource || {}).map(([source, row]: [string, any]) => `${source} ${row.received}→${row.paymentsResolvedTo} payments`).join(', ') || 'none';
  const byRule = Object.entries(report.allocatedByRule || {}).map(([rule, row]: [string, any]) => `${rule} ${row.count}`).join(', ') || 'none';
  return [
    ['opening unallocated', money(report.openingUnallocated)],
    ['observations received', `${report.observations?.received ?? 0} (${bySource})`],
    ['allocated by rule', byRule],
    ['proposed', money(report.proposed)],
    ['unallocated at close', `${money(report.unallocated)} · ${report.unallocated?.olderThan24Hours ?? 0} older than 24h`],
    ['variances', `${report.variances?.count ?? 0} · ${formatKobo(Number(report.variances?.feeVarianceKobo || 0))}`],
    ['exceptions', `${report.exceptions?.opened?.count ?? 0} opened · ${report.exceptions?.closed?.count ?? 0} closed · ${report.exceptions?.openAtClose ?? 0} open`],
    ['positions changed', String(report.customerPositionsChanged?.length ?? 0)],
    ['retry decisions', `${report.retryDecisions?.recorded ?? 0} recorded · ${report.retryDecisions?.finalAttempts ?? 0} final · ${report.retryDecisions?.noticesNotEvidenced ?? 0} deferred`],
  ];
}
function renderValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (/kobo$/i.test(key)) return formatKobo(value);
    if (/rate$|precision$|share$/i.test(key)) return percent(value);
    return String(value);
  }
  return String(value);
}

/** REC-01: the schedule block on a close record and the schedule view in the operational report, typed from free-form data. */
interface CloseScheduleView { time: string; enabled: boolean; nextAt: string; missed: boolean; overdueMinutes: number }
interface CloseTriggerView { trigger: string; late: boolean; delayMinutes: number | null; scheduledFor: string | null }
function scheduleView(value: unknown): CloseScheduleView | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  return { time: String(raw.time ?? ''), enabled: raw.enabled !== false, nextAt: String(raw.nextAt ?? ''), missed: raw.missed === true, overdueMinutes: Number(raw.overdueMinutes ?? 0) };
}
function triggerView(value: unknown): CloseTriggerView | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  return { trigger: String(raw.trigger ?? 'manual'), late: raw.late === true, delayMinutes: typeof raw.delayMinutes === 'number' ? raw.delayMinutes : null, scheduledFor: typeof raw.scheduledFor === 'string' ? raw.scheduledFor : null };
}

export default function ReportsPage() {
  const { merchantId } = useWorkspace();
  const [experimentDialog, setExperimentDialog] = useState<'create' | 'edit' | 'preregister' | null>(null);
  const [selectedExperiment, setSelectedExperiment] = useState<any>(null);
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);

  const { data: reports, isLoading, refetch } = useGetReports(
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getGetReportsQueryKey({ merchantId: merchantId! }) } }
  );

  const dailyClose = usePerformAction({
    mutation: {
      onSuccess: () => refetch()
    }
  });

  const { data: experiments } = useListRecords(
    'experiments',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('experiments', { merchantId: merchantId! }) } }
  );
  const { data: policies } = useListRecords(
    'policies',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('policies', { merchantId: merchantId! }) } }
  );

  const createExport = useCreateExport({
    mutation: {
      onSuccess: (data) => {
        window.open(data.downloadUrl, '_blank');
      }
    }
  });

  if (!merchantId) return null;
  const approvedPolicyOptions = (policies?.items || [])
    .filter(policy => policy.status === 'approved')
    .map(policy => ({ label: `${policy.name} · v${String(policy.data?.version || 1)}`, value: policy.id }));
  const openExperimentDialog = (mode: 'create' | 'edit' | 'preregister', experiment?: any) => {
    setSelectedExperiment(experiment || null);
    setExperimentDialog(mode);
  };

  return (
    <div className="space-y-8">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports & Analytics</h1>
          <p className="text-muted-foreground mt-1">Daily closes, billing, and operational measurement.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button 
            variant="outline" 
            className="gap-2"
            onClick={() => createExport.mutate({ data: { kind: 'billing', format: 'csv' }, params: { merchantId } })}
            busy={createExport.isPending}
            busyLabel="Generating…"
          >
            <Download className="h-4 w-4" /> Export Billing CSV
          </Button>
          <Button variant="outline" className="gap-2" onClick={() => setInvoiceDialogOpen(true)}>
            <FileText className="h-4 w-4" /> Issue invoice
          </Button>
          <Button 
            className="gap-2"
            onClick={() => dailyClose.mutate({ data: { action: 'daily_close' }, params: { merchantId } })}
            busy={dailyClose.isPending}
            busyLabel="Closing the day…"
          >
            <RefreshCcw className="h-4 w-4" /> Trigger Daily Close
          </Button>
        </div>
      </header>

      {isLoading ? (
        <Loading what="reports" />
      ) : !reports ? (
        <div className="p-12 text-center text-destructive">Failed to generate reports.</div>
      ) : (
        <div className="space-y-8">
          {/* Top Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-card border rounded-xl p-5 shadow-sm">
               <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Staff confirmation</p>
               <div className="mt-2 text-3xl font-bold font-mono">{reports.operational?.fortnightlyStaffConfirmed ? 'Yes' : 'No'}</div>
               <p className="text-xs text-muted-foreground mt-2">{reports.operational?.latestReviewAt ? `Latest confirming review ${formatDate(String(reports.operational.latestReviewAt))}; cadence ${reports.operational?.reviewCadenceMet ? 'kept' : 'broken'} since the first close.` : 'No fortnightly review by a named user has confirmed all four jobs yet (Test 5).'}</p>
            </div>
            <div className="bg-card border rounded-xl p-5 shadow-sm">
               <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Precision audit</p>
               <div className="mt-2 text-3xl font-bold font-mono">{String((reports.operational?.precisionAudit as any)?.reviewed ?? 0)} / {String(reports.operational?.requiredAuditSample || 0)}</div>
               <p className="text-xs text-muted-foreground mt-2">{(() => { const audit = reports.operational?.precisionAudit as any; return audit?.falseMatchRate === null || audit?.falseMatchRate === undefined ? `Seeded sample of ${String(audit?.sampleSize ?? 0)} of ${String(audit?.population ?? 0)} automatic certain matches for ${String(audit?.month ?? 'the completed month')}; none reviewed yet.` : `False-match rate ${percent(audit.falseMatchRate)}, 95% interval ${percent(audit.interval?.low)} to ${percent(audit.interval?.high)}, on ${String(audit.reviewed)} reviewed of ${String(audit.sampleSize)} sampled.`; })()}</p>
            </div>
            <div className="bg-card border rounded-xl p-5 shadow-sm">
               <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Live Days</p>
               <div className="mt-2 text-3xl font-bold font-mono">{String(reports.operational?.liveDays || 0)} / {String(reports.operational?.requiredLiveDays || 60)}</div>
               <p className="text-xs text-muted-foreground mt-2">{reports.operational?.liveSince ? `Since the first daily close on ${formatDate(String(reports.operational.liveSince))}.` : 'Counts from the first daily close.'}</p>
            </div>
            <div className="bg-card border rounded-xl p-5 shadow-sm">
               <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Real Cases Used</p>
               <div className="mt-2 text-3xl font-bold font-mono">
                 {String(reports.operational?.realCasesUsed || 0)} / {String(reports.operational?.requiredRealCases || 5)}
               </div>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {reports.metrics.map(metric => (
              <div key={metric.key} className="bg-card border rounded-xl p-5 shadow-sm">
                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{metric.label}</p>
                <div className="mt-2 text-3xl font-bold font-mono">
                  {metric.unit === 'kobo' ? formatKobo(metric.value) : metric.value}
                  {metric.unit !== 'kobo' && <span className="text-sm text-muted-foreground ml-1">{metric.unit}</span>}
                </div>
                {metric.detail && <p className="text-xs text-muted-foreground mt-2">{metric.detail}</p>}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Billing Statement Preview */}
            <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                <h2 className="font-semibold">Billing Statement (Current Period)</h2>
              </div>
              <div className="p-6">
                <div className="space-y-4 font-mono text-sm">
                  {scalarEntries(reports.billing).map(([key, value]) => (
                    <div key={key} className="flex justify-between items-baseline gap-4 border-b border-dashed border-border pb-2">
                      <span className="capitalize">{labelOf(key)}</span>
                      {/* A rule's text can carry one long token (a settings key); it breaks rather than pushing past a phone's edge. */}
                      <span className="min-w-0 font-bold [overflow-wrap:anywhere]">{renderValue(key, value)}</span>
                    </div>
                  ))}
                  {scalarEntries(reports.billing).length === 0 && (
                    <EmptyState title="No billing data for this period" className="px-0 py-4">Billable collections are counted from succeeded direct-debit attempts once the provider's reversal window has passed (BIL-01).</EmptyState>
                  )}
                </div>
                <div className="mt-6">
                  <h3 className="text-sm font-semibold mb-2">Statement lines</h3>
                  {billingLines(reports.billing).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No signed design-partner terms for this period; nothing is billable.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left font-mono">
                        <thead className="text-muted-foreground border-b">
                          <tr><th className="py-1 pr-2">Prospect</th><th className="py-1 pr-2">Tier</th><th className="py-1 pr-2 text-right">Licence</th><th className="py-1 pr-2 text-right">Usage</th><th className="py-1 pr-2 text-right">Total</th><th className="py-1">Note</th></tr>
                        </thead>
                        <tbody className="divide-y">
                          {billingLines(reports.billing).map(line => (
                            <tr key={String(line.commercialId)}>
                              <td className="py-1 pr-2 font-sans">{String(line.prospect)}</td>
                              <td className="py-1 pr-2">{String(line.volumeTier)}{line.tierMismatch ? ' (contract differs)' : ''}</td>
                              <td className="py-1 pr-2 text-right">{formatKobo(Number(line.licenceKobo || 0))}</td>
                              <td className="py-1 pr-2 text-right">{formatKobo(Number(line.usageKobo || 0))}</td>
                              <td className="py-1 pr-2 text-right font-bold">{formatKobo(Number(line.totalKobo || 0))}</td>
                              <td className="py-1 font-sans text-muted-foreground">{line.designPartnerDiscount ? 'Design-partner discount applied' : 'Full public price'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                <div className="mt-6">
                  <h3 className="text-sm font-semibold mb-2">Receipts by channel (BIL-01)</h3>
                  <p className="text-xs text-muted-foreground mb-2">Only direct-debit attempts that succeeded are billable, once settled, unreversed and past the provider's reversal window. Transfers and card receipts are reconciled and shown here, never billed.</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left font-mono">
                      <thead className="text-muted-foreground border-b"><tr><th className="py-1 pr-2">Channel</th><th className="py-1 pr-2 text-right">Receipts</th><th className="py-1 pr-2 text-right">Value</th><th className="py-1 pr-2 text-right">Billable</th></tr></thead>
                      <tbody className="divide-y">
                        {Object.entries((reports.billing?.channelBreakdown as Record<string, any>) || {}).map(([channel, row]) => (
                          <tr key={channel}><td className="py-1 pr-2">{channel}</td><td className="py-1 pr-2 text-right">{String(row.count)}</td><td className="py-1 pr-2 text-right">{formatKobo(Number(row.kobo || 0))}</td><td className="py-1 pr-2 text-right">{String(row.billable)}</td></tr>
                        ))}
                        {Object.keys((reports.billing?.channelBreakdown as Record<string, any>) || {}).length === 0 && <tr><td colSpan={4} className="py-2 text-muted-foreground">No receipts in this period.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">Withheld inside the reversal window: {String(reports.billing?.withheldInsideReversalWindow ?? 0)} (billed on a later statement).</p>
                </div>
                <div className="mt-6">
                  <h3 className="text-sm font-semibold mb-2">Unit economics (MEA-03)</h3>
                  {(() => { const e = reports.billing?.unitEconomics as Record<string, any> | undefined; if (!e) return <p className="text-xs text-muted-foreground">Not available.</p>; return (
                    <div className="text-xs font-mono space-y-1">
                      <p>Successful collections {String(e.successfulCollections)} · usage {formatKobo(Number(e.usageFeeKobo || 0))} · licence {formatKobo(Number(e.licenceKobo || 0))} ({String(e.volumeTier)}) · recurring {formatKobo(Number(e.recurringKobo || 0))}</p>
                      <p>Variable cost {formatKobo(Number(e.variableCostKobo || 0))}{e.estimated ? ' (estimated at the plan\'s NGN 15 per collection)' : ' (recorded)'} · per collection {e.costPerCollectionKobo === null ? 'n/a' : formatKobo(Number(e.costPerCollectionKobo))} against the plan\'s {formatKobo(Number(e.planCostPerCollectionKobo || 0))}</p>
                      <p>Gross margin {e.grossMargin === null ? 'n/a' : percent(e.grossMargin)} against the plan\'s {percent(e.planGrossMargin?.low)} to {percent(e.planGrossMargin?.high)} · annualised recurring revenue {formatKobo(Number(e.annualisedRecurringRevenueKobo || 0))} (licence and usage only)</p>
                      <p className="font-sans text-muted-foreground">{String(e.note || '')}</p>
                    </div>
                  ); })()}
                </div>
                <div className="mt-6">
                  <h3 className="text-sm font-semibold mb-2">Issued invoices (BIL-04)</h3>
                  {invoiceRows(reports.billing).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No invoice issued yet. The next one covers {String(reports.billing?.nextInvoicePeriod || 'the previous month')}; issued invoices are immutable and VAT is shown separately.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left font-mono">
                        <thead className="text-muted-foreground border-b"><tr><th className="py-1 pr-2">Invoice</th><th className="py-1 pr-2">Period</th><th className="py-1 pr-2 text-right">Counted</th><th className="py-1 pr-2 text-right">Adjustments</th><th className="py-1 pr-2 text-right">Net</th><th className="py-1 pr-2 text-right">VAT</th><th className="py-1 pr-2 text-right">Total</th></tr></thead>
                        <tbody className="divide-y">
                          {invoiceRows(reports.billing).map(invoice => (
                            <tr key={String(invoice.id)}>
                              <td className="py-1 pr-2">{String(invoice.reference)}{invoice.creditNote ? ' (credit note)' : ''}</td>
                              <td className="py-1 pr-2">{String(invoice.period)}</td>
                              <td className="py-1 pr-2 text-right">{String(invoice.collectionsCounted ?? 0)}</td>
                              <td className="py-1 pr-2 text-right">{String(invoice.adjustmentCount ?? 0)} · {formatKobo(Number(invoice.adjustmentsKobo || 0))}</td>
                              <td className="py-1 pr-2 text-right">{formatKobo(Number(invoice.netKobo || 0))}</td>
                              <td className="py-1 pr-2 text-right">{formatKobo(Number(invoice.vatKobo || 0))}</td>
                              <td className="py-1 pr-2 text-right font-bold">{formatKobo(Number(invoice.totalKobo || 0))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                <div className="mt-6">
                  <h3 className="text-sm font-semibold mb-2">Adjustments for the next invoice (BIL-07)</h3>
                  <p className="text-xs text-muted-foreground mb-2">A reversal, refund, confirmed duplicate or superseded allocation on a billed collection becomes a credit or debit line here, with the invoice it corrects. Issued invoices are never edited.</p>
                  {adjustmentRows(reports.billing).length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nothing to adjust.</p>
                  ) : (
                    <ul className="text-xs font-mono space-y-1">
                      {adjustmentRows(reports.billing).map(line => (
                        <li key={`${String(line.paymentId)}-${String(line.reason)}`} className={Number(line.kobo) < 0 ? 'text-destructive' : ''}>
                          {String(line.paymentReference)} · {String(line.reason).replace(/_/g, ' ')} · {formatKobo(Number(line.kobo || 0))} · corrects {String(line.originalInvoiceReference)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>

            {/* Experiment Results */}
            <section className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
              <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-primary" />
                  <h2 className="font-semibold">Recovery Experiment</h2>
                </div>
                <Button size="sm" onClick={() => openExperimentDialog('create')}>New experiment</Button>
              </div>
              <div className="p-6 flex-1 overflow-auto">
                <div className="space-y-4">
                  {(experiments?.items || []).map(experiment => (
                    <div key={experiment.id} className="border rounded-lg p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{experiment.name}</p>
                          <p className="text-xs text-muted-foreground">{experiment.status} · holdout {String(experiment.data?.holdoutShare ?? '')}</p>
                        </div>
                        {experiment.status === 'draft' && (
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" onClick={() => openExperimentDialog('edit', experiment)}>Edit</Button>
                            <Button size="sm" onClick={() => openExperimentDialog('preregister', experiment)}>Preregister</Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {scalarEntries(reports.experiment).map(([key, value]) => (
                    <div key={key} className="bg-secondary/30 p-3 rounded-lg flex justify-between items-center">
                      <span className="text-sm font-medium capitalize text-muted-foreground">{labelOf(key)}</span>
                      <span className={`font-mono text-sm font-bold ${String(value) === 'not_proven' ? 'text-warning-strong' : ''}`}>
                        {renderValue(key, value)}
                      </span>
                    </div>
                  ))}
                  {experimentRows(reports.experiment).map(row => (
                    <div key={String(row.experimentId)} className="border rounded-lg p-3 text-xs font-mono space-y-1">
                      <p className="text-muted-foreground truncate">Experiment {String(row.experimentId)} · {String(row.status)} · analysis {String(row.analysisDate || 'n/a')}</p>
                      <p>Enrolled: engine {String(row.engine?.enrolled ?? 0)} · holdout {String(row.holdout?.enrolled ?? 0)} · minimum per arm {String(row.minimumPerArm)}</p>
                      <p>Mature 30-day outcomes: engine {String(row.engine?.mature ?? 0)} · holdout {String(row.holdout?.mature ?? 0)}</p>
                      <p>Recovery by value (primary): engine {percent(row.engine?.recoveryByValue)} · holdout {percent(row.holdout?.recoveryByValue)} · difference {percent(row.differenceByValue)}</p>
                      <p>Recovery by count: engine {percent(row.engine?.recoveryByCount)} · holdout {percent(row.holdout?.recoveryByCount)} · difference {percent(row.differenceByCount)}</p>
                      <p>90% interval of the difference by value: {row.confidenceInterval90 ? `${percent(row.confidenceInterval90.low)} to ${percent(row.confidenceInterval90.high)}` : 'not computable below two mature outcomes per arm'}</p>
                      <p>Rule checks: {Object.entries(row.checks || {}).map(([name, ok]) => `${labelOf(name).toLowerCase()} ${ok ? '✓' : '✗'}`).join(' · ')}</p>
                      <p>Result: <span className={`font-bold ${row.result === 'proven' ? 'text-success' : 'text-warning-strong'}`}>{String(row.result)}</span></p>
                      <p className="font-sans text-muted-foreground">{String(row.reason || '')}</p>
                    </div>
                  ))}
                  {scalarEntries(reports.experiment).length === 0 && experimentRows(reports.experiment).length === 0 && (
                    <EmptyState title="No active experiment" className="px-0 py-4">The recovery test (RET-06) starts when an approved policy version carries an experiment arm; its uplift and 90% interval are reported here.</EmptyState>
                  )}
                </div>
              </div>
            </section>
          </div>

          {/* Daily Closes */}
          <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckSquare className="h-5 w-5 text-primary" />
                <h2 className="font-semibold">Daily Close Snapshots</h2>
              </div>
              {(() => {
                const schedule = scheduleView(reports.operational?.closeSchedule);
                if (!schedule) return null;
                return (
                  <p className={`text-xs ${schedule.missed ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                    {!schedule.enabled
                      ? 'Automatic close off: closes are triggered by hand.'
                      : schedule.missed
                        ? `Scheduled close at ${schedule.time} WAT missed: ${schedule.overdueMinutes} minutes past its time.`
                        : `Next scheduled close ${formatDate(schedule.nextAt)} (${schedule.time} WAT daily).`}
                  </p>
                );
              })()}
            </div>
            <div className="overflow-x-auto max-h-[400px]">
              <table className="w-full text-sm text-left">
                <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                  <tr>
                    <th className="px-6 py-4 font-medium">Date</th>
                    <th className="px-6 py-4 font-medium">Summary</th>
                    <th className="px-6 py-4 font-medium">Close report (REC-07)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {reports.closes.length === 0 ? (
                    <EmptyRow colSpan={3} title="No daily close yet">Trigger the daily close above, or wait for the scheduled one; every close leaves a snapshot here with its REC-07 report.</EmptyRow>
                  ) : (
                    reports.closes.map(close => (
                      <tr key={close.id} className="hover:bg-secondary/10">
                        <td className="px-6 py-4 font-mono text-xs">{formatDate(close.createdAt)}</td>
                        <td className="px-6 py-4 text-muted-foreground">{String(close.data?.summary || '')}</td>
                        <td className="px-6 py-4 font-mono text-xs">
                          {close.data?.report ? closeReportChips(close.data.report).map(([label, value]) => (
                            <span key={label} className="inline-block mr-3 mb-1 bg-secondary/30 px-1.5 py-0.5 rounded border border-border/50">
                              <span className="text-muted-foreground mr-1">{label}:</span>
                              <span className="font-medium">{value}</span>
                            </span>
                          )) : <span className="text-muted-foreground">Closed before the REC-07 report existed.</span>}
                          {close.data?.positionAlert === true && <span className="inline-block mr-3 mb-1 px-1.5 py-0.5 rounded border border-destructive/40 text-destructive">position rebuild alert</span>}
                          {(() => {
                            const trigger = triggerView(close.data?.schedule);
                            if (!trigger) return null;
                            return (
                              <span className={`inline-block mr-3 mb-1 px-1.5 py-0.5 rounded border ${trigger.late ? 'border-warning-strong/60 text-warning-strong' : 'border-border/50 text-muted-foreground'}`}>
                                {trigger.trigger}{trigger.late ? ` · ${trigger.delayMinutes} min late` : trigger.scheduledFor ? ' · on time' : ''}
                              </span>
                            );
                          })()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

        </div>
      )}
      <RecordDialog
        kind="invoices"
        record={null}
        isOpen={invoiceDialogOpen}
        onOpenChange={(open) => { if (!open) { setInvoiceDialogOpen(false); refetch(); } }}
        title="Issue the monthly invoice"
        actionMutation="issue_invoice"
        fields={[
          { name: 'period', label: 'Period (YYYY-MM); blank issues the previous month', type: 'text', isData: true },
        ]}
      />
      <RecordDialog
        kind="experiments"
        record={selectedExperiment}
        isOpen={experimentDialog !== null}
        onOpenChange={(open) => { if (!open) setExperimentDialog(null); }}
        title={experimentDialog === 'preregister' ? 'Preregister experiment' : experimentDialog === 'edit' ? 'Edit experiment draft' : 'Create experiment draft'}
        actionMutation={experimentDialog === 'preregister' ? 'preregister_experiment' : undefined}
        fields={experimentDialog === 'preregister' ? [] : [
          { name: 'name', label: 'Experiment name', type: 'text', required: true },
          { name: 'status', label: 'Status', type: 'select', options: [{ label: 'Draft', value: 'draft' }], required: true },
          { name: 'baselineRate', label: 'Baseline rate', type: 'number', isData: true, required: true },
          { name: 'holdoutShare', label: 'Holdout share (0.1–0.5)', type: 'number', isData: true, required: true },
          { name: 'minPerArm', label: 'Minimum per arm', type: 'number', isData: true, required: true },
          { name: 'analysisDate', label: 'Analysis date (YYYY-MM-DD)', type: 'text', isData: true, required: true },
          { name: 'enrolmentClose', label: 'Enrolment close (YYYY-MM-DD)', type: 'text', isData: true, required: true },
          { name: 'seed', label: 'Assignment seed', type: 'text', isData: true, required: true },
          { name: 'policyId', label: 'Approved policy', type: 'select', options: approvedPolicyOptions, isData: true, required: true }
        ]}
        defaultValues={{ status: 'draft' }}
      />
    </div>
  );
}
