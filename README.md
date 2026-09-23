# Valo Pay

The [22 September usability release](docs/usability/README.md) records operational improvements, the evidence-led audit, role/task map, validation limits and real-user research kit. Its five-component scorecards contain no invented participant results. Production and live-provider activation remain separate decisions.

Observation-first collections operations and connected banking workflows for Nigerian lenders and SMEs. This application is a **synthetic sandbox**, not a live payment service or an approved system for real customer data. Pay-by-bank, Credit Desk, Cash Desk and purpose-specific permissions have working sample journeys; each live capability remains independently gated.

## Source repository

This repository contains a clean snapshot of the application, not the original Replit conversation/checkpoint history. Credentials, databases, stored exports, local agent notes, original business-plan attachments and environment-specific verification reports are deliberately excluded. Replit runtime configuration is included; it contains configuration, not provisioned services or credentials.

## Project structure

- `artifacts/valo-pay` — React + Vite operations console. The landing page is `/` and the console's overview `/overview`; its pages, states and audits are designed against Nielsen's usability heuristics and the interaction-design principles recorded in `docs/design/console.md`.
- `artifacts/api-server` — Express API, scoped repository, domain logic and tests. On the deployed host, where `VALOPAY_EXPIRED_WORKSPACE_CLEANUP=on`, anonymous sandboxes nobody has changed for 30 days are deleted as new ones are created (`docs/deployment.md`); their creation is rate-limited per address, and list endpoints page with `limit`, `offset` and `updatedSince`.
- `artifacts/mockup-sandbox` — existing design/component preview workspace. It carries its own variant of the UI kit (different tokens and hover treatment from the console), so the two `components/ui` trees are intentionally not shared.
- `lib` — PostgreSQL/Drizzle schema, the OpenAPI contract (`lib/api-spec/openapi.json`, written by `node scripts/create-valopay-spec.cjs`), generated API packages and `lib/valopay-schema`, the shared per-kind schema (statuses, state machines, failure-code and exception catalogues, money and policy guardrails) that the API validator and the console both import.
- `scripts` — development checks, the contract generator and the source-sync utilities.
- `docs` — the documents listed below.

Keep the workspace together: the frontend and API depend on shared packages.

## Documentation

| Document | What it is for |
| --- | --- |
| `README.md` | This file: what the application is, how to install, run, check and change it. |
| `docs/BUILD_STATUS.md` | What this build delivers, the deviations from the specification, the closed production gates and the verification boundary. |
| `docs/connected-banking.md` | Connected Banking implementation, sample journeys, authority boundaries, API and remaining live dependencies. |
| `docs/DATABASE_SECURITY.md` | The security boundary: what the scoped repository enforces, what it does not, the opt-in database layers, and the publishing rules. |
| `docs/pilot-database.md` | The restricted runtime's row-level security and its rehearsal on a disposable schema, the superseded `001_pilot_rls.sql`, and the backup and restore rehearsal. |
| `docs/pilot-security.md` | The access and MFA check every staging staff request passes, and the tenant-bound field-encryption helpers. |
| `docs/pilot-workflow-release.md` | The pilot workflow release: the operations journal, saved import batches, coordinated cases, staff access, provisioning the first administrator and the pilot API. |
| `docs/pilot-operations-controls.md` | The pilot operations controls: journey evidence, sources and personal work, staff lender grants, the restricted runtime, envelope encryption, retention and recovery. |
| `docs/database-migrations.md` | The one procedure for migrations 001 to 007: which a database needs, who applies each, the command, how to verify it and how to roll back, and where the Publish flow fits. |
| `docs/record-list-index-deployment.md` | Deploying the read indexes of migrations 002 and 007 to an existing database. |
| `docs/deployment.md` | What the Replit deployment runs and gates on, what Autoscale means for scheduled closes, exports and per-address limits, the two ways to run closes on time (a Reserved VM, or the one-shot close pass from a Scheduled Deployment), sandbox expiry and Clerk telemetry on the deployed host. |
| `docs/frontend-contract.md` | The console's contract with the API: records, pages, mutations, imports and exports, and every console behaviour a page must keep. |
| `docs/design/console.md` | The design rationale for the console, page by page and audit by audit, against the usability heuristics and interaction-design principles. |
| `docs/security-review.md` | The security review: what is sound, the findings and their status, what belongs to the host. |
| `docs/observability.md` | What an operator can see: request ids, the log's events, health and readiness, what to watch, how to trace a report. |
| `docs/operational-rehearsals.md` | The operational monitor (`pnpm run check:operations`), the measured recovery rehearsal and staff access on the restricted runtime. |
| `docs/paystack.md` | The Paystack test adapter, the connection check (`pnpm run check:paystack`) and the optional signed test ingress. |
| `docs/operator-validation.md` | Prepared operator study, task scenarios, measurement definitions and remaining commissioning dependencies. No participant results are claimed. |
| `docs/usability/README.md` | The 22 September usability release: what it changed and what remains unmeasured, with links to the usability documents below. |
| `docs/usability/audit.md` | The usability audit: evidence baseline, method, findings register and remaining backlog. |
| `docs/usability/role-task-map.md` | The roles, the workflow inventory and the ten priority journeys. |
| `docs/usability/import-findings.md` | Findings and changes for imports and the shared forms. |
| `docs/usability/core-findings.md` | Findings and changes for reconciliation, exceptions and exports. |
| `docs/usability/connected-findings.md` | Findings and changes for the connected workspaces. |
| `docs/usability/research-kit.md` | The kit for sessions with real users: recruitment, script, task cards, measures and questionnaires. |
| `docs/usability/measurement-template.csv` | The empty measurement plan the research kit fills in, one row per journey and component. |
| `docs/usability/release.md` | The usability release's boundary, validation, operator guidance and amendment proposals. |
| `docs/investor-presentation.md` | Preparing and giving the investor demonstration from the console's Presentation page, and what it may claim. |
| `docs/documentation-review.md` | The documentation review: the findings, the mechanical check that keeps the documents true (it fails when a file under `docs/` is missing from this table), and where to document what. |
| `docs/github-sync.md` | The Replit-side procedure for publishing source to GitHub, and the legacy upload utility. |
| `lib/api-spec/openapi.json` | The API contract, generated by `scripts/create-valopay-spec.cjs` and served at `/api/v1/openapi.json`; every operation, parameter and schema is described. |
| `artifacts/api-server/src/fonts/README.md` | The typeface embedded in PDF exports and how to regenerate it. |
| `replit.md` | The Replit agent's notes: how to run and where things live, kept consistent with this file. |

## Vocabulary

- **Lender**: a customer of Valo Pay; a merchant in the API, the database and the domain code (`merchantId`). The console says lender.
- **Workspace**: one person's or one browser's set of lenders; a **sandbox** is a workspace of synthetic lenders, created on first visit for an anonymous browser. Nothing in any workspace is real.
- **Persona**: a simulated role (Admin, Operations, Finance, Compliance reviewer, Read-only) a workspace can switch between to exercise separation of duties; not a real permission.
- **Kobo and naira**: every amount is an integer in kobo (₦1 = 100 kobo); the console shows naira. **WAT** is West Africa Time, the zone every time is shown in.
- **Customer, mandate, due item, attempt**: a lender's customer, the authority to debit them, an instalment that is due, and one try at collecting it.
- **Observation, payment, allocation**: evidence of money received, the canonical payment it resolves to, and the matching of that payment to a due item.
- **Exception**: a case the catalogue says a person must work, with an owner, a deadline and controlled resolution codes.
- **Daily close**: the once-a-day run that fixes the books, records every retry decision and produces the REC-07 report; scheduled per lender, or run by hand.
- **Pack and gate**: a dispute pack is a customer's evidence as PDF, CSV and JSON; a gate is a production prerequisite or decision, always unproven on synthetic data.
- Requirement codes such as RET-03, REC-07 or NFR-OBS-02 refer to the Technical Requirements Document v1.1 that governs the scope.

## Prerequisites and installation

The current supported environment is Replit's Linux workspace with **Node.js 24**, **pnpm 10**, **PostgreSQL 16 or later**, managed Clerk authentication and private App Storage. `package.json` requires Node 22.22.2 or a later 22 release, 24.15.0 or a later 24 release, or 26 and later. That is the range jsdom 30 (the console tests' browser environment) supports, and it covers what undici 8 and orval 8 need; pnpm warns on an older Node. Its `packageManager` field pins pnpm 10.26.1, which a newer pnpm switches to by itself (fetching it once) and CI installs. CI runs every check on Node 24 and, so that the Node 22 range stays true, the TypeScript check and every offline suite on Node 22 too.

Reports has Operations, Billing and Pilot evidence views. Operations can filter recorded daily closes by inclusive West Africa Time dates and compare the first and latest closing positions in the range. Current totals and the current billing statement are not recalculated for that range. Missing historical measures remain unavailable; closing positions are never summed as collections.

The sandbox guide starts collapsed, can be opened on every console page and keeps personal progress separately for each lender in this browser. Exceptions, Mandates and Collections request server-filtered priority pages of 25, 50 or 100 rows. Search matches customer names and record references without case or accent sensitivity. Page, size and filters are lender-bound URL state, so browser Back and customer return links restore the queue. Saved views store the search and filters per lender in this browser; they do not store result rows.

Reconciliation requests six separate server-paged queues with complete totals and only the related records needed by each page. The allocation picker fetches a searchable page of instalments when opened. Precision review pages the seeded previous-month sample, including superseded allocations already reviewed as wrong. Reports request compact, server-filtered daily-close summaries; opening a close fetches its full evidence. Inclusive WAT date comparisons use the first and latest closes across the entire selected range, independent of the visible page. Current operational and billing measures remain unchanged.

```sh
pnpm install --frozen-lockfile
```

The lockfile currently excludes native binaries for several platforms other than Linux x64. A macOS/Windows installation may require a separately reviewed dependency portability change. GitHub stores the code; it does not host this application or automatically recreate the services.

### Configuration

Provide credentials through your environment's secret manager, never through committed files.

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection, server only |
| `VALOPAY_DATABASE_POOL_SIZE` | Optional; the database connections one API process may hold, a whole number from 2 to 100, default 10. One lender may use at most half of them, so two lenders busy at once can use them all; a larger pool leaves room for other tenants only while each busy lender has fewer requests in flight than half of it. Keep instances × size (plus one short-lived readiness connection per instance) within the database's connection limit. |
| `CLERK_SECRET_KEY` | Clerk server authentication/proxy |
| `CLERK_PUBLISHABLE_KEY` | Server-side Clerk configuration |
| `VITE_CLERK_PUBLISHABLE_KEY` | Frontend Clerk configuration for sign-in; on a local host without it the console runs the anonymous sandbox, sign-in links inside the console are hidden and `/sign-in` explains that sign-in is not available on this host |
| `PRIVATE_OBJECT_DIR` | Private App Storage location |
| `PORT` | Port for each process, supplied by its managed workflow |
| `BASE_PATH` | Frontend mount path, `/` for this application |
| `NODE_ENV` | Development or production behaviour |
| `VITE_CLERK_PROXY_URL` | Optional frontend Clerk proxy override |
| `LOG_LEVEL` | Optional server logging level |
| `LOG_FORMAT` | Optional; `pretty` prints the server log for a person (the default with `NODE_ENV=development`); `json`, or unset elsewhere, writes JSON lines for the host to collect |
| `LOG_FILE` | Optional; writes the server log synchronously to this file instead of stdout, for a test or a local run that reads it back |
| `VALOPAY_CLOSE_SCHEDULER` | Optional; `on` (the default) or `off`, in any case. `off` stops this API process from running the scheduled daily close, so closes run by hand or from the one-shot close pass (`docs/deployment.md`) |
| `VALOPAY_STAFF_ACCESS` | Unset or `off` keeps demo access; `staging` requires a provisioned organisation, named membership and verified MFA. Financial data remains synthetic. |
| `VALOPAY_STAFF_ISSUER` | Exact HTTPS Clerk issuer for staging staff sessions; required in staff mode |
| `VALOPAY_STAFF_ORIGINS` | Comma-separated HTTPS application origins allowed to use staging staff sessions; required in staff mode |
| `VALOPAY_RUNTIME_ISOLATION` | `staging` opts into the separately commissioned restricted database; unset or `off` leaves it disabled. Every transaction then compares the row-security policies, scope helpers and workspace guard with the reviewed set and answers 503 on any difference. |
| `VALOPAY_RUNTIME_SCHEMA` | Dedicated `valopay_runtime_staging_*` schema; public schemas are refused. |
| `VALOPAY_RUNTIME_ROLE` | Actual restricted database login expected by the runtime; elevated connections are refused. |
| `VALOPAY_RUNTIME_SERVICE_ORG` | Explicitly provisioned organisation for the background worker in isolated staging. |
| `VALOPAY_RUNTIME_SERVICE_USER` | Active service member whose lender grants constrain background work. |
| `VALOPAY_PAYLOAD_ENCRYPTION` | `kms` protects stored raw import and recovery payloads; unset or `off` retains legacy synthetic storage. Raw source rows are opened only by the views that show or use them. |
| `VALOPAY_KMS_KEY` | Google Cloud KMS CryptoKey resource name; Application Default Credentials supply key access. |
| `VALOPAY_KMS_PREVIOUS_KEYS` | Comma-separated prior CryptoKey names permitted to open historical envelopes. |
| `VALOPAY_PAYSTACK_INGRESS` | `test` turns on the signed Paystack test-event address `POST /api/v1/providers/paystack/{connectionId}/events` (see `docs/paystack.md`); unset or any other value answers 503 there. |
| `VALOPAY_PAYSTACK_CONNECTIONS` | Server-only JSON mapping from opaque 64-character hex connection IDs to existing workspace/lender IDs. |
| `VALOPAY_EXPIRED_WORKSPACE_CLEANUP` | `on` or `off`; unset is off. With `on`, which the deployment sets, each new anonymous sandbox deletes up to five sandboxes nobody has changed for 30 days (`docs/deployment.md`) |
| `VITE_PILOT_EMAIL` | Optional pilot enquiry address shown on the landing page; without it the page names no address |
| `CLERK_TELEMETRY_DISABLED` | `1` stops the Clerk SDK's telemetry and its plain-text notice on stdout; the deployment sets it, and every pilot host should |
| `VALOPAY_DEV_API_ORIGIN` | Optional; where the console's development server sends `/api` outside Replit, default `http://127.0.0.1:8080` |
| `VALOPAY_RUN_INTEGRATION` | Set to `1` to run the database-backed suites (`pnpm run test:integration`), never against a deployed database |
| `VALOPAY_RUN_RECOVERY` | With the above, `1` runs the measured backup and restore rehearsal on a loopback `valopay` database |
| `VALOPAY_REHEARSAL_REPORT` | Optional path where the recovery rehearsal writes its timings and counts |
| `VALOPAY_BROWSER_TEST` | Set to `1` by the browser test runner for its loopback fixture server; test only |
| `VALOPAY_BROWSER_DATABASE_TEST` | Set to `1` by the real-API browser runner for its test-only host; test only |
| `VALOPAY_BENCH_CUSTOMERS` | Optional size of the synthetic lender in the workflow benchmark suites |
| `VALOPAY_EXPORT_REPETITIONS` | Optional repetitions of the export step in the workflow benchmark suite |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Optional Chromium binary for both browser suites on a host without Playwright's own download |
| `PAYSTACK_TEST_SECRET_KEY` | An `sk_test_` key from the process environment. Read by `pnpm run check:paystack`, and by the API only while `VALOPAY_PAYSTACK_INGRESS` is `test`, to check the signatures of test events; never a live key |
| `VALOPAY_MONITOR_ORIGIN` | HTTPS origin probed by `pnpm run check:operations`; the other monitor settings are in `docs/operational-rehearsals.md` |
| `VALOPAY_MONITOR_EXPECT_SCHEDULER` | `on` when the probed host is expected to run automatic closes |
| `VALOPAY_MONITOR_OWNER` | Person or team responsible for responding to a monitor incident |
| `VALOPAY_MONITOR_STATE_FILE` | Private state file the monitor owns between runs |
| `VALOPAY_MONITOR_ALERT_URL` | Optional HTTPS receiver for monitor incidents and recoveries |
| `VALOPAY_ALERT_RESEND_KEY` | Optional email-provider key for monitor alerts |
| `VALOPAY_ALERT_FROM` | Verified sender address for monitor emails |
| `VALOPAY_ALERT_TO` | Recipient address for monitor emails; there is no default |

The API checks its settings once, when it starts, before anything reads them: a value outside its rule (an unknown `LOG_LEVEL`, a `PORT` above 65535, a pool size of 1, a scheduler switch other than `on` or `off`, staff access or the restricted runtime without their companions) stops it with one `config.invalid` line naming each setting, never its value (`docs/observability.md`).

The storage client obtains credentials from a **Replit sidecar**. Supplying storage paths alone will not make exports work outside Replit. External hosting requires a reviewed storage-authentication adapter, Clerk setup, PostgreSQL provisioning and same-origin routing for `/api/*` versus frontend assets; these are not implemented by this source transfer.

Exports are saved background jobs. Creating an export commits a queued record and returns its ID; the console shows queued, preparing, ready or failed status and restores recent jobs when you return. Two worker slots per API process generate and upload outside database transactions. A worker stopped by SIGTERM or SIGINT, for example when the host scales down or replaces the instance, returns its unfinished jobs to the queue, so the next worker resumes them at once; a stop never marks an export as failed. A job whose worker crashed or was killed, or could not return it before the process exited, keeps its five-minute claim lease and is recovered when the lease expires. Each job keeps one private object key; recovery verifies an existing object's ownership, size and SHA-256 before adopting it, including after a lost upload response or failed completion commit. Failed jobs can be retried from the console without creating a new file request. Ready files remain immutable, and status, retry and download endpoints all enforce workspace and lender ownership.

The export queue permits ten unfinished jobs per lender (another is refused with 429 and `Retry-After: 30`), examines at most twenty candidates per poll, and bounds each storage metadata/read/upload operation to sixty seconds. Sources and generated files are capped at 32 MB; oversized jobs fail with guidance to export a smaller category or customer pack. Downloads verify the checksum before returning bytes. Only ready exports count as generated packs. This needs a running API worker and configured private storage; the durability record alone does not provision storage or promise a completion time. The worker runs inside the API process, so queued exports wait while no instance is running: on a Replit Autoscale deployment that has scaled to zero, they start only when the next request starts an instance (`docs/deployment.md`). While the queue cannot be read, the worker logs that once and looks again less often, up to once a minute, until it answers.

For a **new, disposable development database only**, after reviewing the schema:

```sh
pnpm --filter @workspace/db run push
```

Do not point this command at production or an existing database without a reviewed migration plan. Startup and build commands must not run database DDL, and the Replit post-merge hook (`scripts/post-merge.sh`) only installs dependencies. See [the database security boundary](docs/DATABASE_SECURITY.md).

## Development

In Replit, use the existing managed API Server and Valo Pay workflows. They inject service ports and route the API and frontend under the same origin.

Outside Replit, run the same two commands on your own machine, each in its own terminal, with a disposable local PostgreSQL database that carries the pushed schema (above):

```sh
PORT=8080 DATABASE_URL=postgres://postgres@127.0.0.1:5432/valopay_dev pnpm --filter @workspace/api-server run dev
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/valopay run dev
```

Then open `http://localhost:5173/`. The console's development server passes `/api` to the API process (at `http://127.0.0.1:8080` unless `VALOPAY_DEV_API_ORIGIN` names another), so the browser stays on one origin, as Replit's router keeps it. Without Clerk keys the console runs the anonymous sandbox and hides sign-in. The API development command builds before starting and is not a file watcher; set `VALOPAY_CLOSE_SCHEDULER=off` to keep scheduled closes from running while you work.

The Replit development environment sets `VALOPAY_CLOSE_SCHEDULER=off` to prevent automatic closes while existing data is imported. Automatic expired-sandbox cleanup is off there too; the deployment turns it on (`VALOPAY_EXPIRED_WORKSPACE_CLEANUP=on` in `artifacts/api-server/.replit-artifact/artifact.toml`), so on the deployed host an anonymous sandbox nobody has changed for 30 days is deleted when new sandboxes are created, up to five each time (`docs/deployment.md`). Whether or not it is on, an anonymous sandbox nobody has changed for seven days stops taking scheduled closes (see Scheduled daily close).

### Operating

`GET /api/healthz` answers without a sandbox or a sign-in: the build, the start time, the uptime and what the close scheduler is doing. `GET /api/readyz` makes one bounded round trip to the database on its own connection, which also checks that every table and column this build needs is present, and answers 503 while either fails. A missing index a migration adds leaves the instance ready, with `checks.schema.status` `indexes_missing`, because every request still works, only slower; the log names what is missing and the migration that adds it, never the answer. The deployment's start-up health check is `/api/readyz`, so a build whose database lacks a table or column it needs does not go live. Apply `lib/db/migrations/007_journal_and_lender_indexes.sql` before deploying this build; `docs/database-migrations.md` is the procedure for every migration.

Every database transaction the API opens sets its own limits (`artifacts/api-server/src/lib/database-limits.ts`). A request waits at most 5 s for a lock and 5 s for a free connection, a statement runs for at most 15 s, and a transaction may stay idle between statements for at most 30 s. The scheduled close, Paystack test deliveries and other service transactions allow 30 s for a statement and 60 s idle; export jobs keep 5 s for a statement, 1 s for a lock and 5 s idle. One lender may occupy at most half of the process's connections; further requests for it wait up to 5 s without one. The cap is counted per workspace and lender, so naming another workspace's lender never takes that workspace's share. It limits a busy lender's effect on other tenants but does not remove it: two lenders busy at once can still fill the pool, and other requests then wait up to 5 s for a connection or are answered 503 (see `docs/DATABASE_SECURITY.md`). A persona, team or invitation change waits the same 5 s lock limit for the requests already running in its workspace, and requests that arrive meanwhile wait behind it. A request turned away is answered 503 with `Retry-After` and, when nothing was saved, `committed: false`. A connection the database ends, for example at the idle limit, fails that request only. Every answer carries `X-Request-Id` and every error body `requestId`; the console quotes it as the reference in a failure notice, and every log line of the request carries it. The log's lines and events, what to watch and how to trace a report are in `docs/observability.md`. On SIGTERM the process finishes the requests in flight and the lender close in progress, and returns any export in progress to the queue, before it exits; the rest of a scheduled pass runs after restart. The close scheduler and the export worker run inside the API process, so on a deployment that scales to zero they wait for the next request (see Scheduled daily close).

### Scheduled daily close

The API process runs each lender's daily close at its configured West Africa Time (`closeTime` in the lender settings, default 07:00, REC-01) unless `VALOPAY_CLOSE_SCHEDULER=off` or the lender's `scheduledCloseEnabled` is false. Every minute a pass reads the lenders whose server-owned `nextCloseAt` cursor has passed, in batches of 25, until none is left or 45 seconds have passed, and closes each in its own transaction through the scoped repository, taking the lender row with `SKIP LOCKED` so a request in flight is never delayed and two API processes never close the same lender twice. The order is fair: staff and signed-in lenders before anonymous sandboxes; within each, lenders being retried come after the rest, then one lender per workspace per turn, then the earliest time. A stop ends the pass after the lender close in progress, and the rest close after restart. Every close, scheduled or manual, moves the cursor to the next configured time, so a manual close after a missed time counts as the catch-up. A close that starts more than 30 minutes after its time is recorded as late, a scheduled time that old with no close raises the `close_missed` alert, and a close missed while the process was down runs at the first tick after it starts (NFR-AVA-02).

A scheduled close that fails is retried after 2, 4, 8, 16 and 32 minutes, then hourly, so a lender that keeps failing never holds the others back. The lender records the retry as `settings.closeRetry` for that pending time: the number of failed attempts and when the next is due, never the error text, which stays in the log. The close stays pending, and is missed after 30 minutes, until an attempt succeeds or a person closes; any close clears the retry. An anonymous sandbox older than seven days that nobody has changed for seven days has its automatic close switched off by the scheduler instead of closed, with an audit entry by `System · scheduled close`; the console explains the pause, and switching the close on again in Settings restarts it from the next configured time. A sandbox holds at most five lenders, the two samples included, so one visitor cannot fill the queue. Lenders created before the scheduler existed receive a cursor at their next configured time without a close. The scheduler's audit entries carry the actor `System · scheduled close` and never count as sandbox activity, neither for the seven-day pause nor for the 30-day expiry sweep.

The scheduler and the export worker run inside the API process, not as a separate scheduled job. `.replit` publishes to Replit Autoscale, which scales an idle deployment down to no instances, and while no instance runs nothing ticks: a scheduled close waits for the first tick after the next request starts an instance, and is recorded as late when that is more than 30 minutes after its time, and queued exports wait for that request too. The per-address request and new-sandbox limits are counted in each instance's memory, so they multiply with instances and start again when one starts. Closes run on time in either of two ways, and which to use is the owner's decision (`docs/deployment.md`):

- a Replit Reserved VM, which stays up and is billed while it runs, with the in-process scheduler on; or
- Autoscale with `VALOPAY_CLOSE_SCHEDULER=off` and a Replit Scheduled Deployment that runs the one-shot close pass every 15 minutes: `node --enable-source-maps artifacts/api-server/dist/close-pass.mjs` after `pnpm --filter @workspace/api-server run build`. It runs the due closes once, through the same pass, and exits 0 when all ran, 2 when a close failed and waits for its retry, and 1 when it could not run.

## Checks and builds

### Pilot preparation

`docs/paystack.md` covers the Paystack test adapter, the connection check and the optional signed test ingress: the address to register with a Paystack test account, its configuration and its answers. The API reads `PAYSTACK_TEST_SECRET_KEY` only while `VALOPAY_PAYSTACK_INGRESS` is `test`, and checks each delivery's signature on its raw bytes before it locks or reads a lender. Received events are test evidence only: there is no charging method, live-mode events are refused, and Direct Debit availability in test mode must still be confirmed separately.

`docs/pilot-security.md` covers the access and MFA check every staff request passes when `VALOPAY_STAFF_ACCESS` is `staging`, and the tenant-bound field-encryption helpers. `docs/pilot-database.md` covers the restricted runtime's row-level-security rehearsal and disposable-database tests, and `docs/pilot-operations-controls.md` the restricted runtime `VALOPAY_RUNTIME_ISOLATION=staging` opts into. Each is off unless configured, and none of them opens the sandbox to real customer data or live instructions.

These checks need no production credentials or running services and do not write to a runtime database:

```sh
pnpm run typecheck
pnpm run check:db-boundary
pnpm run test:pure
pnpm run test:golden
```

`typecheck` covers the API tests and the console tests as well as their sources (`artifacts/api-server/tsconfig.tests.json`, `artifacts/valo-pay/tsconfig.tests.json`), so a test that drifts from a domain signature or a contract type fails before it runs. Record data is typed per kind: `lib/valopay-schema/src/records.ts` declares every kind's fields, the ones a caller may supply and the ones the platform sets, including the kinds only the platform's workflows write (`domainRecordKinds` in `lib/valopay-schema/src/kinds.ts`, which the record API neither lists nor edits), and the API's `recordsOf`, `findRecord` and `makeRecord` return `TypedRecord<K>` views of that type for a kind given as a literal, so a misspelt or mistyped field is a compile error rather than an `any`. Declare a field there before reading or writing it.

`test:pure` runs the checks that need no database and no browser: the source-snapshot safeguards, the repository's in-memory guards and audit checks, the download-stream tests, the security checks (`artifacts/api-server/tests/api-security.test.ts`, reviewed in `docs/security-review.md`), the contract checks (`api-contract.test.ts`: the error body and statuses each operation lists, the Idempotency-Key each write takes and one 400 for a missing `merchantId`; `answer-schemas.test.ts`: the shared answer schemas against every connected action, pilot progress and the close review list as the domain builds them), the internationalisation checks (`i18n.test.ts`: the accent-folding search, the count helper, the dispute pack's embedded typeface, the byte order mark on CSV downloads), the observability checks (`observability.test.ts`: request ids, the log's events, liveness and readiness, reviewed in `docs/observability.md`), the pilot security, pilot workflow, Paystack, connected-workspace, runtime-isolation-policy and database-limit checks, the canonical JSON and record kind checks (`canonical-json.test.ts` and `canonical-json-golden.test.ts`: every digest form against the helper it replaced and the stored digests of a fixed lender; `record-kinds.test.ts`: every stored kind declared with a schema), the documentation check (`scripts/check-docs.mjs`, reviewed in `docs/documentation-review.md`), the operator commands run offline (`scripts/operator-commands.test.mjs`: the monitor, the Paystack check, provision-pilot's three modes, and the smoke and security scripts' host guard), the build and test tooling (`scripts/tooling.test.mjs`: the build stamp, the integration runner, the migration rehearsals' skips and the recovery rehearsal's refusal under CI), the start-up settings check (`startup-config.test.ts`) and the one-shot close pass (`close-pass.test.ts`). The store test supplies an unusable loopback database URL for module initialisation; it does not connect to a database.

`pnpm --filter @workspace/valopay run test` runs the console tests (`artifacts/valo-pay/tests`, Vitest with jsdom and Testing Library). They render the real console at a route, with the same providers, layout and pages production mounts, against an in-memory API (`tests/fake-api.ts`) that serves the console's routes from seeded lender state using the API's own domain code (seed, validation, actions, reconciliation, reports, paging) and validates every response with the same zod contract the server uses, so a page is tested against what the API actually returns, with no database or server. What the fake stands in for is documented at the top of that file. The covered flows:

- The landing page (its first three lines, its links, and that visiting it or the sign-in pages asks the API for nothing until someone opens the sandbox); the sign-in pages without Clerk; the not-found page for an unknown address (no sandbox is created) and for a customer the lender does not have.
- The fallback for a page that stops working (inside the console the sidebar stays); the workspace failing to load (a refused sandbox, an unreachable service, a service error with its reference) with Try again; the loading status of the workspace, of a page and of a table; the busy state of a button while its action runs.
- The empty states of a table and a list, with the next step where one exists, and a search or filter with no matches; a form's missing values named at their fields with focus and an alert, and the server's refusal placed under the field it names; a problem notice that stays until dismissed, with the request's reference when the service failed, and a done notice with its Open action.
- The skip link, focus after navigation, the current-page marking, the arrow-key filter tabs and the "/" search shortcut; the navigation's named groups, daily work first, with every page reachable and a label and icon of its own; the phone layout's drawer (the same pages, groups and lender as the sidebar, opening on the current page, closing after a choice with focus on the page content, Escape returning focus to its button).
- The theme (following the device, a stored choice winning over it, the Appearance radios on the settings page and the page shell's inline rule); the print markup (the chrome marked to leave the page, the provenance lines with the lender and the printed time, the settings help kept off paper).
- An axe-core pass over every page and the dialog and form states (names, roles, labels, headings, landmarks and ARIA; contrast and geometry are checked in a browser); the page loader (a page's code fetched once and rendered at once on a later visit, the page-error notice when it cannot be fetched); the query staleness and the typeface links.
- The market's conventions: the page's language, every timestamp in West Africa Time with its zone named, a day shown as a day, counts with their nouns, names with their marks shown and found without them.
- The overview alerts and next close; running a daily close from the reports page and reading its REC-07 chips; editing the close time and seeing the server's rejection; exception filters; the customer timeline and dispute pack export; lender switching and navigation; audit verification and the formatters.

`test:golden` runs the golden tests for the shared schema, the retry engine, reconciliation, measurement, the close schedule and the dispute pack (`artifacts/api-server/tests/*-golden.test.ts` and `dispute-pack.test.ts`). They pin the TRD v1.1 acceptance behaviour in section 10.4: the three-source replay in every order, duplicate evidence, settlement batches that follow their lines and statement credit when a provider file arrives in parts (ING-03, ING-07), the allocation ceiling, the notice clock, quiet hours, execution windows, attempt ceilings across sources, stable assignment and kill switches; plus the recorded retry decision (RET-03), the daily close report and the matches it counts (REC-07), the uplift report's 90% interval and pre-registered rule (RET-06), billable collections (BIL-01), invoices with VAT and post-invoice adjustment lines (BIL-04, BIL-07), the paginated dispute pack with its CSV and JSON (AUD-02, AUD-06) and the scheduled close's WAT arithmetic, cursor, lateness and missed-close alert (REC-01). `pnpm test` (`scripts/run-tests.mjs`) runs the offline tests in one go: those of `test:pure` and `test:golden`, `pnpm run test:operations`, the database-boundary and documentation checks, the monitor's delivery rehearsal and the console tests. It does not run `pnpm run typecheck`, `pnpm run check:contract`, the builds, the dependency audits or the browser suites; run those as well, or let CI.

### GitHub pull-request checks

The local `.github/workflows/ci.yml` definition is configured to run on pull requests, on pushes to `main` and every Monday at 05:00 UTC on `main`, so a new advisory in either dependency audit surfaces without waiting for a pull request. It uses Ubuntu 24.04, Node.js 24 (and 22 in its own job) and pnpm 10.26.1 (the `packageManager` pin), with every action pinned to a full commit and its release named in a comment, and the PostgreSQL service image pinned by digest. A newer push to a pull request cancels that pull request's running checks; a run for `main` is never cancelled once started. These jobs run in parallel:

- **TypeScript, database boundary and pure tests** installs with `pnpm install --frozen-lockfile`; audits the API's production packages (`pnpm audit --prod --audit-level=high`) and every package, the console's included (`pnpm audit --audit-level=high`), failing on a high or critical advisory; checks the committed contract against its generator (`pnpm run check:contract`); runs the four commands above, `pnpm run test:operations`, the monitor's delivery rehearsal, the workflow measurements and the console tests; and builds every package (`pnpm -r --if-present run build`: the API bundle with the one-shot close pass, the console and the mockup sandbox; the console build needs no Clerk key, see the environment table).
- **Browser workflows (desktop-chromium)**, **(mobile-chromium)**, **(desktop-firefox)** and **(mobile-webkit)** each build the console and run one Playwright project, so a slow spec or its retry cannot push another job past its timeout. Each restores its browser from the cache, keyed on the Playwright version, instead of downloading it, and keeps the report and traces for seven days when a test fails.
- **TypeScript and offline tests on Node 22** runs `pnpm run typecheck` and `pnpm test` on Node 22, the other release `engines` admits.
- **Repository and scheduler tests on PostgreSQL** starts a PostgreSQL 16 service container that exists only for the job, creates the schema in it with the development push (`pnpm --filter @workspace/db run push`), runs `pnpm run test:integration` against it (the suites listed under Builds and integration checks, the runtime isolation rehearsal among them), then the measured backup and restore rehearsal, even when a suite failed, keeping the recovery report for 14 days; the job fails if the report is missing, and under CI the rehearsal fails rather than passing when its opt-ins are missing. The container is discarded with the runner.
- **Browser workflows on the real API and PostgreSQL** serves the built console with the real Express middleware, routes and repository, using a separate disposable PostgreSQL database, in Chromium. It checks anonymous bootstrap, history pages and complete balances, lender isolation, reconciliation search, a reasoned rejection and persistence after reload. The test host requires explicit opt-in flags and a loopback database named `valopay_browser_test`; its fixture route is never part of the application bundle.

Every job has read-only repository permissions and no application secrets. None publishes, deploys or migrates a real database. The export-stream suite still needs App Storage credentials, and the deployment smoke/security scripts still need the Replit development domain and Clerk. The workflow must first be committed to GitHub through an account with workflow-write permission; source sync with `--skip-workflows` does not install or enable it.

The checks report failures on the pull request, but no branch is protected, so a failing check does not block a merge until the repository owner adds a branch rule; this workflow cannot change repository settings. The recommended rule, for `main` and any release branch, requires pull requests and these status checks, each by its name as GitHub shows it: **TypeScript, database boundary and pure tests**; **Browser workflows (desktop-chromium)**, **Browser workflows (mobile-chromium)**, **Browser workflows (desktop-firefox)** and **Browser workflows (mobile-webkit)**; **TypeScript and offline tests on Node 22**; **Repository and scheduler tests on PostgreSQL**; and **Browser workflows on the real API and PostgreSQL**.

### Builds and integration checks

Build the complete workspace with frontend configuration supplied:

```sh
PORT=5173 BASE_PATH=/ pnpm run build
```

API output is `artifacts/api-server/dist`; frontend output is `artifacts/valo-pay/dist/public`. The console builds without a Clerk key: the browser resolves one at run time, from `VITE_CLERK_PUBLISHABLE_KEY` when the build was given it, otherwise from the serving host on Replit, and on a local host without one the console runs the anonymous sandbox (see the environment table).

The following checks create **fresh synthetic development fixtures**. They are not production startup/build commands:

```sh
pnpm run test:security-api
pnpm run test:smoke
VALOPAY_RUN_INTEGRATION=1 pnpm run test:integration
NODE_ENV=development VALOPAY_RUN_INTEGRATION=1 \
  node --expose-gc --import ./scripts/node_modules/tsx/dist/loader.mjs \
  artifacts/api-server/tests/export-streams.integration.test.ts
```

`test:integration` (`scripts/run-integration-tests.mjs`) refuses to run without `VALOPAY_RUN_INTEGRATION=1` and a `DATABASE_URL`, sets `NODE_ENV=development` unless set, and runs these suites in turn, each `artifacts/api-server/tests/<name>.integration.test.ts`: `source-close-controls`, `staff-lender-access`, `runtime-isolation`, `operations-controls`, `pilot-workflow`, `api-contract` (every console-facing operation's answers checked against the published contract), `connected-workflows`, `record-index-migration`, `pilot-workflow-migration`, `valopay-store` (the repository), `close-scheduler` (the one-shot close pass included), `pilot-administrators` (the operator's provisioning, second administrator and renewal), `record-lists` (list paging), `priority-queues`, `console-read-models`, `workspace-concurrency`, `export-jobs` and `workflow-performance`. It runs every suite whatever the ones before it did, then names the ones that failed and exits 1. The documentation check fails when the runner gains a suite this list does not name. The database must be disposable and carry the pushed schema, under any name. The two migration rehearsals (`record-index-migration` and `pilot-workflow-migration`) also build throwaway databases beside it, named after it (`<name>_index_rehearsal_<random>`), so they need a loopback PostgreSQL (`127.0.0.1`, `localhost` or `::1`) whose login can create databases; elsewhere, for example on Replit's managed development database, they skip and say why, and under CI, where they must run, that is a failure. The pull-request workflow runs the same command against its own PostgreSQL service container.

The HTTP suites require Replit's `REPLIT_DEV_DOMAIN` and refuse, before they send anything, any host that is not a `*.replit.dev` development domain. Never use real lender data for tests.

The API contract is generated, never edited by hand: change `scripts/create-valopay-spec.cjs`, run it to rewrite `lib/api-spec/openapi.json`, then regenerate the zod validators and the typed client from it. The generated packages (`lib/api-zod/src/generated`, `lib/api-client-react/src/generated`) are written by this command and nothing else:

```sh
node scripts/create-valopay-spec.cjs
pnpm --filter @workspace/api-spec run codegen
```

`pnpm run check:contract` runs the same two commands and fails when git then sees any difference under `lib/api-spec`, `lib/api-zod` or `lib/api-client-react`, naming the fix; CI runs it on every pull request.

## Making a change

- A rule lives in `lib/valopay-schema` (statuses, catalogues, money and policy guardrails) or in `artifacts/api-server/src/domain`; add a golden case when one changes. A record field is declared in `lib/valopay-schema/src/records.ts` before it is read or written.
- An API change starts in `scripts/create-valopay-spec.cjs` and ends with the regeneration above, which `pnpm run check:contract` confirms; the route checks its answer with `contractAnswer` (`artifacts/api-server/src/lib/contract.ts`) before COMMIT, against the generated zod schema or, for a pilot, team, operations or connected answer, the shared schema in `lib/valopay-schema` that the generator describes the component from.
- A console change keeps `docs/frontend-contract.md` true and adds or amends a console test; a change to how a page looks or behaves records its reasoning in `docs/design/console.md`.
- A new environment variable is read in one place and documented in the table above; a new document is listed in the Documentation table and in the snapshot tool's list; a new log `event` gets its row in `docs/observability.md`; a new integration suite is named under Builds and integration checks; the documentation check fails otherwise.
- British spelling in every document and in the console; lender, not merchant, in anything a person reads.
- Before pushing: `pnpm run typecheck`, `pnpm test`, `pnpm run check:contract` and the builds. A pull request runs those in CI too, and more: both dependency audits, the four browser projects, the database suites, the real-API browser suite and the Node 22 checks (GitHub pull-request checks, above).

## GitHub syncing

The Replit-side procedure for publishing source to the public `obeidpeter/valo-pay` repository, the pre-push guard, the workflow allow-list and the legacy source-only upload utility are in `docs/github-sync.md`. In a fresh clone from GitHub, ordinary Git commits and pushes are the way to work.

## Browser regression checks

After building the console, install the test engines with `pnpm --filter @workspace/valopay exec playwright install chromium firefox webkit`, then run `pnpm --filter @workspace/valopay run test:browser`. A loopback-only synthetic HTTP server supports desktop Chromium/Firefox and phone Chromium/WebKit layouts: queue search and empty states, paging, saved views, customer return links, browser Back, daily-close dates and lazy evidence, and reasoned match rejection; and a whole-page axe sweep of every route at both widths with the best-practice landmark rules. These are browser-engine checks, not physical-device tests.

For the real API browser suite, create the schema in a fresh local PostgreSQL database named `valopay_browser_test`, set `DATABASE_URL` to that database on `127.0.0.1`, build the console, then run `pnpm --filter @workspace/valopay run test:browser:database` (with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` on a host without Playwright's own Chromium, as for the other suite). The configuration supplies `VALOPAY_BROWSER_DATABASE_TEST=1` and `VALOPAY_RUN_INTEGRATION=1` to the test-only server. Every test creates a separate synthetic workspace; discard the test database afterwards. Placeholder Clerk keys exercise signed-out middleware locally. This suite does not verify signed-in sessions, external providers or production deployment. CI runs it in a disposable PostgreSQL service and retains failure traces and screenshots for seven days.

Customer history uses independent server pages for events, mandates, instalments and payments. Counts and balances always use the full customer record, and dispute-pack exports retain the full history. Reconciliation search checks customer names and linked payment/instalment references before counting and paging; precision audit measures continue to describe the entire sample. An unmatched search is labelled as such and clearing it preserves the selected filters.
