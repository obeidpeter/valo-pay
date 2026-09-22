-- Explicit commissioning only. Run with the migration owner, never the app
-- login. This refuses public and existing policies. The ten tables must already
-- exist in a separate valopay_runtime_staging_* or valopay_runtime_test_* schema.
-- Set valopay.runtime_migration=staging-only, valopay.runtime_app_role to a NEW
-- restricted login name and valopay.runtime_helper_role to a NEW NOLOGIN name.
-- Password/connection provisioning is a separate operator step; no credentials
-- are embedded in this migration or accepted through the application API.
BEGIN;
DO $migration$
DECLARE
 target_schema text := current_schema();
 app_role text := current_setting('valopay.runtime_app_role',true);
 helper_role text := current_setting('valopay.runtime_helper_role',true);
 table_name text;
 scope_expression text;
 tables text[] := ARRAY['valopay_workspaces','valopay_merchants','valopay_records','valopay_idempotency','valopay_operations','valopay_teams','valopay_staff_memberships','valopay_staff_invitations','valopay_staff_events','valopay_staff_lender_access'];
BEGIN
 IF current_setting('valopay.runtime_migration',true) IS DISTINCT FROM 'staging-only'
   OR target_schema IS NULL OR target_schema !~ '^valopay_runtime_(staging|test)_[a-z0-9_]+$' THEN
   RAISE EXCEPTION 'Runtime isolation requires explicit commissioning in a separate runtime schema; public is refused.';
 END IF;
 IF app_role IS NULL OR helper_role IS NULL OR app_role !~ '^[a-z][a-z0-9_]{2,62}$' OR helper_role !~ '^[a-z][a-z0-9_]{2,62}$' OR app_role=helper_role THEN RAISE EXCEPTION 'Provide two distinct restricted application/helper role names.'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN(app_role,helper_role)) THEN RAISE EXCEPTION 'Refusing to reuse roles with unknown ownership or grants.'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=target_schema AND tablename=ANY(tables)) THEN RAISE EXCEPTION 'Existing row-security policies need a separately reviewed migration.'; END IF;
 FOREACH table_name IN ARRAY tables LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=target_schema AND c.relname=table_name AND c.relkind='r') THEN RAISE EXCEPTION 'Missing runtime table %.%',target_schema,table_name; END IF;
 END LOOP;
 EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',app_role);
 EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS',helper_role);
 EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC',target_schema);
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I,%I',target_schema,app_role,helper_role);
 EXECUTE format('GRANT CREATE ON SCHEMA %I TO %I',target_schema,helper_role);
 -- Only fixed scope helpers and invitation grant cleanup use the NOLOGIN owner.
 -- The application role is never a member of it and cannot replace functions.
 FOREACH table_name IN ARRAY tables LOOP
   EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC',target_schema,table_name);
   EXECUTE format('GRANT SELECT ON TABLE %I.%I TO %I',target_schema,table_name,helper_role);
 END LOOP;
 EXECUTE format($fn$
 CREATE FUNCTION %1$I.valopay_runtime_workspace() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = pg_catalog,%1$I,pg_temp AS $body$
 SELECT team.workspace_id FROM %1$I.valopay_teams team
 WHERE team.organization_id=NULLIF(current_setting('valopay.runtime_org',true),'')
 AND (EXISTS(SELECT 1 FROM %1$I.valopay_staff_memberships member WHERE member.workspace_id=team.workspace_id AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),'') AND member.status='active' AND member.expires_at>statement_timestamp())
 OR EXISTS(SELECT 1 FROM %1$I.valopay_staff_invitations invitation WHERE invitation.workspace_id=team.workspace_id AND invitation.token_hash=NULLIF(current_setting('valopay.runtime_invite',true),'') AND invitation.status='pending' AND invitation.expires_at>statement_timestamp() AND invitation.email IN(SELECT jsonb_array_elements_text(COALESCE(NULLIF(current_setting('valopay.runtime_emails',true),''),'[]')::jsonb))))
 $body$
 $fn$,target_schema);
 EXECUTE format($fn$
 CREATE FUNCTION %1$I.valopay_runtime_writer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = pg_catalog,%1$I,pg_temp AS $body$
 SELECT EXISTS(SELECT 1 FROM %1$I.valopay_staff_memberships member WHERE member.workspace_id=%1$I.valopay_runtime_workspace() AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),'') AND member.role IN('Admin','Operations','Finance','Compliance reviewer') AND member.status='active' AND member.expires_at>statement_timestamp())
 $body$
 $fn$,target_schema);
 EXECUTE format($fn$
 CREATE FUNCTION %1$I.valopay_runtime_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = pg_catalog,%1$I,pg_temp AS $body$
 SELECT EXISTS(SELECT 1 FROM %1$I.valopay_staff_memberships member WHERE member.workspace_id=%1$I.valopay_runtime_workspace() AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),'') AND member.role='Admin' AND member.status='active' AND member.expires_at>statement_timestamp())
 $body$
 $fn$,target_schema);
 EXECUTE format($fn$
 CREATE FUNCTION %1$I.valopay_runtime_lender(lender_id text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = pg_catalog,%1$I,pg_temp AS $body$
 SELECT EXISTS(SELECT 1 FROM %1$I.valopay_merchants lender WHERE lender.id=lender_id AND lender.workspace_id=%1$I.valopay_runtime_workspace() AND (%1$I.valopay_runtime_admin() OR EXISTS(SELECT 1 FROM %1$I.valopay_staff_memberships member JOIN %1$I.valopay_staff_lender_access grant_row ON grant_row.membership_id=member.id WHERE member.workspace_id=lender.workspace_id AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),'') AND member.status='active' AND member.expires_at>statement_timestamp() AND grant_row.merchant_id=lender.id)))
 $body$
 $fn$,target_schema);
 EXECUTE format($fn$
 CREATE FUNCTION %1$I.valopay_runtime_member(member_id text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = pg_catalog,%1$I,pg_temp AS $body$
 SELECT EXISTS(SELECT 1 FROM %1$I.valopay_staff_memberships member WHERE member.id=member_id AND member.workspace_id=%1$I.valopay_runtime_workspace())
 $body$
 $fn$,target_schema);
 EXECUTE format($fn$
 CREATE FUNCTION %1$I.valopay_runtime_invited(invitee_user text, invited_role text, membership_expiry timestamptz) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = pg_catalog,%1$I,pg_temp AS $body$
 SELECT invitee_user=NULLIF(current_setting('valopay.runtime_user',true),'')
   AND membership_expiry>statement_timestamp() AND membership_expiry<=statement_timestamp()+interval '90 days'
   AND EXISTS(SELECT 1 FROM %1$I.valopay_staff_invitations invitation WHERE invitation.workspace_id=%1$I.valopay_runtime_workspace()
     AND invitation.token_hash=NULLIF(current_setting('valopay.runtime_invite',true),'') AND invitation.role=invited_role
     AND invitation.status='pending' AND invitation.expires_at>statement_timestamp()
     AND invitation.email IN(SELECT jsonb_array_elements_text(COALESCE(NULLIF(current_setting('valopay.runtime_emails',true),''),'[]')::jsonb)))
 $body$
 $fn$,target_schema);
 -- Renewing an expired/revoked membership must remove its former grants. The
 -- invitee has no general DELETE permission: this fixed function can delete
 -- only their own grants under a valid verified-email invitation scope.
 EXECUTE format('GRANT DELETE ON %I.valopay_staff_lender_access TO %I',target_schema,helper_role);
 EXECUTE format($fn$
 CREATE FUNCTION %1$I.valopay_runtime_clear_invitee_grants() RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path = pg_catalog,%1$I,pg_temp AS $body$
 BEGIN
   IF NOT EXISTS(SELECT 1 FROM %1$I.valopay_staff_invitations invitation WHERE invitation.workspace_id=%1$I.valopay_runtime_workspace()
     AND invitation.token_hash=NULLIF(current_setting('valopay.runtime_invite',true),'') AND invitation.status='pending' AND invitation.expires_at>statement_timestamp()
     AND invitation.email IN(SELECT jsonb_array_elements_text(COALESCE(NULLIF(current_setting('valopay.runtime_emails',true),''),'[]')::jsonb))) THEN RAISE EXCEPTION 'A valid verified-email invitation is required to clear prior lender grants.'; END IF;
   DELETE FROM %1$I.valopay_staff_lender_access grant_row USING %1$I.valopay_staff_memberships member
   WHERE grant_row.membership_id=member.id AND member.workspace_id=%1$I.valopay_runtime_workspace() AND member.user_id=NULLIF(current_setting('valopay.runtime_user',true),'');
 END;
 $body$
 $fn$,target_schema);
 FOREACH table_name IN ARRAY ARRAY['valopay_runtime_workspace()','valopay_runtime_admin()','valopay_runtime_writer()','valopay_runtime_lender(text)','valopay_runtime_member(text)','valopay_runtime_invited(text,text,timestamp with time zone)','valopay_runtime_clear_invitee_grants()'] LOOP
   EXECUTE format('ALTER FUNCTION %I.%s OWNER TO %I',target_schema,table_name,helper_role);
   EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',target_schema,table_name);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',target_schema,table_name,app_role);
 END LOOP;
 FOREACH table_name IN ARRAY tables LOOP
   scope_expression := CASE table_name
     WHEN 'valopay_workspaces' THEN format('id=%I.valopay_runtime_workspace()',target_schema)
     WHEN 'valopay_merchants' THEN format('workspace_id=%1$I.valopay_runtime_workspace() AND (%1$I.valopay_runtime_admin() OR %1$I.valopay_runtime_lender(id))',target_schema)
     WHEN 'valopay_records' THEN format('%I.valopay_runtime_lender(merchant_id)',target_schema)
     WHEN 'valopay_idempotency' THEN format('%I.valopay_runtime_lender(merchant_id)',target_schema)
     WHEN 'valopay_operations' THEN format('%I.valopay_runtime_lender(merchant_id)',target_schema)
     WHEN 'valopay_staff_lender_access' THEN format('%1$I.valopay_runtime_member(membership_id) AND %1$I.valopay_runtime_lender(merchant_id)',target_schema)
     WHEN 'valopay_staff_invitations' THEN format('workspace_id=%1$I.valopay_runtime_workspace() AND (%1$I.valopay_runtime_admin() OR token_hash=NULLIF(current_setting(''valopay.runtime_invite'',true),'''') AND email IN(SELECT jsonb_array_elements_text(COALESCE(NULLIF(current_setting(''valopay.runtime_emails'',true),''''),''[]'')::jsonb)))',target_schema)
     ELSE format('workspace_id=%I.valopay_runtime_workspace()',target_schema)
   END;
   EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',target_schema,table_name);
   EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',target_schema,table_name);
   IF table_name=ANY(ARRAY['valopay_staff_memberships','valopay_staff_lender_access','valopay_staff_invitations','valopay_staff_events','valopay_merchants','valopay_records','valopay_idempotency','valopay_operations']) THEN
     EXECUTE format('CREATE POLICY valopay_runtime_scope ON %I.%I FOR SELECT TO %I USING(%s)',target_schema,table_name,app_role,scope_expression);
     IF table_name=ANY(ARRAY['valopay_merchants','valopay_records','valopay_idempotency','valopay_operations']) THEN
       EXECUTE format('CREATE POLICY valopay_runtime_insert ON %1$I.%2$I FOR INSERT TO %3$I WITH CHECK((%4$s) AND %1$I.%5$I())',target_schema,table_name,app_role,scope_expression,CASE WHEN table_name='valopay_merchants' THEN 'valopay_runtime_admin' ELSE 'valopay_runtime_writer' END);
       EXECUTE format('CREATE POLICY valopay_runtime_update ON %1$I.%2$I FOR UPDATE TO %3$I USING((%4$s) AND %1$I.%5$I()) WITH CHECK((%4$s) AND %1$I.%5$I())',target_schema,table_name,app_role,scope_expression,CASE WHEN table_name='valopay_idempotency' THEN 'valopay_runtime_admin' ELSE 'valopay_runtime_writer' END);
     ELSIF table_name='valopay_staff_memberships' THEN
       EXECUTE format('CREATE POLICY valopay_runtime_insert ON %1$I.%2$I FOR INSERT TO %3$I WITH CHECK((%4$s) AND (%1$I.valopay_runtime_admin() OR (status=''active'' AND %1$I.valopay_runtime_invited(user_id,role,expires_at))))',target_schema,table_name,app_role,scope_expression);
       EXECUTE format('CREATE POLICY valopay_runtime_update ON %1$I.%2$I FOR UPDATE TO %3$I USING((%4$s) AND (%1$I.valopay_runtime_admin() OR user_id=NULLIF(current_setting(''valopay.runtime_user'',true),''''))) WITH CHECK((%4$s) AND (%1$I.valopay_runtime_admin() OR (status=''active'' AND %1$I.valopay_runtime_invited(user_id,role,expires_at))))',target_schema,table_name,app_role,scope_expression);
     ELSIF table_name='valopay_staff_lender_access' THEN
       EXECUTE format('CREATE POLICY valopay_runtime_insert ON %1$I.%2$I FOR INSERT TO %3$I WITH CHECK((%4$s) AND %1$I.valopay_runtime_admin())',target_schema,table_name,app_role,scope_expression);
       EXECUTE format('CREATE POLICY valopay_runtime_delete ON %1$I.%2$I FOR DELETE TO %3$I USING((%4$s) AND %1$I.valopay_runtime_admin())',target_schema,table_name,app_role,scope_expression);
     ELSIF table_name='valopay_staff_invitations' THEN
       EXECUTE format('CREATE POLICY valopay_runtime_insert ON %1$I.%2$I FOR INSERT TO %3$I WITH CHECK((%4$s) AND %1$I.valopay_runtime_admin())',target_schema,table_name,app_role,scope_expression);
       EXECUTE format('CREATE POLICY valopay_runtime_update ON %1$I.%2$I FOR UPDATE TO %3$I USING(%4$s) WITH CHECK(%4$s)',target_schema,table_name,app_role,scope_expression);
     ELSE
       EXECUTE format('CREATE POLICY valopay_runtime_insert ON %1$I.%2$I FOR INSERT TO %3$I WITH CHECK((%4$s) AND actor=''Clerk:''||NULLIF(current_setting(''valopay.runtime_user'',true),''''))',target_schema,table_name,app_role,scope_expression);
     END IF;
   ELSE
     EXECUTE format('CREATE POLICY valopay_runtime_scope ON %I.%I TO %I USING(%s) WITH CHECK(%s)',target_schema,table_name,app_role,scope_expression,scope_expression);
   END IF;
   EXECUTE format('GRANT SELECT ON TABLE %I.%I TO %I',target_schema,table_name,app_role);
 END LOOP;
 EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I',target_schema,helper_role);
 EXECUTE format('GRANT UPDATE(role) ON %I.valopay_workspaces TO %I',target_schema,app_role);
 EXECUTE format('GRANT INSERT ON %1$I.valopay_merchants,%1$I.valopay_records,%1$I.valopay_idempotency,%1$I.valopay_operations,%1$I.valopay_staff_memberships,%1$I.valopay_staff_invitations,%1$I.valopay_staff_events,%1$I.valopay_staff_lender_access TO %2$I',target_schema,app_role);
 EXECUTE format('GRANT UPDATE(info,settings) ON %I.valopay_merchants TO %I',target_schema,app_role);
 EXECUTE format('GRANT UPDATE(name,status,reference,amount_kobo,customer_id,data,updated_at) ON %I.valopay_records TO %I',target_schema,app_role);
 EXECUTE format('GRANT UPDATE(request,status,receipt,updated_at) ON %I.valopay_operations TO %I',target_schema,app_role);
 EXECUTE format('GRANT UPDATE(response) ON %I.valopay_idempotency TO %I',target_schema,app_role);
 EXECUTE format('GRANT UPDATE(display_name,role,status,expires_at,updated_at) ON %I.valopay_staff_memberships TO %I',target_schema,app_role);
 EXECUTE format('GRANT UPDATE(status) ON %I.valopay_staff_invitations TO %I',target_schema,app_role);
 EXECUTE format('GRANT DELETE ON %I.valopay_staff_lender_access TO %I',target_schema,app_role);
END;
$migration$;
SELECT set_config('valopay.runtime_migration','',false);
COMMIT;
