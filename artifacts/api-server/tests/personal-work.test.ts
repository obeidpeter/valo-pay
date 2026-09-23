import assert from 'node:assert/strict';
import { personalWorkQuerySchema, workReceiptInputSchema, personalWorkViewSchema } from '@workspace/valopay-schema';
import { seedMerchant } from '../src/lib/valopay-seed';
import { makeRecord } from '../src/domain/records';
import { derivePersonalWork, personalWorkItems, recordWorkReceipt } from '../src/domain/personal-work';
import { bindCloseReviewBasis, closeReviewIssues, prepareCloseReview } from '../src/domain/close-review';
import { ResponseContractError } from '../src/lib/contract';
import type { DomainState, Context } from '../src/domain/types';

const now = '2026-09-25T10:00:00.000Z';
const alice = { actor: 'Clerk:alice', name: 'Alice', role: 'Operations' };
const bob = { actor: 'Clerk:bob', name: 'Bob', role: 'Finance' };
const admin = { actor: 'Clerk:admin', name: 'Administrator', role: 'Admin' };
const people = [alice, bob, admin];
const ctx: Context = { ...alice, now };
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const refuses = (fn: () => unknown, status: number) => { assert.throws(fn, (error: any) => error.status === status); checks += 1; };
const request = (item: ReturnType<typeof personalWorkItems>[number]) => ({ sourceId: item.sourceId, eventId: item.eventId, expectedUpdatedAt: item.sourceVersion, expectedDigest: item.sourceDigest });
function fixture(id = 'work-merchant') { return seedMerchant(id, true); }
function assigned(state: DomainState, options: { actor?: string; due?: string; handover?: boolean; createdAt?: string } = {}) {
  const assignee = options.actor || alice.actor;
  const record = makeRecord<string>(state, 'exceptions', { name: 'Sample account review', status: 'in_progress', createdAt: '2026-09-24T09:00:00.000Z', updatedAt: '2026-09-24T09:00:00.000Z', data: { type: 'unallocated_payment', case: { assignee, assigneeName: people.find(person => person.actor === assignee)?.name, nextAction: 'Compare the sample receipt and instalment.', nextActionAt: options.due || '2026-09-26T10:00:00.000Z' } } });
  const event = makeRecord(state, 'case-events', { name: 'Sample case assigned', status: 'recorded', createdAt: options.createdAt || '2026-09-25T09:00:00.000Z', data: { exceptionId: record.id, action: options.handover ? 'handover' : 'claim', actor: admin.actor, after: structuredClone(record.data.case) } });
  record.data.case.handoverEventId = event.id;
  record.data.case.eventId = event.id;
  return { record, event };
}
{
  const state = fixture();
  const a = assigned(state), b = assigned(state, { actor: bob.actor });
  const own = derivePersonalWork(state, ctx, people);
  check(own.scope === 'mine' && own.total === 1 && own.items[0]!.sourceId === a.record.id, 'default is only the current actor/current lender');
  refuses(() => derivePersonalWork(state, ctx, people, { scope: 'team' }), 403);
  const team = derivePersonalWork(state, { ...admin, now }, people, { scope: 'team' });
  check(team.total === 2 && team.workload.length === 2 && team.items.every(item => !item.canAcknowledge), 'administrator sees own-lender workload without acknowledging for others');
  refuses(() => derivePersonalWork(state, ctx, people, { merchantId: 'different-lender' }), 403);
  const foreign = fixture('foreign-lender'), foreignCase = assigned(foreign, { actor: alice.actor, handover: true });
  state.records.push(...foreign.records);
  check(derivePersonalWork(state, ctx, people).total === 1, 'foreign lender records are not derived even if accidentally mixed into the input');
  const foreignItem = personalWorkItems(foreign, ctx, people)[0]!;
  refuses(() => recordWorkReceipt(state, ctx, people, 'acknowledge', request(foreignItem)), 404);
  check(!JSON.stringify(own).includes(b.record.id) && !JSON.stringify(own).includes(foreignCase.record.id), 'own response does not disclose other assignments');
}
{
  const state = fixture('ack');
  const { record, event } = assigned(state, { handover: true });
  const item = personalWorkItems(state, ctx, people)[0]!;
  check(item.type === 'handover' && item.canAcknowledge, 'intended current assignee can acknowledge a handover');
  const before = JSON.stringify(state.records.filter(saved => saved.kind !== 'work-events'));
  refuses(() => recordWorkReceipt(state, { ...bob, now }, people, 'acknowledge', request(item)), 403);
  refuses(() => recordWorkReceipt(state, { ...admin, now }, people, 'acknowledge', request(item)), 403);
  refuses(() => recordWorkReceipt(state, { ...ctx, role: 'Read-only' }, people, 'acknowledge', request(item)), 403);
  refuses(() => recordWorkReceipt(state, ctx, people.filter(person => person.actor !== alice.actor), 'acknowledge', request(item)), 403);
  refuses(() => recordWorkReceipt(state, ctx, people, 'acknowledge', { ...request(item), expectedDigest: 'a'.repeat(64) }), 409);
  refuses(() => recordWorkReceipt(state, ctx, people, 'acknowledge', { ...request(item), expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }), 409);
  const saved = recordWorkReceipt(state, ctx, people, 'acknowledge', request(item));
  check(saved.financialStatusChanged === false && saved.actor === alice.actor && !saved.duplicate, 'saved acknowledgement identifies actor/source and does not claim a financial change');
  check(state.records.filter(saved => saved.kind === 'work-events').length === 1, 'one acknowledgement event saved');
  const replay = recordWorkReceipt(state, ctx, people, 'acknowledge', request(item));
  check(replay.id === saved.id && replay.duplicate, 'duplicate acknowledgement returns the original receipt');
  check(state.records.filter(saved => saved.kind === 'work-events').length === 1, 'duplicate acknowledgement does not append another event');
  check(JSON.stringify(state.records.filter(saved => saved.kind !== 'work-events')) === before, 'ack does not change case status, assignment, amounts or source history');
  check(personalWorkItems(state, ctx, people)[0]!.type === 'case', 'acknowledged handover remains an assigned case');
  record.data.case.nextAction = 'A later instruction'; record.updatedAt = '2026-09-25T10:01:00.000Z';
  refuses(() => recordWorkReceipt(state, ctx, people, 'acknowledge', request(item)), 409);
  check(personalWorkItems(state, ctx, people)[0]!.type === 'case', 'a progress note does not create another handover');
  const second = makeRecord(state, 'case-events', { name: 'New handover', status: 'recorded', createdAt: '2026-09-25T10:02:00.000Z', data: { exceptionId: record.id, action: 'handover', after: structuredClone(record.data.case) } });
  record.data.case.handoverEventId = second.id;
  check(personalWorkItems(state, ctx, people)[0]!.type === 'handover' && second.id !== event.id, 'a fresh handover to the same person requires new acknowledgement');
  record.data.case.assignee = bob.actor;
  refuses(() => recordWorkReceipt(state, ctx, people, 'acknowledge', request(item)), 403);
}
{
  const state = fixture('read'), { record } = assigned(state, { due: '2026-09-25T10:30:00.000Z' });
  const item = personalWorkItems(state, ctx, people)[0]!;
  const first = recordWorkReceipt(state, ctx, people, 'read', request(item));
  check(derivePersonalWork(state, ctx, people, { filter: 'unread' }).total === 0, 'marking read removes only the notification filter entry');
  check(derivePersonalWork(state, ctx, people).total === 1, 'marking read does not complete assigned work');
  check(recordWorkReceipt(state, ctx, people, 'read', request(item)).id === first.id, 'read receipt replay is stable');
  const later = { ...ctx, now: '2026-09-25T10:30:00.000Z' };
  const overdue = personalWorkItems(state, later, people)[0]!;
  check(overdue.overdue && !overdue.escalated && !overdue.readAt && overdue.eventId !== item.eventId, 'crossing follow-up time produces one distinct overdue notification');
  const muchLater = { ...ctx, now: '2026-09-26T10:30:00.000Z' };
  const escalated = personalWorkItems(state, muchLater, people)[0]!;
  check(escalated.escalated && escalated.eventId !== overdue.eventId, '24-hour overdue threshold creates a distinct escalation identity');
  check(personalWorkItems(state, { ...muchLater, now: '2026-09-27T10:30:00.000Z' }, people)[0]!.eventId === escalated.eventId, 'repeated refresh does not generate duplicate escalation identities');
  check(derivePersonalWork(state, muchLater, people, { filter: 'overdue' }).total === 1, 'overdue filter follows saved next-action time');
  check(derivePersonalWork(state, { ...admin, now: muchLater.now }, people, { scope: 'team' }).workload[0]!.escalated === 1, 'escalation appears in the selected lender administrator workload');
  check(record.status === 'in_progress', 'escalation has no automatic case transition');
  record.status = 'resolved';
  check(derivePersonalWork(state, ctx, people).total === 0 && derivePersonalWork(state, ctx, people).history.length === 1, 'completed source leaves the queue but read history remains');
  refuses(() => recordWorkReceipt(state, ctx, people, 'read', request(item)), 409);
}
{
  const state = fixture('handover-age');
  assigned(state, { handover: true, createdAt: '2026-09-24T10:00:00.000Z' });
  check(personalWorkItems(state, ctx, people)[0]!.escalated, 'handover escalates after 24 hours even if follow-up is later');
  const legacy = fixture('legacy'), { record, event } = assigned(legacy, { handover: true });
  delete record.data.case.handoverEventId; delete record.data.case.eventId;
  makeRecord(legacy, 'case-events', { ...event, id: 'second-same-instant', data: structuredClone(event.data) });
  const ambiguous = personalWorkItems(legacy, ctx, people)[0]!;
  check(!ambiguous.canAcknowledge && !!ambiguous.notice?.includes('ambiguous'), 'ambiguous same-time legacy assignment does not guess acknowledgement ownership');
  refuses(() => recordWorkReceipt(legacy, ctx, people, 'acknowledge', request(ambiguous)), 409);
}
{
  const state = fixture('reviews');
  const close = makeRecord(state, 'closes', { name: 'Sample daily close', status: 'closed', createdAt: '2026-09-24T08:00:00.000Z', data: {} });
  bindCloseReviewBasis(state, close);
  const review = prepareCloseReview(state, { ...admin, now: '2026-09-24T09:00:00.000Z' }, { closeId: close.id, expectedUpdatedAt: close.updatedAt, reviewer: bob.actor, preparationNote: 'Reviewed the sample close inputs.', unresolvedAcceptance: 'Sample owners retain each unresolved case for follow-up.', discrepancyResponses: closeReviewIssues(close).map(issue => ({ issueId: issue.id, explanation: 'Sample evidence reviewed; the case owner will follow up.' })) }, people);
  const bobCtx = { ...bob, now };
  check(derivePersonalWork(state, bobCtx, people, { filter: 'review' }).items[0]!.reviewCurrent === true, 'named Finance reviewer receives a current review');
  check(derivePersonalWork(state, ctx, people, { filter: 'review' }).total === 0, 'other staff do not receive another reviewer’s assignment');
  const item = personalWorkItems(state, bobCtx, people)[0]!;
  check(item.escalated && item.href.includes(close.id), 'review wait escalates after 24 hours and links to the exact close');
  recordWorkReceipt(state, bobCtx, people, 'read', request(item));
  check(review.status === 'awaiting_review', 'reading a pending review never approves it');
  const customer = state.records.find(record => record.kind === 'customers');
  if (customer) customer.name += ' changed'; else makeRecord(state, 'customers', { name: 'Later sample customer' });
  const stale = personalWorkItems(state, bobCtx, people)[0]!;
  check(stale.reviewCurrent === false && !stale.readAt, 'changed close inputs produce visible stale-review remediation, not implied approval');
  review.status = 'approved';
  check(derivePersonalWork(state, bobCtx, people).total === 0, 'decided reviews leave pending queue');
}
{
  const state = fixture('pages');
  for (let index = 0; index < 57; index++) assigned(state, { due: index < 6 ? '2026-09-24T00:00:00.000Z' : '2026-09-26T00:00:00.000Z' });
  const first = derivePersonalWork(state, ctx, people), second = derivePersonalWork(state, ctx, people, { offset: 25 });
  check(first.items.length === 25 && first.total === 57 && first.counts.overdue === 6, 'counts span the entire bounded queue');
  check(second.items.length === 25 && !second.items.some(item => first.items.some(older => older.id === item.id)), 'stable ordering produces disjoint pages');
  check(derivePersonalWork(state, ctx, people, { offset: 50 }).items.length === 7, 'final page is bounded');
  check(personalWorkViewSchema.safeParse(first).success, 'read model satisfies strict response contract');
  check(!personalWorkQuerySchema.safeParse({ merchantId: state.merchant.id, limit: 51 }).success, 'server rejects unbounded page size');
  check(!workReceiptInputSchema.safeParse({ ...request(first.items[0]!), actor: bob.actor }).success, 'body cannot inject a recipient or actor');
  check(derivePersonalWork(state, { ...ctx, role: 'Read-only' }, people).canWork === false, 'read-only current role is explicit in response');
}
{
  // A stored receipt the view cannot describe (here a link off the console) is the service's fault: a
  // ResponseContractError, answered as a 500 and logged as response.invalid, never a validation 400 (audit item 24, review).
  const state = fixture('malformed-history');
  makeRecord(state, 'work-events', { name: 'Notification read', status: 'recorded', createdAt: now, data: { action: 'read', actor: alice.actor, sourceId: 'case-1', eventId: 'event-1', summary: 'Read a case notification', href: 'https://elsewhere.example/case-1' } });
  const failure = (() => { try { derivePersonalWork(state, ctx, people); return undefined; } catch (error) { return error; } })();
  check(failure instanceof ResponseContractError && failure.issues.some(issue => issue.path === 'history.0.href'), 'an answer the view cannot describe is a fault in the answer, naming its path');
}
console.log(`Personal work: ${checks} checks passed.`);
