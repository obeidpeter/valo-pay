import React, { useEffect } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetCustomerTimeline, getGetCustomerTimelineQueryKey, useCreateExport } from '@workspace/api-client-react';
import { formatKobo, formatDate, formatCompactDate, formatCount } from '@/lib/formatters';
import { ArrowLeft, Clock, FileText, CheckCircle, AlertTriangle, Download } from 'lucide-react';
import { CustomerAvatar, StatusBadge, readableLabel } from '@/components/record-label';
import { Link, useParams } from 'wouter';
import { Button } from '@/components/ui/button';
import { notifyDone, notifyProblem, saidBy } from '@/lib/notify';
import { LookedFor } from '@/components/notice';
import { NotFoundNotice } from '@/pages/not-found';

const watStamp = (iso: unknown) => typeof iso === 'string' && Number.isFinite(Date.parse(iso)) ? formatDate(iso) : 'n/a';

/** RET-03: the recorded decision in one sentence: why, when the next attempt is, the notice it requires, the version and the arm. */
function decisionDetail(data: Record<string, any>): string {
  const notice = data.noticeRequired as { purpose?: string; requiredBy?: string | null; evidenced?: boolean } | undefined;
  return [
    String(data.reason || ''),
    data.nextAt ? `Next attempt ${watStamp(data.nextAt)}.` : '',
    notice ? `Notice ${String(notice.purpose || '').replace(/_/g, ' ')}${notice.requiredBy ? ` required by ${watStamp(notice.requiredBy)}` : ''}${notice.evidenced ? ', evidenced.' : ', not evidenced.'}` : '',
    `Policy v${String(data.policyVersion || '?')}${data.experimentArm ? ` · arm ${String(data.experimentArm)}` : ''}.`,
  ].filter(Boolean).join(' ');
}

/** The address is a customer page, but the current lender has no customer with that reference. */
function MissingCustomer({ id }: { id: string }) {
  useEffect(() => { document.title = 'Customer not found · Valo Pay'; }, []);
  return (
    <NotFoundNotice title="No customer with this reference" primary={{ href: '/customers', label: 'Back to customers' }} secondary={{ href: '/overview', label: 'Go to the overview' }}>
      <p>The current lender has no customer with the reference <LookedFor>{id}</LookedFor>. It may belong to another lender in this workspace, which the lender selector switches to, or the address may be mistyped.</p>
      <p>Nothing has been changed.</p>
    </NotFoundNotice>
  );
}

export default function CustomerTimelinePage() {
  const { id } = useParams();
  const { merchantId } = useWorkspace();

  const { data: timeline, isLoading, error } = useGetCustomerTimeline(
    id!,
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId && !!id, queryKey: getGetCustomerTimelineQueryKey(id!, { merchantId: merchantId! }) } }
  );

  const createExport = useCreateExport({
    mutation: {
      onSuccess: (data) => {
        const opened = window.open(data.downloadUrl, '_blank');
        notifyDone(
          'Dispute pack generated',
          `${opened ? 'It opened in a new tab.' : 'Your browser kept the new tab closed; use Open.'} SHA-256 ${data.checksum.slice(0, 16)}… · generated ${formatDate(data.generatedAt)}`,
          { label: 'Open', altText: 'Open the dispute pack in a new tab', onClick: () => { window.open(data.downloadUrl, '_blank'); } },
        );
      },
      onError: (error: unknown) => notifyProblem('The dispute pack was not generated', `${saidBy(error, 'The service refused the request.')} Nothing has been changed.`),
    }
  });
  const exportPack = (format: 'pdf' | 'csv' | 'json') => createExport.mutate({ data: { kind: 'dispute-pack', format, customerId: String(id) }, params: { merchantId: merchantId! } });
  /** Only the export that was asked for says it is being generated; the others wait, disabled. */
  const generating = (format: 'pdf' | 'csv' | 'json') => createExport.isPending && createExport.variables?.data.format === format;

  if (!merchantId) return null;
  if (isLoading) return <Loading what="the timeline" />;
  if ((error as { status?: number } | null)?.status === 404) return <MissingCustomer id={String(id)} />;
  if (error || !timeline) return <div role="alert" className="p-8 text-center text-destructive">Failed to load customer timeline. Please refresh to try again.</div>;

  const { customer, position, events, mandates, dueItems, payments } = timeline;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/customers" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 print:hidden">
          <ArrowLeft className="h-4 w-4" /> Back to Customers
        </Link>
        <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-4">
              <CustomerAvatar name={customer.name} large />
              <div>
                <h1 className="text-3xl font-bold tracking-tight">{customer.name}</h1>
                <p className="text-muted-foreground mt-1 font-mono text-xs" title={customer.id}>{customer.reference}</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Bank:</span> <span className="font-medium">{String(customer.data?.bankName || 'N/A')}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Account:</span> <span className="font-mono font-medium">{String(customer.data?.accountMasked || 'N/A')}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Status:</span> 
                <span className="ml-2"><StatusBadge status={customer.status} /></span>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="gap-2" onClick={() => exportPack('pdf')} disabled={createExport.isPending} busy={generating('pdf')} busyLabel="Generating…">
                <Download className="h-4 w-4" /> Dispute pack (PDF)
              </Button>
              <Button variant="ghost" size="sm" onClick={() => exportPack('csv')} disabled={createExport.isPending} busy={generating('csv')} busyLabel="Generating…">CSV</Button>
              <Button variant="ghost" size="sm" onClick={() => exportPack('json')} disabled={createExport.isPending} busy={generating('json')} busyLabel="Generating…">JSON</Button>
            </div>
            <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">Export the full timeline and the policy, template and cutover versions in effect at each event. Includes a SHA-256 checksum (AUD-02, AUD-06).</p>
          </div>

          <div className="bg-card border rounded-xl p-5 shadow-sm w-full xl:w-80 shrink-0">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Current Position</h2>
            <div className="space-y-3">
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground">Outstanding</span>
                <span className="text-lg font-bold text-destructive font-mono">{formatKobo(Number(position?.outstandingKobo || 0))}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground">Allocated</span>
                <span className="text-lg font-bold text-success font-mono">{formatKobo(Number(position?.allocatedKobo || 0))}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground">Unapplied credit</span>
                <span className="text-lg font-bold font-mono">{formatKobo(Number(position?.unallocatedKobo || 0))}</span>
              </div>
              <p className="text-[11px] text-muted-foreground">{String(position?.note || 'Derived from obligations and payment evidence; we never hold money.')}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6 items-start">
        <div className="xl:col-span-2 space-y-6">
          {/* Active Mandates */}
          <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              <h2 className="font-semibold">Mandates</h2>
            </div>
            <div className="divide-y">
              {mandates.length === 0 ? (
                <EmptyState title="No mandates for this customer">A mandate appears here once your loan software or a CSV import links one to this customer.</EmptyState>
              ) : (
                mandates.map(mandate => (
                  <div key={mandate.id} className="p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <p className="font-medium font-mono text-sm" title={mandate.id}>{mandate.reference}</p>
                        <p className="text-xs text-muted-foreground">Limit: {formatKobo(mandate.amountKobo)}</p>
                      </div>
                      <StatusBadge status={mandate.status} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Due Items & Payments */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 gap-6">
            <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-warning-strong" />
                <h2 className="font-semibold">Due Items</h2>
              </div>
              <div className="divide-y">
                {dueItems.length === 0 ? (
                  <EmptyState title="No instalments due">Instalments due appear here from your loan software, with each attempt against them.</EmptyState>
                ) : (
                  dueItems.map(item => (
                    <div key={item.id} className="p-4">
                      <div className="flex justify-between items-baseline mb-1">
                        <span className="font-mono text-sm">{item.reference}</span>
                        <span className="font-mono font-medium text-destructive">{formatKobo(item.amountKobo)}</span>
                      </div>
                      <div className="flex justify-between items-center mt-2">
                        <span className="text-xs text-muted-foreground">Due: {formatCompactDate(String(item.data?.dueDate || item.createdAt))}</span>
                        <StatusBadge status={item.status} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-success" />
                <h2 className="font-semibold">Payments</h2>
              </div>
              <div className="divide-y">
                {payments.length === 0 ? (
                  <EmptyState title="No payments received">Payments matched to this customer's instalments appear here with the rule that matched them.</EmptyState>
                ) : (
                  payments.map(payment => (
                    <div key={payment.id} className="p-4">
                      <div className="flex justify-between items-baseline mb-1">
                        <span className="font-mono text-sm">{payment.reference}</span>
                        <span className="font-mono font-medium text-success">{formatKobo(payment.amountKobo)}</span>
                      </div>
                      <div className="flex justify-between items-center mt-2">
                        <span className="text-xs text-muted-foreground">{formatCompactDate(payment.createdAt)}</span>
                        <StatusBadge status={payment.status} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>

        {/* Timeline Log */}
        <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col xl:col-span-3">
          <div className="p-5 border-b flex items-center gap-3 shrink-0">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary"><Clock className="h-4 w-4 text-primary" /></span>
            <div>
              <h2 className="font-semibold">Timeline Events</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">The complete record · {formatCount(events.length, 'event')}</p>
            </div>
          </div>
          <ScrollFrame label="Timeline events" className="p-5 sm:p-6 overflow-y-auto max-h-[720px] space-y-4">
            {events.length === 0 ? (
              <EmptyState title="No events recorded yet" className="px-0">Consent, mandate changes, attempts, notices and payments are recorded here as they happen.</EmptyState>
            ) : (
              <ol className="relative border-l border-border ml-2 space-y-7">
                {events.map(event => (
                  <li key={event.id} className="relative pl-6">
                    <span aria-hidden="true" className="absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full bg-brand ring-4 ring-card" />
                    <div className="flex flex-col items-start">
                      <time dateTime={event.createdAt} className="text-[11px] text-muted-foreground mb-1.5">{formatDate(event.createdAt)}</time>
                      <span className="text-sm font-semibold" title={event.id}>{event.name || readableLabel(event.kind)}</span>
                      {event.amountKobo > 0 && (
                        <span className="text-sm font-mono mt-1">{formatKobo(event.amountKobo)}</span>
                      )}
                      {event.kind === 'retry-decisions' && (
                        <span className="text-xs leading-relaxed text-muted-foreground mt-2">{decisionDetail((event.data || {}) as Record<string, any>)}</span>
                      )}
                      <span className="mt-2"><StatusBadge status={event.status} /></span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </ScrollFrame>
        </div>
      </div>
    </div>
  );
}
