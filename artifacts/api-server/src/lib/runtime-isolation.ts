import { pool, type PoolClient } from "@workspace/db";
import { createHash } from "node:crypto";
import { reviewedRuntimeHelpers, reviewedRuntimeServerMajor, runtimeHelperDifferences, runtimePolicyDifferences, type RuntimeHelperRow, type RuntimePolicyRow, type RuntimeTriggerRow } from "./runtime-isolation-policy";
import { beginStatement, checkOut, databaseLimits, failedTransaction } from "./database-limits";

export const runtimeIsolationTables = ["valopay_workspaces", "valopay_merchants", "valopay_records", "valopay_idempotency", "valopay_operations", "valopay_teams", "valopay_staff_memberships", "valopay_staff_invitations", "valopay_staff_events", "valopay_staff_lender_access"] as const;
/** Everything the self-check compares, in one round trip: the ten tables' row
 * security and owners; the SECURITY DEFINER helpers' owners, fixed search path,
 * signatures and bodies; every policy on the ten tables; and their triggers. */
const isolationCatalogue = `SELECT current_setting('server_version_num')::int/10000 AS server_major,
  (SELECT coalesce(json_agg(json_build_object('relname',c.relname,'safe',c.relrowsecurity AND c.relforcerowsecurity AND NOT pg_has_role(current_user,c.relowner,'MEMBER'))),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind='r') AS tables,
  (SELECT coalesce(json_agg(json_build_object('proname',p.proname,'args',pg_get_function_identity_arguments(p.oid),'result',pg_get_function_result(p.oid),'volatility',p.provolatile,'language',l.lanname,'source',p.prosrc,
    'safe',p.prosecdef AND r.rolbypassrls AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT pg_has_role(current_user,p.proowner,'MEMBER') AND p.proconfig=ARRAY[$4::text])),'[]')
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND p.proname=ANY($3::text[])) AS helpers,
  (SELECT coalesce(json_agg(json_build_object('tablename',tablename,'policyname',policyname,'cmd',cmd,'permissive',permissive,'roles',roles,'qual',qual,'with_check',with_check)),'[]') FROM pg_policies WHERE schemaname=$1 AND tablename=ANY($2::text[])) AS policies,
  (SELECT coalesce(json_agg(json_build_object('tgname',t.tgname,'relname',c.relname,'definition',pg_get_triggerdef(t.oid),'tgenabled',t.tgenabled)),'[]') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT t.tgisinternal) AS triggers`;
type IsolationCatalogue = { server_major: number; tables: { relname: string; safe: boolean }[]; helpers: RuntimeHelperRow[]; policies: RuntimePolicyRow[]; triggers: RuntimeTriggerRow[] };
/** A refusal is a 503 in general words; what differs goes to the server log with the error, never to the client. */
function unavailable(message: string, differences?: string[]): never { throw Object.assign(new Error(message), { status: 503 }, differences ? { differences } : {}); }
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
 * establishes database scope, not an alternate authentication mechanism.
 * Resolves true once the connection, the forced row security and the reviewed
 * policies, helpers and workspace guard (runtime-isolation-policy.ts) are
 * verified in this transaction, and false when isolation is off. */
export async function bindRuntimeIdentity(client: PoolClient, identity: { organizationId: string; userId: string }, invitation?: { token: string; verifiedEmails: string[] }): Promise<boolean> {
  const config = runtimeIsolationConfiguration(); if (!config) return false;
  if (!/^org_[A-Za-z0-9]+$/.test(identity.organizationId) || !/^user_[A-Za-z0-9]+$/.test(identity.userId)) unavailable("A verified organisation and user are required for the isolated database.");
  const roles = (await client.query<{ current_name: string; session_name: string; unsafe: boolean }>(`SELECT current_user AS current_name,session_user AS session_name,
    (EXISTS(SELECT 1 FROM pg_roles WHERE (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb) AND (rolname IN(current_user,session_user) OR pg_has_role(current_user,oid,'MEMBER'))) OR has_schema_privilege(current_user,$1,'CREATE')) AS unsafe`, [config.schema])).rows[0];
  if (!roles || roles.current_name !== config.role || roles.session_name !== config.role || roles.unsafe) unavailable("Runtime isolation refused an elevated or unexpected database connection.");
  // Identifier comes from a strict allowlist-shaped configuration, never input.
  // The catalogue is read with pg_catalog first: nothing in the runtime schema
  // can stand in for a catalogue view, and a function there that shadows a
  // built-in is written qualified in a policy, so it differs from the reviewed text.
  await client.query(`SET LOCAL search_path TO pg_catalog, "${config.schema}", pg_temp`);
  const catalogue = (await client.query<IsolationCatalogue>(isolationCatalogue, [config.schema, runtimeIsolationTables, Object.keys(reviewedRuntimeHelpers), `search_path=pg_catalog, ${config.schema}, pg_temp`])).rows[0]!;
  if (catalogue.tables.length !== runtimeIsolationTables.length || catalogue.tables.some(table => !table.safe)) unavailable("Every runtime table must have forced row security and a separate owner before staff access is enabled.");
  // 006 adds the helper that lets lender policies run once per statement; without it every read checks each row and a pilot-scale lender takes seconds.
  if (!catalogue.helpers.some(helper => helper.proname === "valopay_runtime_lenders")) unavailable("The isolated database still checks lender access row by row. Apply lib/db/migrations/006_runtime_isolation_scope.sql before enabling staff access.");
  const helperDifferences = runtimeHelperDifferences(catalogue.helpers, config);
  if (helperDifferences.length) unavailable("The isolation helper owner, fixed configuration or definition differs from the reviewed runtime helper set.", helperDifferences);
  const policyDifferences = runtimePolicyDifferences(catalogue.policies, catalogue.triggers, config);
  // The expressions are recorded as PostgreSQL 16 writes them; another major version may write the same policy differently.
  if (policyDifferences.length) unavailable("The isolated database policies differ from the reviewed runtime policy set.", catalogue.server_major === reviewedRuntimeServerMajor ? policyDifferences
    : [...policyDifferences, `PostgreSQL ${catalogue.server_major} renders the policies; the reviewed set was captured on PostgreSQL ${reviewedRuntimeServerMajor}`]);
  const inviteHash = invitation ? createHash("sha256").update(invitation.token).digest("hex") : "";
  const emails = invitation ? invitation.verifiedEmails.map(email => email.trim().toLowerCase()) : [];
  // The business queries that follow name the runtime tables unqualified.
  await client.query("SELECT set_config('search_path',$5,true),set_config('valopay.runtime_org',$1,true),set_config('valopay.runtime_user',$2,true),set_config('valopay.runtime_invite',$3,true),set_config('valopay.runtime_emails',$4,true)", [identity.organizationId, identity.userId, inviteHash, JSON.stringify(emails), `"${config.schema}", pg_catalog, pg_temp`]);
  return true;
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
/** A background transaction with the system limits; under isolation it runs as the service member, otherwise binding is a no-op. */
export async function runtimeServiceRead<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  let committing = false;
  try {
    await client.query(beginStatement(databaseLimits().system)); await bindRuntimeService(client);
    const result = await operation(client);
    committing = true; await client.query("COMMIT"); return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* the transaction is already closed */ }
    throw failedTransaction(error, { committing, lost: guard.lost(), write: true });
  } finally { guard.release(); }
}
/** Claims never turn a stored arbitrary role into authority. A job's named
 * requester must still have its original role and access to this lender. */
export async function runtimeExportRequesterAllowed(client: PoolClient, workspaceId: string, merchantId: string, requestedBy: unknown, requestedRole: unknown) {
  if (!runtimeIsolationEnabled()) return true;
  if (typeof requestedBy !== "string" || !/^Clerk:user_[A-Za-z0-9]+$/.test(requestedBy) || !["Admin", "Operations", "Finance", "Compliance reviewer", "Read-only"].includes(String(requestedRole))) return false;
  return Boolean((await client.query(`SELECT 1 FROM valopay_staff_memberships member WHERE member.workspace_id=$1 AND member.user_id=$2 AND member.role=$3 AND member.status='active' AND member.expires_at>clock_timestamp() AND (member.role='Admin' OR EXISTS(SELECT 1 FROM valopay_staff_lender_access grant_row WHERE grant_row.membership_id=member.id AND grant_row.merchant_id=$4))`, [workspaceId, requestedBy.slice(6), requestedRole, merchantId])).rows[0]);
}
