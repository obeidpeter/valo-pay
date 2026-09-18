import React, { useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow } from '@/components/empty-state';
import { Loading, LoadingRow } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetGates, useListRecords, useCreateExport, getGetGatesQueryKey, getListRecordsQueryKey } from '@workspace/api-client-react';
import { ShieldCheck, Download, AlertTriangle, FileCheck, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatKobo, formatDate } from '@/lib/formatters';
import { RecordDialog } from '@/components/record-dialog';

/** The prerequisite and decision ids the gate register matches evidence on (data.gateId). */
const gateOptions = [
  { value: 'P1', label: 'P1 · Legal opinion' },
  { value: 'P2', label: 'P2 · Aggregator partner access' },
  { value: 'P3', label: 'P3 · NDPA registration and lender DPA' },
  { value: 'P4', label: 'P4 · Security and operational readiness' },
  { value: 'P5', label: 'P5 · Two design-partner lenders' },
  { value: 'F1', label: 'F1 · Test 5 operational value' },
  { value: 'F2', label: 'F2 · Test 3 commercial evidence' },
  { value: 'F3', label: 'F3 · Variable cost per collection' },
  { value: 'F4', label: 'F4 · Bridge cash in hand' },
  { value: 'T1b', label: 'T1b · Portability decision' },
  { value: 'T2', label: 'T2 · Recovery-fee decision' },
];

export default function EvidencePage() {
  const { merchantId } = useWorkspace();
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [actionKind, setActionKind] = useState<'evidence' | 'commercial' | 'reviews' | ''>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const { data: gates, isLoading: isLoadingGates } = useGetGates(
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getGetGatesQueryKey({ merchantId: merchantId! }) } }
  );

  const { data: commercial, isLoading: isLoadingComm } = useListRecords(
    'commercial',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('commercial', { merchantId: merchantId! }) } }
  );

  const { data: evidence, isLoading: isLoadingEvidence } = useListRecords(
    'evidence',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('evidence', { merchantId: merchantId! }) } }
  );

  const { data: reviews, isLoading: isLoadingReviews } = useListRecords(
    'reviews',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('reviews', { merchantId: merchantId! }) } }
  );

  const createExport = useCreateExport({
    mutation: {
      onSuccess: (data) => {
        window.open(data.downloadUrl, '_blank');
      }
    }
  });

  const handleCreate = (kind: 'evidence' | 'commercial' | 'reviews') => {
    setSelectedRecord(null);
    setActionKind(kind);
    setIsDialogOpen(true);
  };

  const handleEdit = (record: any, kind: 'evidence' | 'commercial' | 'reviews') => {
    setSelectedRecord(record);
    setActionKind(kind);
    setIsDialogOpen(true);
  };

  if (!merchantId) return null;

  return (
    <div className="space-y-8">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Evidence & Readiness</h1>
          <p className="text-muted-foreground mt-1">Prerequisites, commercial commitments, and gate verification.</p>
        </div>
        <Button 
          onClick={() => createExport.mutate({ data: { kind: 'gate-pack', format: 'pdf' }, params: { merchantId } })}
          busy={createExport.isPending}
          busyLabel="Generating…"
          className="gap-2 bg-primary text-primary-foreground"
        >
          <Download className="h-4 w-4" /> Export Gate Pack
        </Button>
      </header>

      {/* Gates */}
      <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-lg">Production Gates</h2>
          </div>
          {gates?.limitations.length ? (
            <span className="text-xs font-medium bg-destructive/10 text-destructive px-2 py-1 rounded border border-destructive/20 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> BLOCKED
            </span>
          ) : (
            <span className="text-xs font-medium bg-success/10 text-success px-2 py-1 rounded border border-success/20 flex items-center gap-1">
              <CheckCircle className="h-3 w-3" /> READY
            </span>
          )}
        </div>
        
        {isLoadingGates ? (
          <Loading what="the gates" />
        ) : !gates ? (
          <div className="p-12 text-center text-destructive">Failed to load gate data.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x">
            <div className="p-6">
              <h3 className="font-medium text-muted-foreground uppercase text-xs tracking-wider mb-4 flex justify-between">
                Prerequisites
                <Button variant="link" size="sm" className="h-auto min-h-6 p-0" onClick={() => handleCreate('evidence')}>Add Evidence</Button>
              </h3>
              <div className="space-y-4">
                {gates.prerequisites.map(gate => (
                  <div key={gate.id} className="flex gap-3">
                    {gate.status === 'proven' ? 
                      <CheckCircle className="h-5 w-5 text-success shrink-0" /> : 
                      <AlertTriangle className="h-5 w-5 text-warning-strong shrink-0" />
                    }
                    <div>
                      <p className="font-medium text-sm">{gate.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{gate.description}</p>
                      <p className="text-xs font-mono text-muted-foreground mt-1 bg-secondary/50 inline-block px-1.5 py-0.5 rounded">Evidence: {gate.evidence}</p>
                      {(evidence?.items || []).filter(item => String(item.data?.gateId || item.reference) === gate.id).map(item => (
                        <button key={item.id} type="button" className="block min-h-6 text-xs text-primary underline mt-1" onClick={() => handleEdit(item, 'evidence')}>
                          {item.name} · {item.status}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            <div className="p-6">
              <h3 className="font-medium text-muted-foreground uppercase text-xs tracking-wider mb-4">Decisions</h3>
              <div className="space-y-4">
                {gates.decisions.map(gate => (
                  <div key={gate.id} className="flex gap-3">
                    {gate.status === 'proven' ? 
                      <CheckCircle className="h-5 w-5 text-success shrink-0" /> : 
                      <AlertTriangle className="h-5 w-5 text-warning-strong shrink-0" />
                    }
                    <div>
                      <p className="font-medium text-sm">{gate.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{gate.description}</p>
                    </div>
                  </div>
                ))}
              </div>
              
              {gates.limitations.length > 0 && (
                <div className="mt-8 bg-destructive/5 border border-destructive/20 rounded-lg p-4">
                  <h4 className="text-sm font-bold text-destructive flex items-center gap-2 mb-2">
                    <AlertTriangle className="h-4 w-4" /> Missing Requirements
                  </h4>
                  <ul className="list-disc list-inside text-xs text-destructive ml-4 space-y-1">
                    {gates.limitations.map((lim, i) => <li key={i}>{lim}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Commercial Commitments */}
      <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCheck className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-lg">Commercial Commitments</h2>
          </div>
          <Button size="sm" onClick={() => handleCreate('commercial')}>Add Terms</Button>
        </div>
        <ScrollFrame label="Commercial commitments" className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-secondary/30 border-b text-muted-foreground">
              <tr>
                <th className="px-6 py-4 font-medium">Prospect</th>
                <th className="px-6 py-4 font-medium">Monthly Vol</th>
                <th className="px-6 py-4 font-medium">Avg Ticket</th>
                <th className="px-6 py-4 font-medium">Licence</th>
                <th className="px-6 py-4 font-medium">Usage Terms</th>
                <th className="px-6 py-4 font-medium">Status</th>
                <th className="px-6 py-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoadingComm ? (
                <LoadingRow colSpan={7} what="commercial commitments" />
              ) : !commercial || commercial.items.length === 0 ? (
                <EmptyRow colSpan={7} title="No commercial commitments">Signed design-partner terms, licence tiers and pricing commitments are recorded here as evidence for the gate.</EmptyRow>
              ) : (
                commercial.items.map(comm => (
                  <tr key={comm.id} className="hover:bg-secondary/10">
                    <td className="px-6 py-4 font-medium">{comm.name}</td>
                    <td className="px-6 py-4 font-mono">{Number(comm.data?.monthlyVolume || 0).toLocaleString()}</td>
                    <td className="px-6 py-4 font-mono">{formatKobo(Number(comm.data?.averageTicketKobo || 0))}</td>
                    <td className="px-6 py-4 font-mono">{formatKobo(Number(comm.data?.licenceKobo || 0))}</td>
                    <td className="px-6 py-4 font-mono text-xs text-muted-foreground">
                      {String(comm.data?.usageBps || 30)} bps (Cap: {formatKobo(Number(comm.data?.usageCapKobo || 15000))})
                    </td>
                    <td className="px-6 py-4">
                      {comm.data?.signed ? (
                        <span className="text-success text-xs font-bold flex items-center gap-1"><CheckCircle className="h-3 w-3" /> SIGNED</span>
                      ) : (
                        <span className="text-warning-strong text-xs font-bold">NEGOTIATING</span>
                      )}
                      {!!comm.data?.effectiveDate && <p className="text-[10px] text-muted-foreground mt-1">From {formatDate(String(comm.data.effectiveDate))}</p>}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Button size="sm" variant="outline" onClick={() => handleEdit(comm, 'commercial')}>Edit</Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </ScrollFrame>
      </section>

      {/* Fortnightly Reviews */}
      <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCheck className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-lg">Fortnightly Reviews</h2>
          </div>
          <Button size="sm" onClick={() => handleCreate('reviews')}>Log Review</Button>
        </div>
        <ScrollFrame label="Fortnightly reviews" className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-secondary/30 border-b text-muted-foreground">
              <tr>
                <th className="px-6 py-4 font-medium">Review Date</th>
                <th className="px-6 py-4 font-medium">Reviewer</th>
                <th className="px-6 py-4 font-medium">Confirmed Jobs</th>
                <th className="px-6 py-4 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoadingReviews ? (
                <LoadingRow colSpan={4} what="reviews" />
              ) : !reviews || reviews.items.length === 0 ? (
                <EmptyRow colSpan={4} title="No reviews logged">A fortnightly confirmation by a named reviewer is logged here, and the cadence check counts them (MEA-05).</EmptyRow>
              ) : (
                reviews.items.map(rev => (
                  <tr key={rev.id} className="hover:bg-secondary/10">
                    <td className="px-6 py-4 font-mono text-xs">{formatDate(String(rev.data?.reviewedAt || rev.createdAt))}</td>
                    <td className="px-6 py-4 font-medium">{String(rev.data?.reviewer || 'Unknown')}</td>
                    <td className="px-6 py-4 font-mono text-xs">{String(rev.data?.confirmedJobs || 0)}</td>
                    <td className="px-6 py-4 text-xs text-muted-foreground">{String(rev.data?.note || '-')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </ScrollFrame>
      </section>

      <RecordDialog
        kind={actionKind || 'evidence'}
        record={selectedRecord}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={selectedRecord ? `Edit ${actionKind}` : `Add ${actionKind}`}
        fields={
          actionKind === 'evidence' ? [
            { name: 'name', label: 'Evidence title', type: 'text', required: true },
            { name: 'gateId', label: 'Prerequisite or decision it evidences', type: 'select', isData: true, required: true, options: gateOptions },
            { name: 'status', label: 'Status', type: 'select', options: [{label: 'Pending', value: 'pending'}, {label: 'Recorded', value: 'recorded'}], required: true },
            { name: 'reference', label: 'Reference URL / ID', type: 'text', isData: true, required: true },
            { name: 'notes', label: 'Notes', type: 'textarea', isData: true }
          ] : actionKind === 'commercial' ? [
            { name: 'name', label: 'Prospect Name', type: 'text', required: true },
            { name: 'monthlyVolume', label: 'Monthly Volume', type: 'number', isData: true, required: true },
            { name: 'averageTicketKobo', label: 'Avg Ticket (Kobo)', type: 'number', isData: true, required: true },
            { name: 'licenceKobo', label: 'Licence (Kobo)', type: 'number', isData: true, required: true },
            { name: 'usageBps', label: 'Usage Bps', type: 'number', isData: true, required: true },
            { name: 'usageCapKobo', label: 'Usage Cap (Kobo)', type: 'number', isData: true, required: true },
            { name: 'signed', label: 'Signed', type: 'checkbox', isData: true }
          ] : actionKind === 'reviews' ? [
            { name: 'name', label: 'Review Name', type: 'text', required: true },
            { name: 'reviewer', label: 'Reviewer Name', type: 'text', isData: true, required: true },
            { name: 'confirmedJobs', label: 'Confirmed Jobs', type: 'number', isData: true, required: true },
            { name: 'note', label: 'Notes', type: 'textarea', isData: true, required: true }
          ] : []
        }
      />
    </div>
  );
}
