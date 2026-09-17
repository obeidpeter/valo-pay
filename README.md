# Valo Pay

Observation-first collections operations for Nigerian lenders. This application is a **synthetic sandbox**, not a live payment service or an approved system for real customer data.

## Source repository

This repository contains a clean snapshot of the application, not the original Replit conversation/checkpoint history. Credentials, databases, stored exports, local agent notes, original business-plan attachments and environment-specific verification reports are deliberately excluded. Replit runtime configuration is included; it contains configuration, not provisioned services or credentials.

## Project structure

- `artifacts/valo-pay` — React + Vite operations console.
- `artifacts/api-server` — Express API, scoped repository, domain logic and tests.
- `artifacts/mockup-sandbox` — existing design/component preview workspace.
- `lib` — PostgreSQL/Drizzle schema, OpenAPI contract, generated API packages and `lib/valopay-schema`, the shared per-kind schema (statuses, state machines, failure-code and exception catalogues, money and policy guardrails) that the API validator and the console both import.
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
| `VITE_CLERK_PUBLISHABLE_KEY` | Frontend Clerk configuration for sign-in; on a local host without it the console runs the anonymous sandbox with sign-in hidden |
| `PRIVATE_OBJECT_DIR` | Private App Storage location |
| `PUBLIC_OBJECT_SEARCH_PATHS` | App Storage public search locations |
| `PORT` | Port for each process, supplied by its managed workflow |
| `BASE_PATH` | Frontend mount path, `/` for this application |
| `NODE_ENV` | Development or production behavior |
| `VITE_CLERK_PROXY_URL` | Optional frontend Clerk proxy override |
| `LOG_LEVEL` | Optional server logging level |

The storage client obtains credentials from a **Replit sidecar**. Supplying storage paths alone will not make exports work outside Replit. External hosting requires a reviewed storage-authentication adapter, Clerk setup, PostgreSQL provisioning and same-origin routing for `/api/*` versus frontend assets; these are not implemented by this source transfer.

For a **new, disposable development database only**, after reviewing the schema:

```sh
pnpm --filter @workspace/db run push
```

Do not point this command at production or an existing database without a reviewed migration plan. Startup and build commands must not run database DDL. See [the database security boundary](docs/DATABASE_SECURITY.md).

## Development

In Replit, use the existing managed API Server and Valo Pay workflows. They inject service ports and route the API and frontend under the same origin.

The underlying commands are:

```sh
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/valopay run dev
```

Each process needs its own `PORT`; the frontend also needs `BASE_PATH`. The API development command builds before starting and is not a file watcher. Outside Replit, two independent localhost ports alone do not reproduce the same-origin routing.

## Checks and builds

These checks need no production credentials or running services and do not write to a runtime database:

```sh
pnpm run typecheck
pnpm run check:db-boundary
pnpm run test:pure
pnpm run test:golden
```

`test:pure` explicitly runs the source-snapshot safeguards, in-memory store guards/audit checks, and download-stream tests. The store test supplies an unusable loopback database URL for module initialization; it does not connect to a database.

`test:golden` runs the golden tests for the shared schema, the retry engine and reconciliation (`artifacts/api-server/tests/*-golden.test.ts`). They pin the TRD v1.1 acceptance behaviour in section 10.4: the three-source replay in every order, duplicate evidence, the allocation ceiling, the notice clock, quiet hours, execution windows, attempt ceilings across sources, stable assignment and kill switches. Add a golden case whenever a rule in `lib/valopay-schema` or `artifacts/api-server/src/domain` changes. `pnpm test` runs every offline check above in one go.

### GitHub pull-request checks

The local `.github/workflows/ci.yml` definition is configured to run on pull requests and pushes to `main`, using Ubuntu 24.04, Node.js 24 and pnpm 10.26.1. It installs with `pnpm install --frozen-lockfile`, runs the four commands above, then builds the API bundle and the console (the console build needs no Clerk key; see the environment table). The job has read-only repository permissions, no application secrets or database service, and does not publish, deploy, migrate, or run the synthetic database/HTTP integration suites. The workflow must first be committed to GitHub through an account with workflow-write permission; source sync with `--skip-workflows` does not install or enable it.

The check reports failures on the pull request. Enforcing a merge block requires a GitHub branch rule that requires **TypeScript, database boundary and pure tests**; this workflow does not change repository protection settings.

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
NODE_ENV=development VALOPAY_RUN_INTEGRATION=1 \
  scripts/node_modules/.bin/tsx artifacts/api-server/tests/valopay-store.integration.test.ts
NODE_ENV=development VALOPAY_RUN_INTEGRATION=1 \
  node --expose-gc --import ./scripts/node_modules/tsx/dist/loader.mjs \
  artifacts/api-server/tests/export-streams.integration.test.ts
```

The HTTP suites require Replit's `REPLIT_DEV_DOMAIN`. Never use real lender data for tests.

Regenerate shared clients and validators after API contract changes:

```sh
pnpm --filter @workspace/api-spec run codegen
```

## Updating GitHub from the original Replit workspace

**Do not push the original Replit Git branch directly.** Its history contains local-only material. Use the connected GitHub account and the source-only synchronization utility instead:

```sh
# Track any newly added source files explicitly first:
git add path/to/new-source-file

# Inspect the source-only file list; no network writes:
node scripts/github-sync.mjs

# After reviewing that list, upload the current source:
node scripts/github-sync.mjs --push
```

The utility targets only the public `obeidpeter/valo-pay` repository, as approved by its owner. Public means anyone can read the uploaded source. It sends reviewed source contents, never Git history or credentials, through the Replit GitHub connector. It checks common secret patterns but cannot prove arbitrary content is safe: review new files before uploading.

Use this script rather than Replit's Git Sync/Push button in the original workspace. That button pushes Git history; this workspace intentionally has no direct GitHub remote. An authentication error from that button does not necessarily mean the GitHub connector used by this script is broken.

Only `.github/workflows/ci.yml` is approved for workflow export. Other workflows and local GitHub actions remain excluded until individually reviewed and added to the allowlist.

The current connector does not offer GitHub's separate workflow-write permission. To sync source while explicitly leaving workflow updates pending:

```sh
node scripts/github-sync.mjs --skip-workflows
node scripts/github-sync.mjs --push --skip-workflows
```

This option preserves existing remote workflow files unchanged and reports pending local workflow changes. It never silently deletes a workflow. Commit the reviewed CI file through GitHub's website, or use a separately authorized clean clone, to enable/update it. An independently created GitHub commit still requires reconciliation before the next source upload. Unchanged workflow blobs are reused, not rewritten.

Updates use ignored local synchronization state from the previous successful upload. In a workspace without that state, the utility can initialize it only when all selected local source files already match GitHub exactly; otherwise it stops for manual reconciliation. This allows a merged task's main workspace to establish its baseline safely. If GitHub has changed independently, the utility stops rather than overwriting changes; it never force-pushes and also refuses remote file deletions. Authentication failures should be repaired through the GitHub connection, not by pasting tokens into code.

In a **fresh clone from GitHub**, normal Git commits/pushes are safe to use because the clone contains only the clean repository history. Reconcile changes made there before uploading another snapshot from the original Replit workspace.