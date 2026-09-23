-- One read index and three constraint names: no row, permission, row-security
-- or setting changes, and no row is checked again. Apply after
-- 004_staff_lender_access.sql and 007_journal_and_lender_indexes.sql, with the
-- database owner, before publishing the build whose Drizzle schema declares
-- them; until the index exists the readiness check stays ready but reports
-- indexes_missing. Run it once for each schema holding the application's
-- tables, including each isolated runtime schema, with that schema first on
-- the search path (PGOPTIONS='-c search_path=<schema>'). Never run at startup.
--
--   valopay_records_export_queue: every few seconds the export worker looks,
--   across every lender, for queued exports and running ones whose lease has
--   run out, oldest first. This partial index holds only those jobs, in that
--   order, so the look-up reads a few index entries instead of every record.
--   Three foreign key names: the names Drizzle generated for the foreign keys
--   of valopay_staff_memberships.workspace_id,
--   valopay_staff_invitations.workspace_id and
--   valopay_staff_lender_access.membership_id ran past PostgreSQL's 63
--   characters, so PostgreSQL cut them short and every drizzle-kit push
--   dropped and added the three constraints again. The Drizzle schema now
--   names them within the limit, and 003 and 004 use those names; this renames
--   the cut names earlier copies of 003 and 004, or an earlier push, left. A
--   rename keeps the constraint itself. Tables without these constraints (the
--   copied tables of an isolated runtime schema have none) are left as they are.
--
-- Run with: psql -X -v ON_ERROR_STOP=1 -f lib/db/migrations/008_export_queue_index_and_foreign_key_names.sql
-- It is transactional and repeatable: the names are the ones the Drizzle schema
-- in lib/db gives them, so a database built by drizzle-kit push already has
-- them and nothing changes, and a run that finds everything in place takes no
-- lock on the tables. A rename takes an ACCESS EXCLUSIVE lock on its staff
-- table and the build a SHARE lock on valopay_records, both held until
-- COMMIT, so staff requests and record writes wait while the index reads the
-- table, well under a second at pilot scale. The staff tables come first, the
-- order a staff request takes them in, so such a request waits for this file
-- rather than deadlocking with it.
-- The lock wait is limited to 5 s and each statement to 60 s: if either limit
-- is reached nothing changes, and it can be run again at a quieter moment, or
-- the index built with CREATE INDEX CONCURRENTLY as
-- docs/record-list-index-deployment.md describes and this file then run to
-- rename the keys and verify.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Each cut name becomes the name the Drizzle schema gives. Both names on one
-- table would mean a second constraint nobody reviewed: stop rather than guess.
DO $rename$
DECLARE
 wanted record;
BEGIN
 FOR wanted IN SELECT * FROM (VALUES
   ('valopay_staff_memberships', 'valopay_staff_memberships_workspace_id_valopay_teams_workspace_', 'valopay_staff_memberships_workspace_id_fk'),
   ('valopay_staff_invitations', 'valopay_staff_invitations_workspace_id_valopay_teams_workspace_', 'valopay_staff_invitations_workspace_id_fk'),
   ('valopay_staff_lender_access', 'valopay_staff_lender_access_membership_id_valopay_staff_members', 'valopay_staff_lender_access_membership_id_fk')) AS names(table_name, cut_name, new_name)
 LOOP
   IF to_regclass(wanted.table_name) IS NULL THEN
     RAISE EXCEPTION 'Table % is not on the search path. Nothing was changed; apply 003_pilot_workflow.sql and 004_staff_lender_access.sql first, with the schema holding the application''s tables first on the search path.', wanted.table_name;
   END IF;
   CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(wanted.table_name) AND conname = wanted.cut_name);
   IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(wanted.table_name) AND conname = wanted.new_name) THEN
     RAISE EXCEPTION 'Table % holds both % and %. Nothing was changed; review both constraints first.', to_regclass(wanted.table_name), wanted.cut_name, wanted.new_name;
   END IF;
   EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', to_regclass(wanted.table_name), wanted.cut_name, wanted.new_name);
 END LOOP;
END
$rename$;
-- Built only when no relation in the record table's schema has its name, so a
-- repeat run waits for no record write.
DO $build$
BEGIN
 IF to_regclass('valopay_records') IS NULL THEN
   RAISE EXCEPTION 'Table valopay_records is not on the search path. Nothing was changed; run this with the schema holding the application''s tables first on the search path.';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_class t ON t.relnamespace = c.relnamespace WHERE t.oid = to_regclass('valopay_records') AND c.relname = 'valopay_records_export_queue') THEN
   EXECUTE format('CREATE INDEX valopay_records_export_queue ON %s USING btree (created_at, id) WHERE kind = ''exports'' AND status IN (''queued'', ''running'')', to_regclass('valopay_records'));
 END IF;
END
$build$;
-- A same-name index built differently, or a constraint under one of the new
-- names that is not the reviewed foreign key, would pass the steps above.
-- Refuse either, and an index that is not valid, before COMMIT.
DO $verify$
DECLARE
 wanted record;
 existing record;
 table_schema text;
BEGIN
 SELECT n.nspname INTO table_schema FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace WHERE t.oid = to_regclass('valopay_records');
 SELECT i.indisvalid AS valid, i.indisunique AS is_unique,
   regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE INDEX \S+ ON \S+ ', '') AS definition
   INTO existing
   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = to_regclass('valopay_records') AND c.relname = 'valopay_records_export_queue';
 IF NOT FOUND OR NOT existing.valid OR existing.is_unique
   OR existing.definition <> 'USING btree (created_at, id) WHERE ((kind = ''exports''::text) AND (status = ANY (ARRAY[''queued''::text, ''running''::text])))' THEN
   RAISE EXCEPTION 'Index %.valopay_records_export_queue is not the reviewed definition (USING btree (created_at, id) WHERE kind = ''exports'' AND status IN (''queued'', ''running'') on valopay_records). Nothing was changed; review the existing index first.', table_schema;
 END IF;
 FOR wanted IN SELECT * FROM (VALUES
   ('valopay_staff_memberships', 'valopay_staff_memberships_workspace_id_fk', 'FOREIGN KEY (workspace_id) REFERENCES valopay_teams(workspace_id)'),
   ('valopay_staff_invitations', 'valopay_staff_invitations_workspace_id_fk', 'FOREIGN KEY (workspace_id) REFERENCES valopay_teams(workspace_id)'),
   ('valopay_staff_lender_access', 'valopay_staff_lender_access_membership_id_fk', 'FOREIGN KEY (membership_id) REFERENCES valopay_staff_memberships(id) ON DELETE CASCADE')) AS expected(table_name, constraint_name, definition)
 LOOP
   SELECT k.contype AS kind, pg_get_constraintdef(k.oid) AS definition INTO existing
     FROM pg_constraint k WHERE k.conrelid = to_regclass(wanted.table_name) AND k.conname = wanted.constraint_name;
   IF FOUND AND (existing.kind <> 'f' OR existing.definition <> wanted.definition) THEN
     RAISE EXCEPTION 'Constraint % on % is not the reviewed foreign key (%). Nothing was changed; review it first.', wanted.constraint_name, to_regclass(wanted.table_name), wanted.definition;
   END IF;
 END LOOP;
END
$verify$;
COMMIT;
