import React, { useState, useEffect, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from './ui/button';
import { useCreateRecord, useUpdateRecord, usePerformAction } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/lib/workspace-context';

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
  
  useEffect(() => {
    if (isOpen) {
      setResult(null);
      create.reset();update.reset();perform.reset();
      if (record) {
        const initial: any = { ...defaultValues, name: record.name, status: record.status, reference: record.reference, amountKobo: record.amountKobo, customerId: record.customerId };
        fields.forEach(f => {
          if (f.isData && record.data) {
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

  const create = useCreateRecord({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); onOpenChange(false); } } });
  const update = useUpdateRecord({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); onOpenChange(false); } } });
  const perform = usePerformAction({ mutation: { onSuccess: (response) => {
    queryClient.invalidateQueries();
    if(actionMutation==='backtest_policy')setResult(response);
    else onOpenChange(false);
  } } });

  const isPending = create.isPending || update.isPending || perform.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!merchantId) return;

    const payload: any = { data: {...(record&&!actionMutation?record.data:{}),...(defaultValues.data||{})} };
    fields.forEach(f => {
      let val = formData[f.name];
      if(val===undefined || (val===''&&!f.required&&f.type!=='textarea'))return;
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
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 z-50" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] -translate-y-[50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg max-h-[90vh] overflow-y-auto">
          <div className="flex flex-col space-y-1.5 text-center sm:text-left">
            <Dialog.Title className="text-lg font-semibold leading-none tracking-tight">{title}</Dialog.Title>
            <Dialog.Description className="text-xs text-muted-foreground">Synthetic sandbox only. This action does not send a debit or a message.</Dialog.Description>
          </div>
          
          <form onSubmit={handleSubmit} className="space-y-4 py-4">
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
                  />
                ) : f.type === 'select' ? (
                  <select 
                    id={`record-${f.name}`}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
                    value={formData[f.name] || ''} 
                    onChange={e => handleChange(f.name, e.target.value)} 
                    required={f.required}
                  >
                    <option value="">Select...</option>
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
                  />
                )}
              </div>
            ))}

            {actionMutation && (
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Reason *</label>
                <input 
                  type="text" 
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
                  value={formData.reason || ''} 
                  onChange={e => handleChange('reason', e.target.value)} 
                  required 
                />
              </div>
            )}
            
            {[create.error,update.error,perform.error].filter(Boolean).map((error:any,index)=>(
              <div key={index} role="alert" className="rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {error.data?.error||error.message||"This action was rejected."}
                {error.data?.details?.map((detail:any)=><div key={detail.field}>{detail.field}: {detail.message}</div>)}
              </div>
            ))}
            {result&&<section className="space-y-2 rounded border p-3"><p className="font-medium">{result.message}</p>
              {result.data?.decisions?.length===0&&<p>No due items use this policy.</p>}
              {result.data?.decisions?.map((decision:any)=><div key={decision.dueItemId} className="border-t pt-2 text-sm"><span className="font-mono text-xs">{decision.dueItemId}</span><p className="font-semibold">{String(decision.decision).replaceAll("_"," ")}</p><p>{decision.reason}</p>{decision.nextAt&&<p>{decision.nextAt}</p>}</div>)}
            </section>}
            <div className="flex justify-end gap-2 mt-4 pt-4 border-t">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={isPending}>{isPending ? 'Saving...' : 'Save'}</Button>
            </div>
          </form>

          <Dialog.Close asChild>
            <button className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
