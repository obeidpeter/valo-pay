# Pilot operations controls

This release extends the synthetic pilot across imports, source checks, personal work, independent close review, staff access and retention. It does not enable real customer data, payment instructions or production access. External commissioning requires a separate identity application, restricted database credentials, private storage and managed key access. No Paystack account or test key is available, so no external Paystack connection has been verified.

## Journey and Finance evidence

Journey steps distinguish not started, in progress, awaiting review, blocked and completed work. Completion requires saved imports, reconciled evidence, resolved cases, a current independent approval and an export tied to that approval. A customer, allocation, close or unrelated export alone does not establish completion.

New manual and scheduled closes record a fingerprint of financial inputs. The preparer names an active Finance reviewer with access to the lender, explains discrepancies and records acceptance of unresolved items. A different authenticated person must decide the review; switching demo personas cannot provide independence. Concurrent decisions and stale versions are refused. Corrections or a newer close make earlier approvals historical without changing their evidence.

Reviewed-close exports carry the immutable review ID and snapshot digest. Generation uses the saved snapshot and explanations, rather than recalculated current figures. A ready checksum must reference the current approved review before the journey marks evidence exported.

## Sources and personal work

Source profiles reuse mappings, amount units and row identity columns. Expected delivery intervals and grace periods expose missed feeds; later uploads do not erase earlier missed intervals. Optional row and amount totals are checked before commit. Corrections retain source identities and revision history.

My work lists assignments, handovers awaiting acknowledgement, due actions and close reviews. Reading a notice and accepting a handover have separate durable receipts. Acknowledgement requires the current assignee, assignment event and record version. It does not resolve the case or change financial status. Supervisors see workload and items overdue by at least 24 hours. Notices are in-app; no email service is configured.

## Paystack boundary

Fixed local scenarios cover signed synthetic payments, duplicates, changed amounts, stale mandate events and tampered signatures. They never contact Paystack. Optional test ingress authenticates raw bytes and saves normalised evidence in a durable lender inbox. An operator-provisioned opaque connection resolves to an existing workspace and lender. Browser state, query strings and event fields cannot choose that scope. Live-mode evidence is rejected. Ingress creates no payment, allocation, debit or mandate authority; signed evidence still requires independent verification.

The existing read-only adapter supports future account/transaction verification. Configure `PAYSTACK_TEST_SECRET_KEY` through the host secret manager only after an account exists. External connectivity and Direct Debit availability require separate verification. The [Paystack webhook documentation](https://paystack.com/docs/payments/webhooks/) defines the signature and acknowledgement contract.

## Staff access and encryption

New non-administrator memberships have no lender grants. Administrators assign lenders with a reason and expected membership version. Revocation, role changes and invitation reacceptance clear old grants. Lists, direct links, recovery requests and eligible case/review assignees enforce the same scope.

`lib/db/migrations/004_staff_lender_access.sql` is additive. `lib/db/migrations/005_runtime_isolation.sql` is a separate commissioning migration; it refuses public schemas and unknown pre-existing policies. It installs a restricted runtime login and a distinct non-login helper owner, fixed helper search paths and forced row security across ten application tables. The application validates its actual database role and policy configuration. Workers require a provisioned service member and recheck the original export requester's authority.

Managed envelope encryption protects original import CSV and validation previews, operation request/receipt bodies and idempotency responses. Each payload receives a fresh data key and authenticated lender/record/field scope. Managed KMS wraps the data key; the database stores ciphertext and key identifiers. The provider uses [Google Cloud KMS](https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys/encrypt) with Application Default Credentials. Missing or wrong keys fail closed. Team & access provides a synthetic key-access check and bounded protection of legacy payloads. Financial record fields, operational metadata and audit content are outside this added envelope layer; whole-database encryption and completed security acceptance are not claimed.

Keep old keys available during rotation and restore. Verify the new key, protect new writes, migrate historical envelopes under a reviewed procedure, and rehearse restore before retiring old key access. No raw key material is exported. Actual identity/MFA, KMS and restricted-database commissioning must be verified on the configured host; local fixtures do not establish those external facts.

## Retention and disaster recovery

Raw CSV, terminal recovery payload and export-file retention default to disabled. Financial and audit records remain retained. Policies and item holds require reasons and retain history. Preview lists up to 100 exact eligible source identities/digests and expires after 15 minutes. Approval revalidates current policy, holds and source versions. Execution handles one item per request under the lender lock, checks eligibility again and records a success, failure or blocked receipt. Resume uses the same saved manifest. Export deletion checks ownership, checksum metadata and object generation; a lost acknowledgement can recover from an already absent object.

Journal redaction retains request keys, fingerprints, actors and terminal status. Matching replay responses become expiry markers that prevent re-execution. Pending requests are never candidates. Raw-file removal preserves committed records, source identity and revision history. File expiry prevents downloading or retrying the expired export job; a new export is a separate request.

The recovery rehearsal restores all ten database tables, generated private-file bytes/metadata and reviewed key/access configuration. It verifies checksums, missing files, wrong keys, lender-bound decryption, audit chains and replay state. Timings and snapshot age are recorded, including an intentional post-snapshot lost write. These measurements do not establish a production recovery commitment. See [operational rehearsals](operational-rehearsals.md).

## Verification

`pnpm run test:operations` checks close reviews, source quality, signed ingress, work receipts, staff grants, encryption, recovery manifests and retention. PostgreSQL suites exercise persisted routes, concurrency and restricted runtime roles. Console and browser checks cover workflows, stale edits and uncertain responses. CI uses disposable synthetic data and requires no Paystack or managed key credentials.
