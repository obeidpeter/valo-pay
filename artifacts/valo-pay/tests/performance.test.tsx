import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { LazyPage, QUERY_STALE_MS, loadPage, queryClient } from "@/App";
import { ErrorBoundary } from "@/components/error-boundary";
import { ScrollFrame } from "@/components/scroll-frame";

const packageFile = (...parts: string[]) => [join(process.cwd(), ...parts), join(process.cwd(), "artifacts", "valo-pay", ...parts)].find((candidate) => existsSync(candidate))!;

// The measurements behind these are in the design rationale (Performance); the tests pin what was changed.
describe("performance", () => {
  it("shows data fetched in the last thirty seconds at once instead of refetching it", () => {
    expect(QUERY_STALE_MS).toBe(30_000);
    expect(queryClient.getDefaultOptions().queries?.staleTime).toBe(QUERY_STALE_MS);
  });

  it("asks for the two typefaces from the page shell, alongside the stylesheet, and for nothing else", () => {
    const shell = readFileSync(packageFile("index.html"), "utf8");
    const css = readFileSync(packageFile("src", "index.css"), "utf8");
    expect(shell).toMatch(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Plus\+Jakarta\+Sans[^"]*Spline\+Sans\+Mono[^"]*" rel="stylesheet">/);
    expect(shell).not.toContain("family=Inter");
    expect(css).not.toContain("@import url('https://fonts.googleapis.com");
  });

  it("loads the console pages on demand and keeps the landing page in the shell", () => {
    const app = readFileSync(packageFile("src", "App.tsx"), "utf8");
    expect(app).toContain("import LandingPage from '@/pages/landing';");
    for (const page of ["overview", "customers/index", "customers/[id]", "reconciliation", "exceptions", "policies", "mandates", "collections", "reports", "evidence", "audit", "settings", "sign-in"]) {
      expect(app).toContain(`import('@/pages/${page}')`);
    }
  });

  it("fetches a page's code once and renders it at once on a later visit", async () => {
    const load = vi.fn(async () => ({ default: () => <p>The page</p> }));
    const first = render(<LazyPage load={load} />);
    expect(first.getByRole("status").textContent).toBe("Loading the page…");
    expect(await first.findByText("The page")).toBeTruthy();
    first.unmount();
    // Fetched ahead of time or visited before: no loading line, no second fetch.
    await loadPage(load);
    const second = render(<LazyPage load={load} />);
    expect(second.queryByRole("status")).toBeNull();
    expect(second.getByText("The page")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shows the page-error notice when a page's code cannot be fetched", async () => {
    const load = vi.fn(async () => { throw new Error("chunk failed to load"); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = render(<ErrorBoundary><LazyPage load={load} /></ErrorBoundary>);
      expect(await view.findByRole("alert")).toBeTruthy();
      expect(view.getByRole("alert").textContent).toContain("stopped working");
    } finally {
      spy.mockRestore();
    }
  });

  it("observes a scroll frame once, however often it renders", () => {
    const created = vi.fn();
    class CountingObserver { constructor() { created(); } observe() { /* not measured in tests */ } unobserve() { /* not measured */ } disconnect() { /* not measured */ } }
    const original = globalThis.ResizeObserver;
    vi.stubGlobal("ResizeObserver", CountingObserver);
    try {
      const view = render(<ScrollFrame label="Rows"><table><tbody><tr><td>one</td></tr></tbody></table></ScrollFrame>);
      view.rerender(<ScrollFrame label="Rows"><table><tbody><tr><td>one</td></tr><tr><td>two</td></tr></tbody></table></ScrollFrame>);
      view.rerender(<ScrollFrame label="Rows"><table><tbody><tr><td>three</td></tr></tbody></table></ScrollFrame>);
      expect(created).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubGlobal("ResizeObserver", original);
    }
  });
});
afterEach(() => vi.unstubAllGlobals());
