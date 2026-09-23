# Database migrations

The one procedure for the numbered files in `lib/db/migrations`: which a database needs, who applies each, how, how to verify it and how to roll back. Nothing applies them automatically: not installation, the build, start-up, the post-merge hook or a deployment. The database owner applies them by hand, in order, before publishing the build that needs them.

## Where the Publish flow fits

Replit's Publish flow deploys a build and carries the development database's schema across to the production database once its diff has been reviewed; it never runs these files. A fresh development or CI database gets every table, constraint and index from the Drizzle schema with `pnpm --filter @workspace/db run push` and needs none of the files. An existing database (production, a staging host, a restored backup) gets each release's changes from the files below, applied with the owner's connection before the release is published. Then review the Publish flow's diff as `docs/DATABASE_SECURITY.md` requires: once the files are applied it shows no change for their tables and indexes, and any unexpected drop or rename stops the release.

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

003, 004 and 007 are single transactions and repeatable: run again, they change nothing. Each waits at most 5 s for a lock and runs each statement for at most 60 s: if either limit is reached it stops with nothing changed, so a request's open write holds it back, and the writes queued behind it wait, for no longer than that; run it again at a quieter moment. Use a direct or session-pinned connection for 002, whose runner holds an advisory lock for the whole operation. Keep `DATABASE_URL` in the environment rather than on the command line, and never paste its value into a terminal log, an issue or a report.

## Before and after

1. Back up the database and note the time.
2. Read `/api/readyz` and the `readiness.failed` or `readiness.indexes_missing` log lines of the running build: they name each missing table, column or index and the file that adds it.
3. Apply the files the release needs, in order, with the commands above.
4. Check `/api/readyz` again, and record in the operator's change log which files were applied to which database, when and by whom. The database keeps no record of its own; readiness and the verification queries above are how to tell afterwards.
5. Publish the build, then review the Publish flow's diff.

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

3. Apply 007 in the runtime schema too: `PGOPTIONS="-c search_path=$VALOPAY_RUNTIME_SCHEMA" psql "$MIGRATION_OWNER_URL" -X -v ON_ERROR_STOP=1 -f lib/db/migrations/007_journal_and_lender_indexes.sql`.
4. Verify by running the application with isolation on: every staff transaction compares the policies, helpers and workspace guard with the reviewed set and answers 503 on any difference, and `/api/readyz` reads the runtime schema (its `readiness` lines name it). The rehearsal runs the same files on a disposable schema in CI.

Passwords, the restricted login's connection and the service member are provisioned separately; no credential is written into these files or accepted by the application.
