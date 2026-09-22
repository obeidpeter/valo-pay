-- Additive migration. Apply to the synthetic development database after review.
-- This does not grant live-data access or change the existing RLS rehearsal.
BEGIN;
CREATE TABLE IF NOT EXISTS valopay_operations (
 id text PRIMARY KEY, merchant_id text NOT NULL REFERENCES valopay_merchants(id) ON DELETE CASCADE,
 owner text NOT NULL, actor text NOT NULL, role text NOT NULL, request_key text NOT NULL,
 request_hash text NOT NULL, request jsonb NOT NULL, label text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')), receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS valopay_operations_owner_page ON valopay_operations(merchant_id,owner,created_at,id);
CREATE TABLE IF NOT EXISTS valopay_teams (
 workspace_id text PRIMARY KEY REFERENCES valopay_workspaces(id), organization_id text NOT NULL UNIQUE, name text NOT NULL
);
CREATE TABLE IF NOT EXISTS valopay_staff_memberships (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES valopay_teams(workspace_id), user_id text NOT NULL,
 display_name text NOT NULL, role text NOT NULL CHECK(role IN ('Admin','Operations','Finance','Compliance reviewer','Read-only')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','revoked')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS valopay_staff_workspace_user ON valopay_staff_memberships(workspace_id,user_id);
CREATE TABLE IF NOT EXISTS valopay_staff_invitations (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES valopay_teams(workspace_id), email text NOT NULL, role text NOT NULL,
 token_hash text NOT NULL UNIQUE, invited_by text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS valopay_staff_events (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES valopay_teams(workspace_id), actor text NOT NULL,
 action text NOT NULL, subject text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
