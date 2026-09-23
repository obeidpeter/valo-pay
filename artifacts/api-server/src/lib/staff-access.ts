import {
  authorizePilotAccess,
  type VerifiedClerkSession,
  type ProvisionedMembership,
  type PilotAccessPolicy,
} from "./pilot-access";

export function staffMode(): boolean {
  const mode = process.env.VALOPAY_STAFF_ACCESS;
  if (mode && mode !== "off" && mode !== "staging")
    throw Object.assign(new Error("Staff access configuration is invalid."), {
      status: 503,
    });
  return mode === "staging";
}
export function staffPolicy(write = false): PilotAccessPolicy {
  return {
    enabled: staffMode(),
    environment: "staging",
    issuer: process.env.VALOPAY_STAFF_ISSUER || "",
    authorisedParties: (process.env.VALOPAY_STAFF_ORIGINS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    maxFactorAgeMinutes: write ? 10 : 720,
    maxSensitiveFactorAgeMinutes: 10,
  };
}
export function verifyStaff(
  auth: VerifiedClerkSession,
  membership: ProvisionedMembership,
  write: boolean,
  now: string,
) {
  // Domain services enforce the specific operation's role. This check requires
  // fresh MFA for every write, including actions pilot-access.ts does not list.
  return authorizePilotAccess(
    auth,
    membership,
    { tenantId: membership.tenantId, action: "read" },
    staffPolicy(write),
    Date.parse(now),
  );
}
