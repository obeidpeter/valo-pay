# Database migrations

The one procedure for the numbered files in `lib/db/migrations`: which a database needs, who applies each, how, how to verify it and how to roll back. Nothing applies them automatically: not installation, the build, start-up, the post-merge hook or a deployment. The database owner applies them by hand, in order, before publishing the build that needs them.

## Where the Publish flow fits

Replit's Publish flow deploys a build and carries the development database's schema across to the production database once its diff has been reviewed; it never runs these files. A fresh development or CI database gets every table, constraint and index from the Drizzle schema with `pnpm --filter @workspace/db run push` and needs none of the files. An existing database (production, a staging host, a restored backup) gets each release's changes from the files below, applied with the owner's connection before the release is published. Then review the Publish flow's diff as `docs/DATABASE_SECURITY.md` requires: once the files are applied it shows no change for their tables and indexes, and any unexpected drop or rename stops the release.

A push is repeatable: run again on an unchanged schema it finds nothing to do, on a freshly pushed database and on one built from these files (the schema push rehearsal, `artifacts/api-server/tests/schema-push.integration.test.ts`, checks both), so a statement a push or the Publish flow's diff shows is a real change. Earlier pushes dropped and rebuilt the in-flight and provider-event uniqueness guards and three foreign keys every time; a push runs its statements one at a time, outside a transaction, so one stopped part way could leave a guard missing, which readiness now reports (below). A development database pushed before 008 holds those three foreign keys under names PostgreSQL cut at 63 characters: apply 008 to it before its next push, or that push drops and adds them once under their new names.

## The files, in order

| Order | File | Status | Who applies it | Command | Verify | Roll back |
| --- | --- | --- | --- | --- | --- | --- |
| 001 | `lib/db/migrations/001_pilot_rls.sql` | Superseded by 005 and 006. Never apply it. | Nobody. | None. | `SELECT count(*) FROM pg_roles WHERE rolname = 'valopay_pilot_app'` answers 0. | Not applicable. |
| 002 | `lib/db/migrations/002_record_list_indexes.sql` | Required on an existing database: four read indexes for record lists. The application works without them, more slowly. | The database owner. | `node scripts/apply-record-list-indexes.mjs` to inspect, then `node scripts/apply-record-list-indexes.mjs --apply --database "VERIFIED_DATABASE_NAME"` (`docs/record-list-index-deployment.md`). | The runner prints `verified`, a second inspection shows all four `present`, and `/api/readyz` no longer reports them missing. | None needed: the indexes change no data. A failed concurrent build leaves an invalid index; after inspection, drop only that index with `DROP INDEX CONCURRENTLY` and apply again. |
| 003 | `lib/db/migrations/003_pilot_workflow.sql` | Required: the operations journal, teams, memberships, invitations and access events. `/api/readyz` answers 503 until they exist. | The database owner. | `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f lib/db/migrations/003_pilot_workflow.sql` | `/api/readyz` answers 200 and the log has no `readiness.failed` line naming these tables. | Restore the previous build and keep the tables: never drop the journal or the access history. |
| 004 | `lib/db/migrations/004_staff_lender_access.sql` | Required, after 003: explicit lender grants for non-administrator staff. | The database owner. | `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f lib/db/migrations/004_staff_lender_access.sql` | As for 003; the table's index is reported by `readiness.indexes_missing` until it exists. | As for 003: keep the table. |
| 005 | `lib/db/migrations/005_runtime_isolation.sql` | Optional commissioning, only for the restricted runtime (`VALOPAY_RUNTIME_ISOLATION=staging`), in a separate `valopay_runtime_staging_<suffix>` schema. | The migration owner (a privileged login, never the application's). | Below. | Below. | Turn the restricted runtime off (`VALOPAY_RUNTIME_ISOLATION=off`); the schema and roles can stay until a reviewed change removes them. |
| 006 | `lib/db/migrations/006_runtime_isolation_scope.sql` | Required after 005 in the same schema: the application refuses a runtime schema without it. | The migration owner. | Below. | Below. | As for 005. |
| 007 | `lib/db/migrations/007_journal_and_lender_indexes.sql` | Required, after 003, before publishing a build whose schema declares its two indexes. Without them readiness reports `indexes_missing`. | The database owner. | `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f lib/db/migrations/007_journal_and_lender_indexes.sql`, and once more for each runtime schema (below). | The file verifies both definitions before it commits; `/api/readyz` then reports `checks.schema.status` `ok`. | None needed: the indexes change no data. The file is repeatable and changes nothing when an index already has the reviewed definition. |
| 008 | `lib/db/migrations/008_export_queue_index_and_foreign_key_names.sql` | Required, after 004 and 007, before publishing a build whose schema declares them: the export worker's queue index, and the names of three foreign keys (memberships and invitations to their team, lender grants to their membership) that earlier files and pushes left cut at PostgreSQL's 63 characters. Without the index readiness reports `indexes_missing`; without the names the Publish flow's diff drops and adds those foreign keys. | The database owner. | `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f lib/db/migrations/008_export_queue_index_and_foreign_key_names.sql`, and once more for each runtime schema (below). | The file verifies the index's definition and the three foreign keys before it commits; `/api/readyz` then reports `checks.schema.status` `ok`, and `SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND conname NOT LIKE '%fk'` answers 0. | None needed: the index changes no data, and a rename keeps the constraint and its rows as they were. The file is repeatable and changes nothing once both are in place. |
| 009 | `lib/db/migrations/009_record_identity_guards.sql` | Required before this build: provider-scoped event uniqueness and lender-local customer reference uniqueness. Existing duplicates stop migration without deleting records. | The database owner, in every application and runtime schema. | `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f lib/db/migrations/009_record_identity_guards.sql` | Exact index definitions verified before commit; `/api/readyz` schema status `ok`. See [preflight and runbook](record-identity-migration.md). | Preserve the new guards and fix forward; the older event guard cannot represent equal IDs from different providers. No record deletion. |

003, 004, 007, 008 and 009 are single transactions and repeatable: run again, they change no data. Each waits at most 5 s for a lock and runs each statement for at most 60 s: if either limit is reached it stops with nothing changed, so a request's open write holds it back, and the writes queued behind it wait, for no longer than that; run it again at a quieter moment. Use a direct or session-pinned connection for 002, whose runner holds an advisory lock for the whole operation. Keep `DATABASE_URL` in the environment rather than on the command line, and never paste its value into a terminal log, an issue or a report.

## Before and after

1. Back up the database and note the time.
2. Read `/api/readyz` and the `readiness.failed` or `readiness.indexes_missing` log lines of the running build: they name each missing table, column or read index and where it comes from. They name a missing unique index or check constraint only when the running build checks them, which builds from before the 23 September 2026 audit fixes ("Repeatable schema push and readiness guards" in `docs/BUILD_STATUS.md`) do not, so the guard query below is how to see those.
3. Apply the files the release needs, in order, with the commands above.
4. Run the guard query below, from the copy of this document in the build you are about to publish. If it lists anything, do not publish yet: that build's readiness would answer 503, its start-up health check would hold the release back and the build before it would keep serving. Restore each guard it lists as "A missing unique index or check constraint" below says, and run the query again until it lists nothing.
5. Check `/api/readyz` again, and record in the operator's change log which files were applied to which database, when and by whom. The database keeps no record of its own; readiness and the verification queries above are how to tell afterwards.
6. Publish the build, then review the Publish flow's diff.

## The guard query

Readiness counts a database as ready only when it holds every unique index and check constraint the build's schema declares (`integrityGuards` in `artifacts/api-server/src/lib/valopay-store.ts`). This query lists each of them the database lacks: missing, not yet valid or validated, or present with another definition. It compares definitions, as readiness does, not names, and it lists nothing when every guard is in place. It only reads the catalogue. Run it with the owner's connection in a read-only session: paste it into `PGOPTIONS="-c default_transaction_read_only=on" psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1`, or save it to a file and add `-f` with the file's name. It reads the tables the search path reaches, so run it once more for each runtime schema, with `-c search_path=$VALOPAY_RUNTIME_SCHEMA` added to `PGOPTIONS`. Each row gives the guard's kind (`unique index` or `check`), its name in the Drizzle schema and its table. `artifacts/api-server/tests/valopay-store-guards.test.ts` checks that the query lists exactly the guards readiness checks, and `artifacts/api-server/tests/integrity-guards.integration.test.ts` that on PostgreSQL it names exactly what readiness names.

```sql
-- Read-only: the unique indexes and check constraints this build requires that the database lacks. No rows: all are in place.
SELECT guard.kind, guard.name, guard.table_name
FROM (VALUES
  ('unique index', 'valopay_workspaces_pkey', 'valopay_workspaces', 'USING btree (id)'),
  ('unique index', 'valopay_workspaces_principal_hash_unique', 'valopay_workspaces', 'USING btree (principal_hash)'),
  ('unique index', 'valopay_merchants_pkey', 'valopay_merchants', 'USING btree (id)'),
  ('unique index', 'valopay_records_pkey', 'valopay_records', 'USING btree (id)'),
  ('unique index', 'valopay_unique_due_reference', 'valopay_records', 'USING btree (merchant_id, reference) WHERE ((kind = ''due-items''::text) AND (reference <> ''''::text))'),
  ('unique index', 'valopay_unique_customer_reference', 'valopay_records', 'USING btree (merchant_id, reference) WHERE ((kind = ''customers''::text) AND (reference <> ''''::text))'),
  ('unique index', 'valopay_unique_provider_event', 'valopay_records', 'USING btree (merchant_id, translate(COALESCE(NULLIF(btrim((data ->> ''providerConnection''::text)), ''''::text), NULLIF(btrim((data ->> ''provider''::text)), ''''::text), ''''::text), ''ABCDEFGHIJKLMNOPQRSTUVWXYZ''::text, ''abcdefghijklmnopqrstuvwxyz''::text), COALESCE((data ->> ''source''::text), ''''::text), ((data ->> ''eventId''::text))) WHERE ((kind = ''observations''::text) AND ((data ->> ''eventId''::text) IS NOT NULL))'),
  ('unique index', 'valopay_one_inflight', 'valopay_records', 'USING btree (merchant_id, ((data ->> ''dueItemId''::text))) WHERE ((kind = ''attempts''::text) AND (status = ANY (ARRAY[''scheduled''::text, ''sent''::text, ''unknown''::text])))'),
  ('check', 'valopay_money_integer', 'valopay_records', 'CHECK (((amount_kobo >= 0) AND (amount_kobo <= ''9007199254740991''::bigint)))'),
  ('check', 'valopay_ticket_floor', 'valopay_records', 'CHECK (((kind <> ''due-items''::text) OR (amount_kobo >= 500000)))'),
  ('unique index', 'valopay_idempotency_pkey', 'valopay_idempotency', 'USING btree (id)'),
  ('unique index', 'valopay_idempotency_tenant_key', 'valopay_idempotency', 'USING btree (merchant_id, id)'),
  ('unique index', 'valopay_operations_pkey', 'valopay_operations', 'USING btree (id)'),
  ('check', 'valopay_operation_status', 'valopay_operations', 'CHECK ((status = ANY (ARRAY[''pending''::text, ''completed''::text, ''cancelled''::text])))'),
  ('unique index', 'valopay_teams_pkey', 'valopay_teams', 'USING btree (workspace_id)'),
  ('unique index', 'valopay_teams_organization_id_unique', 'valopay_teams', 'USING btree (organization_id)'),
  ('unique index', 'valopay_staff_memberships_pkey', 'valopay_staff_memberships', 'USING btree (id)'),
  ('unique index', 'valopay_staff_workspace_user', 'valopay_staff_memberships', 'USING btree (workspace_id, user_id)'),
  ('check', 'valopay_staff_status', 'valopay_staff_memberships', 'CHECK ((status = ANY (ARRAY[''active''::text, ''suspended''::text, ''revoked''::text])))'),
  ('check', 'valopay_staff_role', 'valopay_staff_memberships', 'CHECK ((role = ANY (ARRAY[''Admin''::text, ''Operations''::text, ''Finance''::text, ''Compliance reviewer''::text, ''Read-only''::text])))'),
  ('unique index', 'valopay_staff_invitations_pkey', 'valopay_staff_invitations', 'USING btree (id)'),
  ('unique index', 'valopay_staff_invitations_token_hash_unique', 'valopay_staff_invitations', 'USING btree (token_hash)'),
  ('check', 'valopay_invitation_status', 'valopay_staff_invitations', 'CHECK ((status = ANY (ARRAY[''pending''::text, ''accepted''::text, ''revoked''::text])))'),
  ('unique index', 'valopay_staff_events_pkey', 'valopay_staff_events', 'USING btree (id)'),
  ('unique index', 'valopay_staff_lender_access_membership_id_merchant_id_pk', 'valopay_staff_lender_access', 'USING btree (membership_id, merchant_id)')
) AS guard (kind, name, table_name, definition)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
  WHERE guard.kind = 'unique index' AND t.relname = guard.table_name AND pg_table_is_visible(t.oid)
    AND i.indisunique AND i.indisvalid AND i.indisready
    AND regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \S+ ON (ONLY )?\S+ ', '') = guard.definition
  UNION ALL
  SELECT 1 FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid
  WHERE guard.kind = 'check' AND t.relname = guard.table_name AND pg_table_is_visible(t.oid)
    AND k.contype = 'c' AND k.convalidated AND pg_get_constraintdef(k.oid) = guard.definition
)
ORDER BY guard.table_name, guard.name;
```

## The restricted runtime's commissioning (005 and 006)

Only for a host that turns on `VALOPAY_RUNTIME_ISOLATION=staging`; `docs/pilot-database.md` and `docs/pilot-operations-controls.md` describe what it does. Work as the migration owner, on the schema the host will name in `VALOPAY_RUNTIME_SCHEMA` (a `valopay_runtime_staging_<suffix>` name; the application refuses any other).

1. Create the schema and the ten application tables in it. The isolation rehearsal (`artifacts/api-server/tests/runtime-isolation.integration.test.ts`) creates each as `CREATE TABLE "<schema>".<table> (LIKE public.<table> INCLUDING ALL)`, which copies columns, defaults, checks and indexes but not foreign keys; whether the commissioned schema adds its foreign keys is a reviewed decision for that host.
2. Apply 005 with its opt-in and two new role names, then 006 with its opt-in, each with the schema first on the search path:

   ```sh
   PGOPTIONS="-c search_path=$VALOPAY_RUNTIME_SCHEMA,public -c valopay.runtime_migration=staging-only -c valopay.runtime_app_role=NEW_RESTRICTED_LOGIN -c valopay.runtime_helper_role=NEW_HELPER_OWNER" \
     psql "$MIGRATION_OWNER_URL" -X -v ON_ERROR_STOP=1 -f lib/db/migrations/005_runtime_isolation.sql
   PGOPTIONS="-c search_path=$VALOPAY_RUNTIME_SCHEMA,public -c valopay.runtime_migration=staging-only" \
     psql "$MIGRATION_OWNER_URL" -X -v ON_ERROR_STOP=1 -f lib/db/migrations/006_runtime_isolation_scope.sql
   ```

3. Apply 007 and then 008 in the runtime schema too: `PGOPTIONS="-c search_path=$VALOPAY_RUNTIME_SCHEMA" psql "$MIGRATION_OWNER_URL" -X -v ON_ERROR_STOP=1 -f lib/db/migrations/007_journal_and_lender_indexes.sql`, and the same with `lib/db/migrations/008_export_queue_index_and_foreign_key_names.sql`. The copied tables have no foreign keys, so 008 adds only the index there.
4. Verify by running the application with isolation on: every staff transaction compares the policies, helpers and workspace guard with the reviewed set and answers 503 on any difference, and `/api/readyz` reads the runtime schema (its `readiness` lines name it). The rehearsal runs the same files on a disposable schema in CI.

Passwords, the restricted login's connection and the service member are provisioned separately; no credential is written into these files or accepted by the application.

## A missing unique index or check constraint

The unique indexes the Drizzle schema declares (primary keys and unique constraints included) and its check constraints are integrity guards: without one the database accepts what the application relies on it to refuse, such as two attempts in flight for one instalment, a provider event recorded twice or money outside the safe range. `/api/readyz` answers 503 with `checks.schema.status` `incomplete` while one is missing, and the `readiness.failed` line names each (`unique index valopay_one_inflight: restore it from the Drizzle schema in lib/db`). None of these files removes one; a push stopped part way or a change by hand can. The deployment's start-up health check is `/api/readyz`, so a release whose database lacks a guard does not go live and the build before it keeps serving: restore the guard, then publish again. The guard query above finds such a guard before publishing.

1. Find the rows the guard would refuse, such as two rows with the same values in a unique index's columns that its condition covers, and resolve them with the lender's operators. Never delete evidence to make a guard build.
2. Create the guard under its name, as `lib/db/src/schema/valopay.ts` declares it: on a development database, `pnpm --filter @workspace/db run push`; on an existing database, the definition a pushed development database gives (`pg_get_indexdef` or `pg_get_constraintdef`). On `valopay_records`, build a unique index with `CREATE UNIQUE INDEX CONCURRENTLY` outside a transaction, and add a check `NOT VALID` and then `VALIDATE CONSTRAINT` it, so that record writes are not held while the table is read; readiness counts a check only once it is validated.
3. Run the guard query again until it lists nothing; a build that checks guards then answers 200 on `/api/readyz`.
