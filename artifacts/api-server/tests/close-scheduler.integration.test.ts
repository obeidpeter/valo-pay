// Database-backed test for the scheduled daily close runner (REC-01): it closes
// only due lenders, each in its own system transaction through the scoped
// repository; skips a lender locked by a request in flight; isolates one
// lender's failure from the others; gives legacy lenders a cursor without a
// close; and its audit entries never keep an abandoned sandbox alive.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to run the scheduler integration test.");
  process.exit(0);
}

const { pool } = await import("@workspace/db");
const { nextCloseInstant } = await import("@workspace/valopay-schema");
const { SYSTEM_ACTOR_PREFIX, inWorkspace, listMerchants, loadState } = await import("../src/lib/valopay-store.js");
const { SCHEDULED_CLOSE_ACTOR, runDueCloses, startCloseScheduler } = await import("../src/lib/close-scheduler.js");

const requestFor = (token: string) => ({ headers: { cookie: `valopay_sandbox=${token}` }, secure: false, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
const response = () => ({ cookie() { /* a valid test cookie is already supplied */ } }) as any;
const token = () => randomBytes(32).toString("hex");
const setCursor = (merchantId: string, at: string) => pool.query("UPDATE valopay_merchants SET settings = settings || jsonb_build_object('nextCloseAt', $2::text) WHERE id=$1", [merchantId, at]);
const cursorOf = async (merchantId: string): Promise<string | null> => (await pool.query<{ cursor: string | null }>("SELECT settings->>'nextCloseAt' AS cursor FROM valopay_merchants WHERE id=$1", [merchantId])).rows[0]!.cursor;
const closesOf = async (merchantId: string) => (await pool.query<{ id: string; data: Record<string, any> }>("SELECT id,data FROM valopay_records WHERE merchant_id=$1 AND kind='closes' ORDER BY created_at", [merchantId])).rows;
const closedIds = (run: Awaited<ReturnType<typeof runDueCloses>>) => run.closed.map((item) => item.merchantId);

try {
  const sandbox = token();
  let merchants: string[] = [];
  await inWorkspace(requestFor(sandbox), response(), async (context) => { merchants = (await listMerchants(context)).map((merchant) => merchant.id).sort(); });
  const [a, b] = merchants as [string, string];
  const dbNow = (await pool.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString();

  // A fresh sandbox: both lenders carry a cursor at the next 07:00 WAT after the database clock.
  const seeded = (await cursorOf(a))!;
  assert.ok(seeded > dbNow, "the seeded cursor is in the future");
  assert.equal(new Date(seeded).getUTCHours(), 6, "07:00 WAT is 06:00 UTC");
  assert.equal(new Date(seeded).getUTCMinutes(), 0);
  assert.ok(Date.parse(seeded) - Date.parse(dbNow) <= 24 * 60 * 60 * 1000, "within a day");
  const idle = await runDueCloses({ batchSize: 100 });
  assert.equal(closedIds(idle).some((id) => merchants.includes(id)), false, "nothing is due yet");

  // Lender A became due an hour ago (the platform was down): it is closed late; B is left alone.
  const dueAt = new Date(Date.parse(dbNow) - 60 * 60 * 1000).toISOString();
  await setCursor(a, dueAt);
  const run = await runDueCloses({ batchSize: 100 });
  const closedA = run.closed.find((item) => item.merchantId === a);
  assert.ok(closedA, "the due lender is closed");
  assert.equal(closedIds(run).includes(b), false, "the lender whose time has not come is not");
  assert.equal(closedA.late, true);
  assert.ok((closedA.delayMinutes ?? 0) >= 60);
  await inWorkspace(requestFor(sandbox), response(), async (context) => {
    const state = await loadState(context, a, "share");
    const closes = state.records.filter((record) => record.kind === "closes");
    assert.equal(closes.length, 1);
    assert.equal(closes[0]!.id, closedA.closeId);
    assert.equal(closes[0]!.data.schedule.trigger, "scheduled");
    assert.equal(closes[0]!.data.schedule.scheduledFor, dueAt);
    assert.equal(closes[0]!.data.schedule.late, true);
    const audit = state.records.filter((record) => record.kind === "audit").sort((x, y) => Number(x.data.sequence) - Number(y.data.sequence)).at(-1)!;
    assert.equal(audit.data.actor, SCHEDULED_CLOSE_ACTOR);
    assert.equal(audit.name, "daily_close");
    assert.equal(audit.data.objectId, closedA.closeId);
    assert.equal(state.settings.nextCloseAt, nextCloseInstant(String(closes[0]!.data.closedAt), "07:00"), "the cursor moved to the next 07:00 WAT after the close");
    assert.ok(String(state.settings.nextCloseAt) > dbNow);
  });
  const again = await runDueCloses({ batchSize: 100 });
  assert.equal(closedIds(again).includes(a), false, "a second pass finds nothing due for the closed lender");

  // A lender locked by a request in flight is skipped, never queued behind.
  await setCursor(b, dueAt);
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE", [b]);
    const skipped = await runDueCloses({ batchSize: 100 });
    assert.ok(skipped.skipped.includes(b), "the locked lender is skipped");
    assert.equal(closedIds(skipped).includes(b), false);
    await holder.query("ROLLBACK");
  } finally {
    holder.release();
  }
  assert.equal((await closesOf(b)).length, 0, "no close was written for the locked lender");

  // The automatic close switched off: the lender is not even examined.
  await pool.query(`UPDATE valopay_merchants SET settings = settings || '{"scheduledCloseEnabled": false}' WHERE id=$1`, [b]);
  const off = await runDueCloses({ batchSize: 100 });
  assert.equal(closedIds(off).includes(b), false);
  assert.equal(off.skipped.includes(b), false);
  await pool.query(`UPDATE valopay_merchants SET settings = settings || '{"scheduledCloseEnabled": true}' WHERE id=$1`, [b]);

  // One lender's failure does not stop the others: B's state is made unsaveable, both are due.
  await setCursor(a, dueAt);
  const brokenDue = (await pool.query<{ id: string; data: Record<string, any> }>("SELECT id,data FROM valopay_records WHERE merchant_id=$1 AND kind='due-items' ORDER BY created_at LIMIT 1", [b])).rows[0]!;
  await pool.query(`UPDATE valopay_records SET data = data || '{"outstandingKobo": 9007199254740000}' WHERE id=$1`, [brokenDue.id]);
  const mixed = await runDueCloses({ batchSize: 100 });
  assert.ok(closedIds(mixed).includes(a), "the healthy lender is closed");
  const failure = mixed.failed.find((item) => item.merchantId === b);
  assert.ok(failure, "the broken lender is reported");
  assert.match(failure.error, /Outstanding balance is invalid/);
  assert.equal((await closesOf(b)).length, 0, "nothing of the failed close was committed");
  await pool.query("UPDATE valopay_records SET data = $2 WHERE id=$1", [brokenDue.id, brokenDue.data]);
  const repaired = await runDueCloses({ batchSize: 100 });
  assert.ok(closedIds(repaired).includes(b), "once repaired the lender closes at the next pass");
  assert.equal((await closesOf(b)).length, 1);

  // A lender from before the scheduler carries no cursor: it gets the next configured time, without a close.
  await pool.query("UPDATE valopay_merchants SET settings = settings - 'nextCloseAt' WHERE id=$1", [b]);
  assert.equal(await cursorOf(b), null);
  const initialised = await runDueCloses({ batchSize: 100 });
  assert.ok(initialised.initialised >= 1);
  const cursorB = (await cursorOf(b))!;
  assert.ok(cursorB > dbNow, "the new cursor is the next 07:00 WAT");
  assert.equal(new Date(cursorB).getUTCHours(), 6);
  assert.equal(closedIds(initialised).includes(b), false, "initialisation never closes");
  assert.equal((await closesOf(b)).length, 1);

  // The tick loop: two ticks at once share one pass.
  const scheduler = startCloseScheduler({ intervalMs: 60_000, firstDelayMs: 60_000, batchSize: 100 });
  try {
    const [first, second] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    assert.ok(first);
    assert.equal(first, second, "a tick while a pass runs joins that pass");
  } finally {
    scheduler.stop();
  }

  // Expiry: scheduled-close audit entries never keep an abandoned sandbox alive.
  const workspace = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [a])).rows[0]!.workspace_id;
  await pool.query("UPDATE valopay_workspaces SET created_at = now() - interval '40 days' WHERE id=$1", [workspace]);
  await pool.query(
    `UPDATE valopay_records SET created_at = created_at - interval '40 days', updated_at = updated_at - interval '40 days'
     WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1) AND NOT (kind='audit' AND data->>'actor' LIKE $2)`,
    [workspace, `${SYSTEM_ACTOR_PREFIX}%`],
  );
  assert.ok((await pool.query("SELECT 1 FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id WHERE m.workspace_id=$1 AND r.kind='audit' AND r.created_at >= now() - interval '1 day'", [workspace])).rowCount! >= 2, "recent system audit entries exist");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await inWorkspace(requestFor(token()), response(), async (context) => { await listMerchants(context); });
    if ((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [workspace])).rowCount === 0) break;
  }
  assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [workspace])).rowCount, 0, "a sandbox touched only by the seed and the scheduled close expires");
  console.log("scheduled close integration tests passed");
} finally {
  await pool.end();
}
