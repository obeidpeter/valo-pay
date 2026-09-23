import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { cleanup } from "@testing-library/react";
import { queryClient } from "@/App";
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

it("offers the latest saved version after a colleague saves the batch", async () => {
  const user = userEvent.setup();
  renderApp("/imports");
  await user.click(await screen.findByRole("button", { name: "Use sample" }));
  await user.click(
    screen.getByRole("button", { name: "Save and check batch" }),
  );
  await screen.findByRole("heading", { name: "Saved check results" });
  await waitFor(() =>
    expect(
      (screen.getByLabelText("CSV content") as HTMLTextAreaElement).value,
    ).toContain("PILOT-C001"),
  );
  // A colleague saves a newer version of the same batch.
  const colleagueCsv = api.mutate((state) => {
    const batch = state.records.find((r) => r.kind === "import-batches")!;
    batch.data.csv = `${String(batch.data.csv)}\n`;
    batch.name = "Colleague version";
    batch.updatedAt = new Date(Date.parse(batch.updatedAt) + 60_000).toISOString();
    return String(batch.data.csv);
  });
  await user.type(screen.getByLabelText("CSV content"), " ");
  await user.click(
    screen.getByRole("button", { name: "Save and check batch" }),
  );
  await screen.findByText(/Load the latest version to continue/);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Load latest version" }));
  expect(confirm).toHaveBeenCalled();
  await screen.findByRole("heading", { name: "Colleague version" });
  expect(
    (screen.getByLabelText("CSV content") as HTMLTextAreaElement).value,
  ).toBe(colleagueCsv);
  expect(screen.queryByText(/Load the latest version to continue/)).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Save and check batch" }),
  );
  await waitFor(() =>
    expect(
      api.calls
        .filter((c) => /\/v1\/pilot\/batches\/[^/]+\/save$/.test(c.path))
        .map((c) => c.status),
    ).toEqual([409, 200]),
  );
});

it("lets a case claim whose response was lost be discarded deliberately", async () => {
  const item = api.state().records.find((r) => r.kind === "exceptions")!;
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
  api.failNext(new RegExp(`^/v1/pilot/cases/${item.id}$`), "offline", "POST");
  await user.click(
    screen.getByRole("button", { name: "Claim and save next step" }),
  );
  await screen.findByText("Outcome not confirmed");
  expect(
    (screen.getByLabelText("Next action") as HTMLInputElement).closest("fieldset")
      ?.disabled,
  ).toBe(true);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(
    screen.getByRole("button", { name: "Discard original request" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("Outcome not confirmed")).toBeNull(),
  );
  expect(
    (screen.getByLabelText("Next action") as HTMLInputElement).closest("fieldset")
      ?.disabled,
  ).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "Claim and save next step",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("offers to check or discard a lost invitation revocation, and discarding it frees the other invitations", async () => {
  const send = globalThis.fetch;
  const revokes: Array<{ id: string; key: string }> = [];
  const invitations = ["ada", "bola"].map((name, index) => ({
    id: `invitation-${index + 1}`,
    email: `${name}@example.test`,
    role: "Operations",
    status: "pending",
    expiresAt: api.now,
    invitedBy: "Sandbox Admin",
    approval: "not_required",
    approvedBy: null,
  }));
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = async (input, options) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/api/v1/team" && (options?.method ?? "GET") === "GET")
      return json({
        mode: "staff",
        actor: "Pilot Admin",
        message: "Staff access is active.",
        members: [],
        lenders: [],
        invitations,
        changes: [],
        events: [],
      });
    const revoke = /^\/api\/v1\/team\/invitations\/([^/]+)\/revoke$/.exec(path);
    if (revoke && options?.method === "POST") {
      revokes.push({
        id: revoke[1]!,
        key: new Headers(options.headers).get("Idempotency-Key")!,
      });
      if (revokes.length === 1) throw new TypeError("Failed to fetch");
      return json({ message: "Invitation revoked." });
    }
    return send(input, options);
  };
  const user = userEvent.setup();
  renderApp("/team");
  await user.click(
    (await screen.findAllByRole("button", { name: "Revoke invitation" }))[0]!,
  );
  await screen.findByText("Outcome not confirmed");
  expect(
    screen.getByRole("button", { name: "Check original request" }),
  ).toBeTruthy();
  const second = () =>
    screen.getAllByRole("button", {
      name: "Revoke invitation",
    })[1] as HTMLButtonElement;
  expect(second().disabled).toBe(true);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(
    screen.getByRole("button", { name: "Discard original request" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("Outcome not confirmed")).toBeNull(),
  );
  expect(second().disabled).toBe(false);
  await user.click(second());
  await screen.findByText("Invitation revoked.");
  expect(revokes.map((r) => r.id)).toEqual(["invitation-1", "invitation-2"]);
  expect(revokes[1]!.key).not.toBe(revokes[0]!.key);
});

it("lists what waits for a second administrator and never offers the asker their own approval", async () => {
  const send = globalThis.fetch;
  const posted: string[] = [];
  const pending = (id: string, email: string, role: string, invitedBy: string) => ({ id, email, role, status: "pending", expiresAt: api.now, invitedBy, approval: "awaiting", approvedBy: null });
  const change = (id: string, requestedBy: string) => ({ id, memberId: `member-${id}`, name: `${id}@example.test`, from: { role: "Operations", status: "active" }, to: { role: "Compliance reviewer", status: "active" }, reason: "Move to compliance reviews.", requestedBy, requestedAt: api.now });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (input, options) => {
    const path = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(), "http://localhost").pathname;
    if (path === "/api/v1/team" && (options?.method ?? "GET") === "GET")
      return json({
        mode: "staff", actor: "Sandbox Admin", message: "Staff access is active.", lenders: [], events: [],
        // Another member's expiry is not shown to everyone; this one arrives without it.
        members: [{ id: "member-ops", actor: "Clerk:user_ops", name: "ops@example.test", role: "Operations", status: "active", expiresAt: null, updatedAt: api.now, lenderIds: [], allLenders: false }],
        invitations: [pending("invite-theirs", "finance@example.test", "Finance", "Clerk:user_other"), pending("invite-mine", "admin@example.test", "Admin", "Sandbox Admin")],
        changes: [change("change-theirs", "Clerk:user_other"), change("change-mine", "Sandbox Admin")],
      });
    if (options?.method === "POST" && /^\/api\/v1\/team\/(invitations|changes)\//.test(path)) {
      posted.push(path);
      return json(path.endsWith("/decline") ? { message: "Change request withdrawn. The membership is unchanged." } : { message: "Invitation approved: finance@example.test can now accept it as Finance." });
    }
    return send(input, options);
  };
  const user = userEvent.setup();
  renderApp("/team");
  const panel = (await screen.findByRole("heading", { name: "Waiting for a second administrator" })).closest("section")!;
  expect(within(panel).getAllByRole("button", { name: "Approve invitation" })).toHaveLength(1);
  expect(within(panel).getByText("You sent it: another administrator approves it.")).toBeTruthy();
  expect(within(panel).getAllByRole("button", { name: "Approve change" })).toHaveLength(1);
  expect(within(panel).getByText("You asked for it: another administrator approves it.")).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Decline change" })).toBeTruthy();
  expect(screen.getByText(/finance@example\.test · Finance/).parentElement?.textContent).toContain("waiting for a second administrator");
  expect(screen.getByText("Operations · active").textContent).not.toContain("expires");
  await user.click(within(panel).getByRole("button", { name: "Approve invitation" }));
  expect(await within(panel).findByText("Invitation approved: finance@example.test can now accept it as Finance.")).toBeTruthy();
  await user.click(within(panel).getByRole("button", { name: "Withdraw request" }));
  expect(await within(panel).findByText("Change request withdrawn. The membership is unchanged.")).toBeTruthy();
  expect(posted).toEqual(["/api/v1/team/invitations/invite-theirs/approve", "/api/v1/team/changes/change-mine/decline"]);
});

/** Saves the sample batch and waits until the editor holds the saved version. */
async function saveSampleBatch(user: ReturnType<typeof userEvent.setup>) {
  renderApp("/imports");
  await user.click(await screen.findByRole("button", { name: "Use sample" }));
  await user.click(
    screen.getByRole("button", { name: "Save and check batch" }),
  );
  await screen.findByRole("heading", { name: "Saved check results" });
  await waitFor(() =>
    expect(
      (screen.getByLabelText("CSV content") as HTMLTextAreaElement).value,
    ).toContain("PILOT-C001"),
  );
}

/** A colleague saves a newer version of the same batch; returns its CSV. */
function colleagueSavesBatch() {
  return api.mutate((state) => {
    const batch = state.records.find((r) => r.kind === "import-batches")!;
    batch.data.csv = `${String(batch.data.csv)}\n`;
    batch.name = "Colleague version";
    batch.updatedAt = new Date(Date.parse(batch.updatedAt) + 60_000).toISOString();
    return String(batch.data.csv);
  });
}

const csvValue = () =>
  (screen.getByLabelText("CSV content") as HTMLTextAreaElement).value;

it("keeps the draft and the conflict when the latest version cannot be loaded", async () => {
  const user = userEvent.setup();
  await saveSampleBatch(user);
  const colleagueCsv = colleagueSavesBatch();
  await user.type(screen.getByLabelText("CSV content"), " MYDRAFT");
  await user.click(
    screen.getByRole("button", { name: "Save and check batch" }),
  );
  await screen.findByText(/This batch changed after you opened it/);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  api.failNext(/^\/v1\/pilot\/batches\/[^/]+$/, "offline", "GET");
  await user.click(screen.getByRole("button", { name: "Load latest version" }));
  await screen.findByText(
    "The latest version could not be loaded. Your draft is still here. Try again.",
  );
  expect(csvValue()).toContain("MYDRAFT");
  expect(screen.getByText(/This batch changed after you opened it/)).toBeTruthy();
  expect(
    api.calls
      .filter((c) => c.method === "GET" && /^\/v1\/pilot\/batches\/[^/]+$/.test(c.path))
      .map((c) => c.status)
      .at(-1),
  ).toBe(0);
  // Trying again loads the colleague's version.
  await user.click(screen.getByRole("button", { name: "Load latest version" }));
  await screen.findByRole("heading", { name: "Colleague version" });
  expect(csvValue()).toBe(colleagueCsv);
  expect(screen.queryByText(/could not be loaded/)).toBeNull();
});

it("offers a newer version that a refresh shows, before any save is refused", async () => {
  const user = userEvent.setup();
  await saveSampleBatch(user);
  const colleagueCsv = colleagueSavesBatch();
  expect(screen.queryByRole("button", { name: "Load latest version" })).toBeNull();
  await queryClient.invalidateQueries();
  await screen.findByText(/A newer version of this batch was saved/);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Load latest version" }));
  await screen.findByRole("heading", { name: "Colleague version" });
  expect(csvValue()).toBe(colleagueCsv);
  expect(screen.queryByText(/A newer version of this batch was saved/)).toBeNull();
  expect(
    api.calls.filter((c) => /\/v1\/pilot\/batches\/[^/]+\/save$/.test(c.path)),
  ).toHaveLength(0);
});

it("offers the latest version only when the refusal says the batch changed", async () => {
  const user = userEvent.setup();
  await saveSampleBatch(user);
  api.failNext(
    /^\/v1\/pilot\/batches\/[^/]+\/save$/,
    {
      status: 409,
      error: "Review your pending operations before submitting more requests.",
    },
    "POST",
  );
  await user.type(screen.getByLabelText("CSV content"), " ");
  await user.click(
    screen.getByRole("button", { name: "Save and check batch" }),
  );
  await screen.findByText(/Review your pending operations/);
  expect(screen.queryByText(/This batch changed after you opened it/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Load latest version" })).toBeNull();
  expect(csvValue()).toMatch(/ $/);
});

it("does not offer a newer version while the save's own outcome is unconfirmed", async () => {
  const user = userEvent.setup();
  await saveSampleBatch(user);
  // The save commits, but its answer is lost; a retry with the same key gets the saved answer again.
  const send = globalThis.fetch;
  const answers = new Map<string, Response>();
  globalThis.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (options?.method !== "POST" || !/\/pilot\/batches\/[^/?]+\/save/.test(url)) return send(input, options);
    const key = new Headers(options.headers).get("Idempotency-Key")!;
    if (answers.has(key)) return answers.get(key)!.clone();
    answers.set(key, (await send(input, options)).clone());
    throw new TypeError("Response lost after the save reached the service");
  };
  await user.type(screen.getByLabelText("CSV content"), " ");
  await user.click(
    screen.getByRole("button", { name: "Save and check batch" }),
  );
  await screen.findByText("Outcome not confirmed");
  const reads = api.calls.filter((c) => c.method === "GET" && /^\/v1\/pilot\/batches\/[^/]+$/.test(c.path)).length;
  await queryClient.invalidateQueries();
  await waitFor(() =>
    expect(
      api.calls.filter((c) => c.method === "GET" && /^\/v1\/pilot\/batches\/[^/]+$/.test(c.path)).length,
    ).toBeGreaterThan(reads),
  );
  // The refresh shows this person's own save; the notice about it is the recovery notice, not a colleague's version.
  expect(screen.queryByText(/A newer version of this batch was saved/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Load latest version" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Check original request" }));
  await waitFor(() => expect(screen.queryByText("Outcome not confirmed")).toBeNull());
  expect(screen.queryByText(/A newer version of this batch was saved/)).toBeNull();
  expect(answers.size).toBe(1);
});
