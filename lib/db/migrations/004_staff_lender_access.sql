-- Explicit grants for non-administrator staff. Existing worker memberships
-- deliberately receive no automatic grants; Admin retains workspace oversight.
BEGIN;
CREATE TABLE IF NOT EXISTS valopay_staff_lender_access (
 membership_id text NOT NULL CONSTRAINT valopay_staff_lender_access_membership_id_valopay_staff_memberships_id_fk REFERENCES valopay_staff_memberships(id) ON DELETE CASCADE,
 merchant_id text NOT NULL CONSTRAINT valopay_staff_lender_access_merchant_id_valopay_merchants_id_fk REFERENCES valopay_merchants(id) ON DELETE CASCADE,
 granted_by text NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT valopay_staff_lender_access_membership_id_merchant_id_pk PRIMARY KEY(membership_id,merchant_id)
);
CREATE INDEX IF NOT EXISTS valopay_staff_lender_access_lender ON valopay_staff_lender_access(merchant_id,membership_id);
COMMIT;
