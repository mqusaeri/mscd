-- Milestone 3 correction of the tenant schemas (docs/platform/MILESTONE-3.md R-14, J.7), written by M3-12 (hardening
-- follow-ups). Additive only: no earlier migration changes.

-- The disposal register keeps the retention period of each decision in a column (D.8, M3-06 follow-up): the months in
-- force when the review was decided, and for a disposal when it was approved. Null for reviews decided before this
-- migration; the register then reads the period from the audit entries `retention_review.decided` and
-- `retention_review.approved` as before. The range is the one of retention_rule.retain_months.
ALTER TABLE retention_review
  ADD COLUMN retain_months smallint CHECK (retain_months BETWEEN 1 AND 1200);

-- The grants of platform/0009_milestone3_fix.sql (SELECT on this schema's kysely_migration for mscd_app), with every
-- other right and policy as before.
SELECT platform.secure_tenant_schema(current_schema());
