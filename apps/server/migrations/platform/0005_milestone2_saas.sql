-- Milestone 2 SaaS track contract of the platform schema (docs/platform/MILESTONE-2.md D.3, J.7), written once in
-- wave 1a by M2-02. Later packages add no platform migration; a correction goes in 0006_milestone2_fix.sql.

-- Status history of an organisation (J.8 organization.status): one row per move, with the reason. Append-only.
CREATE TABLE platform.organization_status_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES platform.organization(id),
  from_status varchar(20) NOT NULL CHECK (from_status IN ('active', 'suspended', 'offboarding', 'archived')),
  to_status varchar(20) NOT NULL CHECK (to_status IN ('active', 'suspended', 'offboarding', 'archived')),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_user_id uuid REFERENCES platform.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_status <> to_status)
);
CREATE INDEX organization_status_event_org_idx ON platform.organization_status_event (organization_id, created_at DESC);
CREATE TRIGGER organization_status_event_append_only BEFORE UPDATE OR DELETE ON platform.organization_status_event
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_change();

-- Email domains verified by a DNS TXT record (M2-S11) next to the operator command `tenant verify-domain`. Existing
-- rows were verified by the operator, so they stay verified with method manual.
DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(format('%s (%s organisations)', d.name, d.n), ', ' ORDER BY d.name) INTO duplicates
  FROM (SELECT lower(domain) AS name, count(*) AS n FROM platform.verified_domain GROUP BY lower(domain) HAVING count(*) > 1) d;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'platform.verified_domain has domains verified for more than one organisation: %. Remove the wrong rows, then migrate again.', duplicates
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;
ALTER TABLE platform.verified_domain
  ADD COLUMN status varchar(10) NOT NULL DEFAULT 'verified' CHECK (status IN ('pending', 'verified', 'failed')),
  ADD COLUMN txt_token_hash bytea,
  ADD COLUMN requested_at timestamptz,
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN method varchar(10) NOT NULL DEFAULT 'manual' CHECK (method IN ('dns', 'manual'));
ALTER TABLE platform.verified_domain ALTER COLUMN verified_at DROP NOT NULL;
ALTER TABLE platform.verified_domain ALTER COLUMN verified_by DROP NOT NULL;
ALTER TABLE platform.verified_domain ADD CONSTRAINT verified_domain_verified_check
  CHECK (status <> 'verified' OR verified_at IS NOT NULL);
ALTER TABLE platform.verified_domain ADD CONSTRAINT verified_domain_dns_check
  CHECK (method <> 'dns' OR txt_token_hash IS NOT NULL);
CREATE UNIQUE INDEX verified_domain_verified_uq ON platform.verified_domain (lower(domain)) WHERE status = 'verified';
CREATE INDEX verified_domain_pending_idx ON platform.verified_domain (requested_at) WHERE status = 'pending';

-- Per-organisation entitlement (M2-S10): in multi tenancy the effective licence of an organisation.
CREATE TABLE platform.entitlement (
  organization_id uuid PRIMARY KEY REFERENCES platform.organization(id),
  plan varchar(40),
  source varchar(15) NOT NULL CHECK (source IN ('preset', 'manual', 'signed_licence')),
  max_users integer NOT NULL CHECK (max_users >= 0),
  max_management_systems integer NOT NULL CHECK (max_management_systems >= 0),
  frameworks text[] NOT NULL DEFAULT '{}',
  storage_adapters text[] NOT NULL DEFAULT '{managed_vault}',
  features text[] NOT NULL DEFAULT '{}',
  rate_user_per_minute integer CHECK (rate_user_per_minute IS NULL OR rate_user_per_minute > 0),
  rate_org_per_minute integer CHECK (rate_org_per_minute IS NULL OR rate_org_per_minute > 0),
  valid_from date NOT NULL,
  valid_until date,
  grace_days smallint NOT NULL DEFAULT 30 CHECK (grace_days BETWEEN 0 AND 365),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform.app_user(id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);
CREATE INDEX entitlement_valid_until_idx ON platform.entitlement (valid_until) WHERE valid_until IS NOT NULL;

-- Grants and RLS like the other platform tables (D-31, F.10): the function is redefined with the new tables, then run.
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
      ('organization_status_event', 'SELECT, INSERT'), ('entitlement', 'SELECT, INSERT, UPDATE')
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
  -- expression is written by the platform operator only (operator routes and commands run in platform scope): the
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
      ('entitlement', format('organization_id = %s OR %s', org_expr, scope_expr), scope_expr)
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

-- The api changes the status of an organisation in platform scope only (J.8: the operator's route). mscd_app holds the
-- column grant for that route, and platform.organization has no row-level security. The owner of the table (the
-- migrator: operator commands and maintenance) is not limited.
CREATE FUNCTION platform.require_platform_scope() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
BEGIN
  IF coalesce(current_setting('app.platform_scope', true), '') <> 'on'
     AND NOT pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'USAGE') THEN
    RAISE EXCEPTION 'Changing %.% (%) needs the platform scope', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_status_platform_scope BEFORE UPDATE OF status ON platform.organization
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION platform.require_platform_scope();
