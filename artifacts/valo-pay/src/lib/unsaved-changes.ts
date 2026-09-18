import { useEffect, useRef } from 'react';

const drafts = new Set<{ current: boolean }>();
const message = 'Discard your unsaved changes? Choose Cancel to keep editing. A request already sent may still finish.';

export function confirmUnsavedChanges(): boolean {
  return ![...drafts].some(draft => draft.current) || window.confirm(message);
}

/** Warn without retaining names, payment data, reasons or other sensitive drafts in storage. */
export function useUnsavedChanges(dirty: boolean) {
  const draft = useRef(dirty);
  draft.current = dirty;
  useEffect(() => { drafts.add(draft); return () => { drafts.delete(draft); }; }, []);
  return { confirmDiscard: () => !draft.current || window.confirm(message) };
}

/** Guard links, keyboard navigation, browser Back/Forward and document unload. */
export function installUnsavedNavigationGuard() {
  const push = window.history.pushState;
  const replace = window.history.replaceState;
  const marker = '__valoNavigationIndex';
  let index = Number(window.history.state?.[marker] ?? 0);
  let restoring = false;
  replace.call(window.history, { ...window.history.state, [marker]: index }, '', window.location.href);
  const changesPage = (url?: string | URL | null) => url != null && new URL(String(url), window.location.href).pathname !== window.location.pathname;
  window.history.pushState = function (state, unused, url) {
    if (changesPage(url) && !confirmUnsavedChanges()) return;
    index += 1;
    push.call(this, { ...state, [marker]: index }, unused, url);
  };
  window.history.replaceState = function (state, unused, url) {
    if (changesPage(url) && !confirmUnsavedChanges()) return;
    replace.call(this, { ...state, [marker]: index }, unused, url);
  };
  const pop = (event: PopStateEvent) => {
    const nextIndex = event.state?.[marker];
    if (restoring) { restoring = false; event.stopImmediatePropagation(); return; }
    if (typeof nextIndex === 'number' && !confirmUnsavedChanges()) {
      event.stopImmediatePropagation();
      restoring = true;
      window.history.go(index - nextIndex);
      return;
    }
    if (typeof nextIndex === 'number') index = nextIndex;
  };
  const unload = (event: BeforeUnloadEvent) => {
    if ([...drafts].some(draft => draft.current)) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('popstate', pop, true);
  window.addEventListener('beforeunload', unload);
  return () => {
    window.history.pushState = push; window.history.replaceState = replace;
    window.removeEventListener('popstate', pop, true); window.removeEventListener('beforeunload', unload);
  };
}
