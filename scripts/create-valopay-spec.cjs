const fs = require("node:fs");
const str = { type: "string" }, num = { type: "integer" }, bool = { type: "boolean" };
const ref = (s) => ({ $ref: `#/components/schemas/${s}` });
const arr = (s) => ({ type: "array", items: ref(s) });
const obj = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required });
const schemas = {
  HealthStatus: obj({ status: str, build: str, startedAt: str, uptimeSeconds: num, scheduler: ref("SchedulerStatus") }),
  SchedulerRun: obj({ runId: str, at: str, durationMs: num, initialised: num, examined: num, closed: num, skipped: num, failed: num }),
  SchedulerStatus: obj({ state: { type: "string", enum: ["not_started", "running", "off", "stopped"] }, intervalMs: { type: ["integer", "null"] }, ticks: num, lastTickAt: { type: ["string", "null"] }, lastRun: { oneOf: [ref("SchedulerRun"), { type: "null" }] } }),
  DatabaseCheck: obj({ status: { type: "string", enum: ["ok", "failed"] }, latencyMs: num }),
  ReadinessStatus: obj({ status: { type: "string", enum: ["ok", "degraded"] }, build: str, checks: obj({ database: ref("DatabaseCheck") }) }),
  RecordData: { type: "object", additionalProperties: {} },
  ValopayRecord: obj({ id: str, merchantId: str, kind: str, name: str, status: str, reference: str, amountKobo: num, customerId: str, createdAt: str, updatedAt: str, data: ref("RecordData") }),
  RecordInput: obj({ name: str, status: str, reference: str, amountKobo: {type:"integer", minimum:0}, customerId: str, data: ref("RecordData") }, ["name"]),
  RecordUpdate: obj({ name: str, status: str, reference: str, amountKobo: {type:"integer", minimum:0}, customerId: str, data: ref("RecordData"), expectedUpdatedAt: str }, []),
  Merchant: obj({ id: str, name: str, shortName: str, segment: str, mode: str, status: str, provider: str, monthlyVolume: num, killSwitch: bool, preDataReady: bool, preLiveReady: bool }),
  Workspace: obj({ name: str, environment: str, actor: str, role: str, authenticated: bool, merchants: arr("Merchant"), roles: {type:"array",items:str}, productionEnabled: bool }),
  Metric: obj({ key: str, label: str, value: {type:"number"}, unit: str, detail: str }),
  Alert: obj({ key: str, severity: str, title: str, detail: str, count: num, since: str, linkedRecordId: str }, ["key","severity","title","detail"]),
  Overview: obj({ metrics: arr("Metric"), queues: arr("Metric"), activity: arr("ValopayRecord"), upcoming: arr("ValopayRecord"), mode: str, environment: str, lastClose: str, nextClose: str, closeTime: str, alerts: arr("Alert") }),
  RecordList: obj({ items: arr("ValopayRecord"), total: num, nextOffset: num }, ["items","total"]),
  ActionInput: obj({ action: str, recordId: str, reason: str, data: ref("RecordData"), expectedUpdatedAt: str }, ["action"]),
  ActionResult: obj({ message: str, record: ref("ValopayRecord"), data: ref("RecordData") }, ["message","data"]),
  ImportInput: obj({ kind: str, csv: str, syntheticOnly: bool, commit: bool, mapping: ref("RecordData"), amountUnit: { type: "string", enum: ["naira", "kobo"], description: "Unit used by source amount values; defaults to kobo for existing API clients. The console requires an explicit choice." } }, ["kind","csv","syntheticOnly","commit"]),
  ImportRow: obj({ row: num, status: str, message: str }),
  ImportResult: obj({ valid: num, invalid: num, imported: num, rows: arr("ImportRow") }),
  Report: obj({ metrics: arr("Metric"), billing: ref("RecordData"), experiment: ref("RecordData"), operational: ref("RecordData"), closes: arr("ValopayRecord") }),
  Gate: obj({ id: str, title: str, description: str, status: str, evidence: str, due: str }),
  Gates: obj({ prerequisites: arr("Gate"), decisions: arr("Gate"), limitations:{type:"array", items:str}, cashKobo:num, burnKobo:num }),
  Timeline: obj({ customer: ref("ValopayRecord"), position: ref("RecordData"), events: arr("ValopayRecord"), mandates: arr("ValopayRecord"), dueItems: arr("ValopayRecord"), payments: arr("ValopayRecord") }),
  Settings: obj({ merchant: ref("Merchant"), settings: ref("RecordData"), permissions: ref("RecordData"), integrations: arr("ValopayRecord"), members: arr("ValopayRecord"), calendar: arr("ValopayRecord") }),
  SettingsInput: obj({ executionStart: num, executionEnd: num, authorisationMode: str, contactRoute: str, minimumTicketKobo:num, defaultOwner: str, policyChangeRequiresConsent: bool, unallocatedAlertThreshold: num, notificationCostAlertKobo: num, closeTime: str, scheduledCloseEnabled: bool }, []),
  ExportInput: obj({ kind: str, customerId: str, format: {type:"string", enum:["json","csv","pdf"]} }, ["kind","format"]),
  ExportResult: obj({ id:str, downloadUrl: str, status:{type:'string',enum:['queued','running','ready','failed']}, kind:str, format:str, customerId:str, requestedAt:str, attempts:num, checksum:str, generatedAt:str, byteLength:num, generationMs:num, error:str }, ['id','downloadUrl']),
  EffectiveCloseSchedule: obj({
    time: str, enabled: bool, automatic: bool, nextAt: { type: ["string", "null"] },
    runtimeState: { type: "string", enum: ["not_started", "running", "off", "stopped"] },
    serviceIssue: { type: ["string", "null"], enum: ["starting", "delayed", "failed", null] },
    missed: bool, overdueMinutes: num, lateAfterMinutes: num,
    lastAt: { type: ["string", "null"] }, lastTrigger: { type: ["string", "null"] },
    lastCheckedAt: { type: ["string", "null"] }, lastErrorAt: { type: ["string", "null"] },
  }),
};
// Additive metadata remains optional for clients reading an older service response.
for (const field of ["lastSuccessAt", "lastErrorAt"]) schemas.SchedulerStatus.properties[field] = { type: ["string", "null"] };
for (const name of ["Overview", "Settings"]) schemas[name].properties.closeSchedule = ref("EffectiveCloseSchedule");
const paths = {};
schemas.Settings.properties.revision = str;
schemas.SettingsInput.properties.expectedRevision = str;
schemas.ImportResult.properties.columns = { type: "array", items: str };
schemas.ImportResult.properties.preview = { type: "array", items: obj({ row: num, values: ref("RecordData"), amountKobo: num }, ["row", "values"]) };
schemas.ImportResult.properties.skipped = num;
function add(path, method, id, response, body, params = []) {
 const op = {operationId:id, tags:["valopay"], parameters:params, responses:{"200":{description:"Success",content:{"application/json":{schema:ref(response)}}},"400":{description:"Invalid request"},"401":{description:"Authentication required"},"403":{description:"Permission or readiness gate blocked"},"409":{description:"Conflict"}}};
 if(body)op.requestBody={required:true,content:{"application/json":{schema:ref(body)}}};
 (paths[path]??={})[method]=op;
}
const pathDescriptions = { kind: "Record kind: one of the shared schema's recordKinds (customers, mandates, due-items, attempts, observations, payments, ...).", id: "The record's id.", provider: "Provider name; every provider's ingress is disabled in the sandbox." };
const pathParam = (name) => ({name,in:"path",required:true,schema:str,description:pathDescriptions[name]});
const merchant = {name:"merchantId",in:"query",required:true,schema:str,description:"The lender (a merchant in the API) the request is scoped to; one of the caller's workspace merchants."};
const search = {name:"search",in:"query",schema:str,description:"Text matched, ignoring case and accents, against the name, reference, status and data."};
const status = {name:"status",in:"query",schema:str,description:"Only records in this status; omitted or \"all\" for every status."};
const limit = {name:"limit",in:"query",schema:{type:"integer",minimum:1,maximum:500},description:"Page size, capped at 500 when supplied. Omitted returns the complete filtered kind for existing relationship and balance views."};
const offset = {name:"offset",in:"query",schema:{type:"integer",minimum:0},description:"Rows to skip in the newest-first order."};
const updatedSince = {name:"updatedSince",in:"query",schema:str,description:"ISO timestamp; only records updated at or after it (incremental sync)."};
const customerId = {name:"customerId",in:"query",schema:str,description:"Only records directly linked to this customer, in the selected lender."};
const recordId = {name:"id",in:"query",schema:str,description:"Only this exact record ID, in the selected kind and lender."};
add("/healthz","get","healthCheck","HealthStatus");
add("/readyz","get","readinessCheck","ReadinessStatus");
const describe = (path, method, summary, description) => Object.assign(paths[path][method], { summary, description });
paths["/readyz"].get.responses["503"]={description:"Not ready: the database cannot be reached within the check's time limit",content:{"application/json":{schema:ref("ReadinessStatus")}}};
add("/v1/workspace","get","getWorkspace","Workspace");
add("/v1/overview","get","getOverview","Overview",null,[merchant]);
add("/v1/records/{kind}","get","listRecords","RecordList",null,[pathParam("kind"),merchant,search,status,limit,offset,updatedSince,customerId,recordId]);
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
add('/v1/exports/{id}','get','getExportJob','ExportResult',null,[pathParam('id'),merchant]);
add('/v1/exports/{id}/retry','post','retryExportJob','ExportResult',null,[pathParam('id'),merchant]);
paths["/v1/exports/{id}/download"]={get:{operationId:"downloadExport",tags:["valopay"],parameters:[pathParam("id"),merchant],responses:{"200":{description:"Private verified export bytes",content:{"application/octet-stream":{schema:{type:"string",format:"binary"}}}},"404":{description:"Export not found in tenant"}}}};
paths["/v1/openapi.json"]={get:{operationId:"getOpenApiDocument",tags:["valopay"],responses:{"200":{description:"Versioned public API specification",content:{"application/json":{schema:{type:"object",additionalProperties:true}}}}}}};
paths["/v1/webhooks/{provider}"]={post:{operationId:"disabledProviderWebhook",tags:["valopay"],parameters:[pathParam("provider")],responses:{"403":{description:"Disabled until a provider-specific signed adapter is configured. No events are processed."}}}};
describe("/healthz","get","Liveness: the process answers, with its build, uptime and scheduler state","Never touches the database, so a database outage does not read as a dead process. Needs no sandbox or sign-in.");
describe("/readyz","get","Readiness: one bounded round trip to the database","Answers 503 with status degraded while the database does not answer within the check's time limit; the reason is in the log, not the answer. Needs no sandbox or sign-in.");
describe("/v1/workspace","get","The caller's workspace: its lenders, roles and actor","On a first visit an anonymous caller gets a new synthetic sandbox with two lenders; a signed-in person gets their own workspace. New sandboxes are limited per client address.");
describe("/v1/overview","get","The operations overview for one lender","Metrics, queues, recent activity, upcoming due items, the last and next daily close, and the alerts feed (NFR-OBS-02).");
describe("/v1/records/{kind}","get","Records of one kind for one lender, newest first","Filtered by status and by a search that ignores case and accents; paged with limit and offset; updatedSince for incremental sync.");
describe("/v1/records/{kind}","post","Create a record of an editable kind","Validated against the kind's data schema; a status only a domain action may set is refused.");
describe("/v1/records/{kind}/{id}","patch","Update a record","Editable kinds only; an approved, preregistered or closed version is immutable. Send expectedUpdatedAt from the edit's original record to reject stale changes with 409. An identical successful Idempotency-Key replay returns its original result before checking the version.");
describe("/v1/actions","post","Run a domain action on the lender's state","Every action is audited, most require a reason, and the persona's role applies; the catalogue of actions is in docs/frontend-contract.md.");
describe("/v1/imports","post","Preview or commit a synthetic CSV import","commit=false validates every row and reports each; commit=true persists all rows or none. syntheticOnly must be true: no real lender data.");
describe("/v1/customers/{id}/timeline","get","A customer's position and complete timeline","Every event, mandate, due item and payment, with each retry decision as it was recorded.");
describe("/v1/reports","get","Reports for one lender","Metrics, the billing statement and invoices, the recovery experiment, operational measurement (Test 5) and the daily closes with their REC-07 reports.");
describe("/v1/gates","get","Production readiness gates","Prerequisites and decisions, always unproven on synthetic data, and the limitations the sandbox cannot remove.");
describe("/v1/settings","get","A lender's settings, permissions, integrations, members and calendar","Permissions are those of the caller's current persona.");
describe("/v1/settings","patch","Change a lender's execution settings","Admin only. Send expectedRevision from the settings originally opened; 409 leaves outdated edits unapplied. The revision covers editable preferences and is unaffected by scheduler cursor changes. An identical successful Idempotency-Key replay returns its original result before checking the version.");
describe("/v1/exports","post","Queue a private export","Durably saves a queued export job and returns immediately. Poll its status before downloading. Rendering and private storage run outside the database transaction; retries use the same immutable object key. A record kind, gate pack, billing statement or customer dispute pack supports JSON, CSV or PDF.");
describe('/v1/exports/{id}','get','Check a saved export','Tenant-authorised status, safe failure reason and checksum/download details once ready. Older immediate export records remain downloadable.');
describe('/v1/exports/{id}/retry','post','Retry a saved export','Requeues a failed or expired job while preserving its identity and private object key. Running and ready jobs are returned unchanged; retries cannot overwrite a completed file.');
describe("/v1/exports/{id}/download","get","Download an export","The bytes are read from private storage and checked against the recorded SHA-256 before any are sent.");
describe("/v1/openapi.json","get","This specification","The versioned public contract the console and the generated clients are built from.");
describe("/v1/webhooks/{provider}","post","Provider webhook ingress, disabled in the sandbox","Always 403: no provider adapter is configured and no event is processed.");
const schemaDescriptions = {
  HealthStatus: "The liveness answer: the build, when the process started, its uptime and what the close scheduler is doing.",
  SchedulerRun: "The last scheduler pass that found work: its id, when it ran, how long it took and what it did.",
  SchedulerStatus: "Whether closes are scheduled in this process, how often it looks, when it last looked and its last pass with work.",
  DatabaseCheck: "One round trip to the database and how long it took.",
  ReadinessStatus: "The readiness answer: ok, or degraded while the database does not answer.",
  RecordData: "A record's data: the fields the kind's schema declares, and anything else a caller stored.",
  ValopayRecord: "A stored record of any kind, with its lender, status, reference, amount in kobo and data.",
  RecordInput: "A new record: only the name is required; the kind's default status applies when none is given.",
  RecordUpdate: "The fields to change on a record; omitted fields keep their values.",
  Merchant: "A lender: its mode (observation or instruction), provider, volume, kill switch and readiness flags.",
  Workspace: "The caller's workspace: who is acting, in which role, whether they signed in, and the lenders and roles available.",
  Metric: "A named measurement with its unit and the basis it was derived from.",
  Alert: "An NFR-OBS-02 alert: what condition holds, how severe it is, since when and the record it points at.",
  Overview: "The overview: metrics, queues, recent activity, upcoming due items, the close schedule and the alerts.",
  RecordList: "One page of records with the filtered total; nextOffset is present while more rows remain.",
  ActionInput: "An action to run: its name, the record it applies to, the reason for it and any data it needs.",
  ActionResult: "What an action did, in words, with the record it produced or changed and any data it returns.",
  ImportInput: "A synthetic CSV to preview or commit for one kind, with an optional column mapping.",
  ImportRow: "The outcome of one imported row.",
  ImportResult: "How many rows were valid, invalid and imported, and each row's outcome.",
  Report: "The reports: metrics, billing, the experiment, operational measurement and the daily closes.",
  Gate: "One readiness gate: what it needs, its status and the evidence recorded.",
  Gates: "The prerequisites and decisions, the sandbox's limitations, and the cash and burn figures used for the funding decision.",
  Timeline: "A customer, their derived position, and every related event, mandate, due item and payment.",
  Settings: "A lender's settings and the caller's permissions, with integrations, members and the business calendar.",
  SettingsInput: "The execution settings to change; every field is optional.",
  ExportInput: "What to export (a record kind, gate-pack, billing, dispute-pack or customer-pack with a customerId) and in which format.",
  ExportResult: "Saved export job identity, status and retry details. Checksum, generatedAt and file size appear only when ready; the download route rejects unfinished jobs. Optional status retains compatibility with older immediate-export responses.",
  EffectiveCloseSchedule: "Lender schedule combined with the actual scheduler service status. nextAt is present only when automatic closes are available; run history belongs only to this lender.",
};
for (const [name, description] of Object.entries(schemaDescriptions)) schemas[name].description = description;
// Priority queues keep complete counts while returning only a bounded page and its linked records.
schemas.QueuePage = {
  "type": "object",
  "required": [
    "items",
    "related",
    "total",
    "offset",
    "counts",
    "owners",
    "types",
    "asOf"
  ],
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/ValopayRecord"
      }
    },
    "related": {
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/ValopayRecord"
      }
    },
    "total": {
      "type": "integer",
      "minimum": 0
    },
    "offset": {
      "type": "integer",
      "minimum": 0
    },
    "counts": {
      "type": "object",
      "additionalProperties": {
        "type": "integer",
        "minimum": 0
      }
    },
    "owners": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "types": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "asOf": {
      "type": "string"
    }
  },
  "description": "A bounded priority queue page with complete filter counts, available owners and types, the applied offset and lender-scoped linked records. Counts are calculated before pagination. asOf is the timestamp used to determine overdue and due-today states."
};
paths["/v1/queues/{queue}"] = {
  "get": {
    "operationId": "listQueue",
    "tags": [
      "valopay"
    ],
    "summary": "A priority-sorted, lender-scoped queue with complete filter counts and page-specific linked records",
    "parameters": [
      {
        "name": "queue",
        "in": "path",
        "required": true,
        "schema": {
          "type": "string",
          "enum": [
            "exceptions",
            "mandates",
            "collections"
          ]
        },
        "description": "Priority queue to read: exceptions, mandates or collections."
      },
      {
        "name": "merchantId",
        "in": "query",
        "required": true,
        "schema": {
          "type": "string"
        },
        "description": "The active lender, belonging to the caller’s workspace."
      },
      {
        "name": "view",
        "in": "query",
        "required": false,
        "schema": {
          "type": "string",
          "maxLength": 200
        },
        "description": "A supported view for the queue. Defaults to open for exceptions and all for mandates and collections."
      },
      {
        "name": "owner",
        "in": "query",
        "required": false,
        "schema": {
          "type": "string",
          "maxLength": 200
        },
        "description": "Exact owner filter. Omit for every owner."
      },
      {
        "name": "type",
        "in": "query",
        "required": false,
        "schema": {
          "type": "string",
          "maxLength": 200
        },
        "description": "Exact exception type filter. Omit for every type."
      },
      {
        "name": "record",
        "in": "query",
        "required": false,
        "schema": {
          "type": "string",
          "maxLength": 200
        },
        "description": "Select this exact record in the queue instead of applying its view, within the active lender."
      },
      {
        "name": "target",
        "in": "query",
        "required": false,
        "schema": {
          "type": "string",
          "maxLength": 200
        },
        "description": "Locate the page containing this record among the filtered results. Does not bypass filters."
      },
      {
        "name": "limit",
        "in": "query",
        "required": false,
        "schema": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "description": "Page size, default 25 and maximum 100."
      },
      {
        "name": "offset",
        "in": "query",
        "required": false,
        "schema": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "description": "Rows to skip after filtering and priority ordering. Clamped to the last available page if results shrink."
      }
    ],
    "responses": {
      "200": {
        "description": "Success",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/QueuePage"
            }
          }
        }
      },
      "400": {
        "description": "Invalid request"
      },
      "401": {
        "description": "Authentication required"
      },
      "403": {
        "description": "Permission or readiness gate blocked"
      },
      "409": {
        "description": "Conflict"
      }
    },
    "description": "Filters and priority order are applied before pagination. Counts cover the full filtered queue. Related records only support the current page and remain in the same lender. A target locates the page containing a linked record; an unavailable or filtered-out target leaves the requested page unchanged. Dates use West Africa Time and the returned asOf timestamp."
  }
};

const queueOperation = paths['/v1/queues/{queue}'].get;
queueOperation.parameters.push({name:'q',in:'query',schema:{type:'string',maxLength:200},description:'Literal accent-insensitive customer name, customer reference or queue record name/reference search, applied before counting and paging.'});
schemas.ReconciliationPage = obj({items:arr('ValopayRecord'),related:arr('ValopayRecord'),total:num,offset:num,asOf:str,precision:ref('RecordData')},['items','related','total','offset','asOf']);
schemas.ReconciliationPage.description = 'A database-filtered reconciliation queue page, with complete count and lender-scoped linked evidence. Precision metadata describes the complete seeded monthly sample.';
const pageParams = [{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100},description:'Page size; defaults to 25.'},{name:'offset',in:'query',schema:{type:'integer',minimum:0,maximum:2147483647},description:'Rows to skip; clamped when the result shrinks.'}];
add('/v1/reconciliation/{queue}','get','listReconciliation','ReconciliationPage',null,[merchant,{name:'queue',in:'path',required:true,schema:{type:'string',enum:['proposals','duplicates','payments','observations','audit','batches']},description:'Reconciliation work queue.'},{name:'dueItem',in:'query',schema:{type:'string',maxLength:200},description:'Optional instalment focus; payment queues are restricted to its customer, proposals to its exact instalment.'},...pageParams]);
describe('/v1/reconciliation/{queue}','get','Page a reconciliation work queue','Filters and counts in PostgreSQL before paging. Linked payment, instalment and customer records belong to the same lender. Audit uses the reproducible previous-month sample including superseded reviewed matches.');
schemas.CloseHistoryPage = obj({items:arr('ValopayRecord'),total:num,allTotal:num,offset:num,first:ref('ValopayRecord'),latest:ref('ValopayRecord')},['items','total','allTotal','offset']);
schemas.CloseHistoryPage.description = 'Paged close summaries and first/latest closing positions for the entire WAT date range; full REC-07 evidence is fetched separately.';
add('/v1/close-history','get','listCloseHistory','CloseHistoryPage',null,[merchant,...['from','to'].map(name=>({name,in:'query',schema:{type:'string',maxLength:10},description:'Inclusive date in YYYY-MM-DD format, in West Africa Time.'})),...pageParams]);
describe('/v1/close-history','get','Page recorded daily closes','Newest first, with complete range counts and whole-range comparison endpoints. Missing historical measures remain absent. Invalid dates or reversed ranges are rejected.');
add('/v1/close-history/{id}','get','getCloseDetail','ValopayRecord',null,[merchant,{name:'id',in:'path',required:true,schema:str,description:'Close record in the active lender.'}]);
describe('/v1/close-history/{id}','get','Read the evidence for one recorded close','Returns the full immutable close report on demand within the current lender.');
paths['/v1/reports'].get.parameters.push({name:'includeCloses',in:'query',schema:{type:'string',enum:['true','false']},description:'Default true for compatibility. The console passes false and loads paged close summaries separately.'});
fs.writeFileSync("lib/api-spec/openapi.json",JSON.stringify({openapi:"3.1.0",info:{title:"Valo Pay sandbox API",version:"1.0.0",description:"Valo Pay Stage 1 observation-first sandbox API. All monetary fields are integer kobo. Live lender data and all outbound provider instructions are blocked until production readiness is verified."},servers:[{url:"/api"}],paths,components:{schemas}},null,2));
