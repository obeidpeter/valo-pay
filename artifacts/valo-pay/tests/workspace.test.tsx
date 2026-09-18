import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, within, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

const workspace = /^\/v1\/workspace$/;

describe("workspace", () => {
  it("says what is happening until the workspace arrives", async () => {
    renderApp("/overview");
    expect(screen.getByRole("status").textContent).toBe("Loading your workspace…");
    expect(await screen.findByRole("heading", { name: "Operations Overview" })).toBeTruthy();
    expect(screen.queryByText("Loading your workspace…")).toBeNull();
  });

  it("passes on the service's own words when it asks the visitor to wait, and tries again on request", async () => {
    const user = userEvent.setup();
    api.failNext(workspace, { status: 429, error: "Too many new sandboxes from this address; please try again in an hour." });
    renderApp("/overview");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { level: 1, name: "The service asked you to wait" })).toBeTruthy();
    expect(within(alert).getByText("Too many new sandboxes from this address; please try again in an hour.")).toBeTruthy();
    expect(within(alert).getByText("No lender data has been changed.")).toBeTruthy();
    // The console is not shown without a workspace; the frame offers the start, twice, and the page says so in its title.
    expect(screen.queryByRole("link", { name: /Audit Log/ })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Back to the start" }).map((link) => link.getAttribute("href"))).toEqual(["/", "/"]);
    await waitFor(() => expect(document.title).toBe("Workspace not loaded · Valo Pay"));

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Operations Overview" })).toBeTruthy();
    expect(api.calls.filter((call) => call.path === "/v1/workspace").map((call) => call.status)).toEqual([429, 200]);
    await waitFor(() => expect(document.title).toBe("Overview · Valo Pay"));
  });

  it("says when the service could not be reached at all", async () => {
    api.failNext(workspace, "offline");
    renderApp("/overview");
    expect(await screen.findByRole("heading", { level: 1, name: "The console could not reach the service" })).toBeTruthy();
    expect(screen.getByText("Check your connection and try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("keeps a service error's internals to itself and gives the time for a report", async () => {
    api.failNext(workspace, { status: 500, error: "relation \"valopay_workspaces\" does not exist" });
    renderApp("/overview");
    expect(await screen.findByRole("heading", { level: 1, name: "The service hit an error" })).toBeTruthy();
    expect(screen.getByText(/If it continues, tell us the time:/)).toBeTruthy();
    expect(screen.queryByText(/valopay_workspaces/)).toBeNull();
  });
});
