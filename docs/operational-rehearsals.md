# Operational rehearsals

The shipped sandbox remains synthetic. These checks exercise recovery, alert delivery and the dedicated staging request path without changing the deployed database, enabling the scheduler or sending collection instructions.

## Incident and recovery delivery

`scripts/monitor-valopay.mjs` checks liveness and database readiness, with bounded requests and no redirects. If automatic closes are explicitly expected, it also checks the scheduler state and fresh successful heartbeat. An intentionally disabled scheduler is healthy unless the operator configures that expectation.

Run `pnpm run check:operations` with `VALOPAY_MONITOR_ORIGIN` set to the HTTPS service origin. The default is a dry run: it prints only the service origin, check time and fixed failure codes. It reads no customer records and sends no alerts.

External delivery requires a configured service. The email recipient is the address in `VALOPAY_ALERT_TO`; no address is written into the source. The optional Resend adapter follows the [send-email API](https://resend.com/docs/api-reference/emails/send-email); a verified sender and a provider key are required. Provider acceptance is not proof that a message reached the inbox. Confirm receipt during the host commissioning exercise.

| Variable | Meaning |
| --- | --- |
| `VALOPAY_MONITOR_ORIGIN` | HTTPS origin only; no embedded credentials, path, query or fragment. |
| `VALOPAY_MONITOR_EXPECT_SCHEDULER` | Set to `on` only when this host is expected to run automatic closes. |
| `VALOPAY_MONITOR_OWNER` | Person or operational team responsible for responding. |
| `VALOPAY_MONITOR_STATE_FILE` | Private, persistent state file owned by the monitor; use one process and a lock in the host scheduler. |
| `VALOPAY_MONITOR_ALERT_URL` | Optional HTTPS receiver; this takes precedence over the email adapter. Store any receiver token securely. |
| `VALOPAY_ALERT_RESEND_KEY` | Optional email-provider key, supplied through the host's secret configuration. |
| `VALOPAY_ALERT_FROM` | Verified sender email address for the email adapter. |
| `VALOPAY_ALERT_TO` | Recipient email address for the email adapter; required with the provider key and sender. |

To enable delivery after configuration, run `pnpm run check:operations -- --deliver`. Use an external scheduler so an unavailable app cannot also stop its own monitor. Two consecutive identical failing probes open an incident. Unchanged incidents stay quiet. A healthy probe after a delivered incident sends a recovery. Failed delivery does not mark an incident as delivered. The state file must be durable; separate instances must not run concurrently against the same file. A crash between receiver acceptance and saving local state can repeat a notification, so receiver-side deduplication remains useful.

The local test starts an actual HTTP receiver, exercises incident delivery, failed delivery, retry and recovery, and checks email formatting with an injected transport. It sends nothing to the selected email address. It runs in CI as `node scripts/monitor-valopay.test.mjs`.

On 18 September 2026 the Replit configuration check found no outbound email service, separate staging Clerk app or secret-manager key provider. The recipient is selected; external delivery and its schedule remain uncommissioned. Readiness monitoring does not replace log-based error-rate alerts, availability measurement or incident ownership drills.

## Measured synthetic recovery

`artifacts/api-server/tests/recovery-rehearsal.integration.test.ts` runs only with both `VALOPAY_RUN_INTEGRATION=1` and `VALOPAY_RUN_RECOVERY=1`, against the local disposable CI database named `valopay`. It creates distinct, uniquely named source and empty restore databases, seeds two synthetic lenders and performs a real PostgreSQL custom-format dump and restore. Credentials are passed to the PostgreSQL tools through environment variables, never command arguments or evidence output.

It compares every row in all ten application tables, including lender-specific access grants, pending/completed recovery requests, teams, active/revoked memberships, invitation hashes and access events, alongside lender settings, outstanding amounts, allocations, close snapshots, idempotency responses and audit chains. Two actual synthetic close exports are backed up with their private ownership metadata and restored to an empty local object directory. Their checksums, lengths, lender identities and database export pointers must agree. Missing or corrupted objects fail verification. Cleanup is restricted to the databases and temporary files created by that run.

The rehearsal also restores encrypted import CSV, recovery request/receipt and idempotency response envelopes. A separate test-only wrapping-key vault is restored after the source key material is cleared from memory. Missing keys, incorrect key material and the wrong lender scope must fail closed. The application runtime has no fixture-vault switch: actual deployments use managed KMS wrapping. A real key-recovery drill restores access to retained KMS key versions and their IAM policy; it must never export a managed master key into a database backup.

`src/lib/recovery-manifest.ts` joins the database snapshot checksum, complete private object inventory and reviewed configuration into a strict manifest. The configuration contains only schema version, runtime database role, issuer, allowed origins, retained key identifiers and closed execution gates. It rejects credentials and unknown fields. Before starting a restored environment, compare measured bytes and ownership metadata against an independently protected manifest and compare its configuration against an independently reviewed target configuration. A manifest stored beside a writable backup is not an independent integrity authority; store its hash or signature in a separately controlled recovery record.

CI retains the report for 14 days. It includes snapshot time, database and complete-package backup/restore durations, row counts, restored object count and verification scope, with no database URLs, secret keys, record payloads or customer identifiers. One synthetic write is deliberately made after the snapshot and is absent after restore; the report records this observed data loss and the age of the recovered snapshot. `VALOPAY_REHEARSAL_REPORT` selects its output path. This proves complete logical recovery across the local database/object/key fixtures. It does not prove production point-in-time recovery, hosted App Storage ACL restoration, managed KMS custody, real identity-service configuration or an agreed recovery-time/data-loss target. Those require a separate host rehearsal before real data is admitted.

## Integrated staging access

`artifacts/api-server/src/routes/pilot-staging.ts` constructs a separate staging app using Clerk middleware and an explicit origin allowlist. Each request reloads server-provisioned membership, checks the requested lender, role, active session and both authentication factors. The route never accepts a browser-selected role, workspace or principal. Sensitive writes require fresh factors.

`artifacts/api-server/src/lib/pilot-staging-store.ts` accepts a separate restricted connection pool, a named rehearsal schema and an injected key provider. It refuses privileged logins or missing forced row-level policies. Every transaction derives its scope from verified provisioning, uses transaction-local database settings and locks one lender. The pool connection is returned only after commit or rollback. A rolled-back commit cannot report success.

The staged route reads masked synthetic customer notes and writes encrypted synthetic notes with an expected record version and a stable request key. Ciphertext, audit entry and replay response commit together. Tenant, record and field identifiers are authenticated by the encryption envelope. The output never contains the note or ciphertext. It does not add any debit, message, provisioning, export or global scheduler capability.

The disposable RLS suite exercises complete HTTP requests through the router and actual restricted PostgreSQL login: successful encryption, masked read, replay, stale edit, expired MFA, revoked membership, wrong tenant, wrong origin and reuse of a connection with cleared scope. Verified-session fixtures replace the external identity service only inside the test. The dedicated app uses [Clerk middleware](https://clerk.com/docs/reference/express/clerk-middleware); no test claims to verify an unconfigured Clerk deployment.

This staging app is not mounted in the sandbox and is not started by deployment. Before commissioning it, provision a separate Clerk app, fresh membership lookup, restricted database login/schema, private key provider and approved origin. Full pilot workflows, action-bound reverification, service identities, key lifecycle, deployment rollback and independent assessment remain part of pilot acceptance.
