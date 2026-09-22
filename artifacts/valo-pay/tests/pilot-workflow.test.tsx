import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { cleanup } from "@testing-library/react";
let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
});
afterEach(() => api.uninstall());

it("saves source rows, reopens them and commits a checked batch exactly once", async () => {
  const user = userEvent.setup();
  renderApp("/imports");
  await user.click(await screen.findByRole("button", { name: "Use sample" }));
  await user.click(
    screen.getByRole("button", { name: "Save and check batch" }),
  );
  await screen.findByRole("heading", { name: "Saved check results" });
  expect(
    api
      .state()
      .records.filter(
        (r) => r.kind === "customers" && r.reference === "PILOT-C001",
      ),
  ).toHaveLength(0);
  const batch = api.state().records.find((r) => r.kind === "import-batches")!;
  expect(batch.status).toBe("ready");
  cleanup();
  renderApp("/imports");
  await user.click(
    await screen.findByRole("button", {
      name: /Customers sample.*Pilot sample/,
    }),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("CSV content") as HTMLTextAreaElement).value,
    ).toContain("PILOT-C001"),
  );
  await user.click(
    screen.getByRole("button", { name: "Commit checked batch" }),
  );
  await screen.findByRole("heading", { name: "Import complete" });
  expect(
    api
      .state()
      .records.filter(
        (r) => r.kind === "customers" && r.reference === "PILOT-C001",
      ),
  ).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: "Commit checked batch" }),
  ).toBeNull();
  expect(JSON.stringify(localStorage)).not.toContain("PILOT-C001");
});

it("keeps a rejected batch available for correction and guards unsaved changes", async () => {
  const user = userEvent.setup();
  renderApp("/imports");
  await user.click(await screen.findByRole("button", { name: "Use sample" }));
  const csv = screen.getByLabelText("CSV content");
  await user.clear(csv);
  await user.type(
    csv,
    "source_row_id,name,reference,consentProvenance\nrow-1,Sample,PILOT-BAD,",
  );
  await user.click(
    screen.getByRole("button", { name: "Save and check batch" }),
  );
  await screen.findByRole("heading", { name: "Saved check results" });
  expect(
    (
      screen.getByRole("button", {
        name: "Commit checked batch",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.type(screen.getByLabelText("CSV content"), "Synthetic consent");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(
    screen.getByRole("button", { name: /Customers sample.*Pilot sample/ }),
  );
  expect(confirm).toHaveBeenCalled();
  expect(
    (screen.getByLabelText("CSV content") as HTMLTextAreaElement).value,
  ).toContain("Synthetic consent");
  await user.click(
    screen.getByRole("button", { name: "Save and check batch" }),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Commit checked batch",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(
    api.state().records.filter((r) => r.kind === "import-revisions"),
  ).toHaveLength(2);
});

it("claims a case and hands it to Finance with an immutable note, without allocating money", async () => {
  const item = api.state().records.find((r) => r.kind === "exceptions")!;
  const allocations = JSON.stringify(
    api.state().records.filter((r) => r.kind === "allocations"),
  );
  const user = userEvent.setup();
  renderApp(`/cases/${item.id}`);
  await user.type(
    await screen.findByLabelText("Next action"),
    "Review the payment evidence",
  );
  await user.type(
    screen.getByLabelText("Handover or progress note"),
    "Checked the source reference.",
  );
  await user.click(
    screen.getByRole("button", { name: "Claim and save next step" }),
  );
  await screen.findByText("Case update saved with its handover history.");
  await user.selectOptions(
    screen.getByLabelText("Assigned to"),
    "Sandbox Finance",
  );
  await user.type(
    screen.getByLabelText("Handover or progress note"),
    "Finance should check the proposed allocation.",
  );
  await user.click(screen.getByRole("button", { name: "Save handover" }));
  await screen.findByText(/Case handed over · Demo Finance/);
  expect(
    api.state().records.find((r) => r.id === item.id)?.data.case.assignee,
  ).toBe("Sandbox Finance");
  expect(
    api.state().records.filter((r) => r.kind === "case-events"),
  ).toHaveLength(2);
  expect(
    JSON.stringify(api.state().records.filter((r) => r.kind === "allocations")),
  ).toBe(allocations);
});

it("read-only staff can inspect the journey but cannot save imports or claim cases", async () => {
  api.role = "Read-only";
  renderApp("/imports");
  expect(
    (
      (await screen.findByRole("button", {
        name: "Save and check batch",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  cleanup();
  renderApp(
    `/cases/${api.state().records.find((r) => r.kind === "exceptions")!.id}`,
  );
  expect(
    (
      (await screen.findByRole("button", {
        name: "Claim and save next step",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("identifies demo access honestly and does not offer working staff invitation controls", async () => {
  renderApp("/team");
  await screen.findByText("Demo personas are active.");
  expect(
    screen.queryByRole("button", { name: "Create invitation" }),
  ).toBeNull();
  expect(screen.getByText(/requires a configured organisation/)).toBeTruthy();
});
