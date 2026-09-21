import { afterEach, beforeEach, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";
import { connectedRevision } from "../../api-server/src/domain/connected";
import { queryClient } from "@/App";
import type { ConnectedView } from "@/lib/connected";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ now: "2026-09-21T10:00:00.000Z" });
});
afterEach(() => api.uninstall());

it.each(["Meridian Credit", "Cedar Cooperative"])("retries the original committed request after a lost response and automatic revision refresh in %s", async (lenderName) => {
  // Seed ids are random. Exercise each lender explicitly rather than letting
  // UUID ordering decide which workspace this regression covers.
  const merchantId = api.merchantIds.find(
    (id) => api.state(id).merchant.name === lenderName,
  )!;
  api.merchantIds = [merchantId, ...api.merchantIds.filter((id) => id !== merchantId)];
  const applicant = api.state(merchantId).records.find(
    (record) => record.kind === "customers" && record.reference === "DEMO-C1001",
  )!;
  const originalFetch = globalThis.fetch;
  const committed = new Map<string, Response>();
  const submissions: { key: string; body: string }[] = [];
  let loseResponse = true;
  globalThis.fetch = async (input, options) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    if (options?.method !== "POST" || !url.includes("/connected/actions"))
      return originalFetch(input, options);
    const key = new Headers(options.headers).get("Idempotency-Key")!;
    submissions.push({ key, body: String(options.body) });
    if (committed.has(key)) return committed.get(key)!.clone();
    const response = await originalFetch(input, options);
    if (response.ok) committed.set(key, response.clone());
    if (response.ok && loseResponse) {
      loseResponse = false;
      throw new TypeError("Connection lost after the server committed");
    }
    return response;
  };
  const user = userEvent.setup();
  renderApp("/credit-desk");
  await screen.findByRole("heading", { name: "Credit Desk", level: 1 });
  await user.selectOptions(screen.getByLabelText("Applicant"), applicant.id);
  await user.type(
    screen.getByLabelText("Reason for this assessment"),
    "Check the synthetic evidence before reviewer handoff",
  );
  await user.click(
    screen.getByRole("button", { name: /Run sample assessment/ }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Connection lost after the server committed",
  );
  // Synchronize on the regression's actual precondition: React Query has
  // applied the automatic refetch and its new revision before the retry.
  // The score's display copy is unrelated to retry/idempotency semantics.
  await waitFor(() => {
    const refreshed = queryClient.getQueryData<ConnectedView>(["connected", merchantId]);
    expect(refreshed?.revision).toBe(connectedRevision(api.state(merchantId)));
    expect(refreshed?.revision).not.toBe(JSON.parse(submissions[0]!.body).expectedRevision);
    expect(refreshed?.credit.assessments).toHaveLength(1);
  });
  await screen.findByRole("combobox", { name: "Assessment version" });
  expect(
    api
      .state()
      .records.filter(
        (record) => record.kind === "connected-credit-assessments",
      ),
  ).toHaveLength(1);
  expect(connectedRevision(api.state())).not.toBe(
    JSON.parse(submissions[0]!.body).expectedRevision,
  );
  await user.click(
    screen.getByRole("button", { name: /Run sample assessment/ }),
  );
  await waitFor(() => expect(submissions).toHaveLength(2));
  expect(submissions[1]).toEqual(submissions[0]);
  expect(
    api
      .state()
      .records.filter(
        (record) => record.kind === "connected-credit-assessments",
      ),
  ).toHaveLength(1);
  await screen.findByText(
    /A new immutable sample assessment has been recorded/,
  );
});

it("a definite stale-version rejection releases the old revision for an explicitly retried action", async () => {
  const originalFetch = globalThis.fetch;
  const submissions: { key: string; body: string }[] = [];
  let rejectFirst = true;
  globalThis.fetch = async (input, options) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    if (options?.method !== "POST" || !url.includes("/connected/actions"))
      return originalFetch(input, options);
    submissions.push({
      key: new Headers(options.headers).get("Idempotency-Key")!,
      body: String(options.body),
    });
    if (rejectFirst) {
      rejectFirst = false;
      api.mutate((state) => {
        state.settings.minimumTicketKobo =
          Number(state.settings.minimumTicketKobo ?? 0) + 1;
      });
      return new Response(
        JSON.stringify({
          error:
            "The workspace changed. Refresh and review before trying again.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, options);
  };
  const user = userEvent.setup();
  renderApp("/credit-desk");
  await screen.findByRole("heading", { name: "Credit Desk", level: 1 });
  await user.type(
    screen.getByLabelText("Reason for this assessment"),
    "Check the current synthetic application evidence",
  );
  await user.click(
    screen.getByRole("button", { name: /Run sample assessment/ }),
  );
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: /Run sample assessment/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(
    screen.getByRole("button", { name: /Run sample assessment/ }),
  );
  await screen.findByText(
    /A new immutable sample assessment has been recorded/,
  );
  expect(submissions).toHaveLength(2);
  expect(submissions[1]!.key).not.toBe(submissions[0]!.key);
  expect(JSON.parse(submissions[1]!.body).expectedRevision).not.toBe(
    JSON.parse(submissions[0]!.body).expectedRevision,
  );
  expect(
    api
      .state()
      .records.filter(
        (record) => record.kind === "connected-credit-assessments",
      ),
  ).toHaveLength(1);
});
