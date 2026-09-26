-- Required before publishing this build; run as database owner once for each
-- application schema, including isolated runtime schemas, with that schema
-- first on search_path. Never run automatically at application startup.
-- Preserves all records. Duplicate identities abort before any schema change.
-- See docs/record-identity-migration.md for preflight and remediation.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE valopay_records IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
 IF EXISTS (SELECT 1 FROM valopay_records WHERE kind='observations' AND data->>'eventId' IS NOT NULL
   AND char_length(coalesce(nullif(btrim(data->>'providerConnection'), ''), nullif(btrim(data->>'provider'), ''), '')) > 200) THEN
   RAISE EXCEPTION 'A provider delivery identity exceeds 200 characters. Migration 009 changed nothing. Review its source mapping before retrying.';
 END IF;
 IF EXISTS (
   SELECT 1 FROM valopay_records WHERE kind = 'customers' AND reference <> ''
   GROUP BY merchant_id, reference HAVING count(*) > 1
 ) THEN
   RAISE EXCEPTION 'Duplicate customer references exist within a lender. Migration 009 changed nothing. Review and correct the identities before retrying; no records were deleted.';
 END IF;
 IF EXISTS (
   SELECT 1 FROM valopay_records WHERE kind = 'observations' AND data->>'eventId' IS NOT NULL
   GROUP BY merchant_id,
     translate(coalesce(nullif(btrim(data->>'providerConnection'), ''), nullif(btrim(data->>'provider'), ''), ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
     coalesce(data->>'source', ''), data->>'eventId'
   HAVING count(*) > 1
 ) THEN
   RAISE EXCEPTION 'Duplicate provider delivery identities exist within a lender. Migration 009 changed nothing. Review the original evidence before retrying; no records were deleted.';
 END IF;
END
$preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS valopay_unique_customer_reference ON valopay_records (merchant_id, reference)
 WHERE kind = 'customers' AND reference <> '';
CREATE UNIQUE INDEX IF NOT EXISTS valopay_unique_provider_event ON valopay_records (
 merchant_id,
 translate(coalesce(nullif(btrim(data->>'providerConnection'), ''), nullif(btrim(data->>'provider'), ''), ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
 coalesce(data->>'source', ''), (data->>'eventId')
) WHERE kind = 'observations' AND data->>'eventId' IS NOT NULL;

DO $verify$
DECLARE wanted record; existing record; previous record; table_schema text;
BEGIN
 FOR wanted IN SELECT * FROM (VALUES
  ('valopay_unique_customer_reference', 'USING btree (merchant_id, reference) WHERE ((kind = ''customers''::text) AND (reference <> ''''::text))'),
  ('valopay_unique_provider_event', 'USING btree (merchant_id, translate(COALESCE(NULLIF(btrim((data ->> ''providerConnection''::text)), ''''::text), NULLIF(btrim((data ->> ''provider''::text)), ''''::text), ''''::text), ''ABCDEFGHIJKLMNOPQRSTUVWXYZ''::text, ''abcdefghijklmnopqrstuvwxyz''::text), COALESCE((data ->> ''source''::text), ''''::text), ((data ->> ''eventId''::text))) WHERE ((kind = ''observations''::text) AND ((data ->> ''eventId''::text) IS NOT NULL))')
 ) AS expected(index_name, definition)
 LOOP
  SELECT i.indisvalid AS valid, i.indisunique AS is_unique,
    regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \S+ ON (ONLY )?\S+ ', '') AS definition
   INTO existing FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
   WHERE i.indrelid=to_regclass('valopay_records') AND c.relname=wanted.index_name;
  IF NOT FOUND OR NOT existing.valid OR NOT existing.is_unique OR existing.definition <> wanted.definition THEN
   RAISE EXCEPTION 'Index % is not the reviewed definition. Migration 009 changed nothing; review the existing index.', wanted.index_name;
  END IF;
 END LOOP;
 -- Drop only the reviewed old guard, after the new one has been verified.
 SELECT i.indisvalid AS valid,i.indisunique AS is_unique,
   regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \S+ ON (ONLY )?\S+ ', '') AS definition
  INTO previous FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE i.indrelid=to_regclass('valopay_records') AND c.relname='valopay_unique_observation';
 IF FOUND THEN
  IF NOT previous.valid OR NOT previous.is_unique OR previous.definition <> 'USING btree (merchant_id, ((data ->> ''source''::text)), ((data ->> ''eventId''::text))) WHERE ((kind = ''observations''::text) AND ((data ->> ''eventId''::text) IS NOT NULL))' THEN
   RAISE EXCEPTION 'The old observation guard is not the reviewed definition. Migration 009 changed nothing; review it first.';
  END IF;
  SELECT n.nspname INTO table_schema FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE t.oid=to_regclass('valopay_records');
  EXECUTE format('DROP INDEX %I.valopay_unique_observation', table_schema);
 END IF;
END
$verify$;
COMMIT;
