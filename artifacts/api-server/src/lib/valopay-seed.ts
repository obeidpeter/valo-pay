import { randomUUID } from "node:crypto";
import type { DomainState, Merchant, ValopayRecord } from "../domain/types";

export function seedMerchant(id: string, smaller = false): DomainState {
  const now = new Date();
  const date = (days: number) => new Date(now.getTime()+days*86400000).toISOString();
  const merchant: Merchant = {id,name:smaller?"Cedar Cooperative":"Meridian Credit",shortName:smaller?"CC":"MC",segment:smaller?"Smaller lender · synthetic":"Tier-2 lender · synthetic",mode:"observation",status:"active",provider:"Sandbox Rail",monthlyVolume:smaller?4000:20000,killSwitch:false,preDataReady:false,preLiveReady:false};
  const state: DomainState = {merchant,settings:{executionStart:6,executionEnd:10,authorisationMode:"batch",contactRoute:"Contact your lender's collections team",minimumTicketKobo:1000000,defaultOwner:"lms",environment:"sandbox",reversalWindowDays:7,providerFeeSchedule:{"Sandbox Rail":{bps:50,capKobo:100000}},policyKillSwitches:{}},records:[]};
  function add(kind:string,name:string,status:string,data:Record<string,unknown>={},amountKobo=0,customerId="",reference=""): ValopayRecord {
    const r:ValopayRecord={id:randomUUID(),merchantId:id,kind,name,status,data,amountKobo,customerId,reference,createdAt:date(-3),updatedAt:date(-3)};
    state.records.push(r); return r;
  }
  const policy=add("policies","Standard lender retry policy","draft",{version:1,maxAttempts:3,spacingHours:48,firstNoticeHours:48,retryNoticeHours:24,partialAllowed:false,author:"Sandbox Admin",reviewer:"",complianceMapping:"CBN notification and re-presentation; FCCPC debt-recovery conduct. Requires independent review."});
  add("templates","Pre-debit notice","draft",{version:1,purpose:"pre_debit",text:"{{merchant}}: Your payment of {{amount}} is due on {{date}}. For help, contact {{contact}}.",author:"Sandbox Admin"});
  const names=["Ada Okonkwo","Tunde Bakare","Chiamaka Obi","Yusuf Bello","Ngozi Eze","Dami Adeyemi","Ife Nwosu","Seyi Ajayi"];
  names.forEach((name,i)=>{
    const c=add("customers",name,"active",{bankName:["Access Bank","GTBank","Zenith Bank","UBA"][i%4],accountMasked:`•••• ${1000+i}`,phoneMasked:`+234 ••• ••${30+i}`,consentProvenance:"Synthetic imported consent",synthetic:true},0,"",`DEMO-C${1001+i}`);
    const mandate=add("mandates",`${name} · monthly mandate`,i===2||i===5?"pending_activation":i===7?"suspended":"active",{workflow:i%2?"hosted_consent":"transfer_to_activate",frequency:"monthly",activationDeadline:date(i===2?2:5),consentEvidence:`DEMO-CONSENT-${i+1}`,consentGaps:i===7?["No captured timestamp"]:[],policyId:policy.id,origin:"imported",reminderCount:i===2?1:0,synthetic:true},5000000,c.id,`SBX-MND-${1001+i}`);
    const amount=[2500000,4200000,1800000,3500000,2500000,6000000,1500000,800000][i]!;
    const due=add("due-items",`${name} · instalment ${i+1}`,"scheduled",{dueDate:date(i<4?-2:2).slice(0,10),mandateId:mandate.id,owner:"lms",outstandingKobo:amount,synthetic:true,overrideReason:i===7?"Synthetic Admin acknowledges low-ticket warning":""},amount,c.id,`DEMO-LOAN-${1001+i}`);
    if(i<3){
      const payment=add("payments",`${name} · received`,i===2?"proposed":"allocated",{channel:i===1?"transfer":"direct_debit",collectionStatus:"succeeded",settlementStatus:"settled",reversalStatus:"none",refundStatus:"none",dueItemId:due.id,allocatedKobo:i===2?0:amount,rule:i===2?"R5":"R1",confidence:i===2?"probable":"certain",explanation:i===2?"Payer name and amount suggest this instalment. Finance confirmation required.":"Exact provider reference and amount match this instalment.",synthetic:true},amount,c.id,`SBX-PAY-${1001+i}`);
      add("observations",`${name} · payment evidence`,"resolved",{source:i===1?"transfer":"webhook",paymentId:payment.id,provider:"Sandbox Rail",dueItemId:due.id,resolutionKey:"provider_reference",eventId:`seed-${i}`,synthetic:true},amount,c.id,payment.reference);
      if(i!==2){
        add("allocations",`${name} · certain match`,"confirmed",{paymentId:payment.id,dueItemId:due.id,rule:"R1",confidence:"certain",automatic:true,explanation:"Provider reference, currency and gross amount match.",synthetic:true},amount,c.id);
        due.status="paid"; due.data.outstandingKobo=0;
      } else {
        // A proposed payment always carries its proposed allocation for Finance to confirm or reject.
        add("allocations",`${name} · probable match`,"proposed",{paymentId:payment.id,dueItemId:due.id,rule:"R5",confidence:"probable",automatic:false,explanation:"Payer name and amount suggest this instalment. Finance confirmation required.",reviewed:null,synthetic:true},amount,c.id);
        payment.data.proposedDueItemId=due.id; payment.data.proposedAmountKobo=amount;
      }
      add("attempts",`${name} · external attempt`,"succeeded",{dueItemId:due.id,number:1,source:"external",occurredAt:date(-3),providerReference:payment.reference,synthetic:true},amount,c.id);
    }
    if(i===3){
      add("attempts",`${name} · external attempt`,"failed",{dueItemId:due.id,number:1,source:"external",failureCode:"INSUFFICIENT_FUNDS",occurredAt:date(-2),synthetic:true},amount,c.id);
      due.status="in_collection";
    }
    if([2,5,7].includes(i)){
      add("exceptions",i===7?"Imported consent needs review":i===5?"Activation awaiting consent":"Payment needs confirmation","open",{type:i===7?"imported_consent_gap":i===5?"activation_expired":"unallocated_payment",severity:i===7?"high":"medium",owner:i===2?"Finance":i===7?"Admin":"Operations",dueBy:date(i===7?-1:1),linkedRecordId:i===2?due.id:mandate.id,notes:"Synthetic scenario for workflow evaluation.",synthetic:true},amount,c.id);
    }
  });
  const unidentified=add("payments","Unidentified transfer","unallocated",{channel:"transfer",collectionStatus:"succeeded",settlementStatus:"settled",reversalStatus:"none",refundStatus:"none",allocatedKobo:0,narration:"September payment",observedAt:date(-3),synthetic:true},3200000,"","SBX-UNIDENTIFIED-001");
  add("exceptions","Transfer has no unique reference","open",{type:"unallocated_payment",severity:"medium",owner:"Finance",dueBy:date(1),notes:"Confirm the payer before allocation.",linkedRecordId:unidentified.id,synthetic:true},3200000);
  add("cutovers","Initial lender cohort","draft",{inventory:"LMS scheduler; provider recurring plan; merchant manual collections",incumbentDisabled:false,externalAttemptsImported:true,dualRunComplete:false,accountableUser:"",fallbackOwner:"lms",confirmation:"",synthetic:true});
  add("experiments","Recovery measurement · pre-registration","draft",{baselineRate:0.4,holdoutShare:0.5,minPerArm:600,analysisDate:date(120).slice(0,10),enrolmentClose:date(90).slice(0,10),seed:"valopay-stage1-sandbox",policyId:policy.id,synthetic:true});
  add("commercial",merchant.name,"discovery",{monthlyVolume:merchant.monthlyVolume,averageTicketKobo:2500000,implementationKobo:smaller?100000000:300000000,licenceKobo:smaller?35000000:60000000,usageBps:30,usageCapKobo:15000,signed:false,signedFullPriceTerms:false,effectiveDate:"2028-01-01",startCondition:"Funding gate and agreed launch",conversationComplete:false,designPartner:true,synthetic:true});
  for(const [key,name] of [["P1","Legal opinion"],["P2","Aggregator partner access"],["P3","NDPA registration and lender DPA"],["P4","Independent security and restore evidence"],["P5","Two lender contracts"]]){
    add("evidence",`${key} · ${name}`,"pending",{gateId:key,reference:"",notes:"External evidence required. Synthetic records cannot satisfy this gate."},0,"",key);
  }
  add("integrations","Sandbox Rail","simulated",{type:"aggregator",description:"Deterministic simulation only. Production partner adapter not connected.",capabilities:["mandate tracking","synthetic observations"],synthetic:true});
  add("integrations","SMS route","not_connected",{type:"sms",description:"No messages sent. Nigerian transactional/DND delivery verification required."});
  add("integrations","Loan management system","csv_only",{type:"lms",description:"Synthetic CSV import and outcome export. Partner-specific API delivery not connected."});
  return state;
}