-- Additive migration. Apply to the synthetic development database after review.
-- This does not grant live-data access or change the existing RLS rehearsal.
-- Every constraint carries the name the Drizzle schema in lib/db gives it, so a
-- database built by this file and one built by drizzle-kit push are identical;
-- the pilot workflow migration rehearsal checks that on a throwaway database.
-- It is repeatable. Creating a table locks the tables its foreign keys name,
-- and creating an index locks its table even when the index exists, so an
-- open write on one of those tables holds it back, and writes that come after
-- it wait behind it. The lock wait is limited to 5 s and each statement to
-- 60 s: if either limit is reached nothing changes, and it can be run again
-- at a quieter moment.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS valopay_operations (
 id text PRIMARY KEY, merchant_id text NOT NULL CONSTRAINT valopay_operations_merchant_id_valopay_merchants_id_fk REFERENCES valopay_merchants(id) ON DELETE CASCADE,
 owner text NOT NULL, actor text NOT NULL, role text NOT NULL, request_key text NOT NULL,
 request_hash text NOT NULL, request jsonb NOT NULL, label text NOT NULL,
 status text NOT NULL DEFAULT 'pending', receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT valopay_operation_status CHECK(status IN ('pending','completed','cancelled'))
);
CREATE INDEX IF NOT EXISTS valopay_operations_owner_page ON valopay_operations(merchant_id,owner,created_at,id);
CREATE TABLE IF NOT EXISTS valopay_teams (
 workspace_id text PRIMARY KEY CONSTRAINT valopay_teams_workspace_id_valopay_workspaces_id_fk REFERENCES valopay_workspaces(id),
 organization_id text NOT NULL CONSTRAINT valopay_teams_organization_id_unique UNIQUE, name text NOT NULL
);
CREATE TABLE IF NOT EXISTS valopay_staff_memberships (
 id text PRIMARY KEY, workspace_id text NOT NULL CONSTRAINT valopay_staff_memberships_workspace_id_valopay_teams_workspace_id_fk REFERENCES valopay_teams(workspace_id), user_id text NOT NULL,
 display_name text NOT NULL, role text NOT NULL,
 status text NOT NULL DEFAULT 'active',
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT valopay_staff_status CHECK(status IN ('active','suspended','revoked')),
 CONSTRAINT valopay_staff_role CHECK(role IN ('Admin','Operations','Finance','Compliance reviewer','Read-only'))
);
CREATE UNIQUE INDEX IF NOT EXISTS valopay_staff_workspace_user ON valopay_staff_memberships(workspace_id,user_id);
CREATE TABLE IF NOT EXISTS valopay_staff_invitations (
 id text PRIMARY KEY, workspace_id text NOT NULL CONSTRAINT valopay_staff_invitations_workspace_id_valopay_teams_workspace_id_fk REFERENCES valopay_teams(workspace_id), email text NOT NULL, role text NOT NULL,
 token_hash text NOT NULL CONSTRAINT valopay_staff_invitations_token_hash_unique UNIQUE, invited_by text NOT NULL,
 status text NOT NULL DEFAULT 'pending',
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT valopay_invitation_status CHECK(status IN ('pending','accepted','revoked'))
);
CREATE TABLE IF NOT EXISTS valopay_staff_events (
 id text PRIMARY KEY, workspace_id text NOT NULL CONSTRAINT valopay_staff_events_workspace_id_valopay_teams_workspace_id_fk REFERENCES valopay_teams(workspace_id), actor text NOT NULL,
 action text NOT NULL, subject text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
