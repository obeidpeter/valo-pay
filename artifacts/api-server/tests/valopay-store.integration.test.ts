import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to run repository integration tests.");
  process.exit(0);
}

const { pool } = await import("@workspace/db");
const { getAuth } = await import("@clerk/express");
const { inWorkspace, listMerchants, loadState, saveState, findIdempotency, saveIdempotency, changeRole, appendAudit } = await import("../src/lib/valopay-store.js");

const requestFor = (token: string) => {
  // Verify this is the real Clerk request shape used by principalFor rather
  // than relying on an unbranded look-alike auth function.
  const auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
  assert.equal(getAuth({ auth } as any).userId, null);
  return { headers: { cookie: `valopay_sandbox=${token}` }, secure: false, auth } as any;
};
const response = () => ({ cookie() { /* a valid test cookie is already supplied */ } }) as any;
const token = () => randomBytes(32).toString("hex");

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
    }),
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
  await inWorkspace(requestFor(token()), response(), async (context) => { await listMerchants(context); });
  assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [staleWorkspace])).rowCount, 0, "the expired anonymous sandbox is removed");
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
  console.log("valopay repository integration tests passed");
} finally {
  await pool.end();
}