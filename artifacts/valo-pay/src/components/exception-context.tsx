import { Link, useSearch } from 'wouter';
import type { ValopayRecord } from '@workspace/api-client-react';
import { resolveExceptionType } from '@workspace/valopay-schema';
import { formatKobo, formatDate } from '@/lib/formatters';
import { readableLabel } from '@/components/record-label';

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
  // What recording the outcome does: a dispute's instalment and a pay-by-bank checkout's instalment follow the resolution.
  const effect = checkout
    ? 'Confirmed successful records the pay-by-bank payment as received, with your evidence reference, and applies it to its instalment; Confirmed failed, or Provider confirmed no debit, records the checkout as failed. Either way the checkout no longer holds its instalment, so a new checkout or retry may follow. No money moves.'
    : type === 'customer_dispute'
      ? 'Not upheld takes the instalment out of dispute: its status then follows its balance, and collection and allocation resume. Upheld or mandate cancelled keeps it in dispute until Finance releases it from dispute on the Collections page. No money moves.'
      : 'Resolving this exception records your outcome and reason. It does not allocate a payment, issue a refund, reissue a mandate or move money. Complete any required action in its workflow and include its evidence reference in your reason.';
  return <section aria-label="Exception context" className="space-y-3 rounded-lg border bg-secondary/10 p-4 text-sm">
    <div><h3 className="font-semibold">{readableLabel(exception.data?.type)}</h3><p className="mt-1 font-mono text-xs">{exception.reference || exception.id}</p></div>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2"><dt className="text-muted-foreground">Customer</dt><dd className="min-w-0 break-words">{customer ? `${customer.name} · ${customer.reference}` : exception.customerId ? `Customer ${exception.customerId} (name unavailable)` : 'No customer linked'}</dd><dt className="text-muted-foreground">Amount</dt><dd className="font-semibold">{formatKobo(exception.amountKobo)}</dd><dt className="text-muted-foreground">Owner</dt><dd>{String(exception.data?.owner || 'Unassigned')}</dd>{Boolean(exception.data?.dueBy) && <><dt className="text-muted-foreground">Deadline</dt><dd>{formatDate(String(exception.data.dueBy))}</dd></>}</dl>
    <div className="rounded-md border bg-background p-3"><p className="font-medium">Recorded issue</p><p className="mt-1 whitespace-pre-wrap break-words">{String(exception.data?.notes || 'No notes have been recorded. Review the linked evidence before choosing an outcome.')}</p></div>
    {linkedId && <p className="break-all text-xs text-muted-foreground">Linked record: {linkedId}</p>}
    <div className="flex flex-wrap gap-x-4 gap-y-2">{exception.customerId && <Link className="min-h-6 text-primary underline" href={`/customers/${encodeURIComponent(exception.customerId)}?${customerParams}${linkedId ? `#record-${encodeURIComponent(linkedId)}` : ''}`}>Review customer history</Link>}{financial && <Link className="min-h-6 text-primary underline" href={`/reconciliation?${lender}`}>Review reconciliation</Link>}{mandate && <Link className="min-h-6 text-primary underline" href={`/mandates?${lender}`}>Review mandates</Link>}{checkout && <Link className="min-h-6 text-primary underline" href={`/pay-by-bank?${lender}`}>Review the pay-by-bank checkout</Link>}{!financial && !mandate && !checkout && <Link className="min-h-6 text-primary underline" href={`/collections?${lender}`}>Review collections</Link>}</div>
    {resolving && <div className="rounded-md border bg-background p-3"><p className="font-medium">{resolutionCode ? `Record outcome: ${readableLabel(resolutionCode)}` : 'Record an outcome after reviewing the evidence.'}</p><p className="mt-1">{effect}</p></div>}
  </section>;
}
