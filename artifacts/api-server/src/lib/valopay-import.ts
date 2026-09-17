import { parse } from "csv-parse/sync";
import { makeRecord, validateRecord } from "../domain";
import type { Context, DomainState } from "../domain/types";
import { fail } from "./valopay-store";
import { defaultStatus, importBooleanFields, importKinds as sharedImportKinds, importNumericFields } from "@workspace/valopay-schema";

const importKinds:readonly string[]=sharedImportKinds;
const topFields=new Set(["name","status","reference","amountKobo","customerId"]);
const numeric=importNumericFields;
const boolean=importBooleanFields;
export function importCsv(state:DomainState,ctx:Context,input:{kind:string;csv:string;syntheticOnly:boolean;commit:boolean;mapping?:Record<string,unknown>}){
  if(!input.syntheticOnly)fail("Pre-data gate is closed. Only synthetic sample records are accepted.",403);
  if(!importKinds.includes(input.kind))fail("This resource does not support CSV import.");
  if(input.csv.length>1500000)fail("Import is limited to 1.5 MB and 500 rows.");
  let parsed:Record<string,string>[];
  try{parsed=parse(input.csv,{columns:true,skip_empty_lines:true,bom:true,trim:true,max_record_size:20000});}
  catch{fail("CSV could not be parsed. Use a header row and quoted fields for commas.");}
  if(parsed.length>500||!parsed.length)fail("Provide between 1 and 500 CSV records.");
  const working=structuredClone(state), rows:{row:number;status:string;message:string}[]=[];
  let valid=0,invalid=0,imported=0;
  for(const [index,raw] of parsed.entries()){
    try{
      const record:Record<string,any>={data:{synthetic:true}};
      for(const [key,value] of Object.entries(raw)){
        const target=String(input.mapping?.[key]||key);
        let decoded:unknown=value;
        if(numeric.has(target))decoded=Number(value);
        if(boolean.has(target))decoded=value==="true";
        if(target==="consentGaps")decoded=value?value.split("|"):[];
        if(topFields.has(target))record[target]=decoded;else record.data[target]=decoded;
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
        rows.push({row:index+2,status:"duplicate",message:"Reference already exists for this source; skipped without creating another record."});continue;
      }
      validateRecord(working,ctx,input.kind,record);
      makeRecord(working,input.kind,{...record,createdAt:ctx.now,updatedAt:ctx.now});
      valid++;rows.push({row:index+2,status:"valid",message:input.commit?"Imported synthetic record.":"Validated; ready to import."});
    }catch(error){invalid++;rows.push({row:index+2,status:"invalid",message:error instanceof Error?error.message:"Invalid record."});}
  }
  // All-or-nothing: review every error before committing.
  if(input.commit&&invalid===0){state.records=working.records;imported=valid;}
  else if(input.commit&&invalid>0)rows.forEach(r=>{if(r.status==="valid")r.message="Not imported: resolve all row errors first.";});
  return {valid,invalid,imported,rows};
}