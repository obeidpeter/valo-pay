# Valo Pay

Observation-first collections operations for Nigerian lenders. This application is a **synthetic sandbox**, not a live payment service or an approved system for real customer data.

## Source repository

This repository contains a clean snapshot of the application, not the original Replit conversation/checkpoint history. Credentials, databases, stored exports, local agent notes, original business-plan attachments and environment-specific verification reports are deliberately excluded. Replit runtime configuration is included; it contains configuration, not provisioned services or credentials.

## Project structure

- `artifacts/valo-pay` — React + Vite operations console. Its landing page (`/`) and sign-in pages are designed against Nielsen's usability heuristics and the interaction-design principles recorded in `docs/design/landing-and-login.md`; the console's overview is at `/overview`.
- `artifacts/api-server` — Express API, scoped repository, domain logic and tests. When explicitly enabled, cleanup removes anonymous sandboxes after 30 days without a change; their creation is rate-limited per address, and list endpoints page with `limit`, `offset` and `updatedSince`.
- `artifacts/mockup-sandbox` — existing design/component preview workspace. It carries its own variant of the UI kit (different tokens and hover treatment from the console), so the two `components/ui` trees are intentionally not shared.
- `lib` — PostgreSQL/Drizzle schema, the OpenAPI contract (`lib/api-spec/openapi.json`, written by `node scripts/create-valopay-spec.cjs`), generated API packages and `lib/valopay-schema`, the shared per-kind schema (statuses, state machines, failure-code and exception catalogues, money and policy guardrails) that the API validator and the console both import.
- `scripts` — development checks and source synchronization utilities.
- `docs` — selected implementation and security documentation.

Keep the workspace together: the frontend and API depend on shared packages.

## Prerequisites and installation

The current supported environment is Replit's Linux workspace with **Node.js 24**, **pnpm 10**, PostgreSQL, managed Clerk authentication and private App Storage. `package.json` requires Node 22 or later; CI runs on Node 24 with pnpm 10.26.1.

```sh
pnpm install --frozen-lockfile
```

The lockfile currently excludes native binaries for several platforms other than Linux x64. A macOS/Windows installation may require a separately reviewed dependency portability change. GitHub stores the code; it does not host this application or automatically recreate the services.

### Configuration

Provide credentials through your environment's secret manager, never through committed files.

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection, server only |
| `CLERK_SECRET_KEY` | Clerk server authentication/proxy |
| `CLERK_PUBLISHABLE_KEY` | Server-side Clerk configuration |
| `VITE_CLERK_PUBLISHABLE_KEY` | Frontend Clerk configuration for sign-in; on a local host without it the console runs the anonymous sandbox, sign-in links inside the console are hidden and `/sign-in` explains that sign-in is not available on this host |
| `PRIVATE_OBJECT_DIR` | Private App Storage location |
| `PUBLIC_OBJECT_SEARCH_PATHS` | App Storage public search locations |
| `PORT` | Port for each process, supplied by its managed workflow |
| `BASE_PATH` | Frontend mount path, `/` for this application |
| `NODE_ENV` | Development or production behavior |
| `VITE_CLERK_PROXY_URL` | Optional frontend Clerk proxy override |
| `LOG_LEVEL` | Optional server logging level |
| `VALOPAY_CLOSE_SCHEDULER` | Optional; `off` stops this API process from running the scheduled daily close, so closes must be triggered by hand |
| `VALOPAY_EXPIRED_WORKSPACE_CLEANUP` | Optional; `on` allows new anonymous workspace bootstrap to delete a small batch of expired anonymous workspaces; unset or any other value keeps automatic cleanup off |

The storage client obtains credentials from a **Replit sidecar**. Supplying storage paths alone will not make exports work outside Replit. External hosting requires a reviewed storage-authentication adapter, Clerk setup, PostgreSQL provisioning and same-origin routing for `/api/*` versus frontend assets; these are not implemented by this source transfer.

For a **new, disposable development database only**, after reviewing the schema:

```sh
pnpm --filter @workspace/db run push
```

Do not point this command at production or an existing database without a reviewed migration plan. Startup and build commands must not run database DDL, and the Replit post-merge hook (`scripts/post-merge.sh`) only installs dependencies. See [the database security boundary](docs/DATABASE_SECURITY.md).

## Development

In Replit, use the existing managed API Server and Valo Pay workflows. They inject service ports and route the API and frontend under the same origin.

The underlying commands are:

```sh
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/valopay run dev
```

Each process needs its own `PORT`; the frontend also needs `BASE_PATH`. The API development command builds before starting and is not a file watcher. Outside Replit, two independent localhost ports alone do not reproduce the same-origin routing.

The Replit development environment sets `VALOPAY_CLOSE_SCHEDULER=off` to prevent automatic closes while existing data is imported. Automatic expired-workspace cleanup is also off by default; enable `VALOPAY_EXPIRED_WORKSPACE_CLEANUP=on` only after confirming that eligible anonymous workspace data may be deleted.

### Scheduled daily close

The API process runs each lender's daily close at its configured West Africa Time (`closeTime` in the lender settings, default 07:00, REC-01) unless `VALOPAY_CLOSE_SCHEDULER=off` or the lender's `scheduledCloseEnabled` is false. Every minute it reads the lenders whose server-owned `nextCloseAt` cursor has passed and closes each in its own transaction through the scoped repository, taking the lender row with `SKIP LOCKED` so a request in flight is never delayed and two API processes never close the same lender twice. Every close, scheduled or manual, moves the cursor to the next configured time, so a manual close after a missed time counts as the catch-up. A close that starts more than 30 minutes after its time is recorded as late, a scheduled time that old with no close raises the `close_missed` alert, and a close missed while the process was down runs at the first tick after it starts (NFR-AVA-02). Lenders created before the scheduler existed receive a cursor at their next configured time without a close. The scheduler's audit entries carry the actor `System · scheduled close` and never count as sandbox activity for the 30-day expiry sweep.

## Checks and builds

These checks need no production credentials or running services and do not write to a runtime database:

```sh
pnpm run typecheck
pnpm run check:db-boundary
pnpm run test:pure
pnpm run test:golden
```

`typecheck` covers the API tests and the console tests as well as their sources (`artifacts/api-server/tsconfig.tests.json`, `artifacts/valo-pay/tsconfig.tests.json`), so a test that drifts from a domain signature or a contract type fails before it runs. Record data is typed per kind: `lib/valopay-schema/src/records.ts` declares every kind's fields, the ones a caller may supply and the ones the platform sets, and the API's `recordsOf`, `findRecord` and `makeRecord` return `TypedRecord<K>` views of that type for a kind given as a literal, so a misspelt or mistyped field is a compile error rather than an `any`. Declare a field there before reading or writing it.

`test:pure` explicitly runs the source-snapshot safeguards, in-memory store guards/audit checks, and download-stream tests. The store test supplies an unusable loopback database URL for module initialization; it does not connect to a database.

`pnpm --filter @workspace/valopay run test` runs the console tests (`artifacts/valo-pay/tests`, Vitest with jsdom and Testing Library). They render the real console at a route, with the same providers, layout and pages production mounts, against an in-memory API (`tests/fake-api.ts`) that serves the console's routes from seeded lender state using the API's own domain code (seed, validation, actions, reconciliation, reports, paging) and validates every response with the same zod contract the server uses. A page is therefore tested against what the API actually returns, with no database or server: the covered flows include the landing page (its first three lines, its links, and that visiting it or the sign-in pages asks the API for nothing until someone opens the sandbox), the sign-in pages without Clerk, the not-found page for an unknown address (no sandbox is created) and for a customer the lender does not have, the fallback for a page that stops working (inside the console the sidebar stays), the workspace failing to load (a refused sandbox, an unreachable service, a service error) with Try again, the loading status of the workspace, of a page and of a table, and the busy state of a button while its action runs, the empty states of a table and a list (with the next step where one exists) and a search or filter with no matches, a form's missing values named at their fields with focus and an alert and the server's refusal placed under the field it names, a problem notice that stays until dismissed and a done notice with its Open action, the skip link, focus after navigation, the current-page marking, the arrow-key filter tabs and the "/" search shortcut, the phone layout's drawer (the same pages and lender as the sidebar, closing after a choice with focus on the page content, Escape returning focus to its button), the theme (following the device, a stored choice winning over it, the Appearance radios on the settings page and the page shell's inline rule), the print markup (the chrome marked to leave the page, the provenance lines with the lender and the printed time, the settings help kept off paper), an axe-core pass over every page and the dialog and form states (names, roles, labels, headings, landmarks and ARIA; contrast and geometry are checked in a browser), the overview alerts and next close, running a daily close from the reports page and reading its REC-07 chips, editing the close time and seeing the server's rejection, exception filters, the customer timeline and dispute pack export, lender switching and navigation, audit verification and the formatters. What the fake stands in for is documented at the top of that file.

`test:golden` runs the golden tests for the shared schema, the retry engine, reconciliation, measurement, the close schedule and the dispute pack (`artifacts/api-server/tests/*-golden.test.ts` and `dispute-pack.test.ts`). They pin the TRD v1.1 acceptance behaviour in section 10.4: the three-source replay in every order, duplicate evidence, the allocation ceiling, the notice clock, quiet hours, execution windows, attempt ceilings across sources, stable assignment and kill switches; plus the recorded retry decision (RET-03), the daily close report (REC-07), the uplift report's 90% interval and pre-registered rule (RET-06), billable collections (BIL-01), invoices with VAT and post-invoice adjustment lines (BIL-04, BIL-07), the paginated dispute pack with its CSV and JSON (AUD-02, AUD-06) and the scheduled close's WAT arithmetic, cursor, lateness and missed-close alert (REC-01). Add a golden case whenever a rule in `lib/valopay-schema` or `artifacts/api-server/src/domain` changes, and a console test whenever a page's behaviour changes. `pnpm test` runs every offline check above, the console tests included, in one go.

### GitHub pull-request checks

The local `.github/workflows/ci.yml` definition is configured to run on pull requests and pushes to `main`, using Ubuntu 24.04, Node.js 24 and pnpm 10.26.1, with two jobs that run in parallel:

- **TypeScript, database boundary and pure tests** installs with `pnpm install --frozen-lockfile`, runs the four commands above and the console tests, then builds the API bundle and the console (the console build needs no Clerk key; see the environment table).
- **Repository and scheduler tests on PostgreSQL** starts a PostgreSQL 16 service container that exists only for the job, creates the schema in it with the development push (`pnpm --filter @workspace/db run push`), and runs `pnpm run test:integration` against it: the repository suite (workspace bootstrap, locking, rollback, idempotency, expiry sweep) and the scheduled-close suite. The container is discarded with the runner.

Both jobs have read-only repository permissions and no application secrets. Neither publishes, deploys or migrates a real database, and neither runs the export-stream suite (it needs App Storage credentials) or the HTTP suites (they need the Replit development domain and Clerk). The workflow must first be committed to GitHub through an account with workflow-write permission; source sync with `--skip-workflows` does not install or enable it.

The checks report failures on the pull request. Enforcing a merge block requires a GitHub branch rule that requires **TypeScript, database boundary and pure tests** and **Repository and scheduler tests on PostgreSQL**; this workflow does not change repository protection settings.

### Builds and integration checks

Build the complete workspace with frontend configuration supplied:

```sh
PORT=5173 BASE_PATH=/ pnpm run build
```

API output is `artifacts/api-server/dist`; frontend output is `artifacts/valo-pay/dist/public`. A working frontend build also needs the Clerk publishable key supplied by the environment.

The following checks create **fresh synthetic development fixtures**. They are not production startup/build commands:

```sh
pnpm run test:security-api
pnpm run test:smoke
VALOPAY_RUN_INTEGRATION=1 pnpm run test:integration
NODE_ENV=development VALOPAY_RUN_INTEGRATION=1 \
  node --expose-gc --import ./scripts/node_modules/tsx/dist/loader.mjs \
  artifacts/api-server/tests/export-streams.integration.test.ts
```

`test:integration` (`scripts/run-integration-tests.mjs`) refuses to run without `VALOPAY_RUN_INTEGRATION=1` and a `DATABASE_URL`, sets `NODE_ENV=development` unless set, and runs the repository suite and the scheduled-close suite in turn. The database must be disposable and carry the pushed schema; the pull-request workflow runs the same command against its own PostgreSQL service container.

The HTTP suites require Replit's `REPLIT_DEV_DOMAIN`. Never use real lender data for tests.

Regenerate shared clients and validators after API contract changes:

```sh
pnpm --filter @workspace/api-spec run codegen
```

## GitHub syncing

This Replit workspace uses a clean `main` branch linked to `origin/main` at
`https://github.com/obeidpeter/valo-pay`. In the Git panel, use **main** and
**origin** for normal commits, pulls and pushes.

The original Replit checkpoint history is preserved separately on the local
`replit-history-local` branch. **Never push that branch, all branches, or a
mirror of this repository.** It contains local-only material. Internal Replit
remotes are not GitHub sync destinations. Business attachments, agent notes
and local verification reports remain on disk but are excluded from the clean
branch. Review staged files before committing: this is a public repository.

A local Git pre-push guard checks outgoing commit ancestry and source files.
Do not disable it or bypass it with `--no-verify`. The guard does not replace
reviewing content for private information.

### Legacy source-only upload utility

The source-only utility remains available for workspaces with the original
private checkpoint history. It is not needed for the linked clean `main`
branch. Do not alternate it with normal Git pushes without reconciling the
local branch and its separate synchronization state first.

```sh
# Track any newly added source files explicitly first:
git add path/to/new-source-file

# Inspect the source-only file list; no network writes:
node scripts/github-sync.mjs

# After reviewing that list, upload the current source:
node scripts/github-sync.mjs --push
```

The utility targets only the public `obeidpeter/valo-pay` repository, as approved by its owner. Public means anyone can read the uploaded source. It sends reviewed source contents, never Git history or credentials, through the Replit GitHub connector. It checks common secret patterns but cannot prove arbitrary content is safe: review new files before uploading.

The Git panel and this script use different authentication paths. A working
GitHub connector does not by itself verify Git panel authentication. Check
that the panel targets `origin` and the clean `main` branch before attempting
to reconnect an account.

Only `.github/workflows/ci.yml` is approved for workflow export. Other workflows and local GitHub actions remain excluded until individually reviewed and added to the allowlist.

The current connector does not offer GitHub's separate workflow-write permission. To sync source while explicitly leaving workflow updates pending:

```sh
node scripts/github-sync.mjs --skip-workflows
node scripts/github-sync.mjs --push --skip-workflows
```

This option preserves existing remote workflow files unchanged and reports pending local workflow changes. It never silently deletes a workflow. Commit the reviewed CI file through GitHub's website, or use a separately authorized clean clone, to enable/update it. An independently created GitHub commit still requires reconciliation before the next source upload. Unchanged workflow blobs are reused, not rewritten.

Updates use ignored local synchronization state from the previous successful upload. In a workspace without that state, the utility can initialize it only when all selected local source files already match GitHub exactly; otherwise it stops for manual reconciliation. This allows a merged task's main workspace to establish its baseline safely. If GitHub has changed independently, the utility stops rather than overwriting changes; it never force-pushes and also refuses remote file deletions. Authentication failures should be repaired through the GitHub connection, not by pasting tokens into code.

In a **fresh clone from GitHub**, normal Git commits/pushes are safe to use because the clone contains only the clean repository history. Reconcile changes made there before uploading another snapshot from the original Replit workspace.