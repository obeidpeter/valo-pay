import React, { useState } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, usePerformAction, getListRecordsQueryKey } from '@workspace/api-client-react';
import { formatKobo, formatDate } from '@/lib/formatters';
import { CheckSquare, Info, ShieldAlert, CornerUpLeft, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RecordDialog } from '@/components/record-dialog';
import { recordStatuses } from '@workspace/valopay-schema';

export default function ReconciliationPage() {
  const { merchantId } = useWorkspace();
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  
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
            disabled={runRecon.isPending}
            className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {runRecon.isPending ? 'Running Engine...' : 'Run Engine'}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Allocations requiring review */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col xl:col-span-2">
          <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
            <CheckSquare className="h-5 w-5 text-amber-600" />
            <h2 className="font-semibold">Proposals Awaiting Confirmation</h2>
            <span className="ml-auto bg-amber-100 text-amber-900 text-xs font-bold px-2 py-1 rounded-full">
              {proposals?.items.length || 0} pending
            </span>
          </div>
          
          <div className="p-0 overflow-x-auto">
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
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground animate-pulse">Loading proposals...</td></tr>
                ) : !proposals || proposals.items.length === 0 ? (
                  <tr><td colSpan={6} className="p-12 text-center text-muted-foreground">No proposals pending review. Run engine to generate.</td></tr>
                ) : (
                  proposals.items.map(prop => (
                    <tr key={prop.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-3 font-mono text-xs">{prop.customerId}</td>
                      <td className="px-4 py-3 font-mono text-xs">{String(prop.data?.paymentId || '')}</td>
                      <td className="px-4 py-3 font-mono text-xs">{String(prop.data?.dueItemId || '')}</td>
                      <td className="px-4 py-3 text-right font-mono font-medium">{formatKobo(prop.amountKobo)}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
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
          </div>
        </div>

        {/* Unallocated Payments */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col">
          <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
            <Info className="h-5 w-5 text-blue-500" />
            <h2 className="font-semibold">Unallocated Payments</h2>
            <span className="ml-auto bg-blue-100 text-blue-900 text-xs font-bold px-2 py-1 rounded-full">
              {payments?.items.length || 0} items
            </span>
          </div>
          <div className="p-0 overflow-y-auto max-h-[400px]">
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
                  <tr><td colSpan={3} className="p-4 text-center text-muted-foreground">Loading...</td></tr>
                ) : !payments || payments.items.length === 0 ? (
                  <tr><td colSpan={3} className="p-8 text-center text-muted-foreground">No unallocated payments.</td></tr>
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
          </div>
        </div>

        {/* Unresolved Observations */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col">
          <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            <h2 className="font-semibold">Unresolved Observations</h2>
            <span className="ml-auto bg-red-100 text-red-900 text-xs font-bold px-2 py-1 rounded-full">
              {observations?.items.length || 0} items
            </span>
          </div>
          <div className="p-0 overflow-y-auto max-h-[400px]">
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
                  <tr><td colSpan={3} className="p-4 text-center text-muted-foreground">Loading...</td></tr>
                ) : !observations || observations.items.length === 0 ? (
                  <tr><td colSpan={3} className="p-8 text-center text-muted-foreground">No unresolved observations.</td></tr>
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
          </div>
        </div>
        
        {/* Settlement Batches */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col xl:col-span-2">
          <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
            <h2 className="font-semibold flex items-center gap-2"><Info className="h-5 w-5 text-primary" /> Settlement Batches</h2>
            <Button size="sm" onClick={handleCreateBatch}><Plus className="h-4 w-4 mr-2" /> Add Batch</Button>
          </div>
          <div className="p-0 overflow-x-auto max-h-[400px]">
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
                  <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">Loading...</td></tr>
                ) : !batches || batches.items.length === 0 ? (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">No settlement batches found.</td></tr>
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
          </div>
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
        fields={
          actionKind === 'manual_allocate' ? [
            { name: 'dueItemId', label: 'Due Item ID', type: 'text', isData: true, required: true },
            { name: 'amountKobo', label: 'Amount (Kobo)', type: 'number', isData: true, required: true }
          ] : 
          actionKind === 'record_refund' ? [
            { name: 'reference', label: 'External Refund Ref', type: 'text', isData: true, required: true }
          ] :
          actionKind === 'review_allocation' ? [
            { name: 'correct', label: 'Correct (check if yes)', type: 'checkbox', isData: true, required: true }
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
