import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useWorkspace } from "@/lib/workspace-context";
import { usePilotMutation, usePilotQuery } from "@/lib/pilot";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import {
  PilotError,
  PilotHeading,
  PilotPanel,
  RecoveryNotice,
  pilotField,
} from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { formatDate, formatKobo } from "@/lib/formatters";
import { readableLabel } from "@/components/record-label";
import { LookedFor } from "@/components/notice";
import { NotFoundNotice } from "@/pages/not-found";

const watInput = (iso: string) =>
  new Date(Date.parse(iso) + 3600000).toISOString().slice(0, 16);
/** The address is a case page, but the current lender has no exception with that ID. */
function MissingCase({ id }: { id: string }) {
  useEffect(() => {
    document.title = "Case not found · Valo Pay";
  }, []);
  return (
    <NotFoundNotice
      title="Case not found"
      primary={{ href: "/exceptions", label: "Back to exceptions" }}
      secondary={{ href: "/overview", label: "Go to overview" }}
    >
      <p>
        No case was found with ID <LookedFor>{id}</LookedFor> for the selected
        lender. Check the address or choose another lender.
      </p>
      <p>No records have changed.</p>
    </NotFoundNotice>
  );
}
export default function CasePage({ params }: { params: { id: string } }) {
  const { merchantId } = useWorkspace(),
    query = usePilotQuery(`/pilot/cases/${params.id}`);
  // A confirmed 404 is its own page; any other failure keeps the retry below.
  if ((query.error as { status?: number } | null)?.status === 404)
    return <MissingCase id={params.id} />;
  return (
    <div className="space-y-6">
      <Link href="/exceptions" className="text-sm text-primary underline">
        Back to exceptions
      </Link>
      <PilotHeading title="Coordinate a case">
        Keep ownership, next steps and evidence together. Recording a handover
        does not allocate a payment or resolve its exception.
      </PilotHeading>
      <PilotError
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
      {query.isLoading && <p role="status">Loading this case…</p>}
      {query.data && (
        <CaseWork
          key={`${merchantId}:${params.id}`}
          data={query.data}
          refresh={() => query.refetch()}
        />
      )}
    </div>
  );
}
function CaseWork({ data, refresh }: { data: any; refresh(): Promise<any> }) {
  const { workspace } = useWorkspace();
  const [record, setRecord] = useState(data.record),
    [note, setNote] = useState("");
  const [assignee, setAssignee] = useState(
    record.data.case?.assignee || workspace?.actor || "",
  );
  const [nextAction, setNextAction] = useState(
    record.data.case?.nextAction || "",
  );
  const [when, setWhen] = useState(
    watInput(
      record.data.case?.nextActionAt ||
        new Date(Date.now() + 86400000).toISOString(),
    ),
  );
  const [evidence, setEvidence] = useState<string[]>(
      record.data.case?.evidenceIds || [],
    ),
    [search, setSearch] = useState("");
  const { confirmDiscard } = useUnsavedChanges(
    Boolean(note.trim()) ||
      nextAction !== (record.data.case?.nextAction || "") ||
      assignee !== (record.data.case?.assignee || workspace?.actor || "") ||
      JSON.stringify(evidence) !==
        JSON.stringify(record.data.case?.evidenceIds || []),
  );
  const mutation = usePilotMutation((saved) => {
    setRecord(saved);
    setNote("");
    setAssignee(saved.data.case?.assignee || "");
  });
  const denied =
    workspace?.role === "Read-only" ||
    ["closed", "resolved"].includes(record.status);
  const busy = mutation.isPending || mutation.hasUnconfirmedOutcome,
    changed = Date.parse(data.record.updatedAt) > Date.parse(record.updatedAt);
  const submit = (action: "claim" | "update" | "handover") =>
    mutation.mutate({
      path: `/pilot/cases/${record.id}`,
      data: {
        action,
        assignee,
        expectedUpdatedAt: record.updatedAt,
        note,
        nextAction,
        nextActionAt: new Date(`${when}:00+01:00`).toISOString(),
        evidenceIds: evidence,
      },
    });
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
        <PilotPanel title={readableLabel(record.data.type)}>
          <p className="text-2xl font-semibold tabular-nums">
            {formatKobo(record.amountKobo)}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Status</dt>
            <dd>{readableLabel(record.status)}</dd>
            <dt className="text-muted-foreground">Team</dt>
            <dd>{record.data.owner || "Unassigned"}</dd>
            <dt className="text-muted-foreground">Case assignee</dt>
            <dd>{record.data.case?.assigneeName || "Not claimed"}</dd>
            <dt className="text-muted-foreground">Exception deadline</dt>
            <dd>
              {record.data.dueBy ? formatDate(record.data.dueBy) : "Not set"}
            </dd>
            <dt className="text-muted-foreground">Next action</dt>
            <dd>{record.data.case?.nextAction || "Not recorded"}</dd>
            <dt className="text-muted-foreground">Follow-up</dt>
            <dd>
              {record.data.case?.nextActionAt
                ? formatDate(record.data.case.nextActionAt)
                : "Not set"}
            </dd>
          </dl>
          <p className="text-sm text-muted-foreground">{record.data.notes}</p>
          <Link
            href={`/exceptions?record=${encodeURIComponent(record.id)}`}
            className="inline-block text-sm text-primary underline"
          >
            Review the controlled resolution
          </Link>
          <Link
            href="/reconciliation"
            className="block text-sm text-primary underline"
          >
            Open payment reconciliation
          </Link>
        </PilotPanel>
        <PilotPanel
          title={record.data.case ? "Record the next step" : "Claim this case"}
        >
          {changed && (
            <p
              role="status"
              className="rounded-lg border border-warning-border p-3 text-sm"
            >
              A newer version is available. Your draft is still here. Refresh
              before submitting.
            </p>
          )}
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit(
                !record.data.case?.assignee
                  ? "claim"
                  : assignee !== record.data.case.assignee
                    ? "handover"
                    : "update",
              );
            }}
          >
            <fieldset
              disabled={busy || denied || changed}
              className="space-y-4"
            >
              <label className="block space-y-1 text-sm font-medium">
                Assigned to
                <select
                  className={pilotField}
                  value={assignee}
                  disabled={!record.data.case?.assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                >
                  {data.assignees.map((person: any) => (
                    <option key={person.actor} value={person.actor}>
                      {person.name} · {person.role}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 text-sm font-medium">
                Next action
                <input
                  className={pilotField}
                  required
                  minLength={3}
                  maxLength={240}
                  value={nextAction}
                  onChange={(e) => setNextAction(e.target.value)}
                  placeholder="Confirm the payer and review the matching evidence"
                />
              </label>
              <label className="block space-y-1 text-sm font-medium">
                Follow-up time (WAT)
                <input
                  className={pilotField}
                  type="datetime-local"
                  required
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                />
              </label>
              <label className="block space-y-1 text-sm font-medium">
                Handover or progress note
                <textarea
                  className={`${pilotField} min-h-24`}
                  required
                  minLength={3}
                  maxLength={2000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What was checked, what remains and why this next step is needed"
                />
              </label>
              <details>
                <summary className="cursor-pointer py-2 text-sm font-medium">
                  Linked evidence ({evidence.length})
                </summary>
                <label className="block text-sm">
                  Find evidence
                  <input
                    className={pilotField}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Name, reference or record type"
                  />
                </label>
                <div className="mt-2 max-h-52 space-y-2 overflow-auto rounded-lg border p-3">
                  {data.evidence
                    .filter((item: any) =>
                      `${item.name} ${item.reference} ${item.kind}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .slice(0, 100)
                    .map((item: any) => (
                      <label
                        key={item.id}
                        className="flex items-start gap-2 text-sm"
                      >
                        <input
                          className="mt-1"
                          type="checkbox"
                          checked={evidence.includes(item.id)}
                          onChange={(e) =>
                            setEvidence((previous) =>
                              e.target.checked
                                ? [...previous, item.id]
                                : previous.filter((id) => id !== item.id),
                            )
                          }
                        />
                        <span>
                          {item.name}
                          <small className="block text-muted-foreground">
                            {readableLabel(item.kind)} · {item.reference}
                          </small>
                        </span>
                      </label>
                    ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Up to 20 evidence links. The list shows the first 100 matching
                  records.
                </p>
              </details>
            </fieldset>
            <RecoveryNotice mutation={mutation} />
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                disabled={denied || busy || changed}
                busy={mutation.isPending}
              >
                {!record.data.case?.assignee
                  ? "Claim and save next step"
                  : assignee !== record.data.case.assignee
                    ? "Save handover"
                    : "Save next step"}
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!confirmDiscard()) return;
                  void refresh().then((result) => {
                    if (result.data) {
                      const latest = result.data.record;
                      setRecord(latest);
                      setNote("");
                      setNextAction(latest.data.case?.nextAction || "");
                      setAssignee(
                        latest.data.case?.assignee || workspace?.actor,
                      );
                      setEvidence(latest.data.case?.evidenceIds || []);
                      setWhen(
                        watInput(
                          latest.data.case?.nextActionAt ||
                            new Date(Date.now() + 86400000).toISOString(),
                        ),
                      );
                    }
                  });
                }}
              >
                Refresh case
              </Button>
            </div>
            {mutation.isSuccess && (
              <p role="status" className="text-sm">
                Case update saved with its handover history.
              </p>
            )}
            {denied && (
              <p className="text-sm text-muted-foreground">
                {workspace?.role === "Read-only"
                  ? "Your role can review this case but cannot change it."
                  : "Resolved cases keep their history and cannot be reassigned."}
              </p>
            )}
          </form>
        </PilotPanel>
      </div>
      <PilotPanel title="Handover history">
        {data.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No handover recorded yet. Claim the case to add the first next step.
          </p>
        ) : (
          <ol className="space-y-5">
            {[...data.events].reverse().map((event: any) => (
              <li key={event.id} className="border-l-2 border-primary/30 pl-4">
                <p className="text-sm font-semibold">
                  {event.name} · {event.data.after?.assigneeName}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">
                  {event.data.note}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Next: {event.data.after?.nextAction} ·{" "}
                  {formatDate(event.data.after?.nextActionAt)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {event.data.actor} · {formatDate(event.createdAt)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </PilotPanel>
    </>
  );
}
