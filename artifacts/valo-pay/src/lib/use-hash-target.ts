import { useEffect } from 'react';
import { useLocationProperty } from 'wouter/use-browser-location';

const address = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

/** Resolve deep links after an asynchronous page has rendered its target. */
export function useHashTarget(ids: string | readonly string[], ready: boolean): void {
  // Wouter also publishes pushState/replaceState changes, which do not emit hashchange.
  const location = useLocationProperty(address);
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!ready || !(typeof ids === 'string' ? id === ids : ids.includes(id))) return;
    // Run after the shell's route focus/reset so it cannot overwrite the target.
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (!target) return;
      // Sections outside the normal tab order still need a readable focus destination.
      if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      // No animation, including when the user requests reduced motion.
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ids, ready, location]);
}
