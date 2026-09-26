-- Apply only to the distinct disposable journal database, never the application database.
DO $$ BEGIN
  IF current_setting('valopay.instruction_migration', true) IS DISTINCT FROM 'synthetic-only'
     OR current_schema() !~ '^valopay_dispatch_staging_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Independent journal requires isolated synthetic staging and explicit opt-in';
  END IF;
END $$;
CREATE TABLE dispatch_intents (
  command_id uuid PRIMARY KEY, workspace text NOT NULL, lender text NOT NULL,
  purpose text NOT NULL CHECK(purpose='synthetic-payment'), economic_key text NOT NULL,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), body jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace,lender,purpose,economic_key)
);
-- Deterministic synthetic provider, in a different database failure domain from the outbox.
CREATE TABLE synthetic_receipts (
  command_id uuid PRIMARY KEY REFERENCES dispatch_intents(command_id),
  outcome text NOT NULL CHECK(outcome IN ('succeeded','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION refuse_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Independent dispatch evidence is append only';
END $$;
CREATE TRIGGER append_only_intent BEFORE UPDATE OR DELETE ON dispatch_intents FOR EACH ROW EXECUTE FUNCTION refuse_journal_mutation();
CREATE TRIGGER append_only_receipt BEFORE UPDATE OR DELETE ON synthetic_receipts FOR EACH ROW EXECUTE FUNCTION refuse_journal_mutation();
