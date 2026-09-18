import React, { useState } from 'react';
import { FieldError, FormAlert, attentionTitle, focusField, invalidProps, missingMessage, serverFieldErrors } from '@/components/form-field';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import * as Dialog from '@radix-ui/react-dialog';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, getListRecordsQueryKey, useCreateRecord } from '@workspace/api-client-react';
import { MoreHorizontal } from 'lucide-react';
import { formatKobo } from '@/lib/formatters';
import { Button } from '@/components/ui/button';
import { RecordDialog } from '@/components/record-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { activationWorkflows, mandateFrequencies } from '@workspace/valopay-schema';

export default function MandatesPage() {
  const { merchantId } = useWorkspace();
  const [selectedMandate, setSelectedMandate] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  /** The fields the form asks for, in order, with the words a missing value is named by. */
  const requiredFields: Array<{ name: keyof typeof draft; label: string; type: 'text' | 'number' | 'select' }> = [
    { name: 'name', label: 'Mandate name', type: 'text' }, { name: 'customerId', label: 'Customer', type: 'select' }, { name: 'amountKobo', label: 'Limit (kobo)', type: 'number' },
    { name: 'reference', label: 'Provider reference', type: 'text' }, { name: 'workflow', label: 'Activation workflow', type: 'select' }, { name: 'consentEvidence', label: 'Consent evidence reference', type: 'text' },
    { name: 'policyId', label: 'Policy', type: 'select' }, { name: 'frequency', label: 'Frequency', type: 'select' },
  ];
  const change = (name: keyof typeof draft, value: string) => {
    setDraft(current => ({ ...current, [name]: value }));
    setFieldErrors(prev => { if (!prev[name]) return prev; const next = { ...prev }; delete next[name]; return next; });
  };
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
  const approvedVersionOptions = (policies?.items || []).filter(policy => policy.status === 'approved').map(policy => ({ value: policy.id, label: `${policy.name} · v${String(policy.data?.version || 1)}` }));
  const createMandate = useCreateRecord({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries();
        setIsCreateOpen(false);
        setFieldErrors({}); setFormErrors([]);
      },
      onError: (error: unknown) => {
        const { fields, general } = serverFieldErrors(error, path => { const name = path.replace(/^data\./, ''); return requiredFields.some(field => field.name === name) ? name : null; });
        setFieldErrors(fields); setFormErrors(general);
        const first = requiredFields.find(field => fields[field.name]);
        if (first) focusField(`mandate-${first.name}`);
      }
    }
  });

  const handleAction = (mandate: any, action: string) => {
    setSelectedMandate(mandate);
    setActionKind(action);
    setIsDialogOpen(true);
  };

  const submitCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const errors: Record<string, string> = {};
    for (const field of requiredFields) {
      const value = String(draft[field.name] ?? '').trim();
      if (!value) errors[field.name] = missingMessage(field.label, field.type);
      else if (field.type === 'number' && !Number.isFinite(Number(value))) errors[field.name] = `Enter ${field.label} as a number.`;
    }
    setFieldErrors(errors); setFormErrors([]);
    const first = requiredFields.find(field => errors[field.name]);
    if (first) { focusField(`mandate-${first.name}`); return; }
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
          <Loading what="mandates" />
        ) : !data || data.items.length === 0 ? (
          <EmptyState title="No mandates yet" action={<Button size="sm" variant="outline" onClick={() => setIsCreateOpen(true)}>Create synthetic mandate</Button>}>
            Mandates arrive from your loan software by API or CSV. In the sandbox you can create a synthetic one to see the activation workflow.
          </EmptyState>
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
                      {mandate.status === 'active' && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(mandate, 'mandate_suspend')}>Suspend</Button>}
                      {mandate.status === 'suspended' && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(mandate, 'mandate_reinstate')}>Reinstate</Button>}
                      {['draft', 'submitted', 'pending_activation', 'active', 'suspended'].includes(mandate.status) && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(mandate, 'mandate_cancel')}>Cancel</Button>}
                      {['pending_activation', 'expired', 'cancelled', 'failed'].includes(mandate.status) && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(mandate, 'mandate_reissue')}>Reissue</Button>}
                      {mandate.status === 'pending_activation' && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleAction(mandate, 'activation_reminder')}>Remind</Button>}
                      {['active', 'suspended', 'pending_activation'].includes(mandate.status) && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => handleAction(mandate, 'notify_policy_change')}>Notify policy change</Button>}
                      {['active', 'suspended', 'pending_activation'].includes(mandate.status) && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => handleAction(mandate, 'apply_policy_version')}>Apply policy version</Button>}
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
        fields={actionKind === 'mandate_reissue' ? [{ name: 'consentEvidence', label: 'New consent evidence reference (MAN-06: a re-issue is a new mandate with a new consent record)', type: 'text', isData: true, required: true }]
          : actionKind === 'notify_policy_change' ? [{ name: 'policyId', label: 'Approved policy version to notify (RET-07; the sandbox records a simulated notice, not evidence)', type: 'select', isData: true, required: true, options: approvedVersionOptions }]
          : actionKind === 'apply_policy_version' ? [
            { name: 'policyId', label: 'Approved policy version to apply', type: 'select', isData: true, required: true, options: approvedVersionOptions },
            { name: 'noticeId', label: 'Provider-accepted policy-change notice id (optional; the latest accepted notice for this version is used when blank)', type: 'text', isData: true },
            { name: 'consentEvidence', label: 'Fresh consent evidence (required when the merchant terms require consent for a policy change)', type: 'text', isData: true },
          ] : []}
      />
      <Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg">
            <Dialog.Title className="text-lg font-semibold">Create synthetic mandate</Dialog.Title>
            <p className="mt-1 text-sm text-muted-foreground">This records a sandbox mandate only; no bank instruction is sent.</p>
            <form noValidate className="mt-5 space-y-4" onSubmit={submitCreate}>
              {(formErrors.length > 0 || Object.keys(fieldErrors).length > 0) && (
                <FormAlert title={formErrors[0] ?? attentionTitle(Object.keys(fieldErrors).length)}>{formErrors.slice(1).map(message => <p key={message}>{message}</p>)}</FormAlert>
              )}
              <MandateField label="Mandate name" value={draft.name} id="mandate-name" error={fieldErrors.name} onChange={value => change('name', value)} required />
              <MandateSelect label="Customer" value={draft.customerId} id="mandate-customerId" error={fieldErrors.customerId} onChange={value => change('customerId', value)} required options={(customers?.items || []).map(customer => ({ value: customer.id, label: `${customer.name} · ${customer.reference}` }))} />
              <MandateField label="Limit (kobo)" type="number" value={draft.amountKobo} id="mandate-amountKobo" error={fieldErrors.amountKobo} onChange={value => change('amountKobo', value)} required />
              <MandateField label="Provider reference" value={draft.reference} id="mandate-reference" error={fieldErrors.reference} onChange={value => change('reference', value)} required />
              <MandateSelect label="Activation workflow" value={draft.workflow} id="mandate-workflow" error={fieldErrors.workflow} onChange={value => change('workflow', value)} required options={activationWorkflows.map(workflow => ({ value: workflow, label: workflow.replaceAll('_', ' ') }))} />
              <MandateField label="Consent evidence reference" value={draft.consentEvidence} id="mandate-consentEvidence" error={fieldErrors.consentEvidence} onChange={value => change('consentEvidence', value)} required />
              <label className="block text-sm font-medium">Consent gaps (one per line)</label>
              <textarea className="mt-1 min-h-[72px] w-full rounded-md border bg-transparent px-3 py-2 text-sm" value={draft.consentGaps} onChange={event => setDraft({ ...draft, consentGaps: event.target.value })} />
              <MandateSelect label="Policy" value={draft.policyId} id="mandate-policyId" error={fieldErrors.policyId} onChange={value => change('policyId', value)} required options={(policies?.items || []).map(policy => ({ value: policy.id, label: `${policy.name} · ${policy.status}` }))} />
              <MandateSelect label="Frequency" value={draft.frequency} id="mandate-frequency" error={fieldErrors.frequency} onChange={value => change('frequency', value)} required options={mandateFrequencies.map(frequency => ({ value: frequency, label: frequency.charAt(0).toUpperCase() + frequency.slice(1) }))} />
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
                <Button type="submit" busy={createMandate.isPending} busyLabel="Saving…">Create mandate</Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

type MandateControl = { id: string; label: string; value: string; onChange: (value: string) => void; required?: boolean; error?: string };
const controlClass = 'mt-1 flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function MandateField({ id, label, value, onChange, required, error, type = 'text' }: MandateControl & { type?: 'text' | 'number' }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}{required ? ' *' : ''}</label>
      <input id={id} type={type} required={required} value={value} onChange={event => onChange(event.target.value)} className={controlClass} {...invalidProps(id, error)} />
      <FieldError id={id} message={error} />
    </div>
  );
}

function MandateSelect({ id, label, value, onChange, required, error, options }: MandateControl & { options: { value: string; label: string }[] }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}{required ? ' *' : ''}</label>
      <select id={id} required={required} value={value} onChange={event => onChange(event.target.value)} className={controlClass} {...invalidProps(id, error)}>
        <option value="">Select…</option>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <FieldError id={id} message={error} />
    </div>
  );
}
