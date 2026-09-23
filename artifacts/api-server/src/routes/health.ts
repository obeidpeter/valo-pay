import { Router, type IRouter } from "express";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";
import { BUILD, STARTED_AT } from "../lib/build-info";
import { schedulerStatus } from "../lib/close-scheduler";
import { pingDatabase, type DatabaseReadiness } from "../lib/valopay-store";

const router: IRouter = Router();

/**
 * The readiness answer for one check: 200 when the database answers and holds
 * every table, column and index this build needs; otherwise 503, degraded,
 * naming what is missing and the migration that adds it. A connection error
 * stays in the log, not the answer.
 */
export function readinessAnswer(database: DatabaseReadiness) {
  const ready = database.status === "ok" && database.schema.status === "ok";
  return { httpStatus: ready ? 200 : 503, body: ReadinessCheckResponse.parse({ status: ready ? "ok" : "degraded", build: BUILD, checks: { database: { status: database.status, latencyMs: database.latencyMs }, schema: database.schema } }) };
}

/**
 * Two questions a host or a person can ask without a sandbox or a sign-in.
 * Liveness (/healthz): the process answers, and says which build it is, how
 * long it has been up and what its scheduler is doing. It never touches the
 * database, so a database outage does not read as a dead process. Readiness
 * (/readyz): one bounded round trip to the database on its own connection, so
 * a busy request pool does not read as an unreachable database, which also
 * reads whether the database holds what this build needs, so a migration not
 * yet applied is not ready; 503 while either fails, so traffic can be held
 * back from an instance that cannot serve it.
 */
router.get("/healthz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(HealthCheckResponse.parse({ status: "ok", build: BUILD, startedAt: STARTED_AT, uptimeSeconds: Math.round(process.uptime()), scheduler: schedulerStatus() }));
});

router.get("/readyz", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const database = await pingDatabase(), answer = readinessAnswer(database);
  if (database.status !== "ok") req.log.warn({ event: "readiness.failed", latencyMs: database.latencyMs, reason: database.error }, "Readiness check failed: the database did not answer");
  else if (database.schema.status !== "ok") req.log.warn({ event: "readiness.failed", latencyMs: database.latencyMs, reason: "schema incomplete", missing: database.schema.missing }, "Readiness check failed: the database lacks a table, column or index this build needs");
  res.status(answer.httpStatus).json(answer.body);
});

export default router;
