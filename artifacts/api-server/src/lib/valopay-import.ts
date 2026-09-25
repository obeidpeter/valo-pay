import { parse } from "csv-parse/sync";
import { canonicalDigest } from './digests';
import { makeRecord, validateRecord } from "../domain";
import type { Context, DomainState } from "../domain/types";
import { counted, csvAmountToKobo, defaultStatus, importBooleanFields, importFieldsOf, importKinds as sharedImportKinds, importNumericFields, suggestImportField } from "@workspace/valopay-schema";

const importKinds:readonly string[]=sharedImportKinds;
const topFields=new Set(["name","status","reference","amountKobo","customerId"]);
const numeric=importNumericFields;
const boolean=importBooleanFields;
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
const unsafeKey = (key: string) => ["__proto__", "constructor", "prototype"].includes(key);
/**
 * A warning for each displayed value that fell back while a column went unused: a name taken from the reference
 * (or the row number) and a generated reference. A column is unused when it is skipped or names no field of the
 * kind, so the importer keeps it only as extra detail that nothing reads; the row identity column is metadata.
 * Without an unused column a fallback is taken as intended: the source simply has no such value.
 */
function fallbackWarnings(kind: string, columns: string[], targets: string[], identityColumn: string | undefined, fallbacks: { name: number; reference: number }): string[] {
  const fields = new Set(importFieldsOf(kind));
  const unused = columns.filter((column, index) => targets[index] ? !fields.has(targets[index]!) : column !== identityColumn);
  if (!unused.length) return [];
  const warnings: string[] = [];
  for (const field of ["name", "reference"] as const) {
    const rows = fallbacks[field], one = rows === 1, label = field === "name" ? "Name" : "Reference";
    if (!rows) continue;
    const fallback = field === "name"
      ? targets.includes(field) ? `${one ? "its name is" : "their names are"} taken from ${one ? "its reference (or its row number" : "their references (or their row numbers"} without one)` : "each record's name is taken from its reference (or its row number without one)"
      : targets.includes(field) ? `${one ? "it gets a generated reference" : "they get generated references"}` : "each record gets a generated reference";
    const what = targets.includes(field) ? `${label} is blank on ${counted(rows, "row")}, so ${fallback}.` : `No column is mapped to ${label}, so ${fallback}.`;
    const list = unused.map((column) => suggestImportField(kind, column) === field ? `${column}, which looks like the ${field}` : column).join("; ");
    warnings.push(`${what} Not mapped to a field: ${list}. Map the column that holds the ${field}, or commit knowing the fallback is saved.`);
  }
  return warnings;
}
export function importCsv(state:DomainState,ctx:Context,input:{kind:string;csv:string;syntheticOnly:boolean;commit:boolean;mapping?:Record<string,unknown>;amountUnit?:'naira'|'kobo'; identityColumn?: string; identities?: { source: string; batchId: string; ids: string[] }}){
  if(!input.syntheticOnly)fail("Pre-data gate is closed. Only synthetic sample records are accepted.",403);
  if(!importKinds.includes(input.kind))fail("This resource does not support CSV import.");
  const amountUnit = input.amountUnit ?? 'kobo';
  if (!['naira', 'kobo'].includes(amountUnit)) fail('Choose Naira or Kobo for the source amounts.');
  if(new TextEncoder().encode(input.csv).length>1500000)fail("Import is limited to 1.5 MB and 500 rows.");
  let parsed:Record<string,string>[];
  let columns: string[] = [];
  let headerProblem = '';
  try{parsed=parse(input.csv,{columns:(headers: string[]) => {
    columns = headers;
    if (headers.some(header => !header || unsafeKey(header)) || new Set(headers).size !== headers.length) {
      headerProblem = 'Each CSV column needs a different, non-empty header. Reserved object names are not allowed.';
      throw new Error(headerProblem);
    }
    return headers;
  },skip_empty_lines:true,bom:true,trim:true,max_record_size:20000});}
  catch{fail(headerProblem || "CSV could not be parsed. Use a header row, the same number of columns on every row, and quoted fields for commas.");}
  if(parsed.length>500||!parsed.length)fail("Provide between 1 and 500 CSV records.");
  if (input.mapping && (Array.isArray(input.mapping) || Object.entries(input.mapping).some(([key, target]) => !columns.includes(key) || unsafeKey(key) || typeof target !== 'string' || unsafeKey(target)))) fail('Choose a valid destination or Skip column for each CSV column.');
  const destination = (key: string) => {
    const chosen = input.mapping && Object.hasOwn(input.mapping, key) ? String(input.mapping[key]).trim() : key;
    return chosen === 'amount' ? 'amountKobo' : chosen;
  };
  const targets = columns.map(destination);
  if (new Set(targets.filter(Boolean)).size !== targets.filter(Boolean).length) fail('Map each destination field only once. Choose Skip column for unused columns.');
  // Amounts in major units take the decimals of the row's own currency (ISO 4217), naira when the row names none.
  const currencyColumn = columns.find((column) => destination(column) === 'currency');
  const working=structuredClone(state), rows:{row:number;status:string;message:string}[]=[];
  const amounts = new Map<number, number>();
  let valid=0,invalid=0,imported=0;
  // Imported rows whose name or reference came from a fallback rather than the file.
  const fallbacks={name:0,reference:0};
  for(const [index,raw] of parsed.entries()){
    try{
      const record:Record<string,any>={data:{synthetic:true}}, blankAsZero:Record<string,number>={};
      for(const [key,value] of Object.entries(raw)){
        const target=destination(key);
        if (!target) continue;
        if (unsafeKey(target)) throw new Error('Reserved object names are not allowed as import fields.');
        // A blank number is absent. Only the amount, which every kind but customers needs, is still refused when blank.
        // Quoted spaces are kept by the parser's trim, so a cell of spaces counts as blank too.
        if (numeric.has(target) && !value.trim() && !(target === 'amountKobo' && input.kind !== 'customers')) {
          // Earlier builds read a blank number other than an amount as 0, and the fingerprints of the rows they imported include it.
          if (!target.endsWith('Kobo')) blankAsZero[target] = 0;
          continue;
        }
        let decoded:unknown=value;
        if (numeric.has(target) && target.endsWith('Kobo')) {
          decoded = csvAmountToKobo(value, amountUnit, currencyColumn ? raw[currencyColumn] : undefined);
          if (target === 'amountKobo') amounts.set(index + 2, decoded as number);
        } else if(numeric.has(target))decoded=Number(value);
        if(boolean.has(target)) { if (!['true', 'false', ''].includes(value)) throw new Error(`${target} must be true or false.`); decoded=value==="true"; }
        if(target==="consentGaps")decoded=value?value.split("|"):[];
        if(topFields.has(target))record[target]=decoded;else record.data[target]=decoded;
      }
      const identity = input.identities && { source: input.identities.source, rowId: input.identities.ids[index], batchId: input.identities.batchId };
      // Stored in the row's import identity and compared when the row is imported again: its first form.
      const identityFingerprint = canonicalDigest({ ...record, data: { ...record.data, ...blankAsZero } }, 'legacy-en-us-replacer');
      if (identity) {
        const prior = working.records.find(r => r.kind === input.kind && r.data.importIdentity?.source === identity.source && r.data.importIdentity?.rowId === identity.rowId);
        if (prior) {
          if (prior.data.importIdentity.fingerprint !== identityFingerprint) throw new Error('This source row ID was already imported with different data. Review the existing record; it cannot be replaced by importing again.');
          rows.push({ row: index + 2, status: 'duplicate', message: 'Already imported: the same source row and data are saved.' }); continue;
        }
      }
      const named=Boolean(record.name),referenced=Boolean(record.reference);
      record.name ||= record.reference || `${input.kind} import ${index+1}`;
      record.status ||= defaultStatus[input.kind as keyof typeof defaultStatus];
      if(record.customerId&&!working.records.some(r=>r.id===record.customerId&&r.kind==="customers")){
        const customer=working.records.find(r=>r.kind==="customers"&&r.reference===record.customerId);
        if(customer)record.customerId=customer.id;
      }
      for(const [key,kind] of [["mandateId","mandates"],["dueItemId","due-items"]]){
        const candidate=record.data[key!];
        const related=working.records.find(r=>r.kind===kind&&(r.id===candidate||r.reference===candidate));
        if(related)record.data[key!]=related.id;
      }
      if(input.kind==="due-items")record.data.outstandingKobo=record.amountKobo;
      if(input.kind==="attempts"){record.data.source="external";record.data.simulated=true;}
      if(input.kind==="mandates"){record.data.origin="imported";record.data.consentGaps ||= [];}
      // Payment evidence is the same when its source event is or, without event IDs, when its source, reference, payer,
      // amounts, currency, connection and batch are. Evidence that only shares a reference is new: reconciliation
      // merges it into its payment or holds it as a conflict, and never loses its money.
      const sameDetails=(saved:{reference:string;customerId:string;amountKobo:number;data:Record<string,any>})=>saved.reference===record.reference&&saved.customerId===(record.customerId||"")&&saved.amountKobo===record.amountKobo
        &&["grossAmountKobo","feeKobo","batchReference","currency","provider","providerConnection"].every(key=>saved.data[key]===record.data[key]);
      const savedEvidence=input.kind==="observations"?working.records.find(r=>r.kind==="observations"&&r.data.source===record.data.source&&(r.data.eventId!==undefined||record.data.eventId!==undefined?String(r.data.eventId)===String(record.data.eventId):sameDetails(r))):undefined;
      if(savedEvidence&&!sameDetails(savedEvidence))throw new Error('This source event is already saved with different details. Review the saved payment evidence; it cannot be replaced by importing again.');
      if(record.reference&&(input.kind==="observations"?savedEvidence:working.records.some(r=>r.kind===input.kind&&r.reference===record.reference))){
        if (identity) throw new Error('This reference belongs to another saved record. Check its source row identity before importing; a conflicting row will not be silently skipped.');
        rows.push({row:index+2,status:"duplicate",message:input.kind==="observations"?"Skipped: the same payment evidence is already saved.":"Skipped: this source already has a record with the same reference."});continue;
      }
      validateRecord(working,ctx,input.kind,record);
      if (identity) record.data.importIdentity = { ...identity, fingerprint: identityFingerprint };
      makeRecord(working,input.kind,{...record,createdAt:ctx.now,updatedAt:ctx.now});
      valid++;rows.push({row:index+2,status:"valid",message:input.commit?"Sample record imported.":"Checked and ready to import."});
      if(!named)fallbacks.name++;if(!referenced)fallbacks.reference++;
    }catch(error){invalid++;rows.push({row:index+2,status:"invalid",message:error instanceof Error?error.message:"Invalid record."});}
  }
  // All-or-nothing: review every error before committing.
  if(input.commit&&invalid===0){state.records=working.records;imported=valid;}
  else if(input.commit&&invalid>0)rows.forEach(r=>{if(r.status==="valid")r.message="Not imported: resolve all row errors first.";});
  const warnings=fallbackWarnings(input.kind,columns,targets,input.identityColumn,fallbacks);
  return {valid,invalid,imported,skipped:rows.filter(row=>row.status==='duplicate').length,rows,columns,preview:parsed.slice(0,10).map((values,index)=>({row:index+2,values,...(amounts.has(index+2)?{amountKobo:amounts.get(index+2)}:{})})),...(warnings.length?{warnings}:{})};
}
