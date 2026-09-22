# Core-workflow findings and implementation

Inspected local baseline `cc9cca4127d963d9f8a3a600091d502c08eb4239` on branch `codex/evidence-led-usability`. Evidence below is source inspection and synthetic automated testing, not participant research. Root agent owns baseline/after browser captures and release verification. This slice did not deploy, send messages, connect a provider or move money.

## Scope and factual baseline

- Read the complete pasted assignment; inspected reconciliation, exceptions, reports, export jobs, shared record dialog, action permissions, API mutation wrappers, domain allocation/action logic, read models, saved export worker contracts and existing focused tests.
- Actual roles: Admin/Finance can allocate and review; Admin/Operations/Finance can reconcile, close and resolve exceptions; Compliance reviewer can edit exceptions but cannot resolve them; Read-only cannot write. These existing UI and server rules remain unchanged. Internal support is not a new role in this slice.
- Exception queue already had server paging/search, owner/type filters, saved views and deadline ordering. Reports already separated Operations/Billing/Pilot evidence and supported date-filtered close history. Kept these working features. No reports-page redesign justified by this inspection; shared export control improves its billing workflow.
- Exports are saved queued/running/ready/failed jobs with per-download authorisation, idempotent retries and no public expiry field. No expiry or recall feature was invented.

## UX-C01: stale proposed allocation can credit a different or excessive match

**Observed source defect; severity 3 (major), highest delivery priority.** Route `/reconciliation?view=review`, Finance/Admin. Reproduce: open a proposed match; change/replace the proposal or reduce the instalment's remaining balance in a separate committed action; confirm the original dialog. Baseline action targeted payment ID and looked up its current proposal, ignoring the reviewed proposal identity/version. `applyConfirmedAllocation` checked payment availability but not the current instalment ceiling, then clamped a negative remainder to zero. Reusing an already confirmed allocation directly could increment applied payment again. These are data-correctness defects, not colour/wording issues. Concurrent-change frequency is unknown; impact persists in financial records. Sandbox/live instructions remain disabled, so no claim of observed live monetary loss. Implementation effort: medium, bounded domain guard plus UI payload and regression tests.

Implemented: console sends `data.proposalId` and `data.proposalUpdatedAt`; server refuses mismatches with HTTP 409 before mutation. Server rechecks current instalment and payment balances; already-applied allocations are rejected. Newly created automatic/manual allocations transition through proposed within the transaction before being applied. The reviewed reason survives a conflict. No schema migration, role expansion or ceiling weakening.

Five components: learnability—error names the changed match; efficiency—refresh/review recovery keeps the reason; memorability—same review/refresh locations; errors—authoritative stale-record and ceiling protection; satisfaction—confirmation reflects the proposal actually reviewed. Human benefits remain hypotheses.

Acceptance: `reconciliation-golden.test.ts` refuses wrong/missing/changed proposal token, repeats, already-confirmed application and a reduced outstanding balance without changing state. `reconciliation-workflow.test.tsx` verifies both IDs sent, actual domain confirm/reject outcome, conflict preserves reason and proposal, no optimistic success. Existing 285-check golden suite passed.

Residual: identity/version pair remains optional for older API callers, by explicit root decision to retain the current public action contract; current console always supplies it. Plan a separately versioned requirement for old clients before any live acceptance. A timestamp cannot detect an unchanged timestamp on externally altered data; normal persistence must maintain `updatedAt`. No new cross-customer allocation policy was invented for unidentified payer records.

Paths: `artifacts/api-server/src/domain/actions.ts`, `artifacts/api-server/src/domain/reconciliation.ts`, `artifacts/api-server/tests/reconciliation-golden.test.ts`, `artifacts/valo-pay/src/pages/reconciliation.tsx`, `artifacts/valo-pay/tests/reconciliation-workflow.test.tsx`.

## UX-C02: audit correction lacks decision evidence and effect

**Observed interface/source gap; severity 3 (major).** Route `/reconciliation`, automatic-match accuracy sample. Open Mark incorrect. Baseline dialog had a checkbox/reason but no payment/instalment evidence comparable to proposal confirmation. The checkbox described reopening records but omitted the amount and resulting balances. Proposed match evidence omitted payer identity and distinct receipt/settlement state. Estimated occasional/month-end audit task; frequency/pain unmeasured. Consequence: misinterpreting a correction as an annotation or refund. Effort: small/medium; no backend expansion.

Implemented: shared decision panel shows customer, references, exact payment/outstanding amounts, source reference, receipt and settlement status, matching reason/rule, and distinct fee treatment. Changing the review choice updates the explanation: correct keeps allocation; incorrect shows restored balances and makes clear no refund/money movement occurs. Missing evidence blocks review. Manual allocation identifies whether payer is known and resets prior instalment search when a different allocation dialog opens.

Five components: learnability—plain effect/settlement distinction; efficiency—comparison stays beside the decision; memorability—same evidence structure for proposal/audit; errors—missing evidence and ceiling validation plus explicit correction amounts; satisfaction—visible, reviewable consequences. Human results pending.

Acceptance: focused test with a deterministic previous-month sample verifies effect, source/fee information and changing the checkbox without a mutation. Existing allocation precision/kobo tests still pass. Root browser review should check long content, keyboard focus and narrow viewport dialog scrolling.

Paths: reconciliation page/test above. Residual: item-level fee evidence is not returned by the paged reconciliation API. UI directs fee interpretation to settlement batches and does not fabricate a per-payment fee. Full browser/screen-reader checking belongs to integrated validation.

## UX-C03: failed acknowledgement presented as export not generated

**Observed source/interaction defect; severity 2 (minor), high recurrence risk for interrupted networks.** Reports Billing, customer dispute pack, Evidence pack. Reproduce: interrupt the export POST response; baseline says not generated and suggests starting again. Server could have saved its durable job. Frequency unknown; recurrence whenever acknowledgement is lost. Consequence is duplicate requests, user doubt and unnecessary work (not a live payment). Effort medium including shared safe-mutation integration owned by root.

Implemented: explicit unconfirmed-request copy; Check saved exports reads the saved job without POST; other format requests pause while uncertain; Retry original request preserves original format/payload/idempotency key via the shared safe wrapper. Existing queued/running/retry/ready states continue. File verification/access disclosure states download permission checks, missing expiry metadata and downloaded copies cannot be recalled.

Five components: learnability—queued versus uncertain versus failed states; efficiency—resume saved work; memorability—same saved-job location after return; errors—no new-format retry of unknown request; satisfaction—honest result and recovery choices. Human results pending.

Acceptance: 5 export-job tests verify queued re-entry, failed saved-job same-ID retry, read-only status recovery, an injected committed job after an interrupted request, and CSV original-format recovery with other formats disabled. Reports/evidence/toast regression tests updated only for changed recovery copy/action and pass.

Paths: `artifacts/valo-pay/src/components/export-job-control.tsx`, `artifacts/valo-pay/tests/export-jobs.test.tsx`, `tests/reports.test.tsx`, `tests/evidence.test.tsx`, `tests/toasts.test.tsx`. Residual: original request recovery memory is per mounted UI scope; reload uses saved job history and server idempotency rather than persisting sensitive request bodies. No file expiration policy is invented.

## UX-C04: exception resolution omits issue notes and filtered return

**Observed source/interface gap; severity 2 (minor).** Route `/exceptions?owner=Finance&type=unallocated_payment`. Open Resolve then Review customer history. Baseline resolution panel omits the recorded notes and links without `returnTo`, losing the convenient return to the selected queue. Its due date formatting also bypassed the queue's date-only WAT deadline conversion. Estimated routine task; unmeasured frequency. Effort small.

Implemented: Recorded issue panel preserves full notes; date-only deadlines use shared queue interpretation; customer history gets the same lender-scoped filtered return destination. Current `safeCustomerReturnTo` already validates permitted internal destinations, so no broad navigation changes were needed. The existing exception tabs now name and control their result panel.

Five components: learnability—reason beside outcome; efficiency—return to original owner/type/view; memorability—stable queue context; errors—read the actual issue before resolving, consistent deadline interpretation; satisfaction—less context reconstruction. Human benefits pending.

Acceptance: exception tests verify panel semantics, source notes and preserved owner/type/lender return link; guided-workflow test still confirms resolving only records an outcome and leaves payment/allocation records untouched. Root should visually inspect panel focus and long notes at tablet/phone widths.

Paths: `artifacts/valo-pay/src/pages/exceptions.tsx`, `artifacts/valo-pay/src/components/exception-context.tsx`, `artifacts/valo-pay/tests/exceptions.test.tsx`. Residual: no clinical claim of recovered human proficiency; 7–14-day repeat study pending.

## Verification and references

- `node node_modules/typescript/bin/tsc --build`: passed.
- Focused Vitest group: 33/33 passed across 7 files; one additional original-format recovery test then passed in the 5/5 export suite (34 unique relevant tests total).
- Existing reconciliation golden suite: 285 checks passed. No database-backed concurrency test or physical-device test ran in this subtask; root owns integrated suites and release decision.
- Source guidance: [NN/G five components](https://www.nngroup.com/articles/usability-101-introduction-to-usability/), [heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/), [severity convention](https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/). Ratings above are project-specific expert judgements using frequency, impact and persistence; no weighted score/certification.
- Accessibility diagnosis: [WCAG 2.2](https://www.w3.org/TR/WCAG22/) 1.3.1, 3.3.1, 3.3.3, 3.3.4 and 4.1.2 are relevant; application mapping is expert interpretation, not conformance certification. [WAI-ARIA Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) informed panel relationships.
- Current technology references consulted: [React state](https://react.dev/reference/react/useState), [TanStack Query mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations). No new dependencies or API generation needed; optional fields travel in existing free-form action data.
