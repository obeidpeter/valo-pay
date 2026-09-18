import React, { useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow } from '@/components/empty-state';
import { LoadingRow } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, useImportRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { FileText, ArrowRightLeft, Upload, CheckCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RecordDialog } from '@/components/record-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { failureCodeList, failureCodes } from '@workspace/valopay-schema';
import { RecordLabel, StatusBadge } from '@/components/record-label';

export default function CollectionsPage() {
  const { merchantId } = useWorkspace();
  const [importText, setImportText] = useState('');
  const [importKind, setImportKind] = useState('due-items');
  const [importResult, setImportResult] = useState<any>(null);
  const [previewSignature, setPreviewSignature] = useState('');
  
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const queryClient = useQueryClient();

  const { data: dueItems, isLoading: isLoadingDue } = useListRecords(
    'due-items',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('due-items', { merchantId: merchantId! }) } }
  );
  // Names for the customer column; the full ID stays available for tracing.
  const { data: customers } = useListRecords('customers', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('customers', { merchantId: merchantId! }) } });
  const customerById = new Map(customers?.items.map(customer => [customer.id, customer]));
  const { data: mandates } = useListRecords(
    'mandates',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('mandates', { merchantId: merchantId! }) } }
  );
  const { data: policies } = useListRecords(
    'policies',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('policies', { merchantId: merchantId! }) } }
  );

  const doImport = useImportRecords({
    mutation: {
      onSuccess: (data, variables) => {
        setImportResult(data);
        if (!variables.data.commit) setPreviewSignature(`${variables.data.kind}:${variables.data.csv}`);
        if (variables.data.commit) {
           queryClient.invalidateQueries();
        }
      }
    }
  });

  const handlePreview = () => {
    doImport.mutate({ 
      data: { kind: importKind, csv: importText, syntheticOnly: true, commit: false }, 
      params: { merchantId: merchantId! } 
    });
  };

  const handleCommit = () => {
    doImport.mutate({ 
      data: { kind: importKind, csv: importText, syntheticOnly: true, commit: true }, 
      params: { merchantId: merchantId! } 
    });
  };

  const handleAction = (item: any, action: string) => {
    if (action === 'backtest_policy') {
      const policyId = item.data?.policyId || mandates?.items.find(mandate => mandate.id === item.data?.mandateId)?.data?.policyId;
      const policy = policies?.items.find(candidate => candidate.id === policyId);
      if (!policy) {
        setImportResult({ valid: 0, invalid: 1, rows: [{ row: 0, status: 'invalid', message: 'This due item has no linked policy available for backtesting.' }] });
        return;
      }
      setSelectedItem(policy);
    } else {
      setSelectedItem(item);
    }
    setActionKind(action);
    setIsDialogOpen(true);
  };

  const sampleCsv: Record<string, string> = {
    customers: 'name,reference,consentProvenance,bankName,accountMasked,phoneMasked\nSample borrower,SAMPLE-C001,Synthetic imported consent,Sandbox Bank,•••• 0001,+234 ••• ••01',
    mandates: 'name,reference,customerId,amountKobo,workflow,frequency,activationDeadline,consentEvidence,consentGaps,policyId\nSample mandate,SAMPLE-M001,DEMO-C1001,5000000,hosted_consent,monthly,2028-12-01,SYNTHETIC-CONSENT-001,,',
    'due-items': 'name,reference,customerId,amountKobo,dueDate,mandateId,owner,overrideReason\nSample instalment,SAMPLE-D001,DEMO-C1001,1000000,2028-12-01,,lms,',
    attempts: 'name,reference,customerId,amountKobo,dueItemId,number,failureCode,occurredAt\nSample failed attempt,SAMPLE-A001,DEMO-C1001,2500000,DEMO-LOAN-1001,1,INSUFFICIENT_FUNDS,2028-12-02',
    observations: 'name,reference,customerId,amountKobo,source,dueItemId,narration\nSample payment observation,SAMPLE-O001,DEMO-C1001,2500000,webhook,DEMO-LOAN-1001,Synthetic payment observation'
  };

  const downloadSample = () => {
    const blob = new Blob([sampleCsv[importKind]], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `synthetic-${importKind}-sample.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (!merchantId) return null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Collections</h1>
          <p className="text-muted-foreground mt-1">Due items and collection attempts.</p>
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        
        {/* Synthetic Import */}
        <div className="xl:col-span-1 space-y-6">
          <section className="bg-card border rounded-xl shadow-sm p-5">
            <h2 className="font-semibold text-lg flex items-center gap-2 mb-4">
              <Upload className="h-5 w-5 text-primary" /> Synthetic Import
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              Paste CSV data to simulate incoming operational data. No real data permitted.
            </p>
            <label htmlFor="import-kind" className="text-sm font-medium block mb-1">Import as</label>
            <select 
              id="import-kind"
              className="w-full bg-background border rounded-md p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring mb-4"
              value={importKind}
               onChange={(e) => { setImportKind(e.target.value); setImportResult(null); setPreviewSignature(''); }}
            >
              <option value="customers">Customers</option>
              <option value="mandates">Mandates</option>
              <option value="due-items">Due Items</option>
              <option value="attempts">Attempts</option>
              <option value="observations">Observations</option>
            </select>
            <textarea
              className="w-full h-32 bg-background border rounded-md p-3 text-xs font-mono mb-4 focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="customerId,reference,amountKobo..."
              value={importText}
               onChange={e => { setImportText(e.target.value); setImportResult(null); setPreviewSignature(''); }}
            />
            <Button type="button" variant="link" className="h-auto min-h-6 p-0 mb-4 text-xs" onClick={downloadSample}>Download {importKind} sample CSV</Button>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={handlePreview} disabled={doImport.isPending || !importText} busy={doImport.isPending && !doImport.variables?.data.commit} busyLabel="Checking the file…">Preview</Button>
              <Button className="flex-1" onClick={handleCommit} disabled={doImport.isPending || !importText || !importResult || importResult.valid === 0 || importResult.invalid > 0 || previewSignature !== `${importKind}:${importText}`} busy={doImport.isPending && Boolean(doImport.variables?.data.commit)} busyLabel="Importing…">Commit</Button>
            </div>

            {importResult && (
              <div className="mt-6 border-t pt-4">
                <h3 className="font-medium text-sm mb-3">Import Results</h3>
                <div className="flex gap-4 mb-4 text-sm">
                  <div className="flex items-center gap-1 text-success"><CheckCircle className="h-4 w-4" /> {importResult.valid} valid</div>
                  <div className="flex items-center gap-1 text-destructive"><AlertTriangle className="h-4 w-4" /> {importResult.invalid} invalid</div>
                </div>
                {importResult.rows && importResult.rows.length > 0 && (
                  <div className="space-y-2 max-h-40 overflow-y-auto bg-secondary/20 p-2 rounded text-xs font-mono">
                    {importResult.rows.map((r: any) => (
                      <div key={r.row} className={r.status === 'invalid' ? 'text-destructive' : r.status === 'duplicate' ? 'text-warning-strong' : 'text-success'}>
                        Row {r.row}: {r.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {/* Due Items List */}
        <div className="xl:col-span-2">
          <section className="bg-card border rounded-xl shadow-sm overflow-hidden h-full flex flex-col">
            <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
              <h2 className="font-semibold text-lg flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" /> Active Due Items
              </h2>
            </div>
            
            <ScrollFrame label="Active due items" className="flex-1 overflow-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                  <tr>
                    <th className="px-4 py-3 font-medium">Reference</th>
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {isLoadingDue ? (
                    <LoadingRow colSpan={4} what="due items" />
                  ) : !dueItems || dueItems.items.length === 0 ? (
                    <EmptyRow colSpan={4} title="No due items">Instalments due appear here from your loan software, or from a CSV import above.</EmptyRow>
                  ) : (
                    dueItems.items.map(item => (
                      <tr key={item.id} className="hover:bg-secondary/10">
                        <td className="px-4 py-3 font-mono text-xs">{item.reference}</td>
                        <td className="px-4 py-3"><RecordLabel record={customerById.get(String(item.customerId))} id={item.customerId} customer /></td>
                        <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
                        <td className="px-4 py-3 text-right space-x-2">
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(item, 'simulate_failure')}>Sim. Fail</Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(item, 'backtest_policy')}>Backtest</Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </ScrollFrame>
          </section>
        </div>
      </div>

      <RecordDialog
        kind={actionKind === 'backtest_policy' ? 'policies' : 'due-items'}
        record={selectedItem}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={actionKind === 'simulate_failure' ? 'Simulate Failure' : 'Backtest Policy'}
        actionMutation={actionKind}
        fields={
          actionKind === 'simulate_failure' ? 
            [{ name: 'failureCode', label: 'Failure Code (TRD 4.4)', type: 'select', options: failureCodeList.map(code => ({ label: `${code} · ${failureCodes[code].meaning}`, value: code })), isData: true, required: true }] :
            []
        }
      />
    </div>
  );
}
