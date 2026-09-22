import assert from "node:assert/strict";
import { seedMerchant } from "../src/lib/valopay-seed";
import {
  connectedView,
  connectedRevision,
  runConnectedAction,
  connectedActionSchema,
} from "../src/domain/connected";
import { makeRecord } from "../src/domain/records";
import { evaluateRetry } from "../src/domain/policy-engine";
import type { Context, DomainState, ValopayRecord } from "../src/domain/types";
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { assertFinalState } = await import("../src/lib/valopay-store");
const ctx: Context = {
  now: "2026-09-21T10:00:00.000Z",
  role: "Admin",
  actor: "Sandbox Admin",
};
const finance: Context = { ...ctx, role: "Finance", actor: "Sandbox Finance" };
let checks = 0;
const check = (fn: () => void) => {
  fn();
  checks++;
};
const fresh = () => seedMerchant("tenant-a");
function run(
  state: DomainState,
  action: string,
  data: Record<string, unknown> = {},
  recordId?: string,
  context = ctx,
): ValopayRecord {
  const before = structuredClone(state);
  const result = runConnectedAction(
    state,
    context,
    connectedActionSchema.parse({
      action,
      data,
      recordId,
      reason: "Testing the sample workflow",
      expectedRevision: connectedRevision(state),
    }),
  );
  assertFinalState(before, state, state.merchant.id);
  return result as ValopayRecord;
}
const openDue = (state: DomainState) =>
  state.records.find(
    (r) => r.kind === "due-items" && r.reference === "DEMO-LOAN-1005",
  )!;
const checkout = (state: DomainState, amount?: number) => {
  const due = openDue(state);
  return run(state, "payment.create", {
    dueItemId: due.id,
    amountKobo: amount ?? due.amountKobo,
  });
};
check(() => {
  const s = fresh();
  assert.equal(connectedView(s, ctx).mode, "synthetic");
  assert.equal(
    connectedView(s, ctx).gates.some((g) => g.liveEnabled),
    false,
  );
  assert.equal(
    s.records.filter((r) => r.kind.startsWith("connected-")).length,
    0,
  );
});
check(() => {
  const s = fresh();
  s.settings.environment = "production";
  assert.throws(() => checkout(s), /synthetic/);
});
check(() => {
  const s = fresh();
  assert.throws(
    () =>
      run(
        s,
        "payment.create",
        { dueItemId: openDue(s).id, amountKobo: 1 },
        undefined,
        { ...ctx, role: "Read-only" },
      ),
    /Read-only/,
  );
});
check(() => {
  const s = fresh();
  assert.throws(
    () =>
      run(s, "payment.create", {
        dueItemId: openDue(fresh()).id,
        amountKobo: 1,
      }),
    /not found/,
  );
});
check(() => {
  const s = fresh();
  assert.throws(() => checkout(s, 0), /greater/);
  assert.throws(() => checkout(s, openDue(s).amountKobo + 1), /outstanding/);
  assert.throws(() => checkout(s, 1.5), /integer/);
});
check(() => {
  const s = fresh();
  const i = checkout(s);
  assert.throws(() => checkout(s), /open checkout/);
  run(s, "payment.cancel", {}, i.id);
  assert.doesNotThrow(() => checkout(s));
});
check(() => {
  const s = fresh();
  const i = checkout(s);
  assert.throws(
    () => run(s, "payment.outcome", { outcome: "confirmed" }, i.id),
    /waiting/,
  );
  assert.equal(
    s.records.filter((r) => r.data.connectedIntentId === i.id).length,
    0,
  );
});
check(() => {
  const s = fresh();
  const i = checkout(s);
  const late = { ...ctx, now: "2026-09-21T10:16:00.000Z" };
  assert.throws(() => run(s, "payment.authorise", {}, i.id, late), /expired/);
});
check(() => {
  const s = fresh(),
    due = openDue(s);
  const attempt = makeRecord(s, "attempts", {
    name: "Scheduled",
    status: "scheduled",
    customerId: due.customerId,
    amountKobo: due.amountKobo,
    createdAt: ctx.now,
    data: { dueItemId: due.id, source: "valo" },
  });
  const i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  assert.equal(attempt.status, "cancelled");
  assert.equal(
    s.records.filter((r) => r.kind === "connected-consents").length,
    1,
  );
});
check(() => {
  const s = fresh(),
    due = openDue(s);
  makeRecord(s, "attempts", {
    status: "unknown",
    customerId: due.customerId,
    amountKobo: due.amountKobo,
    createdAt: ctx.now,
    data: { dueItemId: due.id },
  });
  assert.throws(() => checkout(s), /pending|unknown/);
});
check(() => {
  const s = fresh(),
    i = checkout(s),
    due = openDue(s);
  makeRecord(s, "attempts", {
    status: "sent",
    customerId: due.customerId,
    amountKobo: due.amountKobo,
    createdAt: ctx.now,
    data: { dueItemId: due.id },
  });
  assert.throws(() => run(s, "payment.authorise", {}, i.id), /flight/);
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  s.merchant.killSwitch = true;
  assert.throws(() => run(s, "payment.authorise", {}, i.id), /emergency/);
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.return", {}, i.id);
  assert.equal(i.status, "pending");
  assert.equal(
    s.records.filter((r) => r.data.connectedIntentId === i.id).length,
    0,
  );
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.outcome", { outcome: "unknown" }, i.id);
  assert.throws(() => checkout(s), /pending|unknown/);
  assert.throws(() => run(s, "payment.cancel", {}, i.id), /in-flight/);
  const due = openDue(s);
  const decision = evaluateRetry(
    s,
    ctx,
    due as any,
    s.records.find((r) => r.kind === "policies") as any,
  );
  assert.equal(decision.rule, "in_flight");
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.outcome", { outcome: "failed" }, i.id);
  assert.doesNotThrow(() => checkout(s));
});
check(() => {
  const s = fresh(),
    i = checkout(s, 1_000_000),
    due = openDue(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id);
  assert.equal(due.data.outstandingKobo, 1_500_000);
  assert.equal(due.status, "partially_paid");
  const count = s.records.length;
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id);
  assert.equal(s.records.length, count);
  const p = s.records.find((r) => r.id === i.data.paymentId)!;
  assert.equal(p.data.channel, "transfer");
  assert.equal(p.data.paymentMethod, "pay_by_bank");
  assert.equal(p.data.allocatedKobo, 1_000_000);
});
check(() => {
  const s = fresh(),
    i = checkout(s),
    due = openDue(s);
  run(s, "payment.authorise", {}, i.id);
  const grant = s.records.find((r) => r.id === i.data.consentId)!;
  run(s, "consent.revoke", {}, grant.id);
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id, {
    ...ctx,
    now: "2026-09-22T10:00:00.000Z",
  });
  assert.equal(due.status, "paid");
  assert.equal(i.status, "confirmed");
});
check(() => {
  const s = fresh(),
    i = checkout(s),
    due = openDue(s);
  run(s, "payment.authorise", {}, i.id);
  due.amountKobo = 1_500_000;
  due.data.outstandingKobo = 1_500_000;
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id);
  assert.equal(due.data.outstandingKobo, 0);
  assert.ok(
    s.records.some(
      (r) =>
        r.kind === "exceptions" && r.data.linkedRecordId === i.data.paymentId,
    ),
  );
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id);
  assert.throws(
    () => run(s, "payment.refund_confirm", {}, i.id, finance),
    /maker/,
  );
  run(s, "payment.refund_request", {}, i.id);
  assert.throws(() => run(s, "payment.refund_confirm", {}, i.id), /Finance/);
  run(s, "payment.refund_confirm", {}, i.id, finance);
  assert.equal(i.status, "refunded");
  assert.equal(openDue(s).status, "in_dispute");
  assert.equal(openDue(s).data.outstandingKobo, openDue(s).amountKobo);
  // The refunded money left the allocation queues and is no customer credit.
  const refunded = s.records.find((r) => r.id === i.data.paymentId)!;
  assert.equal(refunded.status, "returned");
  // The whole receipt went back, after its allocations were taken off the instalments.
  assert.deepEqual(
    [
      refunded.data.refundStatus,
      refunded.data.refundedKobo,
      refunded.data.allocatedKobo,
    ],
    ["refunded", refunded.amountKobo, 0],
  );
  assert.throws(
    () => run(s, "payment.refund_confirm", {}, i.id, finance),
    /confirmed/,
  );
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id);
  run(s, "payment.reverse", {}, i.id, finance);
  assert.equal(
    s.records.find((r) => r.id === i.data.paymentId)!.data.reversalStatus,
    "reversed",
  );
  assert.equal(s.records.find((r) => r.id === i.data.paymentId)!.status, "returned");
  assert.equal(openDue(s).status, "in_dispute");
});
check(() => {
  const s = fresh(),
    c = s.records.find((r) => r.kind === "customers")!;
  const grant = run(s, "consent.grant", {
    purpose: "account_read",
    subjectId: c.id,
    days: 7,
  });
  const count = s.records.length;
  run(s, "consent.grant", {
    purpose: "account_read",
    subjectId: c.id,
    days: 7,
  });
  assert.equal(s.records.length, count);
  assert.equal(
    connectedView(s, { ...ctx, now: "2026-10-01T10:00:00.000Z" }).consents[0]!
      .effectiveStatus,
    "expired",
  );
  run(s, "consent.revoke", {}, grant.id);
  assert.equal(connectedView(s, ctx).consents[0]!.effectiveStatus, "revoked");
});
check(() => {
  const s = fresh();
  assert.throws(
    () =>
      run(s, "consent.grant", {
        purpose: "account_read",
        subjectId: "foreign",
      }),
    /subject/,
  );
  assert.throws(
    () =>
      run(s, "consent.grant", {
        purpose: "payroll_prepare",
        subjectId: openDue(s).customerId,
      }),
    /subject/,
  );
});
check(() => {
  const s = fresh(),
    revision = connectedRevision(s);
  checkout(s);
  assert.throws(
    () =>
      runConnectedAction(s, ctx, {
        action: "consent.grant",
        reason: "Test stale form",
        data: {},
        expectedRevision: revision,
      }),
    /changed/,
  );
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  const before = structuredClone(s),
    due = openDue(s);
  makeRecord(s, "attempts", {
    status: "scheduled",
    customerId: due.customerId,
    amountKobo: due.amountKobo,
    createdAt: ctx.now,
    data: { dueItemId: due.id },
  });
  assert.throws(
    () => assertFinalState(before, s, s.merchant.id),
    /flight together/,
  );
});
check(() => {
  const s = fresh();
  makeRecord(s, "connected-credit-assessments", {
    status: "complete",
    createdAt: ctx.now,
    data: { result: { score: 50 } },
  });
  const before = structuredClone(s);
  s.records.at(-1)!.data.result.score = 99;
  assert.throws(() => assertFinalState(before, s, s.merchant.id), /immutable/);
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  while (
    s.records.filter((record) => record.kind.startsWith("connected-")).length <
    1500
  )
    makeRecord(s, "connected-cap-fixture", {
      name: "Synthetic quota fixture",
      createdAt: ctx.now,
    });
  assert.throws(
    () => run(s, "credit.assess", { customerId: i.customerId }),
    /record limit/,
  );
  assert.throws(() => run(s, "cash.vat.export"), /record limit/);
  assert.doesNotThrow(() =>
    run(s, "consent.revoke", {}, String(i.data.consentId)),
  );
  assert.doesNotThrow(() =>
    run(s, "payment.outcome", { outcome: "confirmed" }, i.id),
  );
  assert.equal(i.status, "confirmed");
  assert.equal(
    s.records.find((record) => record.id === i.data.consentId)!.status,
    "revoked",
  );
});
console.log(
  `${checks} connected workflow, authority, race and persistence checks passed.`,
);
