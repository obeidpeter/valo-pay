// Run only against the intended synthetic staging database. No HTTP bootstrap.
import { provisionStaffWorkspace } from "../artifacts/api-server/src/lib/valopay-store";
import { pool } from "@workspace/db";
const [confirmation, organisation, administrator, name] = process.argv.slice(2);
if (
  confirmation !== "--synthetic-staging" ||
  !organisation ||
  !administrator ||
  !name
)
  throw new Error(
    'Usage: tsx scripts/provision-pilot.ts --synthetic-staging org_ID user_ID "Workspace name"',
  );
try {
  console.log(await provisionStaffWorkspace(organisation, administrator, name));
} finally {
  await pool.end();
}
