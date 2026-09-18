import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("reports", () => {
  it("runs a daily close from the page and shows the REC-07 chips, the trigger and the schedule", async () => {
    const user = userEvent.setup();
    renderApp("/reports");
    expect(await screen.findByText("No daily close yet")).toBeTruthy();
    expect(screen.getByText(/^Next daily close: .+ WAT, then every day at this time\.$/)).toBeTruthy();
    expect(screen.getByText("Counts from the first daily close.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Run daily close" }));
    // The close is written by the real domain and read back through the reports contract.
    expect(await screen.findByText(/^manual$/)).toBeTruthy();
    const action = api.calls.find((call) => call.method === "POST" && call.path === "/v1/actions");
    expect(action?.body).toMatchObject({ action: "daily_close" });
    expect(action?.status).toBe(200);
    const closes = api.state().records.filter((record) => record.kind === "closes");
    expect(closes).toHaveLength(1);
    expect(closes[0]!.data.schedule.trigger).toBe("manual");
    for (const label of ["Unmatched at start:", "Payment records received:", "Exceptions:", "Retry decisions:"]) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText(String(closes[0]!.data.summary))).toBeTruthy();
    expect(screen.getByText(/Since the first daily close on/)).toBeTruthy();
    expect(screen.queryByText("No daily close yet")).toBeNull();
  });

  it("says when the automatic close is off", async () => {
    api.mutate((state) => { state.settings.scheduledCloseEnabled = false; });
    renderApp("/reports");
    expect(await screen.findByText("Automatic daily close is off. Run closes manually.")).toBeTruthy();
  });
});
