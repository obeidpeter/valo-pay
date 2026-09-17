import React, { useState } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, usePerformAction, getListRecordsQueryKey } from '@workspace/api-client-react';
import { HardDrive, Search, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/formatters';

export default function AuditPage() {
  const { merchantId } = useWorkspace();
  const [search, setSearch] = useState('');

  const { data, isLoading } = useListRecords(
    'audit',
    { merchantId: merchantId!, search: search || undefined },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('audit', { merchantId: merchantId!, search: search || undefined }) } }
  );

  const verify = usePerformAction({
    mutation: {
      onSuccess: (res) => {
        alert(res.message); // In real app use a Toast, but keeping it simple for now
      }
    }
  });

  if (!merchantId) return null;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Audit Log</h1>
          <p className="text-muted-foreground mt-1">Immutable hash-chain log of all operational actions.</p>
        </div>
        <Button 
          variant="outline"
          onClick={() => verify.mutate({ data: { action: 'verify_audit' }, params: { merchantId } })}
          disabled={verify.isPending}
          className="gap-2"
        >
          <ShieldCheck className="h-4 w-4 text-primary" /> {verify.isPending ? 'Verifying...' : 'Verify Chain Integrity'}
        </Button>
      </header>

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
        <div className="p-4 border-b flex items-center gap-4 bg-secondary/20">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input 
              type="text" 
              placeholder="Search audit trail..." 
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-background border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground animate-pulse">Loading audit logs...</div>
        ) : !data || data.items.length === 0 ? (
          <div className="p-16 text-center flex flex-col items-center justify-center">
            <HardDrive className="h-12 w-12 text-muted-foreground mb-4 opacity-20" />
            <h3 className="text-lg font-medium">Log empty</h3>
            <p className="text-muted-foreground text-sm mt-1">No actions have been recorded yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left font-mono">
              <thead className="bg-secondary/30 border-b text-muted-foreground text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-6 py-4 font-medium">Timestamp</th>
                  <th className="px-6 py-4 font-medium">Actor</th>
                  <th className="px-6 py-4 font-medium">Action</th>
                  <th className="px-6 py-4 font-medium">Object ID</th>
                  <th className="px-6 py-4 font-medium">Hash</th>
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
          </div>
        )}
      </div>
    </div>
  );
}
