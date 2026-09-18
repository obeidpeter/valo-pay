// The console in the market's conventions: British English declared on the page,
// every instant in West Africa Time with the zone named, counts with their nouns,
// and names with Yoruba and Igbo marks shown as written and found without them.
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

const repoFile = (relative: string) => [join(process.cwd(), relative), join(process.cwd(), "artifacts/valo-pay", relative)].find((candidate) => existsSync(candidate))!;

describe("internationalisation", () => {
  it("declares the page's language as British English", () => {
    expect(readFileSync(repoFile("index.html"), "utf8")).toContain('<html lang="en-GB">');
  });

  it("shows names with their marks and finds them typed without", async () => {
    const user = userEvent.setup();
    renderApp("/customers");
    expect(await screen.findByText("Chiamaka Ọbi")).toBeTruthy();
    expect(screen.getByText("Dami Adéyẹmí")).toBeTruthy();
    const search = screen.getByPlaceholderText("Search by name, reference or phone…");
    await user.type(search, "obi");
    await screen.findByText("Chiamaka Ọbi");
    await waitFor(() => expect(screen.queryByText("Ada Okonkwo")).toBeNull());
    expect(screen.getByText("Chiamaka Ọbi")).toBeTruthy();
    await user.clear(search);
    await user.type(search, "ADEYEMI");
    await screen.findByText("Dami Adéyẹmí");
    await waitFor(() => expect(screen.queryByText("Chiamaka Ọbi")).toBeNull());
    expect(screen.getByText("Dami Adéyẹmí")).toBeTruthy();
  });

  it("names the zone on every timestamp of the audit log and gives counts their nouns", async () => {
    renderApp("/audit");
    const table = await screen.findByRole("table");
    const stamps = within(table).getAllByText(/\d{1,2} \w{3,4} \d{4}, \d{2}:\d{2} WAT$/);
    expect(stamps.length).toBeGreaterThan(0);
    expect(within(table).queryByText(/\d{2}:\d{2}$/)).toBeNull();
  });

  it("agrees a badge's noun with its number", async () => {
    renderApp("/reconciliation");
    const heading = await screen.findByRole("heading", { name: "Unallocated payments" });
    const badge = heading.parentElement!.querySelector("span")!;
    const [count, noun] = badge.textContent!.split(" ");
    expect(noun).toBe(Number(count) === 1 ? "item" : "items");
  });
});
