import { Link, useLocation } from "wouter";
import {
  ArrowUpRight,
  Building2,
  Landmark,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import "@/connected.css";
export function ConnectedFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
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
      {children}
    </div>
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
