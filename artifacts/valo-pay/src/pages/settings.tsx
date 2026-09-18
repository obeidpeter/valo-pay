import React, { useState } from 'react';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetSettings, useUpdateSettings, usePerformAction, getGetSettingsQueryKey } from '@workspace/api-client-react';
import { Settings as SettingsIcon, Shield, PowerOff, AlertTriangle } from 'lucide-react';
import { authorisationModes, closeRules, executionWindow, isCloseTime } from '@workspace/valopay-schema';
import { FieldError, FormAlert, focusField, invalidProps } from '@/components/form-field';
import { formatDate } from '@/lib/formatters';
import { notifyDone, notifyProblem, saidBy } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { RecordDialog } from '@/components/record-dialog';

export default function SettingsPage() {
  const { merchantId, workspace } = useWorkspace();
  const [role, setRole] = useState(workspace?.role || 'Admin');
  const [killReason, setKillReason] = useState('');
  const [isHandBackOpen, setIsHandBackOpen] = useState(false);
  
  const [isEditingExec, setIsEditingExec] = useState(false);
  const [execSettings, setExecSettings] = useState<any>({});
  
  const { data: settings, isLoading, refetch } = useGetSettings(
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getGetSettingsQueryKey({ merchantId: merchantId! }) } }
  );

  const updateRole = usePerformAction({
    mutation: {
      onSuccess: () => window.location.reload()
    }
  });

  const killSwitch = usePerformAction({
    mutation: {
      onSuccess: (data) => { refetch(); notifyDone('Kill switch updated', data.message); },
      onError: (err: unknown) => notifyProblem('The kill switch was not changed', saidBy(err, 'The change was refused.'))
    }
  });

  const requestInstruction = usePerformAction({
    mutation: {
      onSuccess: (data) => notifyDone('Live instruction requested', data.message),
      onError: (err: unknown) => notifyProblem('Live instruction refused', saidBy(err, 'The request was refused.'))
    }
  });
  
  const updateExecSettings = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        setIsEditingExec(false);
        refetch();
        notifyDone('Settings saved', 'Recorded in the audit log. The next scheduled close follows the saved time.');
      },
      onError: (err: any) => rejectExec(err)
    }
  });

  const [execErrors, setExecErrors] = useState<Record<string, string>>({});
  const [execAlert, setExecAlert] = useState('');
  const execKeys = ['closeTime', 'unallocatedAlertThreshold', 'notificationCostAlertKobo'] as const;
  /** The server's rule messages begin with the key they concern, so the message goes under that field. */
  const rejectExec = (err: any) => {
    const message = String(err?.data?.error || err?.message || 'The change was not saved.');
    const key = execKeys.find(candidate => message.startsWith(candidate));
    setExecErrors(key ? { [key]: message } : {});
    setExecAlert(key ? 'The settings were not saved. Check the field marked below.' : message);
    if (key) focusField(`settings-${key}`);
  };
  const saveExec = () => {
    if (!merchantId) return;
    const errors: Record<string, string> = {};
    if (execSettings.closeTime !== undefined && !isCloseTime(execSettings.closeTime)) errors.closeTime = 'Enter the close time as HH:MM in West Africa Time, for example 07:00.';
    for (const key of ['unallocatedAlertThreshold', 'notificationCostAlertKobo'] as const) {
      const value = execSettings[key];
      if (value !== undefined && (!Number.isInteger(Number(value)) || Number(value) < 0)) errors[key] = 'Enter a whole number, 0 or more.';
    }
    setExecErrors(errors); setExecAlert('');
    const first = execKeys.find(key => errors[key]);
    if (first) { focusField(`settings-${first}`); return; }
    updateExecSettings.mutate({ data: execSettings, params: { merchantId } });
  };
  const cancelExec = () => { setIsEditingExec(false); setExecErrors({}); setExecAlert(''); };
  const startEditExec = () => {
    setExecSettings(settings?.settings || {});
    setExecErrors({}); setExecAlert('');
    setIsEditingExec(true);
  };

  if (!merchantId) return null;

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Settings & Administration</h1>
        <p className="text-muted-foreground mt-1">Manage workspace configuration and demo personas.</p>
      </header>

      {/* Role Persona Switcher */}
      <section className="bg-card border rounded-xl shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="h-5 w-5 text-primary" />
          <h2 className="font-semibold text-lg">Demo Persona</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Switch roles to test permissions and approval workflows. This is a synthetic sandbox feature only.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <select 
            className="flex-1 max-w-xs bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="Admin">Admin</option>
            <option value="Operations">Operations</option>
            <option value="Finance">Finance</option>
            <option value="Compliance reviewer">Compliance reviewer</option>
            <option value="Read-only">Read-only</option>
          </select>
          <Button 
            onClick={() => updateRole.mutate({ data: { action: 'set_role', data: { role } }, params: { merchantId } })}
            disabled={role === workspace?.role}
            busy={updateRole.isPending}
            busyLabel="Switching persona…"
          >
            Apply Persona
          </Button>
          
          <Button
            variant="outline"
            className="ml-auto"
            onClick={() => requestInstruction.mutate({ data: { action: 'request_instruction' }, params: { merchantId } })}
            busy={requestInstruction.isPending}
            busyLabel="Requesting…"
          >
            Request Live Instruction
          </Button>
        </div>
      </section>

      {/* Execution Settings */}
      {isLoading ? (
        <Loading what="settings" className="bg-card border rounded-xl" />
      ) : settings ? (
        <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <SettingsIcon className="h-5 w-5 text-primary" />
              <h2 className="font-semibold text-lg">Execution Settings</h2>
            </div>
            {!isEditingExec ? (
              <Button size="sm" variant="outline" onClick={startEditExec}>Edit</Button>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={cancelExec}>Cancel</Button>
                <Button size="sm" onClick={saveExec} busy={updateExecSettings.isPending} busyLabel="Saving…">Save</Button>
              </div>
            )}
          </div>
          {execAlert && <div className="px-6 pt-6"><FormAlert title="Settings not saved">{execAlert}</FormAlert></div>}
          <div className="p-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="text-sm font-medium block mb-1">Authorisation Mode</label>
                {isEditingExec ? (
                  <select 
                    className="w-full bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={execSettings.authorisationMode || authorisationModes[0]}
                    onChange={(e) => setExecSettings({...execSettings, authorisationMode: e.target.value})}
                  >
                    {authorisationModes.map(mode => <option key={mode} value={mode}>{mode === 'batch' ? 'Batch approval (Finance or Admin releases the day)' : 'Standing authorisation (signed configuration)'}</option>)}
                  </select>
                ) : (
                  <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">
                    {String(settings.settings?.authorisationMode || authorisationModes[0])}
                  </div>
                )}
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">Policy change needs fresh consent (RET-07)</label>
                {isEditingExec ? (
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={execSettings.policyChangeRequiresConsent === true} onChange={(e) => setExecSettings({...execSettings, policyChangeRequiresConsent: e.target.checked})} /> The merchant's terms require fresh consent before a new policy version applies to a customer</label>
                ) : (
                  <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">{settings.settings?.policyChangeRequiresConsent === true ? 'Yes: notice and fresh consent' : 'No: notice only'}</div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium block mb-1">Unallocated alert threshold (Payments older than 24h)</label>
                  {isEditingExec ? (
                    <><input id="settings-unallocatedAlertThreshold" {...invalidProps('settings-unallocatedAlertThreshold', execErrors.unallocatedAlertThreshold)} type="number" min={0} className="w-full bg-background border rounded-md px-3 py-2 text-sm" value={execSettings.unallocatedAlertThreshold ?? 10} onChange={(e) => setExecSettings({...execSettings, unallocatedAlertThreshold: Number(e.target.value)})} />
                    <FieldError id="settings-unallocatedAlertThreshold" message={execErrors.unallocatedAlertThreshold} /></>
                  ) : (
                    <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">{String(settings.settings?.unallocatedAlertThreshold ?? 10)}</div>
                  )}
                </div>
                <div>
                  <label className="text-sm font-medium block mb-1">Notification cost alert (kobo per collection)</label>
                  {isEditingExec ? (
                    <><input id="settings-notificationCostAlertKobo" {...invalidProps('settings-notificationCostAlertKobo', execErrors.notificationCostAlertKobo)} type="number" min={0} className="w-full bg-background border rounded-md px-3 py-2 text-sm" value={execSettings.notificationCostAlertKobo ?? 800} onChange={(e) => setExecSettings({...execSettings, notificationCostAlertKobo: Number(e.target.value)})} />
                    <FieldError id="settings-notificationCostAlertKobo" message={execErrors.notificationCostAlertKobo} /></>
                  ) : (
                    <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">{String(settings.settings?.notificationCostAlertKobo ?? 800)}</div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium block mb-1">Daily close time (WAT, HH:MM, REC-01)</label>
                  {isEditingExec ? (
                    <><input id="settings-closeTime" {...invalidProps('settings-closeTime', execErrors.closeTime)} type="text" inputMode="numeric" placeholder={closeRules.defaultTime} className="w-full bg-background border rounded-md px-3 py-2 text-sm font-mono" value={execSettings.closeTime ?? closeRules.defaultTime} onChange={(e) => setExecSettings({...execSettings, closeTime: e.target.value})} />
                    <FieldError id="settings-closeTime" message={execErrors.closeTime} /></>
                  ) : (
                    <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">{String(settings.settings?.closeTime ?? closeRules.defaultTime)} WAT</div>
                  )}
                </div>
                <div>
                  <label className="text-sm font-medium block mb-1">Automatic daily close</label>
                  {isEditingExec ? (
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={execSettings.scheduledCloseEnabled !== false} onChange={(e) => setExecSettings({...execSettings, scheduledCloseEnabled: e.target.checked})} /> Run the close at that time every day; a close missed while the platform was down runs on recovery</label>
                  ) : (
                    <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">{settings.settings?.scheduledCloseEnabled === false ? 'Off: closes are triggered by hand' : `On · next ${settings.settings?.nextCloseAt ? formatDate(String(settings.settings.nextCloseAt)) : 'at the configured time'}`}</div>
                  )}
                </div>
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">Contact Route (shown in every customer notice)</label>
                {isEditingExec ? (
                  <input 
                    type="text"
                    className="w-full bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={execSettings.contactRoute || ''}
                    onChange={(e) => setExecSettings({...execSettings, contactRoute: e.target.value})}
                  />
                ) : (
                  <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">
                    {String(settings.settings?.contactRoute || 'Not set')}
                  </div>
                )}
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">Execution Window Start (WAT hour, {executionWindow.earliestHour}–{executionWindow.latestHour})</label>
                {isEditingExec ? (
                  <input 
                    type="number"
                    min={executionWindow.earliestHour}
                    max={executionWindow.latestHour - 1}
                    className="w-full bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={execSettings.executionStart ?? executionWindow.defaultStartHour}
                    onChange={(e) => setExecSettings({...execSettings, executionStart: Number(e.target.value)})}
                  />
                ) : (
                  <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">
                    {String(settings.settings?.executionStart ?? executionWindow.defaultStartHour)}:00
                  </div>
                )}
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">Execution Window End (WAT hour, up to {executionWindow.latestHour})</label>
                {isEditingExec ? (
                  <input 
                    type="number"
                    min={executionWindow.earliestHour + 1}
                    max={executionWindow.latestHour}
                    className="w-full bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={execSettings.executionEnd ?? executionWindow.defaultEndHour}
                    onChange={(e) => setExecSettings({...execSettings, executionEnd: Number(e.target.value)})}
                  />
                ) : (
                  <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">
                    {String(settings.settings?.executionEnd ?? executionWindow.defaultEndHour)}:00
                  </div>
                )}
              </div>
            </div>
            
            <div className="pt-4 border-t">
              <h3 className="font-medium mb-4 text-destructive flex items-center gap-2">
                <PowerOff className="h-4 w-4" /> Emergency Controls
              </h3>
              <div className="flex gap-4">
                <input 
                  type="text" 
                  placeholder="Reason for toggle..."
                  value={killReason}
                  onChange={(e) => setKillReason(e.target.value)}
                  className="flex-1 bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">A reason is required; it is recorded in the audit log with the switch.</p>
                <Button 
                  variant="destructive"
                  onClick={() => killSwitch.mutate({ data: { action: 'kill_switch', reason: killReason, data: { enabled: !settings.merchant.killSwitch } }, params: { merchantId } })}
                  disabled={!killReason}
                  busy={killSwitch.isPending}
                  busyLabel={settings.merchant.killSwitch ? 'Deactivating…' : 'Activating…'}
                >
                  {settings.merchant.killSwitch ? 'Deactivate Kill Switch' : 'Activate Kill Switch'}
                </Button>
                
                <Button 
                  variant="outline"
                   onClick={() => setIsHandBackOpen(true)}
                >
                  Hand Back Portfolios
                </Button>
              </div>
              {settings.merchant.killSwitch && (
                <p className="text-xs text-destructive mt-2 flex items-center gap-1 font-bold">
                  <AlertTriangle className="h-3 w-3" /> SYSTEM HALTED. NO OUTBOUND INSTRUCTIONS PERMITTED.
                </p>
              )}
            </div>
          </div>
        </section>
      ) : null}
      <RecordDialog
        kind="cutovers"
        isOpen={isHandBackOpen}
        onOpenChange={setIsHandBackOpen}
        title="Hand back portfolios"
        actionMutation="hand_back"
        fields={[]}
      />

    </div>
  );
}

