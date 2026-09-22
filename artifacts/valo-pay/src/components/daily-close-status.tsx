import { closeRules } from '@workspace/valopay-schema';
import { formatCount, formatDate } from '@/lib/formatters';

/** Reports carry free-form operational data; missing status must never imply a running service. */
export function DailyCloseStatus({ value, showHistory = false }: { value: unknown; showHistory?: boolean }) {
  const schedule = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  let message = 'Automatic close status is unavailable. Refresh this page or run a close manually.';
  let warning = false;
  if (schedule) {
    if (schedule.enabled === false) {
      message = typeof schedule.pausedForInactivityAt === 'string'
        ? `Automatic daily close paused on ${formatDate(schedule.pausedForInactivityAt)} because nobody changed this sandbox for ${closeRules.idleSandboxDays} days. Switch it on again in Settings, or run closes manually.`
        : 'Automatic daily close is off for this lender. Run closes manually.';
    } else if (schedule.runtimeState === 'off') message = 'Automatic daily close is off on this service. Run closes manually.';
    else if (schedule.runtimeState === 'stopped' || schedule.runtimeState === 'not_started') {
      message = 'Automatic daily close is unavailable. Run a close manually while the service recovers.';
      warning = true;
    } else if (schedule.serviceIssue === 'failed' || schedule.serviceIssue === 'delayed') {
      message = schedule.serviceIssue === 'failed'
        ? 'The automatic close service could not complete its latest check. Run a close manually and ask an administrator to check the service.'
        : 'The automatic close service has stopped checking on time. Run a close manually and ask an administrator to check the service.';
      warning = true;
    } else if (schedule.serviceIssue === 'starting') message = 'Automatic daily close is starting. No next run is confirmed yet.';
    else if (schedule.automatic === true && Number(schedule.failedAttempts) > 0 && typeof schedule.retryAt === 'string') {
      message = `The automatic close for this lender failed ${formatCount(Number(schedule.failedAttempts), 'time')}. Next attempt: ${formatDate(schedule.retryAt)}. Run a daily close manually, and ask an administrator to check this lender if it fails again.`;
      warning = true;
    } else if (schedule.automatic === true && schedule.missed === true) {
      message = `Scheduled close at ${schedule.time} WAT missed: ${formatCount(Number(schedule.overdueMinutes), 'minute')} past its time. Run a daily close or ask an administrator to investigate.`;
      warning = true;
    } else if (schedule.automatic === true && Number(schedule.overdueMinutes) > 0 && typeof schedule.nextAt === 'string') {
      message = `Daily close was due ${formatDate(schedule.nextAt)}. Waiting for the automatic close service; you can also run it manually.`;
    } else if (schedule.automatic === true && typeof schedule.nextAt === 'string') {
      message = `Next daily close: ${formatDate(schedule.nextAt)}, then every day at this time.`;
    }
  }
  return <div className="space-y-1 text-xs">
    <p className={warning ? 'font-medium text-destructive' : 'text-muted-foreground'}>{message}</p>
    {showHistory && <p className="text-muted-foreground">Last completed close: {typeof schedule?.lastAt === 'string' ? `${formatDate(schedule.lastAt)} (${schedule.lastTrigger === 'scheduled' ? 'automatic' : 'manual'})` : 'Not closed yet'}.</p>}
    {typeof schedule?.lastCheckedAt === 'string' && <p className="text-muted-foreground">Service last checked: {formatDate(schedule.lastCheckedAt)}.</p>}
    {schedule?.serviceIssue === 'failed' && typeof schedule.lastErrorAt === 'string' && <p className="text-muted-foreground">Last failed service check: {formatDate(schedule.lastErrorAt)}.</p>}
  </div>;
}
