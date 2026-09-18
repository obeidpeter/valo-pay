import React, { useEffect, useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow } from '@/components/empty-state';
import { LoadingRow } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, usePerformAction, getListRecordsQueryKey, useGetReports, getGetReportsQueryKey } from '@workspace/api-client-react';
import { formatKobo, formatDate, formatCount } from '@/lib/formatters';
import { CheckSquare, Info, ShieldAlert, CornerUpLeft, Plus, ClipboardCheck, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RecordDialog } from '@/components/record-dialog';
import { RecordLabel, StatusBadge, readableLabel } from '@/components/record-label';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from 'wouter';
import { nairaToKobo } from '@/lib/money-input';
import { saidBy } from '@/lib/notify';
import { useHashTarget } from '@/lib/use-hash-target';

const paymentAvailable = (record: any): number => Math.max(0, Number(record?.amountKobo || 0) - Number(record?.data?.allocatedKobo || 0));
const instalmentOutstanding = (record: any): number => Math.max(0, Number(record?.data?.outstandingKobo ?? record?.amountKobo ?? 0));

function MatchEvidence({ allocation, payment, instalment, decision }: { allocation: any; payment: any; instalment: any; decision: string }) {
  const available = paymentAvailable(payment), outstanding = instalmentOutstanding(instalment);
  return (
    <section aria-label="Match evidence" className="space-y-3 rounded-lg border bg-secondary/20 p-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border bg-card p-3">
          <h3 className="font-semibold">Recorded payment</h3>
          <p className="mt-1 break-words font-mono text-xs">{payment?.reference || 'Payment details unavailable'}</p>
          <p className="mt-2">Received: <strong>{payment ? formatKobo(payment.amountKobo) : 'Not available'}</strong></p>
          <p className="text-xs text-muted-foreground">{payment ? formatDate(String(payment.data?.observedAt || payment.createdAt)) : 'Reload to check this payment.'}</p>
          <p className="mt-2">Available to allocate: {payment ? formatKobo(available) : 'Not available'}</p>
        </div>
        <div className="rounded-md border bg-card p-3">
          <h3 className="font-semibold">Instalment</h3>
          <p className="mt-1 break-words font-mono text-xs">{instalment?.reference || 'Instalment details unavailable'}</p>
          <p className="mt-2">Outstanding: <strong>{instalment ? formatKobo(outstanding) : 'Not available'}</strong></p>
          <p className="text-xs text-muted-foreground">Due: {formatDate(String(instalment?.data?.dueDate || ''))}</p>
        </div>
      </div>
      <p><strong>Why this match was suggested:</strong> {String(allocation.data?.explanation || 'No explanation was recorded. Review the source records before deciding.')}</p>
      <p className="text-xs text-muted-foreground">Rule {String(allocation.data?.rule || 'not recorded')} · {readableLabel(allocation.data?.confidence || 'not recorded')}</p>
      {decision === 'confirm_allocation' ? <>
        <p>Confirming applies <strong>{formatKobo(allocation.amountKobo)}</strong> to this instalment.</p>
        {payment && instalment && allocation.amountKobo <= available && allocation.amountKobo <= outstanding && <p className="text-xs text-muted-foreground">After confirmation: {formatKobo(available - allocation.amountKobo)} unapplied payment; {formatKobo(outstanding - allocation.amountKobo)} still due.</p>}
      </> : <p>Rejecting removes this proposed match. The payment remains available for Finance to review and allocate.</p>}
    </section>
  );
}

export default function ReconciliationPage() {
  const { merchantId } = useWorkspace();
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [reviewCorrect, setReviewCorrect] = useState(true);
  const [runResult, setRunResult] = useState<Record<string, any> | null>(null);
  const queryClient = useQueryClient();
  const search = useSearch();
  const requestedView = new URLSearchParams(search).get('view');
  const view = requestedView === 'review' || requestedView === 'duplicates' ? requestedView : 'all';
  // Resolve identities from the current lender only; the full IDs remain available for tracing.
  const { data: customers } = useListRecords('customers', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('customers', { merchantId: merchantId! }) } });
  const { data: allPayments, isLoading: isLoadingAllPayments, error: allPaymentsError } = useListRecords('payments', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('payments', { merchantId: merchantId! }) } });
  const { data: dueItems } = useListRecords('due-items', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('due-items', { merchantId: merchantId! }) } });
  const customerById = new Map(customers?.items.map(record => [record.id, record]));
  const paymentById = new Map(allPayments?.items.map(record => [record.id, record]));
  const dueItemById = new Map(dueItems?.items.map(record => [record.id, record]));
  const duplicates = (allPayments?.items || []).filter(payment => payment.status === 'possible_duplicate');

  // Confirmed allocations for the precision audit (REC-09): automatic "certain" matches reviewed by Finance.
  const { data: confirmedAllocations, isLoading: isLoadingAudit, error: auditError } = useListRecords(
    'allocations',
    { merchantId: merchantId!, status: 'confirmed' },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('allocations', { merchantId: merchantId!, status: 'confirmed' }) } }
  );
  // REC-09: the month's seeded sample (at least 200, or all of them) comes from the reports; only sampled allocations are reviewed.
  const { data: reports } = useGetReports({ merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getGetReportsQueryKey({ merchantId: merchantId! }) } });
  useHashTarget('precision-audit', !!merchantId && view === 'all' && !!reports && !!confirmedAllocations && !isLoadingAudit && !auditError);
  const precision = reports?.operational?.precisionAudit as Record<string, any> | undefined;
  const sampledIds = new Set<string>(Array.isArray(precision?.sampledAllocationIds) ? (precision!.sampledAllocationIds as string[]) : []);
  const auditSample = (confirmedAllocations?.items || []).filter(item => item.data?.automatic === true && item.data?.confidence === 'certain' && (sampledIds.size === 0 || sampledIds.has(item.id)));
  const reviewAllocation = (allocation: any, correct: boolean) => {
    setReviewCorrect(correct);
    setSelectedRecord(allocation);
    setActionKind('review_allocation');
    setIsDialogOpen(true);
  };
  
  // Fetch unallocated payments
  const { data: payments, isLoading: isLoadingPayments, error: paymentsError } = useListRecords(
    'payments',
    { merchantId: merchantId!, status: 'unallocated' },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('payments', { merchantId: merchantId!, status: 'unallocated' }) } }
  );

  // Fetch proposals (allocations that need confirmation)
  const { data: proposals, isLoading: isLoadingProposals, error: proposalsError } = useListRecords(
    'allocations',
    { merchantId: merchantId!, status: 'proposed' },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('allocations', { merchantId: merchantId!, status: 'proposed' }) } }
  );

  // Fetch unresolved observations
  const { data: observations, isLoading: isLoadingObs, error: observationsError } = useListRecords(
    'observations',
    { merchantId: merchantId!, status: 'unresolved' },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('observations', { merchantId: merchantId!, status: 'unresolved' }) } }
  );

  const { data: batches, isLoading: isLoadingBatches, error: batchesError } = useListRecords(
    'settlement-batches',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('settlement-batches', { merchantId: merchantId! }) } }
  );

  const runRecon = usePerformAction({
    mutation: {
      onSuccess: async (response) => {
        setRunResult(response);
        // Reconciliation changes payments, evidence, allocations, batches, exceptions and summary counts together.
        await queryClient.invalidateQueries();
      }
    }
  });
  useEffect(() => { setRunResult(null); runRecon.reset(); setIsDialogOpen(false); }, [merchantId]);

  const handleAction = (record: any, action: string) => {
    setSelectedRecord(record);
    setActionKind(action);
    setIsDialogOpen(true);
  };

  const handleCreateBatch = () => {
    setSelectedRecord(null);
    setActionKind('create_batch');
    setIsDialogOpen(true);
  };

  if (!merchantId) return null;
  const isProposalDecision = actionKind === 'confirm_allocation' || actionKind === 'reject_allocation';
  const selectedPayment = isProposalDecision ? paymentById.get(String(selectedRecord?.data?.paymentId)) : selectedRecord;
  const selectedInstalment = isProposalDecision ? dueItemById.get(String(selectedRecord?.data?.dueItemId)) : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reconciliation</h1>
          <p className="text-muted-foreground mt-1">Reconciliation matches provider records to payments and instalments. Review proposed matches and assign unallocated payments here.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            onClick={() => { setRunResult(null); runRecon.mutate({ data: { action: 'run_reconciliation' }, params: { merchantId } }); }}
            busy={runRecon.isPending}
            busyLabel="Reconciling payments…"
            className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <RefreshCw className="h-4 w-4" /> Run reconciliation
          </Button>
        </div>
      </header>

      {runRecon.error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
        <p className="font-semibold text-destructive">Reconciliation could not be completed</p>
        <p className="mt-1">{saidBy(runRecon.error, 'The service could not finish this check.')} Run reconciliation again to retry.</p>
      </div>}
      {runResult && <section role="status" aria-label="Reconciliation result" className="rounded-lg border border-success/30 bg-success/5 p-4 text-sm">
        <p className="font-semibold">Reconciliation complete</p>
        <p className="mt-1 text-muted-foreground">Payment evidence has been checked. No money was moved.</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Evidence resolved', runResult.data?.observationsResolved], ['Awaiting review', runResult.data?.proposed],
            ['Unallocated payments', runResult.data?.unallocated], ['Possible duplicates', runResult.data?.possibleDuplicates],
          ].map(([label, count]) => <div key={String(label)}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{Number(count || 0)}</dd></div>)}
        </dl>
      </section>}

      <nav aria-label="Reconciliation views" className="flex flex-wrap gap-2 print:hidden">
        {[
          { key: 'all', label: 'All reconciliation', href: '/reconciliation' },
          { key: 'review', label: 'Matches to review', href: '/reconciliation?view=review' },
          { key: 'duplicates', label: 'Possible duplicates', href: '/reconciliation?view=duplicates' },
        ].map(item => <Button key={item.key} asChild size="sm" variant={view === item.key ? 'default' : 'outline'}><Link href={item.href} aria-current={view === item.key ? 'page' : undefined}>{item.label}</Link></Button>)}
      </nav>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Allocations requiring review */}
        {view !== 'duplicates' && <div className="bg-card border rounded-xl shadow-sm flex flex-col xl:col-span-2">
          <div className="p-5 border-b flex flex-wrap items-center gap-2">
            <CheckSquare className="h-5 w-5 text-warning-strong" />
            <h2 className="font-semibold">Proposed matches</h2>
            <span className="ml-auto bg-warning text-warning-foreground text-xs font-bold px-2 py-1 rounded-full">
              {proposals?.items.length || 0} pending
            </span>
          </div>
          
          <ScrollFrame label="Proposed matches" className="p-0 overflow-x-auto">
            <table className="min-w-[780px] w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Payment</th>
                  <th className="px-4 py-3 font-medium">Instalment</th>
                  <th className="px-4 py-3 font-medium text-right">Amount</th>
                  <th className="px-4 py-3 font-medium">Confidence and reason</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingProposals ? (
                  <LoadingRow colSpan={6} what="proposed matches" />
                ) : proposalsError ? (
                  <tr><td colSpan={6} className="p-5"><p role="alert" className="text-sm text-destructive">Proposed matches could not be loaded. Reload the page to try again.</p></td></tr>
                ) : !proposals || proposals.items.length === 0 ? (
                  <EmptyRow colSpan={6} title="No proposed matches to review">Possible payment matches appear here when they need Finance to confirm them. Run reconciliation to check for new matches.</EmptyRow>
                ) : (
                  proposals.items.map(prop => (
                    <tr key={prop.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-4"><RecordLabel record={customerById.get(String(prop.customerId))} id={prop.customerId} customer /></td>
                      <td className="px-4 py-4 text-xs"><RecordLabel record={paymentById.get(String(prop.data?.paymentId))} id={prop.data?.paymentId} /></td>
                      <td className="px-4 py-4 text-xs"><RecordLabel record={dueItemById.get(String(prop.data?.dueItemId))} id={prop.data?.dueItemId} /></td>
                      <td className="px-4 py-3 text-right font-mono font-medium">{formatKobo(prop.amountKobo)}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-info text-info-foreground border border-info-border">
                          {readableLabel(prop.data?.confidence || 'medium')}
                        </span>
                        <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">{String(prop.data?.explanation || 'Review the payment and instalment before deciding.')}</p>
                      </td>
                      <td className="px-4 py-3 text-right"><div className="flex justify-end gap-2">
                        <Button 
                          size="sm" variant="outline" 
                          className="text-xs"
                          onClick={() => handleAction(prop, 'reject_allocation')}
                        >Reject</Button>
                        <Button 
                          size="sm" 
                          className="text-xs bg-success hover:bg-success/90 text-success-foreground"
                          onClick={() => handleAction(prop, 'confirm_allocation')}
                        >Confirm</Button>
                      </div></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollFrame>
        </div>}

        {view !== 'review' && <section aria-label="Possible duplicate payments" className="bg-card border rounded-xl shadow-sm overflow-hidden xl:col-span-2">
          <div className="border-b p-4"><h2 className="font-semibold">Possible duplicate payments</h2><p className="mt-1 text-xs text-muted-foreground">These payments are held for Finance review and are never allocated automatically.</p></div>
          <ScrollFrame label="Possible duplicate payments" className="overflow-x-auto">
            <table className="min-w-[650px] w-full text-left text-sm"><thead className="border-b bg-secondary/30 text-muted-foreground"><tr><th className="p-4 font-medium">Payment</th><th className="p-4 font-medium">Customer</th><th className="p-4 font-medium">Reason for review</th><th className="p-4 text-right font-medium">Amount</th><th className="p-4 text-right font-medium">Next step</th></tr></thead>
              <tbody className="divide-y">{isLoadingAllPayments ? <LoadingRow colSpan={5} what="possible duplicate payments" /> : allPaymentsError ? <tr><td colSpan={5} className="p-4"><p role="alert" className="text-destructive">Possible duplicate payments could not be loaded. Reload the page to try again.</p></td></tr> : duplicates.length === 0 ? <EmptyRow colSpan={5} title="No possible duplicates">Payments needing a duplicate check will appear here.</EmptyRow> : duplicates.map(payment => <tr key={payment.id}>
                <td className="p-4"><RecordLabel record={payment} id={payment.id} /></td><td className="p-4"><RecordLabel record={customerById.get(String(payment.customerId))} id={payment.customerId} customer /></td>
                <td className="p-4 text-xs text-muted-foreground">{String(payment.data?.explanation || 'Check the provider references and recorded evidence before deciding whether this is a separate payment.')}</td>
                <td className="p-4 text-right font-mono">{formatKobo(payment.amountKobo)}</td><td className="p-4 text-right"><Link className="inline-flex min-h-9 items-center text-xs font-medium underline underline-offset-4" href="/exceptions?type=suspected_duplicate">Review exceptions</Link></td>
              </tr>)}</tbody>
            </table>
          </ScrollFrame>
        </section>}

        {view === 'all' && <>

        {/* Unallocated Payments */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col">
          <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
            <Info className="h-5 w-5 text-info-strong" />
            <h2 className="font-semibold">Unallocated payments</h2>
            <span className="ml-auto bg-info text-info-foreground text-xs font-bold px-2 py-1 rounded-full">
              {formatCount(payments?.items.length || 0, 'item')}
            </span>
          </div>
          <ScrollFrame label="Unallocated payments" className="p-0 overflow-auto max-h-[400px]">
            <table className="min-w-[460px] w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Reference</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                  <th className="px-4 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingPayments ? (
                  <LoadingRow colSpan={3} what="unallocated payments" />
                ) : paymentsError ? (
                  <tr><td colSpan={3} className="p-5"><p role="alert" className="text-sm text-destructive">Unallocated payments could not be loaded. Reload the page to try again.</p></td></tr>
                ) : !payments || payments.items.length === 0 ? (
                  <EmptyRow colSpan={3} title="No unallocated payments">Unallocated payments have not yet been assigned to an instalment. There are none waiting in this list.</EmptyRow>
                ) : (
                  payments.items.map(pay => (
                    <tr key={pay.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-2 font-mono text-xs">
                        {pay.reference}
                        <div className="text-muted-foreground">{formatDate(pay.createdAt)}</div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono font-medium">{formatKobo(pay.amountKobo)}</td>
                      <td className="px-4 py-2 text-right space-x-2 flex justify-end items-center">
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(pay, 'manual_allocate')}>Allocate</Button>
                        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => handleAction(pay, 'record_refund')} title="Record external refund" aria-label={`Record external refund for ${pay.reference}`}>
                          <CornerUpLeft className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollFrame>
        </div>

        {/* Unresolved Observations */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col">
          <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            <h2 className="font-semibold">Unresolved payment evidence</h2>
            <span className="ml-auto bg-destructive/10 text-destructive text-xs font-bold px-2 py-1 rounded-full">
              {formatCount(observations?.items.length || 0, 'item')}
            </span>
          </div>
          <ScrollFrame label="Unresolved payment evidence" className="p-0 overflow-auto max-h-[400px]">
             <table className="min-w-[440px] w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Reference</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingObs ? (
                  <LoadingRow colSpan={3} what="unresolved payment evidence" />
                ) : observationsError ? (
                  <tr><td colSpan={3} className="p-5"><p role="alert" className="text-sm text-destructive">Payment evidence could not be loaded. Reload the page to try again.</p></td></tr>
                ) : !observations || observations.items.length === 0 ? (
                  <EmptyRow colSpan={3} title="No unresolved payment evidence">Provider records and bank statement entries appear here when they cannot be linked to a payment or settlement batch.</EmptyRow>
                ) : (
                  observations.items.map(obs => (
                    <tr key={obs.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-2">
                        <span className="px-1.5 py-0.5 bg-secondary text-xs rounded border">{readableLabel(obs.data?.source)}</span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs truncate max-w-[120px]" title={obs.reference}>{obs.reference}</td>
                      <td className="px-4 py-2 text-right font-mono font-medium">{formatKobo(obs.amountKobo)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollFrame>
        </div>
        
        {/* Precision audit */}
        <div id="precision-audit" tabIndex={-1} role="region" aria-label="Match accuracy review" className="scroll-mt-6 bg-card border rounded-xl shadow-sm flex flex-col xl:col-span-2">
          <div className="p-5 border-b flex flex-wrap items-start gap-2">
            <ClipboardCheck className="h-5 w-5 text-primary" />
            <h2 className="font-semibold">Match accuracy review</h2>
            <p className="w-full text-xs leading-relaxed text-muted-foreground">Finance checks a sample of automatic matches from the last completed month. Marking a match incorrect stops counting that allocation and reopens the payment and instalment.</p>
            <p className="text-xs font-medium">{auditSample.filter(item => typeof item.data?.reviewed === 'boolean').length} of {auditSample.length} sampled matches reviewed{precision?.falseMatchRate !== null && precision?.falseMatchRate !== undefined ? ` · incorrect match rate ${(Number(precision.falseMatchRate) * 100).toFixed(1)}% (95% confidence interval: ${(Number(precision.interval?.low) * 100).toFixed(1)}% to ${(Number(precision.interval?.high) * 100).toFixed(1)}%)` : ''}.</p>
          </div>
          <ScrollFrame label="Match accuracy review" className="p-0 overflow-x-auto max-h-[400px]">
            <table className="min-w-[780px] w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Rule</th>
                  <th className="px-4 py-2 font-medium">Payment</th>
                  <th className="px-4 py-2 font-medium">Instalment</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                  <th className="px-4 py-2 font-medium">Explanation</th>
                  <th className="px-4 py-2 font-medium">Review</th>
                  <th className="px-4 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingAudit ? (
                  <LoadingRow colSpan={7} what="the match review sample" />
                ) : auditError ? (
                  <tr><td colSpan={7} className="p-5"><p role="alert" className="text-sm text-destructive">The match review sample could not be loaded. Reload the page to try again.</p></td></tr>
                ) : auditSample.length === 0 ? (
                  <EmptyRow colSpan={7} title="No automatic matches to review yet">A daily close selects a sample from the last completed month's automatic matches rated certain. Finance can then check whether those matches are correct.</EmptyRow>
                ) : (
                  auditSample.map(allocation => (
                    <tr key={allocation.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-2 font-mono text-xs">{String(allocation.data?.rule || '')}</td>
                      <td className="px-4 py-3 text-xs"><RecordLabel record={paymentById.get(String(allocation.data?.paymentId))} id={allocation.data?.paymentId} /></td>
                      <td className="px-4 py-3 text-xs"><RecordLabel record={dueItemById.get(String(allocation.data?.dueItemId))} id={allocation.data?.dueItemId} /></td>
                      <td className="px-4 py-2 text-right font-mono font-medium">{formatKobo(allocation.amountKobo)}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground max-w-[280px]">{String(allocation.data?.explanation || '')}</td>
                      <td className="px-4 py-2 text-xs">
                        {allocation.data?.reviewed === true ? <span className="text-success font-medium">Correct</span> : allocation.data?.reviewed === false ? <span className="text-destructive font-medium">Incorrect</span> : <span className="text-muted-foreground">Not reviewed</span>}
                      </td>
                      <td className="px-4 py-2 text-right space-x-2">
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => reviewAllocation(allocation, true)}>Mark correct</Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs text-destructive" onClick={() => reviewAllocation(allocation, false)}>Mark incorrect</Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollFrame>
        </div>

        {/* Settlement Batches */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col xl:col-span-2">
          <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
            <h2 className="font-semibold flex items-center gap-2"><Info className="h-5 w-5 text-primary" /> Settlement batches</h2>
            <Button size="sm" onClick={handleCreateBatch}><Plus className="h-4 w-4 mr-2" /> Add batch</Button>
          </div>
          <ScrollFrame label="Settlement batches" className="p-0 overflow-x-auto max-h-[400px]">
             <table className="min-w-[650px] w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Batch reference</th>
                  <th className="px-4 py-2 font-medium text-right">Before fees</th>
                  <th className="px-4 py-2 font-medium text-right">Fee</th>
                  <th className="px-4 py-2 font-medium text-right">After fees</th>
                  <th className="px-4 py-2 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingBatches ? (
                  <LoadingRow colSpan={6} what="settlement batches" />
                ) : batchesError ? (
                  <tr><td colSpan={6} className="p-5"><p role="alert" className="text-sm text-destructive">Settlement batches could not be loaded. Reload the page to try again.</p></td></tr>
                ) : !batches || batches.items.length === 0 ? (
                  <EmptyRow colSpan={6} title="No settlement batches">A batch groups payments in one provider settlement report. Add a synthetic batch or import a settlement report to see it here.</EmptyRow>
                ) : (
                  batches.items.map(b => (
                    <tr key={b.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-2 font-medium">{String(b.data?.provider || '-')}</td>
                      <td className="px-4 py-2"><button type="button" className="min-h-9 font-mono text-xs underline underline-offset-4 hover:text-primary" onClick={() => handleAction(b, 'edit_batch')} aria-label={`Edit settlement batch ${String(b.data?.batchReference || b.reference)}`}>{String(b.data?.batchReference || b.reference)}</button><span className="hidden print:inline font-mono text-xs">{String(b.data?.batchReference || b.reference)}</span></td>
                      <td className="px-4 py-2 text-right font-mono text-xs">{formatKobo(Number(b.data?.grossKobo || 0))}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-destructive">{formatKobo(Number(b.data?.feeKobo || 0))}</td>
                      <td className="px-4 py-2 text-right font-mono font-medium">{formatKobo(Number(b.data?.netKobo || 0))}</td>
                      <td className="px-4 py-2 text-right"><StatusBadge status={b.status} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollFrame>
        </div>

        </>}
      </div>

      <RecordDialog
        kind={
          actionKind === 'confirm_allocation' || actionKind === 'reject_allocation' || actionKind === 'review_allocation' ? 'allocations' :
          actionKind === 'create_batch' || actionKind === 'edit_batch' ? 'settlement-batches' :
          'payments'
        }
        record={selectedRecord}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={
          actionKind === 'confirm_allocation' ? 'Confirm payment allocation' :
          actionKind === 'reject_allocation' ? 'Reject proposed match' :
          actionKind === 'manual_allocate' ? 'Allocate payment' :
          actionKind === 'record_refund' ? 'Record external refund' :
          actionKind === 'create_batch' ? 'Add settlement batch' :
          actionKind === 'edit_batch' ? 'Edit settlement batch' :
          'Review payment allocation'
        }
        actionMutation={actionKind === 'create_batch' || actionKind === 'edit_batch' ? undefined : actionKind}
        actionRecordId={isProposalDecision ? selectedRecord?.data?.paymentId : undefined}
        defaultValues={actionKind === 'review_allocation' ? { correct: reviewCorrect } : actionKind === 'manual_allocate' ? { amountKobo: paymentAvailable(selectedRecord) } : {}}
        context={isProposalDecision && selectedRecord ? <MatchEvidence allocation={selectedRecord} payment={selectedPayment} instalment={selectedInstalment} decision={actionKind} /> : actionKind === 'manual_allocate' ? values => {
          const due = dueItemById.get(String(values.dueItemId));
          const available = paymentAvailable(selectedRecord), outstanding = instalmentOutstanding(due);
          let amount: number | null = null;
          try { amount = nairaToKobo(String(values.amountKobo ?? '')); } catch { /* The field reports incomplete or invalid input on submit. */ }
          return <section aria-label="Allocation preview" className="space-y-2 rounded-lg border bg-secondary/20 p-3 text-sm">
            <p className="font-semibold">Payment {selectedRecord?.reference}</p>
            <p>Available to allocate: <strong>{formatKobo(available)}</strong></p>
            <p>Selected instalment outstanding: <strong>{due ? formatKobo(outstanding) : 'Choose an instalment'}</strong></p>
            {due && amount !== null && amount > 0 && amount <= available && amount <= outstanding && <p className="text-xs text-muted-foreground">After allocation: {formatKobo(available - amount)} unapplied payment; {formatKobo(outstanding - amount)} still due.</p>}
          </section>;
        } : undefined}
        validate={(values): Record<string, string> => {
          if (isProposalDecision && (!selectedPayment || !selectedInstalment)) return { reason: 'Payment or instalment details are unavailable. Close this dialog and reload before deciding.' };
          if (actionKind !== 'manual_allocate') return {};
          const due = dueItemById.get(String(values.dueItemId));
          if (!due) return { dueItemId: 'Choose an instalment from the current lender.' };
          const amount = nairaToKobo(String(values.amountKobo));
          if (amount <= 0) return { amountKobo: 'Enter an amount greater than ₦0.00.' };
          if (amount > paymentAvailable(selectedRecord)) return { amountKobo: `Enter ${formatKobo(paymentAvailable(selectedRecord))} or less. This is the payment available to allocate.` };
          if (amount > instalmentOutstanding(due)) return { amountKobo: `Enter ${formatKobo(instalmentOutstanding(due))} or less. This is the instalment still due.` };
          return {};
        }}
        fields={
          actionKind === 'manual_allocate' ? [
            { name: 'dueItemId', label: 'Instalment', type: 'select', isData: true, required: true, options: (dueItems?.items || []).filter(item => instalmentOutstanding(item) > 0 && !['paid', 'closed', 'cancelled'].includes(item.status)).map(item => ({ value: item.id, label: `${customerById.get(String(item.customerId))?.name || item.name} · ${item.reference} · ${formatKobo(instalmentOutstanding(item))} due` })) },
            { name: 'amountKobo', label: 'Amount to allocate (₦)', type: 'number', isData: true, required: true }
          ] : 
          actionKind === 'record_refund' ? [
            { name: 'reference', label: 'External refund reference', type: 'text', isData: true, required: true }
          ] :
          actionKind === 'review_allocation' ? [
            { name: 'correct', label: 'This match is correct. Untick to mark it incorrect and reopen the payment and instalment.', type: 'checkbox', isData: true }
          ] :
          actionKind === 'create_batch' || actionKind === 'edit_batch' ? [
            { name: 'name', label: 'Name', type: 'text', required: true },
            { name: 'reference', label: 'Batch reference (reconciliation sets the status)', type: 'text', required: true },
            { name: 'provider', label: 'Provider', type: 'text', isData: true, required: true },
            { name: 'grossKobo', label: 'Amount before fees (₦)', type: 'number', isData: true, required: true },
            { name: 'feeKobo', label: 'Fee (₦)', type: 'number', isData: true, required: true },
            { name: 'netKobo', label: 'Amount after fees (₦)', type: 'number', isData: true, required: true }
          ] :
          []
        }
      />
    </div>
  );
}
