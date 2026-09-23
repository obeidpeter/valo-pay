import { Link, useSearchParams } from 'wouter';
import { QueueSearch } from '@/components/queue-search';
import { QueueFreshness } from '@/components/queue-freshness';
import React, { useEffect, useRef, useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { usePagedQueue } from '@/lib/use-paged-queue';
import { SavedQueueViews } from '@/components/saved-queue-views';
import { AlertTriangle, User, Calendar } from 'lucide-react';
import { PermissionButton as Button } from '@/components/permission-button';
import { formatKobo, formatDate } from '@/lib/formatters';
import { RecordDialog } from '@/components/record-dialog';
import { exceptionSeverities, failureCodeList, resolutionCodesFor, resolveExceptionType } from '@workspace/valopay-schema';
import { readableLabel, RecordLabel, StatusBadge } from '@/components/record-label';
import { deadlineInstant, isDueToday, isDeadlineOverdue as isOverdue, useQueueFilters } from '@/lib/queue-filters';
import { RecordPagination } from '@/components/record-pagination';
import { ExceptionContext } from '@/components/exception-context';
import { useHashTarget } from '@/lib/use-hash-target';

const exceptionViews = ['open', 'high', 'overdue', 'due-today', 'resolved'] as const;

export default function ExceptionsPage() {
  const { merchantId } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q')?.trim();
  // A link to one exception (from its case) shows that exception alone, whatever its status, until the queue is chosen again.
  const targetId = searchParams.get('record');
  const wrongLender = Boolean(searchParams.get('lender') && searchParams.get('lender') !== merchantId);
  const leaveSelectedRecord = () => setSearchParams(current => {
    const next = new URLSearchParams(current);
    next.delete('record'); next.delete('lender');
    return next;
  });
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

  const exceptionsQuery = usePagedQueue('exceptions', { view: filter, owner, type, record: targetId ? wrongLender ? 'unavailable' : targetId : undefined });
  const { data, isLoading, error, refetch, pagination } = exceptionsQuery;
  useHashTarget(`record-${targetId || ''}`, !!targetId && !isLoading && !error && !wrongLender);
  const customerById = new Map(data?.related.filter(row => row.kind === 'customers').map(row => [row.id, row]));

  const handleAction = (ex: any, kind: 'update' | 'resolve') => {
    setSelectedEx(ex);
    setActionKind(kind);
    setIsDialogOpen(true);
  };

  const now = data?.asOf ? Date.parse(data.asOf) : Date.now();
  const isOpen = (status: string) => !['resolved', 'closed'].includes(status);
  const items = data?.items || [];
  const owners = [...new Set([...(data?.owners || []), ...(owner ? [owner] : [])])].sort();
  const types = [...new Set([...(data?.types || []), ...(type ? [type] : [])])].sort();
  const filters: Array<{ key: typeof filter; label: string }> = [
    { key: 'open', label: 'All open' }, { key: 'high', label: 'High severity' },
    { key: 'overdue', label: 'Overdue' }, { key: 'due-today', label: 'Due today' }, { key: 'resolved', label: 'Resolved' },
  ].map(item => ({ ...item, key: item.key as typeof filter, label: item.label + ' (' + (data?.counts[item.key] ?? '…') + ')' }));

  if (!merchantId) return null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Exceptions</h1>
          <p className="text-muted-foreground mt-1">Exceptions are items that need a person to review or resolve them. Track each item's owner and deadline here.</p>
        </div>
      </header>

      <QueueFreshness key={merchantId} queries={[exceptionsQuery]} />

      <QueueSearch /><SavedQueueViews queue="exceptions" views={exceptionViews} fallback="open" />

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
        {targetId ? <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5"><p className="text-sm font-medium">Selected exception</p><Button size="sm" variant="outline" onClick={leaveSelectedRecord}>View exception queue</Button></div> : <div className="p-5 border-b flex flex-wrap items-center gap-4">
          <p className="hidden print:block text-sm">Showing: {filters.find(option => option.key === filter)?.label}</p>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Exception filter">
            {filters.map((option, index) => (
              <Button key={option.key} id={`exception-tab-${option.key}`} aria-controls="exception-results" ref={element => { tabRefs.current[index] = element; }} role="tab" aria-selected={filter === option.key} tabIndex={filter === option.key ? 0 : -1} onKeyDown={event => onTabKeyDown(event, index, filters.map(item => item.key))} variant={filter === option.key ? 'secondary' : 'ghost'} size="sm" className={filter === option.key ? 'bg-primary text-primary-foreground hover:bg-primary/90' : ''} onClick={() => setFilter(option.key)}>
                {option.label}
              </Button>
            ))}
          </div>
          <label className="flex w-full min-w-0 flex-col gap-2 text-sm sm:ml-auto sm:w-auto sm:flex-row sm:items-center">Owner
            <select aria-label="Filter exceptions by owner" className="w-full min-w-0 max-w-full rounded-md border bg-background px-3 py-2 sm:w-auto sm:max-w-52" value={owner} onChange={event => setOwner(event.target.value)}>
              <option value="">All owners</option>
              {owners.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="flex w-full min-w-0 flex-col gap-2 text-sm sm:w-auto sm:flex-row sm:items-center">Type
            <select aria-label="Filter exceptions by type" className="w-full min-w-0 max-w-full rounded-md border bg-background px-3 py-2 sm:w-auto sm:max-w-60" value={type} onChange={event => setType(event.target.value)}>
              <option value="">All types</option>
              {types.map(value => <option key={value} value={value}>{readableLabel(value)}</option>)}
            </select>
          </label>
          <p className="w-full text-xs text-muted-foreground">Overdue items first, then severity and deadline. Dates use West Africa Time.</p>
        </div>}

        <div id="exception-results" {...(targetId ? {} : { role: 'tabpanel', 'aria-labelledby': `exception-tab-${filter}`, tabIndex: 0 })}>
        {isLoading ? (
          <Loading what="exceptions" />
        ) : error && !data ? (
          <div role="alert" className="p-6 text-sm"><p>Exceptions could not be loaded.</p><Button className="mt-3" size="sm" variant="outline" onClick={() => refetch()}>Try again</Button></div>
        ) : targetId && items.length === 0 ? (
          <EmptyState title={wrongLender ? 'This exception link belongs to another lender' : 'The selected exception is unavailable'} action={<Button size="sm" variant="outline" onClick={leaveSelectedRecord}>View exception queue</Button>}>
            {wrongLender ? 'Switch to the lender you were reviewing to open this exception.' : 'It could not be found for the active lender. Open the exception queue to find it.'}
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState filtered title={q ? 'No results match your search' : owner || type ? 'No exceptions match these filters' : filter === 'resolved' ? 'Nothing resolved yet' : filter === 'high' ? 'No high-severity exceptions open' : filter === 'overdue' ? 'No overdue exceptions' : filter === 'due-today' ? 'No exceptions due today' : 'All clear: no open exceptions'}>
            {q ? 'Try another name or reference, or clear the search. Your status, owner and type filters will stay selected.' : filter === 'resolved'
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
                {items.map(exception => (
                  <tr key={exception.id} id={`record-${exception.id}`} tabIndex={-1} className="hover:bg-secondary/10 transition-colors target:bg-primary/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
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
                      {!!exception.data?.case && <p className="mt-2 text-xs font-medium">Assigned to {String((exception.data.case as any).assigneeName)}</p>}
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
                      <Link href={`/cases/${exception.id}`} className="mb-2 inline-flex min-h-9 items-center text-xs font-medium text-primary underline">Case & handover</Link>
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
        {!isLoading && !error && !targetId && (data?.total || 0) > 25 && <RecordPagination pagination={pagination} total={data?.total || 0} label="exceptions" />}
        </div>
      </div>

      <RecordDialog
        kind="exceptions"
        record={selectedEx}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={actionKind === 'resolve' ? 'Resolve exception' : 'Edit exception'}
        actionMutation={actionKind === 'resolve' ? 'resolve_exception' : undefined}
        context={selectedEx ? values => <ExceptionContext exception={selectedEx} customer={customerById.get(String(selectedEx.customerId))} resolving={actionKind === 'resolve'} resolutionCode={values.resolutionCode} /> : undefined}
        validate={actionKind === 'resolve' ? (values): Record<string, string> => values.confirmedFailureCode && values.resolutionCode !== 'resolved_failed' ? { confirmedFailureCode: 'Choose a failure code only when the provider confirmed that the debit failed.' } : {} : undefined}
        fields={
          actionKind === 'resolve' ? [
            { name: 'resolutionCode', label: `How was this resolved? (${readableLabel(selectedEx?.data?.type || 'exception').toLowerCase()})`, type: 'select', isData: true, required: true, options: resolutionCodesFor(selectedEx?.data?.type).map(code => ({ label: readableLabel(code), value: code })) },
            ...(resolveExceptionType(selectedEx?.data?.type) === 'unknown_outcome' ? [{
              name: 'confirmedFailureCode', label: 'Failure code the provider confirmed', type: 'select' as const, isData: true,
              options: failureCodeList.filter(code => code !== 'TIMEOUT_UNKNOWN').map(code => ({ label: readableLabel(code), value: code })),
              help: 'Only when the provider confirmed that the debit failed. Without a code the attempt is recorded as an unclassified failure, which is never retried.',
            }] : []),
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
