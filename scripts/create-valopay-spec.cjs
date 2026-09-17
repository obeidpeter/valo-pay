const fs = require("node:fs");
const str = { type: "string" }, num = { type: "integer" }, bool = { type: "boolean" };
const ref = (s) => ({ $ref: `#/components/schemas/${s}` });
const arr = (s) => ({ type: "array", items: ref(s) });
const obj = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required });
const schemas = {
  HealthStatus: obj({ status: str }),
  RecordData: { type: "object", additionalProperties: {} },
  ValopayRecord: obj({ id: str, merchantId: str, kind: str, name: str, status: str, reference: str, amountKobo: num, customerId: str, createdAt: str, updatedAt: str, data: ref("RecordData") }),
  RecordInput: obj({ name: str, status: str, reference: str, amountKobo: {type:"integer", minimum:0}, customerId: str, data: ref("RecordData") }, ["name"]),
  RecordUpdate: obj({ name: str, status: str, reference: str, amountKobo: {type:"integer", minimum:0}, customerId: str, data: ref("RecordData") }, []),
  Merchant: obj({ id: str, name: str, shortName: str, segment: str, mode: str, status: str, provider: str, monthlyVolume: num, killSwitch: bool, preDataReady: bool, preLiveReady: bool }),
  Workspace: obj({ name: str, environment: str, actor: str, role: str, authenticated: bool, merchants: arr("Merchant"), roles: {type:"array",items:str}, productionEnabled: bool }),
  Metric: obj({ key: str, label: str, value: {type:"number"}, unit: str, detail: str }),
  Alert: obj({ key: str, severity: str, title: str, detail: str, count: num, since: str, linkedRecordId: str }, ["key","severity","title","detail"]),
  Overview: obj({ metrics: arr("Metric"), queues: arr("Metric"), activity: arr("ValopayRecord"), upcoming: arr("ValopayRecord"), mode: str, environment: str, lastClose: str, nextClose: str, closeTime: str, alerts: arr("Alert") }),
  RecordList: obj({ items: arr("ValopayRecord"), total: num, nextOffset: num }, ["items","total"]),
  ActionInput: obj({ action: str, recordId: str, reason: str, data: ref("RecordData") }, ["action"]),
  ActionResult: obj({ message: str, record: ref("ValopayRecord"), data: ref("RecordData") }, ["message","data"]),
  ImportInput: obj({ kind: str, csv: str, syntheticOnly: bool, commit: bool, mapping: ref("RecordData") }, ["kind","csv","syntheticOnly","commit"]),
  ImportRow: obj({ row: num, status: str, message: str }),
  ImportResult: obj({ valid: num, invalid: num, imported: num, rows: arr("ImportRow") }),
  Report: obj({ metrics: arr("Metric"), billing: ref("RecordData"), experiment: ref("RecordData"), operational: ref("RecordData"), closes: arr("ValopayRecord") }),
  Gate: obj({ id: str, title: str, description: str, status: str, evidence: str, due: str }),
  Gates: obj({ prerequisites: arr("Gate"), decisions: arr("Gate"), limitations:{type:"array", items:str}, cashKobo:num, burnKobo:num }),
  Timeline: obj({ customer: ref("ValopayRecord"), position: ref("RecordData"), events: arr("ValopayRecord"), mandates: arr("ValopayRecord"), dueItems: arr("ValopayRecord"), payments: arr("ValopayRecord") }),
  Settings: obj({ merchant: ref("Merchant"), settings: ref("RecordData"), permissions: ref("RecordData"), integrations: arr("ValopayRecord"), members: arr("ValopayRecord"), calendar: arr("ValopayRecord") }),
  SettingsInput: obj({ executionStart: num, executionEnd: num, authorisationMode: str, contactRoute: str, minimumTicketKobo:num, defaultOwner: str, policyChangeRequiresConsent: bool, unallocatedAlertThreshold: num, notificationCostAlertKobo: num, closeTime: str, scheduledCloseEnabled: bool }, []),
  ExportInput: obj({ kind: str, customerId: str, format: {type:"string", enum:["json","csv","pdf"]} }, ["kind","format"]),
  ExportResult: obj({ id:str, downloadUrl: str, checksum: str, generatedAt: str }),
};
const paths = {};
function add(path, method, id, response, body, params = []) {
 const op = {operationId:id, tags:["valopay"], parameters:params, responses:{"200":{description:"Success",content:{"application/json":{schema:ref(response)}}},"400":{description:"Invalid request"},"401":{description:"Authentication required"},"403":{description:"Permission or readiness gate blocked"},"409":{description:"Conflict"}}};
 if(body)op.requestBody={required:true,content:{"application/json":{schema:ref(body)}}};
 (paths[path]??={})[method]=op;
}
const pathParam = (name) => ({name,in:"path",required:true,schema:str});
const merchant = {name:"merchantId",in:"query",required:true,schema:str};
const search = {name:"search",in:"query",schema:str};
const status = {name:"status",in:"query",schema:str};
const limit = {name:"limit",in:"query",schema:{type:"integer",minimum:1,maximum:500},description:"Page size; omitted returns the whole filtered set (at most 500 per page)."};
const offset = {name:"offset",in:"query",schema:{type:"integer",minimum:0},description:"Rows to skip in the newest-first order."};
const updatedSince = {name:"updatedSince",in:"query",schema:str,description:"ISO timestamp; only records updated at or after it (incremental sync)."};
add("/healthz","get","healthCheck","HealthStatus");
add("/v1/workspace","get","getWorkspace","Workspace");
add("/v1/overview","get","getOverview","Overview",null,[merchant]);
add("/v1/records/{kind}","get","listRecords","RecordList",null,[pathParam("kind"),merchant,search,status,limit,offset,updatedSince]);
add("/v1/records/{kind}","post","createRecord","ValopayRecord","RecordInput",[pathParam("kind"),merchant]);
add("/v1/records/{kind}/{id}","patch","updateRecord","ValopayRecord","RecordUpdate",[pathParam("kind"),pathParam("id"),merchant]);
add("/v1/actions","post","performAction","ActionResult","ActionInput",[merchant]);
add("/v1/imports","post","importRecords","ImportResult","ImportInput",[merchant]);
add("/v1/customers/{id}/timeline","get","getCustomerTimeline","Timeline",null,[pathParam("id"),merchant]);
add("/v1/reports","get","getReports","Report",null,[merchant]);
add("/v1/gates","get","getGates","Gates",null,[merchant]);
add("/v1/settings","get","getSettings","Settings",null,[merchant]);
add("/v1/settings","patch","updateSettings","Settings","SettingsInput",[merchant]);
add("/v1/exports","post","createExport","ExportResult","ExportInput",[merchant]);
paths["/v1/exports/{id}/download"]={get:{operationId:"downloadExport",tags:["valopay"],parameters:[pathParam("id"),merchant],responses:{"200":{description:"Private verified export bytes",content:{"application/octet-stream":{schema:{type:"string",format:"binary"}}}},"404":{description:"Export not found in tenant"}}}};
paths["/v1/openapi.json"]={get:{operationId:"getOpenApiDocument",tags:["valopay"],responses:{"200":{description:"Versioned public API specification",content:{"application/json":{schema:{type:"object",additionalProperties:true}}}}}}};
paths["/v1/webhooks/{provider}"]={post:{operationId:"disabledProviderWebhook",tags:["valopay"],parameters:[pathParam("provider")],responses:{"403":{description:"Disabled until a provider-specific signed adapter is configured. No events are processed."}}}};
fs.writeFileSync("lib/api-spec/openapi.json",JSON.stringify({openapi:"3.1.0",info:{title:"Api",version:"1.0.0",description:"Valo Pay Stage 1 observation-first sandbox API. All monetary fields are integer kobo. Live lender data and all outbound provider instructions are blocked until production readiness is verified."},servers:[{url:"/api"}],paths,components:{schemas}},null,2));