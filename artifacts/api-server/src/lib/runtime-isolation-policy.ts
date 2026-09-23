/**
 * The reviewed runtime isolation set: what lib/db/migrations/005_runtime_isolation.sql
 * and then 006_runtime_isolation_scope.sql install in a runtime schema, as the
 * restricted login reads the catalogue back on PostgreSQL 16 with pg_catalog and
 * then the runtime schema on its search path. bindRuntimeIdentity compares the live
 * catalogue with it in every isolated transaction and refuses any difference.
 *
 * Pure: no database import, so the offline suites load it. Definitions are kept
 * as text a reviewer can read: the runtime schema's qualifier is removed from
 * the names of the reviewed tables and helpers, {role} stands for the runtime
 * login in the workspace guard, and white space is collapsed. {role} is spelt
 * out in this text before a comparison, never put into the live text.
 *
 * A migration that changes a policy, a helper, the workspace guard or a grant
 * to the runtime login changes this file in the same reviewed commit;
 * runtime-isolation.integration.test.ts fails otherwise, and so does every
 * isolated staff request.
 */
export type ReviewedPolicy = { readonly using: string | null; readonly check: string | null };
export type ReviewedHelper = { readonly args: string; readonly result: string; readonly volatility: "s" | "v"; readonly language: "sql" | "plpgsql"; readonly source: string };
/** Keyed table:policy:command. Every policy is PERMISSIVE and applies to the runtime login alone. */
export const reviewedRuntimePolicies: Readonly<Record<string, ReviewedPolicy>> = {
  "valopay_idempotency:valopay_runtime_insert:INSERT": { using: null, check: "((merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders)) AND ( SELECT valopay_runtime_writer() AS valopay_runtime_writer))" },
  "valopay_idempotency:valopay_runtime_scope:SELECT": { using: "(merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders))", check: null },
  "valopay_idempotency:valopay_runtime_update:UPDATE": { using: "((merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders)) AND ( SELECT valopay_runtime_admin() AS valopay_runtime_admin))", check: "((merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders)) AND ( SELECT valopay_runtime_admin() AS valopay_runtime_admin))" },
  "valopay_merchants:valopay_runtime_insert:INSERT": { using: null, check: "((workspace_id = ( SELECT valopay_runtime_workspace() AS valopay_runtime_workspace)) AND (( SELECT valopay_runtime_admin() AS valopay_runtime_admin) OR (id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders))) AND ( SELECT valopay_runtime_admin() AS valopay_runtime_admin))" },
  "valopay_merchants:valopay_runtime_scope:SELECT": { using: "((workspace_id = ( SELECT valopay_runtime_workspace() AS valopay_runtime_workspace)) AND (( SELECT valopay_runtime_admin() AS valopay_runtime_admin) OR (id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders))))", check: null },
  "valopay_merchants:valopay_runtime_update:UPDATE": { using: "((workspace_id = ( SELECT valopay_runtime_workspace() AS valopay_runtime_workspace)) AND (( SELECT valopay_runtime_admin() AS valopay_runtime_admin) OR (id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders))) AND ( SELECT valopay_runtime_writer() AS valopay_runtime_writer))", check: "((workspace_id = ( SELECT valopay_runtime_workspace() AS valopay_runtime_workspace)) AND (( SELECT valopay_runtime_admin() AS valopay_runtime_admin) OR (id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders))) AND ( SELECT valopay_runtime_writer() AS valopay_runtime_writer))" },
  "valopay_operations:valopay_runtime_insert:INSERT": { using: null, check: "((merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders)) AND ( SELECT valopay_runtime_writer() AS valopay_runtime_writer))" },
  "valopay_operations:valopay_runtime_scope:SELECT": { using: "(merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders))", check: null },
  "valopay_operations:valopay_runtime_update:UPDATE": { using: "((merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders)) AND ( SELECT valopay_runtime_writer() AS valopay_runtime_writer))", check: "((merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders)) AND ( SELECT valopay_runtime_writer() AS valopay_runtime_writer))" },
  "valopay_records:valopay_runtime_insert:INSERT": { using: null, check: "((merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders)) AND ( SELECT valopay_runtime_writer() AS valopay_runtime_writer))" },
  "valopay_records:valopay_runtime_scope:SELECT": { using: "(merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders))", check: null },
  "valopay_records:valopay_runtime_update:UPDATE": { using: "((merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders)) AND ( SELECT valopay_runtime_writer() AS valopay_runtime_writer))", check: "((merchant_id IN ( SELECT valopay_runtime_lenders() AS valopay_runtime_lenders)) AND ( SELECT valopay_runtime_writer() AS valopay_runtime_writer))" },
  "valopay_staff_events:valopay_runtime_insert:INSERT": { using: null, check: "((workspace_id = valopay_runtime_workspace()) AND (actor = ('Clerk:'::text || NULLIF(current_setting('valopay.runtime_user'::text, true), ''::text))))" },
  "valopay_staff_events:valopay_runtime_scope:SELECT": { using: "(workspace_id = valopay_runtime_workspace())", check: null },
  "valopay_staff_invitations:valopay_runtime_insert:INSERT": { using: null, check: "((workspace_id = valopay_runtime_workspace()) AND (valopay_runtime_admin() OR ((token_hash = NULLIF(current_setting('valopay.runtime_invite'::text, true), ''::text)) AND (email IN ( SELECT jsonb_array_elements_text((COALESCE(NULLIF(current_setting('valopay.runtime_emails'::text, true), ''::text), '[]'::text))::jsonb) AS jsonb_array_elements_text)))) AND valopay_runtime_admin())" },
  "valopay_staff_invitations:valopay_runtime_scope:SELECT": { using: "((workspace_id = valopay_runtime_workspace()) AND (valopay_runtime_admin() OR ((token_hash = NULLIF(current_setting('valopay.runtime_invite'::text, true), ''::text)) AND (email IN ( SELECT jsonb_array_elements_text((COALESCE(NULLIF(current_setting('valopay.runtime_emails'::text, true), ''::text), '[]'::text))::jsonb) AS jsonb_array_elements_text)))))", check: null },
  "valopay_staff_invitations:valopay_runtime_update:UPDATE": { using: "((workspace_id = valopay_runtime_workspace()) AND (valopay_runtime_admin() OR ((token_hash = NULLIF(current_setting('valopay.runtime_invite'::text, true), ''::text)) AND (email IN ( SELECT jsonb_array_elements_text((COALESCE(NULLIF(current_setting('valopay.runtime_emails'::text, true), ''::text), '[]'::text))::jsonb) AS jsonb_array_elements_text)))))", check: "((workspace_id = valopay_runtime_workspace()) AND (valopay_runtime_admin() OR ((token_hash = NULLIF(current_setting('valopay.runtime_invite'::text, true), ''::text)) AND (email IN ( SELECT jsonb_array_elements_text((COALESCE(NULLIF(current_setting('valopay.runtime_emails'::text, true), ''::text), '[]'::text))::jsonb) AS jsonb_array_elements_text)))))" },
  "valopay_staff_lender_access:valopay_runtime_delete:DELETE": { using: "(valopay_runtime_member(membership_id) AND valopay_runtime_lender(merchant_id) AND valopay_runtime_admin())", check: null },
  "valopay_staff_lender_access:valopay_runtime_insert:INSERT": { using: null, check: "(valopay_runtime_member(membership_id) AND valopay_runtime_lender(merchant_id) AND valopay_runtime_admin())" },
  "valopay_staff_lender_access:valopay_runtime_scope:SELECT": { using: "(valopay_runtime_member(membership_id) AND valopay_runtime_lender(merchant_id))", check: null },
  "valopay_staff_memberships:valopay_runtime_insert:INSERT": { using: null, check: "((workspace_id = valopay_runtime_workspace()) AND (valopay_runtime_admin() OR ((status = 'active'::text) AND valopay_runtime_invited(user_id, role, expires_at))))" },
  "valopay_staff_memberships:valopay_runtime_scope:SELECT": { using: "(workspace_id = valopay_runtime_workspace())", check: null },
  "valopay_staff_memberships:valopay_runtime_update:UPDATE": { using: "((workspace_id = valopay_runtime_workspace()) AND (valopay_runtime_admin() OR (user_id = NULLIF(current_setting('valopay.runtime_user'::text, true), ''::text))))", check: "((workspace_id = valopay_runtime_workspace()) AND (valopay_runtime_admin() OR ((status = 'active'::text) AND valopay_runtime_invited(user_id, role, expires_at))))" },
  "valopay_teams:valopay_runtime_scope:ALL": { using: "(workspace_id = valopay_runtime_workspace())", check: "(workspace_id = valopay_runtime_workspace())" },
  "valopay_workspaces:valopay_runtime_scope:ALL": { using: "(id = valopay_runtime_workspace())", check: "(id = valopay_runtime_workspace())" },
};
/** The SECURITY DEFINER helpers, by name: identity arguments, result, volatility, language and body. */
export const reviewedRuntimeHelpers: Readonly<Record<string, ReviewedHelper>> = {
  valopay_runtime_admin: { args: "", result: "boolean", volatility: "s", language: "sql", source: "SELECT EXISTS(SELECT 1 FROM valopay_staff_memberships member WHERE member.workspace_id=valopay_runtime_workspace() AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),'') AND member.role='Admin' AND member.status='active' AND member.expires_at>statement_timestamp())" },
  valopay_runtime_clear_invitee_grants: { args: "", result: "void", volatility: "v", language: "plpgsql", source: "BEGIN IF NOT EXISTS(SELECT 1 FROM valopay_staff_invitations invitation WHERE invitation.workspace_id=valopay_runtime_workspace() AND invitation.token_hash=NULLIF(current_setting('valopay.runtime_invite',true),'') AND invitation.status='pending' AND invitation.expires_at>statement_timestamp() AND invitation.email IN(SELECT jsonb_array_elements_text(COALESCE(NULLIF(current_setting('valopay.runtime_emails',true),''),'[]')::jsonb))) THEN RAISE EXCEPTION 'A valid verified-email invitation is required to clear prior lender grants.'; END IF; DELETE FROM valopay_staff_lender_access grant_row USING valopay_staff_memberships member WHERE grant_row.membership_id=member.id AND member.workspace_id=valopay_runtime_workspace() AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),''); END;" },
  valopay_runtime_guard_workspace: { args: "", result: "trigger", volatility: "v", language: "plpgsql", source: "BEGIN IF session_user='{role}' THEN RAISE EXCEPTION 'The runtime role reads and locks workspace rows; it never changes them. Staff roles come from memberships.' USING ERRCODE='42501'; END IF; RETURN NEW; END;" },
  valopay_runtime_invited: { args: "invitee_user text, invited_role text, membership_expiry timestamp with time zone", result: "boolean", volatility: "s", language: "sql", source: "SELECT invitee_user=NULLIF(current_setting('valopay.runtime_user',true),'') AND membership_expiry>statement_timestamp() AND membership_expiry<=statement_timestamp()+interval '90 days' AND EXISTS(SELECT 1 FROM valopay_staff_invitations invitation WHERE invitation.workspace_id=valopay_runtime_workspace() AND invitation.token_hash=NULLIF(current_setting('valopay.runtime_invite',true),'') AND invitation.role=invited_role AND invitation.status='pending' AND invitation.expires_at>statement_timestamp() AND invitation.email IN(SELECT jsonb_array_elements_text(COALESCE(NULLIF(current_setting('valopay.runtime_emails',true),''),'[]')::jsonb)))" },
  valopay_runtime_lender: { args: "lender_id text", result: "boolean", volatility: "s", language: "sql", source: "SELECT EXISTS(SELECT 1 FROM valopay_merchants lender WHERE lender.id=lender_id AND lender.workspace_id=valopay_runtime_workspace() AND (valopay_runtime_admin() OR EXISTS(SELECT 1 FROM valopay_staff_memberships member JOIN valopay_staff_lender_access grant_row ON grant_row.membership_id=member.id WHERE member.workspace_id=lender.workspace_id AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),'') AND member.status='active' AND member.expires_at>statement_timestamp() AND grant_row.merchant_id=lender.id)))" },
  valopay_runtime_lenders: { args: "", result: "SETOF text", volatility: "s", language: "sql", source: "SELECT lender.id FROM valopay_merchants lender WHERE lender.workspace_id=valopay_runtime_workspace() AND (valopay_runtime_admin() OR EXISTS(SELECT 1 FROM valopay_staff_memberships member JOIN valopay_staff_lender_access grant_row ON grant_row.membership_id=member.id WHERE member.workspace_id=lender.workspace_id AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),'') AND member.status='active' AND member.expires_at>statement_timestamp() AND grant_row.merchant_id=lender.id))" },
  valopay_runtime_member: { args: "member_id text", result: "boolean", volatility: "s", language: "sql", source: "SELECT EXISTS(SELECT 1 FROM valopay_staff_memberships member WHERE member.id=member_id AND member.workspace_id=valopay_runtime_workspace())" },
  valopay_runtime_workspace: { args: "", result: "text", volatility: "s", language: "sql", source: "SELECT team.workspace_id FROM valopay_teams team WHERE team.organization_id=NULLIF(current_setting('valopay.runtime_org',true),'') AND (EXISTS(SELECT 1 FROM valopay_staff_memberships member WHERE member.workspace_id=team.workspace_id AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),'') AND member.status='active' AND member.expires_at>statement_timestamp()) OR EXISTS(SELECT 1 FROM valopay_staff_invitations invitation WHERE invitation.workspace_id=team.workspace_id AND invitation.token_hash=NULLIF(current_setting('valopay.runtime_invite',true),'') AND invitation.status='pending' AND invitation.expires_at>statement_timestamp() AND invitation.email IN(SELECT jsonb_array_elements_text(COALESCE(NULLIF(current_setting('valopay.runtime_emails',true),''),'[]')::jsonb))))" },
  valopay_runtime_writer: { args: "", result: "boolean", volatility: "s", language: "sql", source: "SELECT EXISTS(SELECT 1 FROM valopay_staff_memberships member WHERE member.workspace_id=valopay_runtime_workspace() AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),'') AND member.role IN('Admin','Operations','Finance','Compliance reviewer') AND member.status='active' AND member.expires_at>statement_timestamp())" },
};
/**
 * Every privilege 005 grants the runtime login on a relation, and no others:
 * `table:PRIVILEGE` on a whole table, `table.column:PRIVILEGE` on one column.
 * The login holds nothing else on any relation in any schema, directly or
 * through PUBLIC, and is a member of no role, so these are all it can do with
 * data; a view, a sequence or another table beside the ten is refused too.
 */
export const reviewedRuntimeGrants: readonly string[] = [
  "valopay_idempotency.response:UPDATE", "valopay_idempotency:INSERT", "valopay_idempotency:SELECT",
  "valopay_merchants.info:UPDATE", "valopay_merchants.settings:UPDATE", "valopay_merchants:INSERT", "valopay_merchants:SELECT",
  "valopay_operations.receipt:UPDATE", "valopay_operations.request:UPDATE", "valopay_operations.status:UPDATE", "valopay_operations.updated_at:UPDATE", "valopay_operations:INSERT", "valopay_operations:SELECT",
  "valopay_records.amount_kobo:UPDATE", "valopay_records.customer_id:UPDATE", "valopay_records.data:UPDATE", "valopay_records.name:UPDATE", "valopay_records.reference:UPDATE", "valopay_records.status:UPDATE", "valopay_records.updated_at:UPDATE", "valopay_records:INSERT", "valopay_records:SELECT",
  "valopay_staff_events:INSERT", "valopay_staff_events:SELECT",
  "valopay_staff_invitations.status:UPDATE", "valopay_staff_invitations:INSERT", "valopay_staff_invitations:SELECT",
  "valopay_staff_lender_access:DELETE", "valopay_staff_lender_access:INSERT", "valopay_staff_lender_access:SELECT",
  "valopay_staff_memberships.display_name:UPDATE", "valopay_staff_memberships.expires_at:UPDATE", "valopay_staff_memberships.role:UPDATE", "valopay_staff_memberships.status:UPDATE", "valopay_staff_memberships.updated_at:UPDATE", "valopay_staff_memberships:INSERT", "valopay_staff_memberships:SELECT",
  "valopay_teams:SELECT",
  "valopay_workspaces.role:UPDATE", "valopay_workspaces:SELECT",
];
/** The one non-internal trigger on the ten tables, as pg_get_triggerdef writes it. It must also be enabled. */
export const reviewedRuntimeTrigger = { name: "valopay_runtime_workspace_guard", table: "valopay_workspaces", definition: "CREATE TRIGGER valopay_runtime_workspace_guard BEFORE UPDATE ON valopay_workspaces FOR EACH ROW EXECUTE FUNCTION valopay_runtime_guard_workspace()" } as const;
/** The PostgreSQL major version whose rendering of the expressions is recorded above. */
export const reviewedRuntimeServerMajor = 16;

export type RuntimePolicyRow = { tablename: string; policyname: string; cmd: string; permissive: string; roles: string[]; qual: string | null; with_check: string | null };
export type RuntimeHelperRow = { proname: string; args: string; result: string; volatility: string; language: string; source: string; safe: boolean };
export type RuntimeTriggerRow = { tgname: string; relname: string; definition: string; tgenabled: string };
/** The connection as it reads itself: its roles, the attributes either holds that bypass or administer security, the roles it is a member of, and whether it can create objects in the runtime schema. */
export type RuntimeRoleRow = { current_name: string; session_name: string; attributes: string[]; memberships: string[]; creates: boolean };
/** One privilege the runtime login holds on a relation, directly or through PUBLIC, as the relation's or the column's access list records it. */
export type RuntimeGrantRow = { schema: string; relation: string; column: string | null; privilege: string; grantable: boolean };
/** An object in the runtime schema beyond the reviewed set: a relation that is neither one of the ten tables nor one of their indexes (kind as pg_class writes it), or a function that is not a reviewed helper (kind "function"). */
export type RuntimeObjectRow = { name: string; kind: string };
type Scope = { schema: string; role: string };

/**
 * Each way the connection differs from the runtime login 005 creates: another
 * role; an attribute that bypasses or administers row security or streams
 * every change (SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB, REPLICATION); a
 * membership of any role, such as pg_execute_server_program or
 * pg_read_all_data, whose privileges it could take up; or CREATE on the
 * runtime schema.
 */
export function runtimeRoleDifferences(row: RuntimeRoleRow, scope: Scope): string[] {
  const out: string[] = [];
  if (row.current_name !== scope.role || row.session_name !== scope.role) out.push(`connected as ${row.session_name} (current role ${row.current_name}) instead of the runtime login`);
  for (const attribute of row.attributes) out.push(`the login holds ${attribute}`);
  for (const role of row.memberships) out.push(`the login is a member of ${role}`);
  if (row.creates) out.push("the login can create objects in the runtime schema");
  return out.sort();
}

const objectKinds: Readonly<Record<string, string>> = { r: "table", p: "partitioned table", v: "view", m: "materialized view", f: "foreign table", S: "sequence", c: "composite type", i: "index", I: "partitioned index", function: "function" };
/**
 * Each way the runtime login's privileges, and the objects in the runtime
 * schema, differ from the reviewed set. A privilege on a relation in the
 * runtime schema is named without the qualifier, one anywhere else with its
 * schema, so a grant on another schema's copy of a table never passes for the
 * reviewed one.
 */
export function runtimeGrantDifferences(grants: RuntimeGrantRow[], extras: RuntimeObjectRow[], scope: Scope): string[] {
  const out: string[] = [], reviewed = new Set(reviewedRuntimeGrants);
  const held = new Set(grants.map(row => `${row.schema === scope.schema ? "" : `${row.schema}.`}${row.relation}${row.column === null ? "" : `.${row.column}`}:${row.privilege}${row.grantable ? " with grant option" : ""}`));
  for (const key of held) if (!reviewed.has(key)) out.push(`${key}: not in the reviewed set`);
  for (const key of reviewed) if (!held.has(key)) out.push(`${key}: missing`);
  for (const row of extras) out.push(`${row.name}: a ${objectKinds[row.kind] ?? "relation"} the reviewed set does not have`);
  return out.sort();
}

/** Puts a live definition in the reviewed form. The runtime schema's qualifier is removed
 * only in front of a valopay_ name: such a name resolves to the same table or helper
 * through the fixed search paths, while a qualified name that shadows a built-in, or
 * any other schema's qualifier, stays and differs. Runs of white space become one
 * space; nothing else changes, so the guard keeps the role literal it tests. */
export function normaliseRuntimeDefinition(text: string | null, scope: Scope): string | null {
  if (text === null) return null;
  // The schema matches a strict pattern (runtimeIsolationConfiguration), so it needs no escaping.
  return text.replace(new RegExp(`(?<![A-Za-z0-9_$".])(?:"${scope.schema}"|${scope.schema})\\.(?=valopay_)`, "g"), "")
    .replace(/\s+/g, " ").trim();
}

const rolePlaceholder = "{role}";
/** A reviewed definition as 005 writes it for this runtime login: {role} spelt out
 * (the role matches a strict pattern, so %2$L quotes it as written). */
export function expectedRuntimeDefinition(text: string | null, scope: Scope): string | null {
  return text === null ? null : text.split(rolePlaceholder).join(scope.role);
}

/** Whether a live definition differs from the reviewed one. Live text that holds the
 * placeholder always differs: a guard that compares session_user with '{role}' never fires. */
function differs(live: string | null, reviewed: string | null, scope: Scope) {
  return Boolean(live?.includes(rolePlaceholder)) || normaliseRuntimeDefinition(live, scope) !== expectedRuntimeDefinition(reviewed, scope);
}

/** Each way the helpers differ from the reviewed set, in words an operator can act on. */
export function runtimeHelperDifferences(rows: RuntimeHelperRow[], scope: Scope): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const row of rows) {
    const want = reviewedRuntimeHelpers[row.proname];
    if (!want) { out.push(`${row.proname}: not a reviewed helper`); continue; }
    if (seen.has(row.proname)) { out.push(`${row.proname}(${row.args}): an unreviewed overload`); continue; }
    seen.add(row.proname);
    if (!row.safe) out.push(`${row.proname}: owner, security or fixed search path differs`);
    if (row.args !== want.args || row.result !== want.result || row.volatility !== want.volatility || row.language !== want.language) out.push(`${row.proname}: signature differs`);
    if (differs(row.source, want.source, scope)) out.push(`${row.proname}: body differs`);
  }
  for (const name of Object.keys(reviewedRuntimeHelpers)) if (!seen.has(name)) out.push(`${name}: missing`);
  return out.sort();
}

/** Each way the policies and the workspace guard differ from the reviewed set. */
export function runtimePolicyDifferences(policies: RuntimePolicyRow[], triggers: RuntimeTriggerRow[], scope: Scope): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const row of policies) {
    const key = `${row.tablename}:${row.policyname}:${row.cmd}`, want = reviewedRuntimePolicies[key];
    if (!want) { out.push(`${key}: not in the reviewed set`); continue; }
    if (seen.has(key)) { out.push(`${key}: duplicated`); continue; }
    seen.add(key);
    if (row.permissive !== "PERMISSIVE") out.push(`${key}: ${String(row.permissive).toLowerCase()} instead of permissive`);
    if (row.roles.length !== 1 || row.roles[0] !== scope.role) out.push(`${key}: applies to ${row.roles.join(", ") || "no role"} instead of the runtime login`);
    if (differs(row.qual, want.using, scope)) out.push(`${key}: USING expression differs`);
    if (differs(row.with_check, want.check, scope)) out.push(`${key}: WITH CHECK expression differs`);
  }
  for (const key of Object.keys(reviewedRuntimePolicies)) if (!seen.has(key)) out.push(`${key}: missing`);
  // The definition covers timing, event, columns, WHEN condition, function and arguments.
  const guard = reviewedRuntimeTrigger; let guarded = false;
  for (const row of triggers) {
    if (row.relname !== guard.table || row.tgname !== guard.name) { out.push(`${row.relname}.${row.tgname}: an unreviewed trigger`); continue; }
    guarded = true;
    // O fires in ordinary sessions and A in every session; D never fires and R only on a replica.
    if (row.tgenabled !== "O" && row.tgenabled !== "A") out.push(`${guard.name}: disabled (state ${row.tgenabled})`);
    if (differs(row.definition, guard.definition, scope)) out.push(`${guard.name}: definition differs`);
  }
  if (!guarded) out.push(`${guard.name}: missing`);
  return out.sort();
}
