import { Router, type IRouter } from "express";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";
import { BUILD, STARTED_AT } from "../lib/build-info";
import { schedulerStatus } from "../lib/close-scheduler";
import { pingDatabase } from "../lib/valopay-store";

const router: IRouter = Router();

/**
 * Two questions a host or a person can ask without a sandbox or a sign-in.
 * Liveness (/healthz): the process answers, and says which build it is, how
 * long it has been up and what its scheduler is doing. It never touches the
 * database, so a database outage does not read as a dead process. Readiness
 * (/readyz): one bounded round trip to the database; 503 while it fails, so
 * traffic can be held back from an instance that cannot serve it.
 */
router.get("/healthz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(HealthCheckResponse.parse({ status: "ok", build: BUILD, startedAt: STARTED_AT, uptimeSeconds: Math.round(process.uptime()), scheduler: schedulerStatus() }));
});

router.get("/readyz", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const database = await pingDatabase();
  if (database.status !== "ok") req.log.warn({ event: "readiness.failed", latencyMs: database.latencyMs, reason: database.error }, "Readiness check failed: the database did not answer");
  res.status(database.status === "ok" ? 200 : 503).json(ReadinessCheckResponse.parse({ status: database.status === "ok" ? "ok" : "degraded", build: BUILD, checks: { database: { status: database.status, latencyMs: database.latencyMs } } }));
});

export default router;
