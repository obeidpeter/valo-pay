import React, { useRef, useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { AlertTriangle, User, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatKobo, formatDate } from '@/lib/formatters';
import { RecordDialog } from '@/components/record-dialog';
import { exceptionSeverities, resolutionCodesFor } from '@workspace/valopay-schema';
import { readableLabel, RecordLabel, StatusBadge } from '@/components/record-label';

export default function ExceptionsPage() {
  const { merchantId } = useWorkspace();
  const [selectedEx, setSelectedEx] = useState<any>(null);
  const [actionKind, setActionKind] = useState<'update' | 'resolve' | ''>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [filter, setFilter] = useState<'open' | 'high' | 'resolved'>('open');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** WAI-ARIA tabs: one tab stop for the group, arrows and Home/End move the selection and the focus together. */
  const onTabKeyDown = (event: React.KeyboardEvent, index: number, keys: Array<'open' | 'high' | 'resolved'>) => {
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: keys.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = (moves[event.key]! + keys.length) % keys.length;
    setFilter(keys[next]!);
    tabRefs.current[next]?.focus();
  };

  const { data, isLoading, error } = useListRecords(
    'exceptions',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('exceptions', { merchantId: merchantId! }) } }
  );
  const { data: customers } = useListRecords('customers', { merchantId: merchantId! }, { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('customers', { merchantId: merchantId! }) } });
  const customerById = new Map(customers?.items.map(customer => [customer.id, customer]));

  const handleAction = (ex: any, kind: 'update' | 'resolve') => {
    setSelectedEx(ex);
    setActionKind(kind);
    setIsDialogOpen(true);
  };

  if (!merchantId) return null;

  const isOpen = (status: string) => !['resolved', 'closed'].includes(status);
  const items = (data?.items || []).filter(exception =>
    filter === 'resolved' ? !isOpen(exception.status) : filter === 'high' ? isOpen(exception.status) && String(exception.data?.severity) === 'high' : isOpen(exception.status)
  );
  const filters: Array<{ key: typeof filter; label: string }> = [
    { key: 'open', label: `All open (${(data?.items || []).filter(exception => isOpen(exception.status)).length})` },
    { key: 'high', label: `High severity (${(data?.items || []).filter(exception => isOpen(exception.status) && String(exception.data?.severity) === 'high').length})` },
    { key: 'resolved', label: `Resolved (${(data?.items || []).filter(exception => !isOpen(exception.status)).length})` },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Exceptions</h1>
          <p className="text-muted-foreground mt-1">A clear owner and next step for every item that needs attention.</p>
        </div>
      </header>

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
        <div className="p-5 border-b flex items-center gap-4">
          <p className="hidden print:block text-sm">Showing: {filters.find(option => option.key === filter)?.label}</p>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Exception filter">
            {filters.map((option, index) => (
              <Button key={option.key} ref={element => { tabRefs.current[index] = element; }} role="tab" aria-selected={filter === option.key} tabIndex={filter === option.key ? 0 : -1} onKeyDown={event => onTabKeyDown(event, index, filters.map(item => item.key))} variant={filter === option.key ? 'secondary' : 'ghost'} size="sm" className={filter === option.key ? 'bg-primary text-primary-foreground hover:bg-primary/90' : ''} onClick={() => setFilter(option.key)}>
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <Loading what="exceptions" />
        ) : error ? (
          <p role="alert" className="p-6 text-sm text-destructive">Exceptions could not be loaded. Please refresh to try again.</p>
        ) : items.length === 0 ? (
          <EmptyState filtered title={filter === 'resolved' ? 'Nothing resolved yet' : filter === 'high' ? 'No high-severity exceptions open' : 'All clear: no open exceptions'}>
            {filter === 'resolved'
              ? 'Resolved and closed exceptions are kept here with their resolution code.'
              : 'The daily close raises an exception for each unmatched payment, failed attempt or missing notice, with an owner and a business-day deadline.'}
          </EmptyState>
        ) : (
          <ScrollFrame label="Exceptions" className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground">
                <tr>
                  <th className="px-6 py-4 font-medium">Type & Severity</th>
                  <th className="px-6 py-4 font-medium">Customer / Context</th>
                  <th className="px-6 py-4 font-medium">Status & Owner</th>
                  <th className="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map(exception => (
                  <tr key={exception.id} className="hover:bg-secondary/10 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {String(exception.data?.severity) === 'high' && <AlertTriangle className="h-4 w-4 text-destructive" />}
                        <span title={String(exception.data?.type || '')} className="font-semibold text-foreground">{readableLabel(exception.data?.type)}</span>
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
                          <Calendar className="h-3 w-3" /> Due {formatDate(String(exception.data.dueBy))}
                        </div>
                      )}
                      {!!exception.data?.notes && (
                        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground mt-2">{String(exception.data.notes)}</p>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right space-x-2">
                      {exception.status !== 'resolved' && exception.status !== 'closed' ? (
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" className="text-xs" onClick={() => handleAction(exception, 'update')}>
                            Edit
                          </Button>
                          <Button size="sm" variant="outline" className="text-xs" onClick={() => handleAction(exception, 'resolve')}>
                            Resolve
                          </Button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">Resolved: {readableLabel(exception.data?.resolutionCode)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFrame>
        )}
      </div>

      <RecordDialog
        kind="exceptions"
        record={selectedEx}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={actionKind === 'resolve' ? 'Resolve Exception' : 'Edit Exception'}
        actionMutation={actionKind === 'resolve' ? 'resolve_exception' : undefined}
        fields={
          actionKind === 'resolve' ? [
            { name: 'resolutionCode', label: `Resolution code for ${readableLabel(selectedEx?.data?.type || 'this type').toLowerCase()}`, type: 'select', isData: true, required: true, options: resolutionCodesFor(selectedEx?.data?.type).map(code => ({ label: readableLabel(code), value: code })) }
          ] : [
            { name: 'owner', label: 'Owner', type: 'text', isData: true },
            { name: 'notes', label: 'Notes', type: 'textarea', isData: true },
            { name: 'severity', label: 'Severity', type: 'select', isData: true, options: exceptionSeverities.map(severity => ({ label: severity.charAt(0).toUpperCase() + severity.slice(1), value: severity })) }
          ]
        }
      />
    </div>
  );
}
