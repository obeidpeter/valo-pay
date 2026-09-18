// Runs before every console test file: browser APIs jsdom lacks, and a clean
// query cache and DOM between tests so one page's data never leaks into the next.
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { queryClient } from "@/App";

// Replit injects managed Clerk configuration into Vitest too. Keep these
// offline localhost tests on the anonymous adapter they are specified for,
// without changing or contacting the managed Clerk runtime.
vi.mock("@/lib/auth", () => ({
  authEnabled: false,
  clerkPublishableKey: undefined,
  useSessionUser: () => ({ userId: null, isLoaded: true }),
  useSignOut: () => () => {},
  AuthShow: () => null,
}));

class ResizeObserverStub {
  observe(): void { /* layout is not measured in tests */ }
  unobserve(): void { /* layout is not measured in tests */ }
  disconnect(): void { /* layout is not measured in tests */ }
}
if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener() { /* legacy */ }, removeListener() { /* legacy */ },
    addEventListener() { /* no media changes in tests */ }, removeEventListener() { /* no media changes in tests */ },
    dispatchEvent: () => false,
  });
}
if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => { /* no scrolling in tests */ };
// Radix's swipe-to-dismiss on a notice asks for pointer capture, which jsdom does not implement.
if (typeof Element.prototype.hasPointerCapture !== "function") Element.prototype.hasPointerCapture = () => false;
if (typeof Element.prototype.setPointerCapture !== "function") Element.prototype.setPointerCapture = () => { /* no pointer capture in tests */ };
if (typeof Element.prototype.releasePointerCapture !== "function") Element.prototype.releasePointerCapture = () => { /* no pointer capture in tests */ };

// The app retries failed queries with backoff; a test asserting an error state must see it at once.
// Everything else (the thirty-second staleness) stays as production configures it.
queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });

afterEach(() => {
  cleanup();
  queryClient.clear();
  // A theme chosen in one test is this browser's, not the next test's.
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});
