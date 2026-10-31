// The platform records of the organisation in the export (Milestone 3 D.4): `data/platform/<file>.csv` and `.jsonl`
// for the organisation, its members, its company sign-in providers (without secrets) and linked sign-ins, verified
// domains, plan and limits, status history, sessions in the organisation (without the session id), its entries in the
// platform audit log, and its exports and deletion records. The queries read rows of this organisation only; the
// columns follow `PLATFORM_TABLES` of exclusions.ts. A person listed in `erased_person` appears under the pseudonym
// only (no email, name, handle, linked sign-in or session), and the network address and browser of audit entries
// whose actor is a platform operator or the system are left out, because they belong to the provider's staff.
import { sql, type RawBuilder } from 'kysely';
import type { Trx } from '../../common/tokens';
import { inPlatformScope } from '../identity/platform-scope';
import type { DatasetRow, RowTransform } from './datasets';

/** Who is who for the platform files: the erased people of the organisation and the provider's operator accounts. */
export interface PeopleContext {
  orgId: string;
  /** Erased people of this organisation: account id to pseudonym. */
  erased: ReadonlyMap<string, string>;
  /**
   * Identifying values of erased people (email in lower case, handle, display name; at least 2 characters) to the
   * pseudonym. `pseudonymise` replaces a string only when it is one of these values as a whole.
   */
  erasedValues: ReadonlyMap<string, string>;
  /** Accounts that hold or held the platform operator role. */
  operators: ReadonlySet<string>;
}

/** Reads the people context in the organisation's tenant transaction. */
export async function peopleContext(trx: Trx, orgId: string): Promise<PeopleContext> {
  const erasedRows = await trx.selectFrom('erased_person').select(['erased_user_id', 'pseudonym']).execute();
  const erased = new Map(erasedRows.map((r) => [r.erased_user_id, r.pseudonym]));
  const erasedValues = new Map<string, string>();
  if (erased.size > 0) {
    const accounts = await trx
      .selectFrom('platform.app_user')
      .select(['id', 'email', 'handle', 'display_name'])
      .where('id', 'in', [...erased.keys()])
      .execute();
    for (const account of accounts) {
      const pseudonym = erased.get(account.id)!;
      for (const value of [account.email?.toLowerCase(), account.handle, account.display_name]) {
        const identifying = value?.trim();
        if (identifying && identifying.length >= 2) erasedValues.set(identifying, pseudonym);
      }
    }
  }
  const operatorRows = await trx.selectFrom('platform.platform_role').select('user_id').where('role', '=', 'platform_operator').execute();
  return { orgId, erased, erasedValues, operators: new Set(operatorRows.map((r) => r.user_id)) };
}

/**
 * Replaces every string that is, as a whole, an identifying value of an erased person (an email address in any case)
 * by the pseudonym, inside a string, array or object. A value that only contains one of them (a word that holds a
 * short name) stays as it is, so the export never holds text that MSCD did not store.
 */
export function pseudonymise(value: unknown, values: ReadonlyMap<string, string>): unknown {
  if (values.size === 0 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return values.get(trimmed) ?? (trimmed.includes('@') ? values.get(trimmed.toLowerCase()) : undefined) ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => pseudonymise(v, values));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, pseudonymise(v, values)]));
  }
  return value;
}

/** One file of `data/platform/`. */
export interface PlatformDataset {
  /** File name without extension (`members` gives `data/platform/members.csv` and `.jsonl`). */
  name: string;
  /** Columns of the file in order. */
  columns: readonly string[];
  /** The rows as JSON text (one column `j`). */
  query(ctx: PeopleContext): RawBuilder<unknown>;
  transform?(ctx: PeopleContext): RowTransform;
  /** Rows that row-level security shows only in platform scope (sessions). */
  platformScope?: boolean;
}

const json = (inner: RawBuilder<unknown>) => sql`select row_to_json(x)::text as j from (${inner}) x`;

function nameOf(ctx: PeopleContext, userId: unknown, handle: unknown): unknown {
  return typeof userId === 'string' && ctx.erased.has(userId) ? ctx.erased.get(userId) : handle;
}

function skipErased(ctx: PeopleContext, column: string): RowTransform {
  return (row) => (typeof row[column] === 'string' && ctx.erased.has(row[column] as string) ? null : row);
}

export const PLATFORM_DATASETS: readonly PlatformDataset[] = [
  {
    name: 'organization',
    columns: ['id', 'slug', 'name', 'time_zone', 'site_count', 'status', 'local_login', 'region', 'created_at', 'updated_at', 'deleted_at', 'offboarding_ends_at'],
    query: (ctx) => json(sql`select id, slug, name, time_zone, site_count, status, local_login, region, created_at, updated_at, deleted_at, offboarding_ends_at
      from platform.organization where id = ${ctx.orgId}::uuid`),
  },
  {
    name: 'members',
    columns: [
      'user_id', 'handle', 'email', 'display_name', 'job_title', 'kind', 'account_status', 'organization_id', 'membership_status', 'admin_roles', 'is_default',
      'invited_by_user_id', 'invited_by', 'invited_at', 'accepted_at', 'last_sign_in_at', 'updated_at', 'removed_at', 'account_created_at', 'account_deleted_at',
      'erased_at',
    ],
    query: (ctx) => json(sql`select m.user_id, u.handle, u.email, u.display_name, u.job_title, u.kind, u.status as account_status, m.organization_id,
        m.status as membership_status, m.admin_roles, m.is_default, m.invited_by as invited_by_user_id, inv.handle as invited_by,
        m.created_at as invited_at, m.accepted_at, u.last_login_at as last_sign_in_at, m.updated_at, m.deleted_at as removed_at,
        u.created_at as account_created_at, u.deleted_at as account_deleted_at, u.erased_at
      from platform.org_membership m
      join platform.app_user u on u.id = m.user_id
      left join platform.app_user inv on inv.id = m.invited_by
      where m.organization_id = ${ctx.orgId}::uuid
      order by u.handle, m.user_id`),
    transform: (ctx) => (row) => {
      const out: DatasetRow = { ...row, invited_by: nameOf(ctx, row.invited_by_user_id, row.invited_by) };
      const pseudonym = typeof row.user_id === 'string' ? ctx.erased.get(row.user_id) : undefined;
      if (pseudonym) Object.assign(out, { handle: pseudonym, display_name: pseudonym, email: null, job_title: null, last_sign_in_at: null });
      return out;
    },
  },
  {
    name: 'identity_providers',
    columns: [
      'id', 'organization_id', 'slug', 'kind', 'display_name', 'icon', 'enabled', 'oidc_issuer', 'oidc_client_id', 'oidc_scopes', 'subject_mode', 'entra_tenant_id',
      'saml_entry_point', 'saml_idp_issuer', 'saml_idp_certs', 'saml_sp_entity_id', 'saml_mfa_authn_contexts', 'require_mfa_claim', 'accepted_amr', 'mfa_fallback',
      'jit_provisioning', 'allowed_email_domains', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    ],
    query: (ctx) => json(sql`select id, organization_id, slug, kind, display_name, icon, enabled, oidc_issuer, oidc_client_id, oidc_scopes, subject_mode,
        entra_tenant_id, saml_entry_point, saml_idp_issuer, saml_idp_certs, saml_sp_entity_id, saml_mfa_authn_contexts, require_mfa_claim, accepted_amr,
        mfa_fallback, jit_provisioning, allowed_email_domains, created_at, updated_at, created_by, updated_by, deleted_at
      from platform.identity_provider where organization_id = ${ctx.orgId}::uuid order by slug`),
  },
  {
    name: 'linked_sign_in',
    columns: ['identity_provider_id', 'provider', 'provider_kind', 'subject', 'user_id', 'handle', 'email_at_link', 'link_method', 'linked_by', 'linked_at', 'last_login_at'],
    query: (ctx) => json(sql`select i.identity_provider_id, p.slug as provider, p.kind as provider_kind, i.subject, i.user_id, u.handle, i.email_at_link,
        i.link_method, i.linked_by, i.linked_at, i.last_login_at
      from platform.user_identity i
      join platform.identity_provider p on p.id = i.identity_provider_id
      join platform.app_user u on u.id = i.user_id
      where p.organization_id = ${ctx.orgId}::uuid
      order by p.slug, u.handle`),
    transform: (ctx) => skipErased(ctx, 'user_id'),
  },
  {
    name: 'verified_domains',
    columns: ['organization_id', 'domain', 'status', 'method', 'requested_at', 'verified_at', 'verified_by', 'last_checked_at'],
    query: (ctx) => json(sql`select organization_id, domain, status, method, requested_at, verified_at, verified_by, last_checked_at
      from platform.verified_domain where organization_id = ${ctx.orgId}::uuid order by domain`),
  },
  {
    name: 'licences',
    columns: ['id', 'organization_id', 'license_id', 'document', 'document_sha256', 'key_id', 'installed_at', 'installed_by', 'superseded_at'],
    query: (ctx) => json(sql`select id, organization_id, license_id, document, document_sha256, key_id, installed_at, installed_by, superseded_at
      from platform.licence where organization_id = ${ctx.orgId}::uuid order by installed_at, id`),
  },
  {
    name: 'entitlements',
    columns: [
      'organization_id', 'plan', 'source', 'max_users', 'max_management_systems', 'frameworks', 'storage_adapters', 'features', 'rate_user_per_minute',
      'rate_org_per_minute', 'valid_from', 'valid_until', 'grace_days', 'version', 'updated_at', 'updated_by',
    ],
    query: (ctx) => json(sql`select organization_id, plan, source, max_users, max_management_systems, frameworks, storage_adapters, features,
        rate_user_per_minute, rate_org_per_minute, valid_from, valid_until, grace_days, version, updated_at, updated_by
      from platform.entitlement where organization_id = ${ctx.orgId}::uuid`),
  },
  {
    name: 'status_history',
    columns: ['id', 'organization_id', 'from_status', 'to_status', 'reason', 'actor_user_id', 'created_at'],
    query: (ctx) => json(sql`select id, organization_id, from_status, to_status, reason, actor_user_id, created_at
      from platform.organization_status_event where organization_id = ${ctx.orgId}::uuid order by created_at, id`),
  },
  {
    name: 'sessions',
    columns: [
      'user_id', 'handle', 'organization_id', 'auth_org_id', 'state', 'auth_method', 'identity_provider_id', 'auth_grant_id', 'amr', 'password_at', 'mfa_at',
      'persistent', 'started_at', 'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'ended_at', 'revoke_reason', 'ip', 'user_agent',
    ],
    query: (ctx) => json(sql`select s.user_id, u.handle, s.organization_id, s.auth_org_id, s.state, s.auth_method, s.identity_provider_id, s.auth_grant_id,
        s.amr, s.password_at, s.mfa_at, s.persistent, s.created_at as started_at, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at,
        s.revoked_at as ended_at, s.revoke_reason, host(s.ip) as ip, s.user_agent
      from platform.session s
      join platform.app_user u on u.id = s.user_id
      where s.organization_id = ${ctx.orgId}::uuid
      order by s.created_at, s.user_id`),
    transform: (ctx) => skipErased(ctx, 'user_id'),
    platformScope: true,
  },
  {
    name: 'audit_log',
    columns: [
      'seq', 'id', 'occurred_at', 'organization_id', 'management_system_id', 'actor_user_id', 'actor_kind', 'action', 'entity_type', 'entity_id', 'entity_code',
      'before_data', 'after_data', 'edition', 'request_id', 'source_ip', 'user_agent', 'prev_hash', 'row_hash', 'redacted_at', 'redaction_id',
    ],
    query: (ctx) => json(sql`select seq, id, occurred_at, organization_id, management_system_id, actor_user_id, actor_kind, action, entity_type,
        entity_id, entity_code, before_data, after_data, edition, request_id, host(source_ip) as source_ip, user_agent,
        encode(prev_hash, 'hex') as prev_hash, encode(row_hash, 'hex') as row_hash, redacted_at, redaction_id
      from platform.audit_log where organization_id = ${ctx.orgId}::uuid order by seq`),
    transform: (ctx) => (row) => {
      const actor = typeof row.actor_user_id === 'string' ? row.actor_user_id : null;
      const staff = row.actor_kind === 'operator' || row.actor_kind === 'system' || (actor !== null && ctx.operators.has(actor));
      const erasedActor = actor !== null && ctx.erased.has(actor);
      const out: DatasetRow = {
        ...row,
        entity_code: pseudonymise(row.entity_code, ctx.erasedValues),
        before_data: pseudonymise(row.before_data, ctx.erasedValues),
        after_data: pseudonymise(row.after_data, ctx.erasedValues),
      };
      if (staff || erasedActor) Object.assign(out, { source_ip: null, user_agent: null });
      return out;
    },
  },
  {
    name: 'exports',
    columns: [
      'id', 'organization_id', 'status', 'requested_via', 'requested_by', 'requested_at', 'decided_by', 'decided_at', 'decision_note', 'is_final', 'part_count',
      'file_count', 'size_bytes', 'parts', 'manifest_object_id', 'manifest_sha256', 'expires_at', 'completed_at', 'download_count', 'error', 'created_at', 'updated_at',
    ],
    query: (ctx) => json(sql`select id, organization_id, status, requested_via, requested_by, requested_at, decided_by, decided_at, decision_note, is_final,
        part_count, file_count, size_bytes, parts, manifest_object_id, manifest_sha256, expires_at, completed_at, download_count, error, created_at, updated_at
      from platform.organization_export where organization_id = ${ctx.orgId}::uuid order by requested_at, id`),
  },
  {
    name: 'deletions',
    columns: [
      'id', 'organization_id', 'status', 'scheduled_for', 'scheduled_by', 'reason', 'final_export_id', 'started_at', 'completed_at', 'failed_step', 'error',
      'report', 'vault_objects_deleted', 'certificate', 'certificate_signature', 'certificate_key_id', 'created_at', 'updated_at',
    ],
    query: (ctx) => json(sql`select id, organization_id, status, scheduled_for, scheduled_by, reason, final_export_id, started_at, completed_at, failed_step,
        error, report, vault_objects_deleted, certificate, certificate_signature, certificate_key_id, created_at, updated_at
      from platform.organization_deletion where organization_id = ${ctx.orgId}::uuid order by created_at, id`),
  },
];

/**
 * Runs `fn` with the scope a dataset needs: sessions are visible to their own user only unless platform scope is on, so
 * that one query switches it on inside the organisation's transaction (filtered by the organisation id) and back off.
 */
export function inDatasetScope<T>(trx: Trx, dataset: PlatformDataset, fn: () => Promise<T>): Promise<T> {
  return dataset.platformScope ? inPlatformScope(trx, fn) : fn();
}
