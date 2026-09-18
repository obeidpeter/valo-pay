import React from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow, EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetOverview, getGetOverviewQueryKey } from '@workspace/api-client-react';
import { formatKobo, formatDate, formatCompactDate } from '@/lib/formatters';
import { BarChart3, TrendingUp, AlertCircle, Clock, ShieldCheck, Activity } from 'lucide-react';

export default function OverviewPage() {
  const { merchantId } = useWorkspace();
  const { data: overview, isLoading, error } = useGetOverview(
    { merchantId: merchantId! }, 
    { query: { enabled: !!merchantId, queryKey: getGetOverviewQueryKey({ merchantId: merchantId! }) } }
  );

  if (!merchantId) return null;
  if (isLoading) return <Loading what="the overview" />;
  if (error) return <div className="p-8 text-center text-destructive">Failed to load overview data.</div>;
  if (!overview) return null;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Operations Overview</h1>
        <p className="text-muted-foreground mt-2">
          Environment: <span className="font-mono font-medium text-foreground">{overview.environment}</span> 
          <span className="mx-2">·</span> 
          Last close: {overview.lastClose ? formatDate(overview.lastClose) : 'Never'}
          <span className="mx-2">·</span>
          Next scheduled close: {overview.nextClose ? `${formatDate(overview.nextClose)} (daily)` : 'automatic close off'}
        </p>
      </header>

      {/* Alerts (NFR-OBS-02) */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Alerts</h2>
        {overview.alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No alert conditions: the audit chain verifies, positions rebuild, nothing is stuck unallocated over the threshold, no exception is past its deadline, the books were closed within the last 36 hours and no scheduled close was missed.</p>
        ) : (
          <ul className="space-y-2">
            {overview.alerts.map(alert => (
              <li key={alert.key} className={`rounded-lg border p-3 text-sm ${alert.severity === 'critical' ? 'border-destructive bg-destructive/10 text-destructive' : alert.severity === 'high' ? 'border-destructive/40 bg-destructive/5' : alert.severity === 'medium' ? 'border-warning-strong/40 bg-warning-strong/5' : 'border-border bg-secondary/30'}`}>
                <div className="flex items-center gap-2"><AlertCircle className="h-4 w-4" /><span className="font-semibold">{alert.title}</span><span className="ml-auto text-[11px] uppercase tracking-wider">{alert.severity}</span></div>
                <p className="text-xs mt-1">{alert.detail}{alert.since ? ` Since ${formatDate(alert.since)}.` : ''}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Metrics Grid */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Key Metrics</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
          {overview.metrics.map(metric => (
            <div key={metric.key} className="bg-card border rounded-xl p-5 shadow-sm">
              <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{metric.label}</p>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-bold font-mono">
                  {metric.unit === 'kobo' ? formatKobo(metric.value) : metric.value}
                </span>
                {metric.unit !== 'kobo' && <span className="text-sm text-muted-foreground">{metric.unit}</span>}
              </div>
              {metric.detail && <p className="text-xs text-muted-foreground mt-2">{metric.detail}</p>}
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 print:grid-cols-2 gap-8">
        {/* Queues */}
        <section>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-warning-strong" /> Action Required
          </h2>
          <div className="bg-card border rounded-xl shadow-sm divide-y">
            {overview.queues.length === 0 && (
              <EmptyState title="Nothing in the queue">Items that need a decision, such as a proposed match or an exception past its deadline, appear here.</EmptyState>
            )}
            {overview.queues.map(queue => (
              <div key={queue.key} className="p-4 flex items-center justify-between hover:bg-secondary/50 transition-colors">
                <div>
                  <p className="font-medium text-sm">{queue.label}</p>
                  <p className="text-xs text-muted-foreground">{queue.detail}</p>
                </div>
                <div className="flex items-center justify-center bg-warning text-warning-foreground rounded-full h-8 w-8 font-bold text-sm">
                  {queue.value}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Upcoming */}
        <section>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Clock className="h-5 w-5 text-info-strong" /> Upcoming Scheduled Actions
          </h2>
          <div className="bg-card border rounded-xl shadow-sm divide-y">
            {overview.upcoming.length === 0 && (
              <EmptyState title="No scheduled actions">Retries scheduled under an approved policy appear here with the notice each one requires.</EmptyState>
            )}
            {overview.upcoming.map(record => (
              <div key={record.id} className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{record.name}</p>
                  <p className="text-xs font-mono text-muted-foreground">{record.reference || record.id}</p>
                </div>
                <div className="text-right">
                  <span className="inline-block px-2 py-1 bg-secondary text-secondary-foreground text-xs font-medium rounded">
                    {record.status.replace('_', ' ')}
                  </span>
                  <p className="text-xs text-muted-foreground mt-1">Due {formatCompactDate(String(record.data.dueDate||""))}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Activity Log */}
      <section>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Activity className="h-5 w-5 text-success" /> Recent Activity
        </h2>
        <div className="bg-card border rounded-xl shadow-sm overflow-hidden">
          <ScrollFrame label="Recent activity" className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-secondary/50 border-b text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Record</th>
                  <th className="px-4 py-3 font-medium">Action/Status</th>
                  <th className="px-4 py-3 font-medium text-right">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {overview.activity.length === 0 && (
                  <EmptyRow colSpan={4} title="No activity yet">Every action in this lender's workspace is listed here and recorded in the audit log.</EmptyRow>
                )}
                {overview.activity.map(record => (
                  <tr key={record.id} className="hover:bg-secondary/20">
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDate(record.updatedAt)}</td>
                    <td className="px-4 py-3 font-medium">
                      {record.kind}
                      <span className="block text-xs font-mono text-muted-foreground font-normal">{record.reference || record.id}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 bg-secondary text-secondary-foreground text-xs rounded-full">
                        {record.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium">
                      {record.amountKobo ? formatKobo(record.amountKobo) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFrame>
        </div>
      </section>
    </div>
  );
}
