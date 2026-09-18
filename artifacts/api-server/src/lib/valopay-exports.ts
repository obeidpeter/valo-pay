import PDFDocument from "pdfkit";
import { createHash } from "node:crypto";
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { objectStorageClient } from "./objectStorage";
import type { Context, DomainState, ValopayRecord } from "../domain/types";
import { buildReports } from "../domain";
import { getGates } from "./valopay-readiness";
import { verifyAudit } from "./valopay-store";
import { collectExportBytes, EXPORT_STORAGE_TIMEOUT_MS, readExportBytes } from "./export-download";
import { buildDisputePack, disputePackCsv, packFonts, renderDisputePackPdf, type DisputePack } from "./valopay-packs";
import { MAX_EXPORT_BYTES, publicExportRecord, type ClaimedExport, type ExportArtifact, type ExportJobStorage } from './export-jobs';

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
/** The export kinds that are a customer's dispute pack (customer-pack is the older name). */
export const packKinds=["customer-pack","dispute-pack"] as const;
/** The export kinds that are not a record kind. */
export const exportKinds=["gate-pack","billing",...packKinds] as const;
/** What to export and in which format. */
export interface ExportInput{kind:string;customerId?:string;format:"json"|"csv"|"pdf"}
/** The file for an export request and the payload it was made from. */
export interface ExportBytes{bytes:Buffer;contentType:string;payload:unknown;pack?:DisputePack}

/** Walk the rendered payload before PDF/JSON encoding allocates a second copy.
 * Each string is measured once; unrelated lender history is not an export limit. */
function assertPayloadSize(payload:unknown):void{
 let length=0;
 const visit=(value:unknown):void=>{
  if(value&&typeof value==='object'){
   length+=2;
   for(const [key,child] of Object.entries(value)){length+=Buffer.byteLength(JSON.stringify(key))+2;visit(child);}
  }else length+=Buffer.byteLength(JSON.stringify(value)??'null');
  if(length>MAX_EXPORT_BYTES)throw Object.assign(new Error('Export source exceeds the supported size.'),{exportTooLarge:true});
 };
 visit(payload);
}

/** Pure byte generation. The worker records the checksum and uploads outside database transactions. */
export async function buildExportBytes(state:DomainState,ctx:Context,input:ExportInput,options:{compress?:boolean}={}):Promise<ExportBytes>{
 const generatedAt=ctx.now;
 if((packKinds as readonly string[]).includes(input.kind)){
  // AUD-02: one-page summary followed by the timeline, as PDF, CSV or JSON of the same data.
  const pack=buildDisputePack(state,ctx,input.customerId||"");
  assertPayloadSize(pack);
  if(input.format==="pdf")return {bytes:await renderDisputePackPdf(pack,options),contentType:"application/pdf",payload:pack,pack};
  if(input.format==="csv")return {bytes:Buffer.from(CSV_BOM+disputePackCsv(pack)),contentType:"text/csv; charset=utf-8",payload:pack,pack};
  return {bytes:Buffer.from(JSON.stringify(pack,null,2)),contentType:"application/json",payload:pack,pack};
 }
 const reports=input.kind==="gate-pack"||input.kind==="billing"?buildReports(state,ctx.now):undefined;
 // MEA-02 and RET-06: the gate pack carries the uplift report with the pre-registered rule and its result, frozen at generation.
 const payload=input.kind==="gate-pack"?{...getGates(state),upliftReport:reports!.experiment,operational:reports!.operational,billing:reports!.billing}:input.kind==="billing"?reports!.billing:state.records.filter(r=>r.kind===input.kind).map(record=>record.kind==='exports'?publicExportRecord(record):record);
 const snapshot={merchant:state.merchant.name,environment:"synthetic_sandbox",generatedAt,generatedBy:ctx.actor,auditVerification:verifyAudit(state),data:payload};
 assertPayloadSize(snapshot);
 if(input.format==="pdf")return {bytes:await pdfBytes(input.kind,snapshot),contentType:"application/pdf",payload:snapshot};
 if(input.format==="csv"){
  const rows=Array.isArray(payload)?payload:[payload];
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  return {bytes:Buffer.from(CSV_BOM+[["environment","merchant",...keys].join(","),...rows.map(r=>["synthetic_sandbox",state.merchant.name,...keys.map(k=>r[k])].map(escapeCsv).join(","))].join("\r\n")),contentType:"text/csv; charset=utf-8",payload:snapshot};
 }
 return {bytes:Buffer.from(JSON.stringify(snapshot,null,2)),contentType:"application/json",payload:snapshot};
}
/** Pure byte generation, called only after the durable worker claim transaction has committed. */
export async function generateExportArtifact(claim: ClaimedExport): Promise<{ bytes: Buffer; artifact: ExportArtifact }> {
 const started=performance.now();
 const {bytes,contentType,pack}=await buildExportBytes(claim.state,claim.context,claim.input);
 return {bytes,artifact:{checksum:createHash('sha256').update(bytes).digest('hex'),contentType,byteLength:bytes.length,generationMs:Math.round(performance.now()-started),generatedAt:claim.context.now,
  ...(pack?{events:pack.timeline.length,customerReference:String(pack.customer.reference)}:{})}};
}
/** A stable private key and create-only upload make recovery safe after lost acknowledgements and failed commits. */
export const exportJobStorage: ExportJobStorage = {
 async existing(claim) {
  const file=objectStorageClient.bucket(claim.location.bucket).file(claim.location.objectName);
  let metadata;
  try {
   const stream=file.requestStream({uri:'',headers:{'Cache-Control':'no-store'},timeout:EXPORT_STORAGE_TIMEOUT_MS});
   metadata=JSON.parse((await collectExportBytes(stream,undefined,256*1024)).toString('utf8'));
  } catch(error) { if(Number((error as {statusCode?:unknown;code?:unknown}).statusCode??(error as {code?:unknown}).code)===404)return null; throw error; }
  const custom=metadata.metadata||{};
  if(custom.valopayExportId!==claim.id||custom.valopayMerchantId!==claim.merchantId)throw new Error('Export object ownership metadata does not match its job.');
  const artifact=JSON.parse(String(custom.valopayArtifact||'null')) as ExportArtifact|null;
  if(!artifact||!/^[a-f0-9]{64}$/.test(artifact.checksum)||!Number.isSafeInteger(artifact.byteLength)||artifact.byteLength<0||artifact.byteLength>MAX_EXPORT_BYTES||Number(metadata.size)!==artifact.byteLength)throw new Error('Export object metadata is invalid.');
  const bytes=await readExportBytes(file,undefined,MAX_EXPORT_BYTES);
  if(bytes.length!==artifact.byteLength||createHash('sha256').update(bytes).digest('hex')!==artifact.checksum)throw new Error('Export recovery checksum verification failed.');
  return artifact;
 },
 async put(claim,bytes,artifact) {
  const stream=objectStorageClient.bucket(claim.location.bucket).file(claim.location.objectName).createWriteStream({resumable:false,timeout:EXPORT_STORAGE_TIMEOUT_MS,contentType:artifact.contentType,preconditionOpts:{ifGenerationMatch:0},metadata:{cacheControl:'private, no-store',metadata:{valopayExportId:claim.id,valopayMerchantId:claim.merchantId,valopayArtifact:JSON.stringify(artifact)}}});
  // Abort destroys the actual upload stream, rather than leaving a timed-out
  // promise uploading in the background and consuming an unbounded worker slot.
  await pipeline(Readable.from([bytes]),stream,{signal:AbortSignal.timeout(EXPORT_STORAGE_TIMEOUT_MS)});
 },
};
/** Where an export lives and what to check it against. */
export interface ExportDescriptor{id:string;bucket:string;objectName:string;checksum:string;contentType:string;filename:string}
/** The authorised export metadata from the lender's state; resolved inside the transaction, used after it. */
export function exportDescriptor(state:DomainState,id:string):ExportDescriptor{
 const record=state.records.find(r=>r.kind==="exports"&&r.id===id);
 if(!record)throw Object.assign(new Error("Export not found in this lender."),{status:404});
 return exportDescriptorForRecord(record);
}
export function exportDescriptorForRecord(record:ValopayRecord):ExportDescriptor{
 if(record.status!=="ready")throw Object.assign(new Error("This export is not ready. Check its saved status or retry it from the console."),{status:409});
 return {id:record.id,bucket:String(record.data.bucket),objectName:String(record.data.objectName),checksum:String(record.data.checksum),contentType:String(record.data.contentType),filename:`valopay-${record.data.kind}-${record.id}.${record.data.format}`};
}
/** Reads the object and verifies the immutable SHA-256 before any byte is returned; holds no database lock. */
export async function readExport(descriptor:ExportDescriptor,signal?:AbortSignal){
 const bytes=await readExportBytes(objectStorageClient.bucket(descriptor.bucket).file(descriptor.objectName),signal);
 if(createHash("sha256").update(bytes).digest("hex")!==descriptor.checksum)throw new Error("Export checksum verification failed.");
 return {bytes,contentType:descriptor.contentType,filename:descriptor.filename};
}
/** The export's bytes for a download, resolved from the lender's state and checksum verified. */
export function downloadExport(state:DomainState,id:string,signal?:AbortSignal){
 return readExport(exportDescriptor(state,id),signal);
}
