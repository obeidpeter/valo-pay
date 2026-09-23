# Pilot database isolation and recovery rehearsal

This is a **staging-only foundation**, not an enabled control on the deployed sandbox. The application still uses the existing repository boundary. No migration in this document runs during installation, build, startup or deployment.

`lib/db/migrations/001_pilot_rls.sql` is deliberately incompatible with the current bootstrap, workspace expiry and scheduled-close paths: those paths do not establish the database context that these policies require. It refuses the deployed `public` schema and accepts only schemas named `valopay_pilot_staging_<suffix>` or `valopay_pilot_test_<suffix>`. Do not replace deployed database credentials with the pilot role.

## What the isolation rehearsal provides

The migration creates `valopay_pilot_app`, a role with no login, superuser, database creation, role creation, replication or RLS-bypass capability. It enables and forces row-level security on the four tables it was written for (workspaces, merchants, records and idempotency) in the selected schema. The role does not own these tables. The six tables added since are outside this rehearsal; the restricted runtime migrations, 005 and 006, cover all ten (`docs/pilot-operations-controls.md`).

Both `valopay.workspace_id` and `valopay.principal_hash` must be set for the transaction. A workspace ID alone is insufficient. Merchant visibility follows the visible workspace; records and idempotency entries follow the visible merchant. Missing, empty or mismatched settings expose no rows. Insert policies apply the same checks.

Grants are narrower than row visibility:

| Table | Pilot role capabilities |
| --- | --- |
| Workspaces | Select the scoped workspace; no provisioning, persona change or deletion |
| Merchants | Scoped select and insert; update `info` and `settings` only |
| Records | Scoped select and insert; update operational fields, excluding record ID, merchant ID, kind and creation time |
| Idempotency | Scoped select and insert; no update or deletion |

The role cannot delete records, move a lender to another workspace, move a record to another lender, alter policies, disable RLS or give itself `BYPASSRLS`. Provisioning, deletion and expiry require separate administrative capabilities. Existing domain validation and audit protections remain necessary: an RLS policy does not validate money, consent, record transitions or an audit chain.

The two transaction settings are **scope controls, not authentication credentials**. A database role that can issue arbitrary SQL can set custom PostgreSQL settings. Before this can protect a pilot, the server must verify the identity and workspace membership, derive both values itself, use parameterised SQL, and prevent callers from supplying or overriding scope. This foundation does not claim to contain a compromised database account or arbitrary SQL execution.

## Run the automated isolation test

Use an ephemeral PostgreSQL 16 instance with administrative privileges and the ordinary Valo Pay schema already pushed. The existing GitHub database job is such an environment. Never use a production connection string.

```sh
# DATABASE_URL must already point to that disposable PostgreSQL instance.
VALOPAY_RUN_INTEGRATION=1 VALOPAY_RUN_PILOT_RLS=1 \
  scripts/node_modules/.bin/tsx artifacts/api-server/tests/pilot-rls.integration.test.ts
```

The test creates a uniquely named `valopay_pilot_test_<random>` schema, copies the four table definitions into it, adds their foreign keys, and inserts synthetic fixtures for two workspaces. It applies the migration only to that schema. The application's original tables are not changed.

It verifies explicit opt-in, all four forced policies, role restrictions, unscoped queries, mismatched principals, cross-workspace reads and writes, inserts, attempted tenant moves, committed changes, rolled-back changes, and reuse of the same physical connection without leaking transaction settings. Its cleanup removes only the schema it created and the role created by its own successful migration. It refuses to run if that role already exists. If a process is forcibly killed, an administrator must inspect the leftover test schema and role before retrying; the test does not silently remove pre-existing objects.

The SQL also refuses to proceed without `valopay.pilot_migration=staging-only`, with missing tables, or when the role or policies already exist. Its changes are transactional. For a separate manual rehearsal, clone the four definitions and foreign keys into a named rehearsal schema in a disposable database, set the search path to that schema, and run with `psql -v ON_ERROR_STOP=1`; the opt-in and SQL file must run on the same connection. It revokes public table privileges and public schema creation rights **only in the selected staging schema**.

## Work required before enabling the role

The synthetic-note staging repository and HTTP route described in `docs/operational-rehearsals.md` now demonstrate the transaction, access and encryption integration below. The remaining list applies to full pilot workflows and commissioning, not to missing rehearsal code. The deployed sandbox still uses its original repository and credentials.

1. Replace sandbox personas with verified user membership and permission checks. Decide how team membership maps to the current one-principal-per-workspace model.
2. Implement a separate pilot repository adapter that starts a transaction, establishes server-derived workspace and principal settings using `set_config(..., true)`, and then performs scoped reads and writes. The final boolean makes the values local to that transaction. Never use a session-level tenant setting on a pool.
3. Keep application queries under the restricted login/role. Never give that login table ownership, schema creation, migration-role membership, superuser or `BYPASSRLS` privileges.
4. Move workspace provisioning and expiry to narrow administrative operations. Do not make the web process an administrator to get around a policy denial.
5. Replace the global scheduler scan with a reviewed scheduling capability. Each lender's work must execute inside a verified scope; request and scheduler tests must run under the actual pilot login, including concurrent tenants.
6. Retest the complete runtime: bootstrap, sign-in, invitations, permission changes, reconciliation, exports, idempotency, daily closes, recovery and connection-pool reuse. Record migration, rollback and recovery evidence before applying anything to a pilot database.

The adapter must roll back on every error and must not report success if PostgreSQL answers `ROLLBACK` to a `COMMIT` following a swallowed statement error. Release the connection only after the transaction is closed. The isolation test demonstrates that transaction-local context clears after both commit and rollback; it does not wire this adapter into the running application.

## Rehearse backup and restore before a pilot

Use a separate throwaway source database containing synthetic fixtures and a newly created empty restore target. This is a recovery exercise, not a rollback procedure for production. The administrator must verify both database names and connection hosts before running commands. Give the source a name such as `valopay_source_rehearsal_20260918` and the target `valopay_restore_rehearsal_20260918`; never restore over the source database.

The following commands assume the administrator has already created and verified those two disposable databases and configured their connection strings locally. Do not paste credentials into issues or evidence notes.

```sh
# SOURCE_REHEARSAL_URL: synthetic source, already populated and quiesced.
# EMPTY_RESTORE_REHEARSAL_URL: a different, verified, empty disposable target.
# Keep the dump in a protected local directory; do not commit it.
set -eu
: "${SOURCE_REHEARSAL_URL:?Set the verified synthetic rehearsal source URL}"
: "${EMPTY_RESTORE_REHEARSAL_URL:?Set the verified empty rehearsal target URL}"
source_name=$(psql --dbname="$SOURCE_REHEARSAL_URL" -X -v ON_ERROR_STOP=1 -Atc 'SELECT current_database()')
target_name=$(psql --dbname="$EMPTY_RESTORE_REHEARSAL_URL" -X -v ON_ERROR_STOP=1 -Atc 'SELECT current_database()')
case "$source_name" in valopay_source_rehearsal_*) ;; *) echo 'Refusing a source without the rehearsal name.' >&2; exit 1 ;; esac
case "$target_name" in valopay_restore_rehearsal_*) ;; *) echo 'Refusing a target without the rehearsal name.' >&2; exit 1 ;; esac
[ "$source_name" != "$target_name" ] || { echo 'Source and target must differ.' >&2; exit 1; }
target_objects=$(psql --dbname="$EMPTY_RESTORE_REHEARSAL_URL" -X -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')")
[ "$target_objects" = 0 ] || { echo 'Restore target must be empty.' >&2; exit 1; }

pg_dump --dbname="$SOURCE_REHEARSAL_URL" --format=custom --no-owner \
  --file=valopay-synthetic-recovery.dump

pg_restore --dbname="$EMPTY_RESTORE_REHEARSAL_URL" --no-owner --no-acl \
  --exit-on-error --single-transaction valopay-synthetic-recovery.dump
```

After restoring, compare row counts and IDs for all ten application tables; compare lender settings, outstanding amounts, allocations, daily-close snapshots, and idempotency responses. Verify the complete audit chain with the application verifier. Run the existing repository and scheduler integration suites against the restored target, then perform a UI smoke test using synthetic data. Record elapsed backup and restore time, the snapshot timestamp, verification results, operator and evidence references. Agree acceptable recovery time and data loss with the pilot owner; do not treat an unmeasured target as a successful recovery claim.

This logical dump does not establish point-in-time recovery, restore external object storage or export files, recover encryption keys, or reproduce roles/grants (`--no-acl` intentionally excludes those for the rehearsal). A pilot needs separate tested procedures for each, with restricted backup access, retention, restore credentials, key recovery and a full disaster rehearsal. A successful database test alone does not satisfy the production security or restore readiness gates.
