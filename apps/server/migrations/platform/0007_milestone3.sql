-- Milestone 3 contract of the platform schema (docs/platform/MILESTONE-3.md D.3, J.7), written once in wave 1 by M3-01.
-- Later packages add no platform migration, except platform/0008_milestone3_purge.sql of M3-03 (the purge and redaction
-- functions and the audit trigger change of D.5.4); a correction goes in 0009_milestone3_fix.sql (R-14).

-- The lifecycle of D.5: deleted is the end of a verified deletion (set by the purge only), and an organisation in
-- offboarding carries the end of its read-only period.
ALTER TABLE platform.organization DROP CONSTRAINT organization_status_check;
ALTER TABLE platform.organization ADD CONSTRAINT organization_status_check
  CHECK (status IN ('active', 'suspended', 'offboarding', 'archived', 'deleted'));
ALTER TABLE platform.organization ADD COLUMN offboarding_ends_at timestamptz;
-- The end of the read-only period changes in platform scope only, as the status does (organization_status_platform_scope
-- of 0005): org.lifecycle archives the organisation and schedules its deletion when this date passes (D.5.1), so a
-- write from an organisation's scope must not move it.
CREATE TRIGGER organization_offboarding_ends_platform_scope BEFORE UPDATE OF offboarding_ends_at ON platform.organization
  FOR EACH ROW WHEN (OLD.offboarding_ends_at IS DISTINCT FROM NEW.offboarding_ends_at)
  EXECUTE FUNCTION platform.require_platform_scope();

ALTER TABLE platform.organization_status_event DROP CONSTRAINT organization_status_event_from_status_check;
ALTER TABLE platform.organization_status_event ADD CONSTRAINT organization_status_event_from_status_check
  CHECK (from_status IN ('active', 'suspended', 'offboarding', 'archived', 'deleted'));
ALTER TABLE platform.organization_status_event DROP CONSTRAINT organization_status_event_to_status_check;
ALTER TABLE platform.organization_status_event ADD CONSTRAINT organization_status_event_to_status_check
  CHECK (to_status IN ('active', 'suspended', 'offboarding', 'archived', 'deleted'));

-- An account that was anonymised (D.5.2 step 3, D.6.5) keeps its row, because records and audit rows refer to its id.
ALTER TABLE platform.app_user ADD COLUMN erased_at timestamptz;

-- Attested redaction of platform audit entries (D.5.4): outside the hashed columns, written only by the definer function
-- of platform/0008 (the append-only trigger refuses every other update).
ALTER TABLE platform.audit_log
  ADD COLUMN redacted_at timestamptz,
  ADD COLUMN redaction_id uuid,
  ADD CONSTRAINT audit_log_redaction_check CHECK ((redacted_at IS NULL) = (redaction_id IS NULL));

-- Full exports of an organisation (D.4, machine organization_export.status of J.8). Parts and the manifest are vault
-- objects of the organisation (storage_object rows of its tenant schema), so the purge removes them with everything else.
CREATE TABLE platform.organization_export (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES platform.organization(id),
  status varchar(12) NOT NULL CHECK (status IN ('requested', 'queued', 'building', 'ready', 'failed', 'rejected', 'expired')),
  requested_via varchar(15) NOT NULL CHECK (requested_via IN ('tenant_admin', 'operator', 'offboarding')),
  requested_by uuid REFERENCES platform.app_user(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES platform.app_user(id),
  decided_at timestamptz,
  decision_note varchar(500),
  is_final boolean NOT NULL DEFAULT false,
  part_count integer CHECK (part_count >= 0),
  file_count integer CHECK (file_count >= 0),
  size_bytes bigint CHECK (size_bytes >= 0),
  parts jsonb,
  manifest_object_id uuid,
  manifest_sha256 varchar(64) CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  completed_at timestamptz,
  download_count integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'ready' OR (manifest_object_id IS NOT NULL AND manifest_sha256 IS NOT NULL AND completed_at IS NOT NULL))
);
-- One export per organisation runs at a time (409 export_in_progress, D.4).
CREATE UNIQUE INDEX organization_export_running_uq ON platform.organization_export (organization_id) WHERE status IN ('queued', 'building');
CREATE INDEX organization_export_org_idx ON platform.organization_export (organization_id, requested_at DESC);
CREATE INDEX organization_export_expiry_idx ON platform.organization_export (expires_at) WHERE status = 'ready';
CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform.organization_export FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- The verified deletion of an archived organisation (D.5, machine organization_deletion.status of J.8). The row stays after
-- the purge with the report and the signed certificate; it holds no personal data once the certificate email is sent.
CREATE TABLE platform.organization_deletion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES platform.organization(id),
  status varchar(12) NOT NULL CHECK (status IN ('scheduled', 'cancelled', 'running', 'completed', 'failed')),
  scheduled_for timestamptz NOT NULL,
  scheduled_by uuid REFERENCES platform.app_user(id),
  reason text,
  notify_emails_sealed text,
  final_export_id uuid REFERENCES platform.organization_export(id),
  started_at timestamptz,
  completed_at timestamptz,
  failed_step varchar(40),
  error text,
  report jsonb,
  vault_objects_deleted bigint CHECK (vault_objects_deleted >= 0),
  certificate jsonb,
  certificate_signature text,
  certificate_key_id varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND certificate IS NOT NULL AND certificate_signature IS NOT NULL)),
  CHECK (status <> 'failed' OR failed_step IS NOT NULL)
);
-- One deletion that is not cancelled per organisation.
CREATE UNIQUE INDEX organization_deletion_open_uq ON platform.organization_deletion (organization_id) WHERE status <> 'cancelled';
CREATE INDEX organization_deletion_due_idx ON platform.organization_deletion (scheduled_for) WHERE status = 'scheduled';
CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform.organization_deletion FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Status changes of exports and deletions run in platform scope only (as organization_status_platform_scope of 0005): a
-- Tenant Admin requests an export in the organisation's scope, and the decision, the build and the expiry move it.
CREATE TRIGGER organization_export_status_platform_scope BEFORE UPDATE OF status ON platform.organization_export
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION platform.require_platform_scope();
CREATE TRIGGER organization_deletion_status_platform_scope BEFORE UPDATE OF status ON platform.organization_deletion
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION platform.require_platform_scope();

-- The grants of every tenant schema (D-31): the function of 0001 is redefined to also grant DELETE on notification and
-- calendar_feed_token to mscd_app, for the retention of read notifications (D.6.7) and the erasure of a person in an
-- organisation (D.6.5). audit_trail keeps no UPDATE right for mscd_app. tenant/0009 runs it for every tenant schema.
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

-- Grants and RLS of the platform tables (D-31, F.10): the function of 0006 is redefined with the new tables and rights,
-- then run.
--   * DELETE on session, invitation and password_reset_token: the retention of technical personal data (D.6.7).
--   * DELETE on user_identity, mfa_factor, mfa_recovery_code and user_preference: the account anonymiser (D.5.2 step 3)
--     and the removal of a linked company sign-in (D.9); secret_sealed and code_hash are NOT NULL, so these rows go.
--   * UPDATE of organization.offboarding_ends_at: the move to offboarding (D.2), in platform scope like status (trigger
--     organization_offboarding_ends_platform_scope above).
--   * organization_export: the organisation reads and requests its own exports; status changes need the platform scope
--     (trigger above). organization_deletion: the organisation reads its own row (the read-only banner); only the
--     platform scope writes.
--   * audit_log keeps SELECT and INSERT only.
CREATE OR REPLACE FUNCTION platform.secure_platform_schema() RETURNS void LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
DECLARE
  g record;
  org_expr text := 'nullif(current_setting(''app.org_id'', true), '''')::uuid';
  user_expr text := 'nullif(current_setting(''app.user_id'', true), '''')::uuid';
  scope_expr text := 'coalesce(current_setting(''app.platform_scope'', true), '''') = ''on''';
BEGIN
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM mscd_app, mscd_pack_installer';
  FOR g IN SELECT * FROM (VALUES
      ('kysely_migration', 'SELECT'), ('organization', 'SELECT'), ('installation', 'SELECT'),
      ('app_user', 'SELECT, INSERT, UPDATE'), ('org_membership', 'SELECT, INSERT, UPDATE'),
      ('platform_role', 'SELECT'), ('verified_domain', 'SELECT, INSERT, UPDATE, DELETE'),
      ('identity_provider', 'SELECT, INSERT, UPDATE'), ('user_identity', 'SELECT, INSERT, UPDATE, DELETE'),
      ('session', 'SELECT, INSERT, UPDATE, DELETE'), ('mfa_factor', 'SELECT, INSERT, UPDATE, DELETE'),
      ('mfa_recovery_code', 'SELECT, INSERT, UPDATE, DELETE'), ('auth_transaction', 'SELECT, INSERT, UPDATE, DELETE'),
      ('saml_assertion_seen', 'SELECT, INSERT, DELETE'), ('password_reset_token', 'SELECT, INSERT, UPDATE, DELETE'),
      ('invitation', 'SELECT, INSERT, UPDATE, DELETE'), ('user_preference', 'SELECT, INSERT, UPDATE, DELETE'),
      ('licence', 'SELECT, INSERT'), ('clock_mark', 'SELECT, UPDATE'),
      ('pack_install', 'SELECT'), ('pack_catalog', 'SELECT'), ('tenant_key', 'SELECT, INSERT'),
      ('audit_log', 'SELECT, INSERT'), ('audit_anchor', 'SELECT, INSERT'),
      ('rate_limit_bucket', 'SELECT, INSERT, UPDATE, DELETE'), ('idempotency_key', 'SELECT, INSERT, UPDATE, DELETE'),
      ('job_outbox', 'SELECT, INSERT, UPDATE, DELETE'), ('system_setting', 'SELECT'),
      ('organization_status_event', 'SELECT, INSERT'), ('entitlement', 'SELECT, INSERT, UPDATE'),
      ('daily_job_run', 'SELECT, INSERT, DELETE'),
      ('organization_export', 'SELECT, INSERT, UPDATE'), ('organization_deletion', 'SELECT, INSERT, UPDATE')
    ) AS v(tbl, privs)
  LOOP
    IF to_regclass('platform.' || g.tbl) IS NOT NULL THEN
      EXECUTE format('GRANT %s ON platform.%I TO mscd_app', g.privs, g.tbl);
    END IF;
  END LOOP;
  IF to_regclass('platform.licence') IS NOT NULL THEN
    GRANT UPDATE (superseded_at) ON platform.licence TO mscd_app;
  END IF;
  IF to_regclass('platform.organization') IS NOT NULL THEN
    -- status and offboarding_ends_at: the operator's status changes (J.8) run in the api in platform scope; the slug
    -- and the schema never change.
    GRANT UPDATE (name, time_zone, site_count, local_login, status, offboarding_ends_at) ON platform.organization TO mscd_app;
  END IF;
  FOR g IN SELECT * FROM (VALUES
      ('pack_install', 'SELECT, INSERT, UPDATE'), ('pack_catalog', 'SELECT, INSERT, UPDATE'),
      ('audit_log', 'SELECT, INSERT'), ('installation', 'SELECT')
    ) AS v(tbl, privs)
  LOOP
    IF to_regclass('platform.' || g.tbl) IS NOT NULL THEN
      EXECUTE format('GRANT %s ON platform.%I TO mscd_pack_installer', g.privs, g.tbl);
    END IF;
  END LOOP;
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA platform TO mscd_app';
  -- Organisation-scoped platform tables: forced RLS with an explicit platform scope (F.10). A table with a write
  -- expression is written in platform scope only (operator routes and commands, the scheduler tick): the
  -- organisation reads its own rows (policy platform_isolation, SELECT) and writes none (policy platform_scope_write).
  FOR g IN SELECT * FROM (VALUES
      ('org_membership', format('organization_id = %s OR user_id = %s OR %s', org_expr, user_expr, scope_expr), NULL::text),
      ('session', format('user_id = %s OR %s', user_expr, scope_expr), NULL),
      ('identity_provider', format('organization_id = %s OR %s', org_expr, scope_expr), NULL),
      ('verified_domain', format('organization_id = %s OR %s', org_expr, scope_expr), scope_expr),
      ('invitation', format('organization_id = %s OR %s', org_expr, scope_expr), NULL),
      ('licence', format('organization_id = %s OR %s', org_expr, scope_expr), NULL),
      ('tenant_key', format('organization_id = %s OR %s', org_expr, scope_expr), NULL),
      ('audit_log', format('organization_id = %s OR %s', org_expr, scope_expr), NULL),
      ('idempotency_key', format('organization_id = %s', org_expr), NULL),
      ('organization_status_event', format('organization_id = %s OR %s', org_expr, scope_expr), scope_expr),
      ('entitlement', format('organization_id = %s OR %s', org_expr, scope_expr), scope_expr),
      ('daily_job_run', format('organization_id = %s OR %s', org_expr, scope_expr), scope_expr),
      ('organization_export', format('organization_id = %s OR %s', org_expr, scope_expr), NULL),
      ('organization_deletion', format('organization_id = %s OR %s', org_expr, scope_expr), scope_expr)
    ) AS v(tbl, expr, write_expr)
  LOOP
    IF to_regclass('platform.' || g.tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY', g.tbl);
      EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', g.tbl);
      EXECUTE format('DROP POLICY IF EXISTS platform_isolation ON platform.%I', g.tbl);
      EXECUTE format('DROP POLICY IF EXISTS platform_scope_write ON platform.%I', g.tbl);
      IF g.write_expr IS NULL THEN
        EXECUTE format('CREATE POLICY platform_isolation ON platform.%I USING (%s) WITH CHECK (%s)', g.tbl, g.expr, g.expr);
      ELSE
        EXECUTE format('CREATE POLICY platform_isolation ON platform.%I FOR SELECT USING (%s)', g.tbl, g.expr);
        EXECUTE format('CREATE POLICY platform_scope_write ON platform.%I USING (%s) WITH CHECK (%s)', g.tbl, g.write_expr, g.write_expr);
      END IF;
    END IF;
  END LOOP;
END $$;

SELECT platform.secure_platform_schema();
