import type { DomainState } from "../domain/types";

/** What the sandbox cannot prove, listed on the gates page and in the gate pack. */
export const limitations=[
  "This sandbox accepts sample data only. Do not upload real lender or customer data.",
  "P1 — Legal review: a qualified Nigerian legal opinion and the permitted operating model have not been verified.",
  "P2 — Provider access: no written aggregator agreement, live credentials or live connection is in place. No debit instructions can be sent.",
  "P3 — Data protection: registration under the Nigeria Data Protection Act, lender data-processing agreements, hosting and transfer arrangements, and encryption of individual fields have not been verified. Real data remains blocked.",
  "P4 — Security: mandatory multi-factor authentication and fresh checks for sensitive actions, independent penetration testing, a backup restore drill, operating procedures, a web application firewall and live monitoring have not been verified.",
  "P5 — Lender agreements: two qualifying signed contracts and a confirmed collection handover for each instalment are still required.",
  "Text messages are simulated. There is no live Nigerian transactional messaging route, support for do-not-disturb routing or evidence of provider acceptance.",
  "The current implementation differs from the technical requirements: it uses TypeScript, Express and Drizzle in a hosted workspace. The planned Python, FastAPI, SQLAlchemy and Terraform-managed container infrastructure are not in place.",
  "The production system still needs an outgoing instruction dispatcher, signed provider webhook connections, automated instruction scheduling, field encryption and secure key deletion, retention-locked storage, and time-limited staff access.",
  "Load capacity, uptime, backup restoration, message delivery and live response times have not been certified. Sample results cannot prove the recovery, commercial or operational readiness tests (Tests 2, 3 and 5).",
];
/** The readiness gates: prerequisites and decisions, always unproven on synthetic data. */
export function getGates(state:DomainState){
 const evidence=state.records.filter(r=>r.kind==="evidence");
 const prerequisites=[
  ["P1","Legal opinion","Obtain a written legal opinion before sending collection instructions. Adjust the operating scope if a licence is required.","Before month 1"],
  ["P2","Aggregator partner access","Obtain a written partner agreement and partner-level access to the live provider system.","End of month 2"],
  ["P3","Permission to process data","Verify data-protection registration, lender data-processing agreements, security controls and approved hosting arrangements before accepting real data.","Before accepting lender data"],
  ["P4","Security & operational readiness","Resolve high-severity findings from independent penetration testing. Test backup restoration and the emergency stop, document operating procedures, and verify multi-factor authentication.","Before the first live customer group"],
  ["P5","Two design-partner lenders","Sign two lender contracts covering data sharing, customer references and responsibility for collection instructions.","End of month 3"],
 ].map(([id,title,description,due])=>({id,title,description,due,status:"blocked",evidence: evidence.find(r=>r.reference===id||r.data.gateId===id)?.data.reference||"No verified production evidence"}));
 const decisions=[
  {id:"FUNDING",title:"Stage 2 funding",status:"not_proven",description:"All four conditions are required: both lenders pass the operational test (Test 5); signed agreements meet the list-price test (Test 3); variable cost is no more than ₦15 per collection; and funding covers at least three months of lean operating costs.",evidence:"No qualifying live results or signed commercial evidence",due:"End of month 9"},
  {id:"RECOVERY",title:"Recovery fee · Test 2",status:"not_proven",description:"Each lender must show at least an 8-percentage-point improvement in recovery by value, with a 90% confidence interval above zero and the planned minimum sample in each group. Count payments settled through any channel within 30 days. This decision is separate from funding.",evidence:"Sample data cannot prove improved recovery. The fee remains off.",due:"End of month 9"},
  {id:"PORTABILITY",title:"Provider choice at setup · Test 1b",status:"closed",description:"Obtain written answers from NIBSS and two aggregators about partner access and moving mandates between providers. A failed debit must not be switched to another provider.",evidence:"No written permission to move mandates between providers. Provider routing has not been built.",due:"Only after written permission"},
 ];
 return {prerequisites,decisions,limitations,cashKobo:0,burnKobo:1250000000};
}
/** A lender's settings, the role's permissions, and its integrations, members and calendar. */
export function getSettings(state:DomainState,role:string){
 const allowed=(roles:string[])=>roles.includes(role);
 return {merchant:state.merchant,settings:state.settings,permissions:{
  edit:allowed(["Admin","Operations","Finance","Compliance reviewer"]),
  approvePolicies:allowed(["Compliance reviewer"]),reconcile:allowed(["Admin","Operations","Finance"]),
  manageSettings:role==="Admin",instruct:false,realData:false,mfaVerified:false,
  accessNote:"Demo roles let you try different responsibilities with sample data. They do not grant access to live operations."
 },integrations:state.records.filter(r=>r.kind==="integrations"),
 members:["Admin","Operations","Finance","Compliance reviewer","Read-only"].map((name,i)=>({id:`demo-member-${i}`,merchantId:state.merchant.id,kind:"members",name:`Sandbox ${name}`,status:"demo",reference:"",amountKobo:0,customerId:"",createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),data:{role:name,mfaEnrolled:false,synthetic:true}})),
 calendar:state.records.filter(r=>r.kind==="calendar")};
}
