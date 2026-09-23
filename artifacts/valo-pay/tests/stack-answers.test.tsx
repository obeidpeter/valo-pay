// The console reads the pilot, team, operations and connected answers through
// the shared schemas (audit item 24): an answer the schema does not describe
// is a problem the page shows, or an unconfirmed outcome for a write, never
// something rendered as if it were data. A field a newer service added is
// not a malformed answer.
import { afterEach, beforeEach, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent } from "./harness";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ now: "2026-09-21T10:00:00.000Z" });
});
afterEach(() => api.uninstall());

/** Answers matching requests with a 200 body built from the fake API's own answer; every other request reaches the fake API. */
function answerWith(method: string, pattern: RegExp, body: (original: any) => unknown) {
  const send = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://localhost");
    if ((options?.method ?? "GET").toUpperCase() !== method || !pattern.test(url.pathname)) return send(input, options);
    const original = await (await send(input, options)).json();
    return new Response(JSON.stringify(body(original)), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

it("shows a problem instead of a team directory when the answer is incomplete", async () => {
  answerWith("GET", /\/v1\/team$/, () => ({ mode: "staff", actor: "Clerk:user_1", members: [{ id: "member-1", name: "Ada Obi" }], invitations: [], events: [], message: "Verified staff access." }));
  renderApp("/team");
  await screen.findByText(/The service's answer was incomplete/);
  expect(screen.queryByText("Ada Obi")).toBeNull();
});

it("shows a problem instead of the Credit Desk when the connected answer is incomplete", async () => {
  answerWith("GET", /\/v1\/connected$/, (original) => ({ ...original, credit: { mode: "synthetic", customers: "none" } }));
  renderApp("/credit-desk");
  await screen.findByText("Unable to load Credit Desk");
  screen.getByText(/The service's answer was incomplete/);
});

it("holds a lender set-up whose confirmation is not a lender as unconfirmed", async () => {
  answerWith("POST", /\/v1\/pilot\/lenders$/, () => ({ id: "not-a-lender" }));
  const user = userEvent.setup();
  renderApp("/pilot");
  await user.type(await screen.findByLabelText("Lender name"), "Answer check lender");
  await user.click(screen.getByRole("button", { name: /Create lender/ }));
  await screen.findByText("Outcome not confirmed");
});

it("holds a connected action whose record is malformed as unconfirmed", async () => {
  answerWith("POST", /\/v1\/connected\/actions$/, () => ({ message: "Sample workspace updated.", record: { id: 7 }, mode: "synthetic", externalInstructionPerformed: false }));
  const user = userEvent.setup();
  renderApp("/credit-desk");
  await screen.findByRole("heading", { name: "Credit Desk", level: 1 });
  await user.type(screen.getByLabelText("Reason for this assessment"), "Check that a malformed confirmation is held");
  await user.click(screen.getByRole("button", { name: /Run sample assessment/ }));
  await screen.findByText("Previous action outcome unconfirmed");
});

it("reads an answer that carries a field a newer service added", async () => {
  answerWith("GET", /\/v1\/pilot\/progress$/, (original) => ({ ...original, addedByANewerService: true, steps: original.steps.map((step: object) => ({ ...step, addedLater: "ignored" })) }));
  renderApp("/pilot");
  await screen.findByRole("heading", { name: "Onboard a lender" });
  expect(screen.queryByText(/The service's answer was incomplete/)).toBeNull();
});
