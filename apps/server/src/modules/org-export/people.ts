// People around an organisation export (Milestone 3 D.4, H.2): the active Tenant Admins (who request, approve and
// download), the recipients of the `organization_export_requested` notice (every active Tenant Admin and every primary
// Management System Manager), and how a person is named to the customer (handle and display name of a member, the
// pseudonym of an erased person, nobody for the system or the provider's operators).
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';

/** A person as an export names them: null for the system or someone the customer does not know (an operator). */
export type ExportPersonName = { handle: string; displayName: string } | null;

/** Ids of the active Tenant Admins of the organisation (active account and membership). */
export async function activeTenantAdmins(trx: Trx, orgId: string): Promise<string[]> {
  const { rows } = await sql<{ user_id: string }>`
    select m.user_id from platform.org_membership m join platform.app_user u on u.id = m.user_id
    where m.organization_id = ${orgId}::uuid and m.status = 'active' and m.deleted_at is null
      and 'tenant_admin' = any(m.admin_roles) and u.status = 'active' and u.deleted_at is null
    order by u.handle`.execute(trx);
  return rows.map((r) => r.user_id);
}

/** Every active Tenant Admin and every primary Management System Manager (H.2), each once. */
export async function noticeRecipients(trx: Trx, orgId: string): Promise<string[]> {
  const admins = await activeTenantAdmins(trx, orgId);
  const { rows } = await sql<{ user_id: string }>`
    select distinct r.user_id from user_ms_role r join management_system ms on ms.id = r.management_system_id and ms.deleted_at is null
    where r.role = 'ms_manager' and r.is_primary and r.approval_status = 'active' and r.deleted_at is null
      and (r.valid_until is null or r.valid_until >= now())`.execute(trx);
  return [...new Set([...admins, ...rows.map((r) => r.user_id)])];
}

/** Names of the given accounts as the organisation shows them: members by handle, erased people by pseudonym. */
export async function exportPeople(trx: Trx, orgId: string, ids: readonly (string | null)[]): Promise<Map<string, ExportPersonName>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
  const out = new Map<string, ExportPersonName>();
  if (wanted.length === 0) return out;
  const { rows } = await sql<{ id: string; handle: string; display_name: string; pseudonym: string | null }>`
    select u.id, u.handle, u.display_name, e.pseudonym
    from platform.app_user u
    left join erased_person e on e.erased_user_id = u.id
    where u.id = any(${wanted}::uuid[])
      and (e.erased_user_id is not null
           or exists (select 1 from platform.org_membership m where m.user_id = u.id and m.organization_id = ${orgId}::uuid))`.execute(trx);
  for (const row of rows) {
    out.set(row.id, row.pseudonym ? { handle: row.pseudonym, displayName: row.pseudonym } : { handle: row.handle, displayName: row.display_name });
  }
  return out;
}

/** The name of one person (null when unknown to the organisation). */
export function nameOf(people: Map<string, ExportPersonName>, id: string | null): ExportPersonName {
  return id ? (people.get(id) ?? null) : null;
}
