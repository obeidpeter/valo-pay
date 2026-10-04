# Initial demo release

This build is a working foundation and interactive demonstration, **not completion of all Must requirements** in the supplied Technical Requirements Document.

## Implemented

- Django 5.2 server-rendered app, PostgreSQL persistence, responsive staff and borrower pages.
- Fresh sample organisation for each visitor who opens the demo from the start page, with isolated records. Crawlers and health checks create none; idle workspaces are deleted after 24 hours.
- Today totals calculated from stored records, with the month starting at midnight WAT; sample financial records clearly labelled.
- Customers and monthly instalment schedules, customers with several loans, customer contact edits, search and filtering.
- CSV validation preview and transactional all-or-nothing commit, duplicate detection, integer-kobo validation.
- Consent link creation and expiry; provider activation deliberately unavailable.
- Payment-request creation with outstanding-amount checks, row locks, unique active request constraint, expiry and cancellation.
- Public consent and payment pages end on a truthful confirmation page and never claim a payment is successful.
- Manual holds and distinct-reviewer hold release; Unknown states cannot be released, and loans with Unknown or in-progress money states cannot be closed.
- Review ownership, deadlines, notes and separate-person decision rules. Preparers can close reviews that cannot move money; Viewers cannot own reviews.
- Refund requests with reserved-amount checks and separate approval; approved is NOT refunded.
- CSV reports, customer histories, consent registers and Admin-only audit export.
- Settings, retry preset, demo team-member switching (not sign-in), price example and blocked go-live checklist.
- Credit Desk / Cash Desk are previews only.
- Demo guide (an eleven-step tour that switches person where a step needs it, with a step bar offering Next step on every page), a start page reachable from inside the demo, and Start again with fresh sample data.
- Automated tests (pytest) and CI on PostgreSQL 17 for every push; locked dependencies.
- User-facing wording rewritten to the content guide (docs/content/), with automated copy checks. Legal consent and withdrawal wording is unchanged and awaits owner review (docs/content/copy-review.md).

## Not implemented / launch blockers

- Verified staff accounts, mandatory two-step verification, re-authentication, real invitations, support access controls.
- Production multi-tenant RLS, database-enforced append-only audit permissions, independent audit checkpoints, UUIDv7 identifiers.
- Schedule versions and edits, versioned matches and consents.
- Real Paystack adapter, encrypted per-lender credentials, webhook signature/IP validation, webhook/verify agreement, provider deactivation, reconciliation.
- Celery/Redis jobs: scheduled runs, retries, polling, notification window, business-day calendar, notice rule enforcement for debit execution.
- Outside-payment statements, allocation/credit ledger, duplicate-resolution evidence, actual refunds/reversals.
- Email provider and actual notifications; no emails are claimed sent.
- PDF exports, real usage eligibility/invoices and NRS e-invoicing.
- Live/live-test modes; all real-money actions remain disabled.
- Nigerian production hosting/backups, legal opinion, compliance agreements and registration, retention operations.
- Penetration/load/accessibility/acceptance verification against the complete TRD.
- Comprehension testing of the wording with lenders and borrowers, and testing with screen-reader users (script in docs/content/copy-review.md, not yet run).
- Lender contact details and a privacy notice on borrower pages (TRD 8.2); legal approval of borrower-facing consent wording.

## Safety

Use only sample data. The demo identity selector is intentionally not authentication and is never suitable for a live lender workspace. Each visitor who opens the demo gets a separate sample dataset. Short session expiry is not a retention policy, so idle demo workspaces are deleted 24 hours after their last activity by `purge_demo_workspaces`, which also runs whenever a new demo starts; schedule it daily as well.

Sample payments are excluded from billable usage; the displayed licence and VAT are a price example, not an issued invoice.