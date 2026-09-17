# Valo Pay console contract

All data is a persistent, isolated **synthetic sandbox**. No payment or SMS is actually sent. No live data upload is permitted. Use British spelling, NGN (kobo / 100) and Africa/Lagos dates. Always say “We never hold money”. Keep a visible “Sandbox · synthetic data” label and current Observation mode. No claims of compliance, live success, or gate passes from seed data.

## Records
API `ValopayRecord`: id, merchantId, kind, name, status, reference, amountKobo, customerId, createdAt, updatedAt, data (metadata).

Every status list, enum, failure code, exception type and resolution code below is defined once in `lib/valopay-schema` (`@workspace/valopay-schema`) and consumed by the API validator and the console. Never retype a value from this document; import it.

Kinds and data fields:
- customers: name, reference, status active; data bankName, accountMasked, phoneMasked, consentProvenance.
- mandates: customerId, amountKobo=limit, reference provider ref, status per the TRD 4.2 machine (draft/submitted/pending_activation/active/suspended/expired/cancelled/failed; `mandateTransitions`); data workflow (`activationWorkflows`), frequency (`mandateFrequencies`), activationDeadline, consentEvidence, consentGaps, consentGiven, policyId, origin (created/imported/reissued), reminderCount, reissuedFrom. A PATCH may only follow the machine and never into cancelled or suspended; use the actions.
- due-items: customerId, reference, amountKobo, status scheduled/in_collection/partially_paid/paid/unpaid_final/in_dispute/cancelled/closed (derived; never set by PATCH); data dueDate, mandateId, owner (`executionOwners`; the TRD spelling `valo` is accepted and stored as `valopay`), outstandingKobo, overrideReason (needed between ₦5,000 and the merchant minimum from settings), amendedAt (set when amount or dueDate change), experimentId/experimentArm/firstFailureAt (immutable once assigned).
- attempts: customerId, amountKobo, status scheduled/sent/succeeded/failed/unknown/cancelled/reversed; data dueItemId, number (across every source), source=external, failureCode (normalised to the TRD 4.4 catalogue `failureCodes`; unmapped codes become UNKNOWN with rawFailureCode kept), occurredAt, providerReference (the debit reference the ladder's R1 matches on), noticeId.
- observations: customerId, reference canonical provider reference, amountKobo, status resolved/unresolved; data source (`observationSources`), dueItemId (a strong link the ladder treats as R1 when the amount matches), narration, paymentId, resolutionKey, batchReference, feeKobo, grossAmountKobo, occurredAt, reversed, provider=Sandbox Rail.
- payments: customerId, reference, amountKobo; status unallocated/proposed/allocated/partial/overpaid/possible_duplicate; data channel, observedAt, and the four independent dimensions collectionStatus (received/succeeded/failed/unknown), settlementStatus (unsettled/settled/variance), reversalStatus (none/reversed), refundStatus (none/requested/refunded); dueItemId, allocatedKobo, explanation. Legacy spellings not_reversed/not_refunded are read as none.
- allocations: customerId, amountKobo, status confirmed/proposed/superseded; data paymentId, dueItemId, rule, confidence, explanation, reviewed (correct/wrong), automatic.
- settlement-batches: name, reference=batchReference (the validator copies one to the other), status pending/reconciled/variance (set by reconciliation); data provider, batchReference, grossKobo, feeKobo (stated by the provider), expectedFeeKobo (from the per-provider `providerFeeSchedule` in settings, default 0.5% capped at ₦1,000), feeVarianceKobo, netKobo, lineObservationIds, linePaymentIds. Statement batch credits never become customer payments.
- exceptions: customerId, amountKobo, status open/assigned/in_progress/resolved/closed (`exceptionTransitions`; resolved only through resolve_exception); data type (Appendix A `exceptionCatalogue`: activation_expired, unallocated_payment, suspected_duplicate, overpayment, unpaid_after_final_attempt, mandate_limit_exceeded, settlement_variance, provider_status_mismatch, customer_dispute, unknown_outcome, notice_not_evidenced, ownership_conflict, imported_consent_gap, mapping_needed), severity, owner and dueBy (defaulted from the catalogue: owner per type, SLA in business days), resolutionCode (from `resolutionCodesFor(type)`), notes, linkedRecordId.
- policies: status draft/submitted/approved/rejected; data version, maxAttempts (<=4), spacingHours (>=24), firstNoticeHours (>=24), retryNoticeHours (>=24), partialAllowed=false, author, reviewer, complianceMapping (`policyGuardrails`). Approved versions immutable; a policy-version kill switch is therefore stored in settings.policyKillSwitches.
- templates: status draft/submitted/approved; data purpose, text, author, reviewer, version. Text requires {{amount}}, {{date}}, {{merchant}}, {{contact}}.
- notifications: status simulated/blocked; data purpose, channel, renderedText, acceptedAt, deliveredAt, costKobo.
- cutovers: status draft/ready/handed_back; data inventory, incumbentDisabled, externalAttemptsImported, dualRunComplete, accountableUser, fallbackOwner, confirmation. `ready` needs all three step flags plus accountableUser and confirmation (DEB-11); only then may a due item carry owner valopay. hand_back reverts to fallbackOwner. SIMULATION only.
- audit: immutable name=action, data actor, previousHash, hash, objectId, summary.
- closes: completed daily close snapshots; data summary, metrics.
- exports: generated download metadata; data checksum, kind, format, usedInRealCase=false.
- commercial: name prospect; data monthlyVolume, averageTicketKobo, implementationKobo, licenceKobo, usageBps=30, usageCapKobo=15000, signed, signedFullPriceTerms, effectiveDate, startCondition, conversationComplete, designPartner. Only list-price entries qualify; synthetic evidence does NOT pass real Test3.
- reviews: fortnightly review notes data confirmedJobs, note, reviewer, reviewedAt. Synthetic does NOT pass real Test5.
- evidence: status pending/recorded; data gateId (P1…P5, F1…F4, T1b, T2; what the gate register matches on), reference, notes. Evidence registers are not verification.
- experiments: draft/preregistered/closed; data baselineRate, holdoutShare (0.1–0.5), minPerArm, analysisDate, enrolmentClose, seed, policyId.
- costs: name infrastructure/support/notifications; amountKobo, data period.
- calendar: name holiday, data date.
- members: read-only demo role identities.

## Pages
- `/` shows the operations overview, accessible sandbox without login, with Sign in to own workspace.
- `/customers` and `/customers/:id` with position and complete timeline.
- `/mandates`, `/collections` (due items/attempts), `/reconciliation` (payments/observations/proposals, settlement batches and the REC-09 precision audit of automatic certain allocations), `/exceptions` (filters: all open, high severity, resolved).
- `/policies` includes versioned retry policies and notification templates.
- `/reports` daily closes, operational measurement, recovery experiment, billing statement.
- `/evidence` prerequisite evidence, commercial commitments, three distinct decisions and gate export.
- `/audit` hash-chain log and verification; the verify result (valid, entry count, head hash) is shown on the page and as a toast, never an alert.
- `/settings` roles, access matrix, providers (not connected), calendar, execution settings, cutover and hand-back.
- `/sign-in/*?`, `/sign-up/*?` Clerk branded; authenticated home can redirect to `/overview` same overview. On a local host with no `VITE_CLERK_PUBLISHABLE_KEY` the console runs without Clerk (`lib/auth.tsx`): sign-in links are hidden, these routes redirect to `/`, and the anonymous sandbox loads. Elsewhere workspace loading waits at most five seconds for Clerk.

## Mutations
createRecord and updateRecord for editable kinds. Business actions go to performAction:
- `set_role` data.role (Admin / Operations / Finance / Compliance reviewer / Read-only), **demo personas ONLY**, each is a separate simulated identity; no real permission granted.
- `kill_switch` data.enabled boolean, optional data.policyId, and reason; requires Admin. Cancels scheduled attempts under the switched scope.
- `request_instruction` always blocks: live integration/security gates unmet.
- `mandate_suspend` (active only), `mandate_reinstate` (suspended only), `mandate_cancel` (cancels scheduled attempts), `mandate_reissue` (creates a new mandate; needs data.consentEvidence), `activation_reminder` (pending_activation only; caps 4 transfer_to_activate / 2 hosted_consent, none once consentGiven; refused in quiet hours 21:00–08:00 WAT; logs a notifications record) recordId and reason.
- `submit_policy`, `approve_policy`, `reject_policy`, `new_policy_version` recordId and reason; approval uses different actor and Compliance reviewer role. Same for templates via `submit_template`, `approve_template`.
- `run_reconciliation`, `daily_close` no id. Reconciliation resolves observations to canonical payments, holds suspected duplicates (a payment for an already-paid due item, or the same payer and amount within two minutes), applies the ladder R1 to R5, checks settlement fees against the schedule, raises catalogue exceptions with business-day deadlines, and applies the 6.3 give-up rows (unpaid_final, in_dispute, unknown outcome after 24 hours).
- `confirm_allocation`, `reject_allocation` recordId=payment ID for proposal, reason; Finance/Admin.
- `manual_allocate` recordId=payment ID, data.dueItemId and data.amountKobo, reason.
- `review_allocation` recordId=allocation ID, data.correct boolean, reason; Finance/Admin. `correct=false` supersedes the allocation and reopens the payment and due item (REC-09). RecordDialog always submits checkbox fields as booleans.
- `resolve_exception` recordId and reason, data.resolutionCode from `resolutionCodesFor(exception.data.type)` (Appendix A per type; the generic list only for legacy types); use structured appropriate action first.
- `record_refund` recordId=payment ID data.reference external refund reference, reason. Only records external action, never moves funds.
- `simulate_failure` recordId=due item, data.failureCode from `failureCodeList` (aliases such as ACCOUNT_CLOSED are normalised); TIMEOUT_UNKNOWN creates an attempt with status unknown, which blocks retries until resolved. Not a real debit.
- `backtest_policy` recordId=policy -> result.data.decisions list of {dueItemId,decision,rule,reason,nextAt,inputs}; decisions follow the TRD 6.3 table in order (settled, kill switch, in-flight, non-retryable, ceiling, restricted once, approval, floor and merchant minimum, mandate, consent, holdout, ownership, mode, notice evidence, plan); explicitly not a recovery estimate.
- `preregister_experiment` recordId=experiment; freezes parameters, computes sample.
- `hand_back` reason; restores all Valo ownership to the cutover contract's fallbackOwner (default lms), cancels scheduled attempts, records checklist.
- `verify_audit` result.data.valid, count, headHash.
- `mark_pack_used` always refuses to count synthetic exports as real cases.

## Imports & exports
`importRecords`: kind customers/mandates/due-items/attempts/observations, csv text, syntheticOnly=true, commit=false for preview; commit=true to persist. Show errors per row. Header contract matches record properties plus data fields above. Default download a sample CSV for chosen kind. No real data!
`createExport`: kind (record kind / gate-pack / customer-pack / billing), customerId optional, format csv/json/pdf => downloadUrl to same API, checksum. Download or link returned URL; no fake toasts. Exports audit automatically. No persistent uploaded files in this build; CSV parsed then discarded; reports rebuilt from immutable snapshot metadata.
`getReports`: metrics; billing (integer totals and item lines); experiment (result not_proven/deferred, sample and rules), operational (all evidence measured, synthetic unqualified), closes.
`getGates`: prerequisites list and independent decisions always unproven on demo. limitations enumerates external missing requirements.

Use every provided hook, loading/error states and query invalidation. Main agent builds API concurrently; no hardcoded operational data in client.