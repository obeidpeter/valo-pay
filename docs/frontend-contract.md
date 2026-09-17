# Valo Pay console contract

All data is a persistent, isolated **synthetic sandbox**. No payment or SMS is actually sent. No live data upload is permitted. Use British spelling, NGN (kobo / 100) and Africa/Lagos dates. Always say “We never hold money”. Keep a visible “Sandbox · synthetic data” label and current Observation mode. No claims of compliance, live success, or gate passes from seed data.

## Records
API `ValopayRecord`: id, merchantId, kind, name, status, reference, amountKobo, customerId, createdAt, updatedAt, data (metadata).
Kinds and data fields:
- customers: name, reference, status active; data bankName, accountMasked, phoneMasked, consentProvenance.
- mandates: customerId, amountKobo=limit, reference provider ref, status active/pending_activation/suspended/cancelled/expired; data workflow (transfer_to_activate/hosted_consent), frequency, activationDeadline, consentEvidence, consentGaps, policyId, origin=imported, reminderCount.
- due-items: customerId, reference, amountKobo, status scheduled/in_collection/paid/partially_paid/unpaid_final/in_dispute; data dueDate, mandateId, owner (lms/merchant_manual/provider_auto/valopay), outstandingKobo, overrideReason.
- attempts: customerId, amountKobo, status succeeded/failed/unknown/scheduled/cancelled; data dueItemId, number, source=external, failureCode, occurredAt, noticeId.
- observations: customerId, reference canonical provider reference, amountKobo, status resolved/unresolved; data source (webhook/settlement/statement/transfer/card), dueItemId, narration, paymentId, resolutionKey, batchReference, provider=Sandbox Rail.
- payments: customerId, reference, amountKobo; status allocated/proposed/unallocated/possible_duplicate; data channel, collectionStatus, settlementStatus, reversalStatus, refundStatus, dueItemId, allocatedKobo, rule, confidence, explanation.
- allocations: customerId, amountKobo, status confirmed/proposed/superseded; data paymentId, dueItemId, rule, confidence, explanation, reviewed (correct/wrong), automatic.
- settlement-batches: name, reference=batchReference, status pending/reconciled/variance; data provider, batchReference, grossKobo, feeKobo, netKobo, linePaymentIds. Statement batch credits never become customer payments.
- exceptions: customerId, amountKobo, status open/assigned/in_progress/resolved/closed; data type, severity (high/medium/low), owner, dueBy, resolutionCode, notes, linkedRecordId.
- policies: status draft/submitted/approved/rejected; data version, maxAttempts (<=4), spacingHours (>=24), firstNoticeHours (>=24), retryNoticeHours (>=24), partialAllowed=false, author, reviewer, complianceMapping. Approved versions immutable.
- templates: status draft/submitted/approved; data purpose, text, author, reviewer, version. Text requires {{amount}}, {{date}}, {{merchant}}, {{contact}}.
- notifications: status simulated/blocked; data purpose, channel, renderedText, acceptedAt, deliveredAt, costKobo.
- cutovers: status draft/ready/handed_back; data inventory, incumbentDisabled, externalAttemptsImported, dualRunComplete, accountableUser, fallbackOwner, confirmation. SIMULATION only.
- audit: immutable name=action, data actor, previousHash, hash, objectId, summary.
- closes: completed daily close snapshots; data summary, metrics.
- exports: generated download metadata; data checksum, kind, format, usedInRealCase=false.
- commercial: name prospect; data monthlyVolume, averageTicketKobo, implementationKobo, licenceKobo, usageBps=30, usageCapKobo=15000, signed, signedFullPriceTerms, effectiveDate, startCondition, conversationComplete, designPartner. Only list-price entries qualify; synthetic evidence does NOT pass real Test3.
- reviews: fortnightly review notes data confirmedJobs, note, reviewer, reviewedAt. Synthetic does NOT pass real Test5.
- evidence: name=P1…P5 or F4/T1b; status pending/recorded; data reference, notes. Evidence registers are not verification.
- experiments: draft/preregistered/closed; data baselineRate, holdoutShare (0.1–0.5), minPerArm, analysisDate, enrolmentClose, seed, policyId.
- costs: name infrastructure/support/notifications; amountKobo, data period.
- calendar: name holiday, data date.
- members: read-only demo role identities.

## Pages
- `/` shows the operations overview, accessible sandbox without login, with Sign in to own workspace.
- `/customers` and `/customers/:id` with position and complete timeline.
- `/mandates`, `/collections` (due items/attempts), `/reconciliation` (payments/observations/proposals), `/exceptions`.
- `/policies` includes versioned retry policies and notification templates.
- `/reports` daily closes, operational measurement, recovery experiment, billing statement.
- `/evidence` prerequisite evidence, commercial commitments, three distinct decisions and gate export.
- `/audit` hash-chain log and verification.
- `/settings` roles, access matrix, providers (not connected), calendar, execution settings, cutover and hand-back.
- `/sign-in/*?`, `/sign-up/*?` Clerk branded; authenticated home can redirect to `/overview` same overview.

## Mutations
createRecord and updateRecord for editable kinds. Business actions go to performAction:
- `set_role` data.role (Admin / Operations / Finance / Compliance reviewer / Read-only), **demo personas ONLY**, each is a separate simulated identity; no real permission granted.
- `kill_switch` data.enabled boolean and reason; requires Admin.
- `request_instruction` always blocks: live integration/security gates unmet.
- `mandate_suspend`, `mandate_cancel`, `mandate_reissue`, `activation_reminder` recordId and reason (reminder simulated with caps/quiet hours).
- `submit_policy`, `approve_policy`, `reject_policy`, `new_policy_version` recordId and reason; approval uses different actor and Compliance reviewer role. Same for templates via `submit_template`, `approve_template`.
- `run_reconciliation`, `daily_close` no id.
- `confirm_allocation`, `reject_allocation` recordId=payment ID for proposal, reason; Finance/Admin.
- `manual_allocate` recordId=payment ID, data.dueItemId and data.amountKobo, reason.
- `review_allocation` recordId=allocation ID, data.correct boolean, reason; Finance/Admin.
- `resolve_exception` recordId and reason, data.resolutionCode one of allocated, duplicate_confirmed, no_action_required, mandate_reissued, customer_contacted, ownership_corrected, evidence_received, refunded_externally; use structured appropriate action first.
- `record_refund` recordId=payment ID data.reference external refund reference, reason. Only records external action, never moves funds.
- `simulate_failure` recordId=due item, data.failureCode; creates simulated external failed attempt for policy backtest. Not a real debit.
- `backtest_policy` recordId=policy -> result.data.decisions list of {dueItemId,decision,reason,nextAt}; explicitly not a recovery estimate.
- `preregister_experiment` recordId=experiment; freezes parameters, computes sample.
- `hand_back` reason; restores all Valo ownership to lms, cancels scheduled attempts, records checklist.
- `verify_audit` result.data.valid, count, headHash.
- `mark_pack_used` always refuses to count synthetic exports as real cases.

## Imports & exports
`importRecords`: kind customers/mandates/due-items/attempts/observations, csv text, syntheticOnly=true, commit=false for preview; commit=true to persist. Show errors per row. Header contract matches record properties plus data fields above. Default download a sample CSV for chosen kind. No real data!
`createExport`: kind (record kind / gate-pack / customer-pack / billing), customerId optional, format csv/json/pdf => downloadUrl to same API, checksum. Download or link returned URL; no fake toasts. Exports audit automatically. No persistent uploaded files in this build; CSV parsed then discarded; reports rebuilt from immutable snapshot metadata.
`getReports`: metrics; billing (integer totals and item lines); experiment (result not_proven/deferred, sample and rules), operational (all evidence measured, synthetic unqualified), closes.
`getGates`: prerequisites list and independent decisions always unproven on demo. limitations enumerates external missing requirements.

Use every provided hook, loading/error states and query invalidation. Main agent builds API concurrently; no hardcoded operational data in client.