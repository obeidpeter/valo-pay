/**
 * Executable synthetic outbox/inbox recovery foundation. No network/provider adapter is
 * accepted. The application and independent pre-call journal use distinct loopback databases.
 * Not imported by the web application and never enabled through a production environment flag.
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';

export type InstructionScope = { workspace: string; lender: string; purpose: 'synthetic-payment' };
export type SyntheticInstruction = InstructionScope & {
  economicKey: string; requestKey: string; amountKobo: string; currency: 'NGN';
  sourceDigest: string; authorityVersion: string; environment: 'synthetic';
};
export type Command = {
  id: string; workspace: string; lender: string; purpose: 'synthetic-payment';
  fingerprint: string; body: SyntheticInstruction; state: string; fence: string;
  authority_version: string; lease_until: Date | null;
};
type Fault = 'before-provider' | 'after-provider' | 'before-completion';
const scoped = (s: InstructionScope) => [s.workspace, s.lender, s.purpose];
const digest = (body: SyntheticInstruction) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
const idPattern = /^SYN-[a-zA-Z0-9_-]{1,100}$/;
function scope(s: InstructionScope) {
  if (!idPattern.test(s.workspace) || !idPattern.test(s.lender) || s.purpose !== 'synthetic-payment') throw Error('Synthetic scope required');
}
function freeze(input: SyntheticInstruction): SyntheticInstruction {
  scope(input);
  if (input.environment !== 'synthetic' || input.currency !== 'NGN'
    || !idPattern.test(input.economicKey) || !idPattern.test(input.requestKey)
    || !/^[1-9][0-9]{0,15}$/.test(input.amountKobo) || BigInt(input.amountKobo) > 9007199254740991n
    || !/^[1-9][0-9]{0,14}$/.test(input.authorityVersion)
    || !/^[a-f0-9]{64}$/.test(input.sourceDigest)) throw Error('Invalid frozen synthetic instruction');
  // Fixed field order; ignore no fields silently.
  const body: SyntheticInstruction = { workspace: input.workspace, lender: input.lender, purpose: input.purpose,
    economicKey: input.economicKey, requestKey: input.requestKey, amountKobo: input.amountKobo,
    currency: input.currency, sourceDigest: input.sourceDigest, authorityVersion: input.authorityVersion, environment: input.environment };
  if (Object.keys(input).some(k => !Object.hasOwn(body,k))) throw Error('Unknown instruction field');
  return body;
}
function connection(value: string) {
  const u = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['localhost','127.0.0.1','[::1]'].includes(u.hostname)
    || !/^\/valopay_instruction_(?:app|journal)_[a-z0-9_]+$/.test(u.pathname) || u.search || u.hash) throw Error('Disposable loopback instruction database required');
  return u;
}
export class SyntheticInstructionRecovery {
  private readonly app: pg.Pool;
  private readonly journal: pg.Pool;
  private readonly table: string;
  constructor(appUrl: string, journalUrl: string, schema: string) {
    const app = connection(appUrl), journal = connection(journalUrl);
    if (app.pathname === journal.pathname || !/^valopay_dispatch_staging_[a-z0-9_]{1,24}$/.test(schema)) throw Error('Separate application/journal databases and isolated schema required');
    this.table = `"${schema}"`;
    const limits = { max: 10, connectionTimeoutMillis: 5000, options: '-c statement_timeout=10000 -c lock_timeout=5000' };
    this.app = new pg.Pool({ connectionString: appUrl, ...limits });
    this.journal = new pg.Pool({ connectionString: journalUrl, ...limits });
  }
  async close() { await Promise.all([this.app.end(), this.journal.end()]); }
  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.app.connect();
    try { await c.query('BEGIN'); await c.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'"); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(()=>undefined); throw e; } finally { c.release(); }
  }
  async appoint(s: InstructionScope) {
    scope(s);
    await this.app.query(`INSERT INTO ${this.table}.authorities(workspace,lender,purpose,version) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING`, scoped(s));
  }
  async stop(s: InstructionScope) {
    scope(s);
    await this.app.query(`UPDATE ${this.table}.authorities SET stopped=true,version=version+1 WHERE workspace=$1 AND lender=$2 AND purpose=$3`,scoped(s));
  }
  async enqueue(input: SyntheticInstruction): Promise<Command> {
    const body = freeze(input), fingerprint = digest(body);
    return this.tx(async c => {
      const a = await c.query(`SELECT * FROM ${this.table}.authorities WHERE workspace=$1 AND lender=$2 AND purpose=$3 FOR UPDATE`,scoped(body));
      if (!a.rows[0] || a.rows[0].stopped || a.rows[0].version !== body.authorityVersion) throw Error('Current synthetic authority required');
      const prior = await c.query(`SELECT * FROM ${this.table}.commands WHERE workspace=$1 AND lender=$2 AND purpose=$3 AND request_key=$4`,[...scoped(body),body.requestKey]);
      if (prior.rows[0]) { if (prior.rows[0].fingerprint !== fingerprint) throw Error('Request key identifies another instruction'); return prior.rows[0]; }
      // An app database restored before enqueue cannot silently forget an earlier dispatch of this economic unit.
      const intent = await this.journal.query(`SELECT command_id,fingerprint FROM ${this.table}.dispatch_intents WHERE workspace=$1 AND lender=$2 AND purpose=$3 AND economic_key=$4`,[...scoped(body),body.economicKey]);
      if (intent.rows[0]) throw Error('Independent dispatch evidence exists; reconcile it before any new instruction');
      const row = await c.query(`INSERT INTO ${this.table}.commands(id,workspace,lender,purpose,economic_key,request_key,fingerprint,body,authority_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),...scoped(body),body.economicKey,body.requestKey,fingerprint,body,body.authorityVersion]);
      return row.rows[0];
    });
  }
  async read(s: InstructionScope, id: string): Promise<Command | undefined> {
    scope(s);
    return (await this.app.query(`SELECT * FROM ${this.table}.commands WHERE workspace=$1 AND lender=$2 AND purpose=$3 AND id=$4`,[...scoped(s),id])).rows[0];
  }
  async claim(input: InstructionScope, id: string, leaseMs = 30000): Promise<Command | undefined> {
    const s = { ...input };
    scope(s);
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 60000) throw Error('Invalid bounded lease');
    return this.tx(async c => {
      const a = (await c.query(`SELECT * FROM ${this.table}.authorities WHERE workspace=$1 AND lender=$2 AND purpose=$3 FOR UPDATE`,scoped(s))).rows[0];
      if (!a || a.stopped) return undefined;
      return (await c.query(`UPDATE ${this.table}.commands SET state='claimed',fence=fence+1,lease_until=clock_timestamp()+($5::int*interval '1 millisecond'),updated_at=clock_timestamp()
        WHERE workspace=$1 AND lender=$2 AND purpose=$3 AND id=$4 AND authority_version=$6
        AND (state='queued' OR (state='claimed' AND lease_until<clock_timestamp())) RETURNING *`,[...scoped(s),id,leaseMs,a.version])).rows[0];
    });
  }
  private async current(c: PoolClient, command: Command) {
    const a = (await c.query(`SELECT * FROM ${this.table}.authorities WHERE workspace=$1 AND lender=$2 AND purpose=$3 FOR UPDATE`,scoped(command))).rows[0];
    const row = (await c.query(`SELECT * FROM ${this.table}.commands WHERE workspace=$1 AND lender=$2 AND purpose=$3 AND id=$4 FOR UPDATE`,[...scoped(command),command.id])).rows[0];
    if (!a || a.stopped || a.version !== command.authority_version || !row || row.state !== 'claimed'
      || row.authority_version !== command.authority_version
      || row.fence !== command.fence || row.fingerprint !== command.fingerprint
      || !(await c.query('SELECT $1::timestamptz > clock_timestamp() AS fresh',[row.lease_until])).rows[0].fresh) throw Error('Claim or current authority is no longer valid');
    return row as Command;
  }
  private async unknown(command: Command) {
    await this.app.query(`UPDATE ${this.table}.commands SET state='unknown',lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND fence=$2 AND state='claimed'`,[command.id,command.fence]);
  }
  /** No remote callback exists. The sole provider is a deterministic, persisted synthetic receipt. */
  async dispatch(input: Command, inputOptions: { outcome?: 'succeeded'|'failed'; fault?: Fault } = {}) {
    const command = structuredClone(input), options = { ...inputOptions };
    const body = freeze(command.body);
    if (digest(body) !== command.fingerprint || command.workspace !== body.workspace || command.lender !== body.lender
      || command.purpose !== body.purpose || command.authority_version !== body.authorityVersion) throw Error('Frozen instruction changed');
    if (options.outcome && !['succeeded','failed'].includes(options.outcome)) throw Error('Invalid synthetic outcome');
    await this.tx(async c => { await this.current(c,command); });
    // Must commit outside the app transaction before any provider work. A journal outage means no call.
    let reserved;
    try {
      reserved = await this.journal.query(`INSERT INTO ${this.table}.dispatch_intents(command_id,workspace,lender,purpose,economic_key,fingerprint,body) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING command_id`,[command.id,...scoped(command),body.economicKey,command.fingerprint,body]);
    } catch (error) { await this.unknown(command); throw error; }
    if (!reserved.rowCount) { await this.unknown(command); return { state:'unknown', dispatched:false }; }
    if (options.fault === 'before-provider') { await this.unknown(command); return { state:'unknown',dispatched:false }; }
    try {
      // Lock current authority and fence through the SYNTHETIC acceptance. A real adapter must not copy
      // this long-transaction pattern; it needs provider-contract acceptance and a stop-epoch protocol.
      await this.tx(async c => {
        await this.current(c,command);
        await this.journal.query(`INSERT INTO ${this.table}.synthetic_receipts(command_id,outcome) VALUES($1,$2) ON CONFLICT DO NOTHING`,[command.id,options.outcome ?? 'succeeded']);
      });
    } catch (e) { await this.unknown(command); throw e; }
    if (options.fault === 'after-provider' || options.fault === 'before-completion') { await this.unknown(command); return { state:'unknown',dispatched:true }; }
    return { state:await this.reconcile(command,command.id), dispatched:true };
  }
  /** Status-only reconciliation is safe after stop/revocation: it records evidence, never resends. */
  async reconcile(input: InstructionScope, id: string): Promise<string> {
    const s = { ...input };
    scope(s);
    const evidence = (await this.journal.query(`SELECT i.*,r.outcome FROM ${this.table}.dispatch_intents i LEFT JOIN ${this.table}.synthetic_receipts r USING(command_id) WHERE i.workspace=$1 AND i.lender=$2 AND i.purpose=$3 AND i.command_id=$4`,[...scoped(s),id])).rows[0];
    if (!evidence) throw Error('Independent instruction evidence not found');
    return this.tx(async c => {
      const row: Command | undefined = (await c.query(`SELECT * FROM ${this.table}.commands WHERE workspace=$1 AND lender=$2 AND purpose=$3 AND id=$4 FOR UPDATE`,[...scoped(s),id])).rows[0];
      if (!row || row.fingerprint !== evidence.fingerprint || digest(freeze(row.body)) !== evidence.fingerprint) throw Error('Instruction evidence does not match frozen source');
      if (!evidence.outcome) {
        if (['succeeded','failed','cancelled'].includes(row.state)) throw Error('Terminal instruction conflicts with missing receipt');
        await c.query(`UPDATE ${this.table}.commands SET state='unknown',lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1`,[id]);
        return 'unknown';
      }
      if (['succeeded','failed','cancelled'].includes(row.state)) { if(row.state!==evidence.outcome) throw Error('Conflicting terminal outcome'); return row.state; }
      await c.query(`INSERT INTO ${this.table}.inbox(workspace,lender,purpose,provider_reference,command_id,fingerprint,outcome) VALUES($1,$2,$3,$4,$4,$5,$6) ON CONFLICT DO NOTHING`,[...scoped(s),id,evidence.fingerprint,evidence.outcome]);
      const receipt = (await c.query(`SELECT * FROM ${this.table}.inbox WHERE command_id=$1`,[id])).rows[0];
      if (receipt?.fingerprint !== row.fingerprint || receipt?.outcome !== evidence.outcome
        || receipt.workspace !== s.workspace || receipt.lender !== s.lender || receipt.purpose !== s.purpose
        || receipt.provider_reference !== id) throw Error('Conflicting inbox evidence');
      await c.query(`UPDATE ${this.table}.commands SET state=$2,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1`,[id,evidence.outcome]);
      return evidence.outcome;
    });
  }
  /** Reconstruct an app-database loss only from frozen independent evidence. Never queues a new send. */
  async recover(input: InstructionScope, id: string) {
    const s = { ...input };
    scope(s);
    const row = (await this.journal.query(`SELECT * FROM ${this.table}.dispatch_intents WHERE workspace=$1 AND lender=$2 AND purpose=$3 AND command_id=$4`,[...scoped(s),id])).rows[0];
    if (!row || digest(freeze(row.body)) !== row.fingerprint) throw Error('Valid independent evidence required');
    const body: SyntheticInstruction = row.body;
    // Persist the stop separately: even a subsequent identity conflict must leave the scope stopped.
    await this.app.query(`INSERT INTO ${this.table}.authorities(workspace,lender,purpose,version,stopped) VALUES($1,$2,$3,$4,true)
        ON CONFLICT(workspace,lender,purpose) DO UPDATE SET stopped=true,version=GREATEST(authorities.version,EXCLUDED.version)`,[...scoped(s),body.authorityVersion]);
    await this.tx(async c => {
      await c.query(`INSERT INTO ${this.table}.commands(id,workspace,lender,purpose,economic_key,request_key,fingerprint,body,authority_version,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'unknown') ON CONFLICT DO NOTHING`,[id,...scoped(s),body.economicKey,body.requestKey,row.fingerprint,body,body.authorityVersion]);
      const restored = (await c.query(`SELECT * FROM ${this.table}.commands WHERE workspace=$1 AND lender=$2 AND purpose=$3 AND id=$4`,[...scoped(s),id])).rows[0];
      if (restored?.fingerprint !== row.fingerprint) throw Error('Recovered command conflicts with existing identity');
    });
    return this.reconcile(s,id);
  }
}
