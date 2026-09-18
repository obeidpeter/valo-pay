import { useEffect, type RefObject } from 'react';

/**
 * Keyboard paths the console keeps the same everywhere (Nielsen 4 and 7;
 * universal design: operable by keyboard, low physical effort).
 */

/** Focus the page's main region, the way a page load would start the reader at the top of what changed. */
export function focusMain(): void {
  document.getElementById('main')?.focus();
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
