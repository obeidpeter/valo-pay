import React, { useState } from 'react';
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

export default function ReconciliationPage() {
  const { merchantId } = useWorkspace();
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [reviewCorrect, setReviewCorrect] = useState(true);
  // Resolve identities from the current lender only; the full IDs remain available for tracing.
  const { data: customers } = useListRecords('customers', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('customers', { merchantId: merchantId! }) } });
  const { data: allPayments } = useListRecords('payments', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('payments', { merchantId: merchantId! }) } });
  const { data: dueItems } = useListRecords('due-items', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('due-items', { merchantId: merchantId! }) } });
  const customerById = new Map(customers?.items.map(record => [record.id, record]));
  const paymentById = new Map(allPayments?.items.map(record => [record.id, record]));
  const dueItemById = new Map(dueItems?.items.map(record => [record.id, record]));

  // Confirmed allocations for the precision audit (REC-09): automatic "certain" matches reviewed by Finance.
  const { data: confirmedAllocations, isLoading: isLoadingAudit, error: auditError } = useListRecords(
    'allocations',
    { merchantId: merchantId!, status: 'confirmed' },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('allocations', { merchantId: merchantId!, status: 'confirmed' }) } }
  );
  // REC-09: the month's seeded sample (at least 200, or all of them) comes from the reports; only sampled allocations are reviewed.
  const { data: reports } = useGetReports({ merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getGetReportsQueryKey({ merchantId: merchantId! }) } });
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
  const { data: proposals, isLoading: isLoadingProposals, error: proposalsError, refetch: refetchProposals } = useListRecords(
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
      onSuccess: () => {
        refetchProposals();
      }
    }
  });

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

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reconciliation</h1>
          <p className="text-muted-foreground mt-1">Reconciliation matches provider records to payments and instalments. Review proposed matches and assign unallocated payments here.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            onClick={() => runRecon.mutate({ data: { action: 'run_reconciliation' }, params: { merchantId } })}
            busy={runRecon.isPending}
            busyLabel="Reconciling payments…"
            className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <RefreshCw className="h-4 w-4" /> Run reconciliation
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Allocations requiring review */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col xl:col-span-2">
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
                  <th className="px-4 py-3 font-medium">Confidence</th>
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
        </div>

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
        <div className="bg-card border rounded-xl shadow-sm flex flex-col xl:col-span-2">
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
        defaultValues={actionKind === 'review_allocation' ? { correct: reviewCorrect } : {}}
        fields={
          actionKind === 'manual_allocate' ? [
            dueItems?.items.length ? { name: 'dueItemId', label: 'Instalment', type: 'select', isData: true, required: true, options: dueItems.items.map(item => ({ value: item.id, label: `${customerById.get(String(item.customerId))?.name || item.name} · ${item.reference} · ${formatKobo(item.amountKobo)}` })) } : { name: 'dueItemId', label: 'Instalment ID', type: 'text', isData: true, required: true },
            { name: 'amountKobo', label: 'Amount to allocate (kobo)', type: 'number', isData: true, required: true }
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
            { name: 'grossKobo', label: 'Amount before fees (kobo)', type: 'number', isData: true, required: true },
            { name: 'feeKobo', label: 'Fee (kobo)', type: 'number', isData: true, required: true },
            { name: 'netKobo', label: 'Amount after fees (kobo)', type: 'number', isData: true, required: true }
          ] :
          []
        }
      />
    </div>
  );
}
