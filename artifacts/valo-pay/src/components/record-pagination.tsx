import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/formatters';
import { RECORD_PAGE_SIZES, type RecordPaginationState } from '@/lib/use-record-pagination';

export function RecordPagination({ pagination, total, busy = false, label = 'records' }: {
  pagination: RecordPaginationState; total: number; busy?: boolean; label?: string;
}) {
  const { page, pageSize, offset, setPage, setPageSize } = pagination;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <><nav aria-label={`${label} pagination`} className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-xs text-muted-foreground">
      <p aria-live="polite" aria-atomic="true">{total ? `${formatNumber(Math.min(offset + 1, total))}–${formatNumber(Math.min(offset + pageSize, total))} of ${formatNumber(total)} ${label}` : `0 ${label}`}</p>
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <label className="flex items-center gap-2">Rows per page
          <select aria-label={`${label} per page`} value={pageSize} onChange={event => setPageSize(Number(event.target.value))} disabled={busy} className="rounded-md border bg-background px-2 py-2 text-foreground">
            {RECORD_PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <Button variant="outline" size="sm" disabled={busy || page === 0} onClick={() => setPage(page - 1)} aria-label={`Previous page of ${label}`}>Previous</Button>
        <span className="tabular-nums">Page {formatNumber(page + 1)} of {formatNumber(pages)}</span>
        <Button variant="outline" size="sm" disabled={busy || offset + pageSize >= total} onClick={() => setPage(page + 1)} aria-label={`Next page of ${label}`}>Next</Button>
      </div>
    </nav>
    <p className="hidden print:block border-t px-5 py-3 text-xs">{total ? `${formatNumber(Math.min(offset + 1, total))}–${formatNumber(Math.min(offset + pageSize, total))} of ${formatNumber(total)} ${label}` : `0 ${label}`} · Page {page + 1} of {pages}.{pages > 1 ? ' Current page only. Other pages are not included in this printout.' : ''}</p></>
  );
}
