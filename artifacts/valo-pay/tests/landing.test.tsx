import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

const hrefs = (name: RegExp) => screen.getAllByRole("link", { name }).map((link) => link.getAttribute("href"));

describe("landing page", () => {
  it("says what Valo Pay is and is not, with every way in a real link, and creates no sandbox", async () => {
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Know what was paid, what is due, and what needs attention." })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Valo Pay · Collections operations layer"));
    // The descriptor, the promise and "we never hold money" are the first three lines (marketing strategy 3.1).
    const lines = Array.from(screen.getByRole("main").querySelectorAll("p, h1")).slice(0, 3).map((node) => node.textContent ?? "");
    expect(lines[0]).toMatch(/^A collections operations layer for lenders/);
    expect(lines[1]).toBe("Know what was paid, what is due, and what needs attention.");
    expect(lines[2]).toMatch(/^We never hold money\./);
    // Both ways in are links to real addresses, repeated where a reader would look for them.
    expect(hrefs(/Open the sandbox/)).toEqual(["/overview", "/overview", "/overview"]);
    expect(hrefs(/^Sign in$/)).toEqual(["/sign-in", "/sign-in", "/sign-in"]);
    expect(screen.getByRole("link", { name: "Skip to main content" }).getAttribute("href")).toBe("#main");
    expect(screen.getByRole("link", { name: "See how it works" }).getAttribute("href")).toBe("#how");
    // What we are not is stated, and the illustration is labelled as one.
    expect(screen.getByRole("heading", { name: "What Valo Pay does, and where it stops" })).toBeTruthy();
    expect(screen.getByText("Not a wallet, not a bank, not a payment provider")).toBeTruthy();
    expect(screen.getByText("Illustration with synthetic figures. These are sample records, not live results.")).toBeTruthy();
    // Reading about the product asks the API for nothing: no workspace, no sandbox cookie.
    expect(api.calls).toEqual([]);
  });

  it("opens the sandbox only when the visitor chooses to", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByRole("heading", { level: 1 });
    expect(api.calls.some((call) => call.path === "/v1/workspace")).toBe(false);
    await user.click(screen.getAllByRole("link", { name: /Open the sandbox/ })[0]!);
    expect(await screen.findByRole("heading", { name: "Operations overview" })).toBeTruthy();
    expect(api.calls.some((call) => call.path === "/v1/workspace")).toBe(true);
    await waitFor(() => expect(document.title).toBe("Overview · Valo Pay"));
  });
});
