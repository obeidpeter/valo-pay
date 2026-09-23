import assert from "node:assert/strict";
import { expectedRuntimeDefinition, normaliseRuntimeDefinition, reviewedRuntimeHelpers, reviewedRuntimePolicies, reviewedRuntimeTrigger, runtimeHelperDifferences, runtimePolicyDifferences, type RuntimeHelperRow, type RuntimePolicyRow, type RuntimeTriggerRow } from "../src/lib/runtime-isolation-policy.js";

// The comparison the isolation self-check runs in every staff transaction,
// without a database: rows shaped as the restricted login reads the catalogue.
// The live rendering is pinned by runtime-isolation.integration.test.ts.
let checks = 0;
const scope = { schema: "valopay_runtime_staging_pilot", role: "lender" }; // a role name that is also an alias in the helper bodies
const live = (text: string | null) => text?.replaceAll("{role}", scope.role) ?? null;
// Helper bodies are stored as written: every table and helper qualified with the schema, over several lines.
const qualify = (text: string) => text.replace(/(?<![.\w])(valopay_(?:staff_memberships|staff_invitations|staff_lender_access|merchants|teams)|valopay_runtime_\w+\()/g, `${scope.schema}.$1`);
const policies = (): RuntimePolicyRow[] => Object.entries(reviewedRuntimePolicies).map(([key, want]) => { const [tablename, policyname, cmd] = key.split(":") as [string, string, string]; return { tablename, policyname, cmd, permissive: "PERMISSIVE", roles: [scope.role], qual: live(want.using), with_check: live(want.check) }; });
const helpers = (): RuntimeHelperRow[] => Object.entries(reviewedRuntimeHelpers).map(([proname, want]) => ({ proname, args: want.args, result: want.result, volatility: want.volatility, language: want.language, source: `\n ${qualify(live(want.source)!).replaceAll(" AND ", "\n AND ")}\n `, safe: true }));
// pg_get_triggerdef always qualifies the table.
const guardDefinition = reviewedRuntimeTrigger.definition.replace(" ON valopay_workspaces ", ` ON ${scope.schema}.valopay_workspaces `);
const guard: RuntimeTriggerRow[] = [{ tgname: reviewedRuntimeTrigger.name, relname: reviewedRuntimeTrigger.table, definition: guardDefinition, tgenabled: "O" }];
const eq = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };

eq(Object.keys(reviewedRuntimePolicies).length, 25, "ten tables carry 25 reviewed policies");
eq(Object.keys(reviewedRuntimeHelpers).length, 9, "nine reviewed helpers");
eq(runtimePolicyDifferences(policies(), guard, scope), [], "the reviewed set, as the runtime login reads it, passes");
eq(runtimeHelperDifferences(helpers(), scope), [], "helper bodies pass whatever their line breaks, with the schema and role substituted");
eq(runtimePolicyDifferences(policies(), [{ ...guard[0]!, tgenabled: "A" }], scope), [], "a guard that also fires on replicas passes");

// Policies: what each one does, not only its name.
const merchantsScope = "valopay_merchants:valopay_runtime_scope:SELECT", recordsInsert = "valopay_records:valopay_runtime_insert:INSERT";
const edit = (key: string, patch: Partial<RuntimePolicyRow>) => policies().map(row => `${row.tablename}:${row.policyname}:${row.cmd}` === key ? { ...row, ...patch } : row);
eq(runtimePolicyDifferences(edit(merchantsScope, { qual: "true" }), guard, scope), [`${merchantsScope}: USING expression differs`], "USING (true) is refused");
eq(runtimePolicyDifferences(edit(recordsInsert, { with_check: "true" }), guard, scope), [`${recordsInsert}: WITH CHECK expression differs`], "WITH CHECK (true) is refused");
eq(runtimePolicyDifferences(edit(merchantsScope, { roles: ["public"] }), guard, scope), [`${merchantsScope}: applies to public instead of the runtime login`], "a policy widened to PUBLIC is refused");
eq(runtimePolicyDifferences(edit(merchantsScope, { roles: [scope.role, "reporting"] }), guard, scope), [`${merchantsScope}: applies to ${scope.role}, reporting instead of the runtime login`], "a policy shared with another role is refused");
eq(runtimePolicyDifferences(edit(merchantsScope, { permissive: "RESTRICTIVE" }), guard, scope), [`${merchantsScope}: restrictive instead of permissive`], "a restrictive replacement is refused");
eq(runtimePolicyDifferences([...policies(), { ...policies()[0]!, policyname: "open", qual: "true" }], guard, scope), [`${policies()[0]!.tablename}:open:${policies()[0]!.cmd}: not in the reviewed set`], "an extra policy is refused");
eq(runtimePolicyDifferences(policies().filter(row => `${row.tablename}:${row.policyname}:${row.cmd}` !== merchantsScope), guard, scope), [`${merchantsScope}: missing`], "a missing policy is refused");
eq(runtimePolicyDifferences([...policies(), policies()[0]!], guard, scope).length, 1, "a duplicated policy is refused");
const scoped = live(reviewedRuntimePolicies[merchantsScope]!.using)!;
eq(runtimePolicyDifferences(edit(merchantsScope, { qual: scoped.replace(/valopay_runtime_(\w+)\(\)/g, `"${scope.schema}".valopay_runtime_$1()`) }), guard, scope), [], "a rendering that qualifies the runtime schema's own helpers passes");
eq(runtimePolicyDifferences(edit(merchantsScope, { qual: scoped.replaceAll("valopay_runtime_lenders()", "public.valopay_runtime_lenders()") }), guard, scope), [`${merchantsScope}: USING expression differs`], "a helper from another schema is refused");
eq(runtimePolicyDifferences(edit(merchantsScope, { qual: scoped.replaceAll("valopay_runtime_lenders()", `x${scope.schema}.valopay_runtime_lenders()`) }), guard, scope), [`${merchantsScope}: USING expression differs`], "a schema whose name ends with the runtime schema's is not the runtime schema");
// Read with pg_catalog first, a function in the runtime schema that shadows a built-in renders qualified; it must not be taken for the built-in.
const eventsInsert = "valopay_staff_events:valopay_runtime_insert:INSERT", eventsCheck = live(reviewedRuntimePolicies[eventsInsert]!.check)!;
eq(runtimePolicyDifferences(edit(eventsInsert, { with_check: eventsCheck.replace("current_setting(", `${scope.schema}.current_setting(`) }), guard, scope), [`${eventsInsert}: WITH CHECK expression differs`], "a runtime-schema function shadowing a built-in is refused");

// The workspace guard: present, enabled, unchanged and alone.
const trigger = (patch: Partial<RuntimeTriggerRow>) => [{ ...guard[0]!, ...patch }];
eq(runtimePolicyDifferences(policies(), trigger({ tgenabled: "D" }), scope), ["valopay_runtime_workspace_guard: disabled (state D)"], "a disabled guard is refused");
eq(runtimePolicyDifferences(policies(), trigger({ tgenabled: "R" }), scope), ["valopay_runtime_workspace_guard: disabled (state R)"], "a guard that fires only on replicas is refused");
eq(runtimePolicyDifferences(policies(), [], scope), ["valopay_runtime_workspace_guard: missing"], "a missing guard is refused");
eq(runtimePolicyDifferences(policies(), trigger({ definition: guardDefinition.replace("BEFORE UPDATE ON", "BEFORE UPDATE OF principal_hash ON") }), scope), ["valopay_runtime_workspace_guard: definition differs"], "a guard narrowed to one column is refused");
eq(runtimePolicyDifferences(policies(), trigger({ definition: guardDefinition.replace("FOR EACH ROW", "FOR EACH ROW WHEN (false)") }), scope), ["valopay_runtime_workspace_guard: definition differs"], "a guard that never fires is refused");
eq(runtimePolicyDifferences(policies(), trigger({ definition: guardDefinition.replace("EXECUTE FUNCTION ", "EXECUTE FUNCTION public.") }), scope), ["valopay_runtime_workspace_guard: definition differs"], "a guard calling another schema's function is refused");
eq(runtimePolicyDifferences(policies(), [...guard, { ...guard[0]!, tgname: "extra", relname: "valopay_records" }], scope), ["valopay_records.extra: an unreviewed trigger"], "an unreviewed trigger is refused");

// Helpers: owner and configuration, signature and body.
const helper = (name: string, patch: Partial<RuntimeHelperRow>) => helpers().map(row => row.proname === name ? { ...row, ...patch } : row);
eq(runtimeHelperDifferences(helper("valopay_runtime_lenders", { source: `SELECT id FROM ${scope.schema}.valopay_merchants` }), scope), ["valopay_runtime_lenders: body differs"], "a replaced helper body is refused");
eq(runtimeHelperDifferences(helper("valopay_runtime_writer", { source: live(reviewedRuntimeHelpers.valopay_runtime_writer!.source)!.replace("current_setting(", `${scope.schema}.current_setting(`) }), scope), ["valopay_runtime_writer: body differs"], "a helper calling a runtime-schema function in place of a built-in is refused");
eq(runtimeHelperDifferences(helper("valopay_runtime_admin", { safe: false }), scope), ["valopay_runtime_admin: owner, security or fixed search path differs"], "an unsafe owner stays refused");
eq(runtimeHelperDifferences(helper("valopay_runtime_lender", { volatility: "v" }), scope), ["valopay_runtime_lender: signature differs"], "a changed volatility is refused");
eq(runtimeHelperDifferences(helper("valopay_runtime_member", { args: "member_id character varying" }), scope), ["valopay_runtime_member: signature differs"], "changed arguments are refused");
eq(runtimeHelperDifferences([...helpers(), { ...helpers()[0]!, args: "extra integer" }], scope), [`${helpers()[0]!.proname}(extra integer): an unreviewed overload`], "an overload is refused");
eq(runtimeHelperDifferences(helpers().filter(row => row.proname !== "valopay_runtime_guard_workspace"), scope), ["valopay_runtime_guard_workspace: missing"], "a missing helper is refused");
eq(runtimeHelperDifferences(helper("valopay_runtime_guard_workspace", { source: live(reviewedRuntimeHelpers.valopay_runtime_guard_workspace!.source)!.replace(`'${scope.role}'`, "'someone_else'") }), scope), ["valopay_runtime_guard_workspace: body differs"], "a guard that watches another login is refused");
// The placeholder is spelt out in the reviewed text, never put into the live text: a guard that
// compares session_user with the string '{role}' never fires, so it must not read as the reviewed guard.
eq(runtimeHelperDifferences(helper("valopay_runtime_guard_workspace", { source: qualify(reviewedRuntimeHelpers.valopay_runtime_guard_workspace!.source) }), scope), ["valopay_runtime_guard_workspace: body differs"], "a guard that watches the placeholder instead of the login is refused");
// Even a login named after the placeholder, which the configuration refuses, would not make such a guard pass.
eq(runtimeHelperDifferences(helper("valopay_runtime_guard_workspace", { source: qualify(reviewedRuntimeHelpers.valopay_runtime_guard_workspace!.source) }), { ...scope, role: "{role}" }), ["valopay_runtime_guard_workspace: body differs"], "live text holding the placeholder is refused whatever the login is called");

// Normalisation: only the runtime schema's qualifier and white space; {role} is spelt out in the reviewed text alone.
eq(normaliseRuntimeDefinition(null, scope), null, "an absent expression stays absent");
eq(normaliseRuntimeDefinition(`BEGIN IF session_user='${scope.role}' THEN RAISE EXCEPTION 'x'; END IF; END;`, scope), `BEGIN IF session_user='${scope.role}' THEN RAISE EXCEPTION 'x'; END IF; END;`, "the guard's role literal is kept as written");
eq(normaliseRuntimeDefinition("BEGIN IF session_user='{role}' THEN RETURN NULL; END IF; END;", scope), "BEGIN IF session_user='{role}' THEN RETURN NULL; END IF; END;", "a live placeholder stays a placeholder");
eq(expectedRuntimeDefinition(reviewedRuntimeHelpers.valopay_runtime_guard_workspace!.source, scope)!.startsWith(`BEGIN IF session_user='${scope.role}' THEN`), true, "the reviewed guard names the runtime login, as 005 writes it");
eq(expectedRuntimeDefinition(null, scope), null, "an absent reviewed expression stays absent");
eq(normaliseRuntimeDefinition(`SELECT ${scope.role}.id FROM ${scope.schema}.valopay_merchants ${scope.role}`, scope), `SELECT ${scope.role}.id FROM valopay_merchants ${scope.role}`, "an alias named like the role is kept");
eq(normaliseRuntimeDefinition(`SELECT ${scope.schema}.now(), "${scope.schema}".valopay_runtime_admin()`, scope), `SELECT ${scope.schema}.now(), valopay_runtime_admin()`, "the qualifier is removed only in front of the reviewed objects' names");
console.log(`Runtime isolation fingerprint checks passed (${checks}).`);
