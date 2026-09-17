import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("audit", () => {
  it("verifies the chain and shows the result on the page", async () => {
    const user = userEvent.setup();
    renderApp("/audit");
    await user.click(await screen.findByRole("button", { name: /Verify Chain Integrity/ }));
    // The toast is a live region too, so the result box is found by its text.
    const status = (await screen.findByText("Chain intact")).closest('[role="status"]')!;
    expect(status.textContent).toMatch(/1 entries · head hash [0-9a-f]{64}/);
    expect(api.calls.find((call) => call.path === "/v1/actions")?.body).toMatchObject({ action: "verify_audit" });
  });
});
