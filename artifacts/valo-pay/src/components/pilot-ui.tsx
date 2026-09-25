import { useRef, type ReactNode } from "react";
import { Link } from "wouter";
import { Button } from "./ui/button";
import { usePageProblemFocus } from "./record-pagination";
import { saidBy } from "@/lib/notify";
import { DiscardOriginalRequest } from "./discard-original-request";

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
/** Said when a page's information could not be read and the service gave no words of its own: nothing was asked of it but to read. */
export const READ_PROBLEM =
  "This information could not be loaded. Check your connection and try again.";
/** Said when a change the operations journal records got no answer: if it reached the service, Operations has it with its outcome. */
export const JOURNALED_WRITE_PROBLEM =
  "The request could not be completed. If it reached the service, Operations lists it with its outcome.";
/** Said when a change Operations does not record (team, access and new lender changes) got no answer: the page itself shows whether it was saved. */
export const UNJOURNALED_WRITE_PROBLEM =
  "The request could not be completed. Refresh this page to see whether it was saved before you try again.";

/**
 * A request's problem in the service's words, or in the fallback's when it
 * gave none (no answer, or a proxy's error page). A read and a change need
 * different fallbacks: a failed read changed nothing and is simply tried
 * again, while a change may have been saved and is checked where it is
 * recorded (`READ_PROBLEM` by default). A read's problem that took the place
 * of its list's page buttons after a page press takes their focus.
 */
export function PilotError({
  error,
  retry,
  fallback = READ_PROBLEM,
}: {
  error: unknown;
  retry?: () => void;
  fallback?: string;
}) {
  const notice = useRef<HTMLDivElement>(null);
  usePageProblemFocus(notice);
  return error ? (
    <div
      ref={notice}
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
    >
      <p>{saidBy(error, fallback)}</p>
      {retry && (
        <Button className="mt-3" variant="outline" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  ) : null;
}
/**
 * A change whose answer was lost: Check original request, Operations for a
 * change it records, and Discard original request, which moves focus to `next`,
 * the control that sent the request where the page names it, and otherwise to
 * the page's own nearest control.
 */
export function RecoveryNotice({
  mutation,
  persistent = true,
  next,
}: {
  persistent?: boolean;
  next?: () => HTMLElement | null | undefined;
  mutation: {
    hasUnconfirmedOutcome: boolean;
    isPending: boolean;
    error: unknown;
    retryUnconfirmed(): Promise<unknown>;
    abandonUnconfirmed(): void;
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
          ? "Check the original request before making a different change. Requests received by the server remain in Operations after you leave or reload. If it cannot be recovered, check Operations, then discard it to start again."
          : "Check the original request, or refresh this page to inspect the saved result before making another change. If it cannot be recovered, check the saved result, then discard it to start again."}
      </p>
      <PilotError error={mutation.error} fallback={persistent ? JOURNALED_WRITE_PROBLEM : UNJOURNALED_WRITE_PROBLEM} />
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
        <DiscardOriginalRequest
          disabled={mutation.isPending}
          onDiscard={mutation.abandonUnconfirmed}
          next={next}
        />
      </div>
    </div>
  ) : (
    <PilotError error={mutation.error} fallback={persistent ? JOURNALED_WRITE_PROBLEM : UNJOURNALED_WRITE_PROBLEM} />
  );
}
