import { useEffect, useRef, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { csvHeader, importBatchDetailSchema, importBatchListSchema, importFieldLabel, importFieldsOf, importKindLabels, sourcesViewSchema, suggestImportField, type BatchInput } from "@workspace/valopay-schema";
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
import { PageButtons } from "@/components/record-pagination";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDialogFocusReturn } from "@/lib/focus";
import { formatCount, formatDate, formatKobo, formatNumber } from "@/lib/formatters";
import { readableLabel } from "@/components/record-label";
import { ImportRowResults, importSummary, sampleImportCsv, sampleMapping } from "@/components/import-results";
import { ImportCorrections } from "@/components/import-corrections";
import { isStaleRecordError } from "@/components/form-field";

const types = importKindLabels as Record<BatchInput["kind"], string>;
/** Each kind's sample row: its source row ID and each field's value (amounts in kobo), headed by the shared labels. */
const samples: Record<BatchInput["kind"], { rowId: string; values: Array<[string, string]> }> = {
  customers: { rowId: "customer-001", values: [["name", "Pilot customer"], ["reference", "PILOT-C001"], ["consentProvenance", "Synthetic pilot consent"], ["bankName", "Sandbox Bank"], ["accountMasked", "•••• 0001"]] },
  mandates: { rowId: "mandate-001", values: [["name", "Pilot mandate"], ["reference", "PILOT-M001"], ["customerId", "PILOT-C001"], ["amountKobo", "5000000"], ["workflow", "hosted_consent"], ["frequency", "monthly"], ["activationDeadline", "2028-12-01"], ["consentEvidence", "SYNTHETIC-CONSENT-001"], ["consentGaps", ""]] },
  "due-items": { rowId: "instalment-001", values: [["name", "Pilot instalment"], ["reference", "PILOT-D001"], ["customerId", "PILOT-C001"], ["amountKobo", "2500000"], ["dueDate", "2028-12-01"], ["mandateId", ""], ["owner", "lms"], ["overrideReason", ""]] },
  attempts: { rowId: "attempt-001", values: [["name", "Pilot attempt"], ["reference", "PILOT-A001"], ["customerId", "PILOT-C001"], ["amountKobo", "2500000"], ["dueItemId", "PILOT-D001"], ["number", "1"], ["failureCode", "INSUFFICIENT_FUNDS"], ["occurredAt", "2028-12-02"]] },
  observations: { rowId: "payment-001", values: [["name", "Pilot payment"], ["reference", "PILOT-O001"], ["customerId", "PILOT-C001"], ["amountKobo", "2500000"], ["source", "statement"], ["dueItemId", "PILOT-D001"], ["narration", "PILOT-D001 synthetic transfer"]] },
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
/**
 * Where a column goes when the mapping leaves it out, as the service reads it:
 * the row identity column is only the identity unless it is the reference or
 * event ID, amount is the amount, and any other header names its own field.
 */
const defaultTarget = (column: string, identityColumn: string) =>
  column === identityColumn && !["reference", "eventId"].includes(column) ? "" : column === "amount" ? "amountKobo" : column;
/**
 * A field for each column the last check found that no mapping entry covers
 * and whose header is no field of the kind (a header that is one keeps mapping
 * to itself): full_name as the name, due_date as the due date. Each field
 * once, and never one another column already fills.
 */
function suggestedMapping(kind: string, columns: string[], mapping: Record<string, string>, identityColumn: string): Record<string, string> {
  const known = importFieldsOf(kind);
  const taken = new Set(columns.map((column) => (Object.hasOwn(mapping, column) ? mapping[column] : defaultTarget(column, identityColumn))).filter(Boolean));
  const suggested: Record<string, string> = {};
  for (const column of columns) {
    if (Object.hasOwn(mapping, column) || column === identityColumn || known.includes(defaultTarget(column, identityColumn))) continue;
    const field = suggestImportField(kind, column);
    if (field && !taken.has(field)) {
      suggested[column] = field;
      taken.add(field);
    }
  }
  return suggested;
}
const empty = (): BatchInput => ({
  name: "",
  kind: "customers",
  source: "",
  sourceBatchId: "",
  businessDate: new Date(Date.now() + 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10),
  sourceExpectationId: undefined,
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
    list = usePilotQuery(`/pilot/batches?offset=${offset}`, importBatchListSchema);
  const [selected, setSelected] = useState<string | null>(() =>
      search.get("batch"),
    ),
    [editor, setEditor] = useState(0),
    // Set by a save or commit, which may open the saved batch in a new editor: its results take focus, as the wizard's do.
    focusResults = useRef(false);
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
          initialDate={search.get("businessDate")}
          initialExpectation={search.get("expectation")}
          onSaved={(id) => setSelected(id)}
          focusResults={focusResults}
          onNew={() => {
            setSelected(null);
            setEditor((n) => n + 1);
          }}
        />
      )}
      <PilotPanel title="Saved batches">
        <PilotError
          error={list.error}
          pager="import batches"
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
        {list.data && list.data.total > 25 && (
          <div className="flex flex-wrap items-center gap-3">
            <PageButtons
              label="import batches"
              busy={list.isPlaceholderData}
              atStart={!offset}
              atEnd={offset + 25 >= list.data.total}
              onPrevious={() => setOffset((n) => Math.max(0, n - 25))}
              onNext={() => setOffset((n) => n + 25)}
              previous="Previous batches"
              next="Next batches"
            >
              <span className="text-sm">
                {formatNumber(offset + 1)}–
                {formatNumber(Math.min(offset + 25, list.data.total))} of{" "}
                {formatNumber(list.data.total)}
              </span>
            </PageButtons>
          </div>
        )}
      </PilotPanel>
      <Link
        href="/sources"
        className="inline-block text-sm text-primary underline"
      >
        Manage source schedules, mappings and totals
      </Link>
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
  initialDate,
  initialExpectation,
  onSaved,
  focusResults,
  onNew,
}: {
  id: string | null;
  initialProfile: string | null;
  initialDate: string | null;
  initialExpectation: string | null;
  onSaved(id: string): void;
  focusResults: { current: boolean };
  onNew(): void;
}) {
  const { merchantId, workspace } = useWorkspace();
  const [selectedProfile, setSelectedProfile] = useState(initialProfile || "");
  const initialProfileApplied = useRef(false);
  const detail = useQuery({
    queryKey: ["pilot", "batch", merchantId, workspace?.actor, id],
    enabled: !!id,
    queryFn: ({ signal }) =>
      pilotRequest(lenderPath(`/pilot/batches/${id}`, merchantId), importBatchDetailSchema, { signal }),
  });
  const [form, setForm] = useState<BatchInput>(() => ({
      ...empty(),
      ...(initialDate ? { businessDate: initialDate } : {}),
    })),
    [batch, setBatch] = useState<any>(null),
    [saved, setSaved] = useState(""),
    [fileError, setFileError] = useState(""),
    [reading, setReading] = useState(false),
    [suggested, setSuggested] = useState<Record<string, string>>({}),
    // The sample's mapping, kept while the CSV still has the column it maps.
    [fromSample, setFromSample] = useState<Record<string, string>>({}),
    // Committing a check with warnings takes one more step: the fallbacks are named first.
    [confirmingCommit, setConfirmingCommit] = useState(false);
  const sources = usePilotQuery(
    `/sources${form.businessDate ? `?businessDate=${encodeURIComponent(form.businessDate)}` : ""}`,
    sourcesViewSchema,
  );
  const expectationApplied = useRef(false);
  const applyExpectation = (expectation: any) => {
    setForm((current) =>
      expectation
        ? {
            ...current,
            sourceExpectationId: expectation.id,
            source: expectation.source,
            sourceBatchId: expectation.sourceBatchId,
            kind: expectation.kind,
            mapping: current.kind === expectation.kind ? current.mapping : {},
          }
        : { ...current, sourceExpectationId: undefined },
    );
    setSelectedProfile("");
  };
  useEffect(() => {
    if (
      id ||
      expectationApplied.current ||
      !sources.data ||
      !initialExpectation
    )
      return;
    expectationApplied.current = true;
    const expected = sources.data.completeness?.files.find(
      (file: any) => file.id === initialExpectation,
    );
    if (expected) applyExpectation(expected);
  }, [id, initialExpectation, sources.data]);
  const applyProfile = (profile: any) => {
    setSelectedProfile(profile?.id || "");
    if (!profile) return;
    setForm((current) => ({
      ...current,
      sourceExpectationId: undefined,
      source: profile.data.source,
      kind: profile.data.kind,
      mapping: { ...profile.data.mapping },
      amountUnit: profile.data.amountUnit,
      identityColumn: profile.data.identityColumn,
    }));
  };
  useEffect(() => {
    if (id || initialProfileApplied.current || !sources.data) return;
    initialProfileApplied.current = true;
    const profile = sources.data.profiles.find(
      (p: any) => p.id === initialProfile,
    );
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
          key === "name"
            ? record.name
            : key === "csv"
              ? record.data.csv || ""
              : record.data[key],
        ]),
      ),
      expectedUpdatedAt: record.updatedAt,
    } as BatchInput;
    // A recognisable column the saved mapping leaves unused is mapped as suggested: a change the person sees, saves or undoes.
    const suggestions =
      record.status === "committed" || !record.data.check?.columns
        ? {}
        : suggestedMapping(next.kind, record.data.check.columns, next.mapping, next.identityColumn);
    setForm({ ...next, mapping: { ...next.mapping, ...suggestions } });
    setSaved(JSON.stringify(next));
    setSuggested(suggestions);
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
    focusResults.current = true;
    hydrate(record);
    onSaved(record.id);
  });
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!batch?.data.check || !focusResults.current) return;
    focusResults.current = false;
    resultsHeading.current?.focus();
  }, [batch]);
  const busy = mutation.isPending || reading,
    locked =
      busy || mutation.hasUnconfirmedOutcome || batch?.status === "committed";
  // A save or commit refused because the batch changed (the service's "record changed after you opened it"), or a
  // refresh that shows a newer saved version, offers that version. The draft stays editable until the person chooses
  // to replace it. While a save's outcome is unconfirmed, the newer version may be that save: the recovery notice
  // handles it instead.
  const [latestProblem, setLatestProblem] = useState(""),
    [loadingLatest, setLoadingLatest] = useState(false);
  const stale =
    !!id && !mutation.hasUnconfirmedOutcome && isStaleRecordError(mutation.error);
  const newer =
    !!batch &&
    !mutation.hasUnconfirmedOutcome &&
    !!detail.data &&
    detail.data.batch.id === batch.id &&
    Date.parse(detail.data.batch.updatedAt) > Date.parse(batch.updatedAt);
  const loadLatest = async () => {
    if (busy || loadingLatest || !confirmDiscard()) return;
    setLoadingLatest(true);
    setLatestProblem("");
    try {
      // A failed refetch would otherwise resolve with the cached, older batch.
      const result = await detail.refetch({ throwOnError: true });
      if (!result.data?.batch) throw new Error("The batch was not returned.");
      hydrate(result.data.batch);
      mutation.reset();
    } catch {
      setLatestProblem(
        "The latest version could not be loaded. Your draft is still here. Try again.",
      );
    } finally {
      setLoadingLatest(false);
    }
  };
  const denied = !["Admin", "Operations", "Finance"].includes(
    workspace?.role || "",
  );
  const set = <K extends keyof BatchInput>(key: K, value: BatchInput[K]) =>
    setForm((current) => ({
      ...current,
      ...(["source", "sourceBatchId", "kind", "businessDate"].includes(key)
        ? { sourceExpectationId: undefined }
        : {}),
      [key]: value,
    }));
  const check = batch?.data.check;
  // Suggestions come from the checked columns: a changed file takes them back until its own check.
  const withoutSuggestions = (mapping: Record<string, string>) =>
    Object.fromEntries(Object.entries(mapping).filter(([column, field]) => suggested[column] !== field));
  // A sample column's mapping goes with its column, so an edited sample keeps it and another file never inherits it.
  const withoutSampleColumns = (mapping: Record<string, string>, csv: string) => {
    const columns = csvHeader(csv);
    return Object.fromEntries(Object.entries(mapping).filter(([column, field]) => fromSample[column] !== field || columns.includes(column)));
  };
  const commit = () =>
    mutation.mutate({
      path: `/pilot/batches/${batch.id}/commit`,
      data: { expectedUpdatedAt: batch.updatedAt },
    });
  const restoreFocus = useDialogFocusReturn(confirmingCommit);
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
      if (seq === fileSequence.current) {
        setForm((current) => ({
          ...current,
          csv,
          mapping: selectedProfile ? withoutSuggestions(current.mapping) : {},
          name: current.name || file.name,
        }));
        setSuggested({});
      }
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
      {batch?.data.rawCsvRemovedAt && (
        <p className="rounded-lg border bg-secondary/30 p-3 text-sm">
          The original CSV expired under this lender's retention policy on{" "}
          {formatDate(batch.data.rawCsvRemovedAt)}. Imported records, source row
          identities and saved checks remain available.
        </p>
      )}
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
        {!id && (
          <div className="space-y-2">
            <label className="block space-y-1 text-sm font-medium">
              Reusable source mapping
              <select
                className={pilotField}
                disabled={locked || denied || sources.isLoading}
                value={selectedProfile}
                onChange={(event) => {
                  if (!confirmDiscard()) return;
                  applyProfile(
                    sources.data?.profiles.find(
                      (p: any) => p.id === event.target.value,
                    ),
                  );
                }}
              >
                <option value="">Start without a saved mapping</option>
                {sources.data?.profiles.map((profile: any) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} ·{" "}
                    {types[profile.data.kind as keyof typeof types]}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              A profile fills the source, record type, row identity, units and
              column mapping. Its active expectations are checked again before
              commit.
            </p>
            {initialProfile &&
              sources.data &&
              !sources.data.profiles.some(
                (p: any) => p.id === initialProfile,
              ) && (
                <p role="alert" className="text-sm text-destructive">
                  This source profile is not available in the selected lender.
                  Choose a profile below or return to Sources.
                </p>
              )}
            <PilotError error={sources.error} />
          </div>
        )}
        <fieldset
          disabled={locked || denied}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <div className="space-y-1 text-sm font-medium">
            <label htmlFor="import-business-date">Business date (WAT)</label>
            <input
              id="import-business-date"
              aria-describedby="import-business-date-help"
              className={pilotField}
              type="date"
              required={!id || !!form.businessDate}
              disabled={!!id}
              value={form.businessDate || ""}
              onChange={(e) => set("businessDate", e.target.value)}
            />
            <p id="import-business-date-help" className="text-xs font-normal text-muted-foreground">
              The date this file belongs to, rather than its upload date. Saved
              batches keep this date.
            </p>
          </div>
          {!id && (
            <label className="space-y-1 text-sm font-medium">
              Expected source file
              <select
                className={pilotField}
                value={form.sourceExpectationId || ""}
                disabled={sources.isLoading}
                onChange={(e) => {
                  if (confirmDiscard())
                    applyExpectation(
                      sources.data?.completeness?.files.find(
                        (file: any) => file.id === e.target.value,
                      ),
                    );
                }}
              >
                <option value="">
                  Choose an expected file, or enter details below
                </option>
                {sources.data?.completeness?.files.map((file: any) => (
                  <option key={file.id} value={file.id}>
                    {file.source} · {file.sourceBatchId} ·{" "}
                    {types[file.kind as keyof typeof types]}
                  </option>
                ))}
              </select>
              <span className="block text-xs text-muted-foreground">
                Declarations for {form.businessDate || "the selected date"}.{" "}
                <Link
                  className="text-primary underline"
                  href={`/sources?businessDate=${form.businessDate || ""}`}
                >
                  Review expected files
                </Link>
              </span>
            </label>
          )}
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
                    businessDate: form.businessDate,
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
              if (!confirmDiscard()) return;
              // Headed in the operator's words, with the mapping that says so.
              const mapping = sampleMapping(form.kind, samples[form.kind].values, "source_row_id");
              setFromSample(mapping);
              setForm({
                ...form,
                csv: sampleImportCsv(form.kind, samples[form.kind].rowId, samples[form.kind].values, "naira", "source_row_id"),
                mapping,
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
            id="batch-csv"
            className={`${pilotField} min-h-40 font-mono text-xs`}
            value={form.csv}
            disabled={locked || denied}
            required
            onChange={(e) => {
              const csv = e.target.value;
              setForm((current) => ({ ...current, csv, mapping: withoutSampleColumns(withoutSuggestions(current.mapping), csv) }));
              setSuggested({});
            }}
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
              {check.columns.map((column: string) => {
                const value = form.mapping[column] ?? defaultTarget(column, form.identityColumn);
                // A field of this kind that the common list lacks, such as a suggested batch reference, is offered too.
                const options =
                  value && !fields.includes(value) && importFieldsOf(form.kind).includes(value)
                    ? [...fields, value]
                    : fields;
                return (
                  <label className="space-y-1 text-sm" key={column}>
                    {column}
                    <select
                      className={pilotField}
                      value={value}
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
                      {options.map((field) => (
                        <option key={field} value={field}>
                          {importFieldLabel(form.kind, field)}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
            {Object.keys(suggested).length > 0 && (
              <p className="mt-3 text-sm">
                Suggested from the column names:{" "}
                {Object.entries(suggested)
                  .map(([column, field]) => `${column} as ${importFieldLabel(form.kind, field)}`)
                  .join(", ")}
                . Save and check the batch to use{" "}
                {Object.keys(suggested).length === 1 ? "it" : "them"}, or
                choose another option.
              </p>
            )}
          </fieldset>
        )}
        {(stale || newer) && (
          <div
            role="status"
            className="space-y-3 rounded-lg border border-warning-border bg-warning/20 p-4 text-sm"
          >
            <p>
              {newer
                ? "A newer version of this batch was saved."
                : "This batch changed after you opened it."}{" "}
              Your draft is still here. Load the latest version to continue; it
              replaces your unsaved changes.
            </p>
            <Button
              type="button"
              variant="outline"
              busy={loadingLatest}
              busyLabel="Loading…"
              disabled={busy}
              onClick={() => {
                void loadLatest();
              }}
            >
              Load latest version
            </Button>
            {latestProblem && <p role="alert">{latestProblem}</p>}
          </div>
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
                  batch.status !== "ready" ||
                  (batch.data.sourceQuality &&
                    batch.data.sourceQuality.status !== "checked")
                }
                onClick={() => {
                  if (check?.warnings?.length) setConfirmingCommit(true);
                  else commit();
                }}
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
      {id && !form.businessDate && (
        <p className="rounded-lg border p-3 text-sm">
          This older batch has no recorded business date. It remains visible as
          unresolved source evidence; Finance must explicitly account for it
          during close review.
        </p>
      )}
      {initialExpectation &&
        sources.data &&
        !sources.data.completeness?.files.some(
          (file: any) => file.id === initialExpectation,
        ) && (
          <p role="alert" className="text-sm text-destructive">
            The linked expected file is not part of this lender’s current
            declaration for the selected date. Review Sources before saving this
            batch.
          </p>
        )}
      {check && (
        <section
          className="space-y-3 border-t pt-5"
          aria-label="Saved batch results"
        >
          <h3
            ref={resultsHeading}
            tabIndex={-1}
            className="font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {batch.status === "committed"
              ? "Import complete"
              : dirty
                ? "Previous check · save your corrections to check again"
                : "Saved check results"}
          </h3>
          <p role="status" className="text-sm">
            {importSummary(check)}
          </p>
          {!!check.warnings?.length && (
            <div className="space-y-2 rounded-lg border border-warning-border bg-warning/20 p-3 text-sm">
              <h4 className="font-medium">
                {batch.status === "committed"
                  ? "Saved with fallback values"
                  : "Check before you commit"}
              </h4>
              {check.warnings.map((warning: string) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          )}
          {batch.data.sourceQuality && (
            <div className="rounded-lg border p-3 text-sm space-y-2">
              <h4 className="font-medium">Source quality checks</h4>
              {/* Customers carry no amounts, so a customer batch has rows to count but no total to show. */}
              <p>
                {formatCount(batch.data.sourceQuality.sourceRows, "source row")}
                {batch.data.kind !== "customers" &&
                  ` · ${batch.data.sourceQuality.sourceAmountKobo == null ? "Source total unavailable" : `${formatKobo(batch.data.sourceQuality.sourceAmountKobo)} source total`}`}
              </p>
              <p>
                {formatCount(
                  batch.data.sourceQuality.importedRows,
                  "newly imported row",
                )}
                {batch.data.kind !== "customers" &&
                  ` · ${batch.data.sourceQuality.importedAmountKobo == null ? "Imported total unavailable" : `${formatKobo(batch.data.sourceQuality.importedAmountKobo)} newly imported total`}`}
              </p>
              {batch.data.sourceQuality.issues.map((issue: string) => (
                <p key={issue} className="text-destructive">
                  {issue}
                </p>
              ))}
              <Link href="/sources" className="text-primary underline">
                Review source profile and delivery schedule
              </Link>
            </div>
          )}
          {batch.status !== "committed" && (
            <p className="text-sm text-muted-foreground">
              Your source and mapping are saved. No business records are
              imported until you commit a batch with no row errors.
            </p>
          )}
          {/* The wizard's rows to fix, errors CSV and correction focus; a new check starts again from its rows to fix. */}
          <ImportRowResults
            key={batch.updatedAt}
            rows={check.rows}
            label="Import check results"
            filename={`${batch.data.sourceBatchId || batch.data.kind}-errors.csv`}
            onCorrect={locked || denied ? undefined : () => document.getElementById("batch-csv")?.focus()}
            className="max-h-72 overflow-auto rounded-lg border p-3 text-sm"
          />
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
              {formatNumber(batch.data.recordIds.length)}{" "}
              {batch.data.recordIds.length === 1 ? "record is" : "records are"}{" "}
              linked to this batch. Continue in{" "}
              <Link className="text-primary underline" href="/reconciliation">
                Reconciliation
              </Link>
              .
            </p>
          )}
        </section>
      )}
      {detail.data && detail.data.revisions.length > 0 && (
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
      {batch?.status === "committed" && (
        <ImportCorrections batchId={batch.id} />
      )}
      <Dialog
        open={confirmingCommit}
        onOpenChange={(open) => {
          if (!open) setConfirmingCommit(false);
        }}
      >
        <DialogContent onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>Commit with fallback values?</DialogTitle>
            <DialogDescription>
              The check found values that would be saved from a fallback
              rather than from the file.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {check?.warnings?.map((warning: string) => (
              <p key={warning}>{warning}</p>
            ))}
            <p>
              Committed records keep these values until a reviewed correction
              changes them.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingCommit(false)}>
              Review the mapping
            </Button>
            <Button
              onClick={() => {
                setConfirmingCommit(false);
                commit();
              }}
            >
              Commit anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PilotPanel>
  );
}
