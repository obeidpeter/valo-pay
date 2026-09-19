// Only a disposable database. Validate SQL paging against the reference queue semantics.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { pageQueue, queueViews, type QueueName, type QueueQuery } from '../src/lib/valopay-queues';
if (process.env.VALOPAY_RUN_INTEGRATION !== '1') process.exit(0);
const { pool } = await import('@workspace/db');
const { inWorkspace, listMerchants, listQueue, loadState } = await import('../src/lib/valopay-store');
const tokens = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
const request = (token = tokens[0]) => ({ headers: { cookie: `valopay_sandbox=${token}` }, secure: false, auth: Object.assign(() => ({ userId: null }), { [Symbol.for('@clerk/express.auth')]: true }) }) as any;
const response = () => ({ cookie() {} }) as any;
try {
  const merchants = await inWorkspace(request(), response(), listMerchants);
  const merchantId = merchants[0]!.id, siblingId = merchants[1]!.id;
  const state = await inWorkspace(request(), response(), ctx => loadState(ctx, merchantId, 'share'), 'read');
  const customer = state.records.find(row => row.kind === 'customers')!, mandate = state.records.find(row => row.kind === 'mandates')!;
  const foreign = await inWorkspace(request(), response(), ctx => loadState(ctx, siblingId, 'share'), 'read');
  const foreignCustomer = foreign.records.find(row => row.kind === 'customers')!;
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,amount_kobo)
    SELECT $1 || '-queue-ex-' || lpad(i::text,5,'0'),$1,'exceptions','Queue exception ' || i,
      CASE WHEN i%4=0 THEN 'resolved' ELSE 'open' END,'QEX-' || i,$2,
      jsonb_build_object('synthetic',true,'severity',CASE WHEN i%3=0 THEN 'high' ELSE 'medium' END,
        'owner',CASE WHEN i%2=0 THEN 'Finance' ELSE 'Operations' END,'type','unallocated_payment',
        'dueBy',CASE WHEN i%5=0 THEN 'invalid legacy date' WHEN i%7=0 THEN '2026-09-18T23:30:00-02:00' ELSE '2026-09-19' END),1000000
    FROM generate_series(1,2000) i`, [merchantId, customer.id]);
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,amount_kobo)
    SELECT $1 || '-queue-due-' || lpad(i::text,5,'0'),$1,'due-items','Queue instalment ' || i,
      CASE WHEN i%4=0 THEN 'paid' ELSE 'scheduled' END,'QDUE-' || i,CASE WHEN i=1 THEN $4 ELSE $2 END,
      jsonb_build_object('synthetic',true,'mandateId',$3::text,'owner',CASE WHEN i%2=0 THEN 'lender' ELSE 'valopay' END,
        'dueDate',CASE WHEN i%5=0 THEN '2026-09-18' ELSE '2026-09-19' END),1000000
    FROM generate_series(1,2000) i`, [merchantId, customer.id, mandate.id, foreignCustomer.id]);
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,amount_kobo)
    SELECT $1 || '-queue-attempt-' || lpad(i::text,5,'0'),$1,'attempts','Queue attempt ' || i,'failed','QATT-' || i,$2,
      jsonb_build_object('synthetic',true,'dueItemId',$1 || '-queue-due-' || lpad(i::text,5,'0'),'occurredAt','2026-09-18T12:00:00Z'),1000000
    FROM generate_series(1,2000) i`, [merchantId, customer.id]);
  const baseline = await inWorkspace(request(), response(), ctx => loadState(ctx, merchantId, 'share'), 'read');
  const normalise = (page: ReturnType<typeof pageQueue>) => ({ ...page, related: page.related.sort((a, b) => a.id.localeCompare(b.id)) });
  for (const queue of Object.keys(queueViews) as QueueName[]) {
    const cases: QueueQuery[] = queueViews[queue].flatMap(view => [{ view, limit: 25 }, { view, limit: 25, offset: 25 }, { view, limit: 100, offset: 99999 }]);
    cases.push({ owner: queue === 'exceptions' ? 'Finance' : 'lender', type: queue === 'exceptions' ? 'unallocated_payment' : '', limit: 25 });
    if (queue === 'collections') cases.push({ view: 'failed', target: `${merchantId}-queue-attempt-01999`, limit: 25 }, { view: 'all', target: `${merchantId}-queue-due-00001`, limit: 25 });
    if (queue === 'mandates') cases.push({ record: mandate.id, view: 'overdue', limit: 25 });
    for (const query of cases) {
      await inWorkspace(request(), response(), async ctx => {
        const actual = await listQueue(ctx, merchantId, queue, query);
        const expected = pageQueue(baseline.records, queue, query, ctx.now);
        assert.deepEqual(normalise(actual), normalise(expected), `${queue}: ${JSON.stringify(query)}`);
        assert.ok(actual.items.length <= (query.limit || 25));
        assert.ok(!actual.related.some(row => row.merchantId !== merchantId), 'related rows stay in the active lender');
      }, 'read');
    }
  }
  await assert.rejects(() => inWorkspace(request(tokens[1]), response(), ctx => listQueue(ctx, merchantId, 'exceptions', { limit: 25 }), 'read'), (error: any) => error.status === 404);
  const sibling = await inWorkspace(request(), response(), ctx => listQueue(ctx, siblingId, 'collections', { record: `${merchantId}-queue-due-00001`, limit: 25 }), 'read');
  assert.equal(sibling.total, 0);
  assert.equal(sibling.related.length, 0);
  await assert.rejects(() => inWorkspace(request(), response(), ctx => listQueue(ctx, merchantId, 'collections', { view: 'invalid' }), 'read'), (error: any) => error.status === 400);
  console.log('Priority queue integration passed: 6,000 rows, all filters, complete counts, bounded pages, deep links, related-record scoping and malformed legacy dates.');
} finally {
  const principals = tokens.map(token => createHash('sha256').update(`demo:${token}`).digest('hex'));
  const scope = 'SELECT id FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=ANY($1::text[]))';
  await pool.query(`DELETE FROM valopay_idempotency WHERE merchant_id IN (${scope})`, [principals]);
  await pool.query(`DELETE FROM valopay_records WHERE merchant_id IN (${scope})`, [principals]);
  await pool.query('DELETE FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=ANY($1::text[]))', [principals]);
  await pool.query('DELETE FROM valopay_workspaces WHERE principal_hash=ANY($1::text[])', [principals]);
  await pool.end();
}
