import { Link, useSearchParams } from 'wouter';
import { useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/lib/workspace-context';
import { ExportJobControl, exportKindTitle, exportStatusLabel, exportStatusLabels } from '@/components/export-job-control';
import { PilotError, PilotHeading, PilotPanel, pilotField } from '@/components/pilot-ui';
import { readableLabel } from '@/components/record-label';
import { Button } from '@/components/ui/button';
import { PageButtons } from '@/components/record-pagination';
import { keepRowsWhilePaging } from '@/lib/use-record-pagination';
import { formatDate, formatNumber } from '@/lib/formatters';

/** A saved export named by what it holds and its format ("Dispute pack · JSON"), not by its machine name ("dispute-pack · JSON"). */
function exportName(record: { name: string; data: Record<string, unknown> }): string {
  const kind = String(record.data.kind || ''), format = String(record.data.format || '').toUpperCase();
  if (!kind) return record.name;
  const what = exportKindTitle(kind, readableLabel(kind));
  return format && !what.toUpperCase().endsWith(` ${format}`) ? `${what} · ${format}` : what;
}

export default function ExportsPage() {
  const { merchantId } = useWorkspace();
  return <SavedExports key={merchantId} />;
}
function SavedExports() {
  const { merchantId } = useWorkspace(), [params, setParams] = useSearchParams();
  const requested = params.get('job') || '', status = ['queued','running','ready','failed'].includes(params.get('status') || '') ? params.get('status')! : 'all';
  const parsedOffset = Number(params.get('offset') || 0), offset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
  const query = { merchantId: merchantId!, status, offset, limit: 25 };
  // Paging keeps the jobs shown, and so the page buttons and the one pressed, until the next page arrives.
  const listKey = getListRecordsQueryKey('exports', query), client = useQueryClient();
  const list = useListRecords('exports', query, { query: { enabled: !!merchantId, queryKey: listKey, placeholderData: keepRowsWhilePaging(listKey, client), refetchInterval: 5000 } });
  const exact = { merchantId: merchantId!, id: requested, limit: 1 };
  const focused = useListRecords('exports', exact, { query: { enabled: !!merchantId && !!requested, queryKey: getListRecordsQueryKey('exports', exact) } });
  const selected = requested ? focused.data?.items.find(item => item.id === requested && item.merchantId === merchantId) : list.data?.items[0];
  const change = (nextStatus: string, nextOffset: number) => setParams(new URLSearchParams({ status: nextStatus, offset: String(nextOffset) }));
  const statusOptions = [['all','All exports'],...Object.entries(exportStatusLabels)];
  return <div className="space-y-6">
    <PilotHeading title="Saved exports">Check file preparation, recover stalled jobs and download verified evidence for the selected lender. Retrying keeps the original job and file identity.</PilotHeading>
    <PilotError error={list.error || focused.error} retry={() => { void list.refetch(); if(requested)void focused.refetch(); }} />
    <div className="flex flex-wrap items-end justify-between gap-3"><label className="space-y-2 text-sm font-medium">Export status<select className={pilotField} value={status} onChange={event => change(event.target.value, 0)}>{statusOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><Button variant="outline" onClick={() => { void list.refetch(); if(requested)void focused.refetch(); }}>Refresh saved exports</Button></div>
    {list.isLoading && <p role="status">Loading saved export jobs…</p>}
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(16rem,1fr)_minmax(0,1.5fr)]">
      <PilotPanel title="Export history">{list.data && !list.data.items.length ? <p className="text-sm text-muted-foreground">No exports on this page. Generate evidence from its customer, report or approved close. An empty filtered list does not mean there are no exports in this lender.</p> : <ul className="max-h-[36rem] space-y-2 overflow-y-auto p-1">{list.data?.items.map(record=><li key={record.id}><Link href={`/exports?status=${status}&offset=${offset}&job=${encodeURIComponent(record.id)}`} aria-current={selected?.id===record.id?'page':undefined} className={`block rounded-lg border p-3 text-sm ${selected?.id===record.id?'border-primary bg-primary/5':''}`}><p className="font-semibold break-words">{exportName(record)}</p><p className="mt-1 text-xs text-muted-foreground">{formatDate(record.createdAt)} · {exportStatusLabel(record)}</p></Link></li>)}</ul>}
      {!!list.data && <nav aria-label="Export history pages" className="space-y-2"><p className="text-xs text-muted-foreground">{formatNumber(list.data.items.length?offset+1:0)}–{formatNumber(Math.min(offset+(list.data.items.length||0),list.data.total))} of {formatNumber(list.data.total)}</p><div className="flex gap-2"><PageButtons label="saved exports" busy={list.isPlaceholderData} atStart={offset===0} atEnd={offset+25>=list.data.total} onPrevious={()=>change(status,Math.max(0,offset-25))} onNext={()=>change(status,offset+25)} previous="Previous exports" next="Next exports" /></div></nav>}</PilotPanel>
      <PilotPanel title="Selected export">{requested&&focused.isLoading?<p role="status">Checking this export’s lender access…</p>:selected?<><p className="break-words text-sm font-semibold">{exportName(selected)}</p><p className="break-all font-mono text-xs text-muted-foreground">Request: {selected.id}</p><ExportJobControl key={`${merchantId}:${selected.id}`} kind={String(selected.data.kind)} savedJobId={selected.id} formats={[]} label="Saved export" /></>:<p className="text-sm text-muted-foreground">{requested?'This export was not found in the selected lender. Choose an export from this lender’s history.':'Select a saved export to see its progress and available actions.'}</p>}</PilotPanel>
    </div>
  </div>;
}
