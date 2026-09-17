import PDFDocument from "pdfkit";
import { randomUUID, createHash } from "node:crypto";
import { objectStorageClient, ObjectStorageService } from "./objectStorage";
import type { Context, DomainState } from "../domain/types";
import { buildReports, makeRecord } from "../domain";
import { getGates } from "./valopay-readiness";
import { verifyAudit } from "./valopay-store";
import { readExportBytes } from "./export-download";

export function customerTimeline(state:DomainState,id:string){
 const customer=state.records.find(r=>r.kind==="customers"&&r.id===id);
 if(!customer)throw Object.assign(new Error("Customer not found."),{status:404});
 const related=state.records.filter(r=>r.customerId===id);
 const dueItems=related.filter(r=>r.kind==="due-items"),payments=related.filter(r=>r.kind==="payments");
 const owed=dueItems.reduce((sum,r)=>sum+r.amountKobo,0);
 const applied=related.filter(r=>r.kind==="allocations"&&r.status==="confirmed").reduce((sum,r)=>sum+r.amountKobo,0);
 return {customer,position:{obligationsKobo:owed,allocatedKobo:applied,outstandingKobo:Math.max(0,owed-applied),unallocatedKobo:payments.reduce((sum,r)=>sum+Math.max(0,r.amountKobo-Number(r.data.allocatedKobo||0)),0),note:"Derived obligations and payment evidence, not funds held by Valo Pay."},
 events:related.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),mandates:related.filter(r=>r.kind==="mandates"),dueItems,payments};
}
function escapeCsv(value:unknown){
 let text=typeof value==="object"?JSON.stringify(value):String(value??"");
 if(/^[=+\-@\t\r]/.test(text))text="'"+text;
 return `"${text.replaceAll('"','""')}"`;
}
async function pdfBytes(title:string,data:unknown):Promise<Buffer>{
 return new Promise((resolve,reject)=>{
  const document=new PDFDocument({size:"A4",margin:45,info:{Title:title,Author:"Valo Pay"}});
  const chunks:Buffer[]=[];
  document.on("data",chunk=>chunks.push(chunk));document.on("end",()=>resolve(Buffer.concat(chunks)));document.on("error",reject);
  document.fontSize(24).fillColor("#102E2A").text("VALO PAY").moveDown(0.4);
  document.fontSize(15).text(title).moveDown();
  document.fillColor("#9B6524").fontSize(10).text("SYNTHETIC SANDBOX - NOT LIVE EVIDENCE").moveDown();
  document.fillColor("#333333").fontSize(9).text("We never hold money. All amounts below are integer kobo (NGN). Times are UTC unless stated. This export cannot satisfy a production gate.").moveDown();
  document.font("Courier").fontSize(7).text(JSON.stringify(data,null,2),{width:505});
  document.end();
 });
}
export async function createExportFile(state:DomainState,ctx:Context,input:{kind:string;customerId?:string;format:"json"|"csv"|"pdf"}){
 const generatedAt=ctx.now;
 const payload=input.kind==="gate-pack"?getGates(state):input.kind==="customer-pack"?customerTimeline(state,input.customerId||""):input.kind==="billing"?buildReports(state,ctx.now).billing:state.records.filter(r=>r.kind===input.kind);
 const snapshot={merchant:state.merchant.name,environment:"synthetic_sandbox",generatedAt,generatedBy:ctx.actor,auditVerification:verifyAudit(state),data:payload};
 let bytes:Buffer,contentType:string;
 if(input.format==="pdf"){bytes=await pdfBytes(input.kind,snapshot);contentType="application/pdf";}
 else if(input.format==="csv"){
  const rows=Array.isArray(payload)?payload:[payload];
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  bytes=Buffer.from([["environment","merchant",...keys].join(","),...rows.map(r=>["synthetic_sandbox",state.merchant.name,...keys.map(k=>r[k])].map(escapeCsv).join(","))].join("\r\n"));contentType="text/csv; charset=utf-8";
 }else{bytes=Buffer.from(JSON.stringify(snapshot,null,2));contentType="application/json";}
 const id=randomUUID();
 const dir=new ObjectStorageService().getPrivateObjectDir();
 const parts=dir.replace(/^\//,"").split("/");
 const bucket=parts.shift()!;
 const objectName=`${parts.join("/")}/exports/${state.merchant.id}/${id}.${input.format}`;
 await objectStorageClient.bucket(bucket).file(objectName).save(bytes,{resumable:false,contentType,preconditionOpts:{ifGenerationMatch:0},metadata:{cacheControl:"private, no-store"}});
 const checksum=createHash("sha256").update(bytes).digest("hex");
 makeRecord(state,"exports",{id,name:`${input.kind} · ${input.format.toUpperCase()}`,status:"ready",createdAt:ctx.now,updatedAt:ctx.now,data:{checksum,kind:input.kind,format:input.format,usedInRealCase:false,objectName,bucket,contentType,byteLength:bytes.length}});
 return {id,downloadUrl:`/api/v1/exports/${id}/download?merchantId=${state.merchant.id}`,checksum,generatedAt};
}
export async function downloadExport(state:DomainState,id:string,signal?:AbortSignal){
 const record=state.records.find(r=>r.kind==="exports"&&r.id===id);
 if(!record)throw Object.assign(new Error("Export not found in this lender."),{status:404});
 const bytes=await readExportBytes(objectStorageClient.bucket(record.data.bucket).file(record.data.objectName),signal);
 if(createHash("sha256").update(bytes).digest("hex")!==record.data.checksum)throw new Error("Export checksum verification failed.");
 return {bytes,contentType:record.data.contentType,filename:`valopay-${record.data.kind}-${id}.${record.data.format}`};
}