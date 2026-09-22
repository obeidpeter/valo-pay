import { useState } from "react";
import { Link } from "wouter";
import { ArrowRight, CheckCircle2, Circle, Building2 } from "lucide-react";
import { useWorkspace } from "@/lib/workspace-context";
import { usePilotMutation, usePilotQuery } from "@/lib/pilot";
import {
  PilotError,
  PilotHeading,
  PilotPanel,
  RecoveryNotice,
  pilotField,
} from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";

export default function PilotPage() {
  const { merchantId, workspace, setMerchantId } = useWorkspace();
  const journey = usePilotQuery("/pilot/journey");
  const [name, setName] = useState(""),
    [segment, setSegment] = useState("Consumer lending");
  const create = usePilotMutation((data) => {
    setMerchantId(data.id);
    setName("");
  });
  const counts = journey.data?.counts;
  const steps = [
    {
      name: "Onboard a lender",
      detail: "Start an empty workspace and confirm who has access.",
      href: "/team",
      ready: !!merchantId,
    },
    {
      name: "Ingest records",
      detail: "Save a source batch, fix row errors and import once.",
      href: "/imports",
      ready: (counts?.batches || 0) > 0,
    },
    {
      name: "Reconcile payments",
      detail: "Match payment evidence and review proposed allocations.",
      href: "/reconciliation",
      ready: (counts?.receipts || 0) > 0,
    },
    {
      name: "Resolve exceptions",
      detail: `${counts?.openCases ?? "—"} open · ${counts?.unassignedCases ?? "—"} without a named assignee.`,
      href: "/exceptions",
      ready: counts && counts.openCases === 0,
    },
    {
      name: "Review the close",
      detail: "Open the dated close and inspect unresolved items.",
      href: "/reports",
      ready: (counts?.closes || 0) > 0,
    },
    {
      name: "Export evidence",
      detail: "Request a saved evidence pack and check its download status.",
      href: "/evidence",
      ready: (counts?.exports || 0) > 0,
    },
  ];
  return (
    <div className="space-y-7 pb-10">
      <PilotHeading title="Your pilot journey">
        Bring the operational steps together for one lender. Progress below
        reflects saved records; it is not approval to use real customer data or
        move money.
      </PilotHeading>
      <PilotError
        error={journey.error}
        retry={() => {
          void journey.refetch();
        }}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        {steps.map((step, index) => (
          <Link
            key={step.href}
            href={merchantId ? step.href : "/pilot"}
            className="group flex gap-4 rounded-xl border bg-card p-5 hover:border-primary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="pt-1 text-primary" aria-hidden="true">
              {step.ready ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : (
                <Circle className="h-5 w-5" />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">
                Step {index + 1} ·{" "}
                {step.ready ? "Saved records available" : "To review"}
              </p>
              <h2 className="mt-2 font-semibold">{step.name}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {step.detail}
              </p>
              <ArrowRight
                aria-hidden="true"
                className="mt-4 h-4 w-4 text-primary"
              />
            </div>
          </Link>
        ))}
      </div>
      <PilotPanel title="Set up a lender">
        <p className="text-sm text-muted-foreground">
          Create an empty synthetic lender for the pilot rehearsal. Import your
          sample customers first, then their mandates, instalments and payment
          evidence. Scheduled actions start switched off.
        </p>
        <form
          className="grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({
              path: "/pilot/lenders",
              lender: false,
              data: { name, segment },
            });
          }}
        >
          <label className="space-y-2 text-sm font-medium">
            Lender name
            <input
              className={pilotField}
              required
              minLength={2}
              maxLength={100}
              value={name}
              disabled={create.isPending || create.hasUnconfirmedOutcome}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="space-y-2 text-sm font-medium">
            Lender type
            <select
              className={pilotField}
              value={segment}
              disabled={create.isPending || create.hasUnconfirmedOutcome}
              onChange={(e) => setSegment(e.target.value)}
            >
              {[
                "Consumer lending",
                "Cooperative",
                "Asset finance",
                "Business finance",
              ].map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </label>
          <Button
            type="submit"
            busy={create.isPending}
            disabled={
              workspace?.role !== "Admin" || create.hasUnconfirmedOutcome
            }
          >
            <Building2 aria-hidden="true" className="mr-2 h-4 w-4" />
            Create lender
          </Button>
        </form>
        {workspace?.role !== "Admin" && (
          <p className="text-sm text-muted-foreground">
            An administrator must create the lender.
          </p>
        )}
        <RecoveryNotice mutation={create} persistent={false} />
        {create.isSuccess && (
          <p role="status" className="text-sm">
            Lender created. Select it above, then open Import batches.
          </p>
        )}
      </PilotPanel>
      <div className="flex flex-wrap gap-5 text-sm">
        <Link href="/operations" className="text-primary underline">
          Recover an uncertain request
        </Link>
        <Link href="/team" className="text-primary underline">
          Review staff access
        </Link>
      </div>
    </div>
  );
}
