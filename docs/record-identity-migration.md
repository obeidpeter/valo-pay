# Provider event and customer identities

Migration `009_record_identity_guards.sql` is required before publishing the build that declares `valopay_unique_provider_event` and `valopay_unique_customer_reference`. Apply it to every application schema, including each isolated runtime schema, as the database owner. It changes no record or permission and is not an application-startup migration.

An event ID is unique within a lender, provider connection and delivery channel (`data.source`). The namespace uses a nonblank `data.providerConnection`, then `data.provider`, else an empty legacy namespace. ASCII case and surrounding ASCII spaces are ignored; other characters remain exact. The empty namespace is deliberately stable: changing a lender's configured provider cannot change historical evidence identity. A provider or connection must therefore accompany imports where several providers can reuse event IDs.

Provider identity fields are limited to 200 characters so that provider-scoped index keys stay bounded; an existing longer delivery namespace stops migration for review. Nonempty customer references are unique within each lender, on creation and update. Imports may identify a customer by its record ID or unique reference. A reference that matches several historical customers is refused, never resolved by list order.

## Preflight and deployment

1. Take and verify a backup and ensure the old application can be stopped during the change. Review lender-local duplicate customer references before deployment:

   `SELECT merchant_id, reference, count(*) FROM valopay_records WHERE kind='customers' AND reference<>'' GROUP BY merchant_id, reference HAVING count(*)>1;`

2. Review any duplicate provider deliveries reported by the migration. Their grouping is exactly the provider expression in the file, plus lender, source and event ID. Do not delete or merge records merely to make an index succeed. The data owner must reconcile original evidence, correct ambiguous customer references with an approved recorded change, and preserve their relationships. The migration aborts before schema changes when either preflight finds duplicates.

3. Stop writers, then run with the database owner and the intended schema first on the search path:

   `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f lib/db/migrations/009_record_identity_guards.sql`

   For an isolated schema, set `PGOPTIONS='-c search_path=<runtime_schema>'` for that invocation. The migration reaches the table on that search path and drops only the reviewed old observation index in that same table's schema.

4. The transaction waits at most five seconds for locks and sixty seconds per statement. It takes a SHARE ROW EXCLUSIVE lock, performs duplicate preflight, builds/verifies both guards and removes the old overbroad event guard atomically. A timeout, conflict, invalid index or unexpected same-name definition rolls back the entire migration. Resolve the reported condition and rerun at a suitable time; the file is repeatable.

5. Publish the matching application build and require `/api/readyz` schema status `ok`. Its readiness catalogue requires the new uniqueness definitions; an older event index is insufficient. Rehearse migration and repeated schema push in disposable PostgreSQL before production. The regression is `record-identity-migration.integration.test.ts`.

## Rollback

Application rollback needs a compatibility review: the earlier event guard wrongly treats the same event ID from different providers as one identity. Once new provider-scoped records exist, recreating that guard can fail. Preserve the new database guards and records while fixing forward or deploying a compatible older application; never discard provider evidence to force an old schema back. The two new guards impose no row deletion or reference rewriting.
