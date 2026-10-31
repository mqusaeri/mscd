-- Milestone 3 verified deletion (docs/platform/MILESTONE-3.md D.5.4), written by M3-03 in wave 2 (R-14): the two
-- database functions of the purge and of attested redaction, and the change of the append-only trigger that lets
-- exactly the redaction update through. Nothing else.
--
-- The application role (mscd_app) cannot drop a schema or change an audit row, and keeps that limit. Both functions are
-- SECURITY DEFINER and owned by mscd_migrator (the role that runs this migration and owns every org_ schema and the
-- platform tables); mscd_app gets EXECUTE only. Each function checks its own preconditions and changes nothing when one
-- fails, so a call made too early or for the wrong organisation is refused as a whole.

-- ---------------------------------------------------------------------------------------------------------------
-- Redaction helpers: personal values inside text and JSON, replaced by pseudonyms.
-- ---------------------------------------------------------------------------------------------------------------

-- One text with every listed value replaced by its pseudonym. `p_values` is a JSON object {"<value>": "<pseudonym>"}.
-- Longer values go first (an email before the handle it contains), the match ignores case, and a value counts only
-- where it stands on its own (no letter, digit or underscore right before or after it), so "Ani" never changes
-- "Animal". Values shorter than 3 characters are ignored. A text equal to a value becomes the pseudonym.
CREATE FUNCTION platform.audit_redact_text(p_value text, p_values jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE
  SET search_path = pg_catalog, platform AS $$
DECLARE
  k text;
  v text;
  result text := p_value;
  folded text;
  key_folded text;
  out_text text;
  pos integer;
  hit integer;
  klen integer;
  before_ok boolean;
  after_ok boolean;
BEGIN
  IF p_value IS NULL OR p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN
    RETURN p_value;
  END IF;
  FOR k, v IN SELECT e.key, e.value FROM jsonb_each_text(p_values) e ORDER BY length(e.key) DESC, e.key LOOP
    CONTINUE WHEN k IS NULL OR length(k) < 3 OR v IS NULL;
    IF lower(result) = lower(k) THEN
      result := v;
      CONTINUE;
    END IF;
    -- lower() keeps the length of nearly every text; when it does not, the search is exact instead.
    folded := lower(result);
    key_folded := lower(k);
    IF length(folded) <> length(result) OR length(key_folded) <> length(k) THEN
      folded := result;
      key_folded := k;
    END IF;
    klen := length(k);
    out_text := '';
    pos := 1;
    LOOP
      hit := strpos(substr(folded, pos), key_folded);
      EXIT WHEN hit = 0;
      hit := pos + hit - 1;
      before_ok := hit = 1 OR substr(result, hit - 1, 1) !~ '[[:alnum:]_]';
      after_ok := hit + klen > length(result) OR substr(result, hit + klen, 1) !~ '[[:alnum:]_]';
      IF before_ok AND after_ok THEN
        out_text := out_text || substr(result, pos, hit - pos) || v;
        pos := hit + klen;
      ELSE
        out_text := out_text || substr(result, pos, hit - pos + 1);
        pos := hit + 1;
      END IF;
    END LOOP;
    result := out_text || substr(result, pos);
  END LOOP;
  RETURN result;
END $$;

-- One JSON value with every string (object keys included) redacted by platform.audit_redact_text.
CREATE FUNCTION platform.audit_redact_json(p_value jsonb, p_values jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
  SET search_path = pg_catalog, platform AS $$
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;
  CASE jsonb_typeof(p_value)
    WHEN 'string' THEN
      RETURN to_jsonb(platform.audit_redact_text(p_value #>> '{}', p_values));
    WHEN 'array' THEN
      RETURN coalesce((SELECT jsonb_agg(platform.audit_redact_json(t.e, p_values) ORDER BY t.o)
                         FROM jsonb_array_elements(p_value) WITH ORDINALITY AS t(e, o)), '[]'::jsonb);
    WHEN 'object' THEN
      RETURN coalesce((SELECT jsonb_object_agg(platform.audit_redact_text(t.k, p_values), platform.audit_redact_json(t.e, p_values))
                         FROM jsonb_each(p_value) AS t(k, e)), '{}'::jsonb);
    ELSE
      RETURN p_value;
  END CASE;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- The append-only trigger of every audit chain (platform.audit_log and each org_*.audit_trail), and of the other
-- append-only tables, redefined: it still refuses every UPDATE, DELETE and TRUNCATE, except one UPDATE of an audit row
-- made while platform.redact_audit_rows runs. That function sets the transaction-local setting mscd.audit_redaction to
-- the id of its redaction just around its own UPDATE; the update must carry that id, clear the network address and the
-- browser, and leave every other column except entity_code, before_data and after_data as it was (the stored hashes
-- included). mscd_app holds no UPDATE right on any audit table, so only the definer function reaches this path.
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.forbid_change() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
DECLARE
  marker text;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW'
     AND ((TG_TABLE_SCHEMA = 'platform' AND TG_TABLE_NAME = 'audit_log')
          OR (TG_TABLE_SCHEMA ~ '^org_[a-z0-9_]{1,59}$' AND TG_TABLE_NAME = 'audit_trail')) THEN
    marker := coalesce(current_setting('mscd.audit_redaction', true), '');
    IF marker <> '' THEN
      IF NEW.redaction_id IS NOT NULL AND NEW.redaction_id::text = marker AND NEW.redacted_at IS NOT NULL
         AND NEW.source_ip IS NULL AND NEW.user_agent IS NULL
         AND (NEW.seq, NEW.id, NEW.occurred_at, NEW.organization_id, NEW.management_system_id, NEW.actor_user_id,
              NEW.actor_kind, NEW.action, NEW.entity_type, NEW.entity_id, NEW.edition, NEW.request_id,
              NEW.prev_hash, NEW.row_hash)
             IS NOT DISTINCT FROM
             (OLD.seq, OLD.id, OLD.occurred_at, OLD.organization_id, OLD.management_system_id, OLD.actor_user_id,
              OLD.actor_kind, OLD.action, OLD.entity_type, OLD.entity_id, OLD.edition, OLD.request_id,
              OLD.prev_hash, OLD.row_hash) THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION '% on %.% is not allowed: the table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- platform.redact_audit_rows(chain, seqs, redaction_id, replacements): attested redaction of audit rows (D.5.4).
--
--   chain         'platform.audit_log', or '<org schema>.audit_trail' (the chain names of the anchors)
--   seqs          the rows to redact; a row with nothing to remove is left as it is
--   redaction_id  a new id; refused when the chain already holds it
--   replacements  {"values": {"<personal value>": "<pseudonym>", ...},
--                  "attestation": {"action": ..., "reason": ..., "organizationId"?, "entityType"?, "entityId"?,
--                                  "entityCode"?, "actorUserId"?, "actorKind"?}}
--                 action: tenant.audit_redacted or user.audit_redacted for the platform chain,
--                 privacy.audit_redacted for a tenant chain.
--                 Every pseudonym must have one of the two forms of D.5.2 and D.6.5: erased-<8 hex> (the handle of an
--                 anonymised account, or the pseudonym of a kept account) or "Former user <4 to 8 hex>" (a person
--                 erased in one organisation). So the function can only replace personal values with pseudonyms; it
--                 can never rewrite other text of an audit row (for example "approved" into "rejected").
--
-- For each row it sets source_ip and user_agent to null, replaces the listed values inside entity_code, before_data
-- and after_data, and sets redacted_at and redaction_id; seq, prev_hash, row_hash, action, occurred_at and the record
-- ids never change. Before it changes a row it checks the row as stored: a row never redacted must still match its
-- stored row_hash, and a row redacted before must match what its earlier attestation recorded. One row that fails
-- refuses the whole call. In the same transaction it appends one attestation entry to the same chain whose after_data
-- lists every redacted row as {seq, rowHash, redactedHash}: rowHash is the stored hash (which still links the chain),
-- redactedHash the SHA-256 of the previous hash and the canonical text of the row as redacted. The chain verifier
-- accepts a redacted row only when such an attestation, later in the chain and with the row's redaction_id, lists it
-- with both values, so a row changed or marked redacted without an attestation breaks the chain.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION platform.redact_audit_rows(p_chain text, p_seqs bigint[], p_redaction_id uuid, p_replacements jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, platform AS $$
DECLARE
  v_schema text;
  v_table text;
  v_org uuid;
  v_values jsonb := coalesce(p_replacements -> 'values', '{}'::jsonb);
  v_att jsonb := coalesce(p_replacements -> 'attestation', '{}'::jsonb);
  v_action text := p_replacements -> 'attestation' ->> 'action';
  v_actions text[] := ARRAY['tenant.audit_redacted', 'user.audit_redacted', 'privacy.audit_redacted'];
  v_prev_scope text := coalesce(current_setting('app.platform_scope', true), '');
  v_prev_org text := coalesce(current_setting('app.org_id', true), '');
  v_att_org uuid;
  v_seq bigint;
  v_used boolean;
  v_ok boolean;
  r record;
  v_current bytea;
  v_code text;
  v_before jsonb;
  v_after jsonb;
  v_hash bytea;
  v_rows jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_unchanged integer := 0;
  v_att_seq bigint;
  v_found bigint;
BEGIN
  IF p_redaction_id IS NULL THEN
    RAISE EXCEPTION 'redact_audit_rows needs a redaction id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(v_values) <> 'object' THEN
    RAISE EXCEPTION 'replacements.values must be a JSON object of value to pseudonym' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The message names no value: the keys are the personal values the call removes.
  IF EXISTS (SELECT 1 FROM jsonb_each(v_values) e
              WHERE jsonb_typeof(e.value) <> 'string'
                 OR (e.value #>> '{}') !~ '^(erased-[0-9a-f]{8}|Former user [0-9A-Fa-f]{4,8})$') THEN
    RAISE EXCEPTION 'Every replacement must be a pseudonym (erased-<8 hex> or Former user <4 to 8 hex>); nothing was redacted'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(length(btrim(v_att ->> 'reason')), 0) = 0 THEN
    RAISE EXCEPTION 'replacements.attestation.reason is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_chain = 'platform.audit_log' THEN
    v_schema := 'platform';
    v_table := 'audit_log';
    IF v_action IS NULL OR v_action NOT IN ('tenant.audit_redacted', 'user.audit_redacted') THEN
      RAISE EXCEPTION 'The platform chain takes the attestation tenant.audit_redacted or user.audit_redacted; the call named %', v_action
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_att_org := nullif(v_att ->> 'organizationId', '')::uuid;
  ELSIF p_chain ~ '^org_[a-z0-9_]{1,59}\.audit_trail$' THEN
    v_schema := split_part(p_chain, '.', 1);
    v_table := 'audit_trail';
    SELECT o.id INTO v_org FROM platform.organization o WHERE o.schema_name = v_schema;
    IF v_org IS NULL OR to_regnamespace(v_schema) IS NULL THEN
      RAISE EXCEPTION 'No organisation schema % to redact', v_schema USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_action IS DISTINCT FROM 'privacy.audit_redacted' THEN
      RAISE EXCEPTION 'A tenant chain takes the attestation privacy.audit_redacted; the call named %', v_action USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_att_org := v_org;
  ELSE
    RAISE EXCEPTION 'Unknown audit chain %', p_chain USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The platform table and every tenant table force row-level security, which binds this owner too.
  IF v_table = 'audit_log' THEN
    PERFORM set_config('app.platform_scope', 'on', true);
  ELSE
    PERFORM set_config('app.org_id', v_org::text, true);
  END IF;
  -- The lock of chain_hash: no row is appended to this chain while the rows are checked and redacted.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_schema || '.' || v_table, 42));

  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE redaction_id = $1 OR (action = ANY ($2) AND after_data ->> ''redactionId'' = $3))', v_schema, v_table)
    INTO v_used USING p_redaction_id, v_actions, p_redaction_id::text;
  IF v_used THEN
    RAISE EXCEPTION 'The redaction id % is already used in %', p_redaction_id, p_chain USING ERRCODE = 'unique_violation';
  END IF;

  FOR v_seq IN SELECT DISTINCT s FROM unnest(coalesce(p_seqs, '{}'::bigint[])) AS s WHERE s IS NOT NULL ORDER BY s LOOP
    EXECUTE format('SELECT * FROM %I.%I WHERE seq = $1 FOR UPDATE', v_schema, v_table) INTO r USING v_seq;
    GET DIAGNOSTICS v_found = ROW_COUNT;
    IF v_found = 0 THEN
      RAISE EXCEPTION 'Row % of % does not exist; nothing was redacted', v_seq, p_chain USING ERRCODE = 'no_data_found';
    END IF;
    IF v_table = 'audit_log' AND v_att_org IS NOT NULL AND r.organization_id IS DISTINCT FROM v_att_org THEN
      RAISE EXCEPTION 'Row % of % belongs to another organisation; nothing was redacted', v_seq, p_chain USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_current := sha256(r.prev_hash || convert_to(platform.audit_canonical_text(
      r.seq, r.id, r.occurred_at, r.organization_id, r.management_system_id, r.actor_user_id, r.actor_kind, r.action,
      r.entity_type, r.entity_id, r.entity_code, r.before_data, r.after_data, r.edition, r.request_id, r.source_ip,
      r.user_agent), 'UTF8'));
    IF r.redaction_id IS NULL THEN
      IF v_current IS DISTINCT FROM r.row_hash THEN
        RAISE EXCEPTION 'Row % of % no longer matches its stored hash; nothing was redacted', v_seq, p_chain
          USING ERRCODE = 'data_corrupted';
      END IF;
    ELSE
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I a, jsonb_array_elements(a.after_data -> ''rows'') e
                        WHERE a.action = ANY ($1) AND a.seq > $2 AND a.after_data ->> ''redactionId'' = $3
                          AND (e ->> ''seq'')::bigint = $2 AND e ->> ''rowHash'' = $4 AND e ->> ''redactedHash'' = $5)', v_schema, v_table)
        INTO v_ok USING v_actions, r.seq, r.redaction_id::text, encode(r.row_hash, 'hex'), encode(v_current, 'hex');
      IF NOT v_ok THEN
        RAISE EXCEPTION 'Row % of % was changed after its last attested redaction; nothing was redacted', v_seq, p_chain
          USING ERRCODE = 'data_corrupted';
      END IF;
    END IF;

    v_code := left(platform.audit_redact_text(r.entity_code, v_values), 80);
    v_before := platform.audit_redact_json(r.before_data, v_values);
    v_after := platform.audit_redact_json(r.after_data, v_values);
    IF r.source_ip IS NULL AND r.user_agent IS NULL AND v_code IS NOT DISTINCT FROM r.entity_code
       AND v_before IS NOT DISTINCT FROM r.before_data AND v_after IS NOT DISTINCT FROM r.after_data THEN
      v_unchanged := v_unchanged + 1;
      CONTINUE;
    END IF;

    PERFORM set_config('mscd.audit_redaction', p_redaction_id::text, true);
    EXECUTE format('UPDATE %I.%I SET source_ip = NULL, user_agent = NULL, entity_code = $1, before_data = $2, after_data = $3,
                      redacted_at = now(), redaction_id = $4 WHERE seq = $5', v_schema, v_table)
      USING v_code, v_before, v_after, p_redaction_id, r.seq;
    PERFORM set_config('mscd.audit_redaction', '', true);

    v_hash := sha256(r.prev_hash || convert_to(platform.audit_canonical_text(
      r.seq, r.id, r.occurred_at, r.organization_id, r.management_system_id, r.actor_user_id, r.actor_kind, r.action,
      r.entity_type, r.entity_id, v_code, v_before, v_after, r.edition, r.request_id, NULL, NULL), 'UTF8'));
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('seq', r.seq, 'rowHash', encode(r.row_hash, 'hex'), 'redactedHash', encode(v_hash, 'hex')));
    v_count := v_count + 1;
  END LOOP;

  -- The attestation entry, appended to the same chain by its chain_hash trigger.
  EXECUTE format('INSERT INTO %I.%I (organization_id, actor_user_id, actor_kind, action, entity_type, entity_id, entity_code,
                    after_data, request_id)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING seq', v_schema, v_table)
    INTO v_att_seq
    USING v_att_org,
          nullif(v_att ->> 'actorUserId', '')::uuid,
          coalesce(nullif(v_att ->> 'actorKind', ''), 'system'),
          v_action,
          left(nullif(v_att ->> 'entityType', ''), 40),
          nullif(v_att ->> 'entityId', '')::uuid,
          left(nullif(v_att ->> 'entityCode', ''), 80),
          jsonb_build_object('redactionId', p_redaction_id, 'reason', left(v_att ->> 'reason', 500), 'count', v_count, 'rows', v_rows),
          left(nullif(current_setting('app.request_id', true), ''), 64);

  PERFORM set_config('app.platform_scope', v_prev_scope, true);
  PERFORM set_config('app.org_id', v_prev_org, true);
  RETURN jsonb_build_object('chain', p_chain, 'redactionId', p_redaction_id, 'redacted', v_count, 'unchanged', v_unchanged,
                            'attestationSeq', v_att_seq);
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- platform.purge_organization(org_id): step 5 of the purge (D.5.2). Refuses unless the organisation is archived and its
-- deletion row is running and due. Then drops the organisation's schema with everything in it (records, sealed
-- repository credentials, notifications, the tenant audit chain), deletes the organisation's rows from the platform
-- tables that hold organisation data (memberships, invitations, sessions, sign-in transactions, identity providers
-- with the rows that hang off them, verified domains, licences, entitlement, daily job ledger, outbox and queued jobs
-- that name it, rate limit and idempotency rows) and the tenant_key row, so the live data key is gone. Exports keep
-- their record without content: queued or building ones fail, requested and ready ones expire (the vault step removed
-- their content). Returns the counts as jsonb. The organisation row, its status history, its deletion record, its
-- export records, its platform audit entries (redacted in step 6) and the signed anchors stay.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION platform.purge_organization(p_org_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, platform AS $$
DECLARE
  v_prev_scope text := coalesce(current_setting('app.platform_scope', true), '');
  v_prev_org text := coalesce(current_setting('app.org_id', true), '');
  v_org record;
  v_del record;
  v_idps uuid[];
  v_n bigint;
  v_counts jsonb := '{}'::jsonb;
BEGIN
  -- Platform scope for the platform tables, and the organisation for idempotency_key, whose policy reads app.org_id only.
  PERFORM set_config('app.platform_scope', 'on', true);
  PERFORM set_config('app.org_id', p_org_id::text, true);
  SELECT o.id, o.slug, o.schema_name, o.status INTO v_org FROM platform.organization o WHERE o.id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown organisation %; nothing was purged', p_org_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_org.status <> 'archived' THEN
    RAISE EXCEPTION 'Organisation % is %; only an archived organisation can be purged, so nothing was purged', v_org.slug, v_org.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT d.id, d.status, d.scheduled_for INTO v_del
    FROM platform.organization_deletion d
   WHERE d.organization_id = p_org_id AND d.status <> 'cancelled'
   FOR UPDATE;
  IF NOT FOUND OR v_del.status <> 'running' THEN
    RAISE EXCEPTION 'The deletion of organisation % is not running; nothing was purged', v_org.slug
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_del.scheduled_for > now() THEN
    RAISE EXCEPTION 'The deletion of organisation % is due on % and runs from that date; nothing was purged', v_org.slug, v_del.scheduled_for
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_org.schema_name !~ '^org_[a-z0-9_]{1,59}$' THEN
    RAISE EXCEPTION 'Organisation % has no valid schema name; nothing was purged', v_org.slug USING ERRCODE = 'invalid_schema_name';
  END IF;

  -- The schema, with every tenant table in it.
  v_counts := v_counts || jsonb_build_object('schemaDropped', to_regnamespace(v_org.schema_name) IS NOT NULL);
  EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', v_org.schema_name);

  -- Identity providers of the organisation and the rows that hang off them.
  SELECT coalesce(array_agg(p.id), '{}'::uuid[]) INTO v_idps FROM platform.identity_provider p WHERE p.organization_id = p_org_id;
  DELETE FROM platform.saml_assertion_seen WHERE identity_provider_id = ANY (v_idps);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('samlAssertions', v_n);
  DELETE FROM platform.user_identity WHERE identity_provider_id = ANY (v_idps);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('linkedSignIns', v_n);
  DELETE FROM platform.session WHERE organization_id = p_org_id OR auth_org_id = p_org_id OR identity_provider_id = ANY (v_idps);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('sessions', v_n);
  DELETE FROM platform.auth_transaction WHERE organization_id = p_org_id OR identity_provider_id = ANY (v_idps);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('signInTransactions', v_n);
  DELETE FROM platform.identity_provider WHERE organization_id = p_org_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('identityProviders', v_n);

  DELETE FROM platform.invitation WHERE organization_id = p_org_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('invitations', v_n);
  DELETE FROM platform.org_membership WHERE organization_id = p_org_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('memberships', v_n);
  DELETE FROM platform.verified_domain WHERE organization_id = p_org_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('verifiedDomains', v_n);
  DELETE FROM platform.licence WHERE organization_id = p_org_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('licences', v_n);
  DELETE FROM platform.entitlement WHERE organization_id = p_org_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('entitlements', v_n);
  DELETE FROM platform.daily_job_run WHERE organization_id = p_org_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('dailyJobRuns', v_n);
  DELETE FROM platform.idempotency_key WHERE organization_id = p_org_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('idempotencyKeys', v_n);
  DELETE FROM platform.rate_limit_bucket WHERE strpos(key, p_org_id::text) > 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('rateLimitBuckets', v_n);
  DELETE FROM platform.job_outbox WHERE payload -> 'env' ->> 'orgId' = p_org_id::text;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('outboxJobs', v_n);
  v_n := 0;
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    EXECUTE 'DELETE FROM pgboss.job WHERE data ->> ''orgId'' = $1 AND state <> ''active''' USING p_org_id::text;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  v_counts := v_counts || jsonb_build_object('queuedJobs', v_n);

  -- The wrapped data key: without it nothing of the organisation can be unwrapped any more.
  DELETE FROM platform.tenant_key WHERE organization_id = p_org_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('dataKeys', v_n);

  -- Export records stay, without content.
  UPDATE platform.organization_export SET status = 'failed', error = 'The organisation was deleted before the export was built'
   WHERE organization_id = p_org_id AND status IN ('queued', 'building');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('exportsFailed', v_n);
  UPDATE platform.organization_export SET status = 'expired' WHERE organization_id = p_org_id AND status IN ('requested', 'ready');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('exportsExpired', v_n);

  PERFORM set_config('app.platform_scope', v_prev_scope, true);
  PERFORM set_config('app.org_id', v_prev_org, true);
  RETURN v_counts;
END $$;

REVOKE ALL ON FUNCTION platform.redact_audit_rows(text, bigint[], uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.purge_organization(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.redact_audit_rows(text, bigint[], uuid, jsonb) TO mscd_app;
GRANT EXECUTE ON FUNCTION platform.purge_organization(uuid) TO mscd_app;
-- The helpers are pure functions; the verifier and the tests call them as mscd_app.
GRANT EXECUTE ON FUNCTION platform.audit_redact_text(text, jsonb) TO mscd_app;
GRANT EXECUTE ON FUNCTION platform.audit_redact_json(jsonb, jsonb) TO mscd_app;
