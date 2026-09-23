// Offline tests for the API shell helpers: list paging with an updatedSince
// watermark, and the sandbox creation limiter.
import assert from "node:assert/strict";
import { pageRecords, LIST_PAGE_CEILING } from "../src/lib/valopay-list.js";
import { createCreationLimiter } from "../src/lib/creation-limit.js";
import type { ValopayRecord } from "../src/domain/types.js";

let checks = 0;
const record = (i: number, status = "open"): ValopayRecord => ({ id: `r${String(i).padStart(3, "0")}`, merchantId: "m", kind: "exceptions", name: `record ${i}`, status, reference: `REF-${i}`, amountKobo: i, customerId: "", createdAt: new Date(Date.UTC(2027, 0, 1, 0, i)).toISOString(), updatedAt: new Date(Date.UTC(2027, 0, 2, 0, i)).toISOString(), data: { note: i % 2 ? "odd" : "even" } });
const records = Array.from({ length: 1200 }, (_, i) => record(i, i % 3 ? "open" : "resolved"));

{
  const all = pageRecords(records, {});
  assert.equal(all.items.length, 1200, "no limit returns the whole set, as the console expects");
  assert.equal(all.total, 1200); assert.equal(all.nextOffset, undefined);
  assert.equal(all.items[0]!.id, "r1199", "newest first");
  const first = pageRecords(records, { limit: 100 });
  assert.equal(first.items.length, 100); assert.equal(first.total, 1200); assert.equal(first.nextOffset, 100);
  const second = pageRecords(records, { limit: 100, offset: 100 });
  assert.equal(second.items[0]!.id, "r1099"); assert.equal(second.nextOffset, 200);
  const last = pageRecords(records, { limit: 100, offset: 1150 });
  assert.equal(last.items.length, 50); assert.equal(last.nextOffset, undefined, "no next page after the last row");
  assert.equal(pageRecords(records, { limit: 5000 }).items.length, LIST_PAGE_CEILING, "a page never exceeds the ceiling");
  assert.equal(pageRecords(records, { limit: -3, offset: -1 }).items.length, 1200, "invalid paging values fall back to the defaults");
  const filtered = pageRecords(records, { status: "resolved", search: "odd", limit: 10 });
  assert.equal(filtered.total, records.filter((r) => r.status === "resolved" && r.data.note === "odd").length, "total counts the filtered set");
  assert.equal(filtered.items.length, 10);
  const since = pageRecords(records, { updatedSince: new Date(Date.UTC(2027, 0, 2, 0, 1190)).toISOString() });
  assert.equal(since.total, 10, "updatedSince is inclusive of the watermark");
  assert.throws(() => pageRecords(records, { updatedSince: "yesterday" }), /RFC 3339 date and time/);
  checks += 16;
}

{
  const limiter = createCreationLimiter(3, 1000);
  assert.equal(limiter.take("a", 0), true); assert.equal(limiter.take("a", 10), true); assert.equal(limiter.take("a", 20), true);
  assert.equal(limiter.take("a", 30), false, "the fourth creation inside the window is refused");
  assert.equal(limiter.remaining("a", 30), 0);
  assert.equal(limiter.take("b", 30), true, "another address has its own window");
  assert.equal(limiter.take("a", 1001), true, "the window resets");
  assert.equal(limiter.remaining("a", 1001), 2);
  checks += 8;
}

console.log(`API shell tests passed (${checks} checks): paging, watermark, ceiling, filtered totals, creation limiter.`);
