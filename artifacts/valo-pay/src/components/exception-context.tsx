import { Link, useSearch } from 'wouter';
import type { ValopayRecord } from '@workspace/api-client-react';
import { heldEvidenceCodes, heldEvidenceOf, resolveExceptionType } from '@workspace/valopay-schema';
import { formatKobo, formatDate } from '@/lib/formatters';
import { readableLabel } from '@/components/record-label';

/** A reversal waiting for a payment no connection has seen, as its exception's condition names it (the shared schema's unseenReversalOf). */
const waitingReversal = (condition: unknown) => /^provider_status_mismatch:[^:]+:unseen$/.test(String(condition ?? ''));

/**
 * What recording the chosen outcome does where the service acts on it: evidence held as a suspected duplicate, a payment
 * held as one, and a reversal waiting for its payment, which the next reconciliation reads the resolution of before it
 * looks for any payment. Undefined where resolving records the outcome and reason alone.
 */
export function resolutionEffect(exception: ValopayRecord, code: unknown): string | undefined {
  const type = resolveExceptionType(exception.data?.type), chosen = String(code || '');
  if (type === 'provider_status_mismatch' && waitingReversal(exception.data?.condition)) {
    if (!chosen) return 'Choose the outcome once you have checked with the provider which collection the reversal reverses. This box then says what the next reconciliation does with it.';
    return chosen === 'provider_state_adopted'
      ? 'Provider state adopted keeps the reversal waiting for its payment, with no new exception: the reconciliation that records that payment reverses it, or holds it for you if the payment names another payer, currency or amount. No money moves.'
      : 'The next reconciliation sets the reversal aside for good: it reverses nothing, even if its payment arrives later. No money moves.';
  }
  if (type !== 'suspected_duplicate') return undefined;
  if (!heldEvidenceOf(exception.data?.condition)) {
    // A payment held as a suspected duplicate: only distinct payments changes it.
    return chosen === 'distinct_payments' ? 'Distinct payments releases this payment from its duplicate hold at once: it is then matched like any other payment. No money moves.' : undefined;
  }
  if (!chosen) return 'Choose the outcome once you have checked the evidence. This box then says what the next reconciliation does with it.';
  if (chosen === heldEvidenceCodes.samePayment) return 'The next reconciliation joins this evidence to the payment this exception names, while it is held for its connection alone: evidence of a payment becomes more evidence of it, with no second payment made, and evidence of a reversal reverses that payment. If the payment changes first so that the evidence no longer agrees with it, the evidence is held for you again. No money moves.';
  if (chosen === heldEvidenceCodes.notMoney) return 'The next reconciliation sets this evidence aside for good: no payment is made from it, and it is joined to no payment. No money moves.';
  return `The next reconciliation records this evidence as a payment of its own${chosen === 'confirmed_duplicate_refund' ? ', held until its refund is recorded' : ''}. Evidence of a reversal is set aside instead, since no payment is made only to be reversed. No money moves.`;
}

export function ExceptionContext({ exception, customer, resolutionCode, resolving }: { exception: ValopayRecord; customer?: ValopayRecord; resolutionCode?: unknown; resolving: boolean }) {
  const type = resolveExceptionType(exception.data?.type);
  const lender = new URLSearchParams({ lender: exception.merchantId });
  const linkedId = String(exception.data?.linkedRecordId || '');
  const customerParams = new URLSearchParams(lender);
  const queueParams = new URLSearchParams(useSearch());
  queueParams.set('lender', exception.merchantId);
  queueParams.delete('returnTo');
  customerParams.set('returnTo', '/exceptions?' + queueParams);
  if (linkedId) customerParams.set('record', linkedId);
  const financial = type && ['unallocated_payment', 'suspected_duplicate', 'overpayment', 'settlement_variance'].includes(type);
  const mandate = type && ['activation_expired', 'mandate_limit_exceeded', 'imported_consent_gap'].includes(type);
  const checkout = exception.data?.linkedKind === 'connected-intents';
  // What recording the outcome does: a dispute's instalment and a pay-by-bank checkout's instalment follow the resolution,
  // and so do held evidence, a held payment and a waiting reversal (resolutionEffect).
  const effect = checkout
    ? 'Confirmed successful records the pay-by-bank payment as received, with your evidence reference, and applies it to its instalment; Confirmed failed, or Provider confirmed no debit, records the checkout as failed. Either way the checkout no longer holds its instalment, so a new checkout or retry may follow. No money moves.'
    : type === 'customer_dispute'
      ? 'Not upheld takes the instalment out of dispute: its status then follows its balance, and collection and allocation resume. Upheld or mandate cancelled keeps it in dispute until Finance releases it from dispute on the Collections page. No money moves.'
      : resolutionEffect(exception, resolutionCode) ?? 'Resolving this exception records your outcome and reason. It does not allocate a payment, issue a refund, reissue a mandate or move money. Complete any required action in its workflow and include its evidence reference in your reason.';
  return <section aria-label="Exception context" className="space-y-3 rounded-lg border bg-secondary/10 p-4 text-sm">
    <div><h3 className="font-semibold">{readableLabel(exception.data?.type)}</h3><p className="mt-1 font-mono text-xs">{exception.reference || exception.id}</p></div>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2"><dt className="text-muted-foreground">Customer</dt><dd className="min-w-0 break-words">{customer ? `${customer.name} · ${customer.reference}` : exception.customerId ? `Customer ${exception.customerId} (name unavailable)` : 'No customer linked'}</dd><dt className="text-muted-foreground">Amount</dt><dd className="font-semibold">{formatKobo(exception.amountKobo)}</dd><dt className="text-muted-foreground">Owner</dt><dd>{String(exception.data?.owner || 'Unassigned')}</dd>{Boolean(exception.data?.dueBy) && <><dt className="text-muted-foreground">Deadline</dt><dd>{formatDate(String(exception.data.dueBy))}</dd></>}</dl>
    <div className="rounded-md border bg-background p-3"><p className="font-medium">Recorded issue</p><p className="mt-1 whitespace-pre-wrap break-words">{String(exception.data?.notes || 'No notes have been recorded. Review the linked evidence before choosing an outcome.')}</p></div>
    {linkedId && <p className="break-all text-xs text-muted-foreground">Linked record: {linkedId}</p>}
    <div className="flex flex-wrap gap-x-4 gap-y-2">{exception.customerId && <Link className="min-h-6 text-primary underline" href={`/customers/${encodeURIComponent(exception.customerId)}?${customerParams}${linkedId ? `#record-${encodeURIComponent(linkedId)}` : ''}`}>Review customer history</Link>}{financial && <Link className="min-h-6 text-primary underline" href={`/reconciliation?${lender}`}>Review reconciliation</Link>}{mandate && <Link className="min-h-6 text-primary underline" href={`/mandates?${lender}`}>Review mandates</Link>}{checkout && <Link className="min-h-6 text-primary underline" href={`/pay-by-bank?${lender}`}>Review the pay-by-bank checkout</Link>}{!financial && !mandate && !checkout && <Link className="min-h-6 text-primary underline" href={`/collections?${lender}`}>Review collections</Link>}</div>
    {resolving && <div className="rounded-md border bg-background p-3"><p className="font-medium">{resolutionCode ? `Record outcome: ${readableLabel(resolutionCode)}` : 'Record an outcome after reviewing the evidence.'}</p><p className="mt-1">{effect}</p></div>}
  </section>;
}
