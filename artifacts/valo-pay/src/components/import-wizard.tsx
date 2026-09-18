import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ImportResult } from '@workspace/api-client-react';
import { useSafeImportRecords } from '@/lib/safe-mutations';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { Button } from '@/components/ui/button';
import { ScrollFrame } from '@/components/scroll-frame';
import { readableLabel } from '@/components/record-label';
import { saidBy } from '@/lib/notify';
import { koboToNaira } from '@workspace/valopay-schema';
import { formatKobo } from '@/lib/formatters';
import { useWorkspace } from '@/lib/workspace-context';
import { permissionReason } from '@/lib/permissions';

const samples: Record<string, string> = {
  customers: 'name,reference,consentProvenance,bankName,accountMasked,phoneMasked\nSample customer,SAMPLE-C001,Synthetic imported consent,Sandbox Bank,•••• 0001,+234 ••• ••01',
  mandates: 'name,reference,customerId,amountKobo,workflow,frequency,activationDeadline,consentEvidence,consentGaps,policyId\nSample mandate,SAMPLE-M001,DEMO-C1001,5000000,hosted_consent,monthly,2028-12-01,SYNTHETIC-CONSENT-001,,',
  'due-items': 'name,reference,customerId,amountKobo,dueDate,mandateId,owner,overrideReason\nSample instalment,SAMPLE-D001,DEMO-C1001,1000000,2028-12-01,,lms,',
  attempts: 'name,reference,customerId,amountKobo,dueItemId,number,failureCode,occurredAt\nSample failed attempt,SAMPLE-A001,DEMO-C1001,2500000,DEMO-LOAN-1001,1,INSUFFICIENT_FUNDS,2028-12-02',
  observations: 'name,reference,customerId,amountKobo,source,dueItemId,narration\nSample payment observation,SAMPLE-O001,DEMO-C1001,2500000,webhook,DEMO-LOAN-1001,Synthetic payment observation',
};
const extraFields: Record<string, string[]> = {
  customers: ['status', 'payDay', 'consentCapturedAt'],
  mandates: ['status', 'consentGiven', 'consentCapturedAt', 'providerReference'],
  'due-items': ['status', 'policyId', 'instalmentId'],
  attempts: ['status', 'providerReference', 'debitReference'],
  observations: ['status', 'eventId', 'channel', 'occurredAt', 'providerReference', 'currency', 'payerKey'],
};
const kindLabels: Record<string, string> = { customers: 'Customers', mandates: 'Mandates', 'due-items': 'Instalments', attempts: 'Collection attempts', observations: 'Payment evidence' };
const fieldLabel = (field: string) => ({ amountKobo: 'Amount', customerId: 'Customer reference or ID', dueItemId: 'Instalment reference or ID', mandateId: 'Mandate reference or ID' }[field] || readableLabel(field));
const signatureOf = (kind: string, csv: string, mapping: Record<string, string>, unit?: string) => JSON.stringify([kind, csv, Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b)), kind === 'customers' ? null : unit]);
function sampleCsv(kind: string, unit: string) {
  if (kind === 'customers') return samples[kind]!;
  const [header, line] = samples[kind]!.split('\n');
  const columns = header!.split(','), values = line!.split(',');
  const index = columns.indexOf('amountKobo');
  columns[index] = 'amount';
  if (unit === 'naira') values[index] = koboToNaira(Number(values[index]));
  return `${columns.join(',')}\n${values.join(',')}`;
}

/** Escape CSV cells and neutralise spreadsheet formula prefixes, including leading whitespace. */
export function safeCsvCell(value: unknown): string {
  const text = String(value ?? '');
  const safe = /^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function importErrorCsv(rows: ImportResult['rows']): string {
  return '\uFEFF' + [['Row', 'Status', 'What to fix'], ...rows.filter(row => row.status === 'invalid').map(row => [row.row, row.status, row.message])].map(row => row.map(safeCsvCell).join(',')).join('\r\n');
}
function downloadCsv(contents: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}

export function ImportWizard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { workspace } = useWorkspace();
  const [kind, setKind] = useState('due-items');
  const [amountUnit, setAmountUnit] = useState<'' | 'naira' | 'kobo'>('');
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [previewSignature, setPreviewSignature] = useState('');
  const [savedSignature, setSavedSignature] = useState('');
  const [fileError, setFileError] = useState('');
  const [readingFile, setReadingFile] = useState(false);
  const [session, setSession] = useState(0);
  const alive = useRef(true);
  const fileRequest = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++fileRequest.current; }; }, []);
  const signature = signatureOf(kind, csv, mapping, amountUnit);
  const unitRequired = kind !== 'customers';
  const denied = permissionReason(workspace, { kind });
  const { confirmDiscard } = useUnsavedChanges(Boolean(csv.trim()) && signature !== savedSignature);
  const fields = [...samples[kind]!.split('\n')[0]!.split(','), ...(extraFields[kind] || [])];
  const doImport = useSafeImportRecords({ mutation: { onSuccess: (data, variables) => {
    if (variables.data.commit) void queryClient.invalidateQueries();
    if (!alive.current) return;
    setResult(data);
    if (variables.data.commit) {
      if (data.invalid === 0) setSavedSignature(signatureOf(variables.data.kind, variables.data.csv, variables.data.mapping as Record<string, string> || {}, variables.data.amountUnit));
      setPreviewSignature('');
    } else {
      const submitted = variables.data.mapping as Record<string, string> || {};
      const defaultTarget = (header: string) => header === 'amount' ? 'amountKobo' : fields.includes(header) ? header : '';
      const chosen = Object.fromEntries((data.columns || Object.keys(submitted)).map(header => [header, Object.hasOwn(submitted, header) ? submitted[header]! : defaultTarget(header)]));
      setMapping(chosen);
      const changed = Object.entries(chosen).some(([header, destination]) => destination !== (Object.hasOwn(submitted, header) ? submitted[header] : header === 'amount' ? 'amountKobo' : header));
      setPreviewSignature(changed ? '' : signatureOf(variables.data.kind, variables.data.csv, chosen, variables.data.amountUnit));
    }
  } } }, `${merchantId}:${session}`);
  const busy = doImport.isPending || readingFile;
  const resetPreview = () => { setResult(null); setPreviewSignature(''); setSavedSignature(''); doImport.reset(); setFileError(''); };
  const check = () => doImport.mutate({ data: { kind, csv, mapping, ...(unitRequired && amountUnit ? { amountUnit } : {}), syntheticOnly: true, commit: false }, params: { merchantId } });
  const commit = () => doImport.mutate({ data: { kind, csv, mapping, ...(unitRequired && amountUnit ? { amountUnit } : {}), syntheticOnly: true, commit: true }, params: { merchantId } });
  const canCommit = !denied && !busy && result && result.valid > 0 && result.invalid === 0 && previewSignature === signature;
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
      setCsv(text); setFilename(file.name); setMapping({}); setAmountUnit(''); resetPreview(); setSession(value => value + 1);
    } catch (error) { if (alive.current && request === fileRequest.current) setFileError(error instanceof Error ? error.message : 'The CSV file could not be read.'); }
    finally { if (alive.current && request === fileRequest.current) setReadingFile(false); }
  };
  return <section className="space-y-5 rounded-xl border bg-card p-5 shadow-sm" aria-label="Import sample data">
    <div><h2 className="text-lg font-semibold">Import sample data</h2><p className="mt-1 text-sm text-muted-foreground">Choose a CSV, match its columns, then check every row before importing. Synthetic records only, up to 500 rows and 1.5 MB.</p></div>
    <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1 text-sm font-medium">Import as<select aria-label="Import as" className="block w-full rounded-md border bg-background p-2" value={kind} disabled={busy} onChange={event => { if (!confirmDiscard()) return; setKind(event.target.value); setAmountUnit(''); setCsv(''); setFilename(''); setMapping({}); resetPreview(); setSession(value => value + 1); }}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="space-y-1 text-sm font-medium">Choose CSV file<input aria-label="Choose CSV file" type="file" accept=".csv,text/csv" disabled={busy} className="block w-full rounded-md border bg-background p-2 text-sm" onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ''; }} /></label></div>
    {unitRequired && <div className="space-y-2 rounded-lg border bg-secondary/20 p-4"><label className="block text-sm font-medium" htmlFor="import-amount-unit">Amounts in your CSV *</label><select id="import-amount-unit" aria-describedby="import-unit-help" className="w-full rounded-md border bg-background p-2 sm:max-w-sm" value={amountUnit} disabled={busy} onChange={event => { setAmountUnit(event.target.value as typeof amountUnit); resetPreview(); }}><option value="">Choose the source unit</option><option value="naira">Naira (₦) — for example 1,000.50</option><option value="kobo">Kobo — for example 100050</option></select><p id="import-unit-help" className="text-sm text-muted-foreground">Use the unit in the source file. ₦1,000.50 equals 100050 kobo. Every amount in this import must use the same unit. The preview shows the converted naira amount.</p></div>}
    <p className="text-sm text-muted-foreground">{filename ? `Loaded ${filename}. ` : ''}Or paste CSV below. <button type="button" disabled={unitRequired && !amountUnit} className="font-medium text-primary underline disabled:cursor-not-allowed disabled:opacity-50" onClick={() => downloadCsv('\uFEFF' + sampleCsv(kind, amountUnit), `synthetic-${kind}-${unitRequired ? amountUnit : 'sample'}.csv`)}>Download sample CSV</button>{unitRequired && !amountUnit ? ' after choosing the amount unit.' : ` to get started${unitRequired ? ` with amounts in ${amountUnit}` : ''}.`}</p>
    <label className="block text-sm font-medium" htmlFor="import-csv">CSV content</label><textarea id="import-csv" className="h-32 w-full rounded-md border bg-background p-3 font-mono text-xs" disabled={busy} value={csv} placeholder="Paste CSV content from the sample file…" onChange={event => { setCsv(event.target.value); setFilename(''); setMapping({}); resetPreview(); }} />
    {result?.columns && <fieldset className="space-y-3 rounded-lg border p-4"><legend className="px-2 text-sm font-semibold">Match columns</legend><p className="text-sm text-muted-foreground">Each destination can be used once. Skip columns you do not need, then check the data again.</p><div className="grid gap-3 sm:grid-cols-2">{result.columns.map(header => <label key={header} className="text-sm">{header}<select aria-label={`Map ${header}`} className="mt-1 block w-full rounded-md border bg-background p-2" disabled={busy} value={mapping[header] || ''} onChange={event => { setMapping(previous => ({ ...previous, [header]: event.target.value })); setPreviewSignature(''); doImport.reset(); }}><option value="">Skip column</option>{fields.map(field => <option key={field} value={field}>{fieldLabel(field)}</option>)}</select></label>)}</div></fieldset>}
    {result?.preview && result.preview.length > 0 && <div className="space-y-2"><h3 className="text-sm font-semibold">Parsed preview · first {result.preview.length} {result.preview.length === 1 ? 'row' : 'rows'}</h3><ScrollFrame label="CSV preview" className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2" scope="col">Row</th>{result.columns?.map(header => <th key={header} className="p-2" scope="col">{mapping[header] ? fieldLabel(mapping[header]!) : `${header} (skipped)`}</th>)}{unitRequired && <th className="p-2" scope="col">Amount to import (₦)</th>}</tr></thead><tbody>{result.preview.map(row => <tr key={row.row} className="border-t"><td className="p-2">{row.row}</td>{result.columns?.map(header => <td key={header} className="max-w-60 break-words p-2">{String(row.values[header] ?? '')}</td>)}{unitRequired && <td className="whitespace-nowrap p-2 font-medium">{previewSignature === signature && row.amountKobo !== undefined ? formatKobo(row.amountKobo) : 'Check data'}</td>}</tr>)}</tbody></table></ScrollFrame><p className="text-xs text-muted-foreground">{unitRequired ? `Source amounts: ${amountUnit}. ` : ''}The check covers every row, including those outside this preview. Quoted commas and line breaks are kept together.</p></div>}
    {fileError && <p role="alert" className="text-sm text-destructive">{fileError}</p>}
    {doImport.error && <p role="alert" className="text-sm text-destructive">The import request failed. {saidBy(doImport.error, 'Check your connection and try again.')}</p>}
    {denied && <p role="status" className="text-sm text-muted-foreground">{denied}</p>}
    <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={check} disabled={Boolean(denied) || busy || !csv.trim() || (unitRequired && !amountUnit)} busy={doImport.isPending && !doImport.variables?.data.commit} busyLabel="Checking data…">Check data</Button><Button onClick={commit} disabled={!canCommit} busy={doImport.isPending && Boolean(doImport.variables?.data.commit)} busyLabel="Importing data…">Import data</Button><Button variant="ghost" disabled={busy || !csv} onClick={() => { if (!confirmDiscard()) return; setAmountUnit(''); setCsv(''); setFilename(''); setMapping({}); resetPreview(); setSession(value => value + 1); }}>Clear import</Button></div>
    {result && <div className="space-y-3 border-t pt-4"><h3 className="font-semibold">Import results</h3><p role="status" className="text-sm">{result.imported} imported · {result.skipped ?? result.rows.filter(row => row.status === 'duplicate').length} skipped as duplicates · {result.invalid} rows to fix · {result.valid} valid rows</p>{result.invalid > 0 ? <p className="text-sm">Nothing is imported while any row has an error. Correct the CSV or its mapping and check again.</p> : previewSignature && previewSignature === signature ? <p className="text-sm">Checked and ready. Review the preview, then select Import data.</p> : result.imported > 0 ? <p className="text-sm">Import complete. Your collection records have been refreshed.</p> : <p className="text-sm">Check the data again after matching or changing columns.</p>}{result.invalid > 0 && <Button variant="outline" size="sm" onClick={() => downloadCsv(importErrorCsv(result.rows), `synthetic-${kind}-errors.csv`)}>Download errors CSV</Button>}<div className="max-h-48 overflow-y-auto rounded-md bg-secondary/20 p-3 text-xs">{result.rows.map(row => <p className="py-1" key={row.row}><strong>Row {row.row} · {row.status === 'duplicate' ? 'Skipped' : readableLabel(row.status)}:</strong> {row.message}</p>)}</div></div>}
  </section>;
}
