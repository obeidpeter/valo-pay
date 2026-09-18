import React, { useState, useEffect, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from './ui/button';
import { FieldError, FormAlert, attentionTitle, focusField, formErrorMessage, invalidProps, missingMessage, serverFieldErrors } from './form-field';
import { useCreateRecord, useUpdateRecord, usePerformAction } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/lib/workspace-context';
import { readableLabel } from './record-label';
import { formatDate } from '@/lib/formatters';

const actionLabels: Record<string, string> = {
  mandate_suspend: 'Suspend mandate', mandate_cancel: 'Cancel mandate', mandate_reinstate: 'Resume mandate',
  mandate_reissue: 'Reissue mandate', activation_reminder: 'Record activation reminder',
  notify_policy_change: 'Record policy change notice', apply_policy_version: 'Apply policy version',
  submit_policy: 'Submit for review', approve_policy: 'Approve policy', reject_policy: 'Reject policy',
  new_policy_version: 'Create draft version', submit_template: 'Submit for review', approve_template: 'Approve template',
  confirm_allocation: 'Confirm allocation', reject_allocation: 'Reject allocation', manual_allocate: 'Allocate payment',
  review_allocation: 'Record review', resolve_exception: 'Resolve exception', record_refund: 'Record external refund',
  simulate_failure: 'Simulate failure', backtest_policy: 'Run policy simulation',
  preregister_experiment: 'Register experiment plan', hand_back: 'Return collection ownership', issue_invoice: 'Issue invoice',
};

type FieldDef = {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'textarea' | 'checkbox' | 'date';
  options?: { label: string; value: string }[];
  isData?: boolean; // if true, placed in record.data
  required?: boolean;
};

type RecordDialogProps = {
  kind: string;
  record?: any; // If provided, edit mode. Otherwise, create mode.
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  fields: FieldDef[];
  title: string;
  defaultValues?: any;
  actionMutation?: string; // If provided, calls performAction with this action name instead of create/update
};

export function RecordDialog({ kind, record, isOpen, onOpenChange, fields, title, defaultValues = {}, actionMutation }: RecordDialogProps) {
  const { merchantId } = useWorkspace();
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState<any>({});
  const [result,setResult]=useState<any>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const fieldId = (name: string) => `record-${name}`;
  /** The server names a field by its path in the body; a data field arrives as data.<name>. */
  const resolveField = (path: string): string | null => {
    const name = path.replace(/^data\./, '');
    return fields.some(f => f.name === name) || (actionMutation && name === 'reason') ? name : null;
  };
  const firstNamed = (errors: Record<string, string>) => fields.find(f => errors[f.name])?.name ?? (errors.reason ? 'reason' : undefined);
  const applyServerError = (error: unknown) => {
    const { fields: named, general } = serverFieldErrors(error, resolveField);
    setFieldErrors(named); setFormErrors(general.map(message => formErrorMessage(message, fields)));
    const first = firstNamed(named);
    if (first) focusField(fieldId(first));
  };
  
  useEffect(() => {
    if (isOpen) {
      setResult(null); setFieldErrors({}); setFormErrors([]);
      create.reset();update.reset();perform.reset();
      if (record) {
        const initial: any = { ...defaultValues, name: record.name, status: record.status, reference: record.reference, amountKobo: record.amountKobo, customerId: record.customerId };
        fields.forEach(f => {
          // A field the record does not carry keeps its default instead of becoming undefined.
          if (f.isData && record.data && record.data[f.name] !== undefined) {
            initial[f.name] = record.data[f.name];
          }
        });
        setFormData(initial);
      } else {
        setFormData(defaultValues);
      }
    }
  // Initialise once per opening/record. Inline field arrays must not reset typing.
  }, [isOpen, record?.id, kind, actionMutation]);

  const create = useCreateRecord({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); onOpenChange(false); }, onError: applyServerError } });
  const update = useUpdateRecord({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); onOpenChange(false); }, onError: applyServerError } });
  const perform = usePerformAction({ mutation: { onSuccess: (response) => {
    queryClient.invalidateQueries();
    if(actionMutation==='backtest_policy')setResult(response);
    else onOpenChange(false);
  }, onError: applyServerError } });

  const isPending = create.isPending || update.isPending || perform.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!merchantId) return;
    // Every field is checked here first, so a missing value is named at the field and never costs a request.
    const errors: Record<string, string> = {};
    fields.forEach(f => {
      const value = formData[f.name];
      const empty = value === undefined || value === null || String(value).trim() === '';
      if (f.required && f.type !== 'checkbox' && empty) errors[f.name] = missingMessage(f.label, f.type);
      else if (f.type === 'number' && !empty && !Number.isFinite(Number(value))) errors[f.name] = `Enter ${f.label} as a number.`;
    });
    if (actionMutation && !String(formData.reason || '').trim()) errors.reason = 'Enter a reason for this action. It will be saved in the audit log.';
    setFieldErrors(errors); setFormErrors([]);
    const first = firstNamed(errors);
    if (first) { focusField(fieldId(first)); return; }

    const payload: any = { data: {...(record&&!actionMutation?record.data:{}),...(defaultValues.data||{})} };
    fields.forEach(f => {
      let val = formData[f.name];
      // A checkbox always submits a boolean: an untouched box is false, never a missing field.
      if (f.type === 'checkbox') val = Boolean(val);
      else if(val===undefined || (val===''&&!f.required&&f.type!=='textarea'))return;
      if (f.type === 'number') val = Number(val);
      if(['consentGaps','linePaymentIds','confirmedJobs'].includes(f.name)&&typeof val==='string')val=val.split(/[|,]/).map(s=>s.trim()).filter(Boolean);
      if(f.name==='correct'&&typeof val==='string')val=val==='true';
      if (f.isData) {
        payload.data[f.name] = val;
      } else {
        payload[f.name] = val;
      }
    });

    if (actionMutation) {
      perform.mutate({
        data: { action: actionMutation, recordId: record?.id, data: payload.data, reason: formData.reason },
        params: { merchantId }
      });
    } else if (record) {
      update.mutate({
        kind,
        id: record.id,
        data: payload,
        params: { merchantId }
      });
    } else {
      create.mutate({
        kind,
        data: payload,
        params: { merchantId }
      });
    }
  };

  const handleChange = (name: string, value: any) => {
    setFormData((prev: any) => ({ ...prev, [name]: value }));
    // A field being corrected drops its message at once.
    setFieldErrors(prev => { if (!prev[name]) return prev; const next = { ...prev }; delete next[name]; return next; });
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 z-50" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] -translate-y-[50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg max-h-[90vh] overflow-y-auto">
          <div className="flex flex-col space-y-1.5 text-center sm:text-left">
            <Dialog.Title className="text-lg font-semibold leading-none tracking-tight">{title}</Dialog.Title>
            <Dialog.Description className="text-xs text-muted-foreground">Use sample data only. This action cannot collect money or send a customer message. Fields marked * are required.</Dialog.Description>
          </div>
          
          <form noValidate onSubmit={handleSubmit} className="space-y-4 py-4">
            {(formErrors.length > 0 || Object.keys(fieldErrors).length > 0) && (
              <FormAlert title={formErrors[0] ?? attentionTitle(Object.keys(fieldErrors).length)}>
                {formErrors.slice(1).map(message => <p key={message}>{message}</p>)}
              </FormAlert>
            )}
            {fields.map(f => (
              <div key={f.name} className="flex flex-col gap-2">
                <label htmlFor={`record-${f.name}`} className="text-sm font-medium">{f.label} {f.required && '*'}</label>
                {f.type === 'textarea' ? (
                  <textarea 
                    id={`record-${f.name}`}
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
                    value={Array.isArray(formData[f.name])?formData[f.name].join(" | "):(formData[f.name]??'')} 
                    onChange={e => handleChange(f.name, e.target.value)} 
                    required={f.required} 
                    {...invalidProps(`record-${f.name}`, fieldErrors[f.name])}
                  />
                ) : f.type === 'select' ? (
                  <select 
                    id={`record-${f.name}`}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
                    value={formData[f.name] || ''} 
                    onChange={e => handleChange(f.name, e.target.value)} 
                    required={f.required}
                    {...invalidProps(`record-${f.name}`, fieldErrors[f.name])}
                  >
                    <option value="">Choose an option</option>
                    {f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : f.type === 'checkbox' ? (
                  <input 
                    id={`record-${f.name}`}
                    type="checkbox" 
                    checked={!!formData[f.name]} 
                    onChange={e => handleChange(f.name, e.target.checked)} 
                  />
                ) : (
                  <input 
                    id={`record-${f.name}`}
                    type={f.type === 'number' ? 'number' : f.type==='date'?'date':'text'}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
                    value={Array.isArray(formData[f.name])?formData[f.name].join(" | "):(formData[f.name]??'')} 
                    onChange={e => handleChange(f.name, e.target.value)} 
                    required={f.required} 
                    {...invalidProps(`record-${f.name}`, fieldErrors[f.name])}
                  />
                )}
                <FieldError id={`record-${f.name}`} message={fieldErrors[f.name]} />
              </div>
            ))}

            {actionMutation && (
              <div className="flex flex-col gap-2">
                <label htmlFor="record-reason" className="text-sm font-medium">Reason *</label>
                <input 
                  type="text" 
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
                  id="record-reason" {...invalidProps('record-reason', fieldErrors.reason)} value={formData.reason || ''} 
                  onChange={e => handleChange('reason', e.target.value)} 
                  required 
                />
                <FieldError id="record-reason" message={fieldErrors.reason} />
              </div>
            )}
            
            {result&&<section className="space-y-2 rounded border p-3"><p className="font-medium">{result.message}</p>
              {result.data?.decisions?.length===0&&<p>No instalments use this policy yet.</p>}
              {result.data?.decisions?.map((decision:any)=><div key={decision.dueItemId} className="border-t pt-2 text-sm"><span className="font-mono text-xs">{decision.dueItemId}</span><p className="font-semibold">{readableLabel(decision.decision)}</p><p>{decision.reason}</p>{decision.nextAt&&<p>Next possible attempt: {formatDate(decision.nextAt)}</p>}</div>)}
            </section>}
            <div className="flex justify-end gap-2 mt-4 pt-4 border-t">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" busy={isPending} busyLabel={actionMutation ? 'Working…' : 'Saving…'}>{actionMutation ? actionLabels[actionMutation] || 'Confirm action' : 'Save'}</Button>
            </div>
          </form>

          <Dialog.Close asChild>
            <button className="absolute right-3 top-3 inline-flex h-6 w-6 items-center justify-center rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
