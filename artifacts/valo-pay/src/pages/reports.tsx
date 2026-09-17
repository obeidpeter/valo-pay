import React, { useState } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetReports, usePerformAction, getGetReportsQueryKey, useCreateExport, useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { BarChart3, Download, FileText, CheckSquare, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatKobo, formatDate } from '@/lib/formatters';
import { RecordDialog } from '@/components/record-dialog';

export default function ReportsPage() {
  const { merchantId } = useWorkspace();
  const [experimentDialog, setExperimentDialog] = useState<'create' | 'edit' | 'preregister' | null>(null);
  const [selectedExperiment, setSelectedExperiment] = useState<any>(null);

  const { data: reports, isLoading, refetch } = useGetReports(
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getGetReportsQueryKey({ merchantId: merchantId! }) } }
  );

  const dailyClose = usePerformAction({
    mutation: {
      onSuccess: () => refetch()
    }
  });

  const { data: experiments } = useListRecords(
    'experiments',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('experiments', { merchantId: merchantId! }) } }
  );
  const { data: policies } = useListRecords(
    'policies',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('policies', { merchantId: merchantId! }) } }
  );

  const createExport = useCreateExport({
    mutation: {
      onSuccess: (data) => {
        window.open(data.downloadUrl, '_blank');
      }
    }
  });

  if (!merchantId) return null;
  const approvedPolicyOptions = (policies?.items || [])
    .filter(policy => policy.status === 'approved')
    .map(policy => ({ label: `${policy.name} · v${String(policy.data?.version || 1)}`, value: policy.id }));
  const openExperimentDialog = (mode: 'create' | 'edit' | 'preregister', experiment?: any) => {
    setSelectedExperiment(experiment || null);
    setExperimentDialog(mode);
  };

  return (
    <div className="space-y-8">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports & Analytics</h1>
          <p className="text-muted-foreground mt-1">Daily closes, billing, and operational measurement.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            variant="outline" 
            className="gap-2"
            onClick={() => createExport.mutate({ data: { kind: 'billing', format: 'csv' }, params: { merchantId } })}
            disabled={createExport.isPending}
          >
            <Download className="h-4 w-4" /> Export Billing CSV
          </Button>
          <Button 
            className="gap-2"
            onClick={() => dailyClose.mutate({ data: { action: 'daily_close' }, params: { merchantId } })}
            disabled={dailyClose.isPending}
          >
            <RefreshCcw className="h-4 w-4" /> Trigger Daily Close
          </Button>
        </div>
      </header>

      {isLoading ? (
        <div className="p-12 text-center text-muted-foreground animate-pulse">Generating reports...</div>
      ) : !reports ? (
        <div className="p-12 text-center text-destructive">Failed to generate reports.</div>
      ) : (
        <div className="space-y-8">
          {/* Top Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-card border rounded-xl p-5 shadow-sm">
               <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Confirmed Jobs</p>
               <div className="mt-2 text-3xl font-bold font-mono">{String(reports.operational?.confirmedJobs || 0)}</div>
            </div>
            <div className="bg-card border rounded-xl p-5 shadow-sm">
               <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Required Audit Sample</p>
               <div className="mt-2 text-3xl font-bold font-mono">{String(reports.operational?.requiredAuditSample || 0)}</div>
            </div>
            <div className="bg-card border rounded-xl p-5 shadow-sm">
               <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Live Days</p>
               <div className="mt-2 text-3xl font-bold font-mono">{String(reports.operational?.liveDays || 0)}</div>
            </div>
            <div className="bg-card border rounded-xl p-5 shadow-sm">
               <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Real Cases Used</p>
               <div className="mt-2 text-3xl font-bold font-mono">
                 {String(reports.operational?.realCasesUsed || 0)} / {String(reports.operational?.requiredRealCases || 5)}
               </div>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {reports.metrics.map(metric => (
              <div key={metric.key} className="bg-card border rounded-xl p-5 shadow-sm">
                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{metric.label}</p>
                <div className="mt-2 text-3xl font-bold font-mono">
                  {metric.unit === 'kobo' ? formatKobo(metric.value) : metric.value}
                  {metric.unit !== 'kobo' && <span className="text-sm text-muted-foreground ml-1">{metric.unit}</span>}
                </div>
                {metric.detail && <p className="text-xs text-muted-foreground mt-2">{metric.detail}</p>}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Billing Statement Preview */}
            <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                <h2 className="font-semibold">Billing Statement (Current Period)</h2>
              </div>
              <div className="p-6">
                <div className="space-y-4 font-mono text-sm">
                  {Object.entries(reports.billing || {}).map(([key, value]) => (
                    <div key={key} className="flex justify-between items-baseline border-b border-dashed border-border pb-2">
                      <span className="capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                      <span className="font-bold">{typeof value === 'number' && key.toLowerCase().includes('kobo') ? formatKobo(value) : String(value)}</span>
                    </div>
                  ))}
                  {Object.keys(reports.billing || {}).length === 0 && (
                    <p className="text-muted-foreground text-center py-4">No billing data available.</p>
                  )}
                </div>
              </div>
            </section>

            {/* Experiment Results */}
            <section className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
              <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-primary" />
                  <h2 className="font-semibold">Recovery Experiment</h2>
                </div>
                <Button size="sm" onClick={() => openExperimentDialog('create')}>New experiment</Button>
              </div>
              <div className="p-6 flex-1 overflow-auto">
                <div className="space-y-4">
                  {(experiments?.items || []).map(experiment => (
                    <div key={experiment.id} className="border rounded-lg p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{experiment.name}</p>
                          <p className="text-xs text-muted-foreground">{experiment.status} · holdout {String(experiment.data?.holdoutShare ?? '')}</p>
                        </div>
                        {experiment.status === 'draft' && (
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" onClick={() => openExperimentDialog('edit', experiment)}>Edit</Button>
                            <Button size="sm" onClick={() => openExperimentDialog('preregister', experiment)}>Preregister</Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {Object.entries(reports.experiment || {}).map(([key, value]) => (
                    <div key={key} className="bg-secondary/30 p-3 rounded-lg flex justify-between items-center">
                      <span className="text-sm font-medium capitalize text-muted-foreground">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                      <span className={`font-mono text-sm font-bold ${String(value) === 'not_proven' ? 'text-amber-600' : ''}`}>
                        {String(value)}
                      </span>
                    </div>
                  ))}
                  {Object.keys(reports.experiment || {}).length === 0 && (
                    <p className="text-muted-foreground text-center py-4">No active experiments.</p>
                  )}
                </div>
              </div>
            </section>
          </div>

          {/* Daily Closes */}
          <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckSquare className="h-5 w-5 text-primary" />
                <h2 className="font-semibold">Daily Close Snapshots</h2>
              </div>
            </div>
            <div className="overflow-x-auto max-h-[400px]">
              <table className="w-full text-sm text-left">
                <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                  <tr>
                    <th className="px-6 py-4 font-medium">Date</th>
                    <th className="px-6 py-4 font-medium">Summary</th>
                    <th className="px-6 py-4 font-medium">Metrics</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {reports.closes.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-6 py-8 text-center text-muted-foreground">No close snapshots available.</td>
                    </tr>
                  ) : (
                    reports.closes.map(close => (
                      <tr key={close.id} className="hover:bg-secondary/10">
                        <td className="px-6 py-4 font-mono text-xs">{formatDate(close.createdAt)}</td>
                        <td className="px-6 py-4 text-muted-foreground">{String(close.data?.summary || '')}</td>
                        <td className="px-6 py-4 font-mono text-xs">
                          {Object.entries(close.data?.metrics || {}).map(([k, v]) => (
                            <span key={k} className="inline-block mr-3 mb-1 bg-secondary/30 px-1.5 py-0.5 rounded border border-border/50">
                              <span className="text-muted-foreground mr-1">{k.replace(/([A-Z])/g, ' $1').trim().toLowerCase()}:</span>
                              <span className="font-medium">{typeof v === 'number' && k.toLowerCase().includes('kobo') ? formatKobo(v) : String(v)}</span>
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

        </div>
      )}
      <RecordDialog
        kind="experiments"
        record={selectedExperiment}
        isOpen={experimentDialog !== null}
        onOpenChange={(open) => { if (!open) setExperimentDialog(null); }}
        title={experimentDialog === 'preregister' ? 'Preregister experiment' : experimentDialog === 'edit' ? 'Edit experiment draft' : 'Create experiment draft'}
        actionMutation={experimentDialog === 'preregister' ? 'preregister_experiment' : undefined}
        fields={experimentDialog === 'preregister' ? [] : [
          { name: 'name', label: 'Experiment name', type: 'text', required: true },
          { name: 'status', label: 'Status', type: 'select', options: [{ label: 'Draft', value: 'draft' }], required: true },
          { name: 'baselineRate', label: 'Baseline rate', type: 'number', isData: true, required: true },
          { name: 'holdoutShare', label: 'Holdout share (0.1–0.5)', type: 'number', isData: true, required: true },
          { name: 'minPerArm', label: 'Minimum per arm', type: 'number', isData: true, required: true },
          { name: 'analysisDate', label: 'Analysis date (YYYY-MM-DD)', type: 'text', isData: true, required: true },
          { name: 'enrolmentClose', label: 'Enrolment close (YYYY-MM-DD)', type: 'text', isData: true, required: true },
          { name: 'seed', label: 'Assignment seed', type: 'text', isData: true, required: true },
          { name: 'policyId', label: 'Approved policy', type: 'select', options: approvedPolicyOptions, isData: true, required: true }
        ]}
        defaultValues={{ status: 'draft' }}
      />
    </div>
  );
}
