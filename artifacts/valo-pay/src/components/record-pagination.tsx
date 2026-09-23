import { useLayoutEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/formatters';
import { RECORD_PAGE_SIZES, type RecordPaginationState } from '@/lib/use-record-pagination';

/** The element that scrolls this one: the nearest ancestor with scrolling overflow, or the document. */
function scroller(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/**
 * Keeps the pager where the person clicked it while the next page arrives: a shorter last page would otherwise pull
 * the pager out of view. Chromium and Firefox anchor the view themselves; WebKit does not. It lets go once the page
 * has loaded (or after three seconds), and at once if the person scrolls.
 */
function useKeptInView(busy: boolean) {
  const nav = useRef<HTMLElement>(null);
  const held = useRef<{ top: number; sawBusy: boolean; until: number; release: () => void } | null>(null);
  useLayoutEffect(() => {
    const kept = held.current, element = nav.current;
    if (!kept || !element) return;
    const drift = element.getBoundingClientRect().top - kept.top;
    if (Math.abs(drift) >= 1) scroller(element).scrollTop += drift;
    if (busy) kept.sawBusy = true;
    else if (kept.sawBusy || Date.now() > kept.until) kept.release();
  });
  useLayoutEffect(() => () => held.current?.release(), []);
  return {
    nav,
    keep(change: () => void) {
      held.current?.release();
      const element = nav.current;
      if (element) {
        const container = scroller(element), events = ['wheel', 'touchstart', 'keydown'] as const;
        const kept = { top: element.getBoundingClientRect().top, sawBusy: false, until: Date.now() + 3000, release: () => {
          for (const event of events) container.removeEventListener(event, kept.release);
          if (held.current === kept) held.current = null;
        } };
        for (const event of events) container.addEventListener(event, kept.release, { passive: true });
        held.current = kept;
      }
      change();
    },
  };
}

export function RecordPagination({ pagination, total, busy = false, label = 'records' }: {
  pagination: RecordPaginationState; total: number; busy?: boolean; label?: string;
}) {
  const { page, pageSize, offset, setPage, setPageSize } = pagination;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const { nav, keep } = useKeptInView(busy);
  return (
    <><nav ref={nav} aria-label={`${label} pagination`} className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-xs text-muted-foreground">
      <p aria-live="polite" aria-atomic="true">{total ? `${formatNumber(Math.min(offset + 1, total))}–${formatNumber(Math.min(offset + pageSize, total))} of ${formatNumber(total)} ${label}` : `0 ${label}`}</p>
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <label className="flex items-center gap-2">Rows per page
          <select aria-label={`${label} per page`} value={pageSize} onChange={event => { const size = Number(event.target.value); keep(() => setPageSize(size)); }} disabled={busy} className="rounded-md border bg-background px-2 py-2 text-foreground">
            {RECORD_PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <Button variant="outline" size="sm" disabled={busy || page === 0} onClick={() => keep(() => setPage(page - 1))} aria-label={`Previous page of ${label}`}>Previous</Button>
        <span className="tabular-nums">Page {formatNumber(page + 1)} of {formatNumber(pages)}</span>
        <Button variant="outline" size="sm" disabled={busy || offset + pageSize >= total} onClick={() => keep(() => setPage(page + 1))} aria-label={`Next page of ${label}`}>Next</Button>
      </div>
    </nav>
    <p className="hidden print:block border-t px-5 py-3 text-xs">{total ? `${formatNumber(Math.min(offset + 1, total))}–${formatNumber(Math.min(offset + pageSize, total))} of ${formatNumber(total)} ${label}` : `0 ${label}`} · Page {formatNumber(page + 1)} of {formatNumber(pages)}.{pages > 1 ? ' Current page only. Other pages are not included in this printout.' : ''}</p></>
  );
}
