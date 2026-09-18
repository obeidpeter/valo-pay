import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 for the disposable-database concurrency tests.");
  process.exit(0);
}
const { pool } = await import("@workspace/db");
const { inWorkspace, listMerchants, loadState, saveState, changeRole, appendAudit, verifyAudit, saveIdempotency, findIdempotency, digest } = await import("../src/lib/valopay-store");
const token = randomBytes(32).toString("hex");
const req = () => ({ headers: { cookie: `valopay_sandbox=${token}` }, secure: false, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
const res = () => ({ cookie() {} }) as any;
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} blocked for 5 seconds`)), 5_000); })]); }
  finally { clearTimeout(timer!); }
}
async function staysBlocked(entered: Promise<void>, label: string) {
  const winner = await Promise.race([entered.then(() => "entered"), new Promise<string>(resolve => setTimeout(() => resolve("blocked"), 100))]);
  assert.equal(winner, "blocked", label);
}
const cleanup: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
function track<T>(promise: Promise<T>) { pending.push(promise); void promise.catch(() => {}); return promise; }
try {
  const bootstrap = await Promise.all(Array.from({ length: 4 }, (_, index) => inWorkspace(req(), res(), listMerchants, index % 2 ? "write" : "read")));
  const ids = bootstrap[0]!.map(row => row.id);
  for (const rows of bootstrap) assert.deepEqual(rows.map(row => row.id), ids, "concurrent read/write bootstrap shares one fully seeded workspace");
  const [first, second] = ids as [string, string];

  const readerReady = gate(), releaseReader = gate(); cleanup.push(releaseReader.resolve);
  const heldReader = track(inWorkspace(req(), res(), async context => {
    const before = await loadState(context, first, "share");
    readerReady.resolve(); await releaseReader.promise;
    const after = await loadState(context, first, "share");
    assert.deepEqual(after, before, "a read's lender state cannot change between reads");
    assert.equal(context.role, "Admin");
    await assert.rejects(() => saveState(context, after), /read transaction cannot write/);
    await assert.rejects(() => loadState(context, first, "update"), /read transaction cannot acquire/);
    await assert.rejects(() => changeRole(context, "Finance"), /exclusive workspace transaction/);
  }, "read"));
  await within(readerReady.promise, "first reader");
  await within(inWorkspace(req(), res(), async context => { await loadState(context, first, "share"); }, "read"), "simultaneous reader");
  await within(inWorkspace(req(), res(), async context => {
    const state = await loadState(context, second);
    state.settings.concurrencyFixture = "other lender";
    await saveState(context, state);
  }), "other lender write during read");

  const writerReady = gate(), releaseWriter = gate(); cleanup.push(releaseWriter.resolve);
  const heldWriter = track(inWorkspace(req(), res(), async context => {
    const state = await loadState(context, first);
    writerReady.resolve(); await releaseWriter.promise;
    state.settings.concurrencyFixture = "committed writer";
    appendAudit(state, context, "concurrency.fixture", "workspace", "Synthetic concurrent write");
    await saveState(context, state);
    await saveIdempotency(context, `concurrency-${token}`, "fixed-request", { committed: true });
  }));
  await staysBlocked(writerReady.promise, "same-lender writer waits for reader");
  releaseReader.resolve(); await heldReader; await within(writerReady.promise, "writer after read completes");
  await within(inWorkspace(req(), res(), async context => { await loadState(context, second, "share"); }, "read"), "other lender read during write");
  const waitingReaderEntered = gate();
  const waitingReader = track(inWorkspace(req(), res(), async context => {
    const state = await loadState(context, first, "share"); waitingReaderEntered.resolve();
    assert.equal(state.settings.concurrencyFixture, "committed writer");
    assert.equal(verifyAudit(state).valid, true, "audit chain survives concurrent reads and writes");
  }, "read"));
  await staysBlocked(waitingReaderEntered.promise, "same-lender reader waits for writer commit");
  releaseWriter.resolve(); await heldWriter; await within(waitingReader, "reader after commit");
  await inWorkspace(req(), res(), async context => {
    await loadState(context, first);
    assert.deepEqual(await findIdempotency(context, `concurrency-${token}`), { request_hash: "fixed-request", response: { committed: true } });
    await assert.rejects(() => changeRole(context, "Finance"), /exclusive workspace transaction/);
  });

  const roleReaderReady = gate(), releaseRoleReader = gate(); cleanup.push(releaseRoleReader.resolve);
  const roleReader = track(inWorkspace(req(), res(), async context => { roleReaderReady.resolve(); await releaseRoleReader.promise; assert.equal(context.role, "Admin"); }, "read"));
  await within(roleReaderReady.promise, "role reader");
  const personaReady = gate(), releasePersona = gate(); cleanup.push(releasePersona.resolve);
  const persona = track(inWorkspace(req(), res(), async context => { await changeRole(context, "Finance"); personaReady.resolve(); await releasePersona.promise; }, "persona"));
  await staysBlocked(personaReady.promise, "persona waits for all active workspace readers");
  releaseRoleReader.resolve(); await roleReader; await within(personaReady.promise, "persona after readers complete");
  const newRoleEntered = gate();
  const newRole = track(inWorkspace(req(), res(), async context => { newRoleEntered.resolve(); assert.equal(context.role, "Finance"); }, "read"));
  await staysBlocked(newRoleEntered.promise, "new request cannot observe uncommitted persona");
  releasePersona.resolve(); await persona; await within(newRole, "new persona reader");
  console.log("Workspace concurrency passed: concurrent readers, cross-lender reads/writes, same-lender isolation, bootstrap, read capability, persona, audit and idempotency.");
} finally {
  cleanup.forEach(release => release());
  await Promise.allSettled(pending);
  const principal = digest(`demo:${token}`);
  for (const table of ["valopay_idempotency", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT m.id FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id WHERE w.principal_hash=$1)`, [principal]);
  await pool.query("DELETE FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=$1)", [principal]);
  await pool.query("DELETE FROM valopay_workspaces WHERE principal_hash=$1", [principal]);
  await pool.end();
}
