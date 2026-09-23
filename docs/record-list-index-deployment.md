# Deploy the record-list read indexes

This procedure adds only four non-unique B-tree indexes to `public.valopay_records`, matching `lib/db/src/schema/valopay.ts`. It does not change rows, foreign keys, uniqueness checks, tenant access, RLS, roles, encryption, scheduler settings, or Paystack. The console/API code works before these indexes exist; the indexes reduce database work as record counts grow.

The SQL reviewed for deployment is `lib/db/migrations/002_record_list_indexes.sql`. Use the narrow runner below instead of `drizzle-kit push`, `push-force`, or running every file in the migrations directory. In particular, this procedure never applies `001_pilot_rls.sql`.

## Inspect the target first

Run from the deployed repository checkout with its locked dependencies installed. Use the database owner's existing private deployment connection in `DATABASE_URL`; do not paste its value into a command, terminal output, PR, or report. Use a direct or session-pinned PostgreSQL connection, since the runner keeps an advisory lock for the whole operation.

```sh
node scripts/apply-record-list-indexes.mjs
```

This is read-only apart from connection-local timeout settings. It prints the connected database name, existing index definitions/validity, and a plan for each proposed index:

- `present`: the existing index is valid, ready, live, and has the exact reviewed table, method, ordered columns and non-unique definition.
- `missing`: the index can be created.
- `conflict`: a same-name object is different or invalid, or an equivalent index already exists under another name. Application stops before creating anything.

Review this output against the intended deployment and available storage. Run during a quieter period: concurrent builds allow writes but still consume CPU, I/O and additional disk space. No production index state has been inferred from the source schema.

## Apply and verify

Substitute the database name printed by the inspection; this is a database name, not a connection URL or password.

```sh
node scripts/apply-record-list-indexes.mjs --apply --database "VERIFIED_DATABASE_NAME"
node scripts/apply-record-list-indexes.mjs --database "VERIFIED_DATABASE_NAME"
```

The runner re-inspects all definitions, serialises its own invocations with a session advisory lock, and creates missing indexes one at a time with `CREATE INDEX CONCURRENTLY`. It uses a 5-second lock wait and a 15-minute statement limit. It does not use a surrounding transaction or `IF NOT EXISTS`; an unexpected conflicting object must fail visibly. The final output must say `verified`, and subsequent inspection must show all four indexes as `present`.

After application, check `/api/readyz`, open the customer directory, change page and search, then open a customer history and Settings. Review normal application latency/error monitoring. The disposable integration benchmark records query-plan and latency measurements; those measurements are not a production service guarantee. Exact accent-insensitive JSON search still scans bounded batches of the selected kind, and complex queue views still request complete related sets to preserve totals.

## If a build stops

Already completed indexes stay in place. A failed or timed-out concurrent build can leave an invalid index; the runner deliberately refuses it on the next invocation. Inspect `pg_stat_progress_create_index`, active transactions, disk capacity and the named index's catalogue definition before deciding on a retry. The runner never drops or replaces an index automatically.

If inspection establishes that the failed index belongs to this migration and is not supporting a constraint, the operator can review a single `DROP INDEX CONCURRENTLY public.EXACT_FAILED_INDEX_NAME` command, then rerun the inspection and application steps. Do not drop an unfamiliar or pre-existing differently defined index to make the script pass. No index rollback is required merely to roll back application code; these indexes do not alter the data contract.

PostgreSQL documents the concurrent-build locking, transaction and failure behaviour, and why `IF NOT EXISTS` alone does not validate an existing index, in [CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html). The repository's `record-index-migration.integration.test.ts` rehearses inspection, creation, exact reapplication, conflicting names, equivalent indexes under another name, and unchanged rows in a dedicated throwaway database. Running the test does not apply anything to the live database.

## Journal and lender indexes (migration 007)

`lib/db/migrations/007_journal_and_lender_indexes.sql` adds two more read indexes, also declared in `lib/db/src/schema/valopay.ts`: `valopay_operations_pending` on `valopay_operations(merchant_id, owner)` for pending entries only, which the limit of 100 pending requests per person and lender counts (without it the count read every entry the person had ever made), and `valopay_merchants_workspace` on `valopay_merchants(workspace_id, id)`, which listing and counting a workspace's lenders, the expiry sweep, the staff directory and row-security scope read. They change no rows, permissions or constraints.

Apply it after `003_pilot_workflow.sql`, with the database owner's private deployment connection in `DATABASE_URL`, and before deploying the build whose schema declares the indexes. Until they exist `/api/readyz` stays ready but reports `checks.schema.status` `indexes_missing`, and a `readiness.indexes_missing` log line names both.

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f lib/db/migrations/007_journal_and_lender_indexes.sql
```

Unlike 002, it is one transaction and repeatable: each index is created only if its name is missing, and before committing the file checks that both names hold the reviewed, valid definitions, so a different index under either name stops it with nothing changed. A plain build takes a SHARE lock, so writes to that table wait while it runs; both tables hold one row per lender or per keyed request, so at pilot scale that is well under a second. The file waits at most 5 s for its locks and 60 s per statement, and changes nothing if either limit is reached. For a journal too large to build within that, run the same two definitions one at a time with `CREATE INDEX CONCURRENTLY` outside a transaction, then run the file to verify them; the cautions above about invalid concurrent builds apply.
