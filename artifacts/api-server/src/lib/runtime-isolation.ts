import { pool, type PoolClient } from "@workspace/db";
import { createHash } from "node:crypto";

export const runtimeIsolationTables = ["valopay_workspaces", "valopay_merchants", "valopay_records", "valopay_idempotency", "valopay_operations", "valopay_teams", "valopay_staff_memberships", "valopay_staff_invitations", "valopay_staff_events", "valopay_staff_lender_access"] as const;
function unavailable(message: string): never { throw Object.assign(new Error(message), { status: 503 }); }
export function runtimeIsolationEnabled() {
  const mode = process.env.VALOPAY_RUNTIME_ISOLATION;
  if (mode && mode !== "off" && mode !== "staging") unavailable("Runtime database isolation configuration is invalid.");
  return mode === "staging";
}
export function runtimeIsolationConfiguration() {
  if (!runtimeIsolationEnabled()) return null;
  const schema = process.env.VALOPAY_RUNTIME_SCHEMA || "", role = process.env.VALOPAY_RUNTIME_ROLE || "";
  if (!/^valopay_runtime_(staging|test)_[a-z0-9_]+$/.test(schema) || !/^[a-z][a-z0-9_]{2,62}$/.test(role)) unavailable("Runtime isolation needs a separate commissioning schema and a restricted database role. The public schema is refused.");
  if (process.env.VALOPAY_STAFF_ACCESS !== "staging") unavailable("Runtime isolation requires verified staging staff access.");
  if (process.env.VALOPAY_PAYLOAD_ENCRYPTION !== "kms" || !process.env.VALOPAY_KMS_KEY) unavailable("Runtime isolation requires the configured KMS payload-encryption boundary.");
  return { schema, role };
}
/** Must run inside every business transaction, before any table lookup. An
 * authenticated API request supplies Clerk-verified identity; this function
 * establishes database scope, not an alternate authentication mechanism. */
export async function bindRuntimeIdentity(client: PoolClient, identity: { organizationId: string; userId: string }, invitation?: { token: string; verifiedEmails: string[] }) {
  const config = runtimeIsolationConfiguration(); if (!config) return;
  if (!/^org_[A-Za-z0-9]+$/.test(identity.organizationId) || !/^user_[A-Za-z0-9]+$/.test(identity.userId)) unavailable("A verified organisation and user are required for the isolated database.");
  const roles = (await client.query<{ current_name: string; session_name: string; unsafe: boolean }>(`SELECT current_user AS current_name,session_user AS session_name,
    (EXISTS(SELECT 1 FROM pg_roles WHERE (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb) AND (rolname IN(current_user,session_user) OR pg_has_role(current_user,oid,'MEMBER'))) OR has_schema_privilege(current_user,$1,'CREATE')) AS unsafe`, [config.schema])).rows[0];
  if (!roles || roles.current_name !== config.role || roles.session_name !== config.role || roles.unsafe) unavailable("Runtime isolation refused an elevated or unexpected database connection.");
  // Identifier comes from a strict allowlist-shaped configuration, never input.
  await client.query(`SET LOCAL search_path TO "${config.schema}", pg_catalog, pg_temp`);
  const tables = (await client.query<{ relname: string; safe: boolean }>(`SELECT c.relname,(c.relrowsecurity AND c.relforcerowsecurity AND NOT pg_has_role(current_user,c.relowner,'MEMBER')) AS safe FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind='r'`, [config.schema, runtimeIsolationTables])).rows;
  if (tables.length !== runtimeIsolationTables.length || tables.some(table => !table.safe)) unavailable("Every runtime table must have forced row security and a separate owner before staff access is enabled.");
  const policies = (await client.query<{ tablename: string; policyname: string; cmd: string }>(`SELECT tablename,policyname,cmd FROM pg_policies WHERE schemaname=$1 AND tablename=ANY($2::text[])`, [config.schema, runtimeIsolationTables])).rows;
  const sensitive: Record<string, string[]> = { valopay_staff_memberships: ["SELECT", "INSERT", "UPDATE"], valopay_staff_lender_access: ["SELECT", "INSERT", "DELETE"], valopay_staff_invitations: ["SELECT", "INSERT", "UPDATE"], valopay_staff_events: ["SELECT", "INSERT"], valopay_merchants: ["SELECT", "INSERT", "UPDATE"], valopay_records: ["SELECT", "INSERT", "UPDATE"], valopay_idempotency: ["SELECT", "INSERT", "UPDATE"], valopay_operations: ["SELECT", "INSERT", "UPDATE"] };
  const expected = runtimeIsolationTables.flatMap(table => (sensitive[table] || ["ALL"]).map(cmd => `${table}:valopay_runtime_${cmd === "ALL" || cmd === "SELECT" ? "scope" : cmd.toLowerCase()}:${cmd}`)).sort();
  if (JSON.stringify(policies.map(policy => `${policy.tablename}:${policy.policyname}:${policy.cmd}`).sort()) !== JSON.stringify(expected)) unavailable("The isolated database policies differ from the reviewed runtime policy set.");
  const helpers = (await client.query<{ proname: string; safe: boolean }>(`SELECT p.proname,(p.prosecdef AND r.rolbypassrls AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT pg_has_role(current_user,p.proowner,'MEMBER') AND p.proconfig=ARRAY[$3::text]) AS safe FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname=$1 AND p.proname=ANY($2::text[])`, [config.schema, ["valopay_runtime_workspace", "valopay_runtime_admin", "valopay_runtime_writer", "valopay_runtime_lender", "valopay_runtime_member", "valopay_runtime_invited", "valopay_runtime_clear_invitee_grants"], `search_path=pg_catalog, ${config.schema}, pg_temp`])).rows;
  if (helpers.length !== 7 || helpers.some(helper => !helper.safe)) unavailable("The isolation helper owner or fixed configuration is unsafe.");
  const inviteHash = invitation ? createHash("sha256").update(invitation.token).digest("hex") : "";
  const emails = invitation ? invitation.verifiedEmails.map(email => email.trim().toLowerCase()) : [];
  await client.query("SELECT set_config('valopay.runtime_org',$1,true),set_config('valopay.runtime_user',$2,true),set_config('valopay.runtime_invite',$3,true),set_config('valopay.runtime_emails',$4,true)", [identity.organizationId, identity.userId, inviteHash, JSON.stringify(emails)]);
}
/** Clears only the currently invited person's former grants during renewal. */
export async function clearRuntimeInviteeGrants(client: PoolClient) {
  if (!runtimeIsolationEnabled()) return;
  await client.query("SELECT valopay_runtime_clear_invitee_grants()");
}
/** A background worker has no browser session. It uses one explicitly named
 * service member in one organisation; the same active membership and lender
 * grants are checked by RLS. Missing service identity fails closed. */
export async function bindRuntimeService(client: PoolClient) {
  if (!runtimeIsolationEnabled()) return;
  await bindRuntimeIdentity(client, { organizationId: process.env.VALOPAY_RUNTIME_SERVICE_ORG || "", userId: process.env.VALOPAY_RUNTIME_SERVICE_USER || "" });
  const member = (await client.query<{ role: string }>("SELECT role FROM valopay_staff_memberships WHERE user_id=current_setting('valopay.runtime_user',true) AND status='active' AND expires_at>clock_timestamp()")).rows[0];
  if (!member || !["Admin", "Operations"].includes(member.role)) unavailable("The isolated service worker needs an active Operations or administrator membership.");
}
export async function runtimeServiceRead<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await bindRuntimeService(client); const result = await operation(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
/** Claims never turn a stored arbitrary role into authority. A job's named
 * requester must still have its original role and access to this lender. */
export async function runtimeExportRequesterAllowed(client: PoolClient, workspaceId: string, merchantId: string, requestedBy: unknown, requestedRole: unknown) {
  if (!runtimeIsolationEnabled()) return true;
  if (typeof requestedBy !== "string" || !/^Clerk:user_[A-Za-z0-9]+$/.test(requestedBy) || !["Admin", "Operations", "Finance", "Compliance reviewer", "Read-only"].includes(String(requestedRole))) return false;
  return Boolean((await client.query(`SELECT 1 FROM valopay_staff_memberships member WHERE member.workspace_id=$1 AND member.user_id=$2 AND member.role=$3 AND member.status='active' AND member.expires_at>clock_timestamp() AND (member.role='Admin' OR EXISTS(SELECT 1 FROM valopay_staff_lender_access grant_row WHERE grant_row.membership_id=member.id AND grant_row.merchant_id=$4))`, [workspaceId, requestedBy.slice(6), requestedRole, merchantId])).rows[0]);
}
