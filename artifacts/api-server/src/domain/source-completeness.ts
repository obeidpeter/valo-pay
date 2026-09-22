import { createHash } from "node:crypto";
import { sourceManifestInputSchema, businessDateSchema, sourceBatchQualitySchema, type SourceManifestInput } from "@workspace/valopay-schema";
import type { Context, DomainState, ValopayRecord } from "./types";
import { makeRecord } from "./records";
import { assertRecordVersion } from "../lib/edit-versions";

const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const refuse = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
/** Dates refer to the source's business day, never its arrival or upload time. */
export const watBusinessDate = (iso: string) => new Date(Date.parse(iso) + 3600000).toISOString().slice(0, 10);
const identity = (file: {source: string; kind: string; sourceBatchId: string}) => [file.source, file.kind, file.sourceBatchId];
export const sourceFileId = (businessDate: string, file: {source: string; kind: string; sourceBatchId: string}) => hash([businessDate, ...identity(file)]);
export function latestSourceManifest(state: DomainState, businessDate: string) { return state.records.filter(r => r.kind === "source-manifests" && r.data.businessDate === businessDate).sort((a,b) => Number(b.data.revision)-Number(a.data.revision))[0]; }
export function saveSourceManifest(state: DomainState, ctx: Context, raw: SourceManifestInput) {
  if (!["Admin", "Operations", "Finance"].includes(ctx.role)) refuse("Your role cannot declare source expectations.", 403);
  const input = sourceManifestInputSchema.parse(raw), previous = latestSourceManifest(state, input.businessDate);
  if (previous) { if (previous.id !== input.previousManifestId || !input.expectedUpdatedAt) refuse("The source declaration changed. Refresh before saving a revision.", 409); assertRecordVersion(previous, input.expectedUpdatedAt); }
  else if (input.previousManifestId || input.expectedUpdatedAt) refuse("The previous source declaration was not found in this lender and date.", 409);
  const files = input.files.map(file => ({ ...file, id: sourceFileId(input.businessDate, file) }));
  if (new Set(files.map(file => file.id)).size !== files.length) refuse("Declare each source file once for this business date.");
  for (const file of files) {
    if (file.kind === "customers" && file.expectedAmountKobo !== 0) refuse("Customer files have no financial amount. Declare a total of zero.");
    if (state.records.some(r => r.kind === "source-manifests" && r.data.businessDate !== input.businessDate && r.data.files?.some((other: any) => canonical(identity(other)) === canonical(identity(file))))) refuse("This source batch ID is already declared for another business date. Use the original date or a different source batch ID.", 409);
    const batch = state.records.find(r => r.kind === "import-batches" && canonical(identity(r.data as any)) === canonical(identity(file)));
    if (batch?.data.businessDate && batch.data.businessDate !== input.businessDate) refuse("A saved source file belongs to another business date. Its arrival time cannot reassign it.", 409);
  }
  return makeRecord(state, "source-manifests", { name: `Expected source files · ${input.businessDate}`, status: "declared", createdAt: ctx.now, data: { businessDate: input.businessDate, timezone: "Africa/Lagos", files, noFilesExpected: input.noFilesExpected, reason: input.reason, evidence: input.evidence, revision: Number(previous?.data.revision || 0)+1, previousManifestId: previous?.id || null, declaredBy: ctx.actor, declaredAt: ctx.now, synthetic: true } });
}
/** Optional slot selection is checked against the lender's current declaration. */
export function assertSourceExpectation(state: DomainState, input: { businessDate?: string; sourceExpectationId?: string; source: string; sourceBatchId: string; kind: string }) {
  if (input.sourceExpectationId && (!input.businessDate || !latestSourceManifest(state, input.businessDate)?.data.files?.some((file: any) => file.id === input.sourceExpectationId && file.id === sourceFileId(input.businessDate!, input)))) refuse("The selected expected file no longer matches this lender, business date or source batch. Refresh the source declaration.", 409);
  for (const manifest of state.records.filter(r => r.kind === "source-manifests")) if (manifest.data.businessDate !== input.businessDate && manifest.data.files?.some((file: any) => canonical(identity(file)) === canonical(identity(input)))) refuse("This source batch is declared for a different business date. Select that date before saving.", 409);
}
export interface SourceCompletenessIssue { id: string; label: string; detail: string; }
/** Original committed totals remain authoritative after raw-file retention or an approved correction. */
export function sourceCompleteness(state: DomainState, rawDate: string) {
  const businessDate = businessDateSchema.parse(rawDate), manifest = latestSourceManifest(state, businessDate), issues: SourceCompletenessIssue[] = [];
  const add = (id: string, label: string, detail: string) => issues.push({ id: `source:${id}`, label, detail });
  if (!manifest) add("declaration", "Expected source files have not been declared", "Declare the files and control totals for this business date. No declaration does not establish a complete source set.");
  else if (manifest.data.noFilesExpected) add("excluded", "No source files expected for this date", "Finance must independently accept this exclusion and record supporting evidence. Existing synthetic records alone do not prove source completeness.");
  const files = (manifest?.data.files || []).map((file: any) => {
    const batch = state.records.find(r => r.kind === "import-batches" && canonical(identity(r.data as any)) === canonical(identity(file))), problems: string[] = [];
    const quality = batch?.status === "committed" ? sourceBatchQualitySchema.safeParse(batch.data.sourceQuality) : undefined;
    if (!batch) problems.push("The expected file has not been saved.");
    else {
      if (batch.data.businessDate !== businessDate) problems.push(batch.data.businessDate ? `This file is assigned to ${batch.data.businessDate}, not this business date.` : "This older batch has no declared business date. Its upload time cannot establish the covered date.");
      if (batch.data.sourceExpectationId && batch.data.sourceExpectationId !== file.id) problems.push("The saved expectation link does not match this file declaration.");
      if (batch.status !== "committed") problems.push("The source file has not been committed.");
      else if (!quality?.success) problems.push("The original committed source totals are unavailable.");
      else {
        if (quality.data.status !== "checked") problems.push("The committed source checks still need review.");
        if (quality.data.sourceRows !== file.expectedRows) problems.push(`Declared ${file.expectedRows} rows; received ${quality.data.sourceRows}.`);
        if (quality.data.sourceAmountKobo !== file.expectedAmountKobo) problems.push(`Declared ${file.expectedAmountKobo} kobo; received ${quality.data.sourceAmountKobo ?? "an unavailable total"}.`);
        if (quality.data.invalidRows || quality.data.conflictRows) problems.push("Invalid or conflicting source rows remain.");
      }
    }
    if (problems.length) add(file.id, `Source file incomplete · ${file.sourceBatchId}`, problems.join(" "));
    return { ...file, batchId: batch?.id || null, batchStatus: batch?.status || "missing", businessDate: batch?.data.businessDate || null, receivedRows: quality?.success ? quality.data.sourceRows : null, receivedAmountKobo: quality?.success ? quality.data.sourceAmountKobo : null, status: problems.length ? "incomplete" : "complete", problems };
  });
  const activeProfiles = state.records.filter(r => r.kind === "source-profiles" && r.status === "active").map(r => ({id:r.id,source:r.data.source,kind:r.data.kind}));
  for (const profile of activeProfiles) if (!files.some((file:any) => file.source === profile.source && file.kind === profile.kind)) add(`profile:${profile.id}`, `No expected file for ${profile.source}`, "This active source profile has no file in the business-date declaration. Declare it or explicitly accept its exclusion with Finance evidence.");
  const undeclared = state.records.filter(r => r.kind === "import-batches" && r.data.businessDate === businessDate && !files.some((file:any) => canonical(identity(file)) === canonical(identity(r.data as any)))).map(r => ({id:r.id,name:r.name,status:r.status,source:r.data.source,sourceBatchId:r.data.sourceBatchId,kind:r.data.kind}));
  for (const batch of undeclared) add(`batch:${batch.id}`, `Undeclared source file · ${batch.sourceBatchId}`, "This dated source batch is outside the declared file set. Reconcile the declaration with the original source evidence.");
  const basis = { businessDate, manifest: manifest ? {id:manifest.id,updatedAt:manifest.updatedAt,data:manifest.data} : null, files, activeProfiles:activeProfiles.sort((a,b)=>a.id.localeCompare(b.id)), undeclared:undeclared.sort((a,b)=>a.id.localeCompare(b.id)) };
  return { ...basis, status: issues.length ? "incomplete" : "complete", issues, basisDigest: hash(basis), expectedFiles: files.length, completeFiles: files.filter((file:any)=>file.status === "complete").length };
}
