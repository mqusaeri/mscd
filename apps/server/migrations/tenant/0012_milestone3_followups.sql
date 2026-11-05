-- Milestone 3 correction of the tenant schemas for the small follow-ups (docs/platform/MILESTONE-3.md R-14, J.7, M3-15).
-- Additive only: no earlier migration changes, and every value the earlier CHECK allowed stays allowed.
--
-- The disposal register says when the only file of a disposed record was kept because another live record still uses
-- it (M3-13 follow-up 1): retention_review.file_action accepts 'kept_in_use' next to 'vault_content_deleted',
-- 'owner_asked' and 'none'. The column CHECK of tenant/0009 has a generated name, so it is found by its definition in
-- pg_constraint; the migration stops when it does not find exactly one, and a schema that already accepts the value
-- keeps its CHECK. The new CHECK has a fixed name.
DO $$
DECLARE
  c record;
  found integer := 0;
BEGIN
  FOR c IN
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = current_schema() AND rel.relname = 'retention_review' AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%file_action%'
       AND pg_get_constraintdef(con.oid) LIKE '%vault_content_deleted%'
     ORDER BY con.conname
  LOOP
    found := found + 1;
    IF c.def NOT LIKE '%kept_in_use%' THEN
      EXECUTE format('ALTER TABLE retention_review DROP CONSTRAINT %I', c.conname);
    END IF;
  END LOOP;
  IF found <> 1 THEN
    RAISE EXCEPTION 'Expected the one CHECK of retention_review.file_action in %, found %', current_schema(), found;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = current_schema() AND rel.relname = 'retention_review' AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%kept_in_use%'
  ) THEN
    ALTER TABLE retention_review ADD CONSTRAINT retention_review_file_action_check
      CHECK (file_action IN ('vault_content_deleted', 'owner_asked', 'kept_in_use', 'none'));
  END IF;
END $$;

-- The rights and policies of the schema as before (the same call ends every tenant migration of Milestone 3).
SELECT platform.secure_tenant_schema(current_schema());
