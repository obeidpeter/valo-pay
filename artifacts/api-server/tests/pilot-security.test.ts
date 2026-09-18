import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { authorizePilotAccess, PilotAccessError, type PilotAccessPolicy, type PilotAccessFailure, type ProvisionedMembership, type VerifiedClerkSession } from '../src/lib/pilot-access.js';
import { decryptField, encryptField, FieldEncryptionError, rotateField, type FieldKeyRing, type FieldScope } from '../src/lib/field-encryption.js';

let checks = 0;
const now = Date.parse('2026-09-18T10:00:00Z');
const policy: PilotAccessPolicy = { enabled: true, environment: 'staging', issuer: 'https://clerk.example.test', authorisedParties: ['https://staging.example.test'], maxFactorAgeMinutes: 60, maxSensitiveFactorAgeMinutes: 10 };
const auth: VerifiedClerkSession = {
  userId: 'user_sample', sessionId: 'sess_sample', orgId: 'org_sample', tokenType: 'session_token', sessionStatus: 'active', factorVerificationAge: [0, 0],
  sessionClaims: { sub: 'user_sample', sid: 'sess_sample', iss: policy.issuer, azp: policy.authorisedParties[0], iat: now / 1000 - 30, exp: now / 1000 + 30, nbf: now / 1000 - 30 },
};
const member: ProvisionedMembership = { id: 'member_sample', userId: 'user_sample', organizationId: 'org_sample', tenantId: 'tenant_sample', role: 'Finance', status: 'active', validFrom: '2026-09-01T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z' };
const request = { tenantId: 'tenant_sample', action: 'confirm_match' } as const;
const reject = (fn: () => unknown, code: PilotAccessFailure) => { assert.throws(fn, error => error instanceof PilotAccessError && error.code === code); checks++; };

{
  const grant = authorizePilotAccess(auth, member, request, policy, now);
  assert.equal(grant.role, 'Finance');
  assert.equal(grant.tenantId, member.tenantId);
  assert.equal(grant.liveOperationsAllowed, false);
  assert.equal(Object.isFrozen(grant), true);
  checks += 4;
  reject(() => authorizePilotAccess(auth, member, request, { ...policy, enabled: false }, now), 'pilot_disabled');
  reject(() => authorizePilotAccess(auth, member, request, { ...policy, environment: 'production' } as never, now), 'pilot_disabled');
  for (const patch of [{ issuer: 'http://clerk.example.test' }, { authorisedParties: [] }, { authorisedParties: ['*'] }, { maxFactorAgeMinutes: NaN }, { maxSensitiveFactorAgeMinutes: 11 }]) reject(() => authorizePilotAccess(auth, member, request, { ...policy, ...patch }, now), 'configuration_invalid');
  reject(() => authorizePilotAccess(null, member, request, policy, now), 'authentication_required');
  reject(() => authorizePilotAccess({ ...auth, tokenType: 'api_key' }, member, request, policy, now), 'authentication_required');
  reject(() => authorizePilotAccess({ ...auth, sessionStatus: 'pending' }, member, request, policy, now), 'session_invalid');
  reject(() => authorizePilotAccess({ ...auth, actor: { sub: 'user_other' } }, member, request, policy, now), 'session_invalid');
  for (const patch of [{ sub: 'user_other' }, { sid: 'session_other' }, { iss: 'https://other.example.test' }, { azp: 'https://attacker.example.test' }, { exp: now / 1000 }, { iat: now / 1000 + 1 }, { nbf: now / 1000 + 1 }, { exp: 'future' }]) reject(() => authorizePilotAccess({ ...auth, sessionClaims: { ...auth.sessionClaims, ...patch } }, member, request, policy, now), 'session_invalid');
  reject(() => authorizePilotAccess(auth, null, request, policy, now), 'membership_required');
  for (const patch of [{ userId: 'user_other' }, { organizationId: 'org_other' }, { tenantId: 'tenant_other' }]) reject(() => authorizePilotAccess(auth, { ...member, ...patch }, request, policy, now), 'membership_required');
  for (const patch of [{ status: 'revoked' as const }, { status: 'suspended' as const }, { expiresAt: '2026-09-18T10:00:00Z' }, { validFrom: '2026-09-19T00:00:00Z' }, { expiresAt: 'invalid' }, { expiresAt: '2026-09-31T00:00:00Z' }, { validFrom: '2026-02-30T00:00:00Z' }]) reject(() => authorizePilotAccess(auth, { ...member, ...patch }, request, policy, now), 'membership_inactive');
  for (const role of ['Read-only', 'Operations', 'org:admin', 'Unsupported']) reject(() => authorizePilotAccess({ ...auth, sessionClaims: { ...auth.sessionClaims, role: 'Admin' } }, { ...member, role }, request, policy, now), 'role_not_permitted');
  reject(() => authorizePilotAccess(auth, member, { ...request, action: '__proto__' } as never, policy, now), 'role_not_permitted');
  for (const ages of [null, [-1, 0], [0, -1], [0, NaN], [0, 0.5], [0]] as const) reject(() => authorizePilotAccess({ ...auth, factorVerificationAge: ages as never }, member, request, policy, now), 'mfa_required');
  for (const ages of [[10, 0], [0, 10], [61, 0]]) reject(() => authorizePilotAccess({ ...auth, factorVerificationAge: ages as [number, number] }, member, request, policy, now), 'reverification_required');
  // Token age is added to the factor age; an old signed token cannot keep a factor fresh.
  reject(() => authorizePilotAccess({ ...auth, factorVerificationAge: [9, 0], sessionClaims: { ...auth.sessionClaims, iat: now / 1000 - 61 } }, member, request, policy, now), 'reverification_required');
  assert.equal(authorizePilotAccess({ ...auth, factorVerificationAge: [9, 9] }, member, request, policy, now).role, 'Finance'); checks++;
  assert.equal(authorizePilotAccess({ ...auth, factorVerificationAge: [30, 30] }, { ...member, role: 'Read-only' }, { ...request, action: 'read' }, policy, now).role, 'Read-only'); checks++;
  reject(() => authorizePilotAccess({ ...auth, factorVerificationAge: [60, 0] }, member, { ...request, action: 'read' }, policy, now), 'reverification_required');
  assert.equal(authorizePilotAccess(auth, { ...member, role: 'Compliance reviewer' }, { ...request, action: 'approve_policy' }, policy, now).role, 'Compliance reviewer'); checks++;
  reject(() => authorizePilotAccess(auth, { ...member, role: 'Admin' }, { ...request, action: 'approve_policy' }, policy, now), 'role_not_permitted');
}

{
  const scope: FieldScope = { tenantId: 'tenant_sample', recordId: 'record_sample', field: 'providerToken' };
  const oldKey = randomBytes(32), newKey = randomBytes(32);
  const ring: FieldKeyRing = { activeKeyId: '2026-09', keys: new Map([['2026-09', oldKey], ['2026-10', newKey]]) };
  const plaintext = 'sample only — Ọbi · Adéyẹmí';
  const sealed = encryptField(plaintext, scope, ring);
  assert.equal(decryptField(sealed, scope, ring), plaintext);
  assert.equal(JSON.stringify(sealed).includes(plaintext), false);
  assert.notEqual(encryptField(plaintext, scope, ring).iv, sealed.iv);
  assert.equal(Buffer.from(sealed.iv, 'base64url').byteLength, 12);
  assert.equal(Buffer.from(sealed.tag, 'base64url').byteLength, 16);
  assert.notDeepEqual(oldKey, Buffer.alloc(32), 'internal key cleanup does not erase the caller’s keyring');
  assert.equal(decryptField(encryptField('', scope, ring), scope, ring), '');
  checks += 7;
  const denied = (fn: () => unknown) => { assert.throws(fn, FieldEncryptionError); checks++; };
  for (const changedScope of [{ ...scope, tenantId: 'other' }, { ...scope, recordId: 'other' }, { ...scope, field: 'phone' }]) denied(() => decryptField(sealed, changedScope, ring));
  const flip = (value: string) => { const bytes = Buffer.from(value, 'base64url'); bytes[0] = bytes[0]! ^ 1; return bytes.toString('base64url'); };
  for (const changed of [
    { ...sealed, ciphertext: flip(sealed.ciphertext) }, { ...sealed, tag: flip(sealed.tag) }, { ...sealed, iv: flip(sealed.iv) },
    { ...sealed, tag: sealed.tag.slice(0, -2) }, { ...sealed, iv: '' }, { ...sealed, ciphertext: `${sealed.ciphertext}=` },
    { ...sealed, version: 2 }, { ...sealed, algorithm: 'none' }, { ...sealed, keyId: 'missing' },
  ]) denied(() => decryptField(changed, scope, ring));
  denied(() => decryptField(sealed, scope, { ...ring, keys: new Map([['2026-09', newKey]]) }));
  // Even aliasing the same key under another id fails because the version id is authenticated.
  denied(() => decryptField({ ...sealed, keyId: 'alias' }, scope, { ...ring, keys: new Map([['alias', oldKey]]) }));
  denied(() => decryptField(plaintext, scope, ring));
  denied(() => encryptField(plaintext, { ...scope, tenantId: '' }, ring));
  denied(() => encryptField('x'.repeat(16 * 1024 + 1), scope, ring));
  denied(() => encryptField(plaintext, scope, { activeKeyId: 'short', keys: new Map([['short', randomBytes(16)]]) }));
  for (const malformedId of [undefined, null, 123]) denied(() => encryptField(plaintext, scope, { activeKeyId: malformedId, keys: new Map([[malformedId, oldKey]]) } as never));
  denied(() => encryptField('Unpaired surrogate: \uD800', scope, ring));
  const rotated = rotateField(sealed, scope, { ...ring, activeKeyId: '2026-10' });
  assert.equal(rotated.keyId, '2026-10');
  assert.notEqual(rotated.iv, sealed.iv);
  const activeOnly: FieldKeyRing = { activeKeyId: '2026-10', keys: new Map([['2026-10', newKey]]) };
  assert.equal(decryptField(rotated, scope, activeOnly), plaintext);
  assert.equal(decryptField(sealed, scope, ring), plaintext, 'old records remain readable during rotation');
  checks += 4;
  denied(() => decryptField(sealed, scope, activeOnly));
  const joinedScope = { tenantId: 'a|b', recordId: 'c', field: 'd' };
  denied(() => decryptField(encryptField(plaintext, joinedScope, ring), { tenantId: 'a', recordId: 'b|c', field: 'd' }, ring));
}

console.log(`Pilot security foundation tests passed (${checks} checks): verified-session context, provisioned membership, role/MFA denial, field binding, tamper refusal and key rotation. No live access enabled.`);
