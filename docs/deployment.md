# Deployment and hosting

What the Replit deployment runs, what holds a release back, what Replit Autoscale means for the work the API process does on its own, and the two ways to run scheduled daily closes on time. The owner chooses the deployment type in Replit's publishing settings; nothing in this repository changes it.

## What is deployed

`.replit` publishes to Replit Autoscale (`deploymentTarget = "autoscale"`). The API's own deployment settings are in `artifacts/api-server/.replit-artifact/artifact.toml`: the build (`pnpm --filter @workspace/api-server run build`, which writes the server, its background worker thread and the one-shot close pass to `artifacts/api-server/dist`), the start command (`node --enable-source-maps artifacts/api-server/dist/index.mjs`), the start-up health check and the environment the deployed process gets:

| Setting | Value | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | Production behaviour: JSON log lines and the Clerk proxy. |
| `PORT` | `8080` | The port the router sends `/api` to. |
| `VALOPAY_EXPIRED_WORKSPACE_CLEANUP` | `on` | Anonymous sandboxes nobody has changed for 30 days are deleted (below). |
| `CLERK_TELEMETRY_DISABLED` | `1` | The Clerk SDK sends no telemetry and prints no telemetry notice on stdout (below). |

Credentials (`DATABASE_URL`, the Clerk keys, `PRIVATE_OBJECT_DIR` and any optional service keys) come from Replit's secret manager, never from these files. The console is built and served as static files (`artifacts/valo-pay/.replit-artifact/artifact.toml`).

## What holds a release back

The deployment's start-up health check is `GET /api/readyz`, not the liveness answer. Readiness makes one bounded round trip to the database and reads its catalogue, so:

- a database that does not answer, or lacks a table or column this build needs (a migration not yet applied), answers 503, the health check fails and the new build does not go live;
- a database that lacks only an index a migration adds answers 200 with `checks.schema.status` `indexes_missing`: every request still works, only slower, so the release goes ahead, and a `readiness.indexes_missing` log line names the index and the migration that adds it.

Apply a build's migrations before publishing it (`docs/database-migrations.md`). The process also refuses to start when a setting breaks its rule: it writes one `config.invalid` line naming each setting to correct, never its value, and exits with status 1, so the health check never passes (`docs/observability.md`).

## Autoscale and the work the API process does on its own

Two pieces of work run inside the API process rather than as separate jobs, on its background worker thread (below): the scheduled daily close (REC-01, each lender's configured West Africa Time, default 07:00) and the export worker. Replit Autoscale runs instances only while requests arrive and scales an idle deployment down to none, so:

- **Scheduled closes run late.** While no instance runs, nothing ticks. A close due at 07:00 runs at the first tick after the next request starts an instance, about five seconds after it starts, and a close that starts more than 30 minutes after its time is recorded as late; until then the overview shows the `close_missed` alert.
- **Queued exports wait.** An export queued before the deployment went idle starts when the next request starts an instance. One in progress when an instance stops returns to the queue instead of failing.
- **Per-address limits are per instance.** The general request limit, the new-sandbox limit and the Paystack test-delivery limit count in each instance's memory: with several instances a client can make up to that many times as many requests, and the counts start again whenever an instance starts. The per-lender share of database connections is per instance too (`docs/DATABASE_SECURITY.md`).

## The background worker thread

The API process runs the scheduled daily close and the export worker on a worker thread of its own (`artifacts/api-server/src/background.ts`, built as `dist/background.mjs` beside the server), not on the event loop that answers requests. A month-end close or a large export therefore never holds up another tenant's requests or a health probe; a lender's own requests still wait for its close, as they wait for any change to it. A close a person runs through the API stays on the request path, since it answers that request.

- **Its connections.** The thread has its own database pool of three connections: one for the scheduled close, which closes one lender at a time, and one for each of the two export slots. The requests' pool is `VALOPAY_DATABASE_POOL_SIZE` (10 by default) and readiness keeps one short-lived connection, so an instance holds at most that size plus four, 14 by default. Size the database's connection limit for instances × (size + 4), plus one for the one-shot close pass where it runs.
- **Its log and state.** Its lines are written through the main thread, with the same events as before and `thread: "background"` added, and the scheduler's state reaches `/api/healthz` and the console by message (`docs/observability.md`).
- **A crash.** A thread that fails is logged (`background.crashed`) and started again after a wait that doubles from a second to a minute, back to a second once a thread has run for a minute; the API carries on. A close it was running rolls back with its connection and runs at the new thread's first tick; an export it was running keeps its lease and is recovered when the lease expires, as after a process crash. Until the new thread's first pass succeeds, `/api/healthz` shows the failure in the scheduler's `lastErrorAt` and the console does not advertise the next automatic close.
- **Shutdown.** On SIGTERM or SIGINT the process stops the thread before it exits: no close or export starts, the lender close in progress finishes, the exports in progress return to the queue and the thread ends its pool (`background.stopped`), all within the process's 10 s deadline.

Close times are not staggered. Every lender on the default 07:00 closes then, one after another; on the worker thread a morning of closes delays no request and no health probe, so spreading the times would gain nothing and would move lenders' closes from the time they chose.

## Running scheduled closes on time

Choose one of these for any host whose lenders rely on the automatic close.

1. **A Reserved VM.** Change the deployment type from Autoscale to Reserved VM in Replit's publishing settings. The instance stays up, the API's scheduler ticks every minute on its background worker thread and closes run on time. Leave `VALOPAY_CLOSE_SCHEDULER` unset (or `on`). A Reserved VM is billed while it runs: this is the owner's billing decision.
2. **Autoscale with a Scheduled Deployment.** Keep the Autoscale deployment and set `VALOPAY_CLOSE_SCHEDULER=off` in its environment, so its instances never run the scheduler. Then create a Replit Scheduled Deployment of this repository that runs the one-shot close pass:
   - build command: `pnpm --filter @workspace/api-server run build`;
   - run command: `node --enable-source-maps artifacts/api-server/dist/close-pass.mjs`;
   - schedule: every 15 minutes (cron `*/15 * * * *`), so a close starts well within the 30 minutes after which it is recorded as late;
   - environment: the same `DATABASE_URL` secret as the web deployment and the same database settings (`VALOPAY_DATABASE_POOL_SIZE`, and `VALOPAY_RUNTIME_ISOLATION` with its companions where the restricted runtime is on), with `NODE_ENV=production`. It needs no port, no Clerk key and no storage.

The one-shot close pass (`artifacts/api-server/src/close-pass.ts`, run locally with `pnpm --filter @workspace/api-server run close-pass` after a build) is the scheduler's own pass run once: the same due-lender reads, the same fair order, one lender per system transaction through the scoped repository, the same failure backoff and audit, with a budget of ten minutes instead of 45 seconds. It ignores `VALOPAY_CLOSE_SCHEDULER`. Another process closing at the same time never closes the same lender twice. A stop signal ends it after the lender close in progress. It ends with one `close.one_shot` line and its exit status:

| Exit status | Meaning |
| --- | --- |
| 0 | The pass ran and every due lender was closed, paused (an idle sandbox) or left to another process. |
| 2 | The pass ran, but at least one lender's close failed. Each failure is recorded with its next attempt (2, 4, 8, 16, 32 minutes, then hourly) and a later run retries it; the lender's log line has the error. |
| 1 | The pass could not run (a setting refused at start-up, the database unavailable) or was stopped before it finished. The lenders it did not reach are still due for the next run. |

A failed run shows as failed in the Scheduled Deployment's history. On a host run this way the web instances report the scheduler as `off` on `/api/healthz`, so the console says the automatic daily close is off on this service and does not advertise the next run; the closes the pass records are scheduled closes, shown as such in Reports. Do not set `VALOPAY_MONITOR_EXPECT_SCHEDULER=on` for such a host (`docs/operational-rehearsals.md`); watch the Scheduled Deployment's runs and its `close.one_shot` lines instead.

Exports need no schedule of their own: the export worker runs whenever an instance does, so a queued export waits at most until the next request.

## Anonymous sandboxes on the deployed host

The deployment sets `VALOPAY_EXPIRED_WORKSPACE_CLEANUP=on`. An anonymous sandbox becomes eligible for deletion when it is more than 30 days old and nobody has changed it for 30 days (entries by the seed and the scheduled close do not count as changes). Deletion happens only when a new anonymous sandbox is created, that is when a browser without a sandbox cookie first opens the console: that request deletes up to five eligible sandboxes, oldest first, removing their lenders, records, stored answers and operations journal. A sandbox whose lender a scheduled close, the export worker, a test delivery or a request holds at that moment is left for a later sweep. So an eligible sandbox is deleted at the next new visitor's arrival, five at a time, not at the moment it turns 30 days idle; on a quiet host it can stay longer. Export files the sandbox wrote to private storage are not deleted by the sweep. Signed-in and staff workspaces are never swept. The development workspace leaves the setting unset, so nothing is deleted there.

## Clerk telemetry

With development-instance keys (`pk_test_`, `sk_test_`), the Clerk SDK collects telemetry and prints a three-line plain-text notice on stdout once per process, among the JSON log lines. Set `CLERK_TELEMETRY_DISABLED=1` on every pilot host: the deployment sets it, and a separately configured host must set it too. With it the SDK sends nothing and prints no notice.

## What the owner does by hand

- Choose the deployment type (Autoscale or Reserved VM) and, for Autoscale, create the Scheduled Deployment above and set `VALOPAY_CLOSE_SCHEDULER=off` on the Autoscale deployment.
- Provide the secrets through Replit's secret manager, for the web deployment and for the Scheduled Deployment.
- Apply each release's migrations before publishing it (`docs/database-migrations.md`).
- Provision and renew pilot administrators with the operator command (`docs/pilot-workflow-release.md`).
