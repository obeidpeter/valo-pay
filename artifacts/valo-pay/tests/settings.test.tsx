import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextCloseInstant } from "@workspace/valopay-schema";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("settings", () => {
  it("edits the daily close time, and shows the server's rejection of an invalid one", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    expect(await screen.findByText("07:00 WAT")).toBeTruthy();
    expect(screen.getByText(/^On · next /)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByPlaceholderText("07:00");
    await user.clear(input);
    await user.type(input, "09:30");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("09:30 WAT")).toBeTruthy();
    const patch = api.calls.find((call) => call.method === "PATCH" && call.path === "/v1/settings");
    expect(patch?.body).toMatchObject({ closeTime: "09:30", scheduledCloseEnabled: true });
    expect(patch?.status).toBe(200);
    expect(api.state().settings.closeTime).toBe("09:30");
    expect(api.state().settings.nextCloseAt).toBe(nextCloseInstant(api.now, "09:30"));
    expect(screen.getByText("Settings saved")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const again = screen.getByPlaceholderText("07:00");
    await user.clear(again);
    await user.type(again, "25:00");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // The console checks the format itself before asking the server, and says so at the field.
    expect(await screen.findByText("Enter the close time as HH:MM in West Africa Time, for example 07:00.")).toBeTruthy();
    expect(again.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(again);
    expect(api.calls.filter((call) => call.method === "PATCH" && call.path === "/v1/settings").length).toBe(1);
    // A refusal only the server can make is shown in the section, under the field it names.
    api.failNext(/^\/v1\/settings$/, { status: 400, error: "closeTime must be a WAT time as HH:MM, for example 07:00 (REC-01)." });
    await user.clear(again);
    await user.type(again, "10:00");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Settings not saved")).toBeTruthy();
    expect(screen.getByText("closeTime must be a WAT time as HH:MM, for example 07:00 (REC-01).")).toBeTruthy();
    expect(again.getAttribute("aria-describedby")).toBe("settings-closeTime-error");
    expect(api.state().settings.closeTime).toBe("09:30");
    expect(api.calls.filter((call) => call.method === "PATCH" && call.path === "/v1/settings").at(-1)?.status).toBe(400);
  });

  it("refuses the change for a persona that is not Admin", async () => {
    const user = userEvent.setup();
    api.role = "Finance";
    renderApp("/settings");
    await screen.findByText("07:00 WAT");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Only an Admin can change lender settings.")).toBeTruthy();
  });
});
