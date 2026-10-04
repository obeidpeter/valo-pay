# Valo Pay copy review: coverage, tests and owner decisions

This records the October 2026 review and rewrite of every user-facing word in the Valo Pay demo: what was covered, how it was tested, where the sources disagree, and which wording needs an owner's approval before it is relied on.

| Document | What it holds |
|---|---|
| [content-guide.md](content-guide.md) | Voice, style, terminology, roles, state meanings and rules for borrower pages, messages and legal text |
| [copy-inventory.csv](copy-inventory.csv) | 97 entries: each change with location, audience, before, after, intended meaning, issue, priority, source, status and verification |
| [copy-walk-diff.csv](copy-walk-diff.csv) | The complete before-and-after log: 244 distinct changes found by walking every route, role and state before and after the rewrite |
| This file | Coverage, test results, discrepancies, owner approvals and the comprehension test script |

## Status at a glance

| Status | Meaning | Count |
|---|---|---|
| Implemented and tested | In the code, and covered by automated tests, the browser check or the reviewed walk diff | 81 inventory entries |
| Implemented; awaiting owner review | In the code because the old wording was wrong or misleading, but the owner should confirm the new wording | 13 |
| Unchanged; awaiting owner review | Legal or security wording deliberately left as it was, with proposed alternatives below | 2 |
| Not changed; owner decision | Needs a product or engineering decision first | 1 |
| Unverified | Nothing has been tested with real lenders, borrowers or screen-reader users. The comprehension test script below has **not been run**. | All |

Priorities in the inventory: P1 (money, consent, security or state meaning) 32, P2 (blocks a task, recovery or accessibility) 45, P3 (consistency and style) 20.

No real borrower was contacted, no real collection was triggered and nothing was deployed. All checks ran locally against sample data.

## Coverage record

### How coverage was established

A script opened a fresh local demo workspace and walked 126 scenes: every route, for each of the four roles where the role changes the page, and every state the code can reach (empty, filtered, error, success, blocked, expired, cancelled). For each scene it recorded the visible text plus page titles, meta descriptions, placeholders, accessible names (aria-label, title, alt), confirmation dialogs and CSV content. It ran once before the rewrite and once after. All 126 scenes returned the same status codes after the rewrite as before.

| Area | Scenes | Area | Scenes |
|---|---|---|---|
| Start page and ended session | 2 | Pay-by-bank list and requests | 20 |
| Today | 2 | Borrower consent and payment pages | 8 |
| Customers list and customer pages | 12 | Review queue and review items | 22 |
| Add and edit customer | 8 | Refunds | 4 |
| CSV import | 6 | Reports and CSV exports | 8 |
| Loan actions (consent, hold, release, withdraw, close) | 14 | Settings and role switching | 5 |
| Collections | 5 | Previews | 2 |
| Error pages (403, 404, 405, 500, form security) | 8 | | |

### Surfaces

| Surface | Result |
|---|---|
| Navigation, headings, body text, buttons, links | Reviewed and rewritten. The six navigation names and four role names are unchanged. Actions are shown only to roles that can use them. |
| Page titles and meta descriptions | Reviewed; every page title now names its record or task |
| Form labels, help text, placeholders | Reviewed and rewritten |
| Validation and error messages, including CSV import | Reviewed and rewritten; no framework default messages remain |
| Success, warning and blocked-action messages | Reviewed; success messages added where none existed (hold, release, withdraw, close, refund, assign) |
| Empty states | Reviewed; no records and no matches are now told apart |
| Confirmation dialogs | Reviewed; each names the record and the consequence |
| Status labels | TRD labels kept; plain meanings added next to them (core/content.py) |
| Accessible names and announcements | Reviewed with the browser's accessibility tree; fixes listed under test results |
| Borrower consent and payment pages | Reviewed and rewritten, except the legal sentences (see owner approvals) |
| Error pages | Created for 403, 404, 500 and form-security failures. Customer links (/consent/, /pay/) that do not exist get a customer version of the 404 page. The 405 response is still blank (D8 below). |
| CSV exports | Reviewed; column names and the daily summary rewritten (see T7, T8 in the inventory) |
| Audit entries and sample records | Wording changed only for entries created from now on. Existing audit entries, decision notes and evidence are never rewritten. |
| Operator command output (purge_demo_workspaces) | Reviewed; unchanged |
| Developer documents (README, RELEASE_SCOPE, UI_CONTRACT) | Terminology updated to match the guide |
| Emails, SMS and notifications | None exist in this build, so there is nothing to review. Every screen says that nothing is sent. |
| Sign-in, invitations, two-step verification | Not built; the demo has no sign-in. Wording says so. |
| Loading states, pagination, tooltips, HTMX partials, PDFs | None exist in this build |
| Marketing site and brochure | Not part of this repository; not edited. Discrepancies are recorded below. |
| Demo navigation | Added for presenting: a Demo group in the sidebar (Demo guide, Start page), the start page reachable from inside the demo with Continue and Start again, and a ten-step demo guide. See below. |

## Test results

### Automated tests: 93 passed

`uv run pytest` passes 93 tests: the 52 existing behaviour tests, 27 copy checks in `core/tests/test_copy.py` and 14 demo-navigation tests in `core/tests/test_demo.py`.

The copy checks render every staff page for all four roles, the borrower pages in each state, the error pages and every CSV export. They fail on any of the following:

- Unrendered placeholders or printed empty values ("None", "undefined").
- Banned words: sandbox, synthetic, two-factor, log in, "Something went wrong", "Invalid", "soon", "Secured by", Submit, negative contractions, US spellings, role and navigation variants, and integrity claims such as "can be detected" or "tamper-proof".
- Counts whose noun does not agree.
- Pages without exactly one main heading or a meaningful page title, and headings that end with a full stop.
- Form controls without labels, or buttons without their own text.
- Links with the same name that go to different places.

They also pin, word for word, the meanings that protect money and consent:
- Active consent, Unknown results and Awaiting approval are explained, and every state the code can reach has a meaning in core/content.py.
- Unknown is not shown as Failed.
- Approved refunds say "Not refunded yet".
- Creating a payment request never claims money moved.
- The consent page lists only dates that can still be collected.
- The borrower legal sentences, the retry sentence and the security footer stay as they are.
- Each role sees only the actions it can use, and only Admins see the audit download.

Five existing assertions pinned the old wording. Each was updated to the new wording of the same message, and still checks the same behaviour:

| Test | Old wording | New wording |
|---|---|---|
| test_active_consent_withdrawal_is_not_claimed | Provider deactivation is unavailable | Consent cannot be withdrawn in this demo … The consent is unchanged |
| test_hold_release_needs_a_different_person | different Reviewer | a different person must release it |
| test_payment_hand_off_is_truthful | no money has moved | no money moved (and no "Payment received") |
| test_import_is_all_or_nothing | Row 3: amount | Row 3, amount: |
| test_duplicate_loan_ids_are_rejected | loan_id: already exists | Row 2, loan_id: LN-2041 is already used |

### Do the checks catch regressions? 16 of 16, and 17 of 17 review fixes

Each of these regressions was put back into a scratch copy, and the copy checks failed every time:
- "Sandbox" banner
- "Pay by bank" in navigation
- a blank consent meaning
- a page title printing None
- US spelling in the legal sentence
- a changed withdrawal sentence
- "Refunded" for an approved refund
- a dropped plural
- a Submit button
- a negative contraction
- an unlabelled select
- "Secured by Valo Pay"
- a default framework error
- "synthetic" in an export
- Unknown shown as Failed
- "two-factor"

Each fix from the independent review (below) was also undone in a scratch copy, one at a time, and the tests failed for all 17.

### Walk diff

- **Same 126 scenes:** before and after, with identical HTTP status codes.
- **No banned wording:** none in any of the 8,346 text segments after the rewrite.
- **Every change read:** all 244 distinct changes were reviewed for accuracy against the code and the TRD.
- **Problems found by reading the diff, then fixed:**
  - The Today date format.
  - A doubled "Approved" on refunds.
  - "Submit refund request" became "Request refund".
  - "Switch" became "Switch person".
  - The edit page listed the wrong editable fields.
  - The customer-filter description.

### Independent review of the merged change

After the first pull request merged, five independent reviewers each read the whole change through one lens: whether the wording tells the truth about the code, money and consent meaning against the sources, logic regressions, markup and accessibility, and the tests and docs. A skeptic then tried to refute each finding. 16 findings held up (12 distinct problems, some found by more than one lens) and 6 were refuted, mostly because the problem was older than the change. All 12 are fixed:

- The consent page listed paid and past instalments under "collect … on the dates below" (B9, D14).
- Reports claimed changes to the audit log "can be detected", although the hash does not cover times and nothing checks it (T6, O6).
- A replaced consent link showed customers the staff demo 404 page, and the "replaced by a newer link" wording could never appear (E2, B8, D15).
- After a closed loan's hold was released, the message said payment requests could be created again; closed loans could also be put on hold (D7).
- The due-date help text did not say month-end dates move to the last day of a shorter month (F1).
- The payment page said "pay this instalment" when the amount can be part of it (B2).
- Withdrawing an unused link was announced as "Consent withdrawn" (D9, D1).
- Reviewers and Viewers were shown actions that end on the 403 page (G12).
- A heading ended with a full stop, and list deadlines and expiries had no WAT (G13, G14).
- Four meaning checks compared the page with itself, so a wrong meaning in core/content.py would pass (now pinned word for word).
- The unnamed-button check counted later page text as the button's name (fixed, with its own test).
- Two inventory rows claimed tests that did not exist, and one count was wrong (tests added, count corrected).

### Demo navigation for presenting

The owner reported that there was no clear way back to the landing page once a demo workspace was open, and asked for the demo to be easy to understand and navigate in an investor presentation. Added:

- A Demo group in the sidebar, visible on every staff page and in the phone menu: **Demo guide** and **Start page**.
- The start page is reachable from inside the demo. With a workspace open it offers **Continue the demo**, **Demo guide** and **Start again with fresh sample data**, which asks first, then replaces the workspace (the old one is deleted). Opening the start page never creates a workspace.
- A **Demo guide**: ten steps through the sample lender, each opening the right record. Where a step needs a different person, one click switches to them and opens the page; switching only ever opens a page on this site.
- Today points to the guide until it has been opened. Customer pages are labelled "Customer's view". The Instalments on hold figure says how many loans they belong to.

Tests: 14 new tests cover each of these, including the whole tour from request to decision to refund. Each behaviour was broken in a scratch copy, and the tests failed for 12 of 13; the other change made no difference, because the app already falls back to the first team member after starting again.

### Browser checks: 199 passed

Chromium, with reduced motion, at 1280 px (desktop), 360 px (phone) and 320 px (reflow equivalent to 400% zoom). The walkthrough covered:
- opening the demo
- every main page
- the CSV import
- creating and copying a consent link
- the borrower consent flow
- creating, opening and cancelling a payment request
- the review rule
- the Viewer and 403 pages
- the 404 page
- an ended session
- the way back to the start page and Continue the demo
- the demo guide, its one-click switch to Tunde Bello, and Start again

At each width the browser checked:
- no sideways page scroll
- one main heading and a page title on every page
- confirmation dialog text
- that the copy button's text, its screen-reader announcement and the clipboard agree
- accessible names for the key fields, links and checkboxes

Accessibility-tree snapshots of the start page, a customer page, a payment request, a review item and both borrower pages were read in full. They led to these fixes:
- Repeated links ("Request payment", "View", "Request refund", "Cancel request", "Download CSV") now include their record for screen readers.
- Empty action-column headers are named "Actions".
- A long note was moved out of the "Instalments" heading.
- The "+" on action toggles is no longer read aloud.
- "Repayment schedule" is no longer read twice on the consent page.
- Screen-reader-only text inside scrolling tables no longer widens phone pages.
- The consent page's retry rule was moved out of a narrow two-column list, where it wrapped one or two words per line at 360 px.

### Not tested

- **Real assistive technology:** no testing with NVDA, JAWS, VoiceOver or TalkBack. Only the Chromium accessibility tree was checked.
- **Zoom:** browser text-only zoom was not tested (approximated by the 320 px reflow check).
- **Devices:** no real phones were used.
- **Users:** no comprehension testing with lenders, cooperative staff or borrowers (script below).
- **Language:** no review for Hausa, Yoruba, Igbo or Pidgin readers.

## Discrepancies and who decides

| # | Sources say | Product does | What was done | Decides |
|---|---|---|---|---|
| D1 | TRD 8.1: Today shows "collected this month (confirmed only)" | Tile labelled "Confirmed this month" | Label changed to the TRD 8.3 state name so it cannot be read as money received in the lender's account; meaning unchanged | Product owner |
| D2 | TRD 16.4 lists 10 go-live items | Settings lists 8 | Wording of the 8 improved; items not added | Product owner and compliance |
| D3 | TRD 8.2 and FR-CP1: borrower pages show the lender's contact details and a privacy notice | No contact details or privacy notice exist in the data model | Pages say "Contact {lender}" without details; recorded as a launch blocker in RELEASE_SCOPE.md | Product owner; legal for the privacy notice |
| D4 | Brochure: "Request a demo" by email or QR code | The app's start page offers "Open the demo workspace" and has no contact route | Kept "Open the demo workspace"; no contact details invented | Marketing owner |
| D5 | Brochure shows a Credit Desk "sample score"; TRD and Roadmap say no credit scores | Credit Desk preview says "No credit scores or automatic approvals: a person always decides" | App follows the TRD; brochure not changed | Marketing and product owners |
| D6 | TRD 8.3 state "Awaiting approval" for payment requests | Staff can read it as waiting for an internal approval | TRD label kept; meaning shown beside it ("The customer has not yet approved this payment at their bank") | Product owner (a rename changes TRD 8.3) |
| D7 | NFR-09 and BR-13: times shown in WAT | CSV exports use UTC timestamps in ISO 8601 with microseconds | Not changed: changing an export format can break whoever imports it | Product owner with finance users |
| D8 | Content guide: every error explains itself | A wrong request method (405) returns a blank page | Not changed | Engineering |
| D9 | TRD FR-C1.4: schedule changes create a new version (Must) | The demo cannot change schedules; old text said "not in this release" | Now says "not available in this demo" and describes the live requirement | Product owner to confirm v1 scope |
| D10 | Consent page: "Maximum for each debit" | Legal sentence: "up to {maximum} per instalment"; retries can debit one instalment more than once | Not changed (legal text); see O1 | Legal counsel |
| D11 | Brief refers to earlier accessibility, usability and aesthetics briefs | Those briefs were not supplied | Worked from the 10 usability heuristics document and WCAG 2.2 | Whoever commissioned the work |
| D12 | Layout | At 360 px and below, the main navigation scrolls sideways (Pay-by-bank, Reviews and Reports start off screen), and the instalment table's "Request payment" column needs a sideways scroll | Layout, not wording; not changed | Design owner |
| D13 | "In the live service, …" sentences | They describe TRD requirements that this demo does not implement | Each is phrased as the live service's behaviour, never as something that happened | Product owner before any of them is reused in marketing |
| D14 | TRD 8.2 and FR-C2.2: the consent page shows "the schedule" | The page now lists only unpaid instalments due today or later, so "on the dates below" is true; overdue instalments are not listed | Paid and past dates removed (found in review) | Product owner and legal: whether a new consent should also cover overdue instalments, and how to say so |
| D15 | Content guide: customers never see staff or demo wording | Creating a new consent link overwrites the old one, so the old link is unknown rather than "no longer active" | Customer links that do not exist get a customer 404 page; the lender's name cannot be shown because the old link is not kept | Engineering: keep replaced links so they can show the lender-branded "no longer active" page |

## Wording that needs owner approval

The live app currently shows the "Current wording" column. Nothing in this table is a legal opinion, and rewriting a notice does not make it compliant.

| # | Where | Current wording | Proposed or alternative wording | Meaning to preserve | Owner |
|---|---|---|---|---|---|
| O1 | Consent page, checkbox (unchanged) | I authorise {lender} to debit up to {maximum} per instalment on the schedule above. | I authorise {lender} to debit my bank account up to {maximum} for each debit, on the dates in the schedule above, until {end date}. | Which account, the cap per debit (D10), the dates and the end date | Legal counsel |
| O2 | Consent page, withdrawal (unchanged) | You can withdraw this authorisation at any time by contacting {lender}. Withdrawing does not cancel what you owe. | Add how to contact the lender and when debits stop, for example: "Debits stop once {lender} has cancelled the authorisation with your bank." | The right to withdraw; withdrawal does not cancel the debt | Legal counsel |
| O3 | Consent page, retry rule (changed from the bare preset name "Standard") | If a debit does not go through: {lender} may try again 2 days later and 5 days later, for the same amount. | Confirm the timing and that the retry amount is the same | Retries are possible and when they happen; must match the contract and Paystack's retry behaviour | Legal and compliance, product |
| O4 | Borrower pages, header (changed from "Secured by Valo Pay") | Valo Pay is a service provider to {lender} | Confirm it matches the agreed processing structure (Business Plan: Valo Pay acts on the lender's instructions) | Who the customer deals with | Legal counsel |
| O5 | Borrower pages, footer (unchanged) | Valo Pay never asks for your card PIN, BVN or bank password. | Confirm it stays true for the Paystack direct-debit flow, which may ask for bank details on the bank's or Paystack's own page | Anti-fraud guidance that is always true | Security and legal |
| O6 | Reports, audit log | Each entry is linked to the one before it. | Add a tamper-evidence claim only once the hash covers each entry's time, something checks the chain, and the FR-X3.4 checkpoint is stored separately. The earlier "so changes to the log can be detected" was removed after review, and the copy checks now block such claims. | No integrity claim the system cannot back | Security owner |
| O7 | Settings, price example | An example based on proposed Collections pricing: a licence from ₦150,000 a month, plus a usage fee of 0.3% of each eligible direct debit, capped at ₦150 … | Confirm figures before any external use (Business Plan: Starter "from ₦150,000", fee "0.3%, capped at ₦150", Pay-by-bank ₦50 proposed) | An example, not a quote or invoice; only eligible debits carry the fee | Commercial owner |
| O8 | Start page | Valo Pay is software for the team that collects loan repayments. It is designed to keep each customer's consent … Valo Pay never holds money: each lender connects its own Paystack account. | Confirm positioning and whether to add "Request a demo" (D4) | No claims beyond what the product does | Marketing and product owners |
| O9 | Today and Reports | Confirmed this month | Keep, or return to the TRD's "Collected this month (confirmed only)" | Only confirmed payments count (D1) | Product owner |
| O10 | Pay-by-bank | Awaiting approval (with its explanation) | Keep, or rename in TRD 8.3, for example "Waiting for the customer" | The customer has not approved at their bank (D6) | Product owner |
| O11 | CSV exports | Daily summary columns metric, value, period, data; payments column sample_data; reviews add prepared_by and decided_by | Confirm before anyone builds on these files | Plain labels, periods and maker-checker evidence | Product owner, finance users |
| O12 | Settings, go-live checklist | Eight items, "not done" | Align with the ten TRD 16.4 items (D2) | Live mode stays blocked until every item is done | Product owner, compliance |
| O13 | Credit Desk and Cash Desk previews | Planned feature lists, "Preview · Not available yet" | Confirm the lists match the Roadmap and the brochure (D5) | No dates, no working-feature claims | Product and marketing owners |
| O14 | Demo guide | "How Valo Pay works" (consent, collection, confirmation, review) and the ten-step tour | Confirm the narrative matches how you present Valo Pay to investors and customers | No claims beyond the TRD and the Business Plan; live-service behaviour is marked "In the live service" | Product owner |

## Comprehension test script (not run; results unverified)

Use this to check that people understand the wording, especially money and consent states. Run it only in a local or authorised preview environment with sample data. Never use real borrower details, contact real borrowers or trigger real collections.

**Participants:**
- 5 to 8 collections or desk officers from Nigerian lenders or cooperatives who have not used Valo Pay.
- 5 borrowers or cooperative members using their own phones for the borrower tasks.
- Include at least one screen-reader user if possible.
- Record first language and confidence with English.

**Method:**
- One person at a time, thinking aloud.
- Give the task, not the button name. Do not help unless the participant is stuck for two minutes.
- After each task, ask the meaning question and write down their words.
- Score each task: understood unaided, understood after rereading, or misunderstood.

**Staff tasks** (open a fresh demo workspace and act as Ada Okafor, Admin, unless stated):

1. On Today, find how much is still unpaid on instalments due today. *Ask:* "Is that everything customers owe this month?" (Expected: no, only instalments due today.)
2. *Ask:* "Has the money in 'Confirmed this month' reached the lender's bank account?" (Expected: it counts confirmed payments; in this demo they are sample records and no money moved.)
3. Open Amara Okeke. *Ask:* "Can you ask Amara for this payment again now? Why?" (Expected: no; the result is Unknown and the loan is on hold; Unknown does not mean failed.)
4. Open Chidi Nwosu. *Ask:* "The consent is Active. Could the lender debit Chidi today?" (Expected: only within the schedule, the maximum, the six-hour wait and the notice rule.)
5. Create a payment request for Chidi's next instalment. *Ask:* "Has Chidi been sent anything? Has any money moved?" (Expected: no and no; you share the link yourself.)
6. On that request, *ask:* "What does 'Awaiting approval' mean? Who needs to approve?" (Expected: Chidi, at their bank, not a supervisor.)
7. Request a refund on a payment, switch to Tunde Bello and approve it. *Ask:* "Has the customer got their money back?" (Expected: no; approved is not refunded.)
8. As Ada, try to decide a review item Ada prepared. *Ask:* "What would you do next?" (Expected: someone else must decide it.)
9. Import a CSV file containing three errors (a bad amount, a US-style date, an existing loan ID). Fix the file using only the messages. (Expected: each fix found from the row and column named.)
10. Act as Emeka Obi (Viewer) and try to add a customer. *Ask:* "What happened, and did anything change?" (Expected: the role cannot do this; nothing changed.)

**Borrower tasks** (on a phone; staff create the links beforehand):

11. Open a consent link. *Ask:* "What are you agreeing to? What is the most that can be taken each time? Until when? What happens if a debit does not go through? How would you stop it?"
12. Press the button. *Ask:* "Have you authorised anything? Will money be collected?" (Expected: no, it is a demonstration.)
13. Open a payment link. *Ask:* "Who are you paying, how much, and for what?" Press the button. *Ask:* "Has your payment been made? Would you try again?" (Expected: no payment; they would contact the lender rather than keep retrying.)
14. Open a cancelled payment link. *Ask:* "What should you do now?"

**Success measure:**
- At least 4 in 5 participants understand tasks 2 to 7, 12 and 13 unaided.
- Any misreading of a money or consent state is a P1 finding, however many people make it: fix the wording and test again.
- Record the exact words people use. They are the best source for better labels.

**Status:** not run. Every comprehension claim in this review is unverified until it is.

## Keeping the copy consistent

- Check new wording against the content guide's checklist before release.
- Add new pages and states to `StaffPageTests.pages` in `core/tests/test_copy.py`, and new rules to `BANNED`.
- Change state explanations in `core/content.py`, never in individual templates.
- Record any discrepancy between the sources and the product in this file, with the person who decides.
