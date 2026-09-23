-- Read-performance indexes only: no row, permission, row-security, constraint
-- or setting changes. Apply after 003_pilot_workflow.sql, with the database
-- owner, before deploying the build whose Drizzle schema declares them; the
-- readiness check answers not ready until they exist. Never run at startup.
--
--   valopay_operations_pending: the limit of 100 pending requests per person
--   and lender counts only pending journal entries, instead of reading every
--   entry the person has ever made.
--   valopay_merchants_workspace: a workspace's lenders (listing and counting
--   them, the expiry sweep, the staff directory and row-security scope) are
--   read by workspace instead of scanning every lender.
--
-- Run with: psql -X -v ON_ERROR_STOP=1 -f lib/db/migrations/007_journal_and_lender_indexes.sql
-- It is transactional and repeatable: the index names are the ones the Drizzle
-- schema in lib/db gives them, so a database built by drizzle-kit push already
-- has them and nothing changes. Each build takes a SHARE lock, so writes to
-- that table wait while it runs; both tables hold one row per lender or per
-- keyed request, which takes well under a second at pilot scale. The lock wait
-- is limited to 5 s and each statement to 60 s: if either limit is reached
-- nothing changes, and it can be run again at a quieter moment, or the index
-- built with CREATE INDEX CONCURRENTLY as docs/record-list-index-deployment.md
-- describes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE INDEX IF NOT EXISTS valopay_operations_pending ON valopay_operations USING btree (merchant_id, owner) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS valopay_merchants_workspace ON valopay_merchants USING btree (workspace_id, id);
-- IF NOT EXISTS alone would accept a different index that happens to have one
-- of these names. Refuse that, and an index that is not valid, before COMMIT.
DO $verify$
DECLARE
 wanted record;
 existing record;
BEGIN
 FOR wanted IN SELECT * FROM (VALUES
   ('valopay_operations_pending', 'valopay_operations', 'USING btree (merchant_id, owner) WHERE (status = ''pending''::text)'),
   ('valopay_merchants_workspace', 'valopay_merchants', 'USING btree (workspace_id, id)')) AS expected(index_name, table_name, definition)
 LOOP
   SELECT t.relname AS table_name, i.indisvalid AS valid, i.indisunique AS is_unique,
     regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE INDEX \S+ ON \S+ ', '') AS definition
     INTO existing
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = wanted.index_name;
   IF NOT FOUND OR existing.table_name <> wanted.table_name OR NOT existing.valid OR existing.is_unique OR existing.definition <> wanted.definition THEN
     RAISE EXCEPTION 'Index %.% is not the reviewed definition (% on %). Nothing was changed; review the existing index first.', current_schema(), wanted.index_name, wanted.definition, wanted.table_name;
   END IF;
 END LOOP;
END
$verify$;
COMMIT;
