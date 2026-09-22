import { Link, useLocation } from "wouter";
import {
  ArrowUpRight,
  Building2,
  Landmark,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import "@/connected.css";
type Recovery = {
  scope: string;
  pending: boolean;
  hasUnconfirmedOutcome: boolean;
  retryUnconfirmed: () => Promise<void>;
};
export function ConnectedFrame({
  title,
  description,
  children,
  recovery,
  onRecovered,
}: {
  title: string;
  description: string;
  children: ReactNode;
  recovery?: Recovery;
  onRecovered?: () => void;
}) {
  const [location] = useLocation();
  return (
    <div className="connected-page space-y-6">
      <header className="connected-heading">
        <div>
          <p className="connected-eyebrow">
            <Sparkles size={14} aria-hidden="true" /> Connected workspace
          </p>
          <h1>{title}</h1>
          <p className="text-sm text-muted-foreground max-w-2xl mt-2">
            {description}
          </p>
        </div>
        <span className="connected-mode">
          Sample journeys · no live instructions
        </span>
      </header>
      <nav className="connected-tabs" aria-label="Connected modules">
        {[
          { href: "/pay-by-bank", label: "Pay-by-bank", icon: Landmark },
          { href: "/credit-desk", label: "Credit Desk", icon: ShieldCheck },
          { href: "/cash-desk", label: "Cash Desk", icon: Building2 },
          {
            href: "/connections",
            label: "Permissions & readiness",
            icon: ArrowUpRight,
          },
        ].map((i) => (
          <Link
            key={i.href}
            href={i.href}
            aria-current={location === i.href ? "page" : undefined}
          >
            <i.icon size={16} aria-hidden="true" />
            {i.label}
          </Link>
        ))}
      </nav>
      <ConnectedRecovery recovery={recovery} onRecovered={onRecovered} />
      <fieldset
        disabled={recovery?.pending || recovery?.hasUnconfirmedOutcome}
        className="space-y-6 min-w-0"
        aria-label="Connected workspace actions and records"
      >
        {children}
      </fieldset>
    </div>
  );
}
export function ConnectedRecovery({
  recovery,
  onRecovered,
}: {
  recovery?: Recovery;
  onRecovered?: () => void;
}) {
  const [recoveryError, setRecoveryError] = useState("");
  const [recovered, setRecovered] = useState(false);
  const scope = useRef(recovery?.scope);
  scope.current = recovery?.scope;
  useEffect(() => {
    setRecovered(false);
    setRecoveryError("");
  }, [recovery?.scope]);
  useEffect(() => {
    if (recovery?.hasUnconfirmedOutcome) {
      setRecovered(false);
      setRecoveryError("");
    }
  }, [recovery?.hasUnconfirmedOutcome]);
  return (
    <>
      {recovery?.hasUnconfirmedOutcome && (
        <div className="connected-note" role="alert">
          <h2 className="font-semibold text-foreground">
            Previous action outcome unconfirmed
          </h2>
          <p className="mt-2">
            The response was lost or unavailable. Your action may already have
            been saved. Keep this workspace open and retry the original request
            to recover its result. Do not start a replacement action.
          </p>
          <Button
            className="mt-3"
            busy={recovery.pending}
            busyLabel="Recovering result…"
            onClick={async () => {
              const submittedScope = recovery.scope;
              setRecoveryError("");
              try {
                await recovery.retryUnconfirmed();
                if (scope.current === submittedScope) {
                  onRecovered?.();
                  setRecovered(true);
                }
              } catch (error) {
                if (scope.current === submittedScope)
                  setRecoveryError((error as Error).message);
              }
            }}
          >
            Retry original sample request
          </Button>
          {recoveryError && <p className="mt-2">{recoveryError}</p>}
        </div>
      )}
      {!recovery?.hasUnconfirmedOutcome && recoveryError && (
        <p role="alert" className="connected-error">
          {recoveryError}
        </p>
      )}
      {recovered && (
        <p className="connected-note" role="status">
          Original sample request confirmed. Review the refreshed records below.
          No live financial instruction was sent.
        </p>
      )}
    </>
  );
}
export function ConnectedPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="connected-panel">
      <div className="connected-panel-head">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="p-5 space-y-4">{children}</div>
    </section>
  );
}
export function ConnectedStatus({ status }: { status: string }) {
  return (
    <span
      className={`connected-status ${["confirmed", "active", "approved", "complete"].includes(status) ? "good" : ["unknown", "expired", "revoked", "failed", "blocked", "refused"].includes(status) ? "attention" : ""}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
