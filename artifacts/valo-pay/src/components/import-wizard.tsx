import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ImportResult } from '@workspace/api-client-react';
import { useSafeImportRecords } from '@/lib/safe-mutations';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { Button } from '@/components/ui/button';
import { DiscardOriginalRequest } from '@/components/discard-original-request';
import { KEPT_IN_OPERATIONS, OpenOperations } from '@/components/pilot-ui';
import { ScrollFrame } from '@/components/scroll-frame';
import { ImportRowResults, downloadCsv, importSummary, sampleImportCsv } from '@/components/import-results';
import { saidBy } from '@/lib/notify';
import { amountUnitName, canonicalJson, csvHeader, importFieldLabel, importFieldsOf, importKindLabels, suggestImportField, suggestRowIdColumn } from '@workspace/valopay-schema';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useDialogFocusReturn } from '@/lib/focus';
import { formatMinor } from '@/lib/currencies';
import { useWorkspace } from '@/lib/workspace-context';
import { permissionReason } from '@/lib/permissions';
import { Link } from 'wouter';

/** Each kind's sample row: its source row ID and each field's value (amounts in kobo), headed by the shared labels when downloaded. */
const samples: Record<string, { rowId: string; values: Array<[string, string]> }> = {
  customers: { rowId: 'sample-customer-001', values: [['name', 'Sample customer'], ['reference', 'SAMPLE-C001'], ['consentProvenance', 'Synthetic imported consent'], ['bankName', 'Sandbox Bank'], ['accountMasked', '•••• 0001'], ['phoneMasked', '+234 ••• ••01']] },
  mandates: { rowId: 'sample-mandate-001', values: [['name', 'Sample mandate'], ['reference', 'SAMPLE-M001'], ['customerId', 'DEMO-C1001'], ['amountKobo', '5000000'], ['workflow', 'hosted_consent'], ['frequency', 'monthly'], ['activationDeadline', '2028-12-01'], ['consentEvidence', 'SYNTHETIC-CONSENT-001'], ['consentGaps', ''], ['policyId', '']] },
  'due-items': { rowId: 'sample-instalment-001', values: [['name', 'Sample instalment'], ['reference', 'SAMPLE-D001'], ['customerId', 'DEMO-C1001'], ['amountKobo', '1000000'], ['dueDate', '2028-12-01'], ['mandateId', ''], ['owner', 'lms'], ['overrideReason', '']] },
  attempts: { rowId: 'sample-attempt-001', values: [['name', 'Sample failed attempt'], ['reference', 'SAMPLE-A001'], ['customerId', 'DEMO-C1001'], ['amountKobo', '2500000'], ['dueItemId', 'DEMO-LOAN-1001'], ['number', '1'], ['failureCode', 'INSUFFICIENT_FUNDS'], ['occurredAt', '2028-12-02']] },
  observations: { rowId: 'sample-payment-001', values: [['name', 'Sample payment observation'], ['reference', 'SAMPLE-O001'], ['customerId', 'DEMO-C1001'], ['amountKobo', '2500000'], ['source', 'webhook'], ['dueItemId', 'DEMO-LOAN-1001'], ['narration', 'Synthetic payment observation']] },
};
const extraFields: Record<string, string[]> = {
  customers: ['status', 'payDay', 'consentCapturedAt'],
  mandates: ['status', 'consentGiven', 'consentCapturedAt', 'providerReference'],
  'due-items': ['status', 'policyId', 'instalmentId'],
  attempts: ['status', 'providerReference', 'debitReference'],
  observations: ['status', 'eventId', 'channel', 'occurredAt', 'providerReference', 'currency', 'payerKey'],
};
const signatureOf = (kind: string, csv: string, mapping: Record<string, string>, unit: string | undefined, rowIdColumn: string | undefined) => canonicalJson([kind, csv, mapping, kind === 'customers' ? null : unit ?? null, rowIdColumn ?? '']);
/**
 * Where each column goes: the destination the person chose, or else the row ID
 * column as the row's identity only (unless its header names the reference or
 * event ID, which it fills as well), a header that names a field of the kind as
 * that field, amount as the amount, and a recognisable header as the field it
 * suggests while no other column fills it.
 */
function columnMapping(kind: string, columns: string[], chosen: Record<string, string>, rowIdColumn: string, offered: string[]): Record<string, string> {
  const known = importFieldsOf(kind);
  const identityOnly = (header: string) => header === rowIdColumn && !['reference', 'eventId'].includes(suggestImportField(kind, header) ?? '');
  const direct = (header: string) => Object.hasOwn(chosen, header) ? chosen[header]! : identityOnly(header) ? '' : header === 'amount' ? 'amountKobo' : known.includes(header) ? header : undefined;
  const taken = new Set(columns.map(direct).filter(Boolean));
  return Object.fromEntries(columns.map(header => {
    const target = direct(header);
    if (target !== undefined) return [header, target];
    const suggestion = suggestImportField(kind, header);
    if (!suggestion || !offered.includes(suggestion) || taken.has(suggestion)) return [header, ''];
    taken.add(suggestion);
    return [header, suggestion];
  }));
}

export function ImportWizard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { workspace } = useWorkspace();
  const [kind, setKind] = useState('due-items');
  const [amountUnit, setAmountUnit] = useState<'' | 'naira' | 'kobo'>('');
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('');
  // The destinations and the row ID column the person chose; the rest follow from the file's headers.
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [rowIdChoice, setRowIdChoice] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [resultMode, setResultMode] = useState<'check' | 'commit'>('check');
  const [resultCount, setResultCount] = useState(0);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const focusResults = useRef(false);
  const [previewSignature, setPreviewSignature] = useState('');
  const [savedSignature, setSavedSignature] = useState('');
  const [fileError, setFileError] = useState('');
  const [readingFile, setReadingFile] = useState(false);
  const [session, setSession] = useState(0);
  const alive = useRef(true);
  const fileRequest = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++fileRequest.current; }; }, []);
  const fields = [...samples[kind]!.values.map(([field]) => field), ...(extraFields[kind] || [])];
  const columns = useMemo(() => csvHeader(csv), [csv]);
  const rowIdColumn = rowIdChoice && columns.includes(rowIdChoice) ? rowIdChoice : suggestRowIdColumn(columns) ?? '';
  const mapping = useMemo(() => columnMapping(kind, columns, chosen, rowIdColumn, fields), [kind, columns, chosen, rowIdColumn]);
  const signature = signatureOf(kind, csv, mapping, amountUnit, rowIdColumn);
  const unitRequired = kind !== 'customers';
  const denied = permissionReason(workspace, { kind });
  const { confirmDiscard } = useUnsavedChanges(Boolean(csv.trim()) && signature !== savedSignature);
  const doImport = useSafeImportRecords({ mutation: { onSuccess: (data, variables) => {
    if (variables.data.commit) void queryClient.invalidateQueries();
    if (!alive.current) return;
    setResult(data);
    setResultCount(count => count + 1);
    setResultMode(variables.data.commit ? 'commit' : 'check');
    focusResults.current = true;
    const sent = signatureOf(variables.data.kind, variables.data.csv, variables.data.mapping as Record<string, string> || {}, variables.data.amountUnit, variables.data.identityColumn);
    if (variables.data.commit) {
      if (data.invalid === 0) setSavedSignature(sent);
      setPreviewSignature('');
    } else setPreviewSignature(sent);
  } } }, `${merchantId}:${session}`);
  // Importing a check with warnings takes one more step: the fallbacks are named first.
  const [confirmingImport, setConfirmingImport] = useState(false);
  const restoreFocus = useDialogFocusReturn(confirmingImport);
  const busy = doImport.isPending || readingFile;
  const locked = busy || doImport.hasUnconfirmedOutcome;
  useEffect(() => {
    if (!busy && focusResults.current) {
      resultsHeading.current?.focus();
      focusResults.current = false;
    }
  }, [busy, result]);
  const resetPreview = () => { setResult(null); setPreviewSignature(''); setSavedSignature(''); doImport.reset(); setFileError(''); };
  const changeMapping = () => { setPreviewSignature(''); doImport.reset(); };
  const forget = () => { setChosen({}); setRowIdChoice(''); };
  const send = (commit: boolean) => doImport.mutate({ data: { kind, csv, mapping, identityColumn: rowIdColumn, ...(unitRequired && amountUnit ? { amountUnit } : {}), syntheticOnly: true, commit }, params: { merchantId } });
  const canCommit = !denied && !locked && result && result.valid > 0 && result.invalid === 0 && previewSignature === signature;
  const duplicates = result?.skipped ?? result?.rows.filter(row => row.status === 'duplicate').length ?? 0;
  // A preview amount is in its row's currency, naira when the row names none, as the server converts it.
  const currencyColumn = result?.columns?.find(header => mapping[header] === 'currency');
  const checkedCurrent = Boolean(previewSignature && previewSignature === signature);
  const nextStep = doImport.hasUnconfirmedOutcome ? 'Recover the previous import result before starting another.' : !csv.trim() ? '1. Choose or paste a sample CSV.' : !columns.length ? '2. Start the CSV with a header row that names each column, with every quote closed.' : !rowIdColumn ? '2. Choose the row ID column, then check the data.' : !result ? '2. Check the data to preview rows and match columns.' : !checkedCurrent && resultMode === 'check' ? '2. Check the data again after changing the mapping.' : result.invalid > 0 ? '2. Correct every row error, then check again.' : resultMode === 'commit' ? '3. Review the completed import below.' : result.valid === 0 ? '3. No new records to import.' : '3. Review the checked rows, then import.';
  const readFile = async (file?: File) => {
    if (!file) return;
    if (!confirmDiscard()) return;
    if (file.size > 1_500_000) { setFileError('Choose a CSV file no larger than 1.5 MB.'); return; }
    const request = ++fileRequest.current;
    setReadingFile(true); setFileError('');
    try {
      const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(new Error('The CSV file could not be read.')); reader.readAsText(file); });
      if (!alive.current || request !== fileRequest.current) return;
      if (new TextEncoder().encode(text).length > 1_500_000) throw new Error('Choose a CSV file no larger than 1.5 MB.');
      setCsv(text); setFilename(file.name); forget(); setAmountUnit(''); resetPreview(); setSession(value => value + 1);
    } catch (error) { if (alive.current && request === fileRequest.current) setFileError(error instanceof Error ? error.message : 'The CSV file could not be read.'); }
    finally { if (alive.current && request === fileRequest.current) setReadingFile(false); }
  };
  return <section className="space-y-5 rounded-xl border bg-card p-5 shadow-sm" aria-label="Import sample data">
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm"><strong>Need to return to an import later?</strong><p className="mt-1 text-muted-foreground">Use saved batches for versioned checks, mapping history and reviewed corrections of committed records.</p><Link href="/imports" className="mt-2 inline-block text-primary underline">Open Import batches</Link></div>
    <div><h2 className="text-lg font-semibold">Import sample data</h2><p className="mt-1 text-sm text-muted-foreground">Choose a CSV, match its columns, then check every row before importing. Synthetic records only, up to 500 rows and 1.5 MB.</p></div>
    <div className="space-y-1 rounded-lg border bg-secondary/20 p-4 text-sm"><p className="font-medium">{nextStep}</p><p className="text-muted-foreground">Checking does not save records. All new rows must pass before any are imported. Every row needs a source row ID: a row imported before with the same ID and data is skipped, and one with the same ID but different data, or with a reference another record already has, is refused.</p></div>
    <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1 text-sm font-medium">Import as<select aria-label="Import as" className="block w-full rounded-md border bg-background p-2" value={kind} disabled={locked} onChange={event => { if (!confirmDiscard()) return; setKind(event.target.value); setAmountUnit(''); setCsv(''); setFilename(''); forget(); resetPreview(); setSession(value => value + 1); }}>{Object.entries(importKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="space-y-1 text-sm font-medium">Choose CSV file<input aria-label="Choose CSV file" type="file" accept=".csv,text/csv" disabled={locked} className="block w-full rounded-md border bg-background p-2 text-sm" onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ''; }} /></label></div>
    {unitRequired && <div className="space-y-2 rounded-lg border bg-secondary/20 p-4"><label className="block text-sm font-medium" htmlFor="import-amount-unit">Amounts in your CSV *</label><select id="import-amount-unit" aria-describedby="import-unit-help" className="w-full rounded-md border bg-background p-2 sm:max-w-sm" value={amountUnit} disabled={locked} onChange={event => { setAmountUnit(event.target.value as typeof amountUnit); resetPreview(); }}><option value="">Choose the source unit</option><option value="naira">{amountUnitName('naira', kind)} — for example 1,000.50</option><option value="kobo">{amountUnitName('kobo', kind)} — for example 100050</option></select><p id="import-unit-help" className="text-sm text-muted-foreground">Use the unit in the source file. ₦1,000.50 equals 100050 kobo.{importFieldsOf(kind).includes('currency') ? ' A row that names another currency is read in its units, with its decimals: USD 1,000.50 is 100050 cents and JPY 1,000 is 1000.' : ''} Every amount in this import must use the same unit. {importFieldsOf(kind).includes('currency') ? 'The preview shows each converted amount in its currency.' : 'The preview shows the converted naira amount.'}</p></div>}
    <p className="text-sm text-muted-foreground">{filename ? `Loaded ${filename}. ` : ''}Or paste CSV below. <button type="button" disabled={unitRequired && !amountUnit} className="font-medium text-primary underline disabled:cursor-not-allowed disabled:opacity-50" onClick={() => downloadCsv('\uFEFF' + sampleImportCsv(kind, samples[kind]!.rowId, samples[kind]!.values, amountUnit), `synthetic-${kind}-${unitRequired ? amountUnit : 'sample'}.csv`)}>Download sample CSV</button>{unitRequired && !amountUnit ? ' after choosing the amount unit.' : ` to get started${unitRequired ? ` with amounts in ${amountUnit}` : ''}.`}</p>
    <label className="block text-sm font-medium" htmlFor="import-csv">CSV content</label><textarea id="import-csv" className="h-32 w-full rounded-md border bg-background p-3 font-mono text-xs" disabled={locked} value={csv} placeholder="Paste CSV content from the sample file…" onChange={event => { setCsv(event.target.value); setFilename(''); resetPreview(); }} />
    {columns.length > 0 && <fieldset className="space-y-3 rounded-lg border p-4"><legend className="px-2 text-sm font-semibold">Match columns</legend>
      <div className="space-y-1"><label className="block text-sm font-medium" htmlFor="import-row-id">Row ID column *</label><select id="import-row-id" aria-describedby="import-row-id-help" className="block w-full rounded-md border bg-background p-2 sm:max-w-sm" disabled={locked} value={rowIdColumn} onChange={event => { setRowIdChoice(event.target.value); changeMapping(); }}><option value="">Choose the row ID column</option>{columns.map(header => <option key={header} value={header}>{header}</option>)}</select><p id="import-row-id-help" className="text-sm text-muted-foreground">The column with each row's ID in your source: a different, non-empty value on every row, up to 160 characters, that stays the same when you import the row again.</p></div>
      <p className="text-sm text-muted-foreground">Each destination can be used once. Destinations already matched to another column are unavailable. Skip columns you do not need, then check the data again.</p><div className="grid gap-3 sm:grid-cols-2">{columns.map(header => {
        const value = mapping[header] || '', options = value && !fields.includes(value) ? [...fields, value] : fields;
        return <label key={header} className="text-sm">{header}<select aria-label={`Map ${header}`} className="mt-1 block w-full rounded-md border bg-background p-2" disabled={locked} value={value} onChange={event => { setChosen(previous => ({ ...previous, [header]: event.target.value })); changeMapping(); }}><option value="">{header === rowIdColumn ? 'Row ID only' : 'Skip column'}</option>{options.map(field => <option key={field} value={field} disabled={value !== field && Object.values(mapping).includes(field)}>{importFieldLabel(kind, field)}</option>)}</select></label>;
      })}</div></fieldset>}
    {result?.preview && result.preview.length > 0 && <div className="space-y-2"><h3 className="text-sm font-semibold">Parsed preview · first {result.preview.length} {result.preview.length === 1 ? 'row' : 'rows'}</h3><ScrollFrame label="CSV preview" className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2" scope="col">Row</th>{result.columns?.map(header => <th key={header} className="p-2" scope="col">{mapping[header] ? importFieldLabel(kind, mapping[header]!) : header === rowIdColumn ? `${header} (row ID)` : `${header} (skipped)`}</th>)}{unitRequired && <th className="p-2" scope="col">Amount to import</th>}</tr></thead><tbody>{result.preview.map(row => <tr key={row.row} className="border-t"><td className="p-2">{row.row}</td>{result.columns?.map(header => <td key={header} className="max-w-60 break-words p-2">{String(row.values[header] ?? '')}</td>)}{unitRequired && <td className="whitespace-nowrap p-2 font-medium">{previewSignature === signature && row.amountKobo !== undefined ? formatMinor(row.amountKobo, String((currencyColumn && row.values[currencyColumn]) || 'NGN')) : 'Check data'}</td>}</tr>)}</tbody></table></ScrollFrame><p className="text-xs text-muted-foreground">{unitRequired && amountUnit ? `Source amounts: ${amountUnitName(amountUnit, kind)}. ` : ''}The check covers every row, including those outside this preview. Quoted commas and line breaks are kept together.</p></div>}
    {fileError && <p role="alert" className="text-sm text-destructive">{fileError}</p>}
    {doImport.hasUnconfirmedOutcome ? <div role="alert" className="space-y-2 rounded-lg border border-warning-border bg-warning/20 p-4 text-sm"><p className="font-semibold">Import outcome not confirmed</p><p>The request may have finished. Retry the same import to recover its result without creating another batch. {KEPT_IN_OPERATIONS} Unsaved changes and requests that never reached the service cannot be recovered.</p><p>{saidBy(doImport.error, 'Check your connection, then retry the same import.')}</p><div className="flex flex-wrap items-center gap-3"><Button variant="outline" busy={doImport.isPending} busyLabel="Recovering import…" onClick={() => { void doImport.retryUnconfirmed().catch(() => {}); }}>Retry same import</Button><OpenOperations /><DiscardOriginalRequest disabled={doImport.isPending} onDiscard={doImport.abandonUnconfirmed} /></div></div> : doImport.error && <p role="alert" className="text-sm text-destructive">{doImport.variables?.data.commit ? 'The import was refused.' : 'The data could not be checked.'} {saidBy(doImport.error, 'Your CSV is still here. Check your connection and try again.')}</p>}
    {denied && <p role="status" className="text-sm text-muted-foreground">{denied}</p>}
    {columns.length > 0 && !rowIdColumn && <p className="text-sm text-muted-foreground">Choose the row ID column under Match columns before checking: every row needs a source row ID.</p>}
    <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => send(false)} disabled={Boolean(denied) || locked || !csv.trim() || !rowIdColumn || (unitRequired && !amountUnit)} busy={doImport.isPending && !doImport.variables?.data.commit} busyLabel="Checking data…">Check data</Button><Button onClick={() => { if (result?.warnings?.length) setConfirmingImport(true); else send(true); }} disabled={!canCommit} busy={doImport.isPending && Boolean(doImport.variables?.data.commit)} busyLabel="Importing data…">Import data</Button><Button variant="ghost" disabled={locked || !csv} onClick={() => { if (!confirmDiscard()) return; setAmountUnit(''); setCsv(''); setFilename(''); forget(); resetPreview(); setSession(value => value + 1); }}>Clear import</Button></div>
    {result && <section className="space-y-3 border-t pt-4" aria-labelledby="import-results-heading"><h3 id="import-results-heading" ref={resultsHeading} tabIndex={-1} className="font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{resultMode === 'commit' ? 'Import results' : 'Check results'}</h3><p role="status" className="text-sm">{importSummary(result)}</p>{resultMode === 'check' && <p className="text-sm text-muted-foreground">This was a check only. No records were saved.</p>}{!!result.warnings?.length && <div className="space-y-2 rounded-lg border border-warning-border bg-warning/20 p-3 text-sm"><h4 className="font-medium">{resultMode === 'commit' ? 'Imported with fallback values' : 'Check before you import'}</h4>{result.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}{result.invalid > 0 ? <p className="text-sm">Nothing is imported while any row has an error. Correct the CSV or its mapping and check again.</p> : result.valid === 0 && duplicates > 0 ? <p className="text-sm">All rows already exist. There is nothing new to import; existing records have not been changed.</p> : checkedCurrent ? <p className="text-sm">Checked and ready. Review the preview, then select Import data.</p> : resultMode === 'commit' ? <p className="text-sm">Import complete. The record lists are being refreshed. Rows already imported did not change existing records.</p> : <p className="text-sm">Check the data again after matching or changing columns.</p>}<ImportRowResults key={resultCount} rows={result.rows} label="Import row results" filename={`synthetic-${kind}-errors.csv`} onCorrect={() => document.getElementById('import-csv')?.focus()} className="max-h-48 overflow-auto rounded-md bg-secondary/20 p-3 text-xs" /></section>}
    <Dialog open={confirmingImport} onOpenChange={open => { if (!open) setConfirmingImport(false); }}><DialogContent onCloseAutoFocus={restoreFocus}><DialogHeader><DialogTitle>Import with fallback values?</DialogTitle><DialogDescription>The check found values that would be saved from a fallback rather than from the file.</DialogDescription></DialogHeader><div className="space-y-2 text-sm">{result?.warnings?.map(warning => <p key={warning}>{warning}</p>)}<p>Imported records keep these values until they are edited.</p></div><DialogFooter><Button variant="outline" onClick={() => setConfirmingImport(false)}>Review the columns</Button><Button onClick={() => { setConfirmingImport(false); send(true); }}>Import anyway</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
