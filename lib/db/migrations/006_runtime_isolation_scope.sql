-- Explicit commissioning only, after 005_runtime_isolation.sql, in the same
-- valopay_runtime_staging_* or valopay_runtime_test_* schema. Run with the
-- migration owner, never the app login, with valopay.runtime_migration set to
-- staging-only as for 005.
--
-- 005 checks each row's lender by calling a SECURITY DEFINER helper for every
-- row. PostgreSQL cannot inline such a function, so it and its nested lookups
-- ran once per scanned row: loading a 13,000-record lender took about ten
-- seconds, and the export claim hit its five-second statement timeout. This
-- migration keeps the same rules and policy names, but evaluates them once per
-- statement: one set-returning helper lists the lenders the current identity
-- may see, and each row is checked against that list. The role and workspace
-- helpers are wrapped as scalar subqueries for the same reason.
BEGIN;
DO $migration$
DECLARE
 target_schema text := current_schema();
 app_role text;
 helper_role text;
 table_name text;
 scope_expression text;
 write_check text;
BEGIN
 IF current_setting('valopay.runtime_migration',true) IS DISTINCT FROM 'staging-only'
   OR target_schema IS NULL OR target_schema !~ '^valopay_runtime_(staging|test)_[a-z0-9_]+$' THEN
   RAISE EXCEPTION 'Runtime isolation requires explicit commissioning in a separate runtime schema; public is refused.';
 END IF;
 -- The roles are the ones 005 created: the NOLOGIN helper owns the scope
 -- helpers, and the restricted login is the only role the policies name.
 SELECT r.rolname INTO helper_role FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
   WHERE n.nspname=target_schema AND p.proname='valopay_runtime_lender';
 SELECT policy.roles[1] INTO app_role FROM pg_policies policy
   WHERE policy.schemaname=target_schema AND policy.tablename='valopay_records' AND policy.policyname='valopay_runtime_scope' AND cardinality(policy.roles)=1;
 IF helper_role IS NULL OR app_role IS NULL THEN RAISE EXCEPTION 'Apply 005_runtime_isolation.sql to this schema first.'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=helper_role AND (rolcanlogin OR rolsuper OR NOT rolbypassrls)) THEN RAISE EXCEPTION 'The scope helper owner is not the NOLOGIN helper 005 created.'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=target_schema AND p.proname='valopay_runtime_lenders') THEN
   RAISE EXCEPTION 'This schema already evaluates lender scope once per statement.';
 END IF;
 EXECUTE format('GRANT CREATE ON SCHEMA %I TO %I',target_schema,helper_role);
 -- The same rule as valopay_runtime_lender(lender_id), as a set: a lender of
 -- the identity's workspace, to an administrator or through an explicit grant.
 EXECUTE format($fn$
 CREATE FUNCTION %1$I.valopay_runtime_lenders() RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = pg_catalog,%1$I,pg_temp AS $body$
 SELECT lender.id FROM %1$I.valopay_merchants lender
 WHERE lender.workspace_id=%1$I.valopay_runtime_workspace()
 AND (%1$I.valopay_runtime_admin() OR EXISTS(SELECT 1 FROM %1$I.valopay_staff_memberships member JOIN %1$I.valopay_staff_lender_access grant_row ON grant_row.membership_id=member.id WHERE member.workspace_id=lender.workspace_id AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),'') AND member.status='active' AND member.expires_at>statement_timestamp() AND grant_row.merchant_id=lender.id))
 $body$
 $fn$,target_schema);
 EXECUTE format('ALTER FUNCTION %I.valopay_runtime_lenders() OWNER TO %I',target_schema,helper_role);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.valopay_runtime_lenders() FROM PUBLIC',target_schema);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.valopay_runtime_lenders() TO %I',target_schema,app_role);
 EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I',target_schema,helper_role);
 FOREACH table_name IN ARRAY ARRAY['valopay_merchants','valopay_records','valopay_idempotency','valopay_operations'] LOOP
   scope_expression := CASE table_name
     -- An administrator may add a lender, which no lender list contains yet.
     WHEN 'valopay_merchants' THEN format('workspace_id=(SELECT %1$I.valopay_runtime_workspace()) AND ((SELECT %1$I.valopay_runtime_admin()) OR id IN(SELECT %1$I.valopay_runtime_lenders()))',target_schema)
     ELSE format('merchant_id IN(SELECT %I.valopay_runtime_lenders())',target_schema)
   END;
   EXECUTE format('DROP POLICY valopay_runtime_scope ON %I.%I',target_schema,table_name);
   EXECUTE format('DROP POLICY valopay_runtime_insert ON %I.%I',target_schema,table_name);
   EXECUTE format('DROP POLICY valopay_runtime_update ON %I.%I',target_schema,table_name);
   EXECUTE format('CREATE POLICY valopay_runtime_scope ON %I.%I FOR SELECT TO %I USING(%s)',target_schema,table_name,app_role,scope_expression);
   write_check := format('(SELECT %I.%I())',target_schema,CASE WHEN table_name='valopay_merchants' THEN 'valopay_runtime_admin' ELSE 'valopay_runtime_writer' END);
   EXECUTE format('CREATE POLICY valopay_runtime_insert ON %I.%I FOR INSERT TO %I WITH CHECK((%s) AND %s)',target_schema,table_name,app_role,scope_expression,write_check);
   write_check := format('(SELECT %I.%I())',target_schema,CASE WHEN table_name='valopay_idempotency' THEN 'valopay_runtime_admin' ELSE 'valopay_runtime_writer' END);
   EXECUTE format('CREATE POLICY valopay_runtime_update ON %I.%I FOR UPDATE TO %I USING((%s) AND %s) WITH CHECK((%s) AND %s)',target_schema,table_name,app_role,scope_expression,write_check,scope_expression,write_check);
 END LOOP;
END;
$migration$;
SELECT set_config('valopay.runtime_migration','',false);
COMMIT;
