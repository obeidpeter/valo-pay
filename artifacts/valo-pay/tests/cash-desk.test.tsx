import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { makeRecord } from "../../api-server/src/domain/records";
import { runCashAction } from "../../api-server/src/domain/connected-cash-service";
import type { Context, DomainState } from "../../api-server/src/domain/types";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ role: "Operations", now: "2026-09-21T10:00:00Z" });
});
afterEach(() => api.uninstall());
const context = (role = "Operations"): Context => ({
  role,
  actor: `Sandbox ${role}`,
  now: api.now,
});
const action = (
  state: DomainState,
  name: string,
  role = "Operations",
  recordId?: string,
) =>
  runCashAction(state, context(role), {
    action: name,
    recordId,
    data: {},
    reason: "Prepare offline frontend test fixture",
  });
function setUp() {
  api.mutate((state) => {
    for (const purpose of [
      "merchant_account_read",
      "erp_draft",
      "payroll_prepare",
    ])
      makeRecord(state, "connected-consents", {
        status: "active",
        createdAt: api.now,
        data: {
          purpose,
          subjectId: "sme",
          entityId: `${state.merchant.id}:sme`,
          expiresAt: "2026-10-21T10:00:00Z",
        },
      });
    action(state, "cash.initialize");
  });
}
async function confirm(
  user: ReturnType<typeof userEvent.setup>,
  note = "Confirm the sample evidence for this review",
) {
  const dialog = await screen.findByRole("dialog");
  await user.type(
    within(dialog).getByRole("textbox", { name: "Review note" }),
    note,
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Confirm and save" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("Cash Desk", () => {
  it("shows an honest sample preview without creating records or enabling preparation before permission", async () => {
    renderApp("/cash-desk");
    expect(
      await screen.findByRole("heading", { name: "Cash Desk" }),
    ).toBeTruthy();
    expect(screen.getByText("Sample SME · Trading company")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /Set up sample Cash Desk/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("link", { name: "Review permissions" })
        .getAttribute("href"),
    ).toBe("/connections");
    expect(
      screen.getByRole("table", {
        name: "Weekly base and downside cash balances",
      }),
    ).toBeTruthy();
    expect(
      api.state().records.some((r) => r.kind.startsWith("connected-cash-")),
    ).toBe(false);
  });

  it("saves a new forecast with the chosen downside, a visible review note and unchanged source balances", async () => {
    setUp();
    const user = userEvent.setup();
    renderApp("/cash-desk");
    const percent = await screen.findByRole("spinbutton", {
      name: /Expected receipts retained/,
    });
    await user.clear(percent);
    await user.type(percent, "55");
    const delay = screen.getByRole("spinbutton", { name: /Receipt delay/ });
    await user.clear(delay);
    await user.type(delay, "9");
    await user.click(screen.getByRole("button", { name: /Save forecast/ }));
    expect(
      (
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: "Confirm and save",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await confirm(user, "Stress test a slower customer payment week");
    const request = api.calls.find(
      (c) =>
        c.method === "POST" &&
        (c.body as { action?: string }).action === "cash.forecast",
    );
    expect(request?.body).toMatchObject({
      data: {
        downsideInflowBps: 5500,
        downsideDelayDays: 9,
        bufferMinor: 150000000,
      },
      reason: "Stress test a slower customer payment week",
    });
    expect(
      api.state().records.filter((r) => r.kind === "connected-cash-forecasts"),
    ).toHaveLength(1);
    expect(await screen.findByText(/sample-1/)).toBeTruthy();
  });

  it("lets a different Finance reviewer approve and export an accounting draft without claiming ERP posting", async () => {
    setUp();
    api.mutate((state) => action(state, "cash.erp.prepare"));
    api.role = "Finance";
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await user.click(await screen.findByRole("button", { name: "Accounting" }));
    await user.click(screen.getByRole("button", { name: "Approve draft" }));
    await confirm(user);
    expect(await screen.findByText(/Reviewed by Sandbox Finance/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Prepare export" }));
    await confirm(user);
    expect(
      await screen.findByRole("button", { name: "Download review file" }),
    ).toBeTruthy();
    expect(screen.getByText("Exported · not posted")).toBeTruthy();
    expect(
      api.state().records.find((r) => r.kind === "connected-cash-erp")?.data
        .manifest.status,
    ).toBe("not_posted");
  });

  it("holds an unknown payroll item for reconciliation and keeps the other items independently actionable", async () => {
    setUp();
    api.mutate((state) => {
      const plan = action(state, "cash.payroll.prepare").record!;
      action(state, "cash.payroll.approve", "Finance", plan.id);
      action(state, "cash.payroll.export", "Finance", plan.id);
    });
    api.role = "Finance";
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await user.click(
      await screen.findByRole("button", { name: "Payroll funding" }),
    );
    await user.click(
      screen.getAllByRole("button", { name: "Sample unknown" })[1]!,
    );
    await confirm(user);
    expect(await screen.findByText("Unknown")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Sample unknown" }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Sample success" }),
    ).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    const plan = api
      .state()
      .records.find((r) => r.kind === "connected-cash-payroll")!.data.plan;
    expect(plan.items.map((i: { status: string }) => i.status)).toEqual([
      "exported",
      "unknown",
      "exported",
    ]);
    expect(
      (
        screen.getByRole("button", {
          name: "Refresh funding review",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("keeps a minimal Finance reconciliation route after preparation permissions are revoked", async () => {
    setUp();
    api.mutate((state) => {
      const plan = action(state, "cash.payroll.prepare").record!;
      action(state, "cash.payroll.approve", "Finance", plan.id);
      action(state, "cash.payroll.export", "Finance", plan.id);
      for (const record of state.records.filter(
        (r) =>
          r.kind === "connected-consents" &&
          ["merchant_account_read", "payroll_prepare"].includes(r.data.purpose),
      ))
        record.status = "revoked";
    });
    api.role = "Finance";
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await user.click(
      await screen.findByRole("button", { name: "Payroll funding" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Reconcile retained payroll evidence",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Sample employee · ••/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Prepare bank export" }),
    ).toBeNull();
    await user.click(
      screen.getAllByRole("button", { name: "Record sample success" })[0]!,
    );
    await confirm(user);
    expect(
      await screen.findByRole("button", { name: "Record sample reversal" }),
    ).toBeTruthy();
    const plan = api
      .state()
      .records.find((r) => r.kind === "connected-cash-payroll")!.data.plan;
    expect(plan.items[0].status).toBe("succeeded");
    expect(
      api
        .state()
        .records.filter(
          (r) =>
            r.kind === "connected-consents" &&
            ["merchant_account_read", "payroll_prepare"].includes(
              r.data.purpose,
            ),
        )
        .every((r) => r.status === "revoked"),
    ).toBe(true);
  });

  it("recovers a stale funding plan through a new maker version while invalidating old checker approval", async () => {
    setUp();
    api.mutate((state) => {
      const plan = action(state, "cash.payroll.prepare").record!;
      action(state, "cash.payroll.approve", "Finance", plan.id);
    });
    api.setNow("2026-09-21T12:00:00Z");
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await user.click(
      await screen.findByRole("button", { name: "Refresh sample" }),
    );
    await confirm(user);
    await user.click(screen.getByRole("button", { name: "Payroll funding" }));
    await user.click(
      screen.getByRole("button", { name: "Refresh funding review" }),
    );
    await confirm(user);
    const plan = api
      .state()
      .records.find((r) => r.kind === "connected-cash-payroll")!.data.plan;
    expect(plan.reviewVersion).toBe(2);
    expect(plan.approvalStatus).toBe("draft");
    expect(plan.checker).toBeUndefined();
    expect(
      (
        screen.getByRole("button", {
          name: "Prepare bank export",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
