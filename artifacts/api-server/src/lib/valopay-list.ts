import { canTakeAllocation } from "@workspace/valopay-schema";
import type { ValopayRecord } from "../domain/types";

/** Hard ceiling on one page so a list can never return more than this; the default is the whole filtered set for the console. */
export const LIST_PAGE_CEILING = 500;

/** Search form of a text: marks stripped and case folded, so "Ọkọnkwọ", "Okonkwo" and "OKONKWO" all match one another however a name was typed. */
export function foldForSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export interface ListQuery { status?: string; search?: string; limit?: number; offset?: number; updatedSince?: string; customerId?: string; id?: string; allocatable?: "true" | "false" }

/** True when a list asks only for instalments that can take an allocation (`canTakeAllocation`); asked of another kind, it is refused. */
export function allocatableOnly(kind: string, query: ListQuery): boolean {
  if (query.allocatable !== "true") return false;
  if (kind !== "due-items") throw Object.assign(new Error("allocatable lists instalments only. Use it with due-items."), { status: 400 });
  return true;
}

/**
 * Filter, order and page a kind's records: status and search as before,
 * whether an instalment can take an allocation (`allocatable`; the caller
 * checks the kind with allocatableOnly), an `updatedSince` watermark for
 * incremental sync (Appendix B updated_since), newest first, then `offset` and
 * `limit`.  `total` counts the filtered set so a client can page; `nextOffset`
 * is present when more rows remain.
 */
export function pageRecords(records: ValopayRecord[], query: ListQuery): { items: ValopayRecord[]; total: number; nextOffset?: number } {
  let items = records;
  if (query.status && query.status !== "all") items = items.filter((record) => record.status === query.status);
  if (query.customerId) items = items.filter((record) => record.customerId === query.customerId);
  if (query.id) items = items.filter((record) => record.id === query.id);
  if (query.allocatable === "true") items = items.filter(canTakeAllocation);
  if (query.search) { const search = foldForSearch(query.search); items = items.filter((record) => foldForSearch(`${record.name} ${record.reference} ${record.status} ${JSON.stringify(record.data)}`).includes(search)); }
  if (query.updatedSince) {
    const since = Date.parse(query.updatedSince);
    if (Number.isNaN(since)) throw Object.assign(new Error("updatedSince must be an ISO timestamp."), { status: 400 });
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
