-- Milestone 3 correction of the tenant schemas after the reviews of 2026-11-02 (docs/platform/MILESTONE-3.md R-14, M3-13).
-- Additive only: no earlier migration changes.
--
-- 1. A disposal deletes the content of a record (product owner decision 18, D.8): the five record classes that are
--    rows get `disposed_at`. The disposal clears their free-text and person columns (retention-model.ts
--    DISPOSAL_CLEARS), so the competence record no longer needs a person once disposed, and the CHECKs that need text
--    or a person on a closed record accept a disposed one. Those CHECKs have generated names, so they are found by
--    their definition in pg_constraint; the migration stops when it does not find exactly the two it expects.
ALTER TABLE audit_event ADD COLUMN disposed_at timestamptz;
ALTER TABLE finding ADD COLUMN disposed_at timestamptz;
ALTER TABLE corrective_action ADD COLUMN disposed_at timestamptz;
ALTER TABLE management_review ADD COLUMN disposed_at timestamptz;
ALTER TABLE competence_record ADD COLUMN disposed_at timestamptz;

ALTER TABLE competence_record ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE competence_record ADD CONSTRAINT competence_record_person_check CHECK (user_id IS NOT NULL OR disposed_at IS NOT NULL);

DO $$
DECLARE
  c record;
  changed integer := 0;
BEGIN
  FOR c IN
    SELECT con.conname, rel.relname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = current_schema() AND con.contype = 'c'
       AND ((rel.relname = 'finding'
             AND pg_get_constraintdef(con.oid) LIKE '%rca_text IS NOT NULL%systemic_check_text IS NOT NULL%')
         OR (rel.relname = 'corrective_action'
             AND pg_get_constraintdef(con.oid) LIKE '%verified_by_user_id IS NOT NULL%verified_at IS NOT NULL%effective IS NOT NULL%'))
       AND pg_get_constraintdef(con.oid) NOT LIKE '%disposed_at%'
     ORDER BY rel.relname, con.conname
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.relname, c.conname);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (disposed_at IS NOT NULL OR (%s))', c.relname, c.conname,
                   regexp_replace(c.def, '^CHECK \((.*)\)$', '\1'));
    changed := changed + 1;
  END LOOP;
  IF changed <> 2 THEN
    RAISE EXCEPTION 'Expected the two CHECKs of a closed major finding and a closed corrective action in %, found %', current_schema(), changed;
  END IF;
END $$;

-- 2. The erasure receipt (ISO M4): a document that names no person (organisation, request, subject kind, the erased
--    account id of a member, pseudonym, time and redaction ids), written by the erasure and signed with the audit anchor
--    key by the worker (`org.lifecycle`), which then emails it to the platform operators and the Tenant Admins. After a
--    restore from an older backup, `mscd-server tenant erasure --reapply <receipt>` erases the person again.
ALTER TABLE privacy_request
  ADD COLUMN erasure_receipt jsonb,
  ADD COLUMN erasure_receipt_signature varchar(120),
  ADD COLUMN erasure_receipt_key_id varchar(80),
  ADD COLUMN erasure_receipt_sent_at timestamptz,
  ADD CONSTRAINT privacy_request_receipt_check
    CHECK ((erasure_receipt_signature IS NULL) = (erasure_receipt_key_id IS NULL)
           AND (erasure_receipt_signature IS NULL OR erasure_receipt IS NOT NULL)
           AND (erasure_receipt_sent_at IS NULL OR erasure_receipt_signature IS NOT NULL));
CREATE INDEX privacy_request_receipt_idx ON privacy_request (created_at) WHERE erasure_receipt IS NOT NULL AND erasure_receipt_sent_at IS NULL;

-- 3. The grants of platform/0010_milestone3_review_fix.sql: the report login of on-premise installations no longer
--    reads privacy_request, privacy_check and erased_person (security review 5), with every other right as before.
SELECT platform.secure_tenant_schema(current_schema());
