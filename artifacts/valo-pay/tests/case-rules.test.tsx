import { afterEach, beforeEach, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

// The case form offers what coordinateCase accepts: only the assignee or an
// Admin changes a case someone holds, a case goes only to someone on the
// lender's case list, the follow-up is in the future and the next action and
// note are at least 3 characters. Its link opens this exception in Exceptions.
let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

const exception = () => api.state().records.find((r) => r.kind === "exceptions" && r.status === "open")!;
function assign(id: string, assignee: string, assigneeName: string) {
  api.mutate((state) => {
    const record = state.records.find((r) => r.id === id)!;
    record.status = "in_progress";
    record.data.case = { assignee, assigneeName, nextAction: "Check the payer", nextActionAt: "2030-01-01T09:00:00.000Z", evidenceIds: [] };
  });
}
const writes = () => api.calls.filter((call) => call.method !== "GET");

it("explains that only the assignee or an Admin can change a case someone else holds", async () => {
  const item = exception();
  assign(item.id, "Sandbox Finance", "Sandbox Finance");
  api.role = "Operations";
  renderApp(`/cases/${item.id}`);
  const save = await screen.findByRole("button", { name: "Save next step" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  const reason = document.getElementById(save.getAttribute("aria-describedby")!)!;
  expect(reason.textContent).toBe("This case is assigned to Sandbox Finance. Only Sandbox Finance or an Admin can record its next step or hand it over.");
  expect((screen.getByLabelText("Next action") as HTMLInputElement).closest("fieldset")?.disabled).toBe(true);
  expect(writes()).toEqual([]);
});

it("lets an Admin hand over a case someone else holds, to a person on the lender's case list only", async () => {
  const user = userEvent.setup();
  const item = exception();
  assign(item.id, "Sandbox Finance", "Sandbox Finance");
  renderApp(`/cases/${item.id}`);
  const select = (await screen.findByLabelText("Assigned to")) as HTMLSelectElement;
  expect(select.disabled).toBe(false);
  expect([...select.options].map((option) => option.value)).toEqual(["Sandbox Admin", "Sandbox Operations", "Sandbox Finance", "Sandbox Compliance reviewer"]);
  expect(document.getElementById("case-assignee-help")?.textContent).toBe("Only people who can work on cases for this lender are listed. Read-only staff cannot be given a case.");
  await user.selectOptions(select, "Sandbox Operations");
  await user.type(screen.getByLabelText("Handover or progress note"), "Operations should call the payer.");
  await user.click(screen.getByRole("button", { name: "Save handover" }));
  await screen.findByText("Case update saved with its handover history.");
  expect(api.state().records.find((r) => r.id === item.id)?.data.case).toMatchObject({ assignee: "Sandbox Operations", assigneeName: "Sandbox Operations" });
});

it("asks for a new assignee when the person holding the case can no longer work on cases", async () => {
  const user = userEvent.setup();
  const item = exception();
  assign(item.id, "Clerk:former-analyst", "Former analyst");
  renderApp(`/cases/${item.id}`);
  const select = (await screen.findByLabelText("Assigned to")) as HTMLSelectElement;
  const former = [...select.options].find((option) => option.value === "Clerk:former-analyst")!;
  expect(former.disabled).toBe(true);
  expect(former.textContent).toBe("Former analyst · can no longer work on cases");
  expect(document.getElementById("case-assignee-help")?.textContent).toBe("Former analyst can no longer work on cases for this lender. Choose who takes the case over.");
  expect((screen.getByRole("button", { name: "Save next step" }) as HTMLButtonElement).disabled).toBe(true);
  await user.selectOptions(select, "Sandbox Finance");
  expect((screen.getByRole("button", { name: "Save handover" }) as HTMLButtonElement).disabled).toBe(false);
  expect(writes()).toEqual([]);
});

it("names each missing or past value at its field before asking the service", async () => {
  const user = userEvent.setup();
  const item = exception();
  renderApp(`/cases/${item.id}`);
  const nextAction = await screen.findByLabelText("Next action");
  expect(document.getElementById("case-assignee-help")?.textContent).toBe("Claiming assigns this case to you. Once it is yours, you can hand it over.");
  const followUp = screen.getByLabelText("Follow-up time (WAT)");
  fireEvent.change(followUp, { target: { value: "2020-01-01T09:00" } });
  await user.type(nextAction, "ab");
  await user.click(screen.getByRole("button", { name: "Claim and save next step" }));
  expect(await screen.findByText("Check the 3 highlighted fields before saving.")).toBeTruthy();
  expect(screen.getByText("Enter the next action, in at least 3 characters.")).toBeTruthy();
  expect(screen.getByText("Choose a follow-up time in the future. The exception deadline stays as it is.")).toBeTruthy();
  expect(screen.getByText("Enter a handover or progress note, in at least 3 characters.")).toBeTruthy();
  expect(nextAction.getAttribute("aria-invalid")).toBe("true");
  expect(followUp.getAttribute("aria-describedby")).toBe("case-follow-up-help case-follow-up-error");
  expect(document.activeElement).toBe(nextAction);
  expect(writes()).toEqual([]);
  // Correcting a field clears its message, and the claim is then sent once.
  await user.type(nextAction, "c");
  expect(nextAction.getAttribute("aria-invalid")).toBeNull();
  fireEvent.change(followUp, { target: { value: "2030-01-01T09:00" } });
  await user.type(screen.getByLabelText("Handover or progress note"), "Checked the source reference.");
  await user.click(screen.getByRole("button", { name: "Claim and save next step" }));
  await screen.findByText("Case update saved with its handover history.");
  expect(writes().map((call) => call.path)).toEqual([`/v1/pilot/cases/${item.id}`]);
});

it("opens this exception in Exceptions from its case, even when it is resolved", async () => {
  const user = userEvent.setup();
  const item = exception();
  api.mutate((state) => {
    const record = state.records.find((r) => r.id === item.id)!;
    record.status = "resolved";
    record.data.resolutionCode = "held_credit";
  });
  renderApp(`/cases/${item.id}`);
  const link = await screen.findByRole("link", { name: "Resolve this exception in Exceptions" });
  expect(link.getAttribute("href")).toBe(`/exceptions?record=${item.id}&lender=${api.merchantIds[0]}#record-${item.id}`);
  await user.click(link);
  expect(await screen.findByText("Selected exception")).toBeTruthy();
  const row = await waitFor(() => { const found = document.getElementById(`record-${item.id}`); if (!found) throw new Error("row not shown"); return found; });
  expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(within(row).getByText(/Resolution:/)).toBeTruthy();
  // The queue comes back with its filters when asked for.
  await user.click(screen.getByRole("button", { name: "View exception queue" }));
  expect(await screen.findByRole("tablist", { name: "Exception filter" })).toBeTruthy();
  expect(new URLSearchParams(window.location.search).get("record")).toBeNull();
});
