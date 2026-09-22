import { afterEach, beforeEach, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { queryClient } from "@/App";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
});
afterEach(() => api.uninstall());

/** Simulate the API's idempotency replay and a lost response after committing. */
function loseFirstResponse(path: string, method: string) {
  const send = globalThis.fetch;
  const replies = new Map<string, Response>();
  const requests: Array<{ key: string; body: string }> = [];
  globalThis.fetch = async (input, options) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    if (!url.includes(path) || options?.method !== method)
      return send(input, options);
    const key = new Headers(options.headers).get("Idempotency-Key")!;
    requests.push({ key, body: String(options.body) });
    if (replies.has(key)) return replies.get(key)!.clone();
    const response = await send(input, options);
    replies.set(key, response.clone());
    throw new TypeError("Response lost after request reached server");
  };
  return requests;
}

it("freezes an unconfirmed settings draft and recovers the original revision and key", async () => {
  const user = userEvent.setup();
  renderApp("/settings");
  await screen.findByText("07:00 WAT");
  await user.click(screen.getByRole("button", { name: "Edit" }));
  const amount = screen.getByLabelText(
    "Notification cost alert (₦ per collection)",
  );
  await user.clear(amount);
  await user.type(amount, "10.29");
  const requests = loseFirstResponse("/v1/settings", "PATCH");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Settings outcome unconfirmed");
  expect(api.state().settings.notificationCostAlertKobo).toBe(1029);
  expect(amount.closest("fieldset")?.disabled).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(
    screen.getByRole("button", { name: "Retry original settings request" }),
  );
  await screen.findByText("Settings saved");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

it("retries an emergency-stop outcome without toggling the changed server state back", async () => {
  const user = userEvent.setup();
  renderApp("/settings");
  await screen.findByText("07:00 WAT");
  const reason = screen.getByLabelText(
    "Reason for changing the emergency stop",
  );
  await user.type(reason, "Stop sample operations for a review");
  const requests = loseFirstResponse("/v1/actions", "POST");
  await user.click(
    screen.getByRole("button", { name: "Activate emergency stop" }),
  );
  const retry = await screen.findByRole("button", {
    name: "Retry original emergency-stop request",
  });
  expect(api.state().merchant.killSwitch).toBe(true);
  await queryClient.invalidateQueries();
  expect((reason as HTMLInputElement).disabled).toBe(true);
  await user.click(retry);
  await screen.findByText("Emergency stop updated");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(api.state().merchant.killSwitch).toBe(true);
});

it("keeps a lost demo-role request recoverable even after the server changed roles", async () => {
  const user = userEvent.setup();
  renderApp("/settings");
  await screen.findByText("07:00 WAT");
  const select = screen.getByLabelText("Demo role");
  await user.selectOptions(select, "Finance");
  const requests = loseFirstResponse("/v1/actions", "POST");
  await user.click(screen.getByRole("button", { name: "Switch role" }));
  const retry = await screen.findByRole("button", {
    name: "Retry original role request",
  });
  expect(api.role).toBe("Finance");
  expect((select as HTMLSelectElement).disabled).toBe(true);
  await queryClient.invalidateQueries();
  await user.click(retry);
  await screen.findByText("Demo role changed");
  expect(requests[1]).toEqual(requests[0]);
});

it("locks a mandate draft after a lost create response, then recovers one mandate and the original key", async () => {
  const user = userEvent.setup();
  renderApp("/mandates");
  await user.click(
    await screen.findByRole("button", { name: "Create synthetic mandate" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Create synthetic mandate",
  });
  await user.type(
    within(dialog).getByLabelText(/Mandate name/),
    "Recovery sample mandate",
  );
  const customer = api.state().records.find((r) => r.kind === "customers")!;
  const policy = api.state().records.find((r) => r.kind === "policies")!;
  await user.selectOptions(
    within(dialog).getByLabelText(/Customer/),
    customer.id,
  );
  await user.type(within(dialog).getByLabelText(/Debit limit/), "2000.29");
  await user.type(
    within(dialog).getByLabelText(/Provider reference/),
    "SYN-RECOVER-MANDATE",
  );
  await user.type(
    within(dialog).getByLabelText(/Consent evidence reference/),
    "SYN-CONSENT-RECOVERY",
  );
  await user.selectOptions(within(dialog).getByLabelText(/^Policy/), policy.id);
  const requests = loseFirstResponse("/v1/records/mandates", "POST");
  await user.click(
    within(dialog).getByRole("button", { name: "Create mandate" }),
  );
  await screen.findByText("Mandate creation outcome unconfirmed");
  expect(
    within(dialog)
      .getByLabelText(/Mandate name/)
      .closest("fieldset")?.disabled,
  ).toBe(true);
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Cancel",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();
  await user.click(
    within(dialog).getByRole("button", {
      name: "Retry original mandate request",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(
    api.state().records.filter((r) => r.reference === "SYN-RECOVER-MANDATE"),
  ).toHaveLength(1);
});
