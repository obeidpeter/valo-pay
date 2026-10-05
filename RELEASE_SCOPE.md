# Release scope

This is a guarded sandbox and staff-access implementation, not a live financial
service or a claim that every product requirement is complete.

## Implemented

- Tenant-scoped customers, loans, instalments and financial/audit records.
- Transactional CSV validation/import, money limits and concurrency safeguards.
- Staff password/authenticator sign-in, membership checks, verification gates and
  separate preparer/reviewer identity requirements.
- Consent and payment-request records, holds, review decisions and refund approvals.
- Authenticated operational paths remain separate from synthetic role switching.
- Dashboard, full-width Due today and a ten-step guided synthetic demo.
- Explicit sample debit run; sample records only, consent/hold/uncertainty checks,
  no repeat attempts on paid or failed instalments, no provider calls or retries.
- Public pages do not infer payment success from browser submissions.
- Structured audit records and scoped reports.

## Not enabled

- Live payment execution, real message delivery or public staff provisioning.
- Automatic debit scheduling or actual retry execution.
- Unapproved legal text, provider evidence or unverified business calendars.
- Automatic demo deletion or classification of pre-existing organisations as demos.
- Credit Desk and Cash Desk execution; these remain labelled previews.

Approving a refund is not issuing it. An Unknown result is not failure and must not
be retried as if the result were known. Financial decisions retain independent
Reviewer/Admin checks. Missing providers block execution, not authorised records.

## Data and deployment

Existing records and retention policies are preserved. Demo restart detaches a
browser from its old synthetic workspace, without purging it. Session expiry is
not data deletion.

This export changes code only. See README.md before using an existing database:
the older GitHub demo and the current workspace have incompatible migration
histories. Do not replay or fake migrations without a separate reviewed plan.
No production schema, data, configuration or deployment is changed by this PR.
