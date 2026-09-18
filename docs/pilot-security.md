# Pilot security foundations

These helpers are a tested staging foundation. They do not approve live data, provision staff, change the sandbox's authentication or encrypt existing database records. A deployment must still meet the pre-data and pre-live requirements in `docs/BUILD_STATUS.md`. No application route calls these helpers automatically.

The dedicated, separately constructed staging app now connects these helpers to a restricted repository for synthetic protected notes. It is not mounted in the deployed sandbox. Complete HTTP and database rehearsals are described in `docs/operational-rehearsals.md`; the identity service and key provider still require separate host provisioning.

## Provisioned access and MFA

`artifacts/api-server/src/lib/pilot-access.ts` exports `authorizePilotAccess`. It accepts the authenticated object returned by Clerk's server middleware, a current server-provisioned membership, the requested lender/action and an injected staging policy. It does not verify JWT signatures itself. Decoding a token or accepting an object from the browser is not authentication.

Configure Clerk's middleware with the intended issuer and authorised parties before supplying its result. The helper additionally requires an active user session, matching subject/session claims, an allowed issuer and requesting origin, valid token times and an active organisation. Impersonated and machine sessions fail closed. A server-controlled membership must match the user, organisation and lender, have a supported role, and fall inside its access period. Load this membership afresh for every request so revocation takes effect; neither a browser role nor the sandbox persona grants access.

Both authentication factors must have been verified. Ordinary reads permit the configured factor age, capped at 24 hours; other actions require both factors inside a separately configured window of at most ten minutes. Elapsed token time is added to the factor ages so an older signed token cannot preserve freshness. Missing, negative, malformed or stale ages are refused. The result is immutable and always says `liveOperationsAllowed: false`. This is a staging action guard, not permission to issue a debit.

Freshness is not a one-time approval. Before live sensitive actions, design and verify action-bound reverification identifiers, replay prevention, independent approval where required, session revocation and staff-access audit events. The domain's author/reviewer separation still applies. Clerk documents its factor-age and reverification behaviour in the [Auth object reference](https://clerk.com/docs/reference/backend/types/auth-object) and [reverification guide](https://clerk.com/docs/guides/secure/reverification).

## Protected fields

`artifacts/api-server/src/lib/field-encryption.ts` exports:

- `encryptField(plaintext, scope, keyRing)` returns a versioned AES-256-GCM ciphertext envelope.
- `decryptField(envelope, scope, keyRing)` authenticates before returning plaintext.
- `rotateField(envelope, scope, keyRing)` decrypts with the recorded key version and re-encrypts with the active version and a fresh IV.

The scope contains the tenant, record and field identifiers supplied by the authorised server operation. These identifiers, the key version, algorithm and format version are authenticated with the ciphertext. Moving a protected value between tenants, records or fields fails. Each encryption uses a random 96-bit IV and a 128-bit authentication tag; keys must contain 32 bytes. Fields are limited to 16 KiB. Malformed envelopes, unknown key versions and authentication failures produce the same general error, and there is no plaintext fallback. This uses Node's [authenticated encryption API](https://nodejs.org/docs/latest-v24.x/api/crypto.html).

The keyring is injected and is never read from the browser or stored with the ciphertext. This versioned envelope is not a KMS key-wrapping adapter: production key custody, access logging, availability and deletion must be provisioned separately. Internal key/buffer copies are cleared where possible; JavaScript strings and garbage collection do not provide guaranteed memory erasure. Never log plaintext or the keyring. Keep readable labels and masked values separate from protected source fields, and return only the masked representation to ordinary console views.

## Staging rehearsal

1. Use a disposable staging environment, synthetic records, a separate Clerk application and generated test keys. Set up two organisations and provision explicit, expiring memberships for each lender. Verify issuer and authorised-party configuration; no wildcard requesting origin is permitted by this helper.
2. Wire the guard into a staging-only route after Clerk verification and before tenant queries. Test wrong user, organisation and lender; missing, suspended, expired and revoked memberships; an unsupported role; a pending session; and both stale first-factor and stale second-factor verification. Confirm the browser cannot select a real role. Do not replace the sandbox persona behaviour while rehearsing.
3. Use a secret-manager-backed key provider. Assign a separate key version, encrypt synthetic fields before persistence and pass the authorised record scope on every decrypt. Confirm ciphertext and masked values remain distinct in reads, exports, audit events and logs. Run the independent database-isolation checks too: encryption does not authorise data access.
4. Rehearse rotation by retaining the old decrypt key, selecting a new active key, rewriting a bounded batch transactionally and checking that retries do not lose data. Confirm the encrypted row can still be read before retiring the old key. A failed rewrite must leave the previous envelope intact.
5. Restore an encrypted staging backup with the documented key versions and verify records across tenants. Only retire a version after migration, backup retention and restore requirements have been agreed. Removing a key makes the corresponding ciphertext unreadable, but this helper alone cannot establish deletion from all backups, logs and replicas.
6. Record the access review, restore result, rotation result and independent assessment. Keep real data and live instructions blocked until the missing host configuration, migrations, adapters and signed approvals have been independently verified.

## Verification

`artifacts/api-server/tests/pilot-security.test.ts` runs without network, credentials or a database. It covers token/session context, provisioning scope, expiry/revocation, role restrictions, missing and stale MFA factors, token-age freshness, ciphertext tampering, tenant/record/field binding, unknown key refusal and rotation. These unit checks do not verify an actual Clerk deployment, secret manager, storage migration, key destruction or live operational readiness.
