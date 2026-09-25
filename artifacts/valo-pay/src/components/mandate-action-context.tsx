import { readableLabel } from './record-label';
import { formatKobo } from '@/lib/formatters';

type Mandate = { name?: string; reference?: string; status: string; amountKobo: number; data?: Record<string, unknown> };

/** Confirm the actual domain transition; recovery never promises to recreate cancelled attempts. */
export function MandateActionContext({ mandate, customerName, customerReference, action, policyName }: {
  mandate: Mandate; customerName?: string; customerReference?: string; action: string; policyName?: string;
}) {
  const current = readableLabel(mandate.status);
  const descriptions: Record<string, { after: string; consequence: string; recovery: string }> = {
    mandate_suspend: {
      after: 'Suspended',
      consequence: 'Scheduled attempts linked to this mandate will be cancelled. Attempts already sent to a provider keep their recorded outcomes.',
      recovery: 'You can choose Resume on this mandate later. Resuming does not restore cancelled attempts; review the collection schedule before arranging another attempt.',
    },
    mandate_reinstate: {
      after: 'Active',
      consequence: 'The mandate can be considered by the collection rules again. Cancelled attempts stay cancelled; no new attempt is created by this action.',
      recovery: 'You can suspend the mandate again if collection needs to pause.',
    },
    mandate_cancel: {
      after: 'Cancelled',
      consequence: 'Scheduled attempts linked to this mandate will be cancelled. The existing mandate and its history stay on record.',
      recovery: 'Cancellation cannot be undone. If collection needs to resume, choose Reissue and provide fresh consent evidence for a new mandate.',
    },
    mandate_reissue: {
      after: mandate.status === 'pending_activation' ? 'Existing mandate: Expired · New mandate: Awaiting activation' : `Existing mandate: ${current} · New mandate: Awaiting activation`,
      consequence: 'A separate mandate and consent record will be created with this customer and activation method, for the debit limit entered below. A limit is part of the customer’s consent, so a new limit needs this reissue. Existing instalments are not relinked automatically.',
      recovery: 'The old mandate history is retained. If the new mandate is no longer needed, cancel it; reissuing does not reactivate the old mandate.',
    },
    activation_reminder: {
      after: `${current} (unchanged)`,
      consequence: 'One simulated reminder will be recorded and count towards this mandate’s reminder limit. No customer message is sent.',
      recovery: 'The reminder remains in the history and cannot be removed. Check the customer and reference before recording it.',
    },
    notify_policy_change: {
      after: `${current} (unchanged)`,
      consequence: 'A simulated policy change notice will be saved. The mandate’s policy will not change, and this notice is not proof of provider acceptance.',
      recovery: 'The notice remains in the history. Applying a policy version is a separate action that requires accepted notice evidence.',
    },
    apply_policy_version: {
      after: `${current} · ${policyName || 'Choose the approved policy version below'}`,
      consequence: 'The selected policy version will apply to this mandate only after the server checks the accepted notice and any required fresh consent. Earlier versions stay in its history.',
      recovery: 'There is no automatic undo. A later policy change must meet the same notice and consent requirements.',
    },
  };
  const detail = descriptions[action];
  if (!detail) return null;
  return <section aria-label="Mandate change summary" className="space-y-3 rounded-lg border bg-secondary/20 p-4 text-sm">
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
      <dt className="text-muted-foreground">Customer</dt><dd className="break-words font-medium">{customerName || 'Customer name unavailable'}{customerReference && <span className="block text-xs font-normal text-muted-foreground">{customerReference}</span>}</dd>
      <dt className="text-muted-foreground">Mandate</dt><dd className="break-words font-medium">{mandate.reference || mandate.name || 'Reference unavailable'}</dd>
      <dt className="text-muted-foreground">Debit limit</dt><dd className="tabular-nums">{formatKobo(mandate.amountKobo)}</dd>
      <dt className="text-muted-foreground">Current state</dt><dd>{current}</dd>
      <dt className="text-muted-foreground">After confirmation</dt><dd className="font-medium">{detail.after}</dd>
    </dl>
    <p className="border-t pt-3">{detail.consequence}</p>
    <p className="text-muted-foreground">{detail.recovery}</p>
    <p className="text-xs font-medium">This updates the sandbox record only. No bank instruction is sent.</p>
  </section>;
}
