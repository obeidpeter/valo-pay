import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Keyboard paths the console keeps the same everywhere (Nielsen 4 and 7;
 * universal design: operable by keyboard, low physical effort).
 */

/** Focus the page's main region, the way a page load would start the reader at the top of what changed. */
export function focusMain(): void {
  document.getElementById('main')?.focus({ preventScroll: true });
}

type Activation = { target: HTMLElement };
const currentActivations = new WeakMap<Document, Activation>();

/** Safari does not always focus clicked buttons. Remember only this click's
 * visible control, without changing focus or retaining an unrelated last click. */
export function useDialogActivationTracking(): void {
  useEffect(() => {
    let activation: Activation | undefined;
    let expiry: number | undefined;
    const clear = () => {
      if (activation && currentActivations.get(document) === activation) currentActivations.delete(document);
      activation = undefined;
      if (expiry !== undefined) window.clearTimeout(expiry);
      expiry = undefined;
    };
    const capture = (event: MouseEvent) => {
      clear();
      const target = event.composedPath().find(node => node instanceof HTMLElement && node.matches('button:not(:disabled), a[href], [role="button"], [role="link"]'));
      if (!(target instanceof HTMLElement) || !target.isConnected || target.getClientRects().length === 0 || target.closest('[inert]') || getComputedStyle(target).visibility !== 'visible') return;
      activation = { target };
      currentActivations.set(document, activation);
      // Discrete React click updates commit before this next task. A later
      // asynchronous/programmatic opening must use its own focused context.
      expiry = window.setTimeout(clear, 0);
    };
    document.addEventListener('click', capture, true);
    return () => { document.removeEventListener('click', capture, true); clear(); };
  }, []);
}

/** Snapshot at opening, before the dialog's autofocus effect moves focus. */
export function useDialogFocusReturn(isOpen: boolean): (event?: { preventDefault(): void }) => void {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!isOpen) return;
    const activated = currentActivations.get(document)?.target;
    const focused = document.activeElement;
    opener.current = activated?.isConnected ? activated : focused instanceof HTMLElement && focused !== document.body && focused !== document.documentElement ? focused : null;
  }, [isOpen]);
  return event => {
    event?.preventDefault();
    const target = opener.current;
    if (target?.isConnected) {
      target.focus({ preventScroll: true });
      if (document.activeElement === target) return;
    }
    focusMain();
  };
}

/** True while the keyboard is typing into something, so a shortcut must not steal the key. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/** Pressing "/" anywhere on the page, outside a field, puts the caret in the search box. */
export function useSearchShortcut(ref: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      event.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ref]);
}

/** The shortcuts the console offers, listed on the settings page so they can be found rather than guessed. */
export const keyboardShortcuts: Array<{ keys: string; does: string }> = [
  { keys: 'Tab / Shift+Tab', does: 'Move through the links, fields and buttons in reading order. The first stop on every page skips to its content.' },
  { keys: '/', does: 'Put the caret in the search box on a page that has one (Customers, Audit log).' },
  { keys: 'Escape', does: 'Clear the search box you are in, or close the dialog or menu that is open.' },
  { keys: '← → Home End', does: 'Move between the filter tabs on Exceptions; the list follows the tab.' },
  { keys: 'Enter / Space', does: 'Activate the focused link, button, tab or menu item.' },
  { keys: 'F8', does: 'Jump to the notices in the corner, then Tab to their Dismiss or Open.' },
];
