import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, getListRecordsQueryKey, useCreateRecord } from '@workspace/api-client-react';
import { FileText, MoreHorizontal } from 'lucide-react';
import { formatKobo } from '@/lib/formatters';
import { Button } from '@/components/ui/button';
import { RecordDialog } from '@/components/record-dialog';
import { useQueryClient } from '@tanstack/react-query';

export default function MandatesPage() {
  const { merchantId } = useWorkspace();
  const [selectedMandate, setSelectedMandate] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createError, setCreateError] = useState('');
  const [draft, setDraft] = useState({
    name: '',
    customerId: '',
    amountKobo: '',
    reference: '',
    workflow: 'hosted_consent',
    consentEvidence: '',
    consentGaps: '',
    policyId: '',
    frequency: 'monthly'
  });
  const queryClient = useQueryClient();

  const { data, isLoading } = useListRecords(
    'mandates',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('mandates', { merchantId: merchantId! }) } }
  );
  const { data: customers } = useListRecords(
    'customers',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('customers', { merchantId: merchantId! }) } }
  );
  const { data: policies } = useListRecords(
    'policies',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('policies', { merchantId: merchantId! }) } }
  );
  const createMandate = useCreateRecord({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries();
        setIsCreateOpen(false);
        setCreateError('');
      },
      onError: (error: any) => setCreateError(error.message || 'Unable to create this synthetic mandate.')
    }
  });

  const handleAction = (mandate: any, action: string) => {
    setSelectedMandate(mandate);
    setActionKind(action);
    setIsDialogOpen(true);
  };

  const submitCreate = (event: React.FormEvent) => {
    event.preventDefault();
    setCreateError('');
    createMandate.mutate({
      kind: 'mandates',
      data: {
        name: draft.name,
        customerId: draft.customerId,
        amountKobo: Number(draft.amountKobo),
        reference: draft.reference,
        data: {
          workflow: draft.workflow,
          consentEvidence: draft.consentEvidence,
          consentGaps: draft.consentGaps.split('\n').map(value => value.trim()).filter(Boolean),
          policyId: draft.policyId,
          frequency: draft.frequency,
          origin: 'imported'
        }
      },
      params: { merchantId: merchantId! }
    });
  };

  if (!merchantId) return null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mandates</h1>
          <p className="text-muted-foreground mt-1">Direct debit authorizations and workflow states.</p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)}>Create synthetic mandate</Button>
      </header>

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground animate-pulse">Loading mandates...</div>
        ) : !data || data.items.length === 0 ? (
          <div className="p-16 text-center flex flex-col items-center justify-center">
            <FileText className="h-12 w-12 text-muted-foreground mb-4 opacity-20" />
            <h3 className="text-lg font-medium">No mandates</h3>
            <p className="text-muted-foreground text-sm mt-1">No authorizations found for this workspace.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground">
                <tr>
                  <th className="px-6 py-4 font-medium">Reference</th>
                  <th className="px-6 py-4 font-medium">Customer</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                  <th className="px-6 py-4 font-medium">Limit</th>
                  <th className="px-6 py-4 font-medium">Workflow</th>
                  <th className="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map(mandate => (
                  <tr key={mandate.id} className="hover:bg-secondary/10">
                    <td className="px-6 py-4 font-mono font-medium">{mandate.reference}</td>
                    <td className="px-6 py-4 font-mono text-xs text-muted-foreground">{mandate.customerId}</td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded border ${
                        mandate.status === 'active' ? 'bg-success/10 text-success border-success/20' : 'bg-secondary text-secondary-foreground'
                      }`}>
                        {mandate.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 font-mono">{formatKobo(mandate.amountKobo)}</td>
                    <td className="px-6 py-4 text-xs text-muted-foreground">{String(mandate.data?.workflow || 'Standard')}</td>
                    <td className="px-6 py-4 text-right space-x-2">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(mandate, 'mandate_suspend')}>Suspend</Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(mandate, 'mandate_cancel')}>Cancel</Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(mandate, 'mandate_reissue')}>Reissue</Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(mandate, 'activation_reminder')}>Remind</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <RecordDialog
        kind="mandates"
        record={selectedMandate}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={`Mandate Action: ${actionKind.replace('_', ' ')}`}
        actionMutation={actionKind}
        fields={[]}
      />
      <Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg">
            <Dialog.Title className="text-lg font-semibold">Create synthetic mandate</Dialog.Title>
            <p className="mt-1 text-sm text-muted-foreground">This records a sandbox mandate only; no bank instruction is sent.</p>
            <form className="mt-5 space-y-4" onSubmit={submitCreate}>
              <MandateField label="Mandate name" value={draft.name} onChange={value => setDraft({ ...draft, name: value })} required />
              <MandateSelect label="Customer" value={draft.customerId} onChange={value => setDraft({ ...draft, customerId: value })} required options={(customers?.items || []).map(customer => ({ value: customer.id, label: `${customer.name} · ${customer.reference}` }))} />
              <MandateField label="Limit (kobo)" type="number" value={draft.amountKobo} onChange={value => setDraft({ ...draft, amountKobo: value })} required />
              <MandateField label="Provider reference" value={draft.reference} onChange={value => setDraft({ ...draft, reference: value })} required />
              <MandateSelect label="Activation workflow" value={draft.workflow} onChange={value => setDraft({ ...draft, workflow: value })} required options={[{ value: 'hosted_consent', label: 'Hosted consent' }, { value: 'transfer_to_activate', label: 'Transfer to activate' }]} />
              <MandateField label="Consent evidence reference" value={draft.consentEvidence} onChange={value => setDraft({ ...draft, consentEvidence: value })} required />
              <label className="block text-sm font-medium">Consent gaps (one per line)</label>
              <textarea className="mt-1 min-h-[72px] w-full rounded-md border bg-transparent px-3 py-2 text-sm" value={draft.consentGaps} onChange={event => setDraft({ ...draft, consentGaps: event.target.value })} />
              <MandateSelect label="Policy" value={draft.policyId} onChange={value => setDraft({ ...draft, policyId: value })} required options={(policies?.items || []).map(policy => ({ value: policy.id, label: `${policy.name} · ${policy.status}` }))} />
              <MandateSelect label="Frequency" value={draft.frequency} onChange={value => setDraft({ ...draft, frequency: value })} required options={[{ value: 'monthly', label: 'Monthly' }, { value: 'weekly', label: 'Weekly' }, { value: 'quarterly', label: 'Quarterly' }]} />
              {createError && <p className="text-sm text-destructive">{createError}</p>}
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMandate.isPending}>{createMandate.isPending ? 'Saving...' : 'Create mandate'}</Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function MandateField({ label, value, onChange, required, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: 'text' | 'number' }) {
  return <label className="block text-sm font-medium">{label}{required ? ' *' : ''}<input type={type} required={required} value={value} onChange={event => onChange(event.target.value)} className="mt-1 flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm" /></label>;
}

function MandateSelect({ label, value, onChange, required, options }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; options: { value: string; label: string }[] }) {
  return <label className="block text-sm font-medium">{label}{required ? ' *' : ''}<select required={required} value={value} onChange={event => onChange(event.target.value)} className="mt-1 flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm"><option value="">Select...</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}
