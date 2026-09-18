# Observability

A review of what an operator can see of the API and the console, made after the security and internationalisation reviews and in the same manner: read the surface, test what can be tested here, fix what is this repository's to fix, and write down what was found, what changed, what is accepted and what belongs to the host. It answers four questions: is the service healthy, what happened to a request a person is reporting, why did a close not run, and how long do the heavy operations take.

## Scope and method

The API's logger and request logging (`artifacts/api-server/src/lib/logger.ts`, `app.ts`), the error handler, the process entry point and its lifecycle, the close scheduler, the export route, the refusals (origin, request limit), the health route and the database module; the console's failure surfaces (the workspace failure page, problem notices, the error boundary). Every log call was read; the built API was run against PostgreSQL to look at its lines and answers and to stop it with a signal; the offline test `artifacts/api-server/tests/observability.test.ts` reads the log back from a file and pins the behaviour.

## What is sound

- **Request lines.** One structured line per request with method, path, status and time; the query string is never written, nor cookies or authorisation headers (redacted), nor request or response bodies.
- **The scheduler.** Every close pass carries a correlation id (`job`, `runId`) on its lines, each lender's close is its own line with the close id and its lateness, and a failure names the lender and the error (NFR-OBS-01).
- **Alerts from state.** The overview's alerts feed (a missed close, a broken audit chain, unallocated money past its threshold, an instruction in observation mode) is computed from the lender's records, so it needs no monitoring pipeline to be right (NFR-OBS-02).
- **Levels.** `LOG_LEVEL` sets the level; the console keeps a service failure's internals off the screen and shows a refusal in the rule's own words.

## Findings, and what changed

| # | Finding | Kind | Status |
| --- | --- | --- | --- |
| 1 | Requests were numbered by a per-process counter that was never returned, so a person reporting a failure had nothing to quote and an operator nothing to search for. | Correlation | **Fixed.** Every request has an id: the one the host's edge supplied when it is a plain token (8–64 characters of letters, digits, `.`, `_`, `-`), otherwise 16 random hex characters. It is on every log line of the request, on the answer as `X-Request-Id`, and in every error body as `requestId`. |
| 2 | A programming error was logged with its name and message only; the stack, which is what locates it, was dropped. | Diagnosis | **Fixed.** A failure (`event: request.failed`) is logged with `err` and its stack; the answer stays general. |
| 3 | A refused or rejected request was visible only as a status on its request line; the reason was nowhere. | Diagnosis | **Fixed.** A rejection is one info line (`event: request.rejected`, `status`, `reason`); a cross-origin or malformed-origin refusal is a warning (`event: request.refused`, `reason`), and the request limit is a warning once per client and window, so a flood does not double its own log. |
| 4 | `/api/healthz` said "ok" and nothing else; there was no readiness answer, so a host could not tell an instance that cannot reach its database from one that can. | Health | **Fixed.** `/api/healthz` (liveness, never touches the database) reports the build, the start time, the uptime and the scheduler's state, tick count, last tick and last pass that found work. `/api/readyz` makes one bounded round trip to the database (2 s) and answers 503 `degraded` while it fails; the reason goes to the log, not the answer. |
| 5 | Log lines were pretty-printed and coloured unless `NODE_ENV=production`, which no start command sets; on an unknown host the log would have been for a person, not a collector. | Format | **Fixed.** JSON on stdout unless `NODE_ENV=development` or `LOG_FORMAT=pretty`; `LOG_FILE` writes synchronously to a file instead, which is how the offline test reads the lines back. |
| 6 | Nothing said which build a line or an answer came from. | Provenance | **Fixed.** The build script stamps the commit and the build time into the bundle; every line carries `service` and `build`, as do the health answers and the start line. From the source tree the build is `source`. |
| 7 | An error on an idle database connection is emitted on the pool; unheard, that event ends the process. | Availability | **Fixed.** The process listens (`event: database.pool_error`) and the pool replaces the connection. |
| 8 | A stop signal ended the process at once, cutting requests in flight and any close pass in progress, and a crash nothing caught wrote a bare stack to stderr. | Availability | **Fixed.** On SIGTERM or SIGINT the process stops accepting, finishes the requests in flight, waits for a close pass in progress, ends the pool and exits, within a 10 s deadline (`event: server.stopping`, `server.stopped`, `server.stop_timeout`); an unhandled rejection or uncaught exception is a fatal line (`process.unhandled_rejection`, `process.uncaught_exception`) before the exit. A close cut by the deadline rolls back with its connection and runs as a catch-up after restart (NFR-AVA-02). |
| 9 | A quiet scheduler pass wrote nothing, so a stopped scheduler and an idle one looked the same, and a pass had no duration. | Scheduler | **Fixed.** Each pass that found work is one line (`event: close.run`) with its duration and counts; a quiet pass is a debug line; the state, tick count and last pass are on `/api/healthz`. |
| 10 | An export's generation time was stored on its record but never logged. | Timing | **Fixed.** One line per export (`event: export.generated`) with kind, format, size and generation time. |
| 11 | The console's failure notices gave the time of a service error but not the request. | Console | **Fixed.** A problem notice for a 5xx ends with "Reference <id>", and the workspace failure page gives the time and the reference together; a refusal keeps the rule's own words. |
| 12 | An address under `/api` that no route answers returned the framework's HTML page. | Answers | **Fixed.** A JSON `Unknown resource.` with the request id. |

## Reading the log

Every line is JSON with `level` (30 info, 40 warn, 50 error, 60 fatal), `time`, `pid`, `hostname`, `service` (`valopay-api`) and `build`. A request line has `req.id`, `req.method`, `req.url` (the path, never the query), `res.statusCode`, `responseTime` in milliseconds and `msg` `request completed`, or `request errored` at error level for a 5xx. Lines the request wrote itself carry the same `req` and an `event`:

| Event | Level | Fields | Meaning |
| --- | --- | --- | --- |
| `request.rejected` | info | `status`, `reason` | A rule refused the request in its own words (400, 403, 409). |
| `request.refused` | warn | `reason`: `origin`, `origin_malformed`, `rate_limit` | The shell refused it before any route ran. |
| `request.failed` | error | `err` with stack | The service itself failed; the answer was a general 500. |
| `readiness.failed` | warn | `latencyMs`, `reason` | `/api/readyz` could not reach the database. |
| `export.generated` | info | `kind`, `format`, `byteLength`, `generationMs` | An export was written to storage. |
| `server.started`, `server.stopping`, `server.stopped`, `server.stop_timeout` | info / error | `port`, `build`, `node`; `signal` | The process lifecycle. |
| `scheduler.started`, `scheduler.off` | info / warn | `intervalMs`, `batchSize` | Whether this process schedules closes. |
| `close.run` | info (debug when nothing was due) | `job`, `runId`, `durationMs`, `examined`, `closed`, `skipped`, `failed` | One scheduler pass. Each lender's close is its own line, `scheduled daily close completed` or `failed`, with `merchantId`. |
| `close.tick_failed` | error | `err` | A pass could not even read what was due. |
| `database.pool_error` | error | `err` | An idle connection failed and was replaced. |
| `process.unhandled_rejection`, `process.uncaught_exception` | fatal | `err` | The process is about to exit. |

**Tracing a report.** A person quotes the reference from a notice or the failure page; it is `req.id`. Every line of that request shares it: the request line, the rejection or failure line, a refusal. A scheduled close is traced by `runId`; a person's close is a request like any other, with its audit entry in the lender's log.

**What to watch.** Any line at level 50 or above; `request.refused` with `reason: rate_limit` in a burst; `readiness.failed`; on `/api/healthz`, `scheduler.state` other than `running` on an instance that should schedule, or `lastTickAt` older than a few intervals; `close.run` with `failed` above zero; the distribution of `responseTime` on request lines and of `generationMs` on exports.

## What was left out

- **No metrics endpoint.** The lines above carry every count and duration a dashboard needs, and the host's log tooling aggregates them across instances; an in-process counter on an autoscaled instance would answer for one instance only and read as the whole.
- **No distributed tracing.** One service and one database: the request id is the trace.
- **No error beacon from the console.** A page error is written to the browser console with its component stack and shown with the time and the address; a service failure carries the reference. Collecting browser errors is a product decision that involves the people using it.
- **4xx at info, not warn.** A refusal is the rule working; only the shell's refusals are warnings.
- **Retention, shipping and alert routing belong to the host**, as do the readiness probe's schedule and what it does with a 503.

## How to re-run

- `pnpm run test:pure` runs `artifacts/api-server/tests/observability.test.ts`: request ids kept, replaced and returned; ids in error bodies; stacks and reasons in the log; liveness with build and scheduler state; bounded readiness against an unreachable address; query strings and cookies never written.
- Against a running API: `curl -i /api/healthz`, `curl -i /api/readyz`, a request with `X-Request-Id: edge-0123456789` returning the same id, `kill -TERM` and the `server.stopped` line.
- Before a change that adds an operation an operator would ask about, give it one line with an `event` and its duration, and add a row here.
