import PDFDocument from "pdfkit";
import { randomUUID, createHash } from "node:crypto";
import { objectStorageClient, ObjectStorageService } from "./objectStorage";
import type { Context, DomainState } from "../domain/types";
import { buildReports, customerTimeline, makeRecord } from "../domain";
import { getGates } from "./valopay-readiness";
import { verifyAudit } from "./valopay-store";
import { readExportBytes } from "./export-download";
import { buildDisputePack, disputePackCsv, packFonts, renderDisputePackPdf, type DisputePack } from "./valopay-packs";

/** CSV downloads are UTF-8 and start with the byte order mark, which is what spreadsheet programs look for before they read accented letters correctly on opening; the importer skips it (csv-parse `bom`). */
const CSV_BOM="\uFEFF";
function escapeCsv(value:unknown){
 let text=typeof value==="object"?JSON.stringify(value):String(value??"");
 if(/^[=+\-@\t\r]/.test(text))text="'"+text;
 return `"${text.replaceAll('"','""')}"`;
}
async function pdfBytes(title:string,data:unknown):Promise<Buffer>{
 return new Promise((resolve,reject)=>{
  const document=new PDFDocument({size:"A4",lang:"en-GB",margin:45,info:{Title:title,Author:"Valo Pay"}});
  const chunks:Buffer[]=[];
  document.on("data",chunk=>chunks.push(chunk));document.on("end",()=>resolve(Buffer.concat(chunks)));document.on("error",reject);
  const fonts=packFonts();document.registerFont("Sans",fonts.regular).registerFont("Sans-Bold",fonts.bold).font("Sans");
  document.fontSize(24).fillColor("#102E2A").text("VALO PAY").moveDown(0.4);
  document.fontSize(15).text(title).moveDown();
  document.fillColor("#9B6524").fontSize(10).text("SYNTHETIC SANDBOX - NOT LIVE EVIDENCE").moveDown();
  document.fillColor("#333333").fontSize(9).text("We never hold money. All amounts below are integer kobo (NGN). Times are UTC unless stated. This export cannot satisfy a production gate.").moveDown();
  document.font("Sans").fontSize(7).text(JSON.stringify(data,null,2),{width:505});
  document.end();
 });
}
export const packKinds=["customer-pack","dispute-pack"] as const;
export const exportKinds=["gate-pack","billing",...packKinds] as const;
export interface ExportInput{kind:string;customerId?:string;format:"json"|"csv"|"pdf"}
export interface ExportBytes{bytes:Buffer;contentType:string;payload:unknown;pack?:DisputePack}

/** Pure: the file for an export request.  Storage, the checksum and the audit entry happen in createExportFile. */
export async function buildExportBytes(state:DomainState,ctx:Context,input:ExportInput,options:{compress?:boolean}={}):Promise<ExportBytes>{
 const generatedAt=ctx.now;
 if((packKinds as readonly string[]).includes(input.kind)){
  // AUD-02: one-page summary followed by the timeline, as PDF, CSV or JSON of the same data.
  const pack=buildDisputePack(state,ctx,input.customerId||"");
  if(input.format==="pdf")return {bytes:await renderDisputePackPdf(pack,options),contentType:"application/pdf",payload:pack,pack};
  if(input.format==="csv")return {bytes:Buffer.from(CSV_BOM+disputePackCsv(pack)),contentType:"text/csv; charset=utf-8",payload:pack,pack};
  return {bytes:Buffer.from(JSON.stringify(pack,null,2)),contentType:"application/json",payload:pack,pack};
 }
 const reports=input.kind==="gate-pack"||input.kind==="billing"?buildReports(state,ctx.now):undefined;
 // MEA-02 and RET-06: the gate pack carries the uplift report with the pre-registered rule and its result, frozen at generation.
 const payload=input.kind==="gate-pack"?{...getGates(state),upliftReport:reports!.experiment,operational:reports!.operational,billing:reports!.billing}:input.kind==="billing"?reports!.billing:state.records.filter(r=>r.kind===input.kind);
 const snapshot={merchant:state.merchant.name,environment:"synthetic_sandbox",generatedAt,generatedBy:ctx.actor,auditVerification:verifyAudit(state),data:payload};
 if(input.format==="pdf")return {bytes:await pdfBytes(input.kind,snapshot),contentType:"application/pdf",payload:snapshot};
 if(input.format==="csv"){
  const rows=Array.isArray(payload)?payload:[payload];
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  return {bytes:Buffer.from(CSV_BOM+[["environment","merchant",...keys].join(","),...rows.map(r=>["synthetic_sandbox",state.merchant.name,...keys.map(k=>r[k])].map(escapeCsv).join(","))].join("\r\n")),contentType:"text/csv; charset=utf-8",payload:snapshot};
 }
 return {bytes:Buffer.from(JSON.stringify(snapshot,null,2)),contentType:"application/json",payload:snapshot};
}
export async function createExportFile(state:DomainState,ctx:Context,input:ExportInput){
 const started=Date.now();
 const {bytes,contentType,pack}=await buildExportBytes(state,ctx,input);
 const id=randomUUID();
 const dir=new ObjectStorageService().getPrivateObjectDir();
 const parts=dir.replace(/^\//,"").split("/");
 const bucket=parts.shift()!;
 const objectName=`${parts.join("/")}/exports/${state.merchant.id}/${id}.${input.format}`;
 await objectStorageClient.bucket(bucket).file(objectName).save(bytes,{resumable:false,contentType,preconditionOpts:{ifGenerationMatch:0},metadata:{cacheControl:"private, no-store"}});
 const checksum=createHash("sha256").update(bytes).digest("hex");
 // AUD-02: pack generation is itself an audited event (the route appends the audit entry) and is counted for Test 5 (MEA-01).
 makeRecord(state,"exports",{id,name:`${input.kind} · ${input.format.toUpperCase()}`,status:"ready",customerId:pack?String(pack.customer.id):"",createdAt:ctx.now,updatedAt:ctx.now,data:{checksum,kind:input.kind,format:input.format,usedInRealCase:false,objectName,bucket,contentType,byteLength:bytes.length,generationMs:Date.now()-started,events:pack?.timeline.length,customerReference:pack?String(pack.customer.reference):undefined}});
 return {id,downloadUrl:`/api/v1/exports/${id}/download?merchantId=${state.merchant.id}`,checksum,generatedAt:ctx.now};
}
export interface ExportDescriptor{id:string;bucket:string;objectName:string;checksum:string;contentType:string;filename:string}
/** The authorised export metadata from the lender's state; resolved inside the transaction, used after it. */
export function exportDescriptor(state:DomainState,id:string):ExportDescriptor{
 const record=state.records.find(r=>r.kind==="exports"&&r.id===id);
 if(!record)throw Object.assign(new Error("Export not found in this lender."),{status:404});
 return {id,bucket:String(record.data.bucket),objectName:String(record.data.objectName),checksum:String(record.data.checksum),contentType:String(record.data.contentType),filename:`valopay-${record.data.kind}-${id}.${record.data.format}`};
}
/** Reads the object and verifies the immutable SHA-256 before any byte is returned; holds no database lock. */
export async function readExport(descriptor:ExportDescriptor,signal?:AbortSignal){
 const bytes=await readExportBytes(objectStorageClient.bucket(descriptor.bucket).file(descriptor.objectName),signal);
 if(createHash("sha256").update(bytes).digest("hex")!==descriptor.checksum)throw new Error("Export checksum verification failed.");
 return {bytes,contentType:descriptor.contentType,filename:descriptor.filename};
}
export function downloadExport(state:DomainState,id:string,signal?:AbortSignal){
 return readExport(exportDescriptor(state,id),signal);
}
