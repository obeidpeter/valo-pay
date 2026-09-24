import type { ValopayRecord } from "../domain/types";

/** Hard ceiling on one page so a list can never return more than this. */
export const LIST_PAGE_CEILING = 500;
/**
 * Kinds that grow with a lender's history, with every action or day, rather
 * than with its book: the audit chain, the daily closes and the logs of
 * exports, messages and retry decisions. A list of one of them without
 * `limit` returns at most LIST_PAGE_CEILING records, newest first, with
 * `nextOffset` to page on; a list of any other kind without `limit` returns
 * its whole filtered set.
 */
export const HISTORY_KINDS: ReadonlySet<string> = new Set(["audit", "closes", "exports", "notifications", "retry-decisions"]);
/** A list's page size: the `limit` asked for, at most the ceiling; without one, the ceiling for a history kind and no limit for the rest. */
export function listLimit(kind: string | undefined, limit: unknown): number | undefined {
  if (Number.isInteger(limit) && Number(limit) > 0) return Math.min(Number(limit), LIST_PAGE_CEILING);
  return kind !== undefined && HISTORY_KINDS.has(kind) ? LIST_PAGE_CEILING : undefined;
}

/** Search form of a text: marks stripped and case folded, so "Ọkọnkwọ", "Okonkwo" and "OKONKWO" all match one another however a name was typed. */
export function foldForSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export interface ListQuery { status?: string; search?: string; limit?: number; offset?: number; updatedSince?: string; customerId?: string; id?: string }

/**
 * Filter, order and page a kind's records: status and search as before, an
 * `updatedSince` watermark for incremental sync (Appendix B updated_since),
 * newest first, then `offset` and `limit` (listLimit, for `kind` when given).
 * `total` counts the filtered set so a client can page; `nextOffset` is
 * present when more rows remain.
 */
export function pageRecords(records: ValopayRecord[], query: ListQuery, kind?: string): { items: ValopayRecord[]; total: number; nextOffset?: number } {
  let items = records;
  if (query.status && query.status !== "all") items = items.filter((record) => record.status === query.status);
  if (query.customerId) items = items.filter((record) => record.customerId === query.customerId);
  if (query.id) items = items.filter((record) => record.id === query.id);
  if (query.search) { const search = foldForSearch(query.search); items = items.filter((record) => foldForSearch(`${record.name} ${record.reference} ${record.status} ${JSON.stringify(record.data)}`).includes(search)); }
  if (query.updatedSince) {
    const since = Date.parse(query.updatedSince);
    if (Number.isNaN(since)) throw Object.assign(new Error("updatedSince must be an ISO timestamp."), { status: 400 });
    items = items.filter((record) => Date.parse(record.updatedAt) >= since);
  }
  items = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const total = items.length;
  const offset = Number.isInteger(query.offset) && Number(query.offset) > 0 ? Number(query.offset) : 0;
  const limit = listLimit(kind, query.limit);
  const page = limit === undefined ? items.slice(offset) : items.slice(offset, offset + limit);
  const nextOffset = offset + page.length < total ? offset + page.length : undefined;
  return nextOffset === undefined ? { items: page, total } : { items: page, total, nextOffset };
}
