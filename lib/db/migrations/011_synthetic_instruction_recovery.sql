-- Opt-in rehearsal only. Never applied by Drizzle, startup or deployment.
DO $$ BEGIN
  IF current_setting('valopay.instruction_migration', true) IS DISTINCT FROM 'synthetic-only'
     OR current_schema() !~ '^valopay_dispatch_staging_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Instruction recovery requires an isolated synthetic staging schema and explicit opt-in';
  END IF;
END $$;

CREATE TABLE authorities (
  workspace text NOT NULL, lender text NOT NULL, purpose text NOT NULL CHECK(purpose='synthetic-payment'),
  version bigint NOT NULL CHECK(version>0), stopped boolean NOT NULL DEFAULT false,
  PRIMARY KEY(workspace,lender,purpose)
);
CREATE TABLE commands (
  id uuid PRIMARY KEY, workspace text NOT NULL, lender text NOT NULL,
  purpose text NOT NULL CHECK(purpose='synthetic-payment'), economic_key text NOT NULL,
  request_key text NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL, authority_version bigint NOT NULL CHECK(authority_version>0),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','claimed','unknown','succeeded','failed','cancelled')),
  fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0), lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace,lender,purpose,request_key),
  UNIQUE(workspace,lender,purpose,id),
  FOREIGN KEY(workspace,lender,purpose) REFERENCES authorities(workspace,lender,purpose)
);
-- Success keeps the obligation owned. The app can release failed/cancelled ownership;
-- this conservative foundation still refuses any fresh send after independent intent exists.
CREATE UNIQUE INDEX one_obligation_owner ON commands(workspace,lender,purpose,economic_key)
  WHERE state NOT IN ('failed','cancelled');
CREATE INDEX claim_queue ON commands(created_at,id) WHERE state IN ('queued','claimed');
CREATE TABLE inbox (
  workspace text NOT NULL, lender text NOT NULL, purpose text NOT NULL,
  provider_reference uuid NOT NULL, command_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK(outcome IN ('succeeded','failed')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace,lender,purpose,provider_reference), UNIQUE(command_id),
  FOREIGN KEY(workspace,lender,purpose,command_id) REFERENCES commands(workspace,lender,purpose,id)
);
CREATE FUNCTION immutable_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.workspace,NEW.lender,NEW.purpose,NEW.economic_key,NEW.request_key,NEW.fingerprint,NEW.body,NEW.authority_version,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.workspace,OLD.lender,OLD.purpose,OLD.economic_key,OLD.request_key,OLD.fingerprint,OLD.body,OLD.authority_version,OLD.created_at) THEN
    RAISE EXCEPTION 'Frozen instruction identity cannot change';
  END IF;
  IF OLD.state IN ('succeeded','failed','cancelled') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal instruction cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER frozen_command BEFORE UPDATE ON commands FOR EACH ROW EXECUTE FUNCTION immutable_command();
CREATE FUNCTION immutable_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Inbox evidence is append only';
END $$;
CREATE TRIGGER frozen_receipt BEFORE UPDATE OR DELETE ON inbox FOR EACH ROW EXECUTE FUNCTION immutable_receipt();
