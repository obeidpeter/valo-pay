// Run only against the intended database, after the payload wrapping key changed name. No HTTP route.
// Needs that database's DATABASE_URL, VALOPAY_PAYLOAD_ENCRYPTION=kms, VALOPAY_KMS_KEY naming the key payloads
// move to and VALOPAY_KMS_PREVIOUS_KEYS listing every earlier key they may still name. The arguments and the key
// settings are checked before the store, and with it the database pool, is loaded, so a mistake here never opens a
// connection. Each run re-seals at most --limit payloads and reports how many still name an earlier key; run it
// again until none remain (docs/pilot-security.md, "Key rotation").
const usage = "Usage: pnpm --filter @workspace/scripts exec tsx ./rewrap-payloads.ts [--limit N]  (N from 1 to 1000; 100 when left out)";
const given = process.argv.slice(2);
// A leading `--` is skipped, as the other operator commands skip it.
const args = given[0] === "--" ? given.slice(1) : given;
const limit = args.length === 0 ? 100 : args.length === 2 && args[0] === "--limit" && /^[1-9][0-9]{0,3}$/.test(args[1]!) ? Number(args[1]) : NaN;
if (!Number.isSafeInteger(limit) || limit > 1000) {
  console.error(usage);
  process.exit(1);
}
if (process.env.VALOPAY_PAYLOAD_ENCRYPTION !== "kms" || !process.env.VALOPAY_KMS_KEY) {
  console.error("Set VALOPAY_PAYLOAD_ENCRYPTION=kms and VALOPAY_KMS_KEY to the key payloads move to, and list the earlier keys in VALOPAY_KMS_PREVIOUS_KEYS.");
  process.exit(1);
}
// The store's own pool; the scripts package does not depend on @workspace/db.
const { rewrapProtectedPayloads, closeDatabase } = await import("../artifacts/api-server/src/lib/valopay-store");
try {
  const result = await rewrapProtectedPayloads({ limit });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // A refusal is said in its own words; anything else by its message alone, never with a stack or the database's detail.
  const refusal = typeof (error as { status?: unknown }).status === "number";
  console.error(refusal ? (error as Error).message : `Re-wrapping failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
export {}; // A module, so the awaits above may stand at the top level.
