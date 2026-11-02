-- Milestone 3 correction of the platform schema (docs/platform/MILESTONE-3.md R-14), written by M3-12 (hardening
-- follow-ups). Additive only: no earlier migration changes.
--
-- The grants of every tenant schema (D-31): the function of 0007 is redefined with one more right, SELECT on the
-- schema's own `kysely_migration` for mscd_app, so the organisation export names the migrations applied to the schema
-- from the schema itself (manifest `tenantMigrationsSource: schema`, D.4) instead of the build's list. The table holds
-- migration names and times only, the same in every schema, so the right shows no organisation data; mscd_app still
-- gets nothing on `kysely_migration_lock` and no write right on either table. Every other right of 0007 is unchanged.

CREATE OR REPLACE FUNCTION platform.secure_tenant_schema(target_schema text) RETURNS void LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
DECLARE
  t record;
  tbl text;
  schema_org uuid;
  member_cols text[];
  report_excluded text[] := ARRAY['storage_credential', 'auditor_access_grant', 'calendar_feed_token',
                                  'upload_intent', 'audit_trail'];
  person_cols text[] := ARRAY['user_id', 'owner_user_id', 'holder_user_id', 'pending_holder_user_id',
                              'approver_user_id', 'justification_holder_user_id', 'relationship_owner_user_id',
                              'recipient_user_id', 'accepted_by_user_id', 'auditee_user_id',
                              'implemented_by_user_id', 'verified_by_user_id', 'completed_by_user_id'];
BEGIN
  -- The policy binds the schema to its own organisation, so a session of organisation A can neither read nor
  -- write rows in the schema of organisation B, even with a schema-qualified statement.
  SELECT o.id INTO schema_org FROM platform.organization o WHERE o.schema_name = target_schema;
  IF schema_org IS NULL THEN
    RAISE EXCEPTION 'Schema % has no row in platform.organization', target_schema;
  END IF;
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', target_schema);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO mscd_app', target_schema);
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = target_schema AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'kysely\_%'
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = target_schema AND table_name = t.relname AND column_name = 'organization_id') THEN
      RAISE EXCEPTION 'Tenant table %.% has no organization_id column', target_schema, t.relname;
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.%I TO mscd_app', target_schema, t.relname);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target_schema, t.relname);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', target_schema, t.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', target_schema, t.relname);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I '
      'USING (organization_id = %L::uuid AND organization_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) '
      'WITH CHECK (organization_id = %L::uuid AND organization_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)',
      target_schema, t.relname, schema_org, schema_org);
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = target_schema AND table_name = t.relname AND column_name = 'updated_at')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger tg
                       JOIN pg_class c2 ON c2.oid = tg.tgrelid JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                       WHERE n2.nspname = target_schema AND c2.relname = t.relname AND tg.tgname = 'set_updated_at') THEN
      EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at()',
        target_schema, t.relname);
    END IF;
    member_cols := ARRAY(SELECT column_name::text FROM information_schema.columns
                         WHERE table_schema = target_schema AND table_name = t.relname
                           AND column_name = ANY (person_cols) ORDER BY column_name);
    EXECUTE format('DROP TRIGGER IF EXISTS assert_member ON %I.%I', target_schema, t.relname);
    IF cardinality(member_cols) > 0 THEN
      EXECUTE format('CREATE TRIGGER assert_member BEFORE INSERT OR UPDATE OF %s ON %I.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_member(%s)',
        (SELECT string_agg(quote_ident(c), ', ') FROM unnest(member_cols) AS c), target_schema, t.relname,
        (SELECT string_agg(quote_literal(c), ', ') FROM unnest(member_cols) AS c));
    END IF;
  END LOOP;
  FOREACH tbl IN ARRAY ARRAY['audit_trail', 'link_health_result', 'reminder'] LOOP
    IF to_regclass(format('%I.%I', target_schema, tbl)) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE ON %I.%I FROM mscd_app', target_schema, tbl);
    END IF;
  END LOOP;
  -- Milestone 3 D.6.5, D.6.7: rows the application removes for good (read notifications after their retention, the
  -- notifications and calendar feed tokens of an erased person). Every other tenant table keeps soft delete (C.1).
  FOREACH tbl IN ARRAY ARRAY['notification', 'calendar_feed_token'] LOOP
    IF to_regclass(format('%I.%I', target_schema, tbl)) IS NOT NULL THEN
      EXECUTE format('GRANT DELETE ON %I.%I TO mscd_app', target_schema, tbl);
    END IF;
  END LOOP;
  -- Milestone 3 M3-12: the export reads the applied migrations from the schema (read only; the lock table stays closed).
  IF to_regclass(format('%I.kysely_migration', target_schema)) IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON %I.kysely_migration TO mscd_app', target_schema);
  END IF;
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO mscd_app', target_schema);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_report') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO mscd_report', target_schema);
    FOR t IN
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = target_schema AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'kysely\_%'
        AND c.relname <> ALL (report_excluded)
    LOOP
      EXECUTE format('GRANT SELECT ON %I.%I TO mscd_report', target_schema, t.relname);
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = target_schema AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'kysely\_%'
               AND NOT (c.relrowsecurity AND c.relforcerowsecurity)) THEN
    RAISE EXCEPTION 'Schema % has a table without forced row-level security', target_schema;
  END IF;
END $$;

-- The existing tenant schemas get the right now (tenant/0010_milestone3_fix.sql runs the whole function for each of
-- them again as well). A schema without its migration table yet gets it from its first tenant migration.
DO $$
DECLARE
  o record;
BEGIN
  FOR o IN SELECT schema_name FROM platform.organization WHERE to_regnamespace(schema_name) IS NOT NULL ORDER BY schema_name LOOP
    IF to_regclass(format('%I.kysely_migration', o.schema_name)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON %I.kysely_migration TO mscd_app', o.schema_name);
    END IF;
  END LOOP;
END $$;
