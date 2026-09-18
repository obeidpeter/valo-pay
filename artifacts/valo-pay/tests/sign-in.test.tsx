import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

// jsdom serves the console from localhost with no Clerk key, so there is no account to sign into (lib/auth.tsx).
describe("sign-in pages without Clerk", () => {
  it("says sign-in is unavailable on this host and offers the sandbox instead of a form", async () => {
    renderApp("/sign-in");
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in to your workspace" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign-in is unavailable here" })).toBeTruthy();
    expect(screen.getByText("You cannot sign in at this address. You can explore the sandbox without an account.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("link", { name: /Continue to the sandbox/ }).getAttribute("href")).toBe("/overview");
    expect(screen.getAllByRole("link", { name: "Back to home" }).map((link) => link.getAttribute("href"))).toEqual(["/", "/"]);
    expect(screen.getByRole("heading", { name: "Why sign in?" })).toBeTruthy();
    expect(screen.getByText(/We never hold money\. Nothing in this console moves funds/)).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Sign in to your workspace · Valo Pay"));
    expect(api.calls).toEqual([]);
  });

  it("says the same for creating an account", async () => {
    renderApp("/sign-up");
    expect(await screen.findByRole("heading", { level: 1, name: "Create your workspace" })).toBeTruthy();
    expect(screen.getByText("You cannot create an account at this address. You can explore the sandbox without an account.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Continue to the sandbox/ }).getAttribute("href")).toBe("/overview");
    await waitFor(() => expect(document.title).toBe("Create your workspace · Valo Pay"));
    expect(api.calls).toEqual([]);
  });
});
