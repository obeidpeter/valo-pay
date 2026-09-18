# Valo Pay — build status

## Delivery boundary

This is a working, persistent **synthetic observation sandbox** built towards Stage 1. It is **not** a claim that all 137 Stage 1 MUST requirements, live acceptance tests, regulatory prerequisites or nine-month pilot evidence have been completed.

The Business Plan v2.1 Gate Change Note, Technical Requirements v1.1 and Roadmap v1.1 govern scope. Stage 1 is two lenders and one aggregator. No funds are held.

## Available in this build

- Two isolated sample lenders per browser sandbox or signed-in workspace.
- Customer records, masked sample identifiers, obligations and timeline.
- Mandate tracking with imported consent provenance and provider-specific activation workflow.
- Synthetic CSV preview, validation, duplicate detection and all-or-nothing commit.
- External attempt records, versioned policies, independent demo-persona approvals and read-only policy evaluation; the consent record pins the policy version and its text, and a newer version applies to a customer only after a provider-accepted notice and, where the merchant's terms require, fresh consent (RET-07).
- An alerts feed on the overview and in every daily close for the NFR-OBS-02 conditions the sandbox can observe: a broken audit chain, an instruction in observation mode, position drift, unallocated Payments over the merchant threshold, overdue exceptions, deferred attempts, notification cost per collection, an overdue close and a missed scheduled close.
- The daily close runs on schedule at each lender's configured WAT time, default 07:00 (REC-01), from an in-process scheduler that closes one lender per system transaction through the scoped repository; every close records whether it was scheduled or manual, the scheduled instant it covered and its delay, a close missed while the platform was down runs late on recovery (NFR-AVA-02), and a manual close after a missed time counts as the catch-up.
- Absolute ticket floor, merchant minimum ticket from settings with a recorded override, combined attempt ceiling excluding cancelled attempts, the TRD 4.4 failure-code catalogue with ACCOUNT_RESTRICTED retried once and TIMEOUT_UNKNOWN blocking until resolved, execution windows hard-bounded to 06:00–20:00 WAT with business-calendar rollover, merchant and policy-version kill switches, ownership/mode checks and simulated hand-back to the cutover's fallback owner.
- Observation-to-canonical-payment resolution with repeated lines held as evidence; the R1 provider-reference match on the attempt's debit reference or the observation's due-item link; suspected duplicates for already-paid due items or same-payer amounts within two minutes; certain/probable matching; Finance approvals; per-provider settlement fee schedules with variance exceptions; allocation ceilings enforced by application checks inside locked PostgreSQL transactions.
- Exception ownership, severities and business-day deadlines from the Appendix A catalogue, per-type resolution codes, a seeded monthly precision sample of at least 200 automatic certain allocations with the false-match rate and its 95% interval (REC-09), allocation precision review that supersedes wrong matches, and immutable daily close records carrying the REC-07 report (opening unallocated, observations by source and the payments they resolved to, allocated by rule, proposed, unallocated, variances, exceptions opened and closed, customer positions that changed) with the REC-05 position rebuild check.
- Every close records the retry decision for each open obligation (RET-03): policy version, the 6.3 row, inputs including the calendar and notice evidence, the scheduled time, the notice it requires and the experiment arm; unchanged decisions are not repeated and the records are immutable.
- Application-enforced tenant scoping, transactional state changes, request idempotency, hash-chained audit digests and verification. No independent row-level security barrier. Anonymous sandboxes are rate-limited at creation and swept after 30 days without a change; list endpoints page and support an updatedSince watermark.
- Private App Storage PDF/JSON/CSV exports with downloadable SHA-256 checksums; the dispute pack is a paginated PDF with a one-page summary, the full customer timeline and the policy, template and cutover versions as they applied at each event, with CSV and JSON of the same data (AUD-02, AUD-06); the gate pack freezes the uplift report.
- The Test 5 report derived from records: live days from the first daily close, fortnightly confirmations by a named reviewer with the cadence check, the overdue share at each month end and packs used (MEA-05); unit economics against the plan's NGN 15 per collection and 85–90% margin (MEA-03).
- Synthetic billing counts limited to succeeded direct-debit attempts past the provider reversal window (BIL-01), receipts by channel, immutable monthly invoices with the contracted licence, per-collection usage lines, the design-partner discount, VAT shown separately and BIL-07 adjustment lines with references for collections reversed, refunded, confirmed duplicate or wrongly allocated after billing, separate commercial evidence register, operational measurements including packs generated and time to close, preregistered experiment parameters and the RET-06 uplift report (recovery by value and count per arm, the difference, its 90% interval from a ratio-estimator variance, the sample against the minimum and the pre-registered rule). Recovery and funding results stay unproven on synthetic data.
- React console and versioned OpenAPI contract, with every status, enum and catalogue value imported from the shared `lib/valopay-schema` package rather than retyped.
- A landing page and sign-in pages routed outside the sandbox bootstrap, so reading about the product, signing in or reaching a mistyped address creates nothing; designed against Nielsen's heuristics and the interaction-design principles, with the written rationale in `docs/design/console.md`. The console:
  - works from a phone or at 200% zoom: below 768 px its pages fold into a drawer behind a Menu button, the lender selector stays in the bar, tables scroll within their own frame and rows of controls wrap;
  - is light or dark as the device is, or as chosen per browser on the settings page, with every colour a token that has a value for each theme;
  - prints as a file note: no chrome or controls, tables in full with repeated headers, the lender and the sandbox notice at the top and the printed time at the foot;
  - was audited against WCAG 2.2 AA with axe-core in both themes and at phone width; the findings (names, landmarks, contrast on tints, keyboard access to scrolling frames, target sizes, reduced motion) are fixed, and axe runs in the test suite;
  - had its load measured and cut: the landing page and the shell ship without the console's pages, which arrive on first visit or while the browser is idle, and data fetched in the last thirty seconds is shown at once on return;
  - speaks the market's conventions whatever the device is set to: British English declared on the page, naira and Nigerian number grouping, every instant in West Africa Time with the zone named, counts with their nouns, searches that ignore case and marks, synthetic names written with their Yoruba and Igbo marks, PDF exports that embed a typeface with those letters, and CSV exports with the byte order mark spreadsheet programs need.
- A security review of the request surface, the console, the dependencies and the workflow is in `docs/security-review.md`: programming errors are answered in general words, API answers cannot be framed or read cross-origin, record data refuses prototype keys, and the workflow audits dependencies.
- An operator can see it run: every request is named on its answer and in its log lines, failures are logged with their stacks and refusals as events, `/api/healthz` reports the build and the scheduler and `/api/readyz` the database, the process drains on a stop signal, and the console quotes the request's reference in a failure notice (`docs/observability.md`).
- The documentation was audited against the code and kept true by a check in the test suite: every path, command and environment variable a document names exists, the contract describes every operation, the shared schema's exports are documented, and the spelling is British (`docs/documentation-review.md`).

## Workflow improvements and pilot preparation

The console now connects overview tasks to filtered queues, fixes proposed-match decisions, previews allocation impact, accepts naira in money forms and offers recoverable action/query feedback. All evidence remains searchable across gates with owner and evidence date. Reports distinguish missing measurements from measured zero, and staff reviews name all four tasks. The optional sandbox guide records personal progress only. The landing page includes an explicit, user-started console preview and the approved pilot contact.

Pilot security work is isolated from the running sandbox: access/MFA preflight and tenant-bound encryption helpers, a guarded staging RLS migration and disposable-database tests. These are implementation foundations, not activated production controls. Runtime identity provisioning, encryption migration, key management, scoped database connections and scheduler/service access still need integration and validation before real data can be accepted. See `docs/pilot-security.md` and `docs/pilot-database.md`.

The Paystack test adapter supports read-only connection/transaction checks, authenticated webhook parsing and timeout recovery fixtures. It has no public webhook route or charging method. No test key was available for this release, so no external Paystack verification or Direct Debit capability claim is made. See `docs/paystack.md`.

## Explicit implementation deviations

| Requirement | Current implementation | Consequence |
|---|---|---|
| Python 3.12 / FastAPI / SQLAlchemy / Celery / Redis | TypeScript / Express / Drizzle / PostgreSQL | Not exact technical-stack compliance; engineering-owner review remains necessary. |
| Modular entity-specific resource API | Generic typed record resources plus action endpoints | Partner-specific resource adapters, API keys and outbound LMS event contracts remain to implement. |
| Real provider and messaging adapters | Synthetic evidence and explicit disabled ingress/instructions | No debits, mandate lifecycle instructions, activation SMS or notices reach a provider. |
| Production tenancy and MFA | Isolated sandbox sessions and Clerk sign-in; simulated personas | Not a production role-provisioning or fresh-MFA implementation. |
| Independent database tenant isolation and immutability | Scoped repository with explicit authorisation, transaction locks, application mutation guards and ordinary SQL constraints | No custom-role/RLS/trigger boundary. Privileged SQL or an unscoped application query can bypass isolation and mutation guards; this is an explicit security deviation, not live-data approval. |
| Production outbox / worker scheduler / status recovery | The daily close is scheduled inside the API process rather than by Celery beat and workers; no outbound side effects are dispatched | The close scheduler is single-process per instance with database row locks for coordination; the instruction scheduler, at-least-once receiver idempotency, lost-ack replay and provider polling are not certified. |
| Field encryption / key destruction | Only masked synthetic identifiers are accepted | Real bank accounts, phones and payer data must not be loaded. |
| Locked retention and independent audit anchors | Private objects, application-protected metadata, transactional chain verification | WORM retention, external anchors, daily verifier and crypto-shredding remain unimplemented; privileged database access can alter metadata and rewrite an unanchored chain. |
| Full Test 2 inference | Stable future-failure assignment, sample estimate, 30-day settled-value accounting, the 90% interval of the difference and the pre-registered rule evaluated as written | The rule can only read "proven" on live controlled evidence for each design partner; synthetic data cannot supply it, and the gate readiness register keeps the recovery decision not proven. |
| Invoicing and post-invoice adjustments | Immutable monthly invoices issued from the platform counts with VAT shown, and BIL-07 credit or debit lines on the next invoice for reversals, refunds, confirmed duplicates and superseded allocations, computed from a ledger of what each collection has been billed net | Invoices are still issued by hand from the statement in stage 1 (BIL-04); accounting-software delivery, the dispute workflow and cost attribution require further implementation; the recovery fee stays gated. |

## Closed production gates

### Pre-data

Requires NDPA registration, a signed DPA for each lender, a documented hosting/transfer basis and security foundations. The sandbox does not accept these as verified merely because an evidence reference was entered.

### Pre-live

Requires a qualified legal opinion, written aggregator agreement and partner credentials, independent penetration-test highs closed, mandatory MFA and fresh challenges, audited staff access, restore rehearsal, written runbooks, kill-switch drill and signed cohort cutover. A working development preview is not proof of any of these.

### Nine-month decisions

- **Funding:** Test 5 for both lenders, signed list-price Test 3, measured variable cost ≤₦15 and three months of lean-burn cash. All are required.
- **Recovery fee:** For each lender, at least eight percentage points of uplift and a 90% interval excluding zero on the preregistered sample. Separate from funding.
- **Portability:** Written permission from NIBSS and two aggregators. Routing at creation remains unbuilt.

## Verification boundary

Type checking, runtime API smoke checks, tenant-isolation/refusal checks and visual preview checks are development verification only. They do not replace independent security assessment, load and availability tests, real-provider recorded replay, recovery drill, legal review or lender pilot acceptance.

## Intentionally not built

Stage 2 connectors and routing, payment wallets, custody/settlement accounts, WhatsApp, NPS/RTP, open-banking feeds, recovery-fee charging, self-serve commercial onboarding, bulk exception tools, late-payment automation and elaborate analytics dashboards.
