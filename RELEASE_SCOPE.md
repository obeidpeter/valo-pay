# Initial sandbox release

This build is a working foundation and interactive demonstration, **not completion of all Must requirements** in the supplied Technical Requirements Document.

## Implemented

- Django 5.2 server-rendered app, PostgreSQL persistence, responsive staff and borrower pages.
- Fresh synthetic organisation per browser session, with isolated records.
- Today totals calculated from stored records; synthetic financial records clearly labelled.
- Customers and monthly instalment schedules, customer contact edits, search and filtering.
- CSV validation preview and transactional all-or-nothing commit, duplicate detection, integer-kobo validation.
- Consent link creation and expiry; provider activation deliberately unavailable.
- Payment-request creation with outstanding-amount checks, row locks, unique active request constraint, expiry and cancellation.
- Public payment pages do not claim a payment is successful.
- Manual holds and distinct-reviewer hold release; Unknown states cannot be released.
- Review ownership, deadlines, notes and separate-person decision rules.
- Refund requests with reserved-amount checks and separate approval; approved is NOT refunded.
- CSV reports, customer histories, consent registers and Admin-only audit export.
- Settings, retry preset, synthetic role simulation, billing price illustration and blocked go-live checklist.
- Credit Desk / Cash Desk are previews only.

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

## Safety

Use only synthetic data. The demo identity selector is intentionally not authentication and is never suitable for a live lender workspace. A newly opened session gets a separate synthetic dataset. Short session expiry is not a retention policy; inactive synthetic datasets need a cleanup job before broad public distribution.

Sample payments are excluded from billable usage; displayed licence/VAT is a pricing illustration, not an issued invoice.