import type { ReactNode } from "react";
import { Link } from "wouter";
import { Button } from "./ui/button";
import { saidBy } from "@/lib/notify";

export const pilotField =
  "w-full min-h-11 rounded-lg border bg-background px-3 py-2 text-sm";
export function PilotHeading({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <header className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">
        Pilot workspace
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{children}</p>
    </header>
  );
}
export function PilotPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5 sm:p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
export function PilotError({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return error ? (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
    >
      <p>
        {saidBy(
          error,
          "The request could not be completed. Your original request is available in Operations if it reached the server.",
        )}
      </p>
      {retry && (
        <Button className="mt-3" variant="outline" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  ) : null;
}
export function RecoveryNotice({
  mutation,
  persistent = true,
}: {
  persistent?: boolean;
  mutation: {
    hasUnconfirmedOutcome: boolean;
    isPending: boolean;
    error: unknown;
    retryUnconfirmed(): Promise<unknown>;
  };
}) {
  return mutation.hasUnconfirmedOutcome ? (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-warning-border bg-warning/20 p-4 text-sm"
    >
      <p className="font-semibold">Outcome not confirmed</p>
      <p>
        {persistent
          ? "Check the original request before making a different change. Requests received by the server remain in Operations after you leave or reload."
          : "Check the original request, or refresh this page to inspect the saved result before making another change."}
      </p>
      <PilotError error={mutation.error} />
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          busy={mutation.isPending}
          onClick={() => {
            void mutation.retryUnconfirmed().catch(() => {});
          }}
        >
          Check original request
        </Button>
        {persistent && (
          <Link
            href="/operations"
            className="inline-flex min-h-11 items-center text-primary underline"
          >
            Open Operations
          </Link>
        )}
      </div>
    </div>
  ) : (
    <PilotError error={mutation.error} />
  );
}
