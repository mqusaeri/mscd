-- Run ledger of the daily jobs of every organisation (Milestone 2 D.2 `admin.organization.update`, risk table I).
-- Orchestrator decision between waves 2a and 2b under R-14: it replaces the replay of time zone histories that M2-06
-- built in `scheduler.tick` (docs/platform/handoff/M2-06.md, "Orchestrator redesign: daily job ledger").
--
-- A run is one organisation, one daily job of E.2 and one local date. `scheduler.tick` inserts the row and sends the
-- job in the same transaction, and the job works on the date of its row (the payload's `localDate`), so each daily
-- job runs once per local date of the organisation whatever the time zone does between the tick and the job's start.
-- `scheduled_for` is the instant the run is due (its local time in the zone the tick read); `enqueued_at` is the
-- tick's clock. The tick deletes rows older than 14 days.
CREATE TABLE platform.daily_job_run (
  organization_id uuid NOT NULL REFERENCES platform.organization(id),
  job text NOT NULL CHECK (job ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'),
  local_date date NOT NULL,
  scheduled_for timestamptz NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, job, local_date)
);
CREATE INDEX daily_job_run_local_date_idx ON platform.daily_job_run (local_date);

-- Grants and RLS like the other platform tables (D-31, F.10): the function of 0005 is redefined with the new table,
-- then run. The organisation reads its own rows; only the platform scope (the tick) writes them.
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
      ('identity_provider', 'SELECT, INSERT, UPDATE'), ('user_identity', 'SELECT, INSERT, UPDATE'),
      ('session', 'SELECT, INSERT, UPDATE'), ('mfa_factor', 'SELECT, INSERT, UPDATE'),
      ('mfa_recovery_code', 'SELECT, INSERT, UPDATE'), ('auth_transaction', 'SELECT, INSERT, UPDATE, DELETE'),
      ('saml_assertion_seen', 'SELECT, INSERT, DELETE'), ('password_reset_token', 'SELECT, INSERT, UPDATE'),
      ('invitation', 'SELECT, INSERT, UPDATE'), ('user_preference', 'SELECT, INSERT, UPDATE'),
      ('licence', 'SELECT, INSERT'), ('clock_mark', 'SELECT, UPDATE'),
      ('pack_install', 'SELECT'), ('pack_catalog', 'SELECT'), ('tenant_key', 'SELECT, INSERT'),
      ('audit_log', 'SELECT, INSERT'), ('audit_anchor', 'SELECT, INSERT'),
      ('rate_limit_bucket', 'SELECT, INSERT, UPDATE, DELETE'), ('idempotency_key', 'SELECT, INSERT, UPDATE, DELETE'),
      ('job_outbox', 'SELECT, INSERT, UPDATE, DELETE'), ('system_setting', 'SELECT'),
      ('organization_status_event', 'SELECT, INSERT'), ('entitlement', 'SELECT, INSERT, UPDATE'),
      ('daily_job_run', 'SELECT, INSERT, DELETE')
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
    -- status: the operator's status changes (J.8, M2-S09) run in the api; the slug and the schema never change.
    GRANT UPDATE (name, time_zone, site_count, local_login, status) ON platform.organization TO mscd_app;
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
      ('daily_job_run', format('organization_id = %s OR %s', org_expr, scope_expr), scope_expr)
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
