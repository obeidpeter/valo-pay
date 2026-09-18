-- STAGING-ONLY isolation rehearsal. This is NOT a runtime migration.
-- The existing sandbox bootstrap, workspace expiry and scheduler do not set
-- these transaction settings. Applying this to the current app would break it.
-- Use a disposable database with four cloned tables in a schema named
-- valopay_pilot_staging_<suffix> or valopay_pilot_test_<suffix>.
-- The deployed public schema is explicitly refused. Set search_path to the
-- rehearsal schema, then explicitly opt in for this connection:
-- SELECT set_config('valopay.pilot_migration', 'staging-only', false);
-- Run with ON_ERROR_STOP. All changes below are atomic.
BEGIN;

DO $migration$
DECLARE
  target_schema text := current_schema();
  table_name text;
  expected_tables text[] := ARRAY['valopay_workspaces', 'valopay_merchants', 'valopay_records', 'valopay_idempotency'];
BEGIN
  IF current_setting('valopay.pilot_migration', true) IS DISTINCT FROM 'staging-only' THEN
    RAISE EXCEPTION 'Pilot RLS is staging-only. Explicitly opt in on a disposable database before running this rehearsal.';
  END IF;
  IF target_schema IS NULL OR target_schema !~ '^valopay_pilot_(test|staging)_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Choose a valopay_pilot_staging_<suffix> or valopay_pilot_test_<suffix> schema. Existing application schemas are refused.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'valopay_pilot_app') THEN
    RAISE EXCEPTION 'valopay_pilot_app already exists. Refusing to reuse a role whose ownership or grants were not established by this rehearsal.';
  END IF;
  FOREACH table_name IN ARRAY expected_tables LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = target_schema AND c.relname = table_name AND c.relkind = 'r') THEN
      RAISE EXCEPTION 'Missing ordinary table %.%. Push the schema into the disposable database first.', target_schema, table_name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = target_schema AND tablename = ANY(expected_tables)) THEN
    RAISE EXCEPTION 'Existing policies require a separate reviewed migration. Refusing to add permissive policies alongside them.';
  END IF;

  -- A runtime login would receive this role only after the pilot adapter is
  -- implemented. It must never receive the owner role, CREATEROLE or BYPASSRLS.
  CREATE ROLE valopay_pilot_app NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', target_schema);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO valopay_pilot_app', target_schema);
  FOREACH table_name IN ARRAY expected_tables LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC', target_schema, table_name);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target_schema, table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', target_schema, table_name);
    EXECUTE format('GRANT SELECT ON TABLE %I.%I TO valopay_pilot_app', target_schema, table_name);
  END LOOP;

  -- Both values must come from a verified server-side identity and membership
  -- lookup, never from a submitted workspace ID alone. Empty/missing values
  -- evaluate false. These GUCs are a scope guard, not user authentication.
  EXECUTE format($policy$
    CREATE POLICY valopay_pilot_workspace ON %I.valopay_workspaces
    TO valopay_pilot_app
    USING (id = NULLIF(current_setting('valopay.workspace_id', true), '')
      AND principal_hash = NULLIF(current_setting('valopay.principal_hash', true), ''))
    WITH CHECK (id = NULLIF(current_setting('valopay.workspace_id', true), '')
      AND principal_hash = NULLIF(current_setting('valopay.principal_hash', true), ''))
  $policy$, target_schema);

  EXECUTE format($policy$
    CREATE POLICY valopay_pilot_merchant ON %I.valopay_merchants
    TO valopay_pilot_app
    USING (EXISTS (SELECT 1 FROM %I.valopay_workspaces w
      WHERE w.id = workspace_id))
    WITH CHECK (EXISTS (SELECT 1 FROM %I.valopay_workspaces w
      WHERE w.id = workspace_id))
  $policy$, target_schema, target_schema, target_schema);

  FOREACH table_name IN ARRAY ARRAY['valopay_records', 'valopay_idempotency'] LOOP
    EXECUTE format($policy$
      CREATE POLICY valopay_pilot_merchant_scope ON %I.%I
      TO valopay_pilot_app
      USING (EXISTS (SELECT 1 FROM %I.valopay_merchants m
        WHERE m.id = merchant_id))
      WITH CHECK (EXISTS (SELECT 1 FROM %I.valopay_merchants m
        WHERE m.id = merchant_id))
    $policy$, target_schema, table_name, target_schema, target_schema);
  END LOOP;

  -- Provisioning, expiry and deletion are separate administrative capabilities.
  -- Identity/scope columns cannot be updated, even within a single workspace.
  -- Idempotency entries are append-only to this role.
  EXECUTE format('GRANT INSERT ON %I.valopay_merchants, %I.valopay_records, %I.valopay_idempotency TO valopay_pilot_app', target_schema, target_schema, target_schema);
  EXECUTE format('GRANT UPDATE (info, settings) ON %I.valopay_merchants TO valopay_pilot_app', target_schema);
  EXECUTE format('GRANT UPDATE (name, status, reference, amount_kobo, customer_id, data, updated_at) ON %I.valopay_records TO valopay_pilot_app', target_schema);
END;
$migration$;

SELECT set_config('valopay.pilot_migration', '', false);
COMMIT;
