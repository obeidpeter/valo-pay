import React, { useState } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetGates, useListRecords, useCreateExport, getGetGatesQueryKey, getListRecordsQueryKey } from '@workspace/api-client-react';
import { ShieldCheck, Download, AlertTriangle, FileCheck, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatKobo, formatDate } from '@/lib/formatters';
import { RecordDialog } from '@/components/record-dialog';

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
          disabled={createExport.isPending}
          className="gap-2 bg-primary text-primary-foreground"
        >
          <Download className="h-4 w-4" /> {createExport.isPending ? 'Generating...' : 'Export Gate Pack'}
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
          <div className="p-12 text-center text-muted-foreground animate-pulse">Loading gates...</div>
        ) : !gates ? (
          <div className="p-12 text-center text-destructive">Failed to load gate data.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x">
            <div className="p-6">
              <h3 className="font-medium text-muted-foreground uppercase text-xs tracking-wider mb-4 flex justify-between">
                Prerequisites
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => handleCreate('evidence')}>Add Evidence</Button>
              </h3>
              <div className="space-y-4">
                {gates.prerequisites.map(gate => (
                  <div key={gate.id} className="flex gap-3">
                    {gate.status === 'proven' ? 
                      <CheckCircle className="h-5 w-5 text-success shrink-0" /> : 
                      <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
                    }
                    <div>
                      <p className="font-medium text-sm">{gate.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{gate.description}</p>
                      <p className="text-xs font-mono text-muted-foreground mt-1 bg-secondary/50 inline-block px-1.5 py-0.5 rounded">Evidence: {gate.evidence}</p>
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
                      <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
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
                  <ul className="list-disc list-inside text-xs text-destructive/80 ml-4 space-y-1">
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
        <div className="overflow-x-auto">
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
                <tr><td colSpan={7} className="px-6 py-8 text-center text-muted-foreground animate-pulse">Loading...</td></tr>
              ) : !commercial || commercial.items.length === 0 ? (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-muted-foreground">No commercial records found.</td></tr>
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
                        <span className="text-amber-600 text-xs font-bold">NEGOTIATING</span>
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
        </div>
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
        <div className="overflow-x-auto">
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
                <tr><td colSpan={4} className="px-6 py-8 text-center text-muted-foreground animate-pulse">Loading...</td></tr>
              ) : !reviews || reviews.items.length === 0 ? (
                <tr><td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">No reviews logged.</td></tr>
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
        </div>
      </section>

      <RecordDialog
        kind={actionKind || 'evidence'}
        record={selectedRecord}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={selectedRecord ? `Edit ${actionKind}` : `Add ${actionKind}`}
        fields={
          actionKind === 'evidence' ? [
            { name: 'name', label: 'Requirement (e.g. P1)', type: 'text', required: true },
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
