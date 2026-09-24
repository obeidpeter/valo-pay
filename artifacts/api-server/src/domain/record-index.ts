import { findRecord, recordsOf } from "./records";
import type { DomainState, RecordOf, ValopayRecord } from "./types";

/** What records are looked up by: their id or reference, or a field of their data. */
export type RecordKey = "id" | "reference" | `data.${string}`;
type Reader = (record: ValopayRecord) => unknown;
function reader(key: RecordKey | "kind"): Reader {
  if (key === "id") return (record) => record.id;
  if (key === "reference") return (record) => record.reference;
  if (key === "kind") return (record) => record.kind;
  const field = key.slice("data.".length);
  return (record) => record.data[field];
}

/** One kind's records grouped by one key, in record order, for the first `seen` records of `list`. */
interface Grouping { list: ValopayRecord[]; seen: number; groups: Map<unknown, ValopayRecord[]> }

/**
 * The lookups of one pass over a lender's records. Each kind and key is
 * grouped once, on first use, and the records the pass appends (makeRecord
 * adds at the end) join the groups as they appear; a replaced or shortened
 * list is grouped again. The groups hold the live records, so a status the
 * pass changes is read as it now is.
 */
class RecordIndex {
  private groupings = new Map<string, Grouping>();
  constructor(readonly state: DomainState) {}
  where(kind: string, key: RecordKey | "kind", value: unknown): ValopayRecord[] {
    const name = `${kind}\u0000${key}`, list = this.state.records;
    let grouping = this.groupings.get(name);
    if (!grouping || grouping.list !== list || grouping.seen > list.length) this.groupings.set(name, grouping = { list, seen: 0, groups: new Map() });
    const read = reader(key);
    for (; grouping.seen < list.length; grouping.seen += 1) {
      const record = list[grouping.seen]!;
      if (record.kind !== kind) continue;
      const group = read(record), members = grouping.groups.get(group);
      if (members) members.push(record); else grouping.groups.set(group, [record]);
    }
    // A copy, which a caller may sort; NaN equals nothing, as with ===.
    return value === value ? [...(grouping.groups.get(value) ?? [])] : [];
  }
}

let current: RecordIndex | undefined;

/**
 * Runs a synchronous pass over a lender's records, such as a reconciliation,
 * with its lookups indexed: inside it, recordsWhere reads a map instead of
 * scanning every record, so a pass that handles many items costs what its
 * records do rather than their number times the items. The answers are the
 * ones a scan gives. A pass inside another on the same records shares its
 * index.
 */
export function indexedPass<T>(state: DomainState, pass: () => T): T {
  if (current?.state === state) return pass();
  const outer = current;
  current = new RecordIndex(state);
  try {
    return pass();
  } finally {
    current = outer;
  }
}

/**
 * The records of a kind whose key equals a value, in record order: what
 * filtering every record by kind and `===` gives. Inside an indexed pass they
 * come from its index, so only for a key nothing changes once a record exists
 * (an id, a batch's reference, the payment an allocation applies, the
 * instalment an attempt collects); elsewhere the records are scanned.
 */
export function recordsWhere<K extends string>(state: DomainState, kind: K, key: RecordKey, value: unknown): RecordOf<K>[] {
  if (current?.state === state) return current.where(kind, key, value) as RecordOf<K>[];
  const read = reader(key);
  return state.records.filter((record) => record.kind === kind && read(record) === value) as RecordOf<K>[];
}

/** Every record of a kind, in record order: recordsOf, through the pass's index when there is one. */
export function recordsOfKind<K extends string>(state: DomainState, kind: K): RecordOf<K>[] {
  return current?.state === state ? (current.where(kind, "kind", kind) as RecordOf<K>[]) : recordsOf(state, kind);
}

/** findRecord of a kind, through the pass's index when there is one: the same record, or the same error. */
export function recordById<K extends string>(state: DomainState, id: string, kind: K): RecordOf<K> {
  return recordsWhere(state, kind, "id", id)[0] ?? findRecord(state, id, kind);
}
