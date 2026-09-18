import { createHash } from "node:crypto";
import type { DomainState, ValopayRecord } from "../domain/types";

// Only editable preferences participate. A scheduler heartbeat/cursor must not
// invalidate a form whose preferences have not changed.
const preferenceKeys = ["executionStart", "executionEnd", "authorisationMode", "contactRoute", "minimumTicketKobo", "defaultOwner", "policyChangeRequiresConsent", "unallocatedAlertThreshold", "notificationCostAlertKobo", "closeTime", "scheduledCloseEnabled"] as const;
export function settingsRevision(settings: Record<string, any>): string {
  return createHash("sha256").update(JSON.stringify(preferenceKeys.map(key => [key, settings[key] ?? null]))).digest("hex");
}
function stale(message: string): never { throw Object.assign(new Error(message), { status: 409 }); }
export function assertRecordVersion(record: ValopayRecord, expectedUpdatedAt: string | undefined): void {
  if (expectedUpdatedAt === undefined) return;
  if (!Number.isFinite(Date.parse(expectedUpdatedAt))) throw Object.assign(new Error("expectedUpdatedAt must be an ISO timestamp."), { status: 400 });
  if (Date.parse(record.updatedAt) !== Date.parse(expectedUpdatedAt)) stale("This record changed after you opened it. Your changes have not been saved. Refresh the record, review the latest version, and try again.");
}
export function assertSettingsVersion(settings: Record<string, any>, expectedRevision: string | undefined): void {
  if (expectedRevision !== undefined && expectedRevision !== settingsRevision(settings)) stale("These settings changed after you opened them. Your changes have not been saved. Refresh the settings, review the latest version, and try again.");
}

/** All changed mutable records get a strictly newer revision, even when two
 * actions share a millisecond or a transaction waited for an earlier writer. */
export function advanceRecordVersions(before: DomainState, after: DomainState, now: string): void {
  const originals = new Map(before.records.map(record => [record.id, record]));
  for (const record of after.records) {
    const original = originals.get(record.id);
    if (!original || JSON.stringify(record) === JSON.stringify(original)) continue;
    record.updatedAt = new Date(Math.max(Date.parse(now), Date.parse(record.updatedAt), Date.parse(original.updatedAt) + 1)).toISOString();
  }
}
