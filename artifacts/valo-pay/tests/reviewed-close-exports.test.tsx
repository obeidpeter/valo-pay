import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor } from './harness';
import { makeRecord } from '../../api-server/src/domain/records';
import { bindCloseReviewBasis, closeReviewIssues, prepareCloseReview, decideCloseReview } from '../../api-server/src/domain/close-review';
import { queueExport } from '../../api-server/src/lib/export-jobs';

let api: FakeApi, reviewId: string, closeId: string;
beforeEach(() => {
  api = installFakeApi({ queuedExports: true, now: '2026-09-25T10:00:00.000Z' });
  vi.spyOn(window, 'open').mockReturnValue(null);
  reviewId = api.mutate((state, ctx) => {
    const close = makeRecord(state, 'closes' as string, { status: 'completed', createdAt: ctx.now, updatedAt: ctx.now, name: 'Sample close', data: { closedAt: ctx.now, summary: 'Synthetic close for independent Finance review', report: { variances: { count: 0, batches: [] }, positionRebuild: { mismatches: [] }, unallocated: { count: 0 }, proposed: { count: 0 }, possibleDuplicates: { count: 0 } } } });
    closeId = close.id; bindCloseReviewBasis(state, close);
    const reviewer = { ...ctx, actor: 'Clerk:finance-checker', principalId: 'independent-finance-person', role: 'Finance' };
    const review = prepareCloseReview(state, ctx, { closeId: close.id, expectedUpdatedAt: close.updatedAt, reviewer: reviewer.actor, preparationNote: 'Prepared and checked the synthetic close evidence.', discrepancyResponses: closeReviewIssues(close).map(issue => ({ issueId: issue.id, explanation: 'Finance will review and follow up this sample discrepancy.' })), unresolvedAcceptance: 'Named Finance staff own the remaining sample follow-up.' }, [reviewer]);
    decideCloseReview(state, reviewer, review.id, { expectedUpdatedAt: review.updatedAt, action: 'approve', note: 'Independently inspected and accepted this sample snapshot.', sourceExceptions: close.data.reviewBasis.sourceCompleteness.issues.map((issue: { id: string }) => ({ issueId: issue.id, reason: 'Independent documented acceptance of this sample source gap.', evidence: 'SYNTHETIC-TEST-SOURCE' })) });
    return review.id;
  });
});
afterEach(() => api.uninstall());
const page = () => `/close-review?close=${encodeURIComponent(closeId)}`;

it('queues the exact approved review and resumes its download despite newer exports for other reviews', async () => {
  const user = userEvent.setup(), view = renderApp(page());
  await user.click(await screen.findByRole('button', { name: 'Generate reviewed close evidence (JSON)' }));
  await screen.findByText('Reviewed close evidence is queued');
  const job = api.state().records.find(record => record.kind === 'exports')!;
  expect(job.data.closeReviewId).toBe(reviewId);
  expect(api.calls.find(call => call.path === '/v1/exports' && call.method === 'POST')?.body).toEqual({ kind: 'reviewed-close', closeReviewId: reviewId, format: 'json' });
  expect(window.open).not.toHaveBeenCalled();
  api.mutate(state => {
    for (let index = 0; index < 7; index++) makeRecord(state, 'exports', { name: 'Another reviewed close', status: 'ready', createdAt: '2026-09-25T11:00:00.000Z', data: { kind: 'reviewed-close', closeReviewId: `other-review-${index}`, format: 'json', checksum: 'b'.repeat(64), generatedAt: api.now } });
  });
  view.unmount(); renderApp(page());
  await screen.findByText('Reviewed close evidence is queued');
  api.mutate(state => { const saved = state.records.find(record => record.id === job.id)!; saved.status = 'ready'; Object.assign(saved.data, { checksum: 'a'.repeat(64), generatedAt: api.now, byteLength: 123 }); });
  const link = await screen.findByRole('link', { name: 'Open reviewed close evidence' }, { timeout: 5000 });
  expect(link.getAttribute('href')).toContain(job.id);
  expect(screen.queryByText(/Recent exports/)).toBeNull();
  expect(api.calls.filter(call => call.method === 'POST' && call.path === '/v1/exports')).toHaveLength(1);
  await user.click(screen.getByText('File verification and access'));
  expect(screen.getByText(/approved retention run/)).toBeTruthy();
});

it('keeps a malformed committed receipt uncertain and replays the original review, format and key', async () => {
  const user = userEvent.setup(), baseFetch = globalThis.fetch;
  const requests: Array<{ key: string; body: string }> = [];
  let committed: Response | undefined;
  globalThis.fetch = async (input, options) => {
    if (!String(input).includes('/v1/exports?') || options?.method !== 'POST') return baseFetch(input, options);
    requests.push({ key: new Headers(options.headers).get('Idempotency-Key') || '', body: String(options.body) });
    if (committed) return committed.clone();
    committed = await baseFetch(input, options);
    expect(committed.status).toBe(200);
    return new Response(JSON.stringify({ status: 'queued' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  renderApp(page());
  await user.click(await screen.findByRole('button', { name: 'PDF' }));
  await screen.findByRole('button', { name: 'Retry original request' });
  expect(screen.getByRole('button', { name: 'Generate reviewed close evidence (JSON)' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'PDF' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('link', { name: 'Open reviewed close evidence' })).toBeNull();
  expect(window.open).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Retry original request' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry original request' })).toBeNull());
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].key).not.toBe('');
  expect(JSON.parse(requests[0].body)).toEqual({ kind: 'reviewed-close', closeReviewId: reviewId, format: 'pdf' });
  expect(api.state().records.filter(record => record.kind === 'exports')).toHaveLength(1);
});

it('shows a retained receipt for an expired reviewed-close file without offering its deleted download', async () => {
  const job = api.mutate((state, ctx) => queueExport(state, ctx, { kind: 'reviewed-close', closeReviewId: reviewId, format: 'pdf' }, 'sample/private'));
  api.mutate(state => { const saved = state.records.find(record => record.id === job.id)!; saved.status = 'ready'; Object.assign(saved.data, { checksum: 'c'.repeat(64), generatedAt: api.now, fileDeletedAt: api.now, byteLength: 123 }); });
  renderApp(page());
  await screen.findByText('Reviewed close evidence file has expired');
  expect(screen.queryByRole('link', { name: 'Open reviewed close evidence' })).toBeNull();
  expect(window.open).not.toHaveBeenCalled();
  expect(screen.getByText(/Its checksum and deletion receipt remain available/)).toBeTruthy();
});

for (const status of ['ready', 'failed']) it(`lets a read-only reviewer inspect a ${status} export while blocking new generation and retry`, async () => {
  const job = api.mutate((state, ctx) => queueExport(state, ctx, { kind: 'reviewed-close', closeReviewId: reviewId, format: 'json' }, 'sample/private'));
  api.mutate(state => { const saved = state.records.find(record => record.id === job.id)!; saved.status = status; Object.assign(saved.data, { checksum: 'd'.repeat(64), generatedAt: api.now, lastError: 'Generation could not finish.', byteLength: 123 }); });
  api.role = 'Read-only'; renderApp(page());
  const create = await screen.findByRole('button', { name: 'Generate reviewed close evidence (JSON)' });
  expect(create.hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'PDF' }).hasAttribute('disabled')).toBe(true);
  if (status === 'ready') expect((await screen.findByRole('link', { name: 'Open reviewed close evidence' })).getAttribute('href')).toContain(job.id);
  else expect((await screen.findByRole('button', { name: 'Retry export' })).hasAttribute('disabled')).toBe(true);
  expect(api.calls.filter(call => call.path.startsWith('/v1/exports') && call.method === 'POST')).toHaveLength(0);
});
