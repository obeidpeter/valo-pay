# Connected workflows: evidence-led usability slice

Inspected repository baseline: local commit `cc9cca4127d963d9f8a3a600091d502c08eb4239`, branch `codex/evidence-led-usability`, Windows local workspace. This slice does not claim deployment. Baseline and after-browser screenshots are coordinated by the root agent; no independent screenshots or human sessions were collected by this slice.

## Scope and verified boundaries

Read the full user brief, `docs/connected-banking.md`, all four connected UI routes, shared connected view/mutation hook, exact amount parser, server connected action dispatch/consent/payment roles, credit/cash interface contracts and corresponding tests. The later approved design baseline described by the repository is Business Plan v3.0/TRD v2.0/Roadmap v2.0/Marketing v2.0; these are documentary target descriptions, not proof of a provider integration. No planning documents or financial policy were rewritten.

Verified implemented interfaces: purpose-specific synthetic grants/revocation; synthetic A2A checkout and receipt/reconciliation; illustrative credit assessment/independent review; synthetic SME cash forecasts, accounting review exports, VAT evidence schedules and payroll funding/export/item outcomes. Paystack/Xero/bank reads, real underwriting, ledger writes, tax filing and payouts remain gated. Applicant/payer/payroll-approver are not additional production roles: current sandbox personas exercise those proposed journeys. Internal support has no separate role in this inspected implementation.

| Task / entry | Existing authority / prerequisites | Expected result / consequence | Frequency and effort evidence |
| --- | --- | --- | --- |
| Grant / revoke, `/connections` | Grant: Admin/Operations; revoke: Admin/Operations/Compliance reviewer. Subject must belong to workspace; purpose and expiry rechecked by server. | One named purpose for one applicant or separate SME. Wrong subject/revocation interrupts dependent work. | Frequency and human effort not measured; occasional setup/recovery is a hypothesis. |
| Partial checkout / receipt, `/pay-by-bank` | Admin/Operations/Finance; open instalment; no outstanding external/in-flight/unknown collection. Refund request Admin/Operations; evidence confirmation Finance with existing maker/checker. | Bound customer/recipient/amount; authorisation/return are not receipt. Unknown holds block another collection. | Repeated operational task is a hypothesis. Engineering tests exercise exact amount and state transitions, not human task time. |
| Assessment / review, `/credit-desk` | Admin/Operations assess; separate account-read and credit-assessment authority. Finance/Compliance/permitted independent Admin review. Server decides actual authority. | Evidence/affordability/model recommendation separate from lender outcome. Gaps are not low scores. | First-use/occasional reviewer difficulty unmeasured. |
| Forecast / exports, `/cash-desk` | Separate SME read permission; existing maker/checker and purpose permissions for accounting/payroll; fresh funding/source snapshots. | Versioned planning assumptions; accounting export is not posted; payroll export is not paid; VAT evidence is not a filed return. | Month-end/planning frequency is a hypothesis; no real SME participant observed. |
| Lost response recovery, four routes + `/settings`, custom `/mandates` create | Same current authorised scope, original idempotency identity and request body; backend authority/revision checks preserved. | Recover the original result; do not replace uncertain work. Mistaken replacement risks duplicate logical work. | Incidence unknown; deterministic injected response loss reproduced. |

## Source guidance versus project findings

[NN/G's five usability components](https://www.nngroup.com/articles/usability-101-introduction-to-usability/) organise the goals; engineering checks do not establish human learning, memory or satisfaction. [Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) diagnose visibility, recognition, error prevention/recovery and consistent interactions. [NN/G severity](https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/) informs ordinal 0–4 judgements considering frequency, impact and persistence. Values below are Valo Pay expert judgements, not an official score.

[WCAG 2.2](https://www.w3.org/TR/WCAG22/) is the accessibility target. Relevant checks are labelled controls/relationships (1.3.1), keyboard use (2.1.1), focus order/visibility (2.4.3/2.4.7), error identification/suggestion (3.3.1/3.3.3), names/roles/values (4.1.2), and status messages (4.1.3). This slice does not assert full WCAG conformance. Current [React select documentation](https://react.dev/reference/react-dom/components/select) supports explicit controlled selection and labels; existing installed [Radix tabs](https://www.radix-ui.com/primitives/docs/components/tabs) provides keyboard semantics. [WAI form notifications](https://www.w3.org/WAI/tutorials/forms/notifications/) supports associated field errors and feedback. No dependencies were added.

## Findings, priorities and delivered changes

Delivery priority is project-specific: potential financial/permission error and unknown outcomes first, then repeated form friction and keyboard consistency. Ordinal severity was not multiplied into a numerical ranking.

### UX-X01 — Controls offered authority the role did not have (resolved)

- Evidence: baseline `connections.tsx` used broad `api.canWrite` for grant/revoke; `pay-by-bank.tsx` used it for creation/return/provider outcomes. `connected.ts` server permits only named roles. Reproduce: choose Finance, visit permissions; grant was enabled until server rejected it. Compliance could start A2A mutations likewise.
- Severity 2: predictable, persistent friction for those roles; the server prevented unauthorised commits. Frequency unmeasured. Heuristics 1/5/6; principally learnability, efficiency and errors.
- Fix: controls follow existing server role sets; nearby copy names current role and permitted roles. No server permission expansion. Read-only viewing remains available.
- Acceptance: Finance grant disabled; Compliance may revoke but not grant or create a checkout; no mutation is sent by the forbidden UI action. `connected-usability.test.tsx`; existing connected-payment tests continue to pass.
- Effort/dependency: small; depends on unchanged server role contract. Residual: role information is client affordance only; server checks remain authoritative.

### UX-X02 — Consent review lacked the decision-critical subject (resolved)

- Evidence: baseline revocation form displayed a generic heading and reason, without selected subject/purpose/expiry. The grant form silently selected the first applicant. Cancel retained a revocation reason in the grant form. Reproduce: create permissions for two applicants, click a register row's Review revocation, read only the review form; then enter a reason and Cancel.
- Severity 3: wrong-person grant or revocation is materially consequential within the persisted simulator; the ambiguity repeats for each review. Frequency unknown. Heuristics 3/5/6; WCAG focus/relationships targets.
- Fix: applicant selection is explicit; revocation includes exact subject, purpose, expiry and consequences. Focus moves after rendering the review and returns to the originating button on Cancel; Cancel clears the revocation note. No claim of a bank authorisation or undo.
- Acceptance: no grant sent without an applicant; selected SME/applicant review details visible; cancellation changes no record, returns focus and clears the note. `connected-payments.test.tsx`, `connected-usability.test.tsx`.
- Effort/dependency: small; existing record identity and purpose metadata. Residual: real-person understanding of separate purposes needs participant validation.

### UX-X03 — Amount correction and precision were inconsistent (resolved)

- Evidence: checkout input used `amount || outstanding`, so clearing it restored full outstanding immediately. Credit and cash buffer used `Math.round(Number(value) * 100)`. Cash's Save button was outside a native validated form, allowing extra decimal places to become a silently rounded planning amount. These are repository/reproducible control findings, not measured user error rates.
- Severity 3: potential incorrect amount or planning assumption persists through saves. Frequency of malformed amounts unknown; all partial-payment corrections encounter the clear/reinsert behaviour. Heuristics 3/5/9; WCAG 3.3.1/3.3.3 targets.
- Fix: preserve intentional empty checkout entry; use the existing exact integer-kobo parser for all three pages. Validate amount limits without rounding; retain entered work; show associated errors and focus the first invalid field. Forecast review displays the full exact buffer, retained receipt percentage and delay before commit. Cash planning inputs reset when switching lender/SME context.
- Acceptance: `125.005` rejected; correction to `125.29` sends 12,529 kobo; credit `240,000.29` sends 24,000,029; buffer `1,500,000.29` sends 150,000,029; invalid submission sends no action; tenant change clears draft inputs. Connected usability/credit/Cash Desk tests.
- Effort/dependency: medium; existing exact parser, unchanged server validation. No numerical engines, thresholds or signed policies changed.

### UX-X04 — Credit tabs did not implement their keyboard pattern (resolved)

- Evidence: baseline buttons had tab/tablist roles, but all were tab stops and arrows/Home/End did not move or activate panels. Inactive panel IDs were referenced without corresponding panels. This is a semantic/key-interaction finding; all content remained reachable by ordinary Tab/click, so it is not described as a total keyboard barrier.
- Severity 2: persistent for keyboard users; frequency unknown. Heuristic 4; focus/name-role-value targets.
- Fix: use already installed shared Radix Tabs/Triggers/Content; automatic keyboard activation, one current tab stop, linked panels and visible focus retained.
- Acceptance: Right → Evidence, End → Review history, Home → Assessment; active panel has the active trigger's label; no mutation occurs. `connected-credit-ui.test.tsx`.
- Effort/dependency: small; existing shared primitive. Actual screen-reader testing remains pending.

### UX-X05 — Feedback did not explain committed outcome and next step (resolved)

- Evidence: Cash Desk closed a successful review dialog without a status message. Payment actions all said only that a sample record was updated. Reproduce: save a forecast or simulate a browser return and determine the committed state from the immediate feedback.
- Severity 2: uncertainty after repeated actions; users could inspect records but had to infer the result. Human impact/frequency unmeasured. Heuristics 1/2/9; status-message target.
- Fix: action-specific status after the API resolves: pending return versus confirmed receipt; independent review still needed; export remains unposted/unpaid; unknown outcome holds; new forecast leaves source balances unchanged.
- Acceptance: a held request displays no success; only confirmed save announces the result. Cash/payments tests; existing refund/payroll/domain tests remain part of broader root validation.
- Effort/dependency: small; existing authoritative mutation completion and query invalidation. No optimistic financial success.

### UX-X06 — Unknown request outcomes could be replaced (resolved within the open form/session; received requests later recoverable from Operations)

- Evidence: `useConnected` replaced its attempt whenever the input fingerprint changed after a transport failure. Settings/mandate custom consumers offered edited resubmission/cancellation and some failure wording asserted no change despite a potentially lost committed response. Reproduce using deterministic fault injection: commit a create/settings/connected action, drop its response, then change a field or let the emergency-stop read refresh and press the ordinary toggle.
- Severity 3 and first delivery priority: uncommon frequency is assumed, not measured, but duplicate logical writes or an unintended opposite control change are materially dangerous. Current modules remain synthetic. Heuristics 1/5/9; errors foremost, with recognition and feedback benefits.
- Fix: connected hook retains original body/key/revision and blocks changed input. Unknown status stays sticky through later 401/403/409/408 failures until confirmed replay succeeds. Initial definite structured 4xx permits correction. Invalid JSON, a malformed successful-action response and HTTP 408 all stay unknown. All four modules offer original-request recovery; inputs freeze while pending/unknown and cash/payment dialogs offer recovery inside the focus trap. Settings role/emergency-stop/settings/block-test and custom mandate creation use the shared hook's original-request retry. Cancel/edit disabled while unknown; error copy states uncertainty. Existing navigation guard warns about pending/unknown work without storing sensitive payloads.
- Acceptance: lost committed credit response → refreshed revision → 403 recovery rejection → successful replay retains the exact original body/key and one assessment; lost Cash Desk response recovers inside the locked dialog with one version; settings preserves the revision/key; emergency-stop recovery never flips the stop back; role recovery works after the server changed role; mandate recovery creates one record. `connected-retries.test.tsx`, `cash-desk.test.tsx`, `settings-mandate-recovery.test.tsx`; root shared safe-mutation tests cover cross-cutting hook semantics.
- Effort/dependency: medium; existing server idempotency and root shared safe-mutation work. Residual: the page's own retry identity is in memory, so a deliberate navigation discard, tab close or reload loses it there. The service's lender- and user-scoped journal, added after this slice, keeps every keyed request it received: connected actions, settings saves, the emergency stop and mandate creation can then be checked with their original body and key, or cancelled, from Operations, which their notices link to. A signed-in person's history follows the account; an anonymous sandbox's lasts only as long as its cookie and workspace. The demo role switch is not journaled, and a request that never reached the service cannot be recovered. A reloaded form does not look up its own request: that stays a real-data gate (UX-B02). No sensitive unrestricted storage was introduced.

## Five-component benefit and evidence limits

| Component | Delivered support | Proposed human measure | Evidence status |
| --- | --- | --- | --- |
| Learnability | Role explanations, explicit subject/purpose, checkout/forecast review effects and differentiated outcomes | First correct unassisted permission/partial-checkout completion; explanation mistakes per task attempt | Engineering affordances tested; human baseline/result not measured |
| Efficiency | Correct an amount in place; skip permission-denied round trips; exact one-request recovery instead of re-entry | Active successful task time and correction/re-entry count, with API wait reported separately | No human time savings claimed |
| Memorability | Stable module routes and established tab pattern; named permission context and consistent recovery language | Repeat the same tasks after 7–14 days with comparable records; success/assistance/reorientation time | Delayed participant study pending; no simulated memory result |
| Errors | Exact kobo, role guard, explicit applicant, selected revocation context, unknown-result lock/replay and tenant draft reset | Wrong-subject/amount/replacement attempts per defined opportunity, severe near misses and safe recovery success | Deterministic regression cases passed; not a production error-rate estimate |
| Satisfaction | Clear controlled corrections, honest uncertainty, readable consequential summaries and visible status | Standard task SEQ and session SUS, plus separate confidence/frustration questions | No participant responses or satisfaction score collected |

## Validation and handoff

- Latest focused run: **47 tests passed across 9 files**, including settings/forms/action queues and all connected UI suites. Test command: `node artifacts/valo-pay/node_modules/vitest/vitest.mjs run --root artifacts/valo-pay --config vitest.config.ts tests/settings-mandate-recovery.test.tsx tests/settings.test.tsx tests/action-queues.test.tsx tests/forms.test.tsx tests/connected-payments.test.tsx tests/connected-usability.test.tsx tests/connected-credit-ui.test.tsx tests/cash-desk.test.tsx tests/connected-retries.test.tsx`.
- Final affected rerun after the response contract guard: **20 tests passed across 3 files** (`connected-retries`, `cash-desk`, `connected-usability`), including three additional malformed-JSON/malformed-shape/408 replay cases. Counts overlap; do not add them as independent coverage.
- `tsc -p artifacts/valo-pay/tsconfig.tests.json --noEmit` passed. `git diff --check` passed for owned source paths. These are local Windows/jsdom checks. Root owns final combined build, browser/axe/reflow/manual visual review and release validation.
- Changed paths: four connected page files; connected frame; connected hook; settings and mandates custom consumers; four existing connected UI tests plus retries/Cash Desk; new connected-usability and settings-mandate-recovery tests. Credit Desk was formatted with repository Prettier as part of its semantic edits. No commits, pushes or deployments were made by this slice.
- No backend or schema migration in this slice. Roll back these UI/hook changes together with corresponding tests if needed; never roll back by deleting persisted financial/audit evidence. Respect the root's coordinated release/rollback instructions.

## Explicit backlog / limitations

| ID | State | Reason / next acceptance |
| --- | --- | --- |
| UX-X07 | Partly resolved; the rest is a real-data gate | The scoped server status resource now exists: a lender- and user-scoped journal of received keyed requests, which Operations lists with a summary of each, checks with the original body and key, or cancels, and whose pending entries the navigation counts; the connected pages' notices link there. By the owner's decision recovery stays manual; a reloaded form that looks up its own unconfirmed request is a real-data gate (UX-B02). Request bodies stay out of browser storage. Test server replay/tenant boundaries and operator recovery before any live acceptance. |
| UX-X08 | Deferred, severity 2 hypothesis | Credit assessment selection and Cash Desk section do not retain a long absence's task context across navigation. Avoid adding applicant/financial data to URLs or global storage; validate real returning-user needs before a scoped non-sensitive preference design. |
| UX-X09 | External blocked capability, not an interface defect | Real bank handoff, applicant consents, ERP accepted writes, filed tax and payroll payouts cannot be evaluated here. Preserve readiness gates; require provider-specific acceptance, genuine identities and approved permissions. |
| UX-X10 | Validation pending | Real assistive technology, physical devices, first-use users, delayed retests and SEQ/SUS have not been conducted. Root research kit should include the neutral scenarios above; do not treat passing jsdom tests as human success. |
