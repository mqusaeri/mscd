// The view model of the Pending approvals screen (MILESTONE-2 M2-10): the role grants waiting for a second Tenant Admin
// (from the members of People and roles, with who asked for them from the audit trail metadata) and who may decide on
// each (F.6: a Tenant Admin who neither asked for the grant nor receives it). Pending routing changes come from the
// Routing rules screen of M2-09, which also decides who may approve them (A-50).
import type { BusinessRoleCode, GrantHistory, Member, PersonRef, SystemRef } from '../users/model';
import { approversOf, selfOf } from '../users/model';
import type { HostContext, TextPair } from '../types';
import { TEXT } from './text';

/** A role grant waiting for approval. */
export interface PendingGrant {
  grantId: string;
  member: Member;
  role: BusinessRoleCode;
  ms: string;
  system: SystemRef;
  isPrimary: boolean;
  validUntil: string | null;
  requestedBy: PersonRef | null;
  requestedAt: string | null;
}

/** The pending grants of the members, oldest request first. */
export function pendingGrants(members: readonly Member[], systems: readonly SystemRef[], history: Readonly<Record<string, GrantHistory>>): PendingGrant[] {
  const out: PendingGrant[] = [];
  for (const member of members) {
    for (const g of member.roles) {
      if (g.approvalStatus !== 'pending_approval') continue;
      const system = systems.find((s) => s.slug === g.ms) ?? { id: g.ms, slug: g.ms, code: g.ms.toUpperCase(), name: g.ms, archived: false };
      const h = history[g.grantId];
      out.push({
        grantId: g.grantId, member, role: g.role, ms: g.ms, system, isPrimary: g.isPrimary, validUntil: g.validUntil,
        requestedBy: h?.requestedBy ?? null, requestedAt: h?.requestedAt ?? null,
      });
    }
  }
  return out.sort((a, b) => (a.requestedAt ?? '').localeCompare(b.requestedAt ?? '') || a.member.displayName.localeCompare(b.member.displayName));
}

/** Whether the session holds the Tenant Admin role (the sample manager persona stands for the administrators). */
export function isTenantAdmin(ctx: HostContext): boolean {
  if (ctx.mode !== 'api') return ctx.orgCan('user.manage');
  return Boolean(ctx.me?.adminRoles?.includes('tenant_admin'));
}

/** Why the session may not decide on a grant, or null: never its grantee, never its requester, only a Tenant Admin. */
export function grantDecisionBlock(ctx: HostContext, grant: PendingGrant): TextPair | null {
  const self = selfOf(ctx);
  if (grant.member.id === self.id || grant.member.handle === self.handle) return TEXT.forYou;
  if (grant.requestedBy?.handle && grant.requestedBy.handle === self.handle) return TEXT.ownGrant;
  if (!isTenantAdmin(ctx)) return TEXT.onlyTenantAdmin;
  return null;
}

/** The Tenant Admins who can decide on a grant. */
export function approverNames(members: readonly Member[], grant: PendingGrant): string[] {
  return approversOf(members, grant.requestedBy ? { handle: grant.requestedBy.handle } : null, grant.member.id).map((m) => m.displayName);
}
