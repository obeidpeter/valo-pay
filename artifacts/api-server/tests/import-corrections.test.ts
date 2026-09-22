import assert from "node:assert/strict";
import { seedMerchant } from "../src/lib/valopay-seed";
import {
  saveImportBatch,
  commitImportBatch,
} from "../src/domain/pilot-workflow";
import { makeRecord } from "../src/domain/records";
import {
  previewImportCorrection,
  proposeImportCorrection,
  decideImportCorrection,
  listImportCorrections,
  assertImportedCorrectionChange,
  assertNoDirectImportedCorrection,
} from "../src/domain/import-corrections";
import type { DomainState } from "../src/domain/types";

const ctx = {
  actor: "Clerk:operator",
  principalId: "person-operator",
  role: "Operations",
  now: "2026-09-22T09:00:00.000Z",
};
const finance = {
  actor: "Clerk:finance",
  principalId: "person-finance",
  role: "Finance",
  now: "2026-09-22T10:00:00.000Z",
};
const reviewers = [{ actor: finance.actor, role: "Finance" }];
const fresh = () => {
  const s = seedMerchant("corrections-test", true);
  s.records = [];
  return s;
};
function imported(
  s: DomainState,
  kind: "customers" | "due-items",
  csv: string,
) {
  const batch = saveImportBatch(s, ctx, {
    name: `Imported ${kind}`,
    source: "pilot-lms",
    sourceBatchId: `batch-${kind}`,
    kind,
    csv,
    identityColumn: "source_row_id",
    amountUnit: "naira",
    mapping: {},
    syntheticOnly: true,
  });
  commitImportBatch(s, ctx, batch.id, batch.updatedAt);
  return {
    batch,
    target: s.records.find((r) => r.data.importIdentity?.batchId === batch.id)!,
  };
}
const s = fresh();
const { batch, target } = imported(
  s,
  "customers",
  "source_row_id,name,reference,consentProvenance\nc-1,Synthetic customer,COR-C-1,Synthetic consent",
);
const input = {
  batchId: batch.id,
  targetId: target.id,
  expectedUpdatedAt: target.updatedAt,
  changes: { name: "Corrected synthetic customer" },
  syntheticOnly: true as const,
};
const originalBatch = structuredClone(batch),
  originalTarget = structuredClone(target);
const preview = previewImportCorrection(s, ctx, input);
assert.equal(preview.blockers.length, 0);
assert.equal(preview.financial, false);
assert.equal(preview.differences[0]?.before, "Synthetic customer");
assert.throws(
  () => previewImportCorrection(s, { ...ctx, role: "Read-only" }, input),
  /role/,
);
assert.throws(
  () =>
    previewImportCorrection(s, ctx, {
      ...input,
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
    }),
  /changed/,
);
const proposalInput = {
  ...input,
  previewDigest: preview.previewDigest,
  reviewer: finance.actor,
  reason: "Correct the misspelled source name",
  evidence: "SOURCE-CORRECTION-001",
};
assert.throws(
  () =>
    proposeImportCorrection(
      s,
      ctx,
      { ...proposalInput, previewDigest: "0".repeat(64) },
      reviewers,
    ),
  /comparison changed/,
);
const proposal = proposeImportCorrection(s, ctx, proposalInput, reviewers);
assert.deepEqual(target, originalTarget);
assert.deepEqual(batch, originalBatch);
assert.throws(
  () => proposeImportCorrection(s, ctx, proposalInput, reviewers),
  /open correction/,
);
const decision = {
  proposalDigest: proposal.proposalDigest,
  action: "approve" as const,
  reason: "Checked against corrected source evidence",
};
assert.throws(
  () =>
    decideImportCorrection(
      s,
      { ...finance, principalId: ctx.principalId },
      proposal.id,
      decision,
      reviewers,
    ),
  /different person/,
);
assert.throws(
  () => decideImportCorrection(s, ctx, proposal.id, decision, reviewers),
  /named active Finance/,
);
const snapshot = structuredClone(s);
const approved = decideImportCorrection(
  s,
  finance,
  proposal.id,
  decision,
  reviewers,
);
assert.equal(approved.status, "approved");
assert.equal(target.name, "Corrected synthetic customer");
assert.deepEqual(
  target.data.importIdentity,
  originalTarget.data.importIdentity,
);
assert.deepEqual(batch, originalBatch);
assert.doesNotThrow(() =>
  assertImportedCorrectionChange(originalTarget, target, snapshot, s),
);
assert.throws(
  () => assertNoDirectImportedCorrection(originalTarget, target),
  /independent Finance/,
);
for (const patch of [
  { reference: "CHANGED-SOURCE" },
  { customerId: "different-person" },
  { data: { ...originalTarget.data, bankName: "Changed bank" } },
  { status: "inactive" },
]) {
  assert.throws(
    () =>
      assertNoDirectImportedCorrection(originalTarget, {
        ...originalTarget,
        ...patch,
      }),
    /cannot be edited directly/,
  );
}
assert.doesNotThrow(() =>
  assertNoDirectImportedCorrection(originalTarget, {
    ...originalTarget,
    updatedAt: finance.now,
  }),
);
assert.throws(
  () => decideImportCorrection(s, finance, proposal.id, decision, reviewers),
  /already has a decision/,
);
const forged = structuredClone(s);
forged.records.find((r) => r.id === proposal.id)!.data.after.name = "Forged";
assert.throws(
  () =>
    assertImportedCorrectionChange(
      originalTarget,
      { ...target, name: "Forged" },
      snapshot,
      forged,
    ),
  /independently approved/,
);
assert.throws(
  () => assertImportedCorrectionChange(originalTarget, target, s, s),
  /independently approved/,
);
assert.throws(
  () =>
    previewImportCorrection(
      { ...s, merchant: { ...s.merchant, id: "foreign" } },
      ctx,
      input,
    ),
  /committed import batch/,
);

const financial = fresh();
const customer = imported(
  financial,
  "customers",
  "source_row_id,name,reference,consentProvenance\nc-1,Synthetic payer,COR-C-2,Synthetic consent",
).target;
const instalment = imported(
  financial,
  "due-items",
  "source_row_id,name,reference,customerId,amount,dueDate,owner\nd-1,Synthetic instalment,COR-D-1,COR-C-2,25000,2028-12-01,lms",
);
const dueInput = {
  batchId: instalment.batch.id,
  targetId: instalment.target.id,
  expectedUpdatedAt: instalment.target.updatedAt,
  changes: { amountKobo: 3000000, dueDate: "2028-12-02" },
  syntheticOnly: true as const,
};
const close = makeRecord(financial, "closes", {
  name: "Historical close",
  status: "complete",
  createdAt: "2026-09-21T18:00:00.000Z",
});
const duePreview = previewImportCorrection(financial, ctx, dueInput);
assert.equal(duePreview.financial, true);
assert.deepEqual(duePreview.blockers, []);
assert.ok(duePreview.affected.some((r) => r.id === close.id));
const dueProposal = proposeImportCorrection(
  financial,
  ctx,
  {
    ...dueInput,
    previewDigest: duePreview.previewDigest,
    reviewer: finance.actor,
    reason: "Upstream scheduled amount was corrected",
    evidence: "SOURCE-AMOUNT-002",
  },
  reviewers,
);
// A close recorded after the comparison (tonight's scheduled close) carries
// the same uncorrected value but does not change what approval does, so it
// leaves the proposal current; only closes recorded before it are its evidence.
makeRecord(financial, "closes", {
  name: "Later close",
  status: "complete",
  createdAt: "2026-09-22T23:00:00.000Z",
});
assert.equal(
  listImportCorrections(financial, ctx, instalment.batch.id).proposals.find(
    (p) => p.id === dueProposal.id,
  )?.current,
  true,
);
const dueSnapshot = structuredClone(financial);
const dueDecision = { ...decision, proposalDigest: dueProposal.proposalDigest };
decideImportCorrection(
  financial,
  finance,
  dueProposal.id,
  dueDecision,
  reviewers,
);
assert.equal(instalment.target.amountKobo, 3000000);
assert.equal(instalment.target.data.outstandingKobo, 3000000);
assert.doesNotThrow(() =>
  assertImportedCorrectionChange(
    dueSnapshot.records.find((r) => r.id === instalment.target.id)!,
    instalment.target,
    dueSnapshot,
    financial,
  ),
);
makeRecord(financial, "payments", {
  customerId: customer.id,
  name: "New payment",
  amountKobo: 3000000,
});
assert.throws(
  () =>
    assertImportedCorrectionChange(
      dueSnapshot.records.find((r) => r.id === instalment.target.id)!,
      instalment.target,
      dueSnapshot,
      financial,
    ),
  /dependencies changed/,
);
const blocked = previewImportCorrection(financial, ctx, {
  ...dueInput,
  expectedUpdatedAt: instalment.target.updatedAt,
  changes: { amountKobo: 3500000 },
});
assert.ok(
  blocked.blockers.some((b) => /payment or collection history/.test(b)),
);
assert.ok(blocked.affected.some((r) => r.kind === "payments"));

const stale = structuredClone(dueSnapshot);
makeRecord(stale, "allocations", {
  customerId: customer.id,
  data: { dueItemId: instalment.target.id },
});
assert.throws(
  () =>
    decideImportCorrection(
      stale,
      finance,
      dueProposal.id,
      dueDecision,
      reviewers,
    ),
  /evidence changed/,
);
assert.equal(
  listImportCorrections(stale, ctx, instalment.batch.id).proposals[0]?.current,
  false,
);
assert.throws(
  () =>
    decideImportCorrection(
      stale,
      finance,
      dueProposal.id,
      { ...dueDecision, action: "withdraw" },
      reviewers,
    ),
  /Only the proposer/,
);
assert.equal(
  decideImportCorrection(
    stale,
    ctx,
    dueProposal.id,
    { ...dueDecision, action: "withdraw" },
    reviewers,
  ).status,
  "withdrawn",
);
console.log(
  "Import correction checks passed: immutable provenance, exact comparison, independent approval, stale dependencies, controlled financial changes, withdrawal and isolation.",
);
