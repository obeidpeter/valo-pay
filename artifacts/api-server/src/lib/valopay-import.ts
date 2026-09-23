import { parse } from "csv-parse/sync";
import { canonicalDigest } from './digests';
import { makeRecord, validateRecord } from "../domain";
import type { Context, DomainState } from "../domain/types";
import { csvAmountToKobo, defaultStatus, importBooleanFields, importKinds as sharedImportKinds, importNumericFields } from "@workspace/valopay-schema";

const importKinds:readonly string[]=sharedImportKinds;
const topFields=new Set(["name","status","reference","amountKobo","customerId"]);
const numeric=importNumericFields;
const boolean=importBooleanFields;
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
const unsafeKey = (key: string) => ["__proto__", "constructor", "prototype"].includes(key);
export function importCsv(state:DomainState,ctx:Context,input:{kind:string;csv:string;syntheticOnly:boolean;commit:boolean;mapping?:Record<string,unknown>;amountUnit?:'naira'|'kobo'; identities?: { source: string; batchId: string; ids: string[] }}){
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
  const working=structuredClone(state), rows:{row:number;status:string;message:string}[]=[];
  const amounts = new Map<number, number>();
  let valid=0,invalid=0,imported=0;
  for(const [index,raw] of parsed.entries()){
    try{
      const record:Record<string,any>={data:{synthetic:true}}, blankAsZero:Record<string,number>={};
      for(const [key,value] of Object.entries(raw)){
        const target=destination(key);
        if (!target) continue;
        if (unsafeKey(target)) throw new Error('Reserved object names are not allowed as import fields.');
        // A blank number is absent. Only the amount, which every kind but customers needs, is still refused when blank.
        if (numeric.has(target) && !value && !(target === 'amountKobo' && input.kind !== 'customers')) {
          // Earlier builds read a blank number other than an amount as 0, and the fingerprints of the rows they imported include it.
          if (!target.endsWith('Kobo')) blankAsZero[target] = 0;
          continue;
        }
        let decoded:unknown=value;
        if (numeric.has(target) && target.endsWith('Kobo')) {
          decoded = csvAmountToKobo(value, amountUnit);
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
      if(record.reference&&working.records.some(r=>r.kind===input.kind&&r.reference===record.reference&&(input.kind!=="observations"||r.data.source===record.data.source))){
        if (identity) throw new Error('This reference belongs to another saved record. Check its source row identity before importing; a conflicting row will not be silently skipped.');
        rows.push({row:index+2,status:"duplicate",message:"Skipped: this source already has a record with the same reference."});continue;
      }
      validateRecord(working,ctx,input.kind,record);
      if (identity) record.data.importIdentity = { ...identity, fingerprint: identityFingerprint };
      makeRecord(working,input.kind,{...record,createdAt:ctx.now,updatedAt:ctx.now});
      valid++;rows.push({row:index+2,status:"valid",message:input.commit?"Sample record imported.":"Checked and ready to import."});
    }catch(error){invalid++;rows.push({row:index+2,status:"invalid",message:error instanceof Error?error.message:"Invalid record."});}
  }
  // All-or-nothing: review every error before committing.
  if(input.commit&&invalid===0){state.records=working.records;imported=valid;}
  else if(input.commit&&invalid>0)rows.forEach(r=>{if(r.status==="valid")r.message="Not imported: resolve all row errors first.";});
  return {valid,invalid,imported,skipped:rows.filter(row=>row.status==='duplicate').length,rows,columns,preview:parsed.slice(0,10).map((values,index)=>({row:index+2,values,...(amounts.has(index+2)?{amountKobo:amounts.get(index+2)}:{})}))};
}
