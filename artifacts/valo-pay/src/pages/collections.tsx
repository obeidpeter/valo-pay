import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'wouter';
import { useLocationProperty } from 'wouter/use-browser-location';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow } from '@/components/empty-state';
import { LoadingRow } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, useImportRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { FileText, Upload, CheckCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RecordDialog } from '@/components/record-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { failureCodeList } from '@workspace/valopay-schema';
import { RecordLabel, StatusBadge, readableLabel } from '@/components/record-label';
import { formatKobo, formatDate } from '@/lib/formatters';
import { deadlineOrder, isDueToday, isOverdue, useQueueFilters } from '@/lib/queue-filters';
import { collectionReturnTo, recordDestination } from '@/lib/record-navigation';
import { useHashTarget } from '@/lib/use-hash-target';
import { useRecordPagination } from '@/lib/use-record-pagination';
import { RecordPagination } from '@/components/record-pagination';

const collectionViews = ['all', 'overdue', 'due-today', 'failed'] as const;
const isUnpaid = (status: string) => !['paid', 'closed', 'cancelled'].includes(status);

export default function CollectionsPage() {
  const { merchantId } = useWorkspace();
  const currentMerchant = useRef(merchantId);
  currentMerchant.current = merchantId;
  const [importText, setImportText] = useState('');
  const [importKind, setImportKind] = useState('due-items');
  const [importResult, setImportResult] = useState<any>(null);
  const [previewSignature, setPreviewSignature] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const { view, owner, setView, setOwner } = useQueueFilters(collectionViews, 'all');
  const [search] = useSearchParams();
  const targetHash = useLocationProperty(() => window.location.hash);
  
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const queryClient = useQueryClient();

  const { data: dueItems, isLoading: isLoadingDue, error: dueError, refetch: refetchDue } = useListRecords(
    'due-items',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('due-items', { merchantId: merchantId! }) } }
  );
  const { data: attempts, isLoading: isLoadingAttempts, error: attemptsError, refetch: refetchAttempts } = useListRecords('attempts', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('attempts', { merchantId: merchantId! }) } });
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
  const rowTargets = useMemo(() => [...(dueItems?.items || []), ...(attempts?.items || [])].map(item => `record-${item.id}`), [dueItems, attempts]);

  const doImport = useImportRecords({
    mutation: {
      onSuccess: (data, variables) => {
        if (variables.data.commit) queryClient.invalidateQueries();
        if (variables.params?.merchantId !== currentMerchant.current) return;
        setImportResult(data);
        if (!variables.data.commit) setPreviewSignature(`${variables.params?.merchantId}:${variables.data.kind}:${variables.data.csv}`);
      }
    }
  });
  const resetImport = doImport.reset;
  useEffect(() => {
    setImportResult(null); setPreviewSignature(''); setActionError('');
    setIsDialogOpen(false); setSelectedItem(null); resetImport();
  }, [merchantId, resetImport]);

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
    setActionError('');
    if (action === 'backtest_policy') {
      const policyId = item.data?.policyId || mandates?.items.find(mandate => mandate.id === item.data?.mandateId)?.data?.policyId;
      const policy = policies?.items.find(candidate => candidate.id === policyId);
      if (!policy) {
        setActionError('No policy is available for this instalment. Check its linked mandate and policy.');
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
    customers: 'name,reference,consentProvenance,bankName,accountMasked,phoneMasked\nSample customer,SAMPLE-C001,Synthetic imported consent,Sandbox Bank,•••• 0001,+234 ••• ••01',
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

  const now = Date.now();
  const instalments = dueItems?.items || [];
  const byId = new Map(instalments.map(item => [item.id, item]));
  const ownerOf = (item: typeof instalments[number] | undefined) => String(item?.data?.owner || 'unassigned');
  const failedAttempts = (attempts?.items || []).filter(attempt => attempt.status === 'failed');
  const latestFailure = new Map<string, typeof failedAttempts[number]>();
  for (const attempt of [...failedAttempts].sort((a, b) => deadlineOrder(a.data?.occurredAt || a.createdAt, b.data?.occurredAt || b.createdAt))) latestFailure.set(String(attempt.data?.dueItemId), attempt);
  const owners = [...new Set([...instalments.map(ownerOf), ...(owner ? [owner] : [])])].sort();
  const owned = instalments.filter(item => !owner || ownerOf(item) === owner);
  const ownedFailures = failedAttempts.filter(attempt => !owner || ownerOf(byId.get(String(attempt.data?.dueItemId))) === owner);
  const isOverdueItem = (item: typeof instalments[number]) => isUnpaid(item.status) && isOverdue(item.data?.dueDate, now);
  const isTodayItem = (item: typeof instalments[number]) => isUnpaid(item.status) && isDueToday(item.data?.dueDate, now);
  const displayed = view === 'failed'
    ? ownedFailures.map(attempt => ({ key: attempt.id, item: byId.get(String(attempt.data?.dueItemId)), attempt }))
    : owned.filter(item => view === 'overdue' ? isOverdueItem(item) : view === 'due-today' ? isTodayItem(item) : true).map(item => ({ key: item.id, item, attempt: undefined }));
  displayed.sort((a, b) => Number(!!b.item && isOverdueItem(b.item)) - Number(!!a.item && isOverdueItem(a.item)) || Number(!!b.item && isUnpaid(b.item.status)) - Number(!!a.item && isUnpaid(a.item.status)) || deadlineOrder(a.item?.data?.dueDate, b.item?.data?.dueDate) || deadlineOrder(a.attempt?.data?.occurredAt, b.attempt?.data?.occurredAt));
  const pagination = useRecordPagination(`${merchantId}:${view}:${owner}`, displayed.length);
  const targetIndex = displayed.findIndex(row => `#record-${row.key}` === targetHash);
  useEffect(() => {
    if (targetIndex >= 0) pagination.setPage(Math.floor(targetIndex / pagination.pageSize));
    // Resolve a return link when its record arrives; normal paging must remain under the operator's control.
  }, [merchantId, view, owner, targetHash, targetIndex, pagination.pageSize]);
  const pagedRows = displayed.slice(pagination.offset, pagination.offset + pagination.pageSize);
  useHashTarget(rowTargets, !isLoadingDue && !isLoadingAttempts && !dueError && !attemptsError && targetIndex >= pagination.offset && targetIndex < pagination.offset + pagination.pageSize);
  const views: Array<{ key: typeof view; label: string; count: number }> = [
    { key: 'all', label: 'All instalments', count: owned.length },
    { key: 'overdue', label: 'Overdue', count: owned.filter(isOverdueItem).length },
    { key: 'due-today', label: 'Due today', count: owned.filter(isTodayItem).length },
    { key: 'failed', label: 'Failed attempts', count: ownedFailures.length },
  ];
  if (!merchantId) return null;
  const nextAction = (item: typeof instalments[number] | undefined, attempt: typeof failedAttempts[number] | undefined) => {
    const rowId = attempt?.id || item?.id;
    const returnTo = collectionReturnTo(search, merchantId, rowId);
    const destination = (path: string, id: string, parameter?: string) => recordDestination(path, id, returnTo, merchantId, parameter);
    const customerId = item?.customerId || attempt?.customerId;
    const customerLink = (label: string, recordId: string | undefined) => customerId && recordId
      ? <Link href={destination(`/customers/${encodeURIComponent(customerId)}`, recordId)} className="font-medium text-primary underline underline-offset-4 hover:no-underline">{label}</Link>
      : <span>{label}. Customer link unavailable; check the imported reference.</span>;
    if (!item) return customerLink('Review this unlinked attempt', attempt?.id);
    if (!isUnpaid(item.status)) return 'No collection action needed';
    if (item.status === 'in_dispute') return customerLink('Review the customer dispute', item.id);
    if (item.status === 'unpaid_final') return customerLink('Agree a next step with the lender', item.id);
    const mandate = mandates?.items.find(candidate => candidate.id === item.data?.mandateId);
    if (mandate?.status === 'pending_activation') return <Link href={destination('/mandates', mandate.id)} className="font-medium text-primary underline underline-offset-4 hover:no-underline">Follow up on mandate activation</Link>;
    if (latestFailure.has(item.id)) return customerLink('Review the failed attempt and retry policy', attempt?.id || latestFailure.get(item.id)?.id);
    if (item.status === 'partially_paid') return <Link href={destination('/reconciliation', item.id, 'dueItem')} className="font-medium text-primary underline underline-offset-4 hover:no-underline">Review the remaining amount</Link>;
    return customerLink(ownerOf(item) === 'valopay' || ownerOf(item) === 'valo' ? 'Check the collection schedule' : 'Follow up with the collection owner', item.id);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Collections</h1>
          <p className="text-muted-foreground mt-1">Track instalments and try collection scenarios with synthetic data.</p>
        </div>
        <Button variant="outline" className="gap-2" aria-expanded={importOpen} aria-controls="collection-import" onClick={() => setImportOpen(open => !open)}><Upload className="h-4 w-4" aria-hidden="true" />{importOpen ? 'Hide import' : 'Import sample data'}</Button>
      </header>

      {actionError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">{actionError}</p>}
      <div className="flex flex-col gap-6">
        
        {/* Synthetic Import */}
        <div id="collection-import" hidden={!importOpen} className="order-1">
          <section className="bg-card border rounded-xl shadow-sm p-5">
            <h2 className="font-semibold text-lg flex items-center gap-2 mb-4">
              <Upload className="h-5 w-5 text-primary" /> Import sample data
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              Paste synthetic records in CSV format. Download a sample to see the required columns. CSV amounts remain in kobo: ₦1,000.00 is 100000 kobo. Do not use real customer data.
            </p>
            <label htmlFor="import-kind" className="text-sm font-medium block mb-1">Import as</label>
            <select 
              id="import-kind"
              className="w-full bg-background border rounded-md p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring mb-4"
              value={importKind}
              disabled={doImport.isPending}
               onChange={(e) => { setImportKind(e.target.value); setImportResult(null); setPreviewSignature(''); resetImport(); }}
            >
              <option value="customers">Customers</option>
              <option value="mandates">Mandates</option>
              <option value="due-items">Instalments</option>
              <option value="attempts">Collection attempts</option>
              <option value="observations">Payment evidence</option>
            </select>
            <label htmlFor="import-csv" className="mb-1 block text-sm font-medium">CSV content</label>
            <textarea id="import-csv"
              className="w-full h-32 bg-background border rounded-md p-3 text-xs font-mono mb-4 focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Paste CSV content from the sample file…"
              value={importText}
              disabled={doImport.isPending}
               onChange={e => { setImportText(e.target.value); setImportResult(null); setPreviewSignature(''); resetImport(); }}
            />
            <Button type="button" variant="link" className="h-auto min-h-6 p-0 mb-4 text-xs" onClick={downloadSample}>Download sample CSV</Button>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={handlePreview} disabled={doImport.isPending || !importText} busy={doImport.isPending && !doImport.variables?.data.commit} busyLabel="Checking data…">Check data</Button>
              <Button className="flex-1" onClick={handleCommit} disabled={doImport.isPending || !importText || !importResult || importResult.valid === 0 || importResult.invalid > 0 || previewSignature !== `${merchantId}:${importKind}:${importText}`} busy={doImport.isPending && Boolean(doImport.variables?.data.commit)} busyLabel="Importing data…">Import data</Button>
            </div>

            {doImport.error && <p role="alert" className="mt-4 text-sm text-destructive">The import request failed. {doImport.error.message || 'Check your connection and try again.'}</p>}

            {importResult && (
              <div className="mt-6 border-t pt-4">
                <h3 className="font-medium text-sm mb-3">Import results</h3>
                <div className="flex gap-4 mb-4 text-sm">
                  <div className="flex items-center gap-1 text-success"><CheckCircle className="h-4 w-4" /> Valid rows: {importResult.valid}</div>
                  <div className="flex items-center gap-1 text-destructive"><AlertTriangle className="h-4 w-4" /> Rows to fix: {importResult.invalid}</div>
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
        <div className="order-2">
          <section className="bg-card border rounded-xl shadow-sm overflow-hidden h-full flex flex-col">
            <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
              <h2 className="font-semibold text-lg flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" /> Instalments
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-b p-4">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Collection views">
                {views.map(option => <Button key={option.key} size="sm" variant={view === option.key ? 'default' : 'ghost'} aria-pressed={view === option.key} onClick={() => setView(option.key)}>{option.label} ({option.count})</Button>)}
              </div>
              <label className="flex items-center gap-2 text-sm sm:ml-auto">Owner
                <select aria-label="Filter collections by owner" className="max-w-60 rounded-md border bg-background px-3 py-2" value={owner} onChange={event => setOwner(event.target.value)}>
                  <option value="">All owners</option>
                  {owners.map(value => <option key={value} value={value}>{readableLabel(value)}</option>)}
                </select>
              </label>
              <p className="w-full text-xs text-muted-foreground">{view === 'failed' ? 'Each row is a failed debit attempt, including attempts on instalments later paid. ' : ''}Unpaid, overdue instalments first. Dates use West Africa Time.</p>
            </div>
            
            <ScrollFrame label="Instalments" className="flex-1 overflow-auto">
              <table className="w-full min-w-[1120px] text-sm text-left">
                <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                  <tr>
                    <th className="px-4 py-3 font-medium">Instalment</th>
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 font-medium text-right">{view === 'failed' ? 'Attempt amount / outstanding' : 'Amount / outstanding'}</th>
                    <th className="px-4 py-3 font-medium">Due date</th>
                    <th className="px-4 py-3 font-medium">Status / owner</th>
                    <th className="px-4 py-3 font-medium">Next action</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {isLoadingDue || isLoadingAttempts ? (
                    <LoadingRow colSpan={7} what="collections" />
                  ) : dueError || attemptsError ? (
                    <tr><td colSpan={7} className="p-6"><div role="alert"><p>Collections could not be loaded completely.</p><Button className="mt-3" size="sm" variant="outline" onClick={() => { refetchDue(); refetchAttempts(); }}>Try again</Button></div></td></tr>
                  ) : displayed.length === 0 ? (
                    <EmptyRow colSpan={7} title={view === 'all' && !owner ? 'No instalments recorded' : 'No collections match these filters'}>{view === 'all' && !owner ? 'Open Import sample data to add synthetic instalments using a sample CSV.' : 'Choose All instalments and All owners to see the full list.'}</EmptyRow>
                  ) : (
                    pagedRows.map(({ key, item, attempt }) => (
                      <tr key={key} id={`record-${key}`} tabIndex={-1} className="hover:bg-secondary/10 target:bg-primary/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                        <td className="px-4 py-3"><p className="font-mono text-xs">{item?.reference || 'Instalment not linked'}</p>{attempt && <><p className="mt-1 text-xs text-muted-foreground">Attempt {attempt.reference || String(attempt.data?.number || '')}</p><p className="mt-1 text-xs text-muted-foreground">{formatDate(String(attempt.data?.occurredAt || attempt.createdAt))}</p></>}</td>
                        <td className="px-4 py-3"><RecordLabel record={customerById.get(String(item?.customerId || attempt?.customerId))} id={item?.customerId || attempt?.customerId} customer /></td>
                        <td className="px-4 py-3 text-right tabular-nums"><p className="font-medium">{formatKobo(attempt?.amountKobo ?? item?.amountKobo ?? 0)}</p><p className="mt-1 text-xs text-muted-foreground">{item ? `${formatKobo(Number(item.data?.outstandingKobo ?? item.amountKobo))} outstanding` : 'Outstanding unknown'}</p></td>
                        <td className="px-4 py-3 whitespace-nowrap"><p>{formatDate(String(item?.data?.dueDate || ''))}</p>{item && isOverdueItem(item) && <p className="mt-1 text-xs font-semibold text-destructive">Overdue</p>}</td>
                        <td className="px-4 py-3"><StatusBadge status={attempt?.status || item?.status} /><p className="mt-1 text-xs text-muted-foreground">{readableLabel(ownerOf(item))}</p>{attempt && <p className="mt-1 text-xs">{readableLabel(attempt.data?.failureCode)}</p>}</td>
                        <td className="max-w-56 px-4 py-3 text-xs leading-relaxed">{nextAction(item, attempt)}</td>
                        <td className="px-4 py-3 text-right">
                          {item && <div className="flex flex-col items-end gap-2"><Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(item, 'backtest_policy')}>Test policy</Button>
                          {isUnpaid(item.status) && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => handleAction(item, 'simulate_failure')}>Simulate failure</Button>}</div>}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </ScrollFrame>
            {!isLoadingDue && !isLoadingAttempts && !dueError && !attemptsError && <RecordPagination pagination={pagination} total={displayed.length} label={view === 'failed' ? 'failed attempts' : 'instalments'} />}
          </section>
        </div>
      </div>

      <RecordDialog
        kind={actionKind === 'backtest_policy' ? 'policies' : 'due-items'}
        record={selectedItem}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={actionKind === 'simulate_failure' ? 'Simulate collection failure' : 'Test retry policy'}
        actionMutation={actionKind}
        fields={
          actionKind === 'simulate_failure' ? 
            [{ name: 'failureCode', label: 'Failure reason', type: 'select', options: failureCodeList.map(code => ({ label: readableLabel(code), value: code })), isData: true, required: true }] :
            []
        }
      />
    </div>
  );
}
