# Pilot workflow release

This release connects lender setup, saved import batches, reconciliation, coordinated exceptions, close review and evidence exports. All financial records remain synthetic. Real staff access is an opt-in staging foundation; enabling it does not open the pre-data or live-operation gates.

## Design decisions

- Keep original mutation requests and atomic completion receipts in a lender- and user-scoped server journal. A reload can discover received requests and retry the exact stored request. No request bodies or credentials are written to browser storage. A pending journal entry means completion is not confirmed; it does not mean a payment failed.
- Save imports as versioned batches, including their source namespace, immutable source-row identities, mapping, amount unit, checks and committed record links. Corrections require the current batch version. Commit remains all-or-nothing. Similar rows with different source identities remain separate records.
- Coordinate existing exceptions using a named assignee, next action, deadline, linked evidence and append-only handover history. Case handling cannot replace Finance allocation or policy approval. Concurrent updates require the version the operator reviewed.
- In staging staff mode, resolve the organisation and active membership on the server for every transaction, hold membership/organisation locks through commit, require a verified Clerk session and both MFA factors, and use the stable user identity in approval checks. Demo role switching is unavailable. Invitations are manually shared, expire, and require a verified matching email. No email is sent by this release.
- Provision the first organisation/admin through an explicit operator command. Browser users cannot bootstrap themselves as pilot administrators. Default sandbox entry remains available when staff mode is off.

## Acceptance journey

Create an empty synthetic lender → save/check/correct an import batch → commit once, including after a lost response → reconcile payment evidence → claim and hand over an exception → resolve it through the existing controlled workflow → inspect a dated close → request and download its evidence. Verify isolation, permission refusals, revocation, stale edits and uncertain results alongside the successful journey.

## Deployment boundary

Apply the additive schema to a disposable database first. Verify the code and migration before applying them to the existing synthetic development preview. Keep the pull request draft. Production, live financial operations, external email, real customer ingestion and real Clerk/provider acceptance are separate gates.

The existing forced-RLS rehearsal is independent of this application repository. This release must not claim it protects the default runtime. Staff access supplements the repository's explicit workspace/lender predicates and requires an independent security review before real data.

Authoritative references: [Clerk session claims](https://clerk.com/docs/guides/sessions/session-tokens), [Clerk Express SDK](https://clerk.com/docs/reference/express/overview), [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html).

## Setup and rollback

Apply `lib/db/migrations/003_pilot_workflow.sql` with the existing migration procedure before deploying this API. It adds five tables without rewriting existing financial records. It is repeatable and transactional. Every constraint carries the name the Drizzle schema gives it, so a database built by the file and one built by `pnpm --filter @workspace/db run push` are identical; `artifacts/api-server/tests/pilot-workflow-migration.integration.test.ts` rehearses the file (with `004_staff_lender_access.sql`) on a throwaway database and compares the result with the pushed schema, column by column and constraint by constraint. A database built by an earlier draft of the file keeps its unnamed constraints; they enforce the same rules. Back up the synthetic development database first. Rollback means restoring the previous application build and leaving the additive tables in place; do not drop the journal or access history during rollback.

Default development access remains unchanged. A separate synthetic staff staging host requires the existing Clerk keys, `VALOPAY_STAFF_ACCESS=staging`, the exact `VALOPAY_STAFF_ISSUER`, and HTTPS origins in `VALOPAY_STAFF_ORIGINS`. Enable organisations and second-factor authentication in Clerk. Provision the first administrator explicitly with:

```sh
pnpm --filter @workspace/scripts exec tsx ../scripts/provision-pilot.ts --synthetic-staging org_EXAMPLE user_EXAMPLE "Pilot workspace"
```

The command accepts existing Clerk organisation/user IDs and creates an empty application workspace. Confirm those identities with the operator before running it. It never grants live-data access. Add invitees to the same Clerk organisation, create their Valo Pay invitation, and share the link manually. Acceptance checks verified email, organisation, invitation expiry and both authentication factors. Memberships expire after 90 days; a new invitation is needed after revocation or expiry. Read access requires MFA within 12 hours; writes require it within 10 minutes. Team & access provides Account security and Verify identity controls. Never send identity-service secrets in invitations.

## API supplement

All paths below are beneath `/api/v1`. Lender paths require `merchantId`; paged lists accept `offset` and return at most 25 items. Every resource is scoped to the server-resolved workspace. Mutation inputs use the strict shared contracts in `lib/valopay-schema/src/pilot.ts`.

| Endpoint | Contract and permissions |
| --- | --- |
| `GET /pilot/journey` | Saved lender counts, synthetic-only marker and access mode |
| `POST /pilot/lenders` | Admin; name and segment; required idempotency key; creates an empty synthetic lender with automatic close disabled |
| `GET /operations` | This caller's request summaries and receipts, without stored bodies |
| `POST /operations/:id/retry` | Uses the exact saved request and key; requires the original actor and role plus current permission |
| `POST /operations/:id/cancel` | Serialises with the lender transaction; refuses completed work and blocks future execution |
| `GET /pilot/batches` | Paged summaries without CSV or row previews |
| `GET /pilot/batches/:id` | Admin, Operations or Finance; saved source, mapping, checks and revision history |
| `POST /pilot/batches` | Save/check a source batch; source name, batch ID, stable row-ID column, record kind, CSV, mapping, amount unit and synthetic-only confirmation |
| `POST /pilot/batches/:id/save` | Correct an unfinished batch with its current `expectedUpdatedAt`; preserve source and row identities |
| `POST /pilot/batches/:id/commit` | Current version required; all-or-nothing revalidation and import; returns the saved batch record |
| `GET /pilot/cases/:id` | Exception, eligible assignees, evidence choices and immutable handover events |
| `POST /pilot/cases/:id` | Claim, handover or update with current version, note, next action, future follow-up and up to 20 evidence links; current assignee or Admin controls an assigned case |
| `GET /team` | Staff directory; invitations and access history are Admin-only |
| `POST /team/invitations` | Staff Admin; verified email and application role; returns the one-time invitation token once |
| `POST /team/invitations/:id/revoke` | Staff Admin; revoke an unused invitation |
| `PATCH /team/members/:id` | Staff Admin; role, status, reason and current version; no self-edit or reactivation of revoked membership |
| `POST /team/accept` | Verified matching email and organisation, fresh MFA and an unused invitation token |
| `POST /team/verify` | Clerk reverification challenge; does not grant membership or execute a financial request |

Journal entries survive reload and restart once received by the server. Anonymous history still depends on its sandbox cookie and existing workspace expiry; signed-in history follows the account. Requests that never reached the service cannot be recovered. Pending entries can be retried or cancelled; validation failures do not prove a financial transaction occurred. At most 100 unfinished requests per caller/lender may be retained. Completed journal payloads currently follow workspace retention; review a separate retention policy before any real-data pilot.

Staff membership changes take the organisation lock before the member lock. Financial writes retain a shared organisation lock through commit, so revocation waits for already-authorised work and blocks later work. This does not claim to cancel a transaction that had already started.

## Validation and remaining gates

The pure pilot suite covers source identity, changed-payload conflicts, batch correction, stale commits, immutable evidence, case ownership and financial invariants. The opt-in PostgreSQL suite exercises actual routes, persistent receipts, duplicate concurrent requests, cancellation, cross-workspace isolation, invitation binding, MFA, and revocation ordering. Identity-service results in that suite are controlled verified-session fixtures: real Clerk organisation selection, MFA and invitation acceptance still require a configured staging acceptance test. Provider credentials and external message delivery are not prerequisites for the synthetic journey and remain unconfigured.

The browser/database rehearsal creates an empty lender, saves and reopens a batch, loses a successful commit response and finds its completion after reloading Operations, with exactly one imported customer. Lender selection is retained in tab storage under the server's opaque user/workspace scope; only the lender ID is stored. Customer evidence packs include source-row provenance and case handover notes. The backup/restore rehearsal compares all nine application tables, including unfinished requests and revoked memberships.

This foundation covers the core collections pilot. Connected credit and cash modules retain their existing simulation-specific authority checks; it does not approve real underwriting, payroll, bank instructions or new provider access.
