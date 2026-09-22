import type { RequestHandler } from "express";
import { z } from "zod";
import { parse } from "csv-parse/sync";
import { assertNoRealBankDetails } from "../domain/records";
import { registerRefusalCloser } from "./refused-operations";
import {
  bindOperation,
  boundOperation,
  inWorkspace,
  prepareOperation,
  readOperation,
  rejectOperation,
  type StoredRequest,
} from "./valopay-store";

// Only routes whose writes and receipt commit in one workspace transaction.
// No URLs, headers, provider calls, team invitations or arbitrary HTTP replay.
export function recoverableRequest(
  method: string,
  path: string,
  body: any,
): boolean {
  if (method === "PATCH")
    return (
      /^\/v1\/records\/[a-z-]+\/[^/]+$/.test(path) || path === "/v1/settings"
    );
  if (method !== "POST") return false;
  if (path === "/v1/actions") return body?.action !== "set_role";
  if (path === "/v1/imports") return body?.commit === true;
  return (
    path === "/v1/connected/actions" ||
    /^\/v1\/records\/[a-z-]+$/.test(path) ||
    path === "/v1/exports" ||
    /^\/v1\/exports\/[^/]+\/retry$/.test(path) ||
    /^\/v1\/pilot\/batches(?:\/[^/]+\/(?:save|commit))?$/.test(path) ||
    /^\/v1\/pilot\/cases\/[^/]+$/.test(path) ||
    /^\/v1\/pilot\/import-corrections(?:\/[^/]+\/decision)?$/.test(path) ||
    /^\/v1\/pilot\/close-reviews\/(?:prepare|[^/]+\/decision)$/.test(path) ||
    /^\/v1\/sources\/(?:manifests|profiles(?:\/[^/]+\/save)?|paystack\/fixtures|events\/[^/]+\/replay)$/.test(path) ||
    /^\/v1\/work\/(?:notifications\/read|handovers\/acknowledge)$/.test(path) ||
    /^\/v1\/lifecycle\/(?:policy|holds|runs(?:\/[^/]+\/(?:approve|execute))?)$/.test(path)
  );
}
const query = z.object({ merchantId: z.string().min(1).max(100) });
// Statuses that mean the same request would be refused again. A rate limit,
// a timeout or a service failure leaves the entry pending: its outcome is unknown.
const definitive = new Set([400, 403, 404, 409, 410, 413, 415, 422]);
/** Whether an HTTP status is a definitive refusal of the request that received it. */
export const definitiveRejection = (status: number) => definitive.has(status);
/** Closes the request's journal entry after a definitive refusal, so refused
 * requests never accumulate as pending and lock the person out. Returns
 * nothing when there is no entry to close, so an ordinary refusal is answered
 * synchronously. A failure to record it is logged and leaves the entry
 * pending, the safe direction. */
export function closeRejectedOperation(req: Parameters<RequestHandler>[0], status: number, message: string): Promise<void> | undefined {
  const bound = boundOperation(req);
  if (!bound || !definitiveRejection(status)) return undefined;
  return rejectOperation(req, bound, { status, message }).catch((error: unknown) => {
    req.log?.warn?.({ event: "operation.rejection_unrecorded", err: error instanceof Error ? error : new Error(String(error)) }, "A refused request stays pending in the operations journal");
  });
}
const requestKey = z.string().min(8).max(200);
export const recoveryMiddleware: RequestHandler = async (req, res, next) => {
  try {
    const replay = /^\/v1\/operations\/([a-f0-9]{64})\/retry$/.exec(req.path);
    if (req.method === "POST" && replay) {
      const { merchantId } = query.parse(req.query);
      const stored = await inWorkspace(
        req,
        res,
        (ctx) => readOperation(ctx, merchantId, replay[1]!),
        "read",
      );
      if (
        !recoverableRequest(
          stored.request.method,
          stored.request.path,
          stored.request.body,
        )
      )
        throw Object.assign(
          new Error("This request cannot be repeated automatically."),
          { status: 409 },
        );
      // Re-enter the ordinary route and all current validation/authorisation.
      req.method = stored.request.method;
      req.url = `${stored.request.path}?merchantId=${encodeURIComponent(merchantId)}`;
      req.body = structuredClone(stored.request.body);
      req.headers["idempotency-key"] = stored.request_key;
    }
    if (recoverableRequest(req.method, req.path, req.body)) {
      const { merchantId } = query.parse(req.query);
      // Legacy API callers without keys retain their existing contract. Every
      // console mutation supplies a key; unkeyed writes cannot be recovered.
      if (req.header("Idempotency-Key")) {
        const key = requestKey.parse(req.header("Idempotency-Key"));
        assertNoRealBankDetails(req.body);
        if (typeof req.body?.csv === "string") {
          if (req.body.syntheticOnly !== true)
            throw Object.assign(
              new Error("Only synthetic source rows may be saved."),
              { status: 403 },
            );
          try {
            assertNoRealBankDetails(
              parse(req.body.csv, {
                columns: true,
                bom: true,
                trim: true,
                skip_empty_lines: true,
                max_record_size: 20000,
              }),
            );
          } catch (error) {
            throw Object.assign(
              new Error(
                error instanceof Error
                  ? error.message
                  : "The source rows could not be checked.",
              ),
              { status: 400 },
            );
          }
        }
        const request: StoredRequest = {
          method: req.method as StoredRequest["method"],
          path: req.path,
          body: req.body ?? {},
        };
        const id = await inWorkspace(req, res, (ctx) =>
          prepareOperation(ctx, merchantId, key, request),
        );
        bindOperation(req, id, merchantId);
        registerRefusalCloser(req, (status, message) => closeRejectedOperation(req, status, message));
        res.setHeader("X-Valopay-Operation", id);
      }
    }
    next();
  } catch (error) {
    next(error);
  }
};
