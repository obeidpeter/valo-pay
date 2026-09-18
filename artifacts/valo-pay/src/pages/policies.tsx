import React, { useState } from 'react';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, usePerformAction, getListRecordsQueryKey } from '@workspace/api-client-react';
import { Shield, FileText, CheckCircle, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/formatters';
import { RecordDialog } from '@/components/record-dialog';

export default function PoliciesPage() {
  const { merchantId } = useWorkspace();
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  
  const { data: policies, isLoading, refetch } = useListRecords(
    'policies',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('policies', { merchantId: merchantId! }) } }
  );

  const { data: templates, isLoading: isLoadingTemplates } = useListRecords(
    'templates',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('templates', { merchantId: merchantId! }) } }
  );

  const action = usePerformAction({
    mutation: {
      onSuccess: () => refetch()
    }
  });

  const handleAction = (record: any, kind: string) => {
    setSelectedRecord(record);
    setActionKind(kind);
    setIsDialogOpen(true);
  };

  if (!merchantId) return null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Policies & Templates</h1>
        <p className="text-muted-foreground mt-1">Configure and approve retry rules and notification copy.</p>
      </header>

      {/* Policies */}
      <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-lg">Retry Policies</h2>
          </div>
          <Button size="sm" onClick={() => handleAction(null, 'create_policy')}>Draft New Version</Button>
        </div>
        <div className="divide-y">
          {isLoading ? (
            <Loading what="policies" />
          ) : !policies || policies.items.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">No policies defined.</div>
          ) : (
            policies.items.map(policy => (
              <div key={policy.id} className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div className="space-y-2 flex-1">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold">Version {String(policy.data?.version || '1')}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${
                      policy.status === 'approved' ? 'bg-success/10 text-success border-success/20' : 
                      policy.status === 'submitted' ? 'bg-amber-100 text-amber-800 border-amber-200' :
                      'bg-secondary text-secondary-foreground'
                    }`}>
                      {policy.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                    <div>Max Attempts: <span className="font-medium text-foreground">{String(policy.data?.maxAttempts || 0)}</span></div>
                    <div>Spacing: <span className="font-medium text-foreground">{String(policy.data?.spacingHours || 0)}h</span></div>
                    <div>First Notice: <span className="font-medium text-foreground">{String(policy.data?.firstNoticeHours || 0)}h</span></div>
                    <div>Partial Allowed: <span className="font-medium text-foreground">{policy.data?.partialAllowed ? 'Yes' : 'No'}</span></div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Author: {String(policy.data?.author || 'Unknown')} • Last updated: {formatDate(policy.updatedAt)}
                  </div>
                </div>
                
                <div className="flex flex-col gap-2 shrink-0">
                  {policy.status === 'draft' && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => handleAction(policy, 'edit_policy')}>Edit Draft</Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleAction(policy, 'submit_policy')}
                      >
                        Submit for Review
                      </Button>
                    </>
                  )}
                  {policy.status === 'submitted' && (
                    <>
                      <Button 
                        className="bg-success hover:bg-success/90 text-success-foreground"
                        size="sm"
                        onClick={() => handleAction(policy, 'approve_policy')}
                      >
                        <CheckCircle className="mr-2 h-4 w-4" /> Approve
                      </Button>
                      <Button 
                        variant="destructive"
                        size="sm"
                        onClick={() => handleAction(policy, 'reject_policy')}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                  {policy.status === 'approved' && (
                    <div className="flex items-center gap-2 text-success text-sm font-medium">
                      <Shield className="h-4 w-4" /> Active Policy
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Templates */}
      <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-lg">Notification Templates</h2>
          </div>
          <Button size="sm" onClick={() => handleAction(null, 'create_template')}>Create Template</Button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
          {isLoadingTemplates ? (
            <Loading what="templates" className="col-span-2" />
          ) : !templates || templates.items.length === 0 ? (
            <div className="col-span-2 p-8 text-center text-muted-foreground border-2 border-dashed rounded-xl">No templates defined.</div>
          ) : (
            templates.items.map(template => (
              <div key={template.id} className="border rounded-lg p-4 bg-secondary/5 relative">
                <div className="flex justify-between items-start mb-3">
                  <h3 className="font-medium">{String(template.data?.purpose || template.name)}</h3>
                  <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider font-bold rounded-full bg-secondary border">
                    {template.status}
                  </span>
                </div>
                <div className="bg-background p-3 rounded border font-mono text-xs text-muted-foreground whitespace-pre-wrap">
                  {String(template.data?.text || 'No text content')}
                </div>
                <div className="mt-3 flex justify-between items-center text-xs text-muted-foreground">
                  <span>v{String(template.data?.version || '1')}</span>
                  {template.status === 'draft' && (
                    <div className="flex gap-2">
                      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => handleAction(template, 'edit_template')}>Edit</Button>
                      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => handleAction(template, 'submit_template')}>Submit</Button>
                    </div>
                  )}
                  {template.status === 'submitted' && (
                     <Button variant="link" size="sm" className="h-auto p-0 text-success" onClick={() => handleAction(template, 'approve_template')}>Approve</Button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <RecordDialog
        kind={actionKind.includes('policy') ? 'policies' : 'templates'}
        record={selectedRecord}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={
          actionKind === 'create_policy' ? 'Draft New Policy' :
          actionKind === 'edit_policy' ? 'Edit Draft Policy' :
          actionKind === 'submit_policy' ? 'Submit Policy for Review' :
          actionKind === 'approve_policy' ? 'Approve Policy' :
          actionKind === 'reject_policy' ? 'Reject Policy' :
          actionKind === 'create_template' ? 'Draft New Template' :
          actionKind === 'edit_template' ? 'Edit Template' :
          actionKind === 'submit_template' ? 'Submit Template' :
          actionKind === 'approve_template' ? 'Approve Template' :
          'Action'
        }
        actionMutation={actionKind.includes('create') || actionKind.includes('edit') ? undefined : actionKind}
        fields={
          actionKind === 'create_policy' || actionKind === 'edit_policy' ? [
            { name: 'name', label: 'Policy Name', type: 'text', required: true },
            { name: 'status', label: 'Status', type: 'select', options: [{label: 'Draft', value: 'draft'}], required: true },
            { name: 'version', label: 'Version', type: 'number', isData: true, required: true },
            { name: 'maxAttempts', label: 'Max Attempts', type: 'number', isData: true, required: true },
            { name: 'spacingHours', label: 'Spacing Hours', type: 'number', isData: true, required: true },
            { name: 'firstNoticeHours', label: 'First Notice Hours', type: 'number', isData: true, required: true },
            { name: 'retryNoticeHours', label: 'Retry Notice Hours', type: 'number', isData: true, required: true },
             { name: 'partialAllowed', label: 'Partial Allowed', type: 'checkbox', isData: true },
             { name: 'complianceMapping', label: 'Compliance mapping', type: 'textarea', isData: true, required: true }
          ] :
          actionKind === 'create_template' || actionKind === 'edit_template' ? [
            { name: 'name', label: 'Template Name', type: 'text', required: true },
            { name: 'status', label: 'Status', type: 'select', options: [{label: 'Draft', value: 'draft'}], required: true },
            { name: 'purpose', label: 'Purpose', type: 'text', isData: true, required: true },
            { name: 'text', label: 'Text (Use {{amount}}, {{date}})', type: 'textarea', isData: true, required: true },
            { name: 'version', label: 'Version', type: 'number', isData: true, required: true }
          ] :
          []
        }
        defaultValues={actionKind === 'create_policy' ? { status: 'draft' } : actionKind === 'create_template' ? { status: 'draft' } : {}}
      />
    </div>
  );
}
