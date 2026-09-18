import { QueueFreshness } from '@/components/queue-freshness';
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'wouter';
import { useLocationProperty } from 'wouter/use-browser-location';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow } from '@/components/empty-state';
import { LoadingRow } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { FileText, Upload } from 'lucide-react';
import { PermissionButton as Button } from '@/components/permission-button';
import { RecordDialog } from '@/components/record-dialog';
import { ImportWizard } from '@/components/import-wizard';
import { confirmUnsavedChanges } from '@/lib/unsaved-changes';
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
  const [importOpen, setImportOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const { view, owner, setView, setOwner } = useQueueFilters(collectionViews, 'all');
  const [search] = useSearchParams();
  const targetHash = useLocationProperty(() => window.location.hash);
  
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);



  const dueItemsQuery = useListRecords(
    'due-items',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('due-items', { merchantId: merchantId! }) } }
  );
  const { data: dueItems, isLoading: isLoadingDue, error: dueError, refetch: refetchDue } = dueItemsQuery;
  const attemptsQuery = useListRecords('attempts', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('attempts', { merchantId: merchantId! }) } });
  const { data: attempts, isLoading: isLoadingAttempts, error: attemptsError, refetch: refetchAttempts } = attemptsQuery;
  // Names for the customer column; the full ID stays available for tracing.
  const customersQuery = useListRecords('customers', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('customers', { merchantId: merchantId! }) } });
  const { data: customers } = customersQuery;
  const customerById = new Map(customers?.items.map(customer => [customer.id, customer]));
  const mandatesQuery = useListRecords(
    'mandates',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('mandates', { merchantId: merchantId! }) } }
  );
  const { data: mandates } = mandatesQuery;
  const policiesQuery = useListRecords(
    'policies',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('policies', { merchantId: merchantId! }) } }
  );
  const { data: policies } = policiesQuery;
  const rowTargets = useMemo(() => [...(dueItems?.items || []), ...(attempts?.items || [])].map(item => `record-${item.id}`), [dueItems, attempts]);

  useEffect(() => { setActionError(''); setIsDialogOpen(false); setSelectedItem(null); }, [merchantId]);

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
        <Button action={importOpen ? undefined : "import_records"} variant="outline" className="gap-2" aria-expanded={importOpen} aria-controls="collection-import" onClick={() => { if (importOpen && !confirmUnsavedChanges()) return; setImportOpen(open => !open); }}><Upload className="h-4 w-4" aria-hidden="true" />{importOpen ? 'Hide import' : 'Import sample data'}</Button>
      </header>

      <QueueFreshness key={merchantId} queries={[dueItemsQuery, attemptsQuery, customersQuery, mandatesQuery, policiesQuery]} />

      {actionError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">{actionError}</p>}
      <div className="flex flex-col gap-6">
        
        <div id="collection-import" hidden={!importOpen} className="order-1">{importOpen && <ImportWizard key={merchantId} merchantId={merchantId} />}</div>

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
                  ) : (dueError && !dueItems) || (attemptsError && !attempts) ? (
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
                          {item && <div className="flex flex-col items-end gap-2"><Button size="sm" variant="outline" className="h-7 text-xs" action="backtest_policy" record={item} onClick={() => handleAction(item, 'backtest_policy')}>Test policy</Button>
                          {isUnpaid(item.status) && <Button size="sm" variant="ghost" className="h-7 text-xs" action="simulate_failure" record={item} onClick={() => handleAction(item, 'simulate_failure')}>Simulate failure</Button>}</div>}
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
