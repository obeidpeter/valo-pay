# Database security boundary

## Scope and rationale

Valo Pay remains an isolated **synthetic observation sandbox**, not an approved system for real lender/customer data. Its runtime security boundary is the application's scoped repository. This deliberately replaces a custom PostgreSQL role, RLS policies and a record-protection trigger that the observed managed publishing path did not reproduce faithfully.

The database connection is privileged. Explicit application checks **do not** provide the same independent barrier as a non-bypass database role with correctly configured RLS. A leaked database credential, malicious server code or an unscoped query can bypass application authorization and immutability. Do not describe this redesign as preserving database-enforced isolation.

## Enforcement

- Identity comes from verified Clerk request context or the existing high-entropy anonymous sandbox cookie, not a caller-supplied principal/workspace identifier. An absent or malformed sandbox cookie creates a separate synthetic workspace; it never grants access to an existing workspace. New anonymous sandboxes are limited to 20 per client address per hour on top of the general request limit, the cookie lifetime slides with each visit, and an anonymous sandbox older than 30 days with no change by a person in that time is removed (children first, a few per bootstrap) by the next anonymous bootstrap; activity is read from the audit chain, so entries by system actors (the seed, the scheduled close) never keep a sandbox alive, and signed-in workspaces are never swept.
- One repository owns runtime SQL. Workspace membership, selected merchant ownership and record predicates must be checked explicitly. Routes/domain code must not obtain raw clients or unrestricted query functions.
- The scheduled daily close is the one platform-initiated write path. It runs in the API process, one merchant per system transaction (`inMerchantAsSystem`), scoped to that merchant's own workspace and principal so every repository predicate still applies, with the merchant row taken `FOR UPDATE ... SKIP LOCKED` so it never queues behind a request and two processes never close the same lender at once. It writes through the same load, audit and save path as a request, under the actor `System · scheduled close`. Which merchants are due is read from the server-owned `settings.nextCloseAt` cursor; the settings endpoint strips that key from client input.
- A principal transaction lock serializes workspace creation/persona changes. A mutation takes an exclusive merchant row lock (`FOR UPDATE`) that serializes state validation, allocations, idempotency and audit sequence generation across processes, not just within one Node instance. A read takes a share lock (`FOR SHARE`), so it sees one consistent merchant state, waits for an in-flight mutation to commit, and never queues behind other reads.
- Reads, business mutations, idempotent responses and audit appends share the authorized transaction. The repository retains its own original state for mutation validation, rather than trusting a snapshot supplied by its callers.
- The repository refuses record deletion, tenant/identity reassignment, immutable-evidence edits and changes to frozen approved/preregistered/closed versions. It validates linked records and final allocation totals before committing.
- Ordinary database foreign keys, primary/unique indexes, safe-integer money bounds and the due-item ticket floor provide additional protections. Cross-record allocation caps and evidence immutability are application rules, not triggers.
- Private exports are accessible only through authorized merchant metadata and checksum-verified downloads. The metadata is resolved inside the authorized transaction and the object is read after it ends, so no merchant lock is held for the duration of a download. Object storage is not part of the SQL transaction: an object uploaded before a later database failure can be orphaned, but must not become accessible through another tenant.
- Hash chains detect corruption relative to their stored history. They do not establish independent tamper-proof evidence against a privileged actor able to rewrite both history and hashes.

## Development setup and publishing

The Drizzle schema defines the supported tables, foreign keys, checks and unique indexes. A fresh development setup uses the normal development schema push. Do not reintroduce custom security roles, policies or triggers as an undeclared setup prerequisite. The pull-request workflow creates the schema the same way inside a PostgreSQL 16 service container that exists only for its job and holds no application secret; that is a development push against a throwaway database, not a production migration path.

The existing development database transitions only after replacement application enforcement exists. Retiring the old objects must use narrowly scoped, reviewed development changes, preserve data and ordinary constraints, and never cascade-delete unknown role dependencies.

Production remains managed by the Publish flow. Do not introduce production migration scripts, build-hook schema pushes or startup-time DDL. Inspect the freshly generated development-to-production diff before concluding a publishing problem is resolved: successful compilation does not prove migration fidelity. Review unexpected drops/renames and confirm all required ordinary constraints and expression/partial indexes retain their semantics.

Removing the original role/policy dependencies addresses their specific missing-role failure mechanism. Only a subsequent user-initiated successful publish and post-publish checks establish that the complete publishing process works.

## Verification and residual requirements

- Run the database-boundary check, repository mutation/integration tests, API security regression script and existing smoke checks against the final schema **without** the legacy policies and trigger.
- Exercise foreign identities/merchant IDs, optional linked references, protected records, failed imports, transaction rollback, concurrent allocations/idempotency and audit sequencing, and authorized/unauthorized export downloads.
- Static boundary checks are a development safeguard, not a sandbox against malicious or deliberately obfuscated code.
- Real data remains blocked pending independent security assessment, production staff provisioning/MFA, documented hosting and legal prerequisites, tested recovery, and an explicitly approved production isolation design.

The reproducible checks are the ones in the README under "Checks and builds": `pnpm test` (database boundary, snapshot safeguards, repository guards, export collector and the golden suites), `pnpm run test:security-api` and `pnpm run test:smoke` against a running API, and the database-backed integration suites run with `VALOPAY_RUN_INTEGRATION=1`; the repository and scheduled-close suites (`pnpm run test:integration`) also run on every pull request against the workflow's throwaway database, while the export-stream and HTTP suites remain manual. The development transition evidence stays in the Replit workspace and is not part of this source snapshot.