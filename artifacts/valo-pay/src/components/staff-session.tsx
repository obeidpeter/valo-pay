import { authEnabled, AuthShow, ClerkSlot, VerifiedSession } from "@/lib/auth";

/**
 * The signed-in staff member's organisation, account security and two-factor
 * check. Its controls are Clerk's, so they render under Clerk's provider
 * through a ClerkSlot, and load only where sign-in is available.
 */
export function StaffSession() {
  return authEnabled ? (
    <AuthShow when="signed-in">
      <ClerkSlot>
        <VerifiedSession />
      </ClerkSlot>
    </AuthShow>
  ) : (
    <p className="text-sm text-muted-foreground">
      Sign-in is not configured on this host. Staff access remains unavailable.
    </p>
  );
}
