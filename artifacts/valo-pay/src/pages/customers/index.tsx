import React, { useRef, useState } from 'react';
import { useSearchShortcut } from '@/lib/focus';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { formatKobo, formatDate } from '@/lib/formatters';
import { Search, UserPlus, FileText, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';
import { RecordDialog } from '@/components/record-dialog';
import { recordStatuses } from '@workspace/valopay-schema';

export default function CustomersPage() {
  const { merchantId } = useWorkspace();
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  
  const { data, isLoading, error } = useListRecords(
    'customers',
    { merchantId: merchantId!, search: search || undefined },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('customers', { merchantId: merchantId!, search: search || undefined }) } }
  );

  if (!merchantId) return null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Customers</h1>
          <p className="text-muted-foreground mt-1">Manage borrower profiles and consent.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button className="gap-2" onClick={() => setIsDialogOpen(true)}>
            <UserPlus className="h-4 w-4" /> Add Customer
          </Button>
        </div>
      </header>

      <RecordDialog
        kind="customers"
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title="Add Customer"
        fields={[
          { name: 'name', label: 'Full Name', type: 'text', required: true },
          { name: 'reference', label: 'LMS Reference', type: 'text', required: true },
          { name: 'status', label: 'Status', type: 'select', options: recordStatuses.customers.map(status => ({ label: status.charAt(0).toUpperCase() + status.slice(1), value: status })), required: true },
          { name: 'bankName', label: 'Bank Name', type: 'text', isData: true },
          { name: 'accountMasked', label: 'Masked Account (e.g. ******1234)', type: 'text', isData: true },
          { name: 'phoneMasked', label: 'Masked Phone', type: 'text', isData: true },
          { name: 'consentProvenance', label: 'Consent Provenance', type: 'text', isData: true },
        ]}
        defaultValues={{ status: 'active' }}
      />

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
        {search.trim() && <p className="hidden print:block p-4 border-b text-sm">Search: “{search.trim()}”</p>}
        <div className="p-4 border-b flex items-center gap-4 bg-secondary/20 print:hidden">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input 
              type="text" 
              placeholder="Search by name, reference, or phone..."
              ref={searchRef}
              aria-keyshortcuts="/"
              onKeyDown={event => { if (event.key === 'Escape') { setSearch(''); } }} 
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-background border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border bg-secondary px-1.5 font-mono text-[11px] text-muted-foreground" aria-hidden="true">/</kbd>
          </div>
        </div>

        {isLoading ? (
          <Loading what="customers" />
        ) : error ? (
          <div className="p-8 text-center text-destructive">Failed to load customers.</div>
        ) : !data || data.items.length === 0 ? (
          search.trim() ? (
            <EmptyState filtered title={`No customers match “${search.trim()}”`}>Check the spelling, or search by the reference or the masked phone number.</EmptyState>
          ) : (
            <EmptyState title="No customers yet" action={<Button size="sm" variant="outline" onClick={() => setIsDialogOpen(true)}>Add a customer</Button>}>
              Customers arrive from your loan software by API or a CSV import on the Collections page. In the sandbox you can add one here.
            </EmptyState>
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground">
                <tr>
                  <th className="px-6 py-4 font-medium">Customer</th>
                  <th className="px-6 py-4 font-medium">Contact</th>
                  <th className="px-6 py-4 font-medium">Bank Details</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                  <th className="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map(customer => (
                  <tr key={customer.id} className="hover:bg-secondary/10 transition-colors">
                    <td className="px-6 py-4">
                      <p className="font-medium text-foreground">{customer.name}</p>
                      <p className="text-xs font-mono text-muted-foreground">{customer.reference}</p>
                    </td>
                    <td className="px-6 py-4">
                      <p className="text-muted-foreground">{String(customer.data?.phoneMasked || 'N/A')}</p>
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-medium">{String(customer.data?.bankName || 'N/A')}</p>
                      <p className="text-xs font-mono text-muted-foreground">{String(customer.data?.accountMasked || 'N/A')}</p>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${customer.status === 'active' ? 'bg-success/10 text-success border border-success/20' : 'bg-secondary text-secondary-foreground border'}`}>
                        {customer.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link href={`/customers/${customer.id}`} className="inline-flex items-center gap-1 text-primary hover:underline text-sm font-medium">
                        View Timeline <ArrowRight className="h-3 w-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        
        {data && data.total > data.items.length && (
          <div className="p-4 border-t text-center text-xs text-muted-foreground">
            Showing {data.items.length} of {data.total} records. Refine search to see more.
          </div>
        )}
      </div>
    </div>
  );
}
