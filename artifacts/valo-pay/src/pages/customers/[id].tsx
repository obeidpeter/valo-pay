import React from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetCustomerTimeline, getGetCustomerTimelineQueryKey, useCreateExport } from '@workspace/api-client-react';
import { formatKobo, formatDate, formatCompactDate } from '@/lib/formatters';
import { ArrowLeft, Clock, FileText, CheckCircle, AlertTriangle, CreditCard, Download } from 'lucide-react';
import { Link, useParams } from 'wouter';
import { Button } from '@/components/ui/button';

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
        window.open(data.downloadUrl, '_blank');
      }
    }
  });

  if (!merchantId) return null;
  if (isLoading) return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading timeline...</div>;
  if (error || !timeline) return <div className="p-8 text-center text-destructive">Failed to load customer timeline.</div>;

  const { customer, position, events, mandates, dueItems, payments } = timeline;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/customers" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to Customers
        </Link>
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{customer.name}</h1>
            <p className="text-muted-foreground mt-1 font-mono text-sm">{customer.reference}</p>
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Bank:</span> <span className="font-medium">{String(customer.data?.bankName || 'N/A')}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Account:</span> <span className="font-mono font-medium">{String(customer.data?.accountMasked || 'N/A')}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Status:</span> 
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success border border-success/20">
                  {customer.status}
                </span>
              </div>
            </div>
            <Button 
              variant="outline" 
              size="sm" 
              className="mt-4 gap-2"
              onClick={() => createExport.mutate({ data: { kind: 'customer-pack', format: 'pdf', customerId: id }, params: { merchantId } })}
              disabled={createExport.isPending}
            >
              <Download className="h-4 w-4" /> Export PDF Timeline
            </Button>
          </div>

          <div className="bg-card border rounded-xl p-4 shadow-sm min-w-[240px]">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Current Position</h3>
            <div className="space-y-3">
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground">Outstanding</span>
                <span className="text-lg font-bold text-destructive font-mono">{formatKobo(Number(position?.outstandingKobo || 0))}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground">Paid</span>
                <span className="text-lg font-bold text-success font-mono">{formatKobo(Number(position?.paidKobo || 0))}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Active Mandates */}
          <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              <h2 className="font-semibold">Mandates</h2>
            </div>
            <div className="divide-y">
              {mandates.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground text-sm">No mandates found.</div>
              ) : (
                mandates.map(mandate => (
                  <div key={mandate.id} className="p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <p className="font-medium font-mono text-sm">{mandate.reference}</p>
                        <p className="text-xs text-muted-foreground">Limit: {formatKobo(mandate.amountKobo)}</p>
                      </div>
                      <span className="px-2 py-1 bg-secondary text-xs rounded-md font-medium border">{mandate.status}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Due Items & Payments */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                <h2 className="font-semibold">Due Items</h2>
              </div>
              <div className="divide-y">
                {dueItems.length === 0 ? (
                  <div className="p-6 text-center text-muted-foreground text-sm">No due items.</div>
                ) : (
                  dueItems.map(item => (
                    <div key={item.id} className="p-4">
                      <div className="flex justify-between items-baseline mb-1">
                        <span className="font-mono text-sm">{item.reference}</span>
                        <span className="font-mono font-medium text-destructive">{formatKobo(item.amountKobo)}</span>
                      </div>
                      <div className="flex justify-between items-center mt-2">
                        <span className="text-xs text-muted-foreground">Due: {formatCompactDate(String(item.data?.dueDate || item.createdAt))}</span>
                        <span className="text-xs font-medium px-2 py-0.5 rounded bg-secondary">{item.status}</span>
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
                  <div className="p-6 text-center text-muted-foreground text-sm">No payments.</div>
                ) : (
                  payments.map(payment => (
                    <div key={payment.id} className="p-4">
                      <div className="flex justify-between items-baseline mb-1">
                        <span className="font-mono text-sm">{payment.reference}</span>
                        <span className="font-mono font-medium text-success">{formatKobo(payment.amountKobo)}</span>
                      </div>
                      <div className="flex justify-between items-center mt-2">
                        <span className="text-xs text-muted-foreground">{formatCompactDate(payment.createdAt)}</span>
                        <span className="text-xs font-medium px-2 py-0.5 rounded bg-secondary">{payment.status}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>

        {/* Timeline Log */}
        <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col h-[600px]">
          <div className="p-4 border-b bg-secondary/20 flex items-center gap-2 shrink-0">
            <Clock className="h-5 w-5 text-primary" />
            <h2 className="font-semibold">Timeline Events</h2>
          </div>
          <div className="p-4 overflow-y-auto flex-1 space-y-4">
            {events.length === 0 ? (
              <p className="text-center text-muted-foreground text-sm mt-8">No events recorded.</p>
            ) : (
              <div className="relative border-l-2 border-border ml-3 space-y-6">
                {events.map((event, i) => (
                  <div key={event.id} className="relative pl-6">
                    <div className="absolute -left-[9px] top-1 h-4 w-4 rounded-full bg-background border-2 border-primary"></div>
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground font-mono mb-1">{formatDate(event.createdAt)}</span>
                      <span className="text-sm font-medium">{event.name || event.kind}</span>
                      {event.amountKobo > 0 && (
                        <span className="text-sm font-mono mt-1">{formatKobo(event.amountKobo)}</span>
                      )}
                      <span className="text-xs text-muted-foreground mt-1">{event.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
