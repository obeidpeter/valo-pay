-- Explicit grants for non-administrator staff. Existing worker memberships
-- deliberately receive no automatic grants; Admin retains workspace oversight.
BEGIN;
CREATE TABLE IF NOT EXISTS valopay_staff_lender_access (
 membership_id text NOT NULL REFERENCES valopay_staff_memberships(id) ON DELETE CASCADE,
 merchant_id text NOT NULL REFERENCES valopay_merchants(id) ON DELETE CASCADE,
 granted_by text NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(membership_id,merchant_id)
);
CREATE INDEX IF NOT EXISTS valopay_staff_lender_access_lender ON valopay_staff_lender_access(merchant_id,membership_id);
COMMIT;
