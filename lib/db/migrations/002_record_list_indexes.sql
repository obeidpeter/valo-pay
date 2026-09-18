-- Read-performance indexes only. No row, permission, RLS, constraint, or setting changes.
-- Apply with scripts/apply-record-list-indexes.mjs after its read-only inspection.
-- The runner executes only missing statements after validating existing indexes.
-- Do not wrap in BEGIN/COMMIT: PostgreSQL concurrent builds require autocommit.
-- Do not add IF NOT EXISTS: it would hide a conflicting or invalid same-name index.

CREATE INDEX CONCURRENTLY valopay_records_lender_kind_page ON public.valopay_records USING btree (merchant_id, kind, created_at, id);
CREATE INDEX CONCURRENTLY valopay_records_lender_kind_status_page ON public.valopay_records USING btree (merchant_id, kind, status, created_at, id);
CREATE INDEX CONCURRENTLY valopay_records_lender_customer ON public.valopay_records USING btree (merchant_id, customer_id, created_at, id);
CREATE INDEX CONCURRENTLY valopay_records_lender_kind_updated ON public.valopay_records USING btree (merchant_id, kind, updated_at);
