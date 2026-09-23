import { createHash } from "node:crypto";
import { canonicalJson, type CanonicalJsonForm } from "@workspace/valopay-schema";

/**
 * Every digest the API stores or compares across requests, and the canonical
 * JSON form it is written in (lib/valopay-schema/src/canonical-json.ts). A
 * digest that is stored and computed again later keeps the form it was first
 * written in, so evidence saved by an earlier build still verifies:
 *
 * - the audit chain (entry hash and change digest) and the request
 *   fingerprints (idempotency receipts, the operations journal, lender
 *   onboarding, connected actions, the staging rehearsal):
 *   `legacy-en-us-null`, through this module;
 * - retention policy and hold revisions, retention candidate and preview
 *   digests, import-correction impact, preview and proposal digests, work-item
 *   source digests and import row fingerprints: `legacy-en-us-replacer`;
 * - source file IDs and the source completeness basis: `legacy-code-unit-null`;
 * - connected cash evidence hashes and connected credit snapshots and IDs:
 *   `legacy-en-us-omit`;
 * - retry-decision fingerprints and close review input and snapshot digests:
 *   `canonical`, whose text is byte for byte what their earlier helpers wrote
 *   for any value read back from the database.
 *
 * Digests of bytes (export checksums, recovery backups) and of plain strings
 * (record and journal IDs, principals) involve no JSON form. A Paystack test
 * event's payload digest is `JSON.stringify` of the event the parser builds,
 * whose key order the parser fixes.
 */

/** SHA-256 of a string, as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** SHA-256 of a value's canonical JSON in the named form: `canonical` unless a stored digest needs a legacy form. */
export function canonicalDigest(value: unknown, form: CanonicalJsonForm = "canonical"): string {
  return sha256Hex(canonicalJson(value, form));
}

/** The form of every audit and request digest: each stored chain and journal fingerprint was computed with it. */
const RECORDED_FORM: CanonicalJsonForm = "legacy-en-us-null";

/**
 * A request's fingerprint, stored beside its idempotency receipt or journal
 * entry: a replay with the same key must send the same request, and is
 * compared with this.
 */
export function requestFingerprint(request: unknown): string {
  return canonicalDigest(request, RECORDED_FORM);
}

/** What an audit entry commits to; its hash covers exactly these fields. */
export interface AuditEntryBody {
  sequence: number;
  actor: string;
  action: string;
  objectId: string;
  summary: string;
  changeDigest: string;
  previousHash: string;
  timestamp: string;
}
/** An audit record's data: the body and its hash. */
export type AuditEntryData = AuditEntryBody & { hash: string };

/** The chain hash of an audit entry's body. */
export function auditEntryHash(body: object): string {
  return canonicalDigest(body, RECORDED_FORM);
}

/**
 * The one audit-entry builder: the data of the entry that follows
 * `previousHash` (GENESIS for the first), with the digest of what changed and
 * the chain hash. The repository, the export worker and the staging rehearsal
 * each find the chain's head their own way and pass it in.
 */
export function auditEntryData(entry: {
  sequence: number; actor: string; action: string; objectId: string; summary: string;
  changes?: unknown; previousHash?: string; timestamp: string;
}): AuditEntryData {
  const body: AuditEntryBody = {
    sequence: entry.sequence, actor: entry.actor, action: entry.action, objectId: entry.objectId, summary: entry.summary,
    changeDigest: canonicalDigest(entry.changes ?? {}, RECORDED_FORM), previousHash: entry.previousHash ?? "GENESIS", timestamp: entry.timestamp,
  };
  return { ...body, hash: auditEntryHash(body) };
}

/**
 * Walks a lender's audit entries in sequence order: valid when every entry's
 * sequence, previous hash and hash agree. Returns the count and the head hash.
 */
export function verifyAuditChain(entries: ReadonlyArray<{ data: Record<string, any> }>): { valid: boolean; count: number; headHash: string } {
  const chain = [...entries].sort((a, b) => Number(a.data.sequence) - Number(b.data.sequence));
  let hash = "GENESIS", valid = true, index = 0;
  for (const entry of chain) {
    const { hash: recorded, ...body } = entry.data;
    if (body.sequence !== ++index || body.previousHash !== hash || auditEntryHash(body) !== recorded) { valid = false; break; }
    hash = String(recorded);
  }
  return { valid, count: chain.length, headHash: hash };
}
