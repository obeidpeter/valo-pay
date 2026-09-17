import { createHash } from "node:crypto";
import type { Context, DomainState, ValopayRecord } from "./types";
import { recordsOf } from "./records";

const HOUR=3600000,DAY=24*HOUR;
const retryable=new Set(["INSUFFICIENT_FUNDS","BANK_UNAVAILABLE","TECHNICAL_FAILURE"]);
const permanent=new Set(["ACCOUNT_CLOSED","MANDATE_CANCELLED","MANDATE_EXPIRED","CUSTOMER_DISPUTED","ACCOUNT_RESTRICTED"]);
export function policyIdFor(state:DomainState,due:ValopayRecord){
 return due.data.policyId||state.records.find(r=>r.kind==="mandates"&&r.id===due.data.mandateId)?.data.policyId;
}
function businessTime(state:DomainState,time:number):number{
 const holidays=new Set(recordsOf(state,"calendar").map(r=>r.data.date));
 for(let i=0;i<370;i++){
  const wat=new Date(time+HOUR),date=wat.toISOString().slice(0,10);
  if([0,6].includes(wat.getUTCDay())||holidays.has(date)){wat.setUTCDate(wat.getUTCDate()+1);wat.setUTCHours(8,0,0,0);time=wat.getTime()-HOUR;continue;}
  const start=Math.max(8,Number(state.settings.executionStart??8)),end=Math.min(21,Number(state.settings.executionEnd??21));
  if(start>=end)return NaN;
  if(wat.getUTCHours()<start){wat.setUTCHours(start,0,0,0);return wat.getTime()-HOUR;}
  if(wat.getUTCHours()>=end){wat.setUTCDate(wat.getUTCDate()+1);wat.setUTCHours(start,0,0,0);time=wat.getTime()-HOUR;continue;}
  return time;
 }
 return NaN;
}
export function evaluateRetry(state:DomainState,ctx:Context,due:ValopayRecord,policy:ValopayRecord){
 const explain=(decision:string,reason:string,nextAt:string|null=null)=>({dueItemId:due.id,decision,reason,nextAt,policyVersion:policy.data.version});
 const attempts=recordsOf(state,"attempts").filter(r=>r.data.dueItemId===due.id).sort((a,b)=>String(a.data.occurredAt||a.createdAt).localeCompare(String(b.data.occurredAt||b.createdAt)));
 const last=attempts.at(-1);
 if(state.merchant.killSwitch||state.settings.policyKillSwitches?.[policy.id])return explain("blocked","Kill switch is active.");
 if(["paid","cancelled","closed","in_dispute","unpaid_final"].includes(due.status)||Number(due.data.outstandingKobo)===0)return explain("stop","No collectible, undisputed obligation remains.");
 if(attempts.some(a=>["unknown","sent","scheduled"].includes(a.status)))return explain("blocked","An in-flight or unknown outcome must be resolved by reference before retrying.");
 if(attempts.length>=Math.min(4,Number(policy.data.maxAttempts||3)))return explain("give_up","Combined external and Valo attempt ceiling reached.");
 if(!last||last.status!=="failed")return explain("not_eligible","No failed first attempt to retry.");
 const code=String(last.data.failureCode||"UNKNOWN");
 if(permanent.has(code))return explain("stop",`Permanent failure ${code}; do not re-present.`);
 if(!retryable.has(code))return explain("blocked",`Failure code ${code} requires a mapped, reviewed policy decision.`);
 if(policy.status!=="approved"||!policy.data.reviewer||policy.data.reviewer===policy.data.author)return explain("blocked","Independent compliance approval is required.");
 if(due.amountKobo<500000)return explain("stop","Below the absolute ₦5,000 ticket floor.");
 if(due.amountKobo<1000000&&!due.data.overrideReason&&!due.data.adminOverrideReason)return explain("blocked","Recorded merchant Admin low-ticket override is missing.");
 const mandate=state.records.find(r=>r.kind==="mandates"&&r.id===due.data.mandateId);
 if(!mandate||mandate.status!=="active")return explain("blocked","Mandate is not active.");
 if(due.amountKobo>mandate.amountKobo)return explain("blocked","Due amount exceeds the mandate limit.");
 if(!mandate.data.consentEvidence||mandate.data.consentGaps?.length)return explain("blocked","Consent evidence is missing or imported gaps are unresolved.");
 if(due.data.experimentArm==="holdout")return explain("holdout","Stable manual-process holdout assignment; Valo must not retry.");
 if(due.data.owner!=="valopay")return explain("observation_only",`Execution belongs to ${due.data.owner}; Valo cannot instruct this obligation.`);
 if(state.merchant.mode!=="instruction"||!state.merchant.preLiveReady)return explain("observation_only","Instruction gate remains closed; synthetic backtests cannot unlock it.");
 const notice=recordsOf(state,"notifications").find(r=>r.id===last.data.noticeId&&r.data.purpose==="pre_debit"&&r.data.acceptedAt&&r.data.synthetic!==true);
 if(!notice)return explain("defer","Required notice has no real provider acceptance evidence. Delivery timestamps or simulations do not satisfy the notice clock.");
 const next=businessTime(state,Math.max(Date.parse(ctx.now),Date.parse(last.data.occurredAt||last.createdAt)+Math.max(24,Number(policy.data.spacingHours||48))*HOUR,Date.parse(notice.data.acceptedAt)+Math.max(24,Number(policy.data.retryNoticeHours||24))*HOUR));
 if(!Number.isFinite(next))return explain("blocked","Execution window has no valid business-hour overlap.");
 return explain("would_schedule","All policy checks passed in a read-only evaluation; no instruction is sent.",new Date(next).toISOString());
}
export function preregisterSample(baseline:number,holdout:number){
 if(!(baseline>0&&baseline<0.92&&holdout>=0.1&&holdout<=0.5))throw new Error("Choose a baseline between 0 and 0.92 and a 10–50% holdout.");
 // Two-sided 90% confidence, 80% power, 8 percentage point effect.
 const ratio=(1-holdout)/holdout,z=1.64485362695147+0.8416212335729143;
 const holdoutMinimum=Math.ceil(z*z*(baseline*(1-baseline)+(baseline+0.08)*(1-baseline-0.08)/ratio)/(0.08*0.08));
 return {holdoutMinimum,engineMinimum:Math.ceil(holdoutMinimum*ratio),confidence:0.9,power:0.8,effect:0.08};
}
export function enrolEligibleFailures(state:DomainState,ctx:Context){
 for(const due of recordsOf(state,"due-items")){
  if(due.data.experimentId)continue;
  const first=recordsOf(state,"attempts").filter(a=>a.data.dueItemId===due.id).sort((a,b)=>String(a.data.occurredAt||a.createdAt).localeCompare(String(b.data.occurredAt||b.createdAt)))[0];
  if(!first||first.status!=="failed"||!retryable.has(first.data.failureCode))continue;
  const failureAt=String(first.data.occurredAt||first.createdAt);
  const experiment=recordsOf(state,"experiments").find(e=>e.status==="preregistered"&&e.data.policyId===policyIdFor(state,due)&&failureAt>=e.data.preregisteredAt&&failureAt<=`${e.data.enrolmentClose}T23:59:59.999Z`);
  if(!experiment||due.amountKobo<500000)continue;
  const hash=createHash("sha256").update(`${experiment.data.seed}:${state.merchant.id}:${due.id}`).digest("hex");
  due.data.experimentId=experiment.id;due.data.experimentArm=parseInt(hash.slice(0,8),16)/0x100000000<experiment.data.holdoutShare?"holdout":"engine";
  due.data.firstFailureAt=failureAt;due.data.assignmentAt=ctx.now;due.updatedAt=ctx.now;
 }
}