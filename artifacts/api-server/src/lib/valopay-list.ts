import { instantInputSchema } from "@workspace/valopay-schema";
import type { ValopayRecord } from "../domain/types";

/** Hard ceiling on one page so a list can never return more than this; the default is the whole filtered set for the console. */
export const LIST_PAGE_CEILING = 500;

/** Search form of a text: marks stripped and case folded, so "Ọkọnkwọ", "Okonkwo" and "OKONKWO" all match one another however a name was typed. */
export function foldForSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Whether a list's search (already folded, foldForSearch) matches a record: its
 * name, its reference or any text or number value in its data, nested ones
 * included, each value on its own, so a search never runs from one value into
 * the next. A field's name, true, false, null and JSON's own quotes and braces
 * are not searched: "synthetic" or "true" no longer matches every record, and
 * a value holding a double quote is found as written.
 */
export function matchesSearch(record: { name: string; reference: string; data: unknown }, search: string): boolean {
  const matches = (value: unknown): boolean =>
    typeof value === "string" ? foldForSearch(value).includes(search)
    : typeof value === "number" ? String(value).includes(search)
    : Array.isArray(value) ? value.some(matches)
    : value !== null && typeof value === "object" ? Object.values(value).some(matches) : false;
  return matches(record.name) || matches(record.reference) || matches(record.data);
}

export interface ListQuery { status?: string; search?: string; limit?: number; offset?: number; updatedSince?: string; customerId?: string; id?: string }

/** Why an incremental sync's watermark was refused. */
export const UPDATED_SINCE_REFUSAL = "updatedSince must be an RFC 3339 date and time with Z or an offset, such as 2026-09-18T08:00:00+01:00.";
/**
 * The instant an incremental sync's watermark names, in milliseconds, as the
 * shared instant schema reads it: RFC 3339 with Z or an offset, from the year
 * 0001. A number, a day without a time, a time without a zone (which would be
 * read in the server's own zone) or a value PostgreSQL cannot store is a 400.
 */
export function updatedSinceInstant(value: string): number {
  const since = instantInputSchema.safeParse(value);
  if (!since.success) throw Object.assign(new Error(UPDATED_SINCE_REFUSAL), { status: 400 });
  return Date.parse(since.data);
}

/**
 * Filter, order and page a kind's records: status and search as before, an
 * `updatedSince` watermark for incremental sync (Appendix B updated_since),
 * newest first, then `offset` and `limit`.  `total` counts the filtered set so
 * a client can page; `nextOffset` is present when more rows remain.
 */
export function pageRecords(records: ValopayRecord[], query: ListQuery): { items: ValopayRecord[]; total: number; nextOffset?: number } {
  let items = records;
  if (query.status && query.status !== "all") items = items.filter((record) => record.status === query.status);
  if (query.customerId) items = items.filter((record) => record.customerId === query.customerId);
  if (query.id) items = items.filter((record) => record.id === query.id);
  if (query.search) { const search = foldForSearch(query.search); items = items.filter((record) => matchesSearch(record, search)); }
  if (query.updatedSince) {
    const since = updatedSinceInstant(query.updatedSince);
    items = items.filter((record) => Date.parse(record.updatedAt) >= since);
  }
  items = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const total = items.length;
  const offset = Number.isInteger(query.offset) && Number(query.offset) > 0 ? Number(query.offset) : 0;
  const limit = Number.isInteger(query.limit) && Number(query.limit) > 0 ? Math.min(Number(query.limit), LIST_PAGE_CEILING) : undefined;
  const page = limit === undefined ? items.slice(offset) : items.slice(offset, offset + limit);
  const nextOffset = offset + page.length < total ? offset + page.length : undefined;
  return nextOffset === undefined ? { items: page, total } : { items: page, total, nextOffset };
}
