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
  ExportInput: obj({ kind: str, customerId: str, closeReviewId: str, format: {type:"string", enum:["json","csv","pdf"]} }, ["kind","format"]),
  ExportResult: obj({ id:str, downloadUrl: str, status:{type:'string',enum:['queued','running','ready','failed']}, stage:{type:'string',enum:['queued','checking','rendering','uploading','confirming','ready','failed']}, lastProgressAt:str, stalled:bool, retryAllowed:bool, recoveryAt:str, expiredAt:str, kind:str, format:str, customerId:str, requestedAt:str, attempts:num, checksum:str, generatedAt:str, byteLength:num, generationMs:num, error:str }, ['id','downloadUrl']),
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
// Optional too: a settings answer stored as an idempotency receipt by an earlier build is parsed again on replay.
Object.assign(schemas.EffectiveCloseSchedule.properties, { failedAttempts: num, retryAt: { type: ["string", "null"] }, pausedForInactivityAt: { type: ["string", "null"] } });
Object.assign(schemas.SchedulerRun.properties, { paused: num, batches: num });
for (const name of ["Overview", "Settings"]) schemas[name].properties.closeSchedule = ref("EffectiveCloseSchedule");
const paths = {};
schemas.Settings.properties.revision = str;
schemas.Workspace.properties.accessMode = { type: "string", enum: ["sandbox", "staff"], description: "Whether the server authorises a demo persona or a provisioned staff membership." };
schemas.Workspace.properties.viewerScope = { type: "string", description: "Opaque workspace/user scope for browser preferences; never an authorisation credential." };
schemas.SettingsInput.properties.expectedRevision = str;
schemas.ImportResult.properties.columns = { type: "array", items: str };
schemas.ImportResult.properties.preview = { type: "array", items: obj({ row: num, values: ref("RecordData"), amountKobo: num }, ["row", "values"]) };
schemas.ImportResult.properties.skipped = num;
function add(path, method, id, response, body, params = []) {
 const op = {operationId:id, tags:["valopay"], parameters:params, responses:{"200":{description:"Success",content:{"application/json":{schema:ref(response)}}},"400":{description:"Invalid request"},"401":{description:"Authentication required"},"403":{description:"Permission or readiness gate blocked"},"409":{description:"Conflict"}}};
 if(body)op.requestBody={required:true,content:{"application/json":{schema:ref(body)}}};
 (paths[path]??={})[method]=op;
}
const pathDescriptions = { kind: "Record kind: one of the shared schema's recordKinds (customers, mandates, due-items, attempts, observations, payments, ...).", id: "The record's id.", provider: "Provider name; this generic address refuses every provider (the Paystack test ingress has its own address)." };
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
describe("/v1/webhooks/{provider}","post","Generic provider webhook address, always refused","Always 403: no event is processed here. Paystack test events go to POST /v1/providers/paystack/{connectionId}/events.");
const schemaDescriptions = {
  HealthStatus: "The liveness answer: the build, when the process started, its uptime and what the close scheduler is doing.",
  SchedulerRun: "The last scheduler pass that found work: its id, when it ran, how long it took, how many batches it read and what it did, including idle sandboxes whose automatic close it paused.",
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
  EffectiveCloseSchedule: "Lender schedule combined with the actual scheduler service status. nextAt is present only when automatic closes are available; run history belongs only to this lender. failedAttempts and retryAt describe failed automatic attempts at the pending time (retryAt only while automatic closes are available); pausedForInactivityAt says when the scheduler switched off the automatic close of a sandbox nobody changed. Answers from earlier builds may lack these three fields.",
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

paths['/v1/reconciliation/{queue}'].get.parameters.push({name:'q',in:'query',schema:{type:'string',maxLength:200},description:'Literal case- and accent-insensitive customer, payment or instalment name/reference search before counting and paging. Audit sample metadata remains unfiltered.'});
const historySections=['events','mandates','dueItems','payments'];
schemas.CustomerHistoryCounts=obj(Object.fromEntries(historySections.map(key=>[key,num])),historySections);
schemas.CustomerHistoryCounts.description='Complete counts or actual offsets for the four customer-history sections.';
schemas.CustomerHistory=obj({...schemas.Timeline.properties,totals:ref('CustomerHistoryCounts'),offsets:ref('CustomerHistoryCounts'),focusedRecord:ref('ValopayRecord')},[...schemas.Timeline.required,'totals','offsets']);
schemas.CustomerHistory.description='Bounded pages of customer records with balances derived from every related record, full section counts and an optional lender-scoped selected record.';
add('/v1/customers/{id}/history','get','getCustomerHistory','CustomerHistory',null,[merchant,{name:'id',in:'path',required:true,schema:str,description:'Customer in the active lender.'},{name:'record',in:'query',schema:{type:'string',maxLength:200},description:'Optional selected history record; must belong to this customer and lender.'},...historySections.flatMap(section=>pageParams.map(p=>({...p,name:section+p.name[0].toUpperCase()+p.name.slice(1)})))]);
describe('/v1/customers/{id}/history','get','Page a customer history with complete balances','Each section is independently paged in SQL, newest first with stable ID ordering. Counts and monetary aggregates are calculated before paging; no partial state may be written. Unknown customers return 404. The existing timeline endpoint retains its full-history contract.');
schemas.ConnectedWorkspace = obj({mode:{type:'string',enum:['synthetic']},revision:str,asOf:str,role:str,entity:ref('RecordData'),customers:{type:'array',items:ref('RecordData')},consents:arr('ValopayRecord'),purposes:{type:'array',items:ref('RecordData')},gates:{type:'array',items:ref('RecordData')},payments:ref('RecordData'),credit:ref('RecordData'),cash:ref('RecordData')});
schemas.ConnectedWorkspace.description='Synthetic connected workspace. Credit and Cash views carry evidence, permissions and refusal states. Every gate has liveEnabled false. No read creates sample records.';
schemas.ConnectedActionInput = {...obj({action:{type:'string',maxLength:80},recordId:{type:'string',maxLength:100},reason:{type:'string',minLength:8,maxLength:500},data:ref('RecordData'),expectedRevision:{type:'string',maxLength:80}},['action','reason','expectedRevision']),additionalProperties:false,description:'Action-specific data is validated by the server. Names use consent, payment, credit or cash prefixes. Every action requires a current whole-workspace revision and a reason. No input can enable live routes.'};
schemas.ConnectedActionResult = obj({message:str,record:ref('RecordData'),mode:{type:'string',enum:['synthetic']},externalInstructionPerformed:{type:'boolean',const:false}});
schemas.ConnectedActionResult.description='Committed sample operation. Cash actions include their record and outcome inside record; use the refreshed workspace view for display. A receipt is evidence from the server simulator only.';
add('/v1/connected','get','getConnectedWorkspace','ConnectedWorkspace',null,[merchant]);
describe('/v1/connected','get','Read the connected workspace','Same-origin, private and tenant scoped. Returns granular consent state, bound sample payment intents, explained credit assessments, independent SME cash planning and closed live gates.');
add('/v1/connected/actions','post','performConnectedAction','ConnectedActionResult','ConnectedActionInput',[merchant,{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:8,maxLength:200},description:'One key per unchanged intention. Retain it after response loss; replay happens before revision checking.'}]);
describe('/v1/connected/actions','post','Perform a synthetic connected-workspace action','Runs inside the existing merchant transaction and audit boundary. Role, purpose, subject, expiry, ownership and version checks apply. Unknown payment outcomes hold retries. No bank, credit bureau, accounting or tax endpoint is called.');
// ---- Pilot workflow, sources, personal work, retention and staff operations ----
// Their request and response shapes are the shared zod definitions in lib/valopay-schema,
// translated here so the contract cannot drift from what the routes validate. The views a
// route assembles itself are described by hand next to it.
require("tsx/cjs");
const shared = require("../lib/valopay-schema/src/index.ts");
function fromZod(schema) {
  const def = schema._def, kind = def.typeName, described = (out) => schema.description ? { ...out, description: schema.description } : out;
  switch (kind) {
    case "ZodObject": {
      const properties = {}, required = [];
      for (const [key, value] of Object.entries(def.shape())) { properties[key] = fromZod(value); if (!value.isOptional()) required.push(key); }
      const out = { type: "object", properties, ...(required.length ? { required } : {}) };
      if (def.unknownKeys === "strict") out.additionalProperties = false;
      else if (def.catchall && def.catchall._def.typeName !== "ZodNever") out.additionalProperties = fromZod(def.catchall);
      return described(out);
    }
    case "ZodString": {
      const out = { type: "string" };
      for (const check of def.checks) {
        if (check.kind === "min") out.minLength = check.value; else if (check.kind === "max") out.maxLength = check.value;
        else if (check.kind === "length") out.minLength = out.maxLength = check.value; else if (check.kind === "regex") out.pattern = check.regex.source;
        else if (check.kind === "datetime") out.format = "date-time"; else if (check.kind === "email") out.format = "email";
        else if (check.kind === "uuid") out.format = "uuid"; else if (check.kind === "url") out.format = "uri";
      }
      return described(out);
    }
    case "ZodNumber": {
      const out = { type: def.checks.some((check) => check.kind === "int") ? "integer" : "number" };
      for (const check of def.checks) {
        if (check.kind === "min") out[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
        else if (check.kind === "max") out[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
      }
      return described(out);
    }
    case "ZodBoolean": return described({ type: "boolean" });
    case "ZodNull": return described({ type: "null" });
    case "ZodDate": return described({ type: "string", format: "date-time" });
    case "ZodLiteral": return described({ type: def.value === null ? "null" : typeof def.value === "boolean" ? "boolean" : typeof def.value === "number" ? (Number.isInteger(def.value) ? "integer" : "number") : "string", const: def.value });
    case "ZodEnum": return described({ type: "string", enum: [...def.values] });
    case "ZodNativeEnum": return described({ enum: Object.values(def.values) });
    case "ZodArray": {
      const out = { type: "array", items: fromZod(def.type) };
      if (def.exactLength) out.minItems = out.maxItems = def.exactLength.value;
      else { if (def.minLength) out.minItems = def.minLength.value; if (def.maxLength) out.maxItems = def.maxLength.value; }
      return described(out);
    }
    case "ZodTuple": return described({ type: "array", prefixItems: def.items.map(fromZod), minItems: def.items.length, maxItems: def.items.length });
    case "ZodRecord": return described({ type: "object", additionalProperties: fromZod(def.valueType) });
    case "ZodUnion": return described({ anyOf: def.options.map(fromZod) });
    case "ZodDiscriminatedUnion": return described({ oneOf: [...(def.options.values ? def.options.values() : def.options)].map(fromZod) });
    case "ZodIntersection": return described({ allOf: [fromZod(def.left), fromZod(def.right)] });
    case "ZodNullable": {
      const inner = fromZod(def.innerType);
      return described(typeof inner.type === "string" && !inner.enum && inner.const === undefined ? { ...inner, type: [inner.type, "null"] } : { anyOf: [inner, { type: "null" }] });
    }
    case "ZodOptional": return described(fromZod(def.innerType));
    case "ZodDefault": return described({ ...fromZod(def.innerType), default: def.defaultValue() });
    case "ZodEffects": return described(fromZod(def.schema));
    case "ZodPipeline": return described(fromZod(def.in));
    case "ZodBranded": case "ZodReadonly": case "ZodCatch": return described(fromZod(def.type ?? def.innerType));
    case "ZodLazy": return described(fromZod(def.getter()));
    case "ZodAny": case "ZodUnknown": return described({});
    default: throw new Error(`The contract generator cannot describe a ${kind}; extend fromZod.`);
  }
}
// A component from a shared zod definition, and one described by hand. Both carry a description (documentation check).
const derived = (name, zodSchema, description) => { schemas[name] = { ...fromZod(zodSchema), description }; return ref(name); };
const described = (name, schema, description) => { schemas[name] = { ...schema, description }; return ref(name); };
const nullable = (schema) => ({ type: [schema.type, "null"] });
const strings = { type: "array", items: str };
const keyHeader = { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 }, description: "One key per unchanged intention. The same key with different input is refused; a key whose request was refused cannot run again; a key whose outcome was lost recovers the original result." };
const journalOffset = { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 100000 }, description: "Rows to skip in the newest-first order; pages hold 25 rows." };
const operation = (path, method, id, response, body, params, summary, description) => { add(path, method, id, response, body, params); describe(path, method, summary, description); };

// Operations journal (the recovery middleware and the pilot router).
described("Message", obj({ message: str }), "A confirmation in plain words; nothing else changed that the caller needs to read back.");
described("OperationView", obj({ id: str, label: str, actor: str, role: str, status: { type: "string", enum: ["pending", "completed", "cancelled"] }, createdAt: str, updatedAt: str, message: str, recordId: nullable(str), recordKind: nullable(str) }), "One journal entry: what was asked, by whom, in which role, and whether the service confirmed it. Original request bodies stay private; a completed entry names the record it produced. A refused entry is cancelled and its message says why.");
described("OperationList", obj({ items: arr("OperationView"), total: num, offset: num }), "The caller's journal for one lender, newest first, 25 rows a page.");
described("OperationReplayResult", { type: "object", additionalProperties: true }, "The original route's answer, recovered or re-run under the current validation and authorisation; its shape is that route's response.");
operation("/v1/operations", "get", "listOperations", "OperationList", null, [merchant, journalOffset], "List the caller's recovery journal", "Every keyed, recoverable request the caller made in this lender, with its confirmation state. Read-only; private to the person who made the requests.");
operation("/v1/operations/{id}/retry", "post", "retryOperation", "OperationReplayResult", null, [pathParam("id"), merchant], "Recover or repeat a journaled request", "Re-enters the original route with the stored request and key under the current rules. A completed entry returns its saved result; a cancelled or refused one is refused (409); a different role cannot repeat it (403).");
operation("/v1/operations/{id}/cancel", "post", "cancelOperation", "Message", null, [pathParam("id"), merchant], "Cancel an unconfirmed request", "Confirms with the server that the request never completed and closes it, so its key cannot run again. A completed entry, or one whose receipt already exists, is refused (409).");

// Pilot journey, import batches and case handover.
described("JourneyCounts", obj({ customers: num, batches: num, receipts: num, openCases: num, unassignedCases: num, closes: num, exports: num }), "Record counts that place the lender on the pilot journey: customers, committed batches, receipts, open and unassigned cases, closes and ready exports.");
described("PilotJourney", obj({ lender: ref("Merchant"), accessMode: { type: "string", enum: ["sandbox", "staff"] }, actor: str, syntheticOnly: { type: "boolean", const: true }, counts: ref("JourneyCounts") }), "The lender, the caller's access mode and the counts behind the journey view. Synthetic throughout.");
described("ImportBatchList", obj({ items: arr("ValopayRecord"), total: num, offset: num }), "Import batches newest first, 25 a page, with their source identity, quality totals and check counts but not their rows. A batch saved before check summaries were stored is listed without check counts while the key service cannot open its check.");
described("ImportBatchDetail", obj({ batch: ref("ValopayRecord"), revisions: arr("ValopayRecord") }), "One batch with its source rows (import operator roles only) and every saved revision.");
described("BatchVersion", obj({ expectedUpdatedAt: str }), "The batch version being committed; a stale version is refused (409).");
derived("ImportBatchInput", shared.batchInputSchema, "A synthetic source batch: source, source batch ID, record kind, mapping, identity column, amount unit and up to 500 CSV rows. syntheticOnly must be true; raw bank details are refused.");
described("Assignee", obj({ actor: str, name: str, role: str }), "A person who can own a case or review a close: demo roles in the sandbox, active staff with lender access on a staff host.");
described("EvidenceLink", obj({ id: str, name: str, reference: str, kind: str }), "A record the case can cite as evidence.");
described("CaseDetail", obj({ record: ref("ValopayRecord"), assignees: arr("Assignee"), events: arr("ValopayRecord"), evidence: arr("EvidenceLink") }), "One exception with the people it can be handed to, its handover events and the records it can cite.");
derived("CaseInput", shared.caseInputSchema, "A case handover or update: assignee, next action and its time, note and evidence, with the version being changed.");
derived("PilotLenderInput", shared.lenderInputSchema, "A new synthetic lender: name and segment. A sandbox workspace holds at most five lenders, the two samples included.");
operation("/v1/pilot/journey", "get", "getPilotJourney", "PilotJourney", null, [merchant], "Read the pilot journey counts", "Counts of the records each pilot step needs, for the journey page. No record is created by reading.");
operation("/v1/pilot/lenders", "post", "createPilotLender", "Merchant", "PilotLenderInput", [keyHeader], "Create a synthetic lender", "An administrator: on a staff host with recent MFA; in a sandbox, the demo Administrator. A sandbox workspace holds at most five lenders, the two samples included, and a sixth is refused (409). The key makes creation repeatable; the same key with different details is refused.");
operation("/v1/pilot/batches", "get", "listImportBatches", "ImportBatchList", null, [merchant, journalOffset], "List import batches", "Newest first, 25 a page, without source rows.");
operation("/v1/pilot/batches/{id}", "get", "getImportBatch", "ImportBatchDetail", null, [pathParam("id"), merchant], "Open an import batch", "The batch with its source rows and revisions. Import operator roles only (403); unknown batches are 404.");
operation("/v1/pilot/batches", "post", "saveImportBatch", "ValopayRecord", "ImportBatchInput", [merchant, keyHeader], "Save a source batch", "Parses and checks the rows, screens them for raw bank details, and records the batch as ready or needing correction. A batch with the same source identity is refused (409).");
operation("/v1/pilot/batches/{id}/save", "post", "saveImportBatchRevision", "ValopayRecord", "ImportBatchInput", [pathParam("id"), merchant, keyHeader], "Correct an uncommitted batch", "Saves a revision of the batch, keeping its source identity. A committed batch or a stale version is refused (409).");
operation("/v1/pilot/batches/{id}/commit", "post", "commitImportBatch", "ValopayRecord", "BatchVersion", [pathParam("id"), merchant, keyHeader], "Commit a checked batch", "Imports the checked rows in one transaction and records the original source totals. A batch that is not ready, or a stale version, is refused (409).");
operation("/v1/pilot/cases/{id}", "get", "getCase", "CaseDetail", null, [pathParam("id"), merchant], "Open a case", "The exception with its possible assignees, handover history and citable evidence.");
operation("/v1/pilot/cases/{id}", "post", "coordinateCase", "ValopayRecord", "CaseInput", [pathParam("id"), merchant, keyHeader], "Hand over or update a case", "Records the assignee, next action and evidence, with the version being changed. The next action must be in the future.");

// Team and readiness.
described("StaffMember", obj({ id: str, actor: str, name: str, role: str, status: { type: "string", enum: ["active", "suspended", "revoked"] }, expiresAt: str, updatedAt: str, lenderIds: strings, allLenders: bool }, ["id", "actor", "name", "role", "status", "expiresAt", "updatedAt"]), "A staff membership: its role, state and expiry, and (in the directory) the lenders it may open; an administrator sees every lender.");
described("StaffInvitation", obj({ id: str, email: str, role: str, status: str, expiresAt: str }), "A pending, accepted or revoked invitation; the token is shown once, at creation.");
described("StaffEvent", obj({ id: str, actor: str, action: str, subject: str, detail: ref("RecordData"), createdAt: str }), "One entry of the team's access history.");
described("StaffDirectory", obj({ mode: { type: "string", enum: ["sandbox", "staff"] }, actor: str, members: arr("StaffMember"), lenders: arr("Merchant"), invitations: arr("StaffInvitation"), events: arr("StaffEvent"), message: str }), "The team as the caller may see it: members and lenders for everyone, invitations and history for administrators. In the sandbox the lists are empty and the message says why.");
derived("InvitationInput", shared.invitationInputSchema, "An invitation: email address and pilot role.");
described("InvitationCreated", obj({ id: str, token: str, message: str }), "The invitation and its one-time acceptance token; no email is sent.");
described("AcceptInvitationInput", obj({ token: { type: "string", pattern: "^[a-f0-9]{64}$" } }), "The acceptance token from the invitation link.");
described("InvitationAccepted", obj({ message: str, role: str }), "Confirmation of the new membership and its role.");
derived("MembershipInput", shared.membershipInputSchema, "A membership change: role, state, the version being changed and the reason.");
derived("StaffLenderAccessInput", shared.staffLenderAccessInputSchema, "The lenders a non-administrator membership may open, with the version being changed and the reason.");
described("StaffLenderAccess", obj({ ...schemas.StaffMember.properties, message: str }, [...schemas.StaffMember.required, "lenderIds", "allLenders", "message"]), "The membership with its saved lender access.");
described("ReadinessCheck", obj({ id: str, name: str, state: str, detail: str }), "One readiness control (identity, MFA, origins, database isolation, encryption) with its state on this host and what it means.");
described("AccessReadiness", obj({ syntheticOnly: { type: "boolean", const: true }, canCommission: bool, checkedAt: str, checks: arr("ReadinessCheck") }), "The staff-access and encryption controls as this request observed them. Describes configuration; never reveals secrets.");
described("EncryptionVerification", obj({ message: str, checkedAt: str, verified: bool }), "The result of sealing and opening a synthetic payload with the configured managed key.");
described("PayloadProtection", obj({ message: str, protectedCount: num, mayHaveMore: bool }), "How many stored payloads one bounded run protected, and whether another run is needed.");
operation("/v1/team/verify", "post", "verifyStaffIdentity", "Message", null, [], "Verify staff identity with a fresh second factor", "Staff hosts only (403 elsewhere). Requires a signed-in session with an enrolled second factor used recently; otherwise answers with the identity provider's re-verification instruction.");
operation("/v1/team", "get", "getTeam", "StaffDirectory", null, [], "Read the team directory", "Members, lenders, invitations and access history as the caller's role allows.");
operation("/v1/team/invitations", "post", "inviteStaff", "InvitationCreated", "InvitationInput", [], "Invite a staff member", "Administrator with recent MFA. Replaces any pending invitation for the same address; the token expires in seven days and is never emailed by the service.");
operation("/v1/team/invitations/{id}/revoke", "post", "revokeInvitation", "Message", null, [pathParam("id")], "Revoke an invitation", "Administrator with recent MFA. A revoked token cannot be accepted.");
operation("/v1/team/members/{id}", "patch", "updateStaffMember", "StaffMember", "MembershipInput", [pathParam("id")], "Change a membership", "Administrator with recent MFA; nobody changes their own membership. Records the reason in the access history.");
operation("/v1/team/members/{id}/lenders", "patch", "updateStaffLenders", "StaffLenderAccess", "StaffLenderAccessInput", [pathParam("id")], "Set a member's lender access", "Administrator with recent MFA. Non-administrators open only the lenders named here; sessions pick the change up on their next request.");
operation("/v1/team/accept", "post", "acceptInvitation", "InvitationAccepted", "AcceptInvitationInput", [], "Accept an invitation", "The signed-in person's verified email must match the invitation. Creates a 90-day membership.");
operation("/v1/team/readiness", "get", "getAccessReadiness", "AccessReadiness", null, [], "Read the access readiness checks", "What this host has configured and verified for real staff access, from the request's own checks.");
operation("/v1/team/readiness/encryption", "post", "verifyEncryption", "EncryptionVerification", null, [], "Verify managed payload encryption", "Administrator with recent MFA. Seals and opens a synthetic payload with the configured key (503 when none is configured).");
operation("/v1/team/readiness/protect", "post", "protectPayloads", "PayloadProtection", null, [], "Protect stored payloads", "Administrator with recent MFA. Seals one bounded batch of unprotected import rows and recovery payloads; run until none remain.");

// Close review and pilot progress.
described("ProgressStep", obj({ id: str, name: str, href: str, state: str, evidence: strings, missing: strings }), "One pilot step with its state, the evidence behind that state and what is still missing.");
described("PilotAccess", obj({ mode: str, state: str, message: str }), "Whether real staff access is enabled on this host and what demo progress does not establish.");
described("PilotProgress", obj({ lender: ref("Merchant"), syntheticOnly: { type: "boolean", const: true }, access: ref("PilotAccess"), steps: arr("ProgressStep") }), "The lender's progress through onboarding, ingestion, reconciliation, exceptions, close review and export, derived from its records.");
described("CloseReviewRecord", { allOf: [ref("ValopayRecord"), obj({ current: bool })] }, "A close review record with whether its snapshot still matches the close and its source evidence.");
described("CloseReviewEntry", obj({ close: ref("ValopayRecord"), issues: { type: "array", items: ref("RecordData") }, problem: nullable(str), pendingFinancialCorrections: num, reviews: arr("CloseReviewRecord") }), "One close with the discrepancies a reviewer must answer, why it cannot be reviewed now (if so), pending financial corrections and its reviews.");
described("CloseReviewList", obj({ closes: arr("CloseReviewEntry"), total: num, actor: str, reviewers: arr("Assignee"), accessMode: str, ownPrincipal: str }), "The 25 newest closes with their reviews, the Finance reviewers available and who the caller is, so the console can enforce separation of duties.");
derived("PrepareCloseReviewInput", shared.prepareCloseReviewSchema, "A close review preparation: the close and its version, an independent Finance reviewer, the preparation note and a response to every discrepancy.");
derived("DecideCloseReviewInput", shared.decideCloseReviewSchema, "A review decision: approve or reject with the version being decided, a note and an answer to every source exception.");
operation("/v1/pilot/progress", "get", "getPilotProgress", "PilotProgress", null, [merchant], "Read the pilot progress steps", "Derived from the lender's records on every read; nothing is written.");
operation("/v1/pilot/close-reviews", "get", "listCloseReviews", "CloseReviewList", null, [merchant], "List closes and their reviews", "Newest 25 closes with their discrepancies, review state and the available Finance reviewers.");
operation("/v1/pilot/close-reviews/prepare", "post", "prepareCloseReview", "ValopayRecord", "PrepareCloseReviewInput", [merchant, keyHeader], "Prepare a close for review", "Snapshots the close with its source-completeness basis and assigns an independent Finance reviewer. A close with an open review, a stale version or an unanswered discrepancy is refused.");
operation("/v1/pilot/close-reviews/{id}/decision", "post", "decideCloseReview", "ValopayRecord", "DecideCloseReviewInput", [pathParam("id"), merchant, keyHeader], "Approve or reject a close review", "Only the named reviewer decides, and only while the snapshot is current; a changed close or source declaration must be prepared again.");

// Import corrections.
derived("ImportCorrectionPreviewInput", shared.importCorrectionPreviewInputSchema, "The batch, the imported record with its version, and the supported field changes to compare.");
derived("ImportCorrectionPreview", shared.importCorrectionPreviewSchema, "The before/after comparison, the records the change touches, any blockers and the digest a proposal must quote.");
derived("ImportCorrectionProposalInput", shared.importCorrectionProposalInputSchema, "A proposal quoting the preview digest, naming an independent Finance reviewer, with the reason and evidence.");
derived("ImportCorrectionDecisionInput", shared.importCorrectionDecisionInputSchema, "Approve, reject or withdraw, quoting the proposal digest, with a reason.");
derived("ImportCorrectionView", shared.importCorrectionViewSchema, "A proposal with its preview, its decision if any, and whether the comparison is still current.");
derived("ImportCorrectionList", shared.importCorrectionsResponseSchema, "The batch's imported records, its proposals and the Finance reviewers available.");
const batchIdParam = { name: "batchId", in: "query", required: true, schema: { type: "string", maxLength: 100 }, description: "The committed import batch whose records may be corrected." };
operation("/v1/pilot/import-corrections", "get", "listImportCorrections", "ImportCorrectionList", null, [merchant, batchIdParam], "List import corrections for a batch", "The batch's imported records and every proposal with its current state.");
operation("/v1/pilot/import-corrections/preview", "post", "previewImportCorrection", "ImportCorrectionPreview", "ImportCorrectionPreviewInput", [merchant], "Compare a proposed correction", "Shows what would change, which closes and financial records it touches, and what blocks it. Nothing is written.");
operation("/v1/pilot/import-corrections", "post", "proposeImportCorrection", "ImportCorrectionView", "ImportCorrectionProposalInput", [merchant, keyHeader], "Propose an import correction", "Records the comparison as evidence for an independent Finance reviewer. A changed comparison, a missing reviewer or an open proposal on the same record is refused.");
operation("/v1/pilot/import-corrections/{id}/decision", "post", "decideImportCorrection", "ImportCorrectionView", "ImportCorrectionDecisionInput", [pathParam("id"), merchant, keyHeader], "Decide an import correction", "Only the named reviewer approves or rejects; the proposer may withdraw. Approval applies the change only while the comparison is current.");

// Sources: profiles, manifests, completeness and the Paystack test inbox.
derived("SourceProfileInput", shared.sourceProfileInputSchema, "A reusable synthetic source contract: mapping, identity column, amount unit, first expected delivery, cadence, grace and expected totals.");
derived("SourceManifestInput", shared.sourceManifestInputSchema, "The files and control totals expected for one WAT business date, or an explicit no-file declaration, with reason and evidence; a revision names the declaration it replaces.");
derived("SourceCompleteness", shared.sourceCompletenessSchema, "Whether the declared source files for a business date arrived complete, with each file's state, the profiles that expect a delivery by that date, undeclared batches and the issues Finance must answer.");
derived("SourceBatchQuality", shared.sourceBatchQualitySchema, "The original committed totals and checks of a source batch.");
derived("PaystackFixtureInput", shared.paystackFixtureInputSchema, "A recorded Paystack test scenario to deliver to the inbox.");
derived("ProviderReplayInput", shared.providerReplayInputSchema, "A replay of a stored provider event, with its version and the reason.");
described("SourceDelivery", obj({ status: str, missedDeliveries: num, nextExpectedAt: str, lastCommittedAt: nullable(str), lastBatchId: nullable(str) }), "Where a profile stands against its cadence: missed deliveries, the next expected time and the last committed batch.");
described("SourceProfile", { allOf: [ref("ValopayRecord"), obj({ delivery: ref("SourceDelivery") })] }, "A source profile record with its delivery state.");
described("SourceBatchSummary", obj({ id: str, name: str, source: str, sourceBatchId: str, kind: str, status: str, createdAt: str, quality: ref("SourceBatchQuality") }), "A batch as the sources page lists it, with its original quality totals.");
described("SourceSummary", obj({ lateSources: num, duplicateRows: num, conflictRows: num, batchesNeedingReview: num }), "Counts that need attention: late sources, duplicate and conflicting rows, batches needing review.");
described("ProviderEvent", obj({ id: str, name: str, status: str, reference: str, amountKobo: num, createdAt: str, updatedAt: str, mode: { type: "string", enum: ["fixture", "test"] }, message: str, deliveryCount: num, replayCount: num, financialRecordsCreated: { type: "integer", const: 0 } }), "A stored provider event: fixture or test mode, how often it was delivered and replayed, and the guarantee that it created no financial record.");
described("PaystackInbox", obj({ mode: { type: "string", const: "test_only" }, externalConnectionVerified: { type: "boolean", const: false }, canRunFixtures: bool, state: { type: "string", const: "configuration_required" }, message: str, events: arr("ProviderEvent"), total: num, quarantined: num, duplicates: num }), "The read-only Paystack test inbox: its fixed test-only state, the stored events and how many were quarantined or duplicated.");
described("SourcesView", obj({ completeness: ref("SourceCompleteness"), profiles: arr("SourceProfile"), batches: arr("SourceBatchSummary"), summary: ref("SourceSummary"), paystack: ref("PaystackInbox") }), "Everything the sources page shows for one lender and business date.");
described("PaystackFixtureResult", obj({ accepted: bool, duplicate: bool, event: ref("ProviderEvent") }), "Whether the fixture was accepted or recognised as a duplicate, and the stored event.");
const businessDateParam = { name: "businessDate", in: "query", schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, description: "The WAT business date to report completeness for; defaults to the current one." };
operation("/v1/sources", "get", "getSources", "SourcesView", null, [merchant, businessDateParam], "Read the sources page", "Completeness for the business date, profiles with delivery state, batches with quality totals and the Paystack test inbox.");
operation("/v1/sources/profiles", "post", "createSourceProfile", "ValopayRecord", "SourceProfileInput", [merchant], "Create a source profile", "One profile per source and record kind (409 otherwise). Import operator roles only.");
operation("/v1/sources/profiles/{id}/save", "post", "saveSourceProfile", "ValopayRecord", "SourceProfileInput", [pathParam("id"), merchant, keyHeader], "Change a source profile", "Saves a new version of the profile; batches keep the version they were checked against.");
operation("/v1/sources/manifests", "post", "saveSourceManifest", "ValopayRecord", "SourceManifestInput", [merchant, keyHeader], "Declare the expected source files", "Records what must arrive for a business date. A revision must name the current declaration; a source batch declared for another date is refused.");
operation("/v1/sources/paystack/fixtures", "post", "runPaystackFixture", "PaystackFixtureResult", "PaystackFixtureInput", [merchant, keyHeader], "Deliver a recorded Paystack scenario", "Runs a test-only fixture through the inbox. No external call is made and no financial record is created.");
operation("/v1/sources/events/{id}/replay", "post", "replayProviderEvent", "ProviderEvent", "ProviderReplayInput", [pathParam("id"), merchant, keyHeader], "Replay a stored provider event", "Re-processes the event with the reason recorded; duplicates are recognised and counted.");
// The Paystack test ingress: the address an operator registers with a Paystack test account, not a console call.
described("PaystackTestEvent", obj({ event: str, data: { type: "object", additionalProperties: {}, description: "The event's payload as Paystack sent it." } }), "A Paystack test event exactly as Paystack signed it. The signature covers these bytes, so the body is authenticated before it is parsed. charge.success and the two direct-debit authorisation events are recorded; any other signed event is acknowledged and recorded as ignored.");
described("PaystackDeliveryReceipt", obj({ accepted: { type: "boolean", const: true }, duplicate: bool }), "The acknowledgement Paystack receives: the signed event is saved in the mapped lender's inbox, or recognised as a repeat delivery of one already saved.");
const connectionIdParam = { name: "connectionId", in: "path", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" }, description: "The opaque ID an operator mapped to one synthetic lender in VALOPAY_PAYSTACK_CONNECTIONS; it alone selects the lender, and it is not a credential." };
const paystackSignature = { name: "x-paystack-signature", in: "header", required: true, schema: { type: "string", pattern: "^[a-fA-F0-9]{128}$" }, description: "HMAC-SHA512 of the exact request bytes under the configured test secret key, in hexadecimal." };
operation("/v1/providers/paystack/{connectionId}/events", "post", "receivePaystackTestEvent", "PaystackDeliveryReceipt", "PaystackTestEvent", [connectionIdParam, paystackSignature], "Receive a signed Paystack test event", "The address to register as the webhook URL of a Paystack test account. Off unless the host sets VALOPAY_PAYSTACK_INGRESS to test. The signature is checked on the raw bytes before any lender is locked or read, so a forged or tampered delivery gets 401 and nothing else. A verified event is saved as test-mode evidence only: it creates no payment, allocation, debit or mandate authority, and still needs independent verification. Not a console call: no sandbox, sign-in or Idempotency-Key, and at most 120 deliveries a minute per client address.");
Object.assign(paths["/v1/providers/paystack/{connectionId}/events"].post.responses, {
  "400": { description: "The body is not JSON bytes, the connection ID is malformed, or the signed event is inconsistent or from live mode" },
  "401": { description: "The signature does not match the exact bytes under the configured test key; nothing was locked, read or saved" },
  "403": { description: "With the lender locked, the mapping names another workspace, or the lender is not a synthetic lender in sandbox or observation mode with its kill switch on" },
  "404": { description: "No lender is mapped to this connection ID, or, when the lender cannot be locked, it is not in the mapped workspace (removed, or the mapping names the wrong lender or workspace); correct the connection mapping, since delivering again will not help" },
  "413": { description: "The body is larger than 256 KiB" },
  "429": { description: "More than 120 deliveries a minute from this client address; retry after the Retry-After seconds" },
  "503": { description: "The ingress is off or misconfigured, or the mapped lender is in its workspace but busy; Paystack delivers again" },
});

// Personal work.
derived("PersonalWorkView", shared.personalWorkViewSchema, "The caller's (or, for administrators, the team's) cases, handovers, reviews and notifications, paged and counted.");
derived("WorkReceiptInput", shared.workReceiptInputSchema, "The item being acknowledged, with its version.");
derived("WorkReceipt", shared.workReceiptSchema, "The recorded acknowledgement: who, what, and when.");
const workParams = [merchant,
  { name: "scope", in: "query", schema: { type: "string", enum: ["mine", "team"], default: "mine" }, description: "The caller's own work, or (administrators) the whole team's." },
  { name: "filter", in: "query", schema: { type: "string", enum: ["all", "overdue", "handover", "review", "unread"], default: "all" }, description: "Only overdue items, handovers, reviews or unread notifications." },
  { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 100000 }, description: "Rows to skip." },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 }, description: "Page size; defaults to 25." }];
operation("/v1/work", "get", "getPersonalWork", "PersonalWorkView", null, workParams, "Read personal work", "Derived from cases, reviews and notifications on every read; bounded and lender scoped.");
operation("/v1/work/notifications/read", "post", "readNotification", "WorkReceipt", "WorkReceiptInput", [merchant, keyHeader], "Mark a notification read", "Records who read it and when; the server supplies the recipient.");
operation("/v1/work/handovers/acknowledge", "post", "acknowledgeHandover", "WorkReceipt", "WorkReceiptInput", [merchant, keyHeader], "Acknowledge a handover", "Records that the assignee took the case over; a stale version is refused.");

// Retention and lifecycle (administrators only).
derived("LifecycleView", shared.lifecycleViewSchema, "The lender's retention policy, holds, bounded inventory of what the policy would touch, and saved retention runs.");
derived("LifecycleRunView", shared.lifecycleRunViewSchema, "One retention run: its reviewed manifest, approval state and per-item receipts.");
derived("RetentionPolicyInput", shared.retentionPolicyInputSchema, "The retention periods per kind, with the version being changed and the reason.");
derived("RetentionHoldInput", shared.retentionHoldInputSchema, "A hold on one item, or its release, with the reason.");
derived("LifecyclePreviewInput", shared.lifecyclePreviewInputSchema, "Which kinds to preview and the reason for the run.");
derived("LifecycleApproveInput", shared.lifecycleApproveInputSchema, "Approval of a previewed run, quoting its manifest digest.");
derived("LifecycleExecuteInput", shared.lifecycleExecuteInputSchema, "Execution of an approved run, quoting its manifest digest, in bounded batches.");
operation("/v1/lifecycle", "get", "getLifecycle", "LifecycleView", null, [merchant, journalOffset], "Read retention controls", "Administrators only (403). Policy, holds, inventory and runs for the lender.");
operation("/v1/lifecycle/runs/{id}", "get", "getLifecycleRun", "LifecycleRunView", null, [pathParam("id"), merchant], "Read a retention run", "Administrators only. The run's manifest and receipts.");
operation("/v1/lifecycle/policy", "post", "saveRetentionPolicy", "LifecycleView", "RetentionPolicyInput", [merchant, keyHeader], "Change the retention policy", "Administrators only. Keeps every previous policy version with its reason.");
operation("/v1/lifecycle/holds", "post", "setRetentionHold", "LifecycleView", "RetentionHoldInput", [merchant, keyHeader], "Place or release a hold", "Administrators only. A held item is never deleted by a run.");
operation("/v1/lifecycle/runs", "post", "previewLifecycleRun", "LifecycleRunView", "LifecyclePreviewInput", [merchant, keyHeader], "Preview a retention run", "Administrators only. Records the exact manifest of what would be deleted; nothing is deleted.");
operation("/v1/lifecycle/runs/{id}/approve", "post", "approveLifecycleRun", "LifecycleRunView", "LifecycleApproveInput", [pathParam("id"), merchant, keyHeader], "Approve a retention run", "Administrators only. The manifest digest must match the preview; a changed inventory must be previewed again.");
operation("/v1/lifecycle/runs/{id}/execute", "post", "executeLifecycleRun", "LifecycleRunView", "LifecycleExecuteInput", [pathParam("id"), merchant, keyHeader], "Execute an approved run", "Administrators only. Deletes in bounded batches with a receipt per item; blocked and failed items are reported, never skipped silently.");

fs.writeFileSync("lib/api-spec/openapi.json",JSON.stringify({openapi:"3.1.0",info:{title:"Valo Pay sandbox API",version:"1.1.0",description:"Valo Pay collections and connected banking sandbox API. All monetary fields are integer minor units (NGN kobo). Real data and all outbound provider instructions are disabled in connected modules."},servers:[{url:"/api"}],paths,components:{schemas}},null,2));
