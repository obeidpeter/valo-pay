import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { seedMerchant } from "../src/lib/valopay-seed";
import { makeRecord } from "../src/domain/records";
import { reconcile } from "../src/domain/reconciliation";
import {
  createPaystackTestAdapter,
  parsePaystackTestWebhook,
} from "../src/providers/paystack";
import {
  receivePaystackEvent,
  assertProviderEventChange,
  replayProviderEvent,
} from "../src/providers/paystack-inbox";
import {
  paystackTestConnectionIdentity,
  verifyQueuedPaystackEvent,
  type PaystackVerificationTransaction,
} from "../src/providers/paystack-verification";
import type { DomainState } from "../src/domain/types";

process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { assertFinalState } = await import("../src/lib/valopay-store");
const key = ["sk", "test", "OFFLINE", "FIXTURE", "0".repeat(20)].join("_");
const connectionId = "a".repeat(64);
const ctx = {
  now: "2026-09-26T10:00:00.000Z",
  actor: "System · Paystack test verification",
  role: "Operations",
};
const reference = "SYNTHETIC-VERIFICATION-001";
let checks = 0;
async function check(run: () => Promise<void> | void) {
  await run();
  checks++;
}
function fixture(mode: "test" | "fixture" = "test") {
  let state = seedMerchant("verification-lender");
  state.merchant.mode = "observation";
  state.merchant.killSwitch = true;
  const due = state.records.find(
    (r) => r.kind === "due-items" && r.reference === "DEMO-LOAN-1005",
  )!;
  const attempt = makeRecord(state, "attempts", {
    name: "Saved test collection expectation",
    status: "unknown",
    reference,
    customerId: due.customerId,
    amountKobo: due.amountKobo,
    createdAt: ctx.now,
    data: {
      source: "external",
      dueItemId: due.id,
      currency: "NGN",
      providerConnection: paystackTestConnectionIdentity(connectionId),
      providerReference: reference,
      failureCode: "TIMEOUT_UNKNOWN",
    },
  });
  const payment = {
    id: "9990001",
    domain: "test",
    status: "success",
    reference,
    amount: due.amountKobo,
    currency: "NGN",
    channel: "direct_debit",
  };
  const raw = Buffer.from(
    JSON.stringify({ event: "charge.success", data: payment }),
  );
  const signed = parsePaystackTestWebhook(
    raw,
    createHmac("sha512", key).update(raw).digest("hex"),
    key,
  );
  const event = receivePaystackEvent(state, ctx, signed, {
    connectionId,
    mode,
  }).event;
  let calls = 0,
    locked = false,
    beforeReply = () => {},
    failCommit = false,
    loseReply = false;
  const adapter = createPaystackTestAdapter({
    secretKey: key,
    fetch: async (url, init) => {
      assert.equal(
        locked,
        false,
        "provider lookup must occur outside the lender transaction",
      );
      assert.equal(
        String(url),
        `https://api.paystack.co/transaction/verify/${reference}`,
      );
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      calls++;
      beforeReply();
      return new Response(JSON.stringify({ status: true, data: payment }));
    },
  });
  const transact: PaystackVerificationTransaction = async (
    id,
    write,
    apply,
  ) => {
    assert.equal(id, connectionId);
    locked = true;
    try {
      const copy = structuredClone(state);
      const result = apply(copy, ctx);
      if (write) {
        assertFinalState(state, copy, state.merchant.id);
        if (failCommit) throw new Error("Synthetic failed commit");
        state = copy;
        if (loseReply) {
          loseReply = false;
          throw new Error("Synthetic response loss after commit");
        }
      }
      return result;
    } finally {
      locked = false;
    }
  };
  const run = () =>
    verifyQueuedPaystackEvent({
      connectionId,
      eventId: event.id,
      transact,
      adapter,
    });
  return {
    run,
    adapter,
    transact,
    payment,
    eventId: event.id,
    attemptId: attempt.id,
    state: () => state,
    calls: () => calls,
    onReply: (fn: () => void) => {
      beforeReply = fn;
    },
    failCommit: () => {
      failCommit = true;
    },
    loseReply: () => {
      loseReply = true;
    },
  };
}

await check(async () => {
  const f = fixture(),
    before = structuredClone(f.state());
  const result = await f.run();
  assert.equal(result.status, "verified");
  assert.equal(result.observationCreated, true);
  assert.equal(result.financialRecordsCreated, 0);
  const event = f.state().records.find((r) => r.id === f.eventId)!;
  assertProviderEventChange(
    before.records.find((r) => r.id === f.eventId)!,
    event,
  );
  assert.equal(
    f.state().records.filter((r) => r.kind === "payments").length,
    before.records.filter((r) => r.kind === "payments").length,
  );
  assert.equal(
    f
      .state()
      .records.filter(
        (r) => r.kind === "observations" && r.data.providerEventId === event.id,
      ).length,
    1,
  );
  assert.throws(
    () =>
      replayProviderEvent(
        f.state(),
        { ...ctx, role: "Finance" },
        event.id,
        event.updatedAt,
        "Review verified sample evidence",
      ),
    /already has an independently verified/,
  );
  assert.equal((await f.run()).observationCreated, false);
  assert.equal(
    f.calls(),
    1,
    "a completed event never performs a second lookup or creates another observation",
  );
  reconcile(f.state(), ctx);
  const canonical = f
    .state()
    .records.filter((r) => r.kind === "payments" && r.reference === reference);
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0]!.data.collectionStatus, "succeeded");
  assert.equal(
    canonical[0]!.data.settlementStatus,
    "unsettled",
    "transaction success never fabricates settlement",
  );
  reconcile(f.state(), ctx);
  assert.equal(
    f
      .state()
      .records.filter((r) => r.kind === "payments" && r.reference === reference)
      .length,
    1,
  );
});
await check(async () => {
  const f = fixture("fixture");
  await assert.rejects(f.run, /fixtures cannot be promoted/);
  assert.equal(f.calls(), 0);
});
for (const change of [
  "live",
  "stop_released",
  "wrong_connection",
  "wrong_subject",
  "wrong_amount",
] as const)
  await check(async () => {
    const f = fixture(),
      attempt = f.state().records.find((r) => r.id === f.attemptId)!;
    if (change === "live") f.state().settings.environment = "production";
    if (change === "stop_released") f.state().merchant.killSwitch = false;
    if (change === "wrong_connection")
      attempt.data.providerConnection = "another-provider";
    if (change === "wrong_subject") attempt.customerId = "another-customer";
    if (change === "wrong_amount") attempt.amountKobo++;
    await assert.rejects(f.run);
    assert.equal(f.calls(), 0);
  });
for (const change of ["attempt", "signed", "authority"] as const)
  await check(async () => {
    const f = fixture();
    f.onReply(() => {
      if (change === "attempt")
        f.state().records.find((r) => r.id === f.attemptId)!.data.version = 2;
      if (change === "signed")
        f.state().records.find((r) => r.id === f.eventId)!.data.payloadDigest =
          "b".repeat(64);
      if (change === "authority") f.state().settings.environment = "production";
    });
    await assert.rejects(
      f.run,
      /changed during verification|synthetic workspace/,
    );
    assert.equal(
      f
        .state()
        .records.filter(
          (r) =>
            r.kind === "observations" && r.data.providerEventId === f.eventId,
        ).length,
      0,
    );
  });
await check(async () => {
  const f = fixture();
  f.onReply(() => {
    const event = f.state().records.find((record) => record.id === f.eventId)!;
    event.data.replayHistory = Array.from({ length: 100 }, () => ({ at: ctx.now, actor: ctx.actor, reason: "Concurrent synthetic check", result: "awaiting_verification" }));
  });
  await assert.rejects(f.run, /check limit/);
  assert.equal(f.state().records.filter((r) => r.kind === "observations" && r.data.providerEventId === f.eventId).length, 0);
});
await check(async () => {
  const f = fixture();
  f.payment.id = "9990002";
  assert.equal((await f.run()).status, "quarantined");
  assert.equal(
    f
      .state()
      .records.filter(
        (r) =>
          r.kind === "observations" && r.data.providerEventId === f.eventId,
      ).length,
    0,
  );
});
await check(async () => {
  const f = fixture();
  f.payment.status = "ongoing";
  assert.equal((await f.run()).status, "awaiting_verification");
  assert.equal(
    f
      .state()
      .records.filter(
        (r) =>
          r.kind === "observations" && r.data.providerEventId === f.eventId,
      ).length,
    0,
  );
});
await check(async () => {
  const f = fixture();
  const adapter = createPaystackTestAdapter({
    secretKey: key,
    fetch: async () => new Response("{}", { status: 404 }),
  });
  const result = await verifyQueuedPaystackEvent({
    connectionId,
    eventId: f.eventId,
    transact: f.transact,
    adapter,
  });
  assert.equal(
    result.status,
    "awaiting_verification",
    "not found does not establish no payment or permit a replacement",
  );
  assert.equal(result.observationCreated, false);
});
await check(async () => {
  const f = fixture(),
    before = structuredClone(f.state());
  f.failCommit();
  await assert.rejects(f.run, /failed commit/);
  assert.deepEqual(f.state(), before);
});
await check(async () => {
  const f = fixture();
  f.loseReply();
  await assert.rejects(f.run, /response loss/);
  assert.equal((await f.run()).observationCreated, false);
  assert.equal(f.calls(), 1);
});
await check(async () => {
  const f = fixture();
  await f.run();
  f.state().records = f
    .state()
    .records.filter(
      (r) =>
        !(r.kind === "observations" && r.data.providerEventId === f.eventId),
    );
  await assert.rejects(f.run, /missing its retained observation/);
  assert.equal(
    f.calls(),
    1,
    "an incomplete restore must not silently recreate evidence",
  );
});
console.log(
  `Paystack verification: ${checks} offline fixed-origin, current-authority, immutable-evidence, rollback and reconciliation checks passed.`,
);
