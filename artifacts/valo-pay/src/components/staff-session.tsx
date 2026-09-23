import { lazy, Suspense } from "react";
import { authEnabled, AuthShow, ClerkSlot } from "@/lib/auth";

// Clerk's controls, fetched only when a signed-in staff member is shown them, so the pages that
// can show this block (Team & access, an invitation, a refused workspace) do not bring Clerk's code.
const VerifiedSession = lazy(() => import("./staff-verification").then((module) => ({ default: module.VerifiedSession })));

/**
 * The signed-in staff member's organisation, account security and two-factor
 * check. Its controls are Clerk's, so they render under Clerk's provider
 * through a ClerkSlot, and load only where sign-in is available.
 */
export function StaffSession() {
  return authEnabled ? (
    <AuthShow when="signed-in">
      <ClerkSlot>
        <Suspense fallback={null}>
          <VerifiedSession />
        </Suspense>
      </ClerkSlot>
    </AuthShow>
  ) : (
    <p className="text-sm text-muted-foreground">
      Sign-in is not configured on this host. Staff access remains unavailable.
    </p>
  );
}
