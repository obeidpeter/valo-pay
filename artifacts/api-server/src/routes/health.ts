import { Router, type IRouter } from "express";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";
import { BUILD, STARTED_AT } from "../lib/build-info";
import { schedulerStatus } from "../lib/close-scheduler";
import { pingDatabase, type DatabaseReadiness } from "../lib/valopay-store";
import { contractAnswer } from "../lib/contract";

const router: IRouter = Router();

/**
 * The readiness answer for one check: 200 when the database answers and holds
 * every table and column this build needs; otherwise 503, degraded. An index a
 * migration adds that is missing leaves the answer ready, marked
 * `indexes_missing`: every request still works, only slower, and taking every
 * instance out of rotation for it would be an outage. The answer says only
 * which state; the names of what is missing, and a connection error, stay in
 * the log.
 */
export function readinessAnswer(database: DatabaseReadiness) {
  const ready = database.status === "ok" && (database.schema.status === "ok" || database.schema.status === "indexes_missing");
  return { httpStatus: ready ? 200 : 503, body: contractAnswer(ReadinessCheckResponse, { status: ready ? "ok" : "degraded", build: BUILD, checks: { database: { status: database.status, latencyMs: database.latencyMs }, schema: { status: database.schema.status } } }) };
}

let reportedIndexes = "";
/**
 * The warning line a readiness check writes, if any: every time the database
 * does not answer or lacks a table or column; for missing indexes, once until
 * what is missing changes, so a host polling readiness every few seconds does
 * not write the same warning each time.
 */
export function readinessWarning(database: DatabaseReadiness): { fields: Record<string, unknown>; message: string } | undefined {
  const indexes = database.status === "ok" && database.schema.status === "indexes_missing" ? database.schema.missing.join("\n") : "";
  const repeated = indexes === reportedIndexes;
  reportedIndexes = indexes;
  if (database.status !== "ok") return { fields: { event: "readiness.failed", latencyMs: database.latencyMs, reason: database.error }, message: "Readiness check failed: the database did not answer" };
  if (database.schema.status === "incomplete") return { fields: { event: "readiness.failed", latencyMs: database.latencyMs, reason: "schema incomplete", missing: database.schema.missing }, message: "Readiness check failed: the database lacks a table or column this build needs" };
  if (indexes && !repeated) return { fields: { event: "readiness.indexes_missing", missing: database.schema.missing }, message: "Ready, but the database lacks an index this build expects: some reads are slower until its migration is applied" };
  return undefined;
}

/**
 * Two questions a host or a person can ask without a sandbox or a sign-in.
 * Liveness (/healthz): the process answers, and says which build it is, how
 * long it has been up and what its scheduler is doing. It never touches the
 * database, so a database outage does not read as a dead process. Readiness
 * (/readyz): one bounded round trip to the database on its own connection, so
 * a busy request pool does not read as an unreachable database, which also
 * reads whether the database holds the tables and columns this build needs,
 * so a migration not yet applied is not ready; 503 while either fails, so
 * traffic can be held back from an instance that cannot serve it.
 */
router.get("/healthz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(contractAnswer(HealthCheckResponse, { status: "ok", build: BUILD, startedAt: STARTED_AT, uptimeSeconds: Math.round(process.uptime()), scheduler: schedulerStatus() }));
});

router.get("/readyz", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const database = await pingDatabase(), answer = readinessAnswer(database), warning = readinessWarning(database);
  if (warning) req.log.warn(warning.fields, warning.message);
  res.status(answer.httpStatus).json(answer.body);
});

export default router;
