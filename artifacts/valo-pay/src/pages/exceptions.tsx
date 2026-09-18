import { QueueFreshness } from '@/components/queue-freshness';
import React, { useEffect, useRef, useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { AlertTriangle, User, Calendar } from 'lucide-react';
import { PermissionButton as Button } from '@/components/permission-button';
import { formatKobo, formatDate } from '@/lib/formatters';
import { RecordDialog } from '@/components/record-dialog';
import { exceptionSeverities, resolutionCodesFor } from '@workspace/valopay-schema';
import { readableLabel, RecordLabel, StatusBadge } from '@/components/record-label';
import { deadlineInstant, deadlineOrder, isDueToday, isDeadlineOverdue as isOverdue, useQueueFilters } from '@/lib/queue-filters';
import { RecordPagination } from '@/components/record-pagination';
import { useRecordPagination } from '@/lib/use-record-pagination';
import { ExceptionContext } from '@/components/exception-context';

const exceptionViews = ['open', 'high', 'overdue', 'due-today', 'resolved'] as const;

export default function ExceptionsPage() {
  const { merchantId } = useWorkspace();
  const [selectedEx, setSelectedEx] = useState<any>(null);
  const [actionKind, setActionKind] = useState<'update' | 'resolve' | ''>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { view: filter, owner, type, setView: setFilter, setOwner, setType } = useQueueFilters(exceptionViews, 'open');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => { setSelectedEx(null); setIsDialogOpen(false); }, [merchantId]);
  /** WAI-ARIA tabs: one tab stop for the group, arrows and Home/End move the selection and the focus together. */
  const onTabKeyDown = (event: React.KeyboardEvent, index: number, keys: Array<typeof filter>) => {
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: keys.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = (moves[event.key]! + keys.length) % keys.length;
    setFilter(keys[next]!);
    tabRefs.current[next]?.focus();
  };

  const exceptionsQuery = useListRecords(
    'exceptions',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('exceptions', { merchantId: merchantId! }) } }
  );
  const { data, isLoading, error, refetch } = exceptionsQuery;
  const customersQuery = useListRecords('customers', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('customers', { merchantId: merchantId! }) } });
  const { data: customers } = customersQuery;
  const customerById = new Map(customers?.items.map(customer => [customer.id, customer]));

  const handleAction = (ex: any, kind: 'update' | 'resolve') => {
    setSelectedEx(ex);
    setActionKind(kind);
    setIsDialogOpen(true);
  };

  const isOpen = (status: string) => !['resolved', 'closed'].includes(status);
  const now = Date.now();
  const records = data?.items || [];
  const owned = records.filter(exception => (!owner || String(exception.data?.owner || 'Unassigned') === owner) && (!type || exception.data?.type === type));
  const matchesView = (exception: typeof records[number], view: typeof filter) => {
    if (view === 'resolved') return !isOpen(exception.status);
    if (!isOpen(exception.status)) return false;
    if (view === 'high') return String(exception.data?.severity) === 'high';
    if (view === 'overdue') return isOverdue(exception.data?.dueBy, now);
    if (view === 'due-today') return isDueToday(exception.data?.dueBy, now);
    return true;
  };
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const items = owned.filter(exception => matchesView(exception, filter)).sort((a, b) =>
    Number(isOverdue(b.data?.dueBy, now)) - Number(isOverdue(a.data?.dueBy, now)) ||
    (severityOrder[String(a.data?.severity)] ?? 4) - (severityOrder[String(b.data?.severity)] ?? 4) ||
    deadlineOrder(a.data?.dueBy, b.data?.dueBy)
  );
  const owners = [...new Set(records.map(exception => String(exception.data?.owner || 'Unassigned'))), ...(owner ? [owner] : [])].filter((value, index, values) => values.indexOf(value) === index).sort();
  const types = [...new Set([...records.map(exception => String(exception.data?.type || 'unknown')), ...(type ? [type] : [])])].sort();
  const filters: Array<{ key: typeof filter; label: string }> = [
    { key: 'open', label: `All open (${owned.filter(exception => matchesView(exception, 'open')).length})` },
    { key: 'high', label: `High severity (${owned.filter(exception => matchesView(exception, 'high')).length})` },
    { key: 'overdue', label: `Overdue (${owned.filter(exception => matchesView(exception, 'overdue')).length})` },
    { key: 'due-today', label: `Due today (${owned.filter(exception => matchesView(exception, 'due-today')).length})` },
    { key: 'resolved', label: `Resolved (${owned.filter(exception => matchesView(exception, 'resolved')).length})` },
  ];
  const pagination = useRecordPagination(`${merchantId}:${filter}:${owner}:${type}`, items.length);

  if (!merchantId) return null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Exceptions</h1>
          <p className="text-muted-foreground mt-1">Exceptions are items that need a person to review or resolve them. Track each item's owner and deadline here.</p>
        </div>
      </header>

      <QueueFreshness key={merchantId} queries={[exceptionsQuery, customersQuery]} />

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
        <div className="p-5 border-b flex flex-wrap items-center gap-4">
          <p className="hidden print:block text-sm">Showing: {filters.find(option => option.key === filter)?.label}</p>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Exception filter">
            {filters.map((option, index) => (
              <Button key={option.key} ref={element => { tabRefs.current[index] = element; }} role="tab" aria-selected={filter === option.key} tabIndex={filter === option.key ? 0 : -1} onKeyDown={event => onTabKeyDown(event, index, filters.map(item => item.key))} variant={filter === option.key ? 'secondary' : 'ghost'} size="sm" className={filter === option.key ? 'bg-primary text-primary-foreground hover:bg-primary/90' : ''} onClick={() => setFilter(option.key)}>
                {option.label}
              </Button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm sm:ml-auto">Owner
            <select aria-label="Filter exceptions by owner" className="max-w-52 rounded-md border bg-background px-3 py-2" value={owner} onChange={event => setOwner(event.target.value)}>
              <option value="">All owners</option>
              {owners.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">Type
            <select aria-label="Filter exceptions by type" className="max-w-60 rounded-md border bg-background px-3 py-2" value={type} onChange={event => setType(event.target.value)}>
              <option value="">All types</option>
              {types.map(value => <option key={value} value={value}>{readableLabel(value)}</option>)}
            </select>
          </label>
          <p className="w-full text-xs text-muted-foreground">Overdue items first, then severity and deadline. Dates use West Africa Time.</p>
        </div>

        {isLoading ? (
          <Loading what="exceptions" />
        ) : error && !data ? (
          <div role="alert" className="p-6 text-sm"><p>Exceptions could not be loaded.</p><Button className="mt-3" size="sm" variant="outline" onClick={() => refetch()}>Try again</Button></div>
        ) : items.length === 0 ? (
          <EmptyState filtered title={owner || type ? 'No exceptions match these filters' : filter === 'resolved' ? 'Nothing resolved yet' : filter === 'high' ? 'No high-severity exceptions open' : filter === 'overdue' ? 'No overdue exceptions' : filter === 'due-today' ? 'No exceptions due today' : 'All clear: no open exceptions'}>
            {filter === 'resolved'
              ? 'Resolved and closed items will appear here with a record of how they were resolved.'
              : filter !== 'open' || owner || type
                ? 'Select All open, All owners and All types to review other exceptions.'
                : 'Items appear here when reconciliation finds a problem that needs review, such as an unmatched payment or missing notice evidence.'}
          </EmptyState>
        ) : (
          <ScrollFrame label="Exceptions" className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground">
                <tr>
                  <th className="px-6 py-4 font-medium">Type and severity</th>
                  <th className="px-6 py-4 font-medium">Customer and amount</th>
                  <th className="px-6 py-4 font-medium">Status and owner</th>
                  <th className="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.slice(pagination.offset, pagination.offset + pagination.pageSize).map(exception => (
                  <tr key={exception.id} className="hover:bg-secondary/10 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {String(exception.data?.severity) === 'high' && <AlertTriangle className="h-4 w-4 text-destructive" />}
                        <span title={readableLabel(exception.data?.type)} className="font-semibold text-foreground">{readableLabel(exception.data?.type)}</span>
                      </div>
                      <span className={`inline-block mt-1 px-2 py-0.5 text-[10px] uppercase font-bold rounded border ${
                        String(exception.data?.severity) === 'high' ? 'bg-destructive/10 text-destructive border-destructive/20' : 
                        String(exception.data?.severity) === 'medium' ? 'bg-warning text-warning-foreground border-warning-border' : 
                        'bg-secondary text-secondary-foreground'
                      }`}>
                        {String(exception.data?.severity || 'low')}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <RecordLabel record={customerById.get(String(exception.customerId))} id={exception.customerId} customer />
                      {exception.amountKobo > 0 && (
                         <p className="font-mono font-medium mt-1">{formatKobo(exception.amountKobo)}</p>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={exception.status} />
                      <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                        <User className="h-3 w-3" /> {String(exception.data?.owner || 'Unassigned')}
                      </div>
                      {!!exception.data?.dueBy && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                          <Calendar className="h-3 w-3" /> Due {formatDate(deadlineInstant(exception.data.dueBy))}
                          {isOpen(exception.status) && isOverdue(exception.data.dueBy, now) && <span className="font-semibold text-destructive">Overdue</span>}
                        </div>
                      )}
                      {!!exception.data?.notes && (
                        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground mt-2">{String(exception.data.notes)}</p>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right space-x-2">
                      {exception.status !== 'resolved' && exception.status !== 'closed' ? (
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" className="text-xs" kind="exceptions" record={exception} onClick={() => handleAction(exception, 'update')}>
                            Edit
                          </Button>
                          <Button size="sm" variant="outline" className="text-xs" action="resolve_exception" record={exception} onClick={() => handleAction(exception, 'resolve')}>
                            Resolve
                          </Button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">Resolution: {readableLabel(exception.data?.resolutionCode)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFrame>
        )}
        {!isLoading && !error && items.length > 25 && <RecordPagination pagination={pagination} total={items.length} label="exceptions" />}
      </div>

      <RecordDialog
        kind="exceptions"
        record={selectedEx}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={actionKind === 'resolve' ? 'Resolve exception' : 'Edit exception'}
        actionMutation={actionKind === 'resolve' ? 'resolve_exception' : undefined}
        context={selectedEx ? values => <ExceptionContext exception={selectedEx} customer={customerById.get(String(selectedEx.customerId))} resolving={actionKind === 'resolve'} resolutionCode={values.resolutionCode} /> : undefined}
        fields={
          actionKind === 'resolve' ? [
            { name: 'resolutionCode', label: `How was this resolved? (${readableLabel(selectedEx?.data?.type || 'exception').toLowerCase()})`, type: 'select', isData: true, required: true, options: resolutionCodesFor(selectedEx?.data?.type).map(code => ({ label: readableLabel(code), value: code })) }
          ] : [
            { name: 'owner', label: 'Assigned owner', type: 'text', isData: true },
            { name: 'notes', label: 'Notes', type: 'textarea', isData: true },
            { name: 'severity', label: 'Severity', type: 'select', isData: true, options: exceptionSeverities.map(severity => ({ label: severity.charAt(0).toUpperCase() + severity.slice(1), value: severity })) }
          ]
        }
      />
    </div>
  );
}
