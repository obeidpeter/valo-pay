// Run only against the intended synthetic staging database. No HTTP bootstrap.
// Needs that database's DATABASE_URL and VALOPAY_STAFF_ACCESS=staging. The
// arguments and the staff setting are checked before the store, and with it
// the database pool, is loaded, so a mistake here never opens a connection.
const usage =
  'Usage: VALOPAY_STAFF_ACCESS=staging pnpm --filter @workspace/scripts exec tsx ./provision-pilot.ts --synthetic-staging org_ID user_ID "Workspace name"';
const given = process.argv.slice(2);
// A leading `--` is skipped, as the other operator commands skip it.
const args = given[0] === "--" ? given.slice(1) : given;
const [confirmation, organisation, administrator, name] = args;
if (
  args.length !== 4 ||
  confirmation !== "--synthetic-staging" ||
  !organisation ||
  !administrator ||
  !name
) {
  console.error(usage);
  process.exit(1);
}
if (process.env.VALOPAY_STAFF_ACCESS !== "staging") {
  console.error(
    "Set VALOPAY_STAFF_ACCESS=staging: a pilot workspace is provisioned only for staging staff access.",
  );
  process.exit(1);
}
// The store's own pool; the scripts package does not depend on @workspace/db.
const { provisionStaffWorkspace, closeDatabase } = await import(
  "../artifacts/api-server/src/lib/valopay-store"
);
try {
  console.log(await provisionStaffWorkspace(organisation, administrator, name));
} finally {
  await closeDatabase();
}
export {}; // A module, so the awaits above may stand at the top level.
