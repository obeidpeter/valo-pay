import { useEffect, useRef, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { BatchInput } from "@workspace/valopay-schema";
import { useWorkspace } from "@/lib/workspace-context";
import {
  lenderPath,
  pilotRequest,
  usePilotMutation,
  usePilotQuery,
} from "@/lib/pilot";
import {
  confirmUnsavedChanges,
  useUnsavedChanges,
} from "@/lib/unsaved-changes";
import {
  PilotError,
  PilotHeading,
  PilotPanel,
  RecoveryNotice,
  pilotField,
} from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { formatDate, formatKobo } from "@/lib/formatters";
import { ScrollFrame } from "@/components/scroll-frame";
import { readableLabel } from "@/components/record-label";

const types = {
  customers: "Customers",
  mandates: "Mandates",
  "due-items": "Instalments",
  attempts: "Collection attempts",
  observations: "Payment evidence",
};
const samples = {
  customers:
    "source_row_id,name,reference,consentProvenance,bankName,accountMasked\ncustomer-001,Pilot customer,PILOT-C001,Synthetic pilot consent,Sandbox Bank,•••• 0001",
  mandates:
    "source_row_id,name,reference,customerId,amount,workflow,frequency,activationDeadline,consentEvidence,consentGaps\nmandate-001,Pilot mandate,PILOT-M001,PILOT-C001,50000,hosted_consent,monthly,2028-12-01,SYNTHETIC-CONSENT-001,",
  "due-items":
    "source_row_id,name,reference,customerId,amount,dueDate,mandateId,owner,overrideReason\ninstalment-001,Pilot instalment,PILOT-D001,PILOT-C001,25000,2028-12-01,,lms,",
  attempts:
    "source_row_id,name,reference,customerId,amount,dueItemId,number,failureCode,occurredAt\nattempt-001,Pilot attempt,PILOT-A001,PILOT-C001,25000,PILOT-D001,1,INSUFFICIENT_FUNDS,2028-12-02",
  observations:
    "source_row_id,name,reference,customerId,amount,source,dueItemId,narration\npayment-001,Pilot payment,PILOT-O001,PILOT-C001,25000,statement,PILOT-D001,PILOT-D001 synthetic transfer",
};
const fields = [
  "name",
  "reference",
  "status",
  "customerId",
  "amountKobo",
  "consentProvenance",
  "bankName",
  "accountMasked",
  "phoneMasked",
  "payDay",
  "consentCapturedAt",
  "workflow",
  "frequency",
  "activationDeadline",
  "consentEvidence",
  "consentGaps",
  "consentGiven",
  "policyId",
  "providerReference",
  "dueDate",
  "mandateId",
  "owner",
  "overrideReason",
  "instalmentId",
  "dueItemId",
  "number",
  "failureCode",
  "occurredAt",
  "source",
  "narration",
  "eventId",
  "channel",
  "currency",
  "payerKey",
];
const empty = (): BatchInput => ({
  name: "",
  kind: "customers",
  source: "",
  sourceBatchId: "",
  identityColumn: "source_row_id",
  amountUnit: "naira",
  mapping: {},
  csv: "",
  syntheticOnly: true,
});

export default function ImportsPage() {
  const { merchantId } = useWorkspace();
  return <LenderImports key={merchantId || "no-lender"} />;
}
function LenderImports() {
  const search = new URLSearchParams(useSearch());
  const { merchantId } = useWorkspace(),
    [offset, setOffset] = useState(0),
    list = usePilotQuery(`/pilot/batches?offset=${offset}`);
  const [selected, setSelected] = useState<string | null>(() => search.get("batch")),
    [editor, setEditor] = useState(0);
  return (
    <div className="space-y-6">
      <PilotHeading title="Import batches">
        Save the file, mapping and row checks together. Return to fix a batch
        later, then commit every valid row in one step. Only synthetic sample
        records are accepted.
      </PilotHeading>
      {!merchantId ? (
        <Link href="/pilot" className="text-primary underline">
          Create a lender to begin
        </Link>
      ) : (
        <BatchEditor
          key={`${merchantId}:${selected || editor}`}
          id={selected}
          initialProfile={search.get("profile")}
          onSaved={(id) => setSelected(id)}
          onNew={() => {
            setSelected(null);
            setEditor((n) => n + 1);
          }}
        />
      )}
      <PilotPanel title="Saved batches">
        <PilotError
          error={list.error}
          retry={() => {
            void list.refetch();
          }}
        />
        {list.isLoading && <p role="status">Loading batches…</p>}
        {list.data?.total === 0 && (
          <p className="text-sm text-muted-foreground">
            Your first saved batch will appear here, including any rows that
            need correction.
          </p>
        )}
        <div className="space-y-2">
          {list.data?.items.map((batch: any) => (
            <button
              key={batch.id}
              type="button"
              onClick={() => {
                if (confirmUnsavedChanges()) setSelected(batch.id);
              }}
              className="flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-left hover:bg-secondary/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span>
                <strong className="text-sm">{batch.name}</strong>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {batch.data.source} · {batch.data.sourceBatchId} ·{" "}
                  {formatDate(batch.updatedAt)}
                </span>
              </span>
              <span className="rounded-full bg-secondary px-3 py-1 text-xs">
                {readableLabel(batch.status)} · revision {batch.data.revision}
              </span>
            </button>
          ))}
        </div>
        {list.data?.total > 25 && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={!offset || list.isFetching}
              onClick={() => setOffset((n) => Math.max(0, n - 25))}
            >
              Previous batches
            </Button>
            <span className="text-sm">
              {offset + 1}–{Math.min(offset + 25, list.data.total)} of{" "}
              {list.data.total}
            </span>
            <Button
              variant="outline"
              disabled={offset + 25 >= list.data.total || list.isFetching}
              onClick={() => setOffset((n) => n + 25)}
            >
              Next batches
            </Button>
          </div>
        )}
      </PilotPanel>
      <Link href="/sources" className="inline-block text-sm text-primary underline">Manage source schedules, mappings and totals</Link>
      <Link
        href="/pilot"
        className="inline-block text-sm text-primary underline"
      >
        Return to the pilot journey
      </Link>
    </div>
  );
}
function BatchEditor({
  id,
  initialProfile,
  onSaved,
  onNew,
}: {
  id: string | null;
  initialProfile: string | null;
  onSaved(id: string): void;
  onNew(): void;
}) {
  const { merchantId, workspace } = useWorkspace();
  const sources = usePilotQuery("/sources");
  const [selectedProfile, setSelectedProfile] = useState(initialProfile || "");
  const initialProfileApplied = useRef(false);
  const detail = useQuery<any>({
    queryKey: ["pilot", "batch", merchantId, workspace?.actor, id],
    enabled: !!id,
    queryFn: ({ signal }) =>
      pilotRequest(lenderPath(`/pilot/batches/${id}`, merchantId), { signal }),
  });
  const [form, setForm] = useState<BatchInput>(empty),
    [batch, setBatch] = useState<any>(null),
    [saved, setSaved] = useState(""),
    [fileError, setFileError] = useState(""),
    [reading, setReading] = useState(false);
  const applyProfile = (profile: any) => {
    setSelectedProfile(profile?.id || "");
    if (!profile) return;
    setForm(current => ({ ...current, source: profile.data.source, kind: profile.data.kind, mapping: { ...profile.data.mapping }, amountUnit: profile.data.amountUnit, identityColumn: profile.data.identityColumn }));
  };
  useEffect(() => {
    if (id || initialProfileApplied.current || !sources.data) return;
    initialProfileApplied.current = true;
    const profile = sources.data.profiles.find((p: any) => p.id === initialProfile);
    if (profile) applyProfile(profile);
  }, [id, initialProfile, sources.data]);
  const loaded = useRef(false),
    fileSequence = useRef(0);
  useEffect(
    () => () => {
      fileSequence.current++;
    },
    [],
  );
  const hydrate = (record: any) => {
    const next = {
      ...empty(),
      ...Object.fromEntries(
        Object.keys(empty()).map((key) => [
          key,
          key === "name" ? record.name : key === "csv" ? record.data.csv || "" : record.data[key],
        ]),
      ),
      expectedUpdatedAt: record.updatedAt,
    } as BatchInput;
    setForm(next);
    setSaved(JSON.stringify(next));
    setBatch(record);
  };
  useEffect(() => {
    if (detail.data && !loaded.current) {
      loaded.current = true;
      hydrate(detail.data.batch);
    }
  }, [detail.data]);
  const dirty = !!form.csv && JSON.stringify(form) !== saved;
  const { confirmDiscard } = useUnsavedChanges(dirty);
  const mutation = usePilotMutation((record) => {
    hydrate(record);
    onSaved(record.id);
  });
  const busy = mutation.isPending || reading,
    locked =
      busy || mutation.hasUnconfirmedOutcome || batch?.status === "committed";
  const denied = !["Admin", "Operations", "Finance"].includes(
    workspace?.role || "",
  );
  const set = <K extends keyof BatchInput>(key: K, value: BatchInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const check = batch?.data.check;
  const readFile = async (file?: File) => {
    if (!file || !confirmDiscard()) return;
    if (file.size > 1500000) {
      setFileError("Choose a file no larger than 1.5 MB.");
      return;
    }
    const seq = ++fileSequence.current;
    setReading(true);
    setFileError("");
    try {
      const csv = await file.text();
      if (seq === fileSequence.current)
        setForm((current) => ({
          ...current,
          csv,
          mapping: selectedProfile ? current.mapping : {},
          name: current.name || file.name,
        }));
    } catch {
      if (seq === fileSequence.current)
        setFileError(
          "The file could not be read. You can paste its CSV content below.",
        );
    } finally {
      if (seq === fileSequence.current) setReading(false);
    }
  };
  if (id && !batch)
    return (
      <PilotPanel title="Open batch">
        <PilotError
          error={detail.error}
          retry={() => {
            void detail.refetch();
          }}
        />
        {detail.isLoading && (
          <p role="status">Loading the saved source and checks…</p>
        )}
      </PilotPanel>
    );
  return (
    <PilotPanel title={batch ? batch.name : "Start a source batch"}>
      <p className="text-sm text-muted-foreground">
        Use a stable source name and source batch ID. Each row needs a source
        row ID that stays the same when you correct or upload it again. Two
        separate payments must have different IDs, even if their amounts match.
      </p>
      {batch?.data.rawCsvRemovedAt && <p className="rounded-lg border bg-secondary/30 p-3 text-sm">The original CSV expired under this lender's retention policy on {formatDate(batch.data.rawCsvRemovedAt)}. Imported records, source row identities and saved checks remain available.</p>}
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate({
            path: id ? `/pilot/batches/${id}/save` : "/pilot/batches",
            data: form,
          });
        }}
      >
        {!id && <div className="space-y-2"><label className="block space-y-1 text-sm font-medium">Reusable source mapping<select className={pilotField} disabled={locked || denied || sources.isLoading} value={selectedProfile} onChange={event => { if (!confirmDiscard()) return; applyProfile(sources.data?.profiles.find((p: any) => p.id === event.target.value)); }}><option value="">Start without a saved mapping</option>{sources.data?.profiles.map((profile: any) => <option key={profile.id} value={profile.id}>{profile.name} · {types[profile.data.kind as keyof typeof types]}</option>)}</select></label><p className="text-xs text-muted-foreground">A profile fills the source, record type, row identity, units and column mapping. Its active expectations are checked again before commit.</p>{initialProfile && sources.data && !sources.data.profiles.some((p: any) => p.id === initialProfile) && <p role="alert" className="text-sm text-destructive">This source profile is not available in the selected lender. Choose a profile below or return to Sources.</p>}<PilotError error={sources.error}/></div>}
        <fieldset
          disabled={locked || denied}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <label className="space-y-1 text-sm font-medium">
            Batch name
            <input
              className={pilotField}
              required
              value={form.name}
              maxLength={120}
              onChange={(e) => set("name", e.target.value)}
              placeholder="September payment evidence"
            />
          </label>
          <label className="space-y-1 text-sm font-medium">
            Record type
            <select
              className={pilotField}
              disabled={!!id}
              value={form.kind}
              onChange={(e) => {
                if (confirmDiscard())
                  setForm({
                    ...empty(),
                    kind: e.target.value as BatchInput["kind"],
                    name: form.name,
                    source: form.source,
                  });
              }}
            >
              {Object.entries(types).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm font-medium">
            Source name
            <input
              className={pilotField}
              required
              disabled={!!id}
              value={form.source}
              maxLength={100}
              onChange={(e) => set("source", e.target.value)}
              placeholder="Pilot loan system"
            />
          </label>
          <label className="space-y-1 text-sm font-medium">
            Source batch ID
            <input
              className={pilotField}
              required
              disabled={!!id}
              value={form.sourceBatchId}
              maxLength={120}
              onChange={(e) => set("sourceBatchId", e.target.value)}
              placeholder="statement-2026-09"
            />
          </label>
          <label className="space-y-1 text-sm font-medium">
            Source row ID column
            <input
              className={pilotField}
              required
              value={form.identityColumn}
              maxLength={100}
              onChange={(e) => set("identityColumn", e.target.value)}
            />
          </label>
          <label className="space-y-1 text-sm font-medium">
            Amounts in the source file
            <select
              className={pilotField}
              value={form.amountUnit}
              onChange={(e) =>
                set("amountUnit", e.target.value as "naira" | "kobo")
              }
            >
              <option value="naira">Naira (₦) — 1,000.50</option>
              <option value="kobo">Kobo — 100050</option>
            </select>
          </label>
        </fieldset>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 space-y-2 text-sm font-medium">
            Choose CSV file
            <input
              className={pilotField}
              type="file"
              accept=".csv,text/csv"
              disabled={locked || denied}
              onChange={(e) => {
                void readFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={locked || denied || !!id}
            onClick={() => {
              if (confirmDiscard())
                setForm({
                  ...form,
                  csv: samples[form.kind],
                  mapping: {},
                  name: form.name || `${types[form.kind]} sample`,
                  source: form.source || "Pilot sample",
                  sourceBatchId: form.sourceBatchId || `${form.kind}-001`,
                  identityColumn: "source_row_id",
                  amountUnit: "naira",
                });
            }}
          >
            Use sample
          </Button>
        </div>
        <label className="block space-y-2 text-sm font-medium">
          CSV content
          <textarea
            className={`${pilotField} min-h-40 font-mono text-xs`}
            value={form.csv}
            disabled={locked || denied}
            required
            onChange={(e) => set("csv", e.target.value)}
          />
        </label>
        {fileError && (
          <p role="alert" className="text-sm text-destructive">
            {fileError}
          </p>
        )}
        {check?.columns && batch?.status !== "committed" && (
          <fieldset
            disabled={locked || denied}
            className="rounded-xl border p-4"
          >
            <legend className="px-2 text-sm font-semibold">
              Column mapping
            </legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {check.columns.map((column: string) => (
                <label className="space-y-1 text-sm" key={column}>
                  {column}
                  <select
                    className={pilotField}
                    value={
                      form.mapping[column] ??
                      (column === form.identityColumn &&
                      !["reference", "eventId"].includes(column)
                        ? ""
                        : column === "amount"
                          ? "amountKobo"
                          : column)
                    }
                    onChange={(e) =>
                      set("mapping", {
                        ...form.mapping,
                        [column]: e.target.value,
                      })
                    }
                  >
                    <option value="">
                      {column === form.identityColumn
                        ? "Source identity only"
                        : "Skip column"}
                    </option>
                    {fields.map((field) => (
                      <option key={field} value={field}>
                        {field === "amountKobo"
                          ? "Amount"
                          : readableLabel(field)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <RecoveryNotice mutation={mutation} />
        <div className="flex flex-wrap gap-3">
          {batch?.status !== "committed" && (
            <>
              <Button type="submit" busy={busy} disabled={denied || locked}>
                Save and check batch
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={
                  denied ||
                  locked ||
                  dirty ||
                  !batch ||
                  batch.status !== "ready"
                  || (batch.data.sourceQuality && batch.data.sourceQuality.status !== "checked")
                }
                onClick={() =>
                  mutation.mutate({
                    path: `/pilot/batches/${batch.id}/commit`,
                    data: { expectedUpdatedAt: batch.updatedAt },
                  })
                }
              >
                Commit checked batch
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={busy || mutation.hasUnconfirmedOutcome}
            onClick={() => {
              if (confirmDiscard()) onNew();
            }}
          >
            Start another batch
          </Button>
        </div>
        {denied && (
          <p className="text-sm text-muted-foreground">
            Importing requires Admin, Operations or Finance. Some record types
            have additional role requirements.
          </p>
        )}
      </form>
      {check && (
        <section
          className="space-y-3 border-t pt-5"
          aria-label="Saved batch results"
        >
          <h3 className="font-semibold">
            {batch.status === "committed"
              ? "Import complete"
              : dirty
                ? "Previous check · save your corrections to check again"
                : "Saved check results"}
          </h3>
          <p role="status" className="text-sm">
            {check.imported} imported · {check.skipped} already present ·{" "}
            {check.invalid} to fix · {check.valid} valid
          </p>
          {batch.data.sourceQuality && <div className="rounded-lg border p-3 text-sm space-y-2"><h4 className="font-medium">Source quality checks</h4><p>{batch.data.sourceQuality.sourceRows} source rows · {batch.data.sourceQuality.sourceAmountKobo == null ? "Source total unavailable" : formatKobo(batch.data.sourceQuality.sourceAmountKobo)} source total</p><p>{batch.data.sourceQuality.importedRows} newly imported rows · {batch.data.sourceQuality.importedAmountKobo == null ? "Imported total unavailable" : formatKobo(batch.data.sourceQuality.importedAmountKobo)} newly imported total</p>{batch.data.sourceQuality.issues.map((issue: string) => <p key={issue} className="text-destructive">{issue}</p>)}<Link href="/sources" className="text-primary underline">Review source profile and delivery schedule</Link></div>}
          {batch.status !== "committed" && (
            <p className="text-sm text-muted-foreground">
              Your source and mapping are saved. No business records are
              imported until you commit a batch with no row errors.
            </p>
          )}
          <ScrollFrame
            label="Import check results"
            className="max-h-72 overflow-auto rounded-lg border p-3 text-sm"
          >
            {check.rows.map((row: any) => (
              <p key={row.row} className="border-b py-2 last:border-0">
                <strong>
                  Row {row.row} · {readableLabel(row.status)}:{" "}
                </strong>
                {row.message}
              </p>
            ))}
          </ScrollFrame>
          {check.preview?.some((row: any) => row.amountKobo !== undefined) && (
            <div className="rounded-lg bg-secondary/30 p-3 text-sm">
              <h4 className="font-medium">Converted amounts · first rows</h4>
              {check.preview.map(
                (row: any) =>
                  row.amountKobo !== undefined && (
                    <p key={row.row}>
                      Row {row.row}: {formatKobo(row.amountKobo)}
                    </p>
                  ),
              )}
            </div>
          )}
          {!!batch.data.recordIds?.length && (
            <p className="text-sm text-muted-foreground">
              {batch.data.recordIds.length} {batch.data.recordIds.length === 1 ? 'record is' : 'records are'} linked to this batch.
              Continue in{" "}
              <Link className="text-primary underline" href="/reconciliation">
                Reconciliation
              </Link>
              .
            </p>
          )}
        </section>
      )}
      {detail.data?.revisions?.length > 0 && (
        <details>
          <summary className="cursor-pointer py-2 text-sm font-medium">
            Mapping and check history
          </summary>
          <ol className="space-y-2 text-sm text-muted-foreground">
            {detail.data.revisions.map((r: any) => (
              <li key={r.id}>
                {r.name} · {formatDate(r.createdAt)} · {r.data.actor} ·{" "}
                {r.data.valid} valid, {r.data.invalid} to fix
              </li>
            ))}
          </ol>
        </details>
      )}
    </PilotPanel>
  );
}
