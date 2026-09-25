import { useSafePerformAction as usePerformAction } from '@/lib/safe-mutations';
import React, { useEffect, useRef, useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { useSearchShortcut } from '@/lib/focus';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { LoadProblem } from '@/components/load-problem';
import { RecordPagination } from '@/components/record-pagination';
import { keepRowsWhilePaging, useDebouncedSearch, useRecordPagination } from '@/lib/use-record-pagination';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Search, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDate, formatCount } from '@/lib/formatters';
import { notifyProblem, saidBy } from '@/lib/notify';

export default function AuditPage() {
  const { merchantId, workspace } = useWorkspace();
  const [rawSearch, setSearch] = useState('');
  const { search, searchPending } = useDebouncedSearch(rawSearch, merchantId);
  const pagination = useRecordPagination(`${merchantId}:${search}`);
  const listParams = { merchantId: merchantId!, search: search || undefined, limit: pagination.pageSize, offset: pagination.offset };
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const [verification, setVerification] = useState<{ merchantId: string; checkedAt: string; valid: boolean; count: number; headHash: string } | null>(null);
  const currentMerchant = useRef(merchantId);
  currentMerchant.current = merchantId;
  const verificationRequest = useRef(0);

  const auditKey = getListRecordsQueryKey('audit', listParams), client = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useListRecords(
    'audit',
    listParams,
    { query: { enabled: !!merchantId, queryKey: auditKey, placeholderData: keepRowsWhilePaging(auditKey, client) } }
  );

  const verify = usePerformAction(undefined, merchantId);
  useEffect(() => {
    // A result belongs to one visit to one lender, including a switch away and back.
    verificationRequest.current += 1;
    setVerification(null);
    verify.reset();
    return () => { verificationRequest.current += 1; };
  }, [merchantId]);

  const checkAudit = async () => {
    if (!merchantId) return;
    const request = ++verificationRequest.current;
    setVerification(null);
    try {
      const res = await verify.mutateAsync({ data: { action: 'verify_audit' }, params: { merchantId } });
      if (currentMerchant.current !== merchantId || verificationRequest.current !== request) return;
      setVerification({ merchantId, checkedAt: new Date().toISOString(), valid: res.data?.valid === true, count: Number(res.data?.count || 0), headHash: String(res.data?.headHash || '') });
    } catch (error) {
      if (currentMerchant.current === merchantId && verificationRequest.current === request) {
        notifyProblem('Audit log could not be checked', `${saidBy(error, 'The service could not complete the check.')} The log is unchanged.`);
      }
    }
  };

  if (!merchantId) return null;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Audit log</h1>
          <p className="text-muted-foreground mt-1">A permanent record of workspace actions. Each entry is linked to the previous one so changes can be detected.</p>
        </div>
        <Button 
          variant="outline"
          onClick={() => { void checkAudit(); }}
          busy={verify.isPending}
          busyLabel="Checking audit log…"
          className="gap-2"
        >
          <ShieldCheck className="h-4 w-4 text-primary" /> Check audit log
        </Button>
      </header>

      {verification?.merchantId === merchantId && (
        <div role="status" className={`rounded-xl border p-4 text-sm ${verification.valid ? 'border-success/30 bg-success/5' : 'border-destructive/30 bg-destructive/5 text-destructive'}`}>
          <p className="font-semibold">{verification.valid ? 'Audit log verified: all entries are intact' : 'Audit log check failed: an entry or its link does not match. Ask an administrator to investigate.'}</p>
          <p className="mt-1">{workspace?.merchants.find(merchant => merchant.id === verification.merchantId)?.name} · Checked {formatDate(verification.checkedAt)}</p>
          <p className="font-mono text-xs mt-1">{formatCount(verification.count, verification.valid ? 'verified entry' : 'checked entry', verification.valid ? 'verified entries' : 'checked entries')} · {verification.valid ? 'Latest verified hash' : 'Reported head hash'}: {verification.headHash}</p>
          <p className="mt-1 text-muted-foreground">This result covers the entries checked at that time. Check again after new actions are recorded.</p>
        </div>
      )}

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
        {search.trim() && <p className="hidden print:block p-4 border-b text-sm">Search: “{search.trim()}”</p>}
        <div className="p-4 border-b flex items-center gap-4 bg-secondary/20 print:hidden">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input 
              type="text" 
              placeholder="Search by action, person or summary…"
              aria-label="Search the audit log"
              ref={searchRef}
              aria-keyshortcuts="/"
              onKeyDown={event => { if (event.key === 'Escape') { setSearch(''); } }} 
              value={rawSearch}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-background border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border bg-secondary px-1.5 font-mono text-[11px] text-muted-foreground" aria-hidden="true">/</kbd>
          </div>
        </div>

        {searchPending ? (
          <Loading what="matching audit entries" />
        ) : isLoading ? (
          <Loading what="the audit log" />
        ) : error ? (
          <LoadProblem what="the audit log" pager="audit entries" error={error} retry={() => { void refetch(); }} busy={isFetching} />
        ) : !data || data.items.length === 0 ? (
          search.trim() ? (
            <EmptyState filtered title={`No entries match “${search.trim()}”`}>Try a shorter term, or search for an action, person or summary.</EmptyState>
          ) : (
            <EmptyState title="No actions recorded yet">Workspace changes will appear here with who made them and when. Use Check audit log to verify the record.</EmptyState>
          )
        ) : (
          <ScrollFrame label="Audit log" className="overflow-x-auto">
            <table className="w-full text-sm text-left font-mono">
              <thead className="bg-secondary/30 border-b text-muted-foreground text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-6 py-4 font-medium">Time</th>
                  <th className="px-6 py-4 font-medium">Performed by</th>
                  <th className="px-6 py-4 font-medium">Action</th>
                  <th className="px-6 py-4 font-medium">Record ID</th>
                  <th className="px-6 py-4 font-medium">Verification hash</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map(log => (
                  <tr key={log.id} className="hover:bg-secondary/10">
                    <td className="px-6 py-3 whitespace-nowrap text-muted-foreground">{formatDate(log.createdAt)}</td>
                    <td className="px-6 py-3 font-sans font-medium">{String(log.data?.actor || 'System')}</td>
                    <td className="px-6 py-3">
                      <span className="bg-secondary/50 text-foreground px-2 py-1 rounded text-xs">{String(log.data?.summary || log.name)}</span>
                    </td>
                    <td className="px-6 py-3 text-xs text-muted-foreground">{String(log.data?.objectId || '-')}</td>
                    <td className="px-6 py-3 text-[10px] text-muted-foreground max-w-[150px] truncate" title={String(log.data?.hash || '')}>
                      {String(log.data?.hash || '-')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFrame>
        )}
        {!error && data && !searchPending && <RecordPagination pagination={pagination} total={data.total} busy={isFetching || searchPending} label="audit entries" />}
      </div>
    </div>
  );
}
