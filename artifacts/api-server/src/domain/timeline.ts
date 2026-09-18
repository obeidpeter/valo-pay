import { positionFor } from "./close";
import { recordsOf } from "./records";
import type { DomainState } from "./types";

/** One customer's timeline: the record, its derived position (REC-05) and every related record newest first. */
export function customerTimeline(state: DomainState, id: string) {
  const customer = recordsOf(state, "customers").find((record) => record.id === id);
  if (!customer) throw Object.assign(new Error("Customer not found."), { status: 404 });
  const related = state.records.filter((record) => record.customerId === id);
  const dueItems = related.filter((record) => record.kind === "due-items"), payments = related.filter((record) => record.kind === "payments");
  // REC-05: one derivation of the position, shared with the daily close and the dispute pack.
  const { obligationsKobo, allocatedKobo, outstandingKobo, unallocatedKobo } = positionFor(state, id);
  return {
    customer,
    position: { obligationsKobo, allocatedKobo, outstandingKobo, unallocatedKobo, note: "Derived obligations and payment evidence, not funds held by Valo Pay." },
    events: related.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), mandates: related.filter((record) => record.kind === "mandates"), dueItems, payments,
  };
}
