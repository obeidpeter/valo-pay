import type { DomainState } from "../domain/types";

/** What the sandbox cannot prove, listed on the gates page and in the gate pack. */
export const limitations=[
  "Synthetic sandbox only. No real lender or customer data may be loaded.",
  "P1: qualified Nigerian legal opinion and permitted operating model not verified.",
  "P2: no written aggregator partner agreement, production credentials or production connector. No debit dispatch.",
  "P3: NDPA registration, lender DPA, hosting/transfer basis and field-level envelope encryption not verified. Pre-data gate closed.",
  "P4: mandatory MFA/fresh challenges, independent penetration test, restore drill, runbooks, WAF and production monitoring not verified.",
  "P5: two qualifying signed lender contracts and per-obligation execution cutover are outstanding.",
  "SMS is simulated; no Nigerian transactional/DND route or real acceptance evidence.",
  "Implementation differs from TRD: TypeScript/Express/Drizzle rather than Python/FastAPI/SQLAlchemy; hosted workspace rather than Terraform/container infrastructure.",
  "Production outbox dispatcher, partner-specific signed webhook adapters, automated scheduling, field encryption/crypto-shredding, retention-locked storage and time-boxed staff access are not implemented.",
  "No measured load, uptime, restore, notification delivery or production latency certification. Sandbox outputs cannot prove Tests 2, 3 or 5.",
];
/** The readiness gates: prerequisites and decisions, always unproven on synthetic data. */
export function getGates(state:DomainState){
 const evidence=state.records.filter(r=>r.kind==="evidence");
 const prerequisites=[
  ["P1","Legal opinion","Written opinion before instruction; adapt scope if a licence is required.","Before month 1"],
  ["P2","Aggregator partner access","One written partner agreement and partner-level production credentials.","End of month 2"],
  ["P3","Permission to process data","NDPA registration, lender DPA, security foundations and approved hosting basis before data.","Before lender data"],
  ["P4","Security & operational readiness","Independent pentest highs closed, restore rehearsal, runbooks, MFA and kill-switch drill.","Before live cohort"],
  ["P5","Two design-partner lenders","Two lender contracts with data-sharing, references and execution-ownership clauses.","End of month 3"],
 ].map(([id,title,description,due])=>({id,title,description,due,status:"blocked",evidence: evidence.find(r=>r.reference===id||r.data.gateId===id)?.data.reference||"No verified production evidence"}));
 const decisions=[
  {id:"FUNDING",title:"Stage 2 funding",status:"not_proven",description:"Test 5 for BOTH lenders, signed list-price Test 3, ≤₦15 variable cost and ≥3 months lean-burn bridge. All four required.",evidence:"No qualifying live measurement or signed commercial evidence",due:"End of month 9"},
  {id:"RECOVERY",title:"Recovery fee · Test 2",status:"not_proven",description:"For EACH lender: ≥8pp value recovery uplift; 90% CI excludes zero; precomputed sample per arm; settled any channel within 30 days. Independent of funding.",evidence:"Synthetic data cannot establish recovery efficacy. Fee remains off.",due:"End of month 9"},
  {id:"PORTABILITY",title:"Routing at creation · Test 1b",status:"closed",description:"Written answers from NIBSS and two aggregators on partner access and portability. No failover at failed debit.",evidence:"No written portability permission. No routing implementation.",due:"Only on written permission"},
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
  accessNote:"Demo personas affect synthetic workflows only; no live access is granted."
 },integrations:state.records.filter(r=>r.kind==="integrations"),
 members:["Admin","Operations","Finance","Compliance reviewer","Read-only"].map((name,i)=>({id:`demo-member-${i}`,merchantId:state.merchant.id,kind:"members",name:`Sandbox ${name}`,status:"demo",reference:"",amountKobo:0,customerId:"",createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),data:{role:name,mfaEnrolled:false,synthetic:true}})),
 calendar:state.records.filter(r=>r.kind==="calendar")};
}