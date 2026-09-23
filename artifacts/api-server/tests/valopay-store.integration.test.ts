import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to run repository integration tests.");
  process.exit(0);
}

const { pool } = await import("@workspace/db");
const { getAuth } = await import("@clerk/express");
const { inWorkspace, listMerchants, loadState, saveState, findIdempotency, saveIdempotency, changeRole, appendAudit, settleChanges, addedRecords, closeDatabase, prepareOperation, digest, inMerchantAsSystem, SYSTEM_ACTOR_PREFIX, pingDatabase } = await import("../src/lib/valopay-store.js");
const { overrideDatabaseLimits } = await import("../src/lib/database-limits.js");

const requestFor = (token: string) => {
  // Verify this is the real Clerk request shape used by principalFor rather
  // than relying on an unbranded look-alike auth function.
  const auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
  assert.equal(getAuth({ auth } as any).userId, null);
  return { headers: { cookie: `valopay_sandbox=${token}` }, secure: false, auth } as any;
};
const response = () => ({ cookie() { /* a valid test cookie is already supplied */ } }) as any;
const token = () => randomBytes(32).toString("hex");
/** Runs `work` and returns the text and values of the first statement the store sent that matches `pattern`. */
async function statementOf(pattern: RegExp, work: () => Promise<unknown>) {
  const holder = await pool.connect(), clients = Object.getPrototypeOf(holder) as { query: (this: unknown, ...args: unknown[]) => unknown };
  holder.release();
  const query = clients.query;
  let found: { text: string; values: unknown[] } | undefined;
  clients.query = function (this: unknown, ...args: unknown[]) {
    if (!found && typeof args[0] === "string" && pattern.test(args[0])) found = { text: args[0], values: Array.isArray(args[1]) ? args[1] : [] };
    return query.apply(this, args);
  };
  try { await work(); } finally { clients.query = query; }
  assert.ok(found, `the store sent a statement matching ${pattern}`);
  return found!;
}
/** The indexes PostgreSQL would read to run a statement with its own values. */
async function indexesRead(statement: { text: string; values: unknown[] }) {
  const plan = (await pool.query(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.values)).rows[0]["QUERY PLAN"][0].Plan;
  const names = new Set<string>(), walk = (node: any) => { if (node["Index Name"]) names.add(node["Index Name"]); for (const child of node.Plans ?? []) walk(child); };
  walk(plan);
  return names;
}

try {
  const role = await pool.query("SELECT 1 FROM pg_roles WHERE rolname='valopay_runtime'");
  assert.equal(role.rowCount, 0, "legacy runtime role must be absent");
  const policies = await pool.query(
    "SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename=ANY($1::text[])",
    [["valopay_workspaces", "valopay_merchants", "valopay_records", "valopay_idempotency"]],
  );
  assert.equal(policies.rowCount, 0, "legacy Valo Pay RLS policies must be absent");
  const triggers = await pool.query(
    `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     WHERE c.relname='valopay_records' AND NOT t.tgisinternal`,
  );
  assert.equal(triggers.rowCount, 0, "legacy record protection trigger must be absent");
  const functions = await pool.query("SELECT 1 FROM pg_proc WHERE proname='valopay_protect_records'");
  assert.equal(functions.rowCount, 0, "legacy record protection function must be absent");

  const bootstrapPrincipal = token();
  const bootstrapResults = await Promise.all(Array.from({ length: 4 }, () =>
    inWorkspace(requestFor(bootstrapPrincipal), response(), async (context) =>
      (await listMerchants(context)).map((merchant) => merchant.id).sort(),
    ),
  ));
  assert.equal(bootstrapResults[0]!.length, 2);
  for (const result of bootstrapResults) assert.deepEqual(result, bootstrapResults[0], "Concurrent bootstrap must create only one workspace and its two lenders.");
  const legacyRequest = requestFor(bootstrapPrincipal);
  legacyRequest.headers.cookie = `valo_sandbox=${bootstrapPrincipal}`;
  await inWorkspace(legacyRequest, response(), async (context) => {
    assert.deepEqual((await listMerchants(context)).map((merchant) => merchant.id).sort(), bootstrapResults[0], "Legacy cookies must keep access to the same workspace.");
  });

  const principalA = token();
  let merchantA = "";
  let originalCustomerName = "";
  let retainedContext: any;
  // Bootstrap must commit separately; otherwise rollback correctly removes the
  // entire fresh workspace, including the IDs the next assertion would load.
  await inWorkspace(requestFor(principalA), response(), async (context) => {
    merchantA = (await listMerchants(context))[0]!.id;
  });
  await assert.rejects(
    () => inWorkspace(requestFor(principalA), response(), async (context) => {
      retainedContext = context;
      assert.equal("db" in context, false, "routes never receive a database client");
      merchantA = (await listMerchants(context))[0]!.id;
      const state = await loadState(context, merchantA);
      const customer = state.records.find((record) => record.kind === "customers")!;
      originalCustomerName = customer.name;
      customer.name = `rollback-${randomUUID()}`;
      await changeRole(context, "Finance");
      await saveState(context, state);
      throw new Error("intentional repository rollback");
    }, "persona"),
    /intentional repository rollback/,
  );

  await assert.rejects(() => listMerchants(retainedContext), (error: any) => error?.status === 409);
  await inWorkspace(requestFor(principalA), response(), async (context) => {
    assert.equal(context.role, "Admin", "role update must be rolled back with the record write");
    const state = await loadState(context, merchantA);
    assert.equal(state.records.find((record) => record.kind === "customers")!.name, originalCustomerName);
    state.records.pop();
    await assert.rejects(() => saveState(context, state), (error: any) => error?.status === 409);
  });

  const principalB = token();
  let merchantB = "";
  const idempotencyId = `integration-${randomUUID()}`;
  await inWorkspace(requestFor(principalB), response(), async (context) => {
    merchantB = (await listMerchants(context))[0]!.id;
    await loadState(context, merchantB);
    await saveIdempotency(context, idempotencyId, "original-request", { response: "original" });
  });
  await assert.rejects(
    () => inWorkspace(requestFor(principalB), response(), async (context) => {
      await loadState(context, merchantB);
      assert.deepEqual(await findIdempotency(context, idempotencyId), { request_hash: "original-request", response: { response: "original" } });
      // saveIdempotency maps the SQL duplicate to 409.  Swallowing it must not
      // turn the already-aborted PostgreSQL transaction into an apparent commit.
      await assert.rejects(
        () => saveIdempotency(context, idempotencyId, "different-request", { response: "rewritten" }),
        (error: any) => error?.status === 409,
      );
    }),
    /workspace transaction was rolled back/,
  );
  await inWorkspace(requestFor(principalB), response(), async (context) => {
    await loadState(context, merchantB);
    assert.deepEqual(await findIdempotency(context, idempotencyId), { request_hash: "original-request", response: { response: "original" } });
  });

  const principalC = token();
  await inWorkspace(requestFor(principalC), response(), async (context) => {
    await assert.rejects(() => loadState(context, merchantA), (error: any) => error?.status === 404);
    await assert.rejects(() => listMerchants({ ...context } as typeof context), (error: any) => error?.status === 409);
  });

  // Expiry: an anonymous sandbox older than the cookie lifetime with no change in that time is swept by the next bootstrap.
  const staleToken = token();
  let staleMerchant = "";
  await inWorkspace(requestFor(staleToken), response(), async (context) => { staleMerchant = (await listMerchants(context))[0]!.id; });
  const staleWorkspace = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [staleMerchant])).rows[0]!.workspace_id;
  await pool.query("UPDATE valopay_workspaces SET created_at = now() - interval '40 days' WHERE id=$1", [staleWorkspace]);
  await pool.query("UPDATE valopay_records SET created_at = created_at - interval '40 days', updated_at = updated_at - interval '40 days' WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [staleWorkspace]);
  // Cleanup is opt-in (VALOPAY_EXPIRED_WORKSPACE_CLEANUP=on): by default a new bootstrap leaves the expired sandbox alone.
  await inWorkspace(requestFor(token()), response(), async (context) => { await listMerchants(context); });
  assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [staleWorkspace])).rowCount, 1, "with cleanup off, the default, the expired sandbox is kept");
  process.env.VALOPAY_EXPIRED_WORKSPACE_CLEANUP = "on";
  {
    // A sweep that cannot finish (here, a record of the expired sandbox is locked elsewhere past the lock limit) rolls back to its savepoint: the visitor is still seeded.
    const restore = overrideDatabaseLimits({ request: { lockMs: 300 } });
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM valopay_records WHERE merchant_id=$1 LIMIT 1 FOR UPDATE", [staleMerchant]);
      const seeded = await inWorkspace(requestFor(token()), response(), listMerchants);
      assert.equal(seeded.length, 2, "a stuck sweep never fails a new visitor's bootstrap");
      assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [staleWorkspace])).rowCount, 1, "the expired sandbox is left whole for a later sweep");
      assert.equal((await pool.query("SELECT 1 FROM valopay_merchants WHERE workspace_id=$1", [staleWorkspace])).rowCount, 2, "with both its lenders");
    } finally { await holder.query("ROLLBACK"); holder.release(); restore(); }
  }
  await inWorkspace(requestFor(token()), response(), async (context) => { await listMerchants(context); });
  assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [staleWorkspace])).rowCount, 0, "with cleanup on, the expired anonymous sandbox is removed");
  assert.equal((await pool.query("SELECT 1 FROM valopay_merchants WHERE workspace_id=$1", [staleWorkspace])).rowCount, 0, "with its lenders and records");
  assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=(SELECT workspace_id FROM valopay_merchants WHERE id=$1)", [merchantA])).rowCount, 1, "a live sandbox stays");
  // A sandbox that is old but recently changed by a person stays; activity is read from the audit chain, and the seed's own system entry does not count.
  const activeToken = token();
  let activeMerchant = "";
  await inWorkspace(requestFor(activeToken), response(), async (context) => { activeMerchant = (await listMerchants(context))[0]!.id; });
  const activeWorkspace = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [activeMerchant])).rows[0]!.workspace_id;
  await pool.query("UPDATE valopay_workspaces SET created_at = now() - interval '40 days' WHERE id=$1", [activeWorkspace]);
  await pool.query("UPDATE valopay_records SET created_at = created_at - interval '40 days', updated_at = updated_at - interval '40 days' WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [activeWorkspace]);
  await inWorkspace(requestFor(activeToken), response(), async (context) => {
    const state = await loadState(context, activeMerchant);
    appendAudit(state, context, "patch.settings", "workspace", "A person changed a setting");
    await saveState(context, state);
  });
  await inWorkspace(requestFor(token()), response(), async (context) => { await listMerchants(context); });
  assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [activeWorkspace])).rowCount, 1, "a recent change by a person keeps an old sandbox alive");
  {
    // The sweep and a scheduled close of the same expired sandbox. A close holds its lender's row from the start and
    // writes the lender's records at the end. The sweep used to delete the sandbox's records first and then wait for
    // that lender's row, so the close, saving, waited for a record the sweep had deleted: a deadlock, which PostgreSQL
    // broke after a second by failing one of the two. The sweep now locks a sandbox's lenders first, in order and
    // without waiting, and leaves a sandbox with a lender held elsewhere whole for a later sweep.
    const heldToken = token();
    const heldLender = (await inWorkspace(requestFor(heldToken), response(), listMerchants)).map((merchant) => merchant.id).sort()[0]!;
    const heldWorkspace = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [heldLender])).rows[0]!.workspace_id;
    // Older than every other expired sandbox a reused database may hold, so this sweep reaches it first.
    await pool.query("UPDATE valopay_workspaces SET created_at = now() - interval '400 days' WHERE id=$1", [heldWorkspace]);
    await pool.query("UPDATE valopay_records SET created_at = created_at - interval '400 days', updated_at = updated_at - interval '400 days' WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [heldWorkspace]);
    let holding!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
    const close = inMerchantAsSystem(heldLender, `${SYSTEM_ACTOR_PREFIX}scheduled close`, async (context) => {
      const state = await loadState(context, heldLender);
      holding(); await released;
      const customer = state.records.find((record) => record.kind === "customers")!;
      customer.name = `${customer.name} (closed)`;
      appendAudit(state, context, "daily_close", customer.id, "Synthetic close while the sweep runs", settleChanges(context, state));
      await saveState(context, state);
      return customer.id;
    });
    await held;
    const warnings: Array<{ event?: string }> = [];
    const visitor = inWorkspace({ ...requestFor(token()), log: { warn: (fields: { event?: string }) => warnings.push(fields) } }, response(), listMerchants);
    const sweepWaits = async () => {
      for (let waited = 0; waited < 5_000; waited += 25) {
        if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM valopay_%'")).rowCount) return "sweep waited";
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return "timed out";
    };
    const first = await Promise.race([visitor.then(() => "sweep finished", () => "visitor failed"), sweepWaits()]);
    release();
    const [closed, seeded] = await Promise.allSettled([close, visitor]);
    assert.equal(first, "sweep finished", "the sweep never waits for a lender a close holds");
    assert.equal(closed.status, "fulfilled", `the close saves: ${closed.status === "rejected" ? String(closed.reason?.message) : ""}`);
    assert.equal(seeded.status === "fulfilled" && seeded.value.length, 2, "and the visitor is seeded");
    assert.deepEqual(warnings.map((fields) => fields.event), [], "without a failed sweep");
    assert.equal((await pool.query("SELECT 1 FROM valopay_merchants WHERE workspace_id=$1", [heldWorkspace])).rowCount, 2, "the sandbox with a busy lender is left whole");
    // Once the close has finished, the next sweep removes the sandbox; the close's own entry is not activity.
    await inWorkspace(requestFor(token()), response(), listMerchants);
    assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [heldWorkspace])).rowCount, 0, "a later sweep removes it");
    assert.equal((await pool.query("SELECT 1 FROM valopay_records WHERE merchant_id=$1", [heldLender])).rowCount, 0, "with the close's records");
  }
  // A save touches only what the request changed. Earlier closes load as
  // summaries for writes, stay whole in PostgreSQL and in reads, and a save
  // cannot change them.
  const savesToken = token();
  let savesMerchant = "";
  await inWorkspace(requestFor(savesToken), response(), async (context) => { savesMerchant = (await listMerchants(context))[0]!.id; });
  const report = { unallocated: { count: 1, kobo: 5, olderThan24Hours: 0 }, exceptions: { openAtClose: 2, overdueAtClose: 1 }, customerPositionsChanged: Array.from({ length: 200 }, (_, index) => ({ customerId: `c${index}`, note: "x".repeat(200) })) };
  for (const [id, days] of [["close-old", 30], ["close-recent", 2], ["close-latest", 0]] as const) {
    await pool.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at) VALUES($1,$2,'closes',$1,'completed','',0,'',$3,now()-make_interval(days=>$4),now()-make_interval(days=>$4))",
      [`${savesMerchant}-${id}`, savesMerchant, { summary: id, closedAt: new Date(Date.now() - days * 86400000).toISOString(), report, operational: { rows: 1 }, metrics: [{ key: "m" }], synthetic: true }, days]);
  }
  const stamps = async () => new Map((await pool.query<{ id: string; updated_at: Date }>("SELECT id,updated_at FROM valopay_records WHERE merchant_id=$1", [savesMerchant])).rows.map((row) => [row.id, row.updated_at.toISOString()]));
  const beforeSave = await stamps();
  await inWorkspace(requestFor(savesToken), response(), async (context) => {
    const state = await loadState(context, savesMerchant);
    const old = state.records.find((record) => record.id === `${savesMerchant}-close-old`)!;
    assert.deepEqual(Object.keys(old.data).sort(), ["closedAt", "report", "summary", "synthetic"], "an earlier close loads for a write as its summary");
    assert.deepEqual(old.data.report, { unallocated: report.unallocated, exceptions: report.exceptions }, "with the totals the domain reads");
    assert.equal(state.records.find((record) => record.id === `${savesMerchant}-close-recent`)!.data.operational?.rows, 1, "recent closes, and so the latest, stay whole");
    const customer = state.records.find((record) => record.kind === "customers")!;
    customer.name = `${customer.name} (renamed)`;
    const added = { ...structuredClone(customer), id: randomUUID(), reference: `SAVE-${randomUUID()}`, name: "Added in this save", createdAt: context.now, updatedAt: context.now };
    state.records.push(added);
    assert.deepEqual(addedRecords(context, state).map((record) => record.id), [added.id]);
    const changes = settleChanges(context, state);
    assert.equal(changes.changedRecords, 2, "the audit digests cover the renamed and the added customer only");
    assert.ok(customer.updatedAt > beforeSave.get(customer.id)!, "the changed record gets a newer version before the response is built");
    appendAudit(state, context, "patch.records.customers", customer.id, "Renamed in the save test", changes);
    await saveState(context, state);
  });
  const afterSave = await stamps();
  const rewritten = [...beforeSave].filter(([id, at]) => afterSave.get(id) !== at).map(([id]) => id);
  assert.equal(rewritten.length, 1, "only the renamed record was rewritten; the rest of the lender was left alone");
  assert.equal(afterSave.size, beforeSave.size + 2, "the added customer and the audit entry were inserted");
  const stored = (await pool.query("SELECT data FROM valopay_records WHERE id=$1", [`${savesMerchant}-close-old`])).rows[0].data;
  assert.equal(stored.report.customerPositionsChanged.length, 200, "the earlier close keeps its full report in PostgreSQL");
  assert.equal(stored.operational.rows, 1);
  await inWorkspace(requestFor(savesToken), response(), async (context) => {
    const full = await loadState(context, savesMerchant, "share");
    assert.equal(full.records.find((record) => record.id === `${savesMerchant}-close-old`)!.data.report.customerPositionsChanged.length, 200, "a read still sees every close whole");
  }, "read");
  await assert.rejects(() => inWorkspace(requestFor(savesToken), response(), async (context) => {
    const state = await loadState(context, savesMerchant);
    state.records.find((record) => record.id === `${savesMerchant}-close-old`)!.data.summary = "rewritten";
    await saveState(context, state);
  }), /Evidence records are immutable/, "a summarised close can never be written back over its full report");
  assert.equal((await pool.query("SELECT data->>'summary' AS summary FROM valopay_records WHERE id=$1", [`${savesMerchant}-close-old`])).rows[0].summary, "close-old");
  // The pending-request limit counts a person's pending journal entries, and a workspace's lenders are read by
  // workspace; each has its own index (lib/db/migrations/007_journal_and_lender_indexes.sql). Without them the count
  // read every entry the person had ever made, and the lender lookups every lender. The store's own statements are
  // captured as they run and explained with their own values, on a journal and a lender table big enough to choose.
  {
    const indexToken = token(), filler = `index-filler-${randomUUID()}`;
    const indexLender = (await inWorkspace(requestFor(indexToken), response(), listMerchants))[0]!.id;
    try {
      await pool.query(`INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,status)
        SELECT $3||'-'||i,$1,$2,'Sandbox Admin','Admin',$3||'-key-'||i,'hash','{}','Save records customers',CASE WHEN i<=3 THEN 'pending' ELSE 'completed' END FROM generate_series(1,20000) i`, [indexLender, digest(`demo:${indexToken}`), filler]);
      await pool.query("INSERT INTO valopay_workspaces(id,principal_hash,role) SELECT $1||'-'||i,$1||'-principal-'||i,'Admin' FROM generate_series(1,3000) i", [filler]);
      await pool.query(`INSERT INTO valopay_merchants(id,workspace_id,info,settings) SELECT $1||'-lender-'||i,$1||'-'||(i%3000+1),'{}','{"scheduledCloseEnabled":false}' FROM generate_series(1,6000) i`, [filler]);
      await pool.query("ANALYZE valopay_operations"); await pool.query("ANALYZE valopay_merchants");
      const pending = await statementOf(/^SELECT count\(\*\) FROM valopay_operations WHERE merchant_id=\$1 AND owner=\$2 AND status='pending'/, () =>
        inWorkspace(requestFor(indexToken), response(), (context) => prepareOperation(context, indexLender, randomUUID(), { method: "POST", path: "/v1/records/customers", body: { name: "Index check" } })));
      assert.deepEqual([...await indexesRead(pending)], ["valopay_operations_pending"], "the pending-request limit reads only pending entries");
      const lenders = await statementOf(/^SELECT m\.info FROM valopay_merchants m/, () => inWorkspace(requestFor(indexToken), response(), listMerchants, "read"));
      assert.ok((await indexesRead(lenders)).has("valopay_merchants_workspace"), "a workspace's lenders are read through the workspace index");
    } finally {
      await pool.query("DELETE FROM valopay_operations WHERE merchant_id=$1 AND (id LIKE $2 OR label='Save records customers')", [indexLender, `${filler}-%`]);
      await pool.query("DELETE FROM valopay_merchants WHERE id LIKE $1", [`${filler}-lender-%`]);
      await pool.query("DELETE FROM valopay_workspaces WHERE id LIKE $1", [`${filler}-%`]);
      await pool.query("ANALYZE valopay_operations"); await pool.query("ANALYZE valopay_merchants");
    }
  }
  // Readiness asks the database for what this build needs, not only for an answer: every table the Drizzle schema
  // declares with every column it declares, and the indexes later migrations add, compared by definition (the copied
  // tables of an isolated schema carry generated index names). A database missing a migration used to answer SELECT 1
  // and read as ready. A missing table or column fails the check; a missing index is only reported.
  {
    const ready = await pingDatabase();
    assert.deepEqual([ready.status, ready.schema], ["ok", { status: "ok", missing: [] }], "the pushed schema is complete");
    const scratch = `valopay_readiness_test_${randomBytes(6).toString("hex")}`;
    const tables = ["valopay_workspaces", "valopay_merchants", "valopay_records", "valopay_idempotency", "valopay_operations", "valopay_teams", "valopay_staff_memberships", "valopay_staff_invitations", "valopay_staff_events", "valopay_staff_lender_access"];
    try {
      await pool.query(`CREATE SCHEMA "${scratch}"`);
      for (const table of tables) await pool.query(`CREATE TABLE "${scratch}".${table} (LIKE public.${table} INCLUDING ALL)`);
      assert.deepEqual((await pingDatabase({ schema: scratch })).schema, { status: "ok", missing: [] }, "copied tables whose indexes carry generated names are complete");
      const copiedPending = (await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='valopay_operations' AND indexdef LIKE '%WHERE (status%'", [scratch])).rows[0]!.indexname;
      await pool.query(`DROP INDEX "${scratch}"."${copiedPending}"`);
      // Without an index every request still works, only slower: reported, not a reason to leave rotation.
      assert.deepEqual((await pingDatabase({ schema: scratch })).schema, { status: "indexes_missing", missing: ["index valopay_operations_pending: apply lib/db/migrations/007_journal_and_lender_indexes.sql"] }, "a missing index alone is named, with its migration, without failing");
      await pool.query(`DROP TABLE "${scratch}".valopay_staff_events`);
      await pool.query(`ALTER TABLE "${scratch}".valopay_operations DROP COLUMN receipt`);
      const incomplete = await pingDatabase({ schema: scratch });
      assert.deepEqual([incomplete.status, incomplete.schema.status], ["ok", "incomplete"], "a database that answers but lacks a table or column the build uses is not ready");
      assert.deepEqual(incomplete.schema.missing, [
        "column valopay_operations.receipt: apply lib/db/migrations/003_pilot_workflow.sql",
        "table valopay_staff_events: apply lib/db/migrations/003_pilot_workflow.sql",
        "index valopay_operations_pending: apply lib/db/migrations/007_journal_and_lender_indexes.sql",
      ], "and names each missing table, column and index with the migration that adds it");
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${scratch}" CASCADE`);
    }
  }
  // Audit item 26: a record whose keys were only reordered holds the value PostgreSQL already stores. A save neither
  // writes it nor gives it a new version, so evidence (a close, an audit entry) is not refused as changed.
  const beforeReorder = await stamps();
  await inWorkspace(requestFor(savesToken), response(), async (context) => {
    const state = await loadState(context, savesMerchant);
    const reordered = [
      state.records.find((record) => record.id === `${savesMerchant}-close-recent`)!,
      state.records.find((record) => record.kind === "audit")!,
      state.records.find((record) => record.kind === "customers")!,
    ];
    const versions = reordered.map((record) => record.updatedAt);
    for (const record of reordered) record.data = Object.fromEntries(Object.entries(record.data).reverse());
    assert.equal(settleChanges(context, state).changedRecords, 0, "reordered keys are not a change");
    assert.deepEqual(reordered.map((record) => record.updatedAt), versions, "and give no record a new version");
    await saveState(context, state);
  });
  assert.deepEqual(await stamps(), beforeReorder, "nothing was written");
  console.log("valopay repository integration tests passed");
} finally {
  delete process.env.VALOPAY_EXPIRED_WORKSPACE_CLEANUP;
  await closeDatabase();
}
