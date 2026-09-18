import React, { useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow } from '@/components/empty-state';
import { LoadingRow } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, usePerformAction, getListRecordsQueryKey, useGetReports, getGetReportsQueryKey } from '@workspace/api-client-react';
import { formatKobo, formatDate, formatCount } from '@/lib/formatters';
import { CheckSquare, Info, ShieldAlert, CornerUpLeft, Plus, ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RecordDialog } from '@/components/record-dialog';
import { recordStatuses } from '@workspace/valopay-schema';

export default function ReconciliationPage() {
  const { merchantId } = useWorkspace();
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [reviewCorrect, setReviewCorrect] = useState(true);

  // Confirmed allocations for the precision audit (REC-09): automatic "certain" matches reviewed by Finance.
  const { data: confirmedAllocations, isLoading: isLoadingAudit } = useListRecords(
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
  const { data: payments, isLoading: isLoadingPayments } = useListRecords(
    'payments',
    { merchantId: merchantId!, status: 'unallocated' },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('payments', { merchantId: merchantId!, status: 'unallocated' }) } }
  );

  // Fetch proposals (allocations that need confirmation)
  const { data: proposals, isLoading: isLoadingProposals, refetch: refetchProposals } = useListRecords(
    'allocations',
    { merchantId: merchantId!, status: 'proposed' },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('allocations', { merchantId: merchantId!, status: 'proposed' }) } }
  );

  // Fetch unresolved observations
  const { data: observations, isLoading: isLoadingObs } = useListRecords(
    'observations',
    { merchantId: merchantId!, status: 'unresolved' },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('observations', { merchantId: merchantId!, status: 'unresolved' }) } }
  );

  const { data: batches, isLoading: isLoadingBatches } = useListRecords(
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
          <p className="text-muted-foreground mt-1">Match external observations to payments and allocations.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            onClick={() => runRecon.mutate({ data: { action: 'run_reconciliation' }, params: { merchantId } })}
            busy={runRecon.isPending}
            busyLabel="Running the engine…"
            className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            Run Engine
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Allocations requiring review */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col xl:col-span-2">
          <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
            <CheckSquare className="h-5 w-5 text-warning-strong" />
            <h2 className="font-semibold">Proposals Awaiting Confirmation</h2>
            <span className="ml-auto bg-warning text-warning-foreground text-xs font-bold px-2 py-1 rounded-full">
              {proposals?.items.length || 0} pending
            </span>
          </div>
          
          <ScrollFrame label="Proposals awaiting confirmation" className="p-0 overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Customer ID</th>
                  <th className="px-4 py-3 font-medium">Payment ID</th>
                  <th className="px-4 py-3 font-medium">Due Item ID</th>
                  <th className="px-4 py-3 font-medium text-right">Amount</th>
                  <th className="px-4 py-3 font-medium">Confidence</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingProposals ? (
                  <LoadingRow colSpan={6} what="proposals" />
                ) : !proposals || proposals.items.length === 0 ? (
                  <EmptyRow colSpan={6} title="No proposals waiting for review">The engine proposes a match when a payment fits an instalment by amount, reference or timing but not with certainty. Run the engine to look for new ones.</EmptyRow>
                ) : (
                  proposals.items.map(prop => (
                    <tr key={prop.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-3 font-mono text-xs">{prop.customerId}</td>
                      <td className="px-4 py-3 font-mono text-xs">{String(prop.data?.paymentId || '')}</td>
                      <td className="px-4 py-3 font-mono text-xs">{String(prop.data?.dueItemId || '')}</td>
                      <td className="px-4 py-3 text-right font-mono font-medium">{formatKobo(prop.amountKobo)}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-info text-info-foreground border border-info-border">
                          {String(prop.data?.confidence || 'medium')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right space-x-2">
                        <Button 
                          size="sm" variant="outline" 
                          className="h-7 text-xs"
                          onClick={() => handleAction(prop, 'reject_allocation')}
                        >Reject</Button>
                        <Button 
                          size="sm" 
                          className="h-7 text-xs bg-success hover:bg-success/90 text-success-foreground"
                          onClick={() => handleAction(prop, 'confirm_allocation')}
                        >Confirm</Button>
                      </td>
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
            <h2 className="font-semibold">Unallocated Payments</h2>
            <span className="ml-auto bg-info text-info-foreground text-xs font-bold px-2 py-1 rounded-full">
              {formatCount(payments?.items.length || 0, 'item')}
            </span>
          </div>
          <ScrollFrame label="Unallocated payments" className="p-0 overflow-auto max-h-[400px]">
            <table className="w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Ref</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                  <th className="px-4 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingPayments ? (
                  <LoadingRow colSpan={3} what="unallocated payments" />
                ) : !payments || payments.items.length === 0 ? (
                  <EmptyRow colSpan={3} title="No unallocated payments">Every payment received is matched to an instalment. One that cannot be matched appears here with an owner and a deadline.</EmptyRow>
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
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(pay, 'record_refund')} title="Record Refund">
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
            <h2 className="font-semibold">Unresolved Observations</h2>
            <span className="ml-auto bg-destructive/10 text-destructive text-xs font-bold px-2 py-1 rounded-full">
              {formatCount(observations?.items.length || 0, 'item')}
            </span>
          </div>
          <ScrollFrame label="Unresolved observations" className="p-0 overflow-auto max-h-[400px]">
             <table className="w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Ref</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingObs ? (
                  <LoadingRow colSpan={3} what="unresolved observations" />
                ) : !observations || observations.items.length === 0 ? (
                  <EmptyRow colSpan={3} title="No unresolved observations">Every webhook, settlement line and statement line has been resolved to a payment. Anything the engine cannot resolve waits here as evidence.</EmptyRow>
                ) : (
                  observations.items.map(obs => (
                    <tr key={obs.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-2">
                        <span className="px-1.5 py-0.5 bg-secondary text-xs rounded border">{String(obs.data?.source || 'unknown')}</span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs truncate max-w-[120px]">{obs.reference}</td>
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
          <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-primary" />
            <h2 className="font-semibold">Precision Audit</h2>
            <span className="ml-auto text-xs text-muted-foreground">Seeded sample of the completed month's automatic certain matches reviewed by Finance (REC-09); a wrong match is superseded and the books reopen. {auditSample.filter(item => typeof item.data?.reviewed === 'boolean').length} of {auditSample.length} sampled reviewed{precision?.falseMatchRate !== null && precision?.falseMatchRate !== undefined ? ` · false-match rate ${(Number(precision.falseMatchRate) * 100).toFixed(1)}% (95% interval ${(Number(precision.interval?.low) * 100).toFixed(1)}% to ${(Number(precision.interval?.high) * 100).toFixed(1)}%)` : ''}.</span>
          </div>
          <ScrollFrame label="Precision audit" className="p-0 overflow-x-auto max-h-[400px]">
            <table className="w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Rule</th>
                  <th className="px-4 py-2 font-medium">Payment</th>
                  <th className="px-4 py-2 font-medium">Due item</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                  <th className="px-4 py-2 font-medium">Explanation</th>
                  <th className="px-4 py-2 font-medium">Review</th>
                  <th className="px-4 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingAudit ? (
                  <LoadingRow colSpan={7} what="the precision sample" />
                ) : auditSample.length === 0 ? (
                  <EmptyRow colSpan={7} title="No automatic certain matches to review yet">The sample is drawn from the completed month's automatic certain allocations at the daily close, for Finance to confirm or reject (REC-09).</EmptyRow>
                ) : (
                  auditSample.map(allocation => (
                    <tr key={allocation.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-2 font-mono text-xs">{String(allocation.data?.rule || '')}</td>
                      <td className="px-4 py-2 font-mono text-xs">{String(allocation.data?.paymentId || '')}</td>
                      <td className="px-4 py-2 font-mono text-xs">{String(allocation.data?.dueItemId || '')}</td>
                      <td className="px-4 py-2 text-right font-mono font-medium">{formatKobo(allocation.amountKobo)}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground max-w-[280px]">{String(allocation.data?.explanation || '')}</td>
                      <td className="px-4 py-2 text-xs">
                        {allocation.data?.reviewed === true ? <span className="text-success font-medium">Correct</span> : allocation.data?.reviewed === false ? <span className="text-destructive font-medium">Wrong</span> : <span className="text-muted-foreground">Unreviewed</span>}
                      </td>
                      <td className="px-4 py-2 text-right space-x-2">
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => reviewAllocation(allocation, true)}>Correct</Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs text-destructive" onClick={() => reviewAllocation(allocation, false)}>Wrong</Button>
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
            <h2 className="font-semibold flex items-center gap-2"><Info className="h-5 w-5 text-primary" /> Settlement Batches</h2>
            <Button size="sm" onClick={handleCreateBatch}><Plus className="h-4 w-4 mr-2" /> Add Batch</Button>
          </div>
          <ScrollFrame label="Settlement batches" className="p-0 overflow-x-auto max-h-[400px]">
             <table className="w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Batch Ref</th>
                  <th className="px-4 py-2 font-medium text-right">Gross</th>
                  <th className="px-4 py-2 font-medium text-right">Fee</th>
                  <th className="px-4 py-2 font-medium text-right">Net</th>
                  <th className="px-4 py-2 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingBatches ? (
                  <LoadingRow colSpan={6} what="settlement batches" />
                ) : !batches || batches.items.length === 0 ? (
                  <EmptyRow colSpan={6} title="No settlement batches">A batch appears when a settlement report arrives from the aggregator or is imported as a CSV.</EmptyRow>
                ) : (
                  batches.items.map(b => (
                    <tr key={b.id} className="hover:bg-secondary/10 cursor-pointer" onClick={() => handleAction(b, 'edit_batch')}>
                      <td className="px-4 py-2 font-medium">{String(b.data?.provider || '-')}</td>
                      <td className="px-4 py-2 font-mono text-xs">{String(b.data?.batchReference || '-')}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs">{formatKobo(Number(b.data?.grossKobo || 0))}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-destructive">{formatKobo(Number(b.data?.feeKobo || 0))}</td>
                      <td className="px-4 py-2 text-right font-mono font-medium">{formatKobo(Number(b.data?.netKobo || 0))}</td>
                      <td className="px-4 py-2 text-right"><span className="px-1.5 py-0.5 bg-secondary text-xs rounded border">{b.status}</span></td>
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
          actionKind === 'confirm_allocation' ? 'Confirm Allocation' : 
          actionKind === 'reject_allocation' ? 'Reject Allocation' : 
          actionKind === 'manual_allocate' ? 'Manual Allocation' : 
          actionKind === 'record_refund' ? 'Record Refund' :
          actionKind === 'create_batch' ? 'Add Settlement Batch' :
          actionKind === 'edit_batch' ? 'Edit Settlement Batch' :
          'Review Allocation'
        }
        actionMutation={actionKind === 'create_batch' || actionKind === 'edit_batch' ? undefined : actionKind}
        defaultValues={actionKind === 'review_allocation' ? { correct: reviewCorrect } : {}}
        fields={
          actionKind === 'manual_allocate' ? [
            { name: 'dueItemId', label: 'Due Item ID', type: 'text', isData: true, required: true },
            { name: 'amountKobo', label: 'Amount (Kobo)', type: 'number', isData: true, required: true }
          ] : 
          actionKind === 'record_refund' ? [
            { name: 'reference', label: 'External Refund Ref', type: 'text', isData: true, required: true }
          ] :
          actionKind === 'review_allocation' ? [
            { name: 'correct', label: 'This allocation is correct (unticked marks it wrong and supersedes it)', type: 'checkbox', isData: true }
          ] :
          actionKind === 'create_batch' || actionKind === 'edit_batch' ? [
            { name: 'name', label: 'Name', type: 'text', required: true },
            { name: 'reference', label: `Batch reference (status is set by reconciliation: ${recordStatuses['settlement-batches'].join(' / ')})`, type: 'text', required: true },
            { name: 'provider', label: 'Provider', type: 'text', isData: true, required: true },
            { name: 'grossKobo', label: 'Gross (Kobo)', type: 'number', isData: true, required: true },
            { name: 'feeKobo', label: 'Fee (Kobo)', type: 'number', isData: true, required: true },
            { name: 'netKobo', label: 'Net (Kobo)', type: 'number', isData: true, required: true }
          ] :
          []
        }
      />
    </div>
  );
}
