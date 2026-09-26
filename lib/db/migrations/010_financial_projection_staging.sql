-- Explicit owner-run staging migration. Never part of Drizzle push or API startup.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$ BEGIN
  IF current_schema() !~ '^valopay_finance_staging_[a-z0-9_]{1,32}$'
     OR current_setting('valopay.financial_migration', true) IS DISTINCT FROM 'staging-only' THEN
    RAISE EXCEPTION 'Financial projection migration requires an isolated valopay_finance_staging_* schema and staging-only opt-in';
  END IF;
  -- pg_temp is implicitly first for relations unless explicitly placed last.
  EXECUTE format('SET LOCAL search_path TO %I,pg_catalog,pg_temp',current_schema());
END $$;

CREATE TABLE financial_projection_metadata (version integer PRIMARY KEY CHECK(version=1), signature text NOT NULL);
CREATE TABLE financial_scopes (
  workspace_id text NOT NULL, lender_id text NOT NULL,
  lock_version bigint NOT NULL DEFAULT 0,
  source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,lender_id)
);
CREATE TABLE financial_receipts (
  workspace_id text NOT NULL, lender_id text NOT NULL, id text NOT NULL,
  customer_id text NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  amount_kobo numeric NOT NULL CHECK(amount_kobo=trunc(amount_kobo) AND amount_kobo BETWEEN 0 AND 9007199254740991),
  returned_kobo numeric NOT NULL CHECK(returned_kobo=trunc(returned_kobo) AND returned_kobo BETWEEN 0 AND amount_kobo),
  source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(workspace_id,lender_id,id),
  UNIQUE(workspace_id,lender_id,id,customer_id,currency),
  FOREIGN KEY(workspace_id,lender_id) REFERENCES financial_scopes(workspace_id,lender_id)
);
CREATE TABLE financial_obligations (
  workspace_id text NOT NULL, lender_id text NOT NULL, id text NOT NULL,
  customer_id text NOT NULL CHECK(customer_id<>''), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  amount_kobo numeric NOT NULL CHECK(amount_kobo=trunc(amount_kobo) AND amount_kobo BETWEEN 0 AND 9007199254740991),
  source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(workspace_id,lender_id,id),
  UNIQUE(workspace_id,lender_id,id,customer_id,currency),
  FOREIGN KEY(workspace_id,lender_id) REFERENCES financial_scopes(workspace_id,lender_id)
);
CREATE TABLE financial_allocations (
  workspace_id text NOT NULL, lender_id text NOT NULL, id text NOT NULL,
  receipt_id text NOT NULL, obligation_id text NOT NULL,
  customer_id text NOT NULL CHECK(customer_id<>''), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  amount_kobo numeric NOT NULL CHECK(amount_kobo=trunc(amount_kobo) AND amount_kobo BETWEEN 0 AND 9007199254740991),
  source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(workspace_id,lender_id,id),
  FOREIGN KEY(workspace_id,lender_id,receipt_id,customer_id,currency)
    REFERENCES financial_receipts(workspace_id,lender_id,id,customer_id,currency),
  FOREIGN KEY(workspace_id,lender_id,obligation_id,customer_id,currency)
    REFERENCES financial_obligations(workspace_id,lender_id,id,customer_id,currency)
);
CREATE INDEX financial_allocations_receipt ON financial_allocations(workspace_id,lender_id,receipt_id);
CREATE INDEX financial_allocations_obligation ON financial_allocations(workspace_id,lender_id,obligation_id);

-- Updating (not merely locking) the scope makes concurrent REPEATABLE READ writers
-- conflict as well. READ COMMITTED trigger queries see earlier committed allocations.
CREATE FUNCTION financial_scope_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.lender_id,NEW.id) IS DISTINCT FROM (OLD.workspace_id,OLD.lender_id,OLD.id) THEN
    RAISE EXCEPTION 'Financial record identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN
    UPDATE financial_scopes SET lock_version=lock_version+1 WHERE workspace_id=OLD.workspace_id AND lender_id=OLD.lender_id;
    RETURN OLD;
  END IF;
  UPDATE financial_scopes SET lock_version=lock_version+1 WHERE workspace_id=NEW.workspace_id AND lender_id=NEW.lender_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Financial scope does not exist' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION financial_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace text; lender text;
BEGIN
  workspace:=NEW.workspace_id; lender:=NEW.lender_id;
  IF EXISTS (
    SELECT 1 FROM financial_receipts r
    WHERE r.workspace_id=workspace AND r.lender_id=lender AND
      r.returned_kobo + COALESCE((SELECT sum(a.amount_kobo) FROM financial_allocations a
        WHERE (a.workspace_id,a.lender_id,a.receipt_id)=(r.workspace_id,r.lender_id,r.id)),0)>r.amount_kobo
  ) THEN RAISE EXCEPTION 'Allocations and returned money exceed receipt amount' USING ERRCODE='23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM financial_obligations o
    WHERE o.workspace_id=workspace AND o.lender_id=lender AND
      COALESCE((SELECT sum(a.amount_kobo) FROM financial_allocations a
        WHERE (a.workspace_id,a.lender_id,a.obligation_id)=(o.workspace_id,o.lender_id,o.id)),0)>o.amount_kobo
  ) THEN RAISE EXCEPTION 'Allocations exceed obligation amount' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_receipts_lock BEFORE INSERT OR UPDATE OR DELETE ON financial_receipts FOR EACH ROW EXECUTE FUNCTION financial_scope_lock();
CREATE TRIGGER financial_obligations_lock BEFORE INSERT OR UPDATE OR DELETE ON financial_obligations FOR EACH ROW EXECUTE FUNCTION financial_scope_lock();
CREATE TRIGGER financial_allocations_lock BEFORE INSERT OR UPDATE OR DELETE ON financial_allocations FOR EACH ROW EXECUTE FUNCTION financial_scope_lock();
CREATE TRIGGER financial_receipts_conservation AFTER INSERT OR UPDATE ON financial_receipts FOR EACH ROW EXECUTE FUNCTION financial_conservation();
CREATE TRIGGER financial_obligations_conservation AFTER INSERT OR UPDATE ON financial_obligations FOR EACH ROW EXECUTE FUNCTION financial_conservation();
CREATE TRIGGER financial_allocations_conservation AFTER INSERT OR UPDATE ON financial_allocations FOR EACH ROW EXECUTE FUNCTION financial_conservation();

-- Functions always resolve inside this dedicated schema; callers cannot redirect
-- their table names by supplying another search_path.
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION financial_scope_lock() SET search_path=%I,pg_catalog,pg_temp',current_schema());
  EXECUTE format('ALTER FUNCTION financial_conservation() SET search_path=%I,pg_catalog,pg_temp',current_schema());
END $$;
INSERT INTO financial_projection_metadata VALUES(1,'pending');
UPDATE financial_projection_metadata SET signature=(
 SELECT md5(string_agg(definition,E'\n' ORDER BY definition)) FROM (
   SELECT 'column:'||c.relname||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') AS definition
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
   LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=current_schema() AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
   UNION ALL SELECT 'constraint:'||c.relname||':'||k.conname||':'||k.convalidated||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()
   UNION ALL SELECT 'index:'||pg_get_indexdef(i.indexrelid)||':'||i.indisvalid||':'||i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()
   UNION ALL SELECT 'trigger:'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT t.tgisinternal
   UNION ALL SELECT 'function:'||pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema()
 ) definitions
);
COMMIT;
