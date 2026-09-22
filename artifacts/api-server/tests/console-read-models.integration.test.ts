import { pageCustomerHistory } from '../src/lib/customer-history';
import { customerTimeline } from '../src/domain/timeline';
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  pageReconciliation,
  pageCloseHistory,
  reconciliationQueues,
} from "../src/lib/console-read-models";
import { buildConsoleReports } from "../src/lib/valopay-close-views";
import { previousMonth } from "../src/domain/billing";
import type { ValopayRecord } from "../src/domain/types";
if (process.env.VALOPAY_RUN_INTEGRATION !== "1") process.exit(0);
const { pool } = await import("@workspace/db");
const {
  inWorkspace,
  listMerchants,
  loadState,
  listReconciliation,
  listCloseHistory,
  getCloseDetail,
  getCustomerHistory,
  loadReportsView,
} = await import("../src/lib/valopay-store");
const tokens = [
  randomBytes(32).toString("hex"),
  randomBytes(32).toString("hex"),
];
const request = (token = tokens[0]) =>
  ({
    headers: { cookie: `valopay_sandbox=${token}` },
    secure: false,
    auth: Object.assign(() => ({ userId: null }), {
      [Symbol.for("@clerk/express.auth")]: true,
    }),
  }) as any;
const response = () => ({ cookie() {} }) as any;
try {
  const lenders = await inWorkspace(request(), response(), listMerchants),
    merchantId = lenders[0]!.id,
    otherId = lenders[1]!.id;
  const { state, now } = await inWorkspace(
    request(),
    response(),
    async (ctx) => ({
      state: await loadState(ctx, merchantId, "share"),
      now: ctx.now,
    }),
    "read",
  );
  const proposal = state.records.find(
    (r) => r.kind === "allocations" && r.status === "proposed",
  )!;
  const due = state.records.find((r) => r.id === proposal.data.dueItemId)!;
  const rows: ValopayRecord[] = [];
  const month = previousMonth(now);
  for (let i = 0; i < 450; i++) {
    rows.push({
      ...proposal,
      id: randomUUID(),
      reference: `READ-MATCH-${i}`,
      status: i < 60 ? "proposed" : i % 3 ? "confirmed" : "superseded",
      createdAt: `${month}-05T12:00:00.000Z`,
      data: {
        ...proposal.data,
        automatic: true,
        confidence: "certain",
        confirmedAt: `${month}-05T12:00:00Z`,
        ...(i % 2 ? { reviewed: i % 3 !== 0 } : {}),
      },
    });
    rows.push({
      ...due,
      id: randomUUID(),
      kind: "closes",
      reference: `READ-CLOSE-${i}`,
      status: "completed",
      createdAt: new Date(
        Date.UTC(2025, 0, 1, 22, 30) + i * 86400000,
      ).toISOString(),
      data: {
        synthetic: true,
        summary: `Close ${i}`,
        closedAt: new Date(
          Date.UTC(2025, 0, 1, 22, 30) + i * 86400000,
        ).toISOString(),
        report: {
          unallocated: { kobo: i * 100, olderThan24Hours: i % 2 },
          exceptions: { openAtClose: i, overdueAtClose: i % 3 },
          customerPositionsChanged: Array.from({ length: 50 }, (_, j) => ({
            customerId: `synthetic-${j}`,
            value: j,
          })),
        },
      },
    });
  }
  // Matches at the audit month's edges, which are midnight West Africa Time
  // (23:00 UTC the day before): at the month's first instant and half an hour
  // later (still the previous month in UTC), at its last millisecond, and at
  // the next month's first instant (still this month in UTC). One more has no
  // confirmedAt, so its creation time stands in, and one is a date only.
  const monthStart = Date.parse(`${month}-01T00:00:00.000Z`) - 3_600_000;
  const [year, monthNumber] = month.split("-").map(Number);
  const nextMonthStart = Date.UTC(year!, monthNumber!, 1) - 3_600_000;
  const edges = [
    { at: monthStart, stamped: true },
    { at: monthStart + 30 * 60_000, stamped: true },
    { at: nextMonthStart - 1, stamped: true },
    { at: nextMonthStart, stamped: true },
    { at: monthStart + 30 * 60_000, stamped: false },
  ];
  for (const [index, edge] of edges.entries()) {
    const at = new Date(edge.at).toISOString();
    const data: Record<string, unknown> = {
      ...proposal.data,
      automatic: true,
      confidence: "certain",
    };
    if (edge.stamped) data.confirmedAt = at;
    else delete data.confirmedAt;
    rows.push({
      ...proposal,
      id: randomUUID(),
      reference: `READ-WAT-${index}`,
      status: "confirmed",
      createdAt: at,
      data,
    });
  }
  rows.push({
    ...proposal,
    id: randomUUID(),
    reference: "READ-WAT-DATE",
    status: "confirmed",
    createdAt: `${month}-01T00:00:00.000Z`,
    data: {
      ...proposal.data,
      automatic: true,
      confidence: "certain",
      confirmedAt: `${month}-01`,
    },
  });
  await pool.query(
    `INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
    SELECT id,"merchantId",kind,name,status,reference,"amountKobo","customerId",data,"createdAt","updatedAt" FROM jsonb_to_recordset($1::jsonb) AS x(id text,"merchantId" text,kind text,name text,status text,reference text,"amountKobo" bigint,"customerId" text,data jsonb,"createdAt" timestamptz,"updatedAt" timestamptz)`,
    [JSON.stringify(rows)],
  );
  const normalise = (page: any) => ({
    ...page,
    related: page.related?.sort((a: any, b: any) => a.id.localeCompare(b.id)),
  });
  await inWorkspace(
    request(),
    response(),
    async (ctx) => {
      const full = await loadState(ctx, merchantId, "share");
      for (const queue of reconciliationQueues)
        for (const filters of [
          { limit: 25 },
          { limit: 25, offset: 25 },
          { limit: 100, offset: 99999 },
          { limit: 25, dueItem: due.id },
          { limit: 25, dueItem: "unavailable" },
          ...[due.reference, state.records.find(r=>r.id===proposal.data.paymentId)!.reference, 'CHIAMAKA', 'read-match-4', '%_', 'no-match'].map(q=>({limit:25,offset:25,q})),
        ]) {
          const actual = await listReconciliation(
            ctx,
            merchantId,
            queue,
            filters,
          );
          assert.deepEqual(
            normalise(actual),
            normalise(pageReconciliation(full, queue, filters, ctx.now)),
            `${queue} ${JSON.stringify(filters)}`,
          );
          assert.ok(actual.items.length <= filters.limit);
          assert.ok(actual.related.every((r) => r.merchantId === merchantId));
        }
      // The audit month is the same WAT month in SQL and in the domain.
      const watMonth = (at: string) =>
        new Date(Date.parse(at) + 3_600_000).toISOString().slice(0, 7);
      const audited = full.records.filter(
        (r) =>
          r.kind === "allocations" &&
          ["confirmed", "superseded"].includes(r.status) &&
          r.data.automatic === true &&
          r.data.confidence === "certain" &&
          watMonth(String(r.data.confirmedAt || r.createdAt)) === month,
      );
      assert.ok(
        ["READ-WAT-0", "READ-WAT-1", "READ-WAT-2", "READ-WAT-4", "READ-WAT-DATE"]
          .every((reference) => audited.some((r) => r.reference === reference)) &&
          !audited.some((r) => r.reference === "READ-WAT-3"),
        "the edge rows fall where the WAT month says",
      );
      assert.equal(
        (await listReconciliation(ctx, merchantId, "audit", { limit: 25 }))
          .precision?.population,
        audited.length,
        "the audit population counts the WAT month",
      );
      const complete=customerTimeline(full,due.customerId);
      for(const historyQuery of [{},{eventsOffset:25,eventsLimit:25},{eventsOffset:99999,mandatesOffset:99999,dueItemsOffset:99999,paymentsOffset:99999},{eventsLimit:1,mandatesLimit:1,dueItemsLimit:1,paymentsLimit:1,record:complete.events.at(-1)!.id},{record:'not-this-customer'}]) {
        const result=await getCustomerHistory(ctx,merchantId,due.customerId,historyQuery);
        assert.deepEqual(result,pageCustomerHistory(full,due.customerId,historyQuery));
        assert.deepEqual(result.position,complete.position,'paging never changes the full monetary position');
        assert.ok(result.events.length<=(historyQuery.eventsLimit||25));
        assert.equal(result.totals.events,complete.events.length);
      }
      await assert.rejects(()=>getCustomerHistory(ctx,merchantId,'missing',{}),(e:any)=>e.status===404);
      for (const filters of [
        { limit: 25 },
        { limit: 25, offset: 25 },
        { limit: 100, offset: 99999 },
        { limit: 25, from: "2025-02-01", to: "2025-02-28" },
        { limit: 25, from: "2027-01-01" },
      ]) {
        const actual = await listCloseHistory(ctx, merchantId, filters);
        assert.deepEqual(actual, pageCloseHistory(full.records, filters));
        assert.ok(
          actual.items.every((r) => !r.data.report?.customerPositionsChanged),
          "page excludes full evidence",
        );
      }
      await assert.rejects(() =>
        listCloseHistory(ctx, merchantId, { from: "2025-02-30" }),
      );
      await assert.rejects(() =>
        listCloseHistory(ctx, merchantId, {
          from: "2025-03-01",
          to: "2025-02-01",
        }),
      );
      const detail = await getCloseDetail(ctx, merchantId, rows[1]!.id);
      assert.equal(detail.data.report.customerPositionsChanged.length, 50);
      const runtime = {
        state: "off" as const,
        intervalMs: null,
        lastTickAt: null,
        lastSuccessAt: null,
        lastErrorAt: null,
      };
      const thin = await loadReportsView(ctx, merchantId);
      assert.deepEqual(
        { ...buildConsoleReports(thin, ctx.now, runtime), closes: [] },
        { ...buildConsoleReports(full, ctx.now, runtime), closes: [] },
        "thinner report reads preserve every published metric and billing result",
      );
    },
    "read",
  );
  await inWorkspace(
    request(),
    response(),
    async (ctx) => {
      await assert.rejects(()=>getCustomerHistory(ctx,otherId,due.customerId,{}),(e:any)=>e.status===404);
      const result = await listReconciliation(ctx, otherId, "proposals", {
        dueItem: due.id,
      });
      assert.equal(result.total, 0);
      assert.equal(result.related.length, 0);
      await assert.rejects(
        () => getCloseDetail(ctx, otherId, rows[1]!.id),
        (e: any) => e.status === 404,
      );
    },
    "read",
  );
  await assert.rejects(
    () =>
      inWorkspace(
        request(tokens[1]),
        response(),
        (ctx) => listCloseHistory(ctx, merchantId, {}),
        "read",
      ),
    (e: any) => e.status === 404,
  );
  console.log(
    "Console read models passed: 906 additional records, all reconciliation queues, seeded audit parity, WAT history, lazy evidence, unchanged report measures and isolation.",
  );
} finally {
  const principals = tokens.map((token) =>
    createHash("sha256").update(`demo:${token}`).digest("hex"),
  );
  const scope =
    "SELECT id FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=ANY($1::text[]))";
  await pool.query(
    `DELETE FROM valopay_idempotency WHERE merchant_id IN (${scope})`,
    [principals],
  );
  await pool.query(
    `DELETE FROM valopay_records WHERE merchant_id IN (${scope})`,
    [principals],
  );
  await pool.query(`DELETE FROM valopay_merchants WHERE id IN (${scope})`, [
    principals,
  ]);
  await pool.query(
    "DELETE FROM valopay_workspaces WHERE principal_hash=ANY($1::text[])",
    [principals],
  );
  await pool.end();
}
