import React, { useRef, useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { useSearchShortcut } from '@/lib/focus';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, usePerformAction, getListRecordsQueryKey } from '@workspace/api-client-react';
import { Search, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDate, formatCount } from '@/lib/formatters';
import { notifyProblem, saidBy } from '@/lib/notify';

export default function AuditPage() {
  const { merchantId } = useWorkspace();
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const [verification, setVerification] = useState<{ valid: boolean; count: number; headHash: string } | null>(null);

  const { data, isLoading } = useListRecords(
    'audit',
    { merchantId: merchantId!, search: search || undefined },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('audit', { merchantId: merchantId!, search: search || undefined }) } }
  );

  const verify = usePerformAction({
    mutation: {
      onSuccess: (res) => {
        const result = { valid: res.data?.valid === true, count: Number(res.data?.count || 0), headHash: String(res.data?.headHash || '') };
        setVerification(result);

      },
      onError: (error: unknown) => notifyProblem('Audit log could not be checked', `${saidBy(error, 'The service could not complete the check.')} The log is unchanged.`),
    }
  });

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
          onClick={() => verify.mutate({ data: { action: 'verify_audit' }, params: { merchantId } })}
          busy={verify.isPending}
          busyLabel="Checking audit log…"
          className="gap-2"
        >
          <ShieldCheck className="h-4 w-4 text-primary" /> Check audit log
        </Button>
      </header>

      {verification && (
        <div role="status" className={`rounded-xl border p-4 text-sm ${verification.valid ? 'border-success/30 bg-success/5' : 'border-destructive/30 bg-destructive/5 text-destructive'}`}>
          <p className="font-semibold">{verification.valid ? 'Audit log verified: all entries are intact' : 'Audit log check failed: an entry or its link does not match. Ask an administrator to investigate.'}</p>
          <p className="font-mono text-xs mt-1">{formatCount(verification.count, 'verified entry', 'verified entries')} · Latest verified hash: {verification.headHash}</p>
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
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-background border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border bg-secondary px-1.5 font-mono text-[11px] text-muted-foreground" aria-hidden="true">/</kbd>
          </div>
        </div>

        {isLoading ? (
          <Loading what="the audit log" />
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
      </div>
    </div>
  );
}
