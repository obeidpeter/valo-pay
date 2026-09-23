import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useGetExportJob, useListRecords, getListRecordsQueryKey, getGetExportJobQueryKey, type ExportResult } from '@workspace/api-client-react';
import { Download, RefreshCw } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { useSafeCreateExport, useSafeRetryExportJob } from '@/lib/safe-mutations';
import { Button } from './ui/button';
import { DiscardOriginalRequest } from './discard-original-request';
import { formatDate } from '@/lib/formatters';
import { notifyDone, notifyProblem, saidBy } from '@/lib/notify';
import { GetExportJobResponse } from '@workspace/api-zod';
import { Link } from 'wouter';

type Format = 'pdf' | 'csv' | 'json';
/** Jobs survive page changes and reloads. Poll only the selected lender/job; downloads always re-authorise on the server. */
export function ExportJobControl({ kind, customerId, closeReviewId, savedJobId, formats = ['pdf'], label }: { kind: string; customerId?: string; closeReviewId?: string; savedJobId?: string; formats?: Format[]; label: string }) {
  const { merchantId, workspace } = useWorkspace();
  const canCreate = !!workspace && workspace.role !== 'Read-only';
  const queryClient = useQueryClient();
  const scope = `${merchantId}:${kind}:${customerId || ''}:${closeReviewId || ''}:${savedJobId || ''}`;
  const visit = useRef({ scope });
  if (visit.current.scope !== scope) visit.current = { scope };
  const [selected, setSelected] = useState<{ scope: string; job: ExportResult } | null>(null);
  const [problem, setProblem] = useState<{ scope: string; message: string } | null>(null);
  const title = kind === 'billing' ? 'Billing CSV' : kind === 'gate-pack' ? 'Evidence pack' : kind === 'reviewed-close' ? 'Reviewed close evidence' : kind === 'closes' ? 'Close evidence' : ['customer-pack','dispute-pack'].includes(kind) ? 'Dispute pack' : 'Saved export';
  const openLabel = kind === 'billing' ? 'Open billing CSV' : `Open ${title.toLowerCase()}`;
  // Search the saved review identity before paging, then enforce the exact match.
  const params = { merchantId: merchantId!, customerId, search: closeReviewId || kind, limit: 5 };
  const recent = useListRecords('exports', params, { query: { enabled: !!merchantId && !savedJobId, queryKey: getListRecordsQueryKey('exports', params), refetchInterval: savedJobId ? false : 5000 } });
  const previous = savedJobId ? [] : recent.data?.items.filter(record => record.data.kind === kind && (!customerId || record.customerId === customerId) && (!closeReviewId || record.data.closeReviewId === closeReviewId)) || [];
  const selectedJob = selected?.scope === scope ? selected.job : undefined;
  const id = savedJobId || selectedJob?.id || previous[0]?.id || '';
  const status = useGetExportJob(id, { merchantId: merchantId! }, { query: { enabled: !!merchantId && !!id, queryKey: getGetExportJobQueryKey(id, { merchantId: merchantId! }), select: value => {
    if (!GetExportJobResponse.safeParse(value).success || value.id !== id || !['queued','running','ready','failed'].includes(value.status || '') || (value.status === 'ready' && !/^[a-f0-9]{64}$/i.test(value.checksum || ''))) throw new Error('The saved export status could not be verified. Refresh this job.');
    const download = new URL(value.downloadUrl, window.location.origin);
    if (download.origin !== window.location.origin || download.pathname !== `/api/v1/exports/${encodeURIComponent(id)}/download` || download.searchParams.get('merchantId') !== merchantId) throw new Error('The saved export download could not be verified. Refresh this job.');
    return value;
  }, refetchInterval: query => ['queued', 'running'].includes(query.state.data?.status || '') ? 1500 : false } });
  const job = status.data || selectedJob;
  const state = job?.expiredAt ? 'expired' : job?.status || (job?.checksum ? 'ready' : undefined);
  const create = useSafeCreateExport(undefined, scope);
  const retry = useSafeRetryExportJob(undefined, scope);
  const announce = (result: ExportResult, immediate = false) => {
    if (result.expiredAt || (result.status || 'ready') !== 'ready' || !result.checksum) return;
    const opened = immediate ? window.open(result.downloadUrl, '_blank') : undefined;
    notifyDone(`${title} ready`, `${immediate ? (opened ? 'The file opened in a new tab.' : 'Your browser blocked the new tab. Select Open to view the file.') : 'Select Open to view the file.'} Sample data only. SHA-256 checksum: ${result.checksum.slice(0, 16)}…`, { label: 'Open', altText: `Open the ${title.toLowerCase()} in a new tab`, onClick: () => { window.open(result.downloadUrl, '_blank'); } });
  };
  const announced = useRef(new Set<string>());
  useEffect(() => {
    if (selected?.scope === scope && state === 'ready' && job && !announced.current.has(job.id)) { announced.current.add(job.id); announce(job); }
  }, [scope, job?.id, state]);
  useEffect(() => { visit.current = { scope }; return () => { visit.current = { scope: 'unmounted' }; }; }, [scope]);
  const refresh = async () => { if (!savedJobId) await recent.refetch(); };
  const refreshStatus = () => { if (!savedJobId) void recent.refetch(); if (id) void status.refetch(); };
  const start = async (format: Format, recover = false) => {
    if (!merchantId || !canCreate || create.isPending) return;
    const submitted = visit.current; setProblem(null);
    try {
      const result = await (recover ? create.retryUnconfirmed() : create.mutateAsync({ data: { kind, format, ...(customerId ? { customerId } : {}), ...(closeReviewId ? { closeReviewId } : {}) }, params: { merchantId } }));
      if (submitted !== visit.current) return;
      setSelected({ scope, job: { ...result, kind, format } });
      queryClient.setQueryData(getGetExportJobQueryKey(result.id, { merchantId }), result);
      if ((result.status || 'ready') === 'ready') { announced.current.add(result.id); announce(result, true); }
      void refresh();
    } catch (error) {
      if (submitted === visit.current) {
        setProblem({ scope, message: saidBy(error, 'The request could not be confirmed. Check recent exports or retry the unchanged request.') });
        if (kind === 'dispute-pack') notifyProblem('Check the dispute pack request', `${saidBy(error, 'The request could not be confirmed.')} Check saved exports before starting another request.`);
      }
    }
  };
  const retrySaved = async () => {
    if (!merchantId || !canCreate || !id || retry.isPending) return;
    const submitted = visit.current; setProblem(null);
    try {
      const result = await (retry.hasUnconfirmedOutcome ? retry.retryUnconfirmed() : retry.mutateAsync({ id, params: { merchantId } }));
      if (submitted !== visit.current) return;
      setSelected({ scope, job: result }); queryClient.setQueryData(getGetExportJobQueryKey(result.id, { merchantId }), result); void refresh();
    } catch (error) { if (submitted === visit.current) setProblem({ scope, message: saidBy(error, 'The retry could not be confirmed. Check this export’s status before trying again.') }); }
  };
  if (!merchantId) return null;
  return <div className="space-y-3 min-w-0 max-w-xl">
    <div className="flex flex-wrap gap-2">
      {formats.map((format, index) => <Button key={format} variant={index === 0 ? 'outline' : 'ghost'} size="sm" disabled={!canCreate || create.isPending || retry.isPending || create.hasUnconfirmedOutcome || retry.hasUnconfirmedOutcome} busy={create.isPending && create.variables?.data.format === format} busyLabel={`Preparing ${format.toUpperCase()}…`} onClick={() => { void start(format); }}>
        {index === 0 && <Download className="h-4 w-4" />}{index === 0 ? label : format.toUpperCase()}
      </Button>)}
    </div>
    {!canCreate && <p className="text-xs text-muted-foreground">Read-only access lets you download existing files. Ask a teammate with a working role to generate or retry an export.</p>}
    {problem?.scope === scope && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm"><p className="font-medium">{title === 'Billing CSV' ? 'Billing export' : title} request could not be confirmed</p><p>{problem.message}</p><p className="mt-2">The request may have been saved. Check saved exports before starting another request.</p><Button className="mt-2" variant="outline" size="sm" onClick={refreshStatus}>Check saved exports</Button></div>}
    {(create.hasUnconfirmedOutcome || retry.hasUnconfirmedOutcome) && <div className="rounded-lg border bg-secondary/20 p-3 text-sm"><p>Other export requests are paused until this result is confirmed. Retrying checks the original request without creating a duplicate.</p><Button variant="outline" size="sm" className="mt-2" disabled={!canCreate} busy={create.isPending || retry.isPending} busyLabel="Checking original request…" onClick={() => { if (create.hasUnconfirmedOutcome) void start(create.variables!.data.format as Format, true); else void retrySaved(); }}>Retry original request</Button><DiscardOriginalRequest disabled={create.isPending || retry.isPending} onDiscard={() => { create.abandonUnconfirmed(); retry.abandonUnconfirmed(); setProblem(null); }} /></div>}
    {(recent.error || status.error) && <div role="alert" className="text-sm"><p>Saved export status could not be loaded. A job may still be running.</p><Button variant="outline" size="sm" onClick={refreshStatus}>Refresh export status</Button></div>}
    {job && <div role={state === 'failed' ? 'alert' : 'status'} className="rounded-lg border bg-card p-3 text-sm space-y-2">
      <p className="font-medium">{title} {state === 'expired' ? 'file has expired' : state === 'ready' ? 'is ready to download' : state === 'failed' ? 'could not be completed' : state === 'running' ? 'is being prepared' : 'is queued'}</p>
      {state==='expired'&&<p className="text-muted-foreground">Removed under the lender retention policy. Its checksum and deletion receipt remain available. Create a new export for current evidence.</p>}
      {(state === 'queued' || state === 'running') && <><p className="text-muted-foreground">You can leave this page. This saved job and its progress remain available when you return.</p>{job.stage && <p className="font-medium">{({queued:'Waiting for an export worker',checking:'Checking for an existing verified file',rendering:'Preparing the file contents',uploading:'Saving the private file',confirming:'File saved · confirming its download receipt',ready:'Ready to download',failed:'Generation stopped'})[job.stage]}</p>}{job.lastProgressAt && <p className="text-xs text-muted-foreground">Last progress: {formatDate(job.lastProgressAt)}</p>}</>}
      {job.stalled && (state==='queued'||state==='running') && <div role="alert" className="space-y-2 rounded-lg border border-warning-border bg-warning/10 p-3"><p className="font-medium">This export needs a status check</p><p>No recent progress was recorded, or its worker lease expired. The saved request and any completed file are retained. Recovery uses this same job and file identity.</p>{job.retryAllowed ? <Button variant="outline" size="sm" disabled={!canCreate || create.isPending || create.hasUnconfirmedOutcome || retry.hasUnconfirmedOutcome} onClick={() => { void retrySaved(); }} busy={retry.isPending}>Recover saved export</Button> : <p>{job.recoveryAt ? `The current worker can recover until ${formatDate(job.recoveryAt)}. Refresh after that time to check recovery options.` : 'The job is waiting for a worker. Ask an administrator to check the export service if progress does not resume.'}</p>}<Button variant="outline" size="sm" onClick={refreshStatus}>Check this export</Button></div>}
      {state === 'failed' && <><p>{job.error || 'Generation could not finish. Retry this saved export.'}</p><Button variant="outline" size="sm" disabled={!canCreate || create.isPending || create.hasUnconfirmedOutcome || retry.hasUnconfirmedOutcome} onClick={() => { void retrySaved(); }} busy={retry.isPending} busyLabel="Retrying…"><RefreshCw className="h-4 w-4" />Retry export</Button></>}
      {state === 'ready' && <><p className="text-xs text-muted-foreground">Sample data only{job.generatedAt ? ` · ${formatDate(job.generatedAt)}` : ''}</p><Button asChild variant="outline" size="sm"><a href={job.downloadUrl} target="_blank" rel="noopener noreferrer">{openLabel}</a></Button><details className="text-xs"><summary className="min-h-8 cursor-pointer content-center font-medium">File verification and access</summary><p className="mt-2 font-mono break-all">SHA-256: {job.checksum}</p><p className="mt-2 text-muted-foreground">Workspace access is checked on every download. An administrator may remove this file through an approved retention run after the lender’s retention period. Its checksum and deletion receipt are retained. A copy already downloaded cannot be recalled.</p></details></>}
    </div>}
    {!savedJobId && id && <Link href={`/exports?job=${encodeURIComponent(id)}`} className="inline-flex min-h-9 items-center text-xs text-primary underline">View all saved exports</Link>}
    {previous.length > 1 && <details className="text-xs"><summary className="cursor-pointer font-medium">Recent exports ({previous.length})</summary><ul className="mt-2 space-y-1">{previous.map(record => <li key={record.id}><button type="button" className="min-h-8 text-left underline" onClick={() => setSelected({ scope, job: { id: record.id, downloadUrl: `/api/v1/exports/${record.id}/download?merchantId=${merchantId}`, status: record.status as ExportResult['status'] } })}>{String(record.data.format).toUpperCase()} · {formatDate(record.createdAt)} · {record.status}</button></li>)}</ul></details>}
  </div>;
}
