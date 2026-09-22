import React from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useWorkspace } from '@/lib/workspace-context';

/** Keep API values intact while using ordinary words in the interface. */
const displayLabels: Record<string, string> = {
  valopay: 'Valo Pay', valo: 'Valo Pay', lms: 'Loan management system',
  merchant_manual: 'Lender team', provider_auto: 'Provider automatic collection',
  pending_activation: 'Awaiting activation', unpaid_final: 'Unpaid after final attempt', superseded: 'No longer applied',
  returned: 'Returned to the payer',
  in_collection: 'Collection in progress', in_flight: 'Awaiting an outcome',
  not_proven: 'Not yet proven', not_eligible: 'Not eligible for a retry',
  would_schedule: 'Would schedule a retry', observation_only: 'Observation only',
  give_up: 'No further retries', defer: 'Retry postponed', holdout: 'Comparison group',
  engine: 'Automated retry group', preregistered: 'Plan registered',
  handed_back: 'Returned to the fallback collection owner',
  transfer_to_activate: 'Activate with a bank transfer', hosted_consent: 'Consent through the provider',
  paper_mandate: 'Paper mandate', not_ours: 'Payment belongs elsewhere',
  allocated_manual: 'Allocated manually', held_credit: 'Kept as unallocated credit',
  confirmed_duplicate_refund: 'Duplicate confirmed; refund required',
  paid_other_channel: 'Paid through another channel', applied_to_next: 'Applied to the next instalment',
  rescheduled_by_lms: 'Rescheduled in the loan system', written_off_by_lms: 'Written off in the loan system',
  limit_raised_new_mandate: 'Limit increased through a new mandate', split_by_lms: 'Split in the loan system',
  upheld_refund: 'Dispute upheld; refund required', not_upheld: 'Dispute not upheld',
  resolved_succeeded: 'Confirmed successful', resolved_failed: 'Confirmed failed',
  deferred_executed: 'Postponed attempt completed', customer_unreachable_cancelled: 'Cancelled; customer could not be reached',
  incumbent_disabled: 'Previous collection system disabled', owner_reverted: 'Previous collection owner restored',
  mapped_to_code: 'Failure code classified', imported_consent_gap: 'Missing consent evidence',
  notice_not_evidenced: 'Notice acceptance not confirmed', ownership_conflict: 'Collection ownership conflict',
  mapping_needed: 'Failure code needs classification', activation_expired: 'Activation deadline passed',
  INSUFFICIENT_FUNDS: 'Insufficient funds', ACCOUNT_RESTRICTED: 'Account restricted',
  INVALID_ACCOUNT: 'Invalid or closed account', MANDATE_INACTIVE: 'Mandate inactive',
  MANDATE_LIMIT_EXCEEDED: 'Mandate limit exceeded', BANK_UNAVAILABLE: 'Bank unavailable',
  PROVIDER_ERROR: 'Provider error', TIMEOUT_UNKNOWN: 'Outcome unknown',
  DUPLICATE: 'Duplicate instruction', CUSTOMER_DISPUTED: 'Customer disputed the debit', UNKNOWN: 'Unclassified failure',
};

export function readableLabel(value: unknown): string {
  const raw = String(value || 'Unknown');
  if (Object.hasOwn(displayLabels, raw)) return displayLabels[raw];
  const words = raw.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function CustomerAvatar({ name, large = false }: { name: string; large?: boolean }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('');
  return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-foreground font-semibold ${large ? 'h-14 w-14 text-lg' : 'h-9 w-9 text-xs'}`}>{initials || '?'}</span>;
}

export function StatusBadge({ status }: { status: unknown }) {
  const value = String(status || 'unknown');
  const tone = ['active', 'paid', 'allocated', 'confirmed', 'resolved', 'reconciled', 'succeeded'].includes(value)
    ? 'bg-success/10 text-success border-success/20'
    : ['failed', 'expired', 'unpaid_final', 'variance'].includes(value)
      ? 'bg-destructive/10 text-destructive border-destructive/20'
      : ['pending_activation', 'proposed', 'unallocated', 'possible_duplicate', 'in_progress'].includes(value)
        ? 'bg-warning text-warning-foreground border-warning-border'
        : 'bg-secondary text-secondary-foreground border-border';
  return <span title={readableLabel(value)} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}><span aria-hidden="true" className="h-1 w-1 rounded-full bg-current" />{readableLabel(value)}</span>;
}

type RecordIdentity = { id: string; name?: string | null; reference?: string | null };

/** Full identifiers remain available without dominating the operational table. */
export function RecordLabel({ record, id, customer = false }: { record?: RecordIdentity; id?: unknown; customer?: boolean }) {
  const [path]=useLocation(), search=useSearch();const {merchantId}=useWorkspace();
  const params=new URLSearchParams(search);if(merchantId)params.set('lender',merchantId);
  const returnTo=['/exceptions','/mandates','/collections','/reconciliation'].includes(path) ? path+'?'+params : null;
  const destination=record ? '/customers/'+record.id+(returnTo?'?'+new URLSearchParams({returnTo,lender:merchantId || ''}):'') : '';
  const fullId = record?.id || String(id || '');
  if (!record) return fullId
    ? <details className="text-xs"><summary className="cursor-pointer font-mono text-muted-foreground">{fullId.slice(0, 8)}…</summary><span className="mt-1 block max-w-56 break-all font-mono">{fullId}</span></details>
    : <span className="text-xs text-muted-foreground">{customer ? 'No customer linked' : 'Reference unavailable'}</span>;
  const title = customer ? record.name || record.reference || fullId : record.reference || record.name || fullId;
  return <div title={fullId} className="min-w-0">
    {customer ? <Link href={destination} className="font-medium text-foreground hover:text-primary hover:underline">{title}</Link> : <span className="font-medium text-foreground">{title}</span>}
    {customer && record.reference && <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{record.reference}</span>}
    <span className="sr-only"> Record ID: {fullId}</span>
  </div>;
}
