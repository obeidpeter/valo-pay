import { useState } from "react";
import {
  OrganizationSwitcher,
  useClerk,
  useReverification,
} from "@clerk/react";
import { authEnabled, AuthShow } from "@/lib/auth";
import { Button } from "./ui/button";
import { PilotError } from "./pilot-ui";

export function StaffSession() {
  return authEnabled ? (
    <AuthShow when="signed-in">
      <VerifiedSession />
    </AuthShow>
  ) : (
    <p className="text-sm text-muted-foreground">
      Sign-in is not configured on this host. Staff access remains unavailable.
    </p>
  );
}
function VerifiedSession() {
  const clerk = useClerk(),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const verify = useReverification(() =>
    fetch("/api/v1/team/verify", {
      method: "POST",
      credentials: "same-origin",
    }),
  );
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Select your provisioned organisation. Use account security to enrol an
        authenticator, then verify both factors before making a pilot change.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <OrganizationSwitcher hidePersonal />
        <Button variant="outline" onClick={() => clerk.openUserProfile()}>
          Account security
        </Button>
        <Button
          variant="outline"
          busy={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            setMessage("");
            void verify()
              .then(async (response) => {
                if (!response) return;
                const result = await response.json();
                if (!response.ok)
                  throw new Error(
                    result.error || "Verification could not be completed.",
                  );
                setMessage("Identity verified. Retry your original request.");
              })
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          Verify identity
        </Button>
      </div>
      <PilotError error={error} />
      <p role="status" className="text-sm">
        {message}
      </p>
    </div>
  );
}
