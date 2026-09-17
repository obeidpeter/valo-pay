import { randomUUID } from "node:crypto";
import type { DomainState, ValopayRecord } from "./types";

const forbiddenBankKey = /(^|_)(account(number)?|bank_account|iban|bvn|card(number)?)(_|$)/i;
const digitRun = /\d[\d -]{6,}\d/;

/** Rejecting raw financial identifiers keeps this synthetic sandbox non-sensitive. */
export function assertNoRealBankDetails(value: unknown, key = ""): void {
  if (typeof value === "string") {
    if (forbiddenBankKey.test(key) || (key.toLowerCase().includes("account") && !key.toLowerCase().includes("masked"))) {
      throw new Error("Raw bank account details are not permitted; store a masked identifier only.");
    }
    if (!key.toLowerCase().includes("masked") && digitRun.test(value) && /(bank|account|card|iban|bvn)/i.test(key)) {
      throw new Error("Raw financial identifiers are not permitted in this sandbox.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoRealBankDetails(item, key));
  } else if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => {
      assertNoRealBankDetails(child, childKey);
    });
  }
}

export function findRecord(state: DomainState, id: string, kind?: string): ValopayRecord {
  const record = state.records.find((item) => item.id === id && (!kind || item.kind === kind));
  if (!record) throw new Error(`Record ${id} was not found.`);
  return record;
}

export function recordsOf(state: DomainState, kind: string): ValopayRecord[] {
  return state.records.filter((item) => item.kind === kind);
}

export function touch(record: ValopayRecord, now: string): ValopayRecord {
  record.updatedAt = now;
  return record;
}

export function makeRecord(
  state: DomainState,
  kind: string,
  input: Partial<ValopayRecord> & { data?: Record<string, any> },
): ValopayRecord {
  assertNoRealBankDetails(input);
  const timestamp = input.createdAt || new Date().toISOString();
  const record: ValopayRecord = {
    id: input.id || randomUUID(),
    merchantId: state.merchant.id,
    kind,
    name: input.name || kind,
    status: input.status || "draft",
    reference: input.reference || `SYN-${kind}-${randomUUID().slice(0, 8)}`,
    amountKobo: Number.isInteger(input.amountKobo) ? Number(input.amountKobo) : 0,
    customerId: input.customerId || "",
    createdAt: timestamp,
    updatedAt: input.updatedAt || timestamp,
    data: { ...(input.data || {}), synthetic: true },
  };
  if (record.amountKobo < 0) throw new Error("Amounts must be integer kobo greater than or equal to zero.");
  state.records.push(record);
  return record;
}

export function masked(value: unknown): boolean {
  return typeof value === "string" && (/[*xX•]/.test(value) || value.length <= 4);
}