import { useLayoutEffect, useRef, type ReactNode } from 'react';
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

type Control = 'previous' | 'next' | 'size';
/** Where focus may go when the control pressed cannot take it: the pressed one first, then the others. */
const fallbacks: Record<Control, Control[]> = { previous: ['previous', 'next', 'size'], next: ['next', 'previous', 'size'], size: ['size', 'next', 'previous'] };
/** The pager control a person last pressed, by the pager's label, until that pager shows the page asked for or the person does something else. */
let pressed: { label: string; control: Control; until: number; release: () => void } | null = null;
function press(label: string, control: Control) {
  pressed?.release();
  // A key or a pointer press after this one is the person moving on; the one that pressed the control came before it.
  const events = ['keydown', 'pointerdown'] as const;
  const held = { label, control, until: Date.now() + 30_000, release: () => {
    for (const event of events) document.removeEventListener(event, held.release, true);
    if (pressed === held) pressed = null;
  } };
  for (const event of events) document.addEventListener(event, held.release, true);
  pressed = held;
}

/**
 * Keeps keyboard focus on the pager control that was pressed while its page loads, rather than on the page body or
 * the top of a dialog. While busy the controls stay focusable (aria-disabled) and ignore presses; a pager mounted
 * again once its page arrives gives the focus back to the control pressed; and a page button that reaching the first
 * or last page disables passes it to the other one. The person's next key or pointer press lets go. Lists keep their
 * pager while the next page loads (keepRowsWhilePaging), so the control pressed is normally never lost.
 */
function usePagerFocus(label: string, busy: boolean) {
  const controls = { previous: useRef<HTMLButtonElement>(null), next: useRef<HTMLButtonElement>(null), size: useRef<HTMLSelectElement>(null) };
  useLayoutEffect(() => {
    const held = pressed;
    if (!held || held.label !== label) return;
    if (Date.now() > held.until) { held.release(); return; }
    const target = fallbacks[held.control].map(control => controls[control].current).find(element => element?.isConnected && !element.disabled);
    if (target && document.activeElement !== target) target.focus();
    if (!busy) held.release();
  });
  return controls;
}

/**
 * Previous and Next for a list that pages by a fixed step on its own (a pilot page's history, say), with the pager's
 * keyboard focus: while `busy`, as its next page loads, both stay focusable and wait; one that the first or last page
 * disables passes the focus to the other. `label` names the list, as RecordPagination's does. Children go between them.
 */
export function PageButtons({ label, busy = false, atStart, atEnd, onPrevious, onNext, previous = 'Previous', next = 'Next', children }: {
  label: string; busy?: boolean; atStart: boolean; atEnd: boolean; onPrevious(): void; onNext(): void; previous?: string; next?: string; children?: ReactNode;
}) {
  const controls = usePagerFocus(label, busy);
  const go = (control: Control, change: () => void) => { if (busy) return; press(label, control); change(); };
  return <>
    <Button ref={controls.previous} variant="outline" disabled={atStart} aria-disabled={busy || undefined} className="aria-disabled:opacity-50" onClick={() => go('previous', onPrevious)}>{previous}</Button>
    {children}
    <Button ref={controls.next} variant="outline" disabled={atEnd} aria-disabled={busy || undefined} className="aria-disabled:opacity-50" onClick={() => go('next', onNext)}>{next}</Button>
  </>;
}

export function RecordPagination({ pagination, total, busy = false, label = 'records' }: {
  pagination: RecordPaginationState; total: number; busy?: boolean; label?: string;
}) {
  const { page, pageSize, offset, setPage, setPageSize } = pagination;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const { nav, keep } = useKeptInView(busy);
  const controls = usePagerFocus(label, busy);
  const go = (control: Control, change: () => void) => { if (busy) return; press(label, control); keep(change); };
  return (
    <><nav ref={nav} aria-label={`${label} pagination`} className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-xs text-muted-foreground">
      <p aria-live="polite" aria-atomic="true">{total ? `${formatNumber(Math.min(offset + 1, total))}–${formatNumber(Math.min(offset + pageSize, total))} of ${formatNumber(total)} ${label}` : `0 ${label}`}</p>
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <label className="flex items-center gap-2">Rows per page
          {/* While a page loads the controls wait, focusable, so the one pressed keeps the focus. */}
          <select ref={controls.size} aria-label={`${label} per page`} value={pageSize} onChange={event => { const size = Number(event.target.value); go('size', () => setPageSize(size)); }} aria-disabled={busy || undefined} className="rounded-md border bg-background px-2 py-2 text-foreground aria-disabled:opacity-50">
            {RECORD_PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <Button ref={controls.previous} variant="outline" size="sm" disabled={page === 0} aria-disabled={busy || undefined} className="aria-disabled:opacity-50" onClick={() => go('previous', () => setPage(page - 1))} aria-label={`Previous page of ${label}`}>Previous</Button>
        <span className="tabular-nums">Page {formatNumber(page + 1)} of {formatNumber(pages)}</span>
        <Button ref={controls.next} variant="outline" size="sm" disabled={offset + pageSize >= total} aria-disabled={busy || undefined} className="aria-disabled:opacity-50" onClick={() => go('next', () => setPage(page + 1))} aria-label={`Next page of ${label}`}>Next</Button>
      </div>
    </nav>
    <p className="hidden print:block border-t px-5 py-3 text-xs">{total ? `${formatNumber(Math.min(offset + 1, total))}–${formatNumber(Math.min(offset + pageSize, total))} of ${formatNumber(total)} ${label}` : `0 ${label}`} · Page {formatNumber(page + 1)} of {formatNumber(pages)}.{pages > 1 ? ' Current page only. Other pages are not included in this printout.' : ''}</p></>
  );
}
