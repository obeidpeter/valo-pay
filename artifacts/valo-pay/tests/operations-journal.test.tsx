// Backlog item UX-B02-X3 and decision 3: Operations says enough to match an entry to the form that was lost, opens the
// saved result of every record kind that has a page, and the console shows the count of unconfirmed requests on the
// Operations link, where a person who reloads sees it.
import { afterEach, beforeEach, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
/** Serves the journal and its pending count from `items`, and everything else from the fake API. */
function journal(items: Array<Record<string, unknown>>, pending = items.filter((item) => item.status === "pending").length) {
  const send = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(), "http://localhost");
    if (url.pathname === "/api/v1/operations") return json({ items, total: items.length, offset: 0 });
    if (url.pathname === "/api/v1/operations/pending") return json({ pending });
    return send(input, options);
  };
}
const entry = (id: string, status: string, rest: Record<string, unknown> = {}) => ({
  id, label: `Save ${id}`, actor: "Sandbox Admin", role: "Admin", status, createdAt: api.now, updatedAt: api.now,
  message: status === "completed" ? "The service saved this request." : "Completion has not been confirmed. Check the original request.",
  recordId: null, recordKind: null, summary: null, ...rest,
});
const card = (heading: string) => screen.getByRole("heading", { name: heading }).closest("article") as HTMLElement;

it("names what each request asked and the record it names, never more", async () => {
  journal([
    entry("pending-change", "pending", { summary: { action: "Change a record", targetKind: "customers", targetId: "cus-1", details: [{ name: "Status", value: "inactive" }] } }),
    entry("pending-action", "pending", { summary: { action: "Mandate suspend", targetKind: "mandates", targetId: "mnd-1", details: [] } }),
    entry("sealed", "pending"),
  ]);
  renderApp("/operations");
  await screen.findByRole("heading", { name: "Change a record" });
  const change = card("Change a record");
  expect(change.textContent).toContain("Customers cus-1");
  expect(change.textContent).toContain("Status: inactive");
  expect(within(change).getByRole("link", { name: "Open the record" }).getAttribute("href")).toBe("/customers/cus-1");
  const action = card("Mandate suspend");
  expect(within(action).getByRole("link", { name: "Open the record" }).getAttribute("href")).toBe(`/mandates?record=mnd-1&lender=${api.merchantIds[0]}#record-mnd-1`);
  // A sealed request has no summary: its label stands in.
  expect(card("Save sealed").textContent).not.toContain("Open the record");
});

it("opens the saved result of every record kind that has a page", async () => {
  const lender = api.merchantIds[0]!;
  const pages: Array<[string, string | null]> = [
    ["customers", "/customers/r-customers"],
    ["exceptions", "/cases/r-exceptions"],
    ["mandates", `/mandates?record=r-mandates&lender=${lender}#record-r-mandates`],
    ["due-items", `/reconciliation?dueItem=r-due-items&lender=${lender}#record-r-due-items`],
    ["import-batches", "/imports?batch=r-import-batches"],
    ["import-corrections", "/imports"],
    ["exports", "/exports"],
    ["closes", "/reports?view=operations#daily-closes"],
    ["close-reviews", "/close-review"],
    ["payments", "/reconciliation"],
    ["allocations", "/reconciliation"],
    ["policies", "/policies"],
    ["templates", "/policies"],
    ["reviews", "/evidence"],
    ["evidence", "/evidence"],
    ["source-profiles", "/sources"],
    ["provider-events", "/sources"],
    ["retention-runs", "/lifecycle"],
    ["work-events", "/work"],
    ["connected-intents", "/pay-by-bank"],
    ["connected-credit-assessments", "/credit-desk"],
    ["connected-cash-forecasts", "/cash-desk"],
    ["costs", null],
  ];
  journal(pages.map(([kind]) => entry(kind, "completed", { recordId: `r-${kind}`, recordKind: kind })));
  renderApp("/operations");
  await screen.findByRole("heading", { name: "Save customers" });
  for (const [kind, href] of pages) {
    const link = within(card(`Save ${kind}`)).queryByRole("link", { name: "Open saved result" });
    expect(link?.getAttribute("href") ?? null, kind).toBe(href);
  }
});

it("shows the count of unconfirmed requests on the Operations link", async () => {
  journal([entry("one", "pending"), entry("two", "pending")]);
  renderApp("/overview");
  const links = await screen.findAllByRole("link", { name: "Operations, 2 unconfirmed requests" });
  expect(links[0]!.getAttribute("href")).toBe("/operations");
});

it("shows no count when nothing waits", async () => {
  renderApp("/overview");
  await waitFor(() => expect(api.calls.some((call) => call.path === "/v1/operations/pending")).toBe(true));
  expect(screen.getAllByRole("link", { name: "Operations" }).length).toBeGreaterThan(0);
  expect(screen.queryAllByRole("link", { name: /unconfirmed/ })).toEqual([]);
});
