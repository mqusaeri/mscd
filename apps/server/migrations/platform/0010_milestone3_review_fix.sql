-- Milestone 3 correction of the platform schema after the reviews of 2026-11-02 (docs/platform/MILESTONE-3.md R-14,
-- M3-13). Additive only: no earlier migration changes.
--
-- 1. platform.redact_audit_rows gains the mode "clear_disposed" (product owner decision 18, D.8): the attested redaction
--    of the audit entries of a record that an approved disposal cleared. Tenant chains only, no replacement values,
--    and every listed row must be about a disposed record (`disposed_at` set on audit_event, finding,
--    corrective_action, management_review or competence_record) or about a child row of one (audit_activity and
--    audit_prep_task of an audit event, management_review_input of a management review). The disposed records are read
--    with dynamic SQL, so this function is valid whether tenant/0011 (which adds `disposed_at`) ran before or after it.
--    Each listed row keeps its keys: every scalar inside before_data and after_data becomes null, the network address
--    and the browser are cleared, entity_code, action, actor and time stay. The attestation entry has the same form
--    as every other redaction, so the append-only trigger, the chain verifier and `export verify` need no change.
--    The mode "replace" (the default, also when the call names no mode) is the redaction of 0008, unchanged.
-- 2. platform.secure_tenant_schema keeps the report login of on-premise installations (mscd_report) away from the
--    requests from one person: privacy_request (names, emails, identity check notes), privacy_check and erased_person
--    (which maps a pseudonym back to an account) join the excluded tables, and SELECT on every excluded table is revoked
--    from mscd_report when the role exists (security review 5). The existing schemas lose the right below as well, and
--    tenant/0011 runs the whole function for each of them again.

-- One JSON value with every scalar replaced by JSON null; object keys and array lengths stay.
CREATE FUNCTION platform.audit_null_json(p_value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
  SET search_path = pg_catalog, platform AS $$
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;
  CASE jsonb_typeof(p_value)
    WHEN 'array' THEN
      RETURN coalesce((SELECT jsonb_agg(platform.audit_null_json(t.e) ORDER BY t.o)
                         FROM jsonb_array_elements(p_value) WITH ORDINALITY AS t(e, o)), '[]'::jsonb);
    WHEN 'object' THEN
      RETURN coalesce((SELECT jsonb_object_agg(t.k, platform.audit_null_json(t.e))
                         FROM jsonb_each(p_value) AS t(k, e)), '{}'::jsonb);
    ELSE
      RETURN 'null'::jsonb;
  END CASE;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- platform.redact_audit_rows(chain, seqs, redaction_id, replacements): attested redaction of audit rows (D.5.4).
--
--   chain         'platform.audit_log', or '<org schema>.audit_trail' (the chain names of the anchors)
--   seqs          the rows to redact; a row with nothing to remove is left as it is
--   redaction_id  a new id; refused when the chain already holds it
--   replacements  {"mode"?: "replace" | "clear_disposed",
--                  "values": {"<personal value>": "<pseudonym>", ...},
--                  "attestation": {"action": ..., "reason": ..., "organizationId"?, "entityType"?, "entityId"?,
--                                  "entityCode"?, "actorUserId"?, "actorKind"?}}
--                 mode replace (default): every pseudonym must have one of the two forms of D.5.2 and D.6.5
--                 (erased-<8 hex> or "Former user <4 to 8 hex>"), so the call can only replace personal values with
--                 pseudonyms and never rewrite other text of an audit row.
--                 mode clear_disposed: a tenant chain, no values, and every row about a disposed record or a child row
--                 of one; every scalar of before_data and after_data becomes null.
--                 action: tenant.audit_redacted or user.audit_redacted for the platform chain,
--                 privacy.audit_redacted for a tenant chain.
--
-- For each row it sets source_ip and user_agent to null, changes entity_code, before_data and after_data as the mode
-- says, and sets redacted_at and redaction_id; seq, prev_hash, row_hash, action, occurred_at and the record ids never
-- change. Before it changes a row it checks the row as stored: a row never redacted must still match its stored
-- row_hash, and a row redacted before must match what its earlier attestation recorded. One row that fails refuses the
-- whole call. In the same transaction it appends one attestation entry to the same chain whose after_data lists every
-- redacted row as {seq, rowHash, redactedHash}: rowHash is the stored hash (which still links the chain), redactedHash
-- the SHA-256 of the previous hash and the canonical text of the row as redacted. The chain verifier accepts a redacted
-- row only when such an attestation, later in the chain and with the row's redaction_id, lists it with both values, so
-- a row changed or marked redacted without an attestation breaks the chain.
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.redact_audit_rows(p_chain text, p_seqs bigint[], p_redaction_id uuid, p_replacements jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, platform AS $$
DECLARE
  v_schema text;
  v_table text;
  v_org uuid;
  v_mode text := coalesce(nullif(p_replacements ->> 'mode', ''), 'replace');
  v_values jsonb := coalesce(p_replacements -> 'values', '{}'::jsonb);
  v_att jsonb := coalesce(p_replacements -> 'attestation', '{}'::jsonb);
  v_action text := p_replacements -> 'attestation' ->> 'action';
  v_actions text[] := ARRAY['tenant.audit_redacted', 'user.audit_redacted', 'privacy.audit_redacted'];
  v_records text[] := ARRAY['audit_event', 'finding', 'corrective_action', 'management_review', 'competence_record'];
  v_prev_scope text := coalesce(current_setting('app.platform_scope', true), '');
  v_prev_org text := coalesce(current_setting('app.org_id', true), '');
  v_att_org uuid;
  v_seq bigint;
  v_used boolean;
  v_ok boolean;
  v_disposed boolean;
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
  IF v_mode NOT IN ('replace', 'clear_disposed') THEN
    RAISE EXCEPTION 'Unknown redaction mode %; nothing was redacted', v_mode USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(v_values) <> 'object' THEN
    RAISE EXCEPTION 'replacements.values must be a JSON object of value to pseudonym' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_mode = 'clear_disposed' AND v_values <> '{}'::jsonb THEN
    RAISE EXCEPTION 'The mode clear_disposed takes no replacement values; nothing was redacted' USING ERRCODE = 'invalid_parameter_value';
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
    IF v_mode = 'clear_disposed' THEN
      RAISE EXCEPTION 'The mode clear_disposed works on the audit trail of one organisation only; nothing was redacted'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
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
    IF v_mode = 'clear_disposed' THEN
      -- The row must be about a disposed record, or about a child row of one.
      v_disposed := NULL;
      IF r.entity_id IS NOT NULL AND r.entity_type = ANY (v_records) THEN
        EXECUTE format('SELECT disposed_at IS NOT NULL FROM %I.%I WHERE id = $1', v_schema, r.entity_type) INTO v_disposed USING r.entity_id;
      ELSIF r.entity_id IS NOT NULL AND r.entity_type IN ('audit_activity', 'audit_prep_task') THEN
        EXECUTE format('SELECT p.disposed_at IS NOT NULL FROM %I.%I c JOIN %I.audit_event p ON p.id = c.audit_event_id WHERE c.id = $1',
                       v_schema, r.entity_type, v_schema) INTO v_disposed USING r.entity_id;
      ELSIF r.entity_id IS NOT NULL AND r.entity_type = 'management_review_input' THEN
        EXECUTE format('SELECT p.disposed_at IS NOT NULL FROM %I.management_review_input c JOIN %I.management_review p ON p.id = c.management_review_id WHERE c.id = $1',
                       v_schema, v_schema) INTO v_disposed USING r.entity_id;
      END IF;
      IF v_disposed IS NOT TRUE THEN
        RAISE EXCEPTION 'Row % of % is not about a disposed record; nothing was redacted', v_seq, p_chain
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
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

    IF v_mode = 'clear_disposed' THEN
      v_code := r.entity_code;
      v_before := platform.audit_null_json(r.before_data);
      v_after := platform.audit_null_json(r.after_data);
    ELSE
      v_code := left(platform.audit_redact_text(r.entity_code, v_values), 80);
      v_before := platform.audit_redact_json(r.before_data, v_values);
      v_after := platform.audit_redact_json(r.after_data, v_values);
    END IF;
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

REVOKE ALL ON FUNCTION platform.audit_null_json(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.audit_null_json(jsonb) TO mscd_app;

-- ---------------------------------------------------------------------------------------------------------------
-- platform.secure_tenant_schema: as in 0009, with privacy_request, privacy_check and erased_person excluded from the
-- report login, and SELECT revoked from mscd_report on every excluded table.
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.secure_tenant_schema(target_schema text) RETURNS void LANGUAGE plpgsql
  SET search_path = pg_catalog, platform AS $$
DECLARE
  t record;
  tbl text;
  schema_org uuid;
  member_cols text[];
  report_excluded text[] := ARRAY['storage_credential', 'auditor_access_grant', 'calendar_feed_token',
                                  'upload_intent', 'audit_trail',
                                  -- Milestone 3 M3-13 (security review 5): the requests from one person.
                                  'privacy_request', 'privacy_check', 'erased_person'];
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
    -- An excluded table granted by an earlier version of this function loses the right.
    FOREACH tbl IN ARRAY report_excluded LOOP
      IF to_regclass(format('%I.%I', target_schema, tbl)) IS NOT NULL THEN
        EXECUTE format('REVOKE SELECT ON %I.%I FROM mscd_report', target_schema, tbl);
      END IF;
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = target_schema AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'kysely\_%'
               AND NOT (c.relrowsecurity AND c.relforcerowsecurity)) THEN
    RAISE EXCEPTION 'Schema % has a table without forced row-level security', target_schema;
  END IF;
END $$;

-- The existing tenant schemas lose the report right on the three tables now (tenant/0011_milestone3_review_fix.sql
-- runs the whole function for each of them again).
DO $$
DECLARE
  o record;
  tbl text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_report') THEN
    RETURN;
  END IF;
  FOR o IN SELECT schema_name FROM platform.organization WHERE to_regnamespace(schema_name) IS NOT NULL ORDER BY schema_name LOOP
    FOREACH tbl IN ARRAY ARRAY['privacy_request', 'privacy_check', 'erased_person'] LOOP
      IF to_regclass(format('%I.%I', o.schema_name, tbl)) IS NOT NULL THEN
        EXECUTE format('REVOKE SELECT ON %I.%I FROM mscd_report', o.schema_name, tbl);
      END IF;
    END LOOP;
  END LOOP;
END $$;
