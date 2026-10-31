// The export of one person's data in one organisation (Milestone 3 D.6.3, `export_file` kind `personal_data`, format
// `json`), built by `export.build` for an access request (`exports.person.create`) or for the person themselves
// (`exports.me.create`). It holds what this organisation keeps about the person:
//
//   account        the account fields this organisation sees (handle, display name, email, job title, kind, status, dates)
//   membership     the membership of this organisation with its admin roles
//   businessRoles  business roles per system with grant dates (revoked ones with the date)
//   linkedSignIns  company sign-in linked for this organisation's providers
//   sessions       sessions in this organisation, with network address and browser
//   signInEvents   sign-in events in this organisation (platform audit entries `auth.*` of the person)
//   auditEntries   the organisation's audit entries where the person acted (action, record, time; no values)
//   records        records the person owns or holds in any system (kind, code, title, status, due date, holder columns)
//   confirmations  read confirmations of policies
//   competenceRecords  competence records about the person
//   notifications  in-app notifications to the person (kind, title, dates)
//   requests       the person's personal data requests
//
// Secrets (password hash, second factors, recovery codes, token and session hashes) and other people's data are left
// out: audit entries carry no before and after values, and no record code of an entry about another account.
import { sql } from 'kysely';
import type { TenantInfo, Trx } from '../../common/tokens';
import { inPlatformScope } from '../identity/platform-scope';
import { competenceCode } from '../risk-registers/competence';

/** Format id of the file (`format` member). */
export const PERSONAL_DATA_FORMAT = 'mscd-personal-data-v1';

/** The sections of the file, in order (the integration tests and the screens name them). */
export const PERSONAL_DATA_SECTIONS = [
  'account', 'membership', 'businessRoles', 'linkedSignIns', 'sessions', 'signInEvents', 'auditEntries', 'records', 'confirmations',
  'competenceRecords', 'notifications', 'requests',
] as const;

/** Columns that name the person who owns or holds a record. */
const HOLDER_COLUMNS = [
  'owner_user_id', 'holder_user_id', 'pending_holder_user_id', 'approver_user_id', 'justification_holder_user_id', 'relationship_owner_user_id',
  'auditor_user_id', 'auditee_user_id', 'completed_by_user_id', 'implemented_by_user_id', 'verified_by_user_id',
] as const;
/** Code, title, status and due date columns, the first that a table has. */
const CODE_COLUMNS = ['code', 'doc_code', 'evidence_code', 'request_no', 'review_no', 'certificate_no', 'item_code', 'requirement_code', 'target_code', 'short_label', 'template_code', 'entity_code'];
const TITLE_COLUMNS = ['title', 'title_en', 'name_en', 'role_title', 'item_title'];
const DUE_COLUMNS = ['due_at', 'action_due_at', 'due_on', 'pending_due_at', 'justification_due_at', 'next_review_at', 'target_fix_at', 'planned_at', 'scheduled_at'];
/** Tables whose rows are covered by a section of their own, or that hold no record of the person's work. */
const NOT_RECORDS = new Set(['notification', 'acknowledgement', 'user_ms_role', 'calendar_feed_token', 'auditor_access_grant', 'reminder', 'erased_person', 'privacy_request', 'privacy_check']);
/** Rows per table at most (a person rarely holds more). */
const RECORDS_PER_TABLE = 5000;
/** Entity types of audit entries about an account, whose record codes name another person. */
const ACCOUNT_ENTITIES = new Set(['user', 'org_membership', 'user_ms_role', 'auditor_access_grant', 'user_identity']);

const iso = (value: Date | string | null | undefined): string | null => (value === null || value === undefined ? null : new Date(value).toISOString());
const day = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
};

/** One held record of the `records` section. */
export interface HeldRecord {
  kind: string;
  code: string | null;
  title: string | null;
  status: string | null;
  dueDate: string | null;
  /** The holder columns that name the person (for example `owner_user_id`). */
  as: string[];
}

/** The content of a personal data export, as the file holds it. */
export interface PersonalData {
  format: typeof PERSONAL_DATA_FORMAT;
  generatedAt: string;
  organisation: { name: string; slug: string };
  account: Record<string, unknown> | null;
  membership: Record<string, unknown> | null;
  businessRoles: Record<string, unknown>[];
  linkedSignIns: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  signInEvents: Record<string, unknown>[];
  auditEntries: Record<string, unknown>[];
  records: HeldRecord[];
  confirmations: Record<string, unknown>[];
  competenceRecords: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  requests: Record<string, unknown>[];
}

/** The file name of a personal data export: `personal-data-<handle>-<date>.json`. */
export function personalDataFileName(handle: string, today: string): string {
  const safe = handle.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'person';
  return `personal-data-${safe}-${today}.json`;
}

/**
 * The name of a stored personal data export with the person's handle replaced by `handle` (an erasure gives the handle
 * form of the pseudonym, D.6.5); the date of the name stays, or the date the file was made when the name has none.
 */
export function renamedPersonalDataFile(fileName: string | null, handle: string, createdAt: Date): string {
  const date = /-(\d{4}-\d{2}-\d{2})\.json$/.exec(fileName ?? '')?.[1] ?? createdAt.toISOString().slice(0, 10);
  return personalDataFileName(handle, date);
}

/** Why a personal data export about a person erased in the organisation is not built or kept (D.6.5). */
export const ERASED_SUBJECT = 'The person was erased in this organisation';

/** True when the person is erased in the transaction's organisation (an `erased_person` row, D.6.5). */
export async function erasedInOrganisation(trx: Trx, userId: string): Promise<boolean> {
  const row = await trx.selectFrom('erased_person').select('erased_user_id').where('erased_user_id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
  return row !== undefined;
}

/** Builds the export of `userId` in the transaction's organisation (`org`). */
export async function personalDataOf(trx: Trx, org: Pick<TenantInfo, 'id' | 'name' | 'slug'>, userId: string, now: Date): Promise<PersonalData> {
  const platform = await inPlatformScope(trx, async () => {
    const account = await trx
      .selectFrom('platform.app_user')
      .select(['handle', 'display_name', 'email', 'job_title', 'kind', 'status', 'created_at', 'last_login_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    const membership = await trx
      .selectFrom('platform.org_membership')
      .select(['status', 'admin_roles', 'created_at', 'deleted_at'])
      .where('organization_id', '=', org.id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const identities = await sql<{ slug: string; name: string; subject: string; link_method: string; linked_at: Date; last_login_at: Date | null }>`
      select p.slug, p.display_name as name, i.subject, i.link_method, i.linked_at, i.last_login_at
        from platform.user_identity i join platform.identity_provider p on p.id = i.identity_provider_id
       where i.user_id = ${userId}::uuid and p.organization_id = ${org.id}::uuid
       order by i.linked_at`.execute(trx);
    const sessions = await sql<{
      created_at: Date; last_seen_at: Date; revoked_at: Date | null; revoke_reason: string | null; idle_expires_at: Date; absolute_expires_at: Date;
      auth_method: string; ip: string | null; user_agent: string | null;
    }>`
      select s.created_at, s.last_seen_at, s.revoked_at, s.revoke_reason, s.idle_expires_at, s.absolute_expires_at, s.auth_method,
             host(s.ip) as ip, s.user_agent
        from platform.session s
       where s.user_id = ${userId}::uuid and (s.organization_id = ${org.id}::uuid or s.auth_org_id = ${org.id}::uuid)
       order by s.created_at`.execute(trx);
    const signIns = await sql<{ occurred_at: Date; action: string; source_ip: string | null; user_agent: string | null }>`
      select a.occurred_at, a.action, host(a.source_ip) as source_ip, a.user_agent
        from platform.audit_log a
       where a.actor_user_id = ${userId}::uuid and a.organization_id = ${org.id}::uuid and a.action like 'auth.%'
       order by a.seq`.execute(trx);
    return { account, membership, identities: identities.rows, sessions: sessions.rows, signIns: signIns.rows };
  });

  const { rows: roles } = await sql<{ ms: string; role: string; is_primary: boolean; approval_status: string; created_at: Date; valid_until: Date | null; deleted_at: Date | null }>`
    select m.slug as ms, r.role, r.is_primary, r.approval_status, r.created_at, r.valid_until, r.deleted_at
      from user_ms_role r join management_system m on m.id = r.management_system_id
     where r.user_id = ${userId}::uuid
     order by m.position, m.slug, r.role, r.created_at`.execute(trx);
  const { rows: entries } = await sql<{ seq: string; occurred_at: Date; action: string; entity_type: string | null; entity_code: string | null; ms: string | null }>`
    select t.seq, t.occurred_at, t.action, t.entity_type, t.entity_code, m.slug as ms
      from audit_trail t left join management_system m on m.id = t.management_system_id
     where t.actor_user_id = ${userId}::uuid
     order by t.seq`.execute(trx);
  const { rows: confirmations } = await sql<{ doc_code: string; title: string; version_label: string; status: string; opened_at: Date | null; confirmed_at: Date | null; excused_reason: string | null; due_on: string }>`
    select d.doc_code, d.title, v.version_label, a.status, a.opened_at, a.confirmed_at, a.excused_reason, r.due_on::text as due_on
      from acknowledgement a
      join acknowledgement_request r on r.id = a.acknowledgement_request_id
      join document d on d.id = r.document_id
      join document_version v on v.id = r.document_version_id
     where a.user_id = ${userId}::uuid and a.deleted_at is null
     order by a.created_at`.execute(trx);
  const { rows: competence } = await sql<{ id: string; role_title: string; competence_required: string; proof_type: string; achieved_at: string | null; valid_until: string | null; verified: boolean }>`
    select c.id, c.role_title, c.competence_required, c.proof_type, c.achieved_at::text as achieved_at, c.valid_until::text as valid_until,
           c.verified_by is not null as verified
      from competence_record c
     where c.user_id = ${userId}::uuid and c.deleted_at is null
     order by c.created_at`.execute(trx);
  const { rows: notifications } = await sql<{ kind: string; title_en: string; title_id: string; created_at: Date; read_at: Date | null }>`
    select n.kind, n.title_en, n.title_id, n.created_at, n.read_at
      from notification n
     where n.recipient_user_id = ${userId}::uuid and n.deleted_at is null
     order by n.created_at`.execute(trx);
  const { rows: requests } = await sql<{ request_no: string; request_type: string; status: string; channel: string; received_at: Date; due_at: Date; closed_at: Date | null; outcome: string | null }>`
    select r.request_no, r.request_type, r.status, r.channel, r.received_at, r.due_at, r.closed_at, r.outcome
      from privacy_request r
     where r.subject_user_id = ${userId}::uuid and r.deleted_at is null
     order by r.received_at`.execute(trx);

  return {
    format: PERSONAL_DATA_FORMAT,
    generatedAt: now.toISOString(),
    organisation: { name: org.name, slug: org.slug },
    account: platform.account
      ? {
        handle: platform.account.handle,
        displayName: platform.account.display_name,
        email: platform.account.email,
        jobTitle: platform.account.job_title,
        kind: platform.account.kind,
        status: platform.account.status,
        createdAt: iso(platform.account.created_at),
        lastSignInAt: iso(platform.account.last_login_at),
      }
      : null,
    membership: platform.membership
      ? {
        status: platform.membership.deleted_at ? 'removed' : platform.membership.status,
        adminRoles: [...platform.membership.admin_roles],
        joinedAt: iso(platform.membership.created_at),
        removedAt: iso(platform.membership.deleted_at),
      }
      : null,
    businessRoles: roles.map((r) => ({
      ms: r.ms, role: r.role, primary: r.is_primary, approvalStatus: r.approval_status, grantedAt: iso(r.created_at), validUntil: iso(r.valid_until), revokedAt: iso(r.deleted_at),
    })),
    linkedSignIns: platform.identities.map((i) => ({
      provider: i.slug, providerName: i.name, subject: i.subject, linkMethod: i.link_method, linkedAt: iso(i.linked_at), lastSignInAt: iso(i.last_login_at),
    })),
    sessions: platform.sessions.map((s) => {
      const expiry = new Date(Math.min(new Date(s.idle_expires_at).getTime(), new Date(s.absolute_expires_at).getTime()));
      const ended = s.revoked_at ? new Date(s.revoked_at) : expiry.getTime() <= now.getTime() ? expiry : null;
      return {
        startedAt: iso(s.created_at),
        lastSeenAt: iso(s.last_seen_at),
        endedAt: iso(ended),
        endReason: s.revoke_reason ?? (ended ? 'expired' : null),
        signInMethod: s.auth_method,
        networkAddress: s.ip,
        browser: s.user_agent,
      };
    }),
    signInEvents: platform.signIns.map((e) => ({ at: iso(e.occurred_at), action: e.action, networkAddress: e.source_ip, browser: e.user_agent })),
    auditEntries: entries.map((e) => ({
      seq: Number(e.seq),
      at: iso(e.occurred_at),
      action: e.action,
      recordType: e.entity_type,
      recordCode: e.entity_type && ACCOUNT_ENTITIES.has(e.entity_type) ? null : e.entity_code,
      ms: e.ms,
    })),
    records: await heldRecords(trx, userId),
    confirmations: confirmations.map((c) => ({
      document: c.doc_code, title: c.title, version: c.version_label, status: c.status, dueOn: c.due_on, openedAt: iso(c.opened_at),
      confirmedAt: iso(c.confirmed_at), excusedReason: c.excused_reason,
    })),
    competenceRecords: competence.map((c) => ({
      code: competenceCode(c.id), roleTitle: c.role_title, competenceRequired: c.competence_required, proofType: c.proof_type,
      achievedOn: c.achieved_at, validUntil: c.valid_until, verified: c.verified,
    })),
    notifications: notifications.map((n) => ({ kind: n.kind, title: { en: n.title_en, id: n.title_id }, createdAt: iso(n.created_at), readAt: iso(n.read_at) })),
    requests: requests.map((r) => ({
      requestNo: r.request_no, type: r.request_type, status: r.status, channel: r.channel, receivedAt: iso(r.received_at), dueAt: iso(r.due_at),
      closedAt: iso(r.closed_at), outcome: r.outcome,
    })),
  };
}

/**
 * Records of every table of the organisation's schema that the person owns or holds through a holder column, with the
 * code, title, status and due date columns the table has. The tables come from the catalogue, so a table added later
 * is covered without a change here.
 */
async function heldRecords(trx: Trx, userId: string): Promise<HeldRecord[]> {
  const { rows: columns } = await sql<{ table: string; column: string }>`
    select c.table_name as table, c.column_name as column
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = current_schema() and c.table_name not like 'kysely\\_%'
     order by c.table_name, c.ordinal_position`.execute(trx);
  const byTable = new Map<string, Set<string>>();
  for (const row of columns) {
    if (!byTable.has(row.table)) byTable.set(row.table, new Set());
    byTable.get(row.table)!.add(row.column);
  }
  const out: HeldRecord[] = [];
  for (const [table, cols] of byTable) {
    if (NOT_RECORDS.has(table) || !cols.has('id')) continue;
    const holders = HOLDER_COLUMNS.filter((c) => cols.has(c));
    if (holders.length === 0) continue;
    const pick = (list: readonly string[]) => list.find((c) => cols.has(c)) ?? null;
    const code = pick(CODE_COLUMNS);
    const title = pick(TITLE_COLUMNS);
    const due = pick(DUE_COLUMNS);
    const status = cols.has('status') ? 'status' : null;
    const expr = (column: string | null) => (column ? sql`${sql.ref(`t.${column}`)}::text` : sql`null::text`);
    const named = holders.map((h) => sql`case when ${sql.ref(`t.${h}`)} = ${userId}::uuid then ${h} end`);
    const anyHolder = holders.map((h) => sql`${sql.ref(`t.${h}`)} = ${userId}::uuid`);
    const alive = cols.has('deleted_at') ? sql`t.deleted_at is null` : sql`true`;
    const { rows } = await sql<{ id: string; code: string | null; title: string | null; status: string | null; due: string | null; named: (string | null)[] }>`
      select t.id::text as id, ${expr(code)} as code, ${expr(title)} as title, ${expr(status)} as status, ${expr(due)} as due,
             array[${sql.join(named)}]::text[] as named
        from ${sql.table(table)} t
       where ${alive} and (${sql.join(anyHolder, sql` or `)})
       order by 2 nulls last, 1
       limit ${RECORDS_PER_TABLE}`.execute(trx);
    for (const row of rows) {
      out.push({
        kind: table,
        code: row.code ?? (table === 'competence_record' ? competenceCode(row.id) : null),
        title: row.title,
        status: row.status,
        dueDate: day(row.due),
        as: (row.named ?? []).filter((n): n is string => typeof n === 'string'),
      });
    }
  }
  return out;
}
