import { beforeEach, afterEach, it, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, within } from "./harness";
import { executeAction } from "../../api-server/src/domain/actions";
import { makeRecord } from "../../api-server/src/domain/records";
import { queryClient } from "@/App";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());
const emptyClose = () => api.mutate((state, ctx) => { state.records = []; return executeAction(state, ctx, { action: "daily_close" }); });

it("shows evidence-led journey states instead of treating a payment or close as completed work", async () => {
  emptyClose();
  api.mutate(state => makeRecord(state, "payments", { status: "unallocated", amountKobo: 500000 }));
  renderApp("/pilot");
  const reconcile = await screen.findByRole("link", { name: /Reconcile payments/ });
  expect(within(reconcile).getByText(/In progress/)).toBeTruthy();
  const closing = screen.getByRole("link", { name: /Review the close/ });
  expect(within(closing).getByText(/Blocked/)).toBeTruthy();
  expect(screen.getByText(/Records changed after this close/)).toBeTruthy();
  const exceptions = screen.getByRole("link", { name: /Resolve exceptions/ });
  expect(within(exceptions).getByText(/Not started/)).toBeTruthy();
  expect(screen.getByText(/Real staff access is not enabled/)).toBeTruthy();
});

it("prepares an exact close snapshot and prevents approving it by switching demo roles", async () => {
  emptyClose(); const user = userEvent.setup();
  renderApp("/close-review");
  await user.selectOptions(await screen.findByLabelText("Finance reviewer"), "Sandbox Finance");
  await user.type(screen.getByLabelText("Preparation summary"), "Checked the source records and synthetic zero-activity close.");
  await user.click(screen.getByRole("button", { name: "Submit for Finance review" }));
  await screen.findByText(/Waiting for the named Finance reviewer/);
  const review = api.state().records.find(record => record.kind === "close-reviews")!;
  expect(review.status).toBe("awaiting_review");
  expect(review.data.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
  const snapshot = JSON.stringify(review.data.snapshot);
  cleanup(); queryClient.clear(); api.role = "Finance"; renderApp("/close-review");
  await screen.findByText(/You prepared this close/);
  expect(screen.queryByRole("button", { name: "Record Finance approval" })).toBeNull();
  expect(JSON.stringify(api.state().records.find(record => record.id === review.id)!.data.snapshot)).toBe(snapshot);
});

it("requires an independent reviewer acknowledgement and preserves the recorded snapshot", async () => {
  emptyClose(); const user = userEvent.setup(); renderApp("/close-review");
  await user.selectOptions(await screen.findByLabelText("Finance reviewer"), "Sandbox Finance");
  await user.type(screen.getByLabelText("Preparation summary"), "Checked the complete synthetic closing report.");
  await user.click(screen.getByRole("button", { name: "Submit for Finance review" }));
  await screen.findByText(/Waiting for the named Finance reviewer/);
  cleanup(); queryClient.clear(); api.role = "Finance"; api.principalId = "synthetic-independent-reviewer"; renderApp("/close-review");
  await user.type(await screen.findByLabelText("Review note"), "Independently checked this exact close snapshot and accepted it.");
  const button = screen.getByRole("button", { name: "Record Finance approval" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await user.click(screen.getByRole("checkbox", { name: /I inspected this snapshot/ }));
  await user.click(button);
  await screen.findByText("Approved");
  expect(api.state().records.find(record => record.kind === "close-reviews")!.status).toBe("approved");
});
