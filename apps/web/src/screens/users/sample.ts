// Sample adapter of the People and roles screen (MILESTONE-2 M2-10): the people of the sample organisation (`PEOPLE`)
// with administration roles and the role grants of the demo seed (each system's manager is its primary MS Manager,
// Rina manages every system), two Tenant Admins (Rina and Tono) and a Storage Admin (Yusuf), an invited person and
// two grants waiting for approval. Changes stay for the browser session and follow the server's rules: a grant to
// yourself or to an administrator waits for another Tenant Admin, who neither asked for it nor receives it.
import type { RoleGrant, UserCreate, UserPatch } from '@mscd/shared';
import type { ControllerData } from '../../data/types';
import { sampleHoldings } from '../handover/sample';
import type { TextPair } from '../types';
import type { AdminRole, BusinessRoleCode, GrantHistory, GrantModel, HoldingsSystem, Member, Result, SystemRef, UsersAdapter } from './model';
import { activeTenantAdmins } from './model';

/** A refusal in the shape of the api's problems. */
function refuse(status: number, message: TextPair, extra: { rule?: string; errors?: { path: string; message: string }[] } = {}): { ok: false; error: { status: number; message: [string, string]; rule?: string; errors?: { path: string; message: string }[] } } {
  return { ok: false, error: { status, message: [message[0], message[1]], ...extra } };
}

const SAMPLE_ADMINS: Readonly<Record<string, AdminRole[]>> = { rina: ['tenant_admin', 'storage_admin'], tono: ['tenant_admin'], yusuf: ['storage_admin'] };
const ONLY_ROLE: Readonly<Record<string, BusinessRoleCode>> = {
  bagus: 'domain_owner', maya: 'internal_auditor', hendra: 'top_management', dewi: 'domain_owner', fajar: 'domain_owner', andi: 'domain_owner', yusuf: 'domain_owner',
};
const NO_FACTOR = new Set(['fajar']);
const OTHER_ORGS = new Set(['hendra', 'maya']);
const INVITED_EMAIL = 'nadia.halim@nusantaradigital.co.id';

/** `<first>.<last>@nusantaradigital.co.id` of a sample name, as the demo seed writes them. */
export function sampleEmail(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).join('.')}@nusantaradigital.co.id`;
}

/** The handle an email gives (its local part, as the server derives it for an invited account). */
export function handleOfEmail(email: string): string {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return /^[a-z]/.test(base) ? base.slice(0, 40) : `u${base}`.slice(0, 40);
}

interface SampleState {
  members: Member[];
  history: Record<string, GrantHistory>;
  /** Counter of the ids of new invitations and grants. */
  seq: number;
}

let state: SampleState | null = null;

/** Clears the session's changes (unit tests). */
export function resetSampleUsers(): void {
  state = null;
}

const person = (D: ControllerData | null, handle: string) => ({ handle, name: D?.PEOPLE?.[handle]?.[0] ?? handle });

/** The sample members of the snapshot's organisation. */
export function sampleMembers(D: ControllerData | null): { members: Member[]; history: Record<string, GrantHistory> } {
  const systems = D?.MS ?? [];
  const today = D?.TODAY_S ?? '2026-09-28';
  const history: Record<string, GrantHistory> = {};
  const members: Member[] = [];
  const handles = Object.keys(D?.PEOPLE ?? {}).filter((h) => h !== 'none');
  handles.forEach((handle, i) => {
    const [name, job] = D!.PEOPLE[handle];
    const roles: GrantModel[] = [];
    for (const m of systems) {
      let role: BusinessRoleCode | null = null;
      if (m.mgr === handle) role = 'ms_manager';
      else if (handle === 'rina') role = 'ms_manager';
      else if (ONLY_ROLE[handle]) role = ONLY_ROLE[handle];
      else if (systems.some((s) => s.mgr === handle)) role = 'domain_owner';
      if (!role) continue;
      const grantId = `sample-grant-${handle}-${m.id}-${role}`;
      roles.push({ grantId, ms: m.id, role, isPrimary: m.mgr === handle && role === 'ms_manager', approvalStatus: 'active', validUntil: null });
      history[grantId] = { requestedBy: null, requestedAt: null, decidedBy: person(D, 'rina'), decidedAt: '2026-02-02T03:00:00Z' };
    }
    const day = String(28 - (i % 20)).padStart(2, '0');
    members.push({
      id: handle,
      handle,
      email: sampleEmail(name),
      displayName: name,
      jobTitle: job === '-' ? null : job,
      kind: 'person',
      accountStatus: 'active',
      membershipStatus: 'active',
      adminRoles: [...(SAMPLE_ADMINS[handle] ?? [])],
      roles,
      mfaEnrolled: !NO_FACTOR.has(handle),
      otherMemberships: OTHER_ORGS.has(handle),
      lastLoginAt: NO_FACTOR.has(handle) ? null : `${today.slice(0, 8)}${day}T02:15:00Z`,
    });
  });
  // Two grants waiting for approval: Tono asks for Yusuf (a Storage Admin), Rina asks for herself.
  const first = systems[0]?.id;
  const second = systems[1]?.id ?? first;
  const yusuf = members.find((m) => m.handle === 'yusuf');
  if (yusuf && first) {
    const grantId = 'sample-grant-pending-yusuf';
    yusuf.roles.push({ grantId, ms: first, role: 'risk_owner', isPrimary: false, approvalStatus: 'pending_approval', validUntil: null });
    history[grantId] = { requestedBy: person(D, 'tono'), requestedAt: '2026-09-26T03:00:00Z', decidedBy: null, decidedAt: null };
  }
  const rina = members.find((m) => m.handle === 'rina');
  if (rina && second) {
    const grantId = 'sample-grant-pending-rina';
    rina.roles.push({ grantId, ms: second, role: 'programme_owner', isPrimary: false, approvalStatus: 'pending_approval', validUntil: null });
    history[grantId] = { requestedBy: person(D, 'rina'), requestedAt: '2026-09-27T03:00:00Z', decidedBy: null, decidedAt: null };
  }
  members.push({
    id: 'sample-invited-1', handle: handleOfEmail(INVITED_EMAIL), email: INVITED_EMAIL, displayName: INVITED_EMAIL, jobTitle: null, kind: 'person',
    accountStatus: 'invited', membershipStatus: 'invited', adminRoles: [], roles: [], mfaEnrolled: false, otherMemberships: false, lastLoginAt: null,
  });
  members.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
  return { members, history };
}

/** The systems of the snapshot: the slug stands for the uuid in the sample. */
export function sampleSystems(D: ControllerData | null): SystemRef[] {
  return (D?.MS ?? []).map((m) => ({ id: m.id, slug: m.id, code: m.short, name: D ? (Array.isArray(m.name) ? m.name[0] : String(m.name)) : m.short, archived: false }));
}

/** Holdings of a member in every system, as `admin.users.holdings` counts them (systems with nothing held are left out). */
export function sampleUserHoldings(D: ControllerData | null, handle: string): HoldingsSystem[] {
  const out: HoldingsSystem[] = [];
  for (const m of D?.MS ?? []) {
    const held = sampleHoldings(D, m.id, handle);
    if (!held.items.length) continue;
    const mgr = m.mgr;
    out.push({
      ms: m.id,
      name: Array.isArray(m.name) ? m.name[0] : String(m.name),
      primaryManager: mgr && D?.PEOPLE?.[mgr] ? { handle: mgr, displayName: D.PEOPLE[mgr][0], email: sampleEmail(D.PEOPLE[mgr][0]) } : null,
      counts: { ...held.counts },
      total: held.items.length,
    });
  }
  return out;
}

const ok = <T,>(data: T, message: TextPair | null = null): Result<T> => ({ ok: true, data, message });
const copy = (m: Member): Member => ({ ...m, adminRoles: [...m.adminRoles], roles: m.roles.map((g) => ({ ...g })) });
const SOD: TextPair = [
  'A role grant is approved or rejected by a Tenant Admin who neither requested it nor receives it',
  'Pemberian peran disetujui atau ditolak oleh Tenant Admin yang bukan pemohon dan bukan penerima',
];
const NO_APPROVER: TextPair = [
  'No other Tenant Admin can approve this grant yet; it stays pending until one does',
  'Belum ada Tenant Admin lain yang dapat menyetujui pemberian peran ini; statusnya tetap menunggu hingga ada',
];

/**
 * The sample adapter; `me` gives the session person's handle (the persona can change) and `tenancy` the tenancy mode
 * of the organisation shown (a SaaS sample organisation stands for multi tenancy).
 */
export function createSampleAdapter(getD: () => ControllerData | null, me: () => string, tenancy: () => 'single' | 'multi' = () => 'single'): UsersAdapter {
  const current = (): SampleState => {
    if (!state) {
      const built = sampleMembers(getD());
      state = { members: built.members, history: built.history, seq: 0 };
    }
    return state;
  };
  const find = (id: string) => current().members.find((m) => m.id === id) ?? null;
  const grantOf = (systemSlug: string, grantId: string) => {
    for (const m of current().members) {
      const g = m.roles.find((r) => r.grantId === grantId && r.ms === systemSlug);
      if (g) return { member: m, grant: g };
    }
    return null;
  };
  const decide = (system: SystemRef, grantId: string, to: 'active' | 'rejected'): Result<null> => {
    const found = grantOf(system.slug, grantId);
    if (!found) return refuse(404, ['Unknown role grant', 'Pemberian peran tidak dikenal']);
    if (found.grant.approvalStatus !== 'pending_approval') return refuse(409, ['This grant is no longer waiting for approval', 'Pemberian peran ini tidak lagi menunggu persetujuan']);
    const self = me();
    const h = current().history[grantId];
    if (found.member.handle === self || h?.requestedBy?.handle === self) return refuse(422, SOD, { rule: 'SOD-SELF-GRANT' });
    found.grant.approvalStatus = to;
    if (to === 'rejected') found.member.roles = found.member.roles.filter((g) => g.grantId !== grantId);
    current().history[grantId] = { ...(h ?? { requestedBy: null, requestedAt: null }), decidedBy: person(getD(), self), decidedAt: new Date().toISOString() };
    return ok(null);
  };
  return {
    members: async () => ok(current().members.map(copy)),
    systems: async () => ok(sampleSystems(getD())),
    providers: async () => {
      const { sampleProviderRefs } = await import('../identity-providers/sample');
      return ok(sampleProviderRefs());
    },
    org: async () => ok({ tenancyMode: tenancy() }),
    async invite(body: UserCreate) {
      const s = current();
      const email = body.email.trim();
      const existing = s.members.find((m) => m.email.toLowerCase() === email.toLowerCase());
      if (existing && existing.membershipStatus === 'active') return ok(null);
      if (existing) {
        existing.membershipStatus = 'invited';
        existing.adminRoles = [...body.adminRoles];
        return ok(null);
      }
      s.seq += 1;
      s.members.push({
        id: `sample-invited-new-${s.seq}`, handle: handleOfEmail(email), email, displayName: email, jobTitle: null, kind: 'person', accountStatus: 'invited',
        membershipStatus: 'invited', adminRoles: [...body.adminRoles], roles: [], mfaEnrolled: false, otherMemberships: false, lastLoginAt: null,
      });
      return ok(null);
    },
    async update(id: string, patch: UserPatch) {
      const s = current();
      const m = find(id);
      if (!m) return refuse(404, ['Not a member of this organisation', 'Bukan anggota organisasi ini']);
      const self = m.handle === me();
      // As the api: the status of an invited membership changes only when the person accepts the invitation.
      if (patch.membershipStatus !== undefined && patch.membershipStatus !== m.membershipStatus && m.membershipStatus === 'invited') {
        return refuse(400, ['Invalid request', 'Invalid request'], { errors: [{ path: 'body.membershipStatus', message: 'An invited membership becomes active when the user accepts it' }] });
      }
      if (patch.membershipStatus === 'disabled' && self) return refuse(403, ['You cannot disable your own membership', 'Anda tidak dapat menonaktifkan keanggotaan Anda sendiri']);
      const otherAdmins = activeTenantAdmins(s.members).filter((x) => x.id !== m.id).length;
      const losesAdmin = (patch.adminRoles && m.adminRoles.includes('tenant_admin') && !patch.adminRoles.includes('tenant_admin')) || (patch.membershipStatus === 'disabled' && m.adminRoles.includes('tenant_admin'));
      if (losesAdmin && otherAdmins === 0) return refuse(400, ['Validation failed', 'Validasi gagal'], { errors: [{ path: 'body', message: 'The organisation needs at least one active Tenant Admin' }] });
      if ((patch.jobTitle !== undefined || patch.displayName !== undefined) && !self && m.otherMemberships) {
        return refuse(403, ['Forbidden', 'Forbidden']);
      }
      if (patch.adminRoles) m.adminRoles = [...patch.adminRoles];
      if (patch.jobTitle !== undefined) m.jobTitle = patch.jobTitle || null;
      if (patch.membershipStatus) m.membershipStatus = patch.membershipStatus;
      return ok(copy(m));
    },
    async grant(system: SystemRef, body: RoleGrant) {
      const s = current();
      const m = s.members.find((x) => x.handle === body.user && x.membershipStatus === 'active');
      if (!m) return refuse(400, ['Validation failed', 'Validasi gagal'], { errors: [{ path: 'body.user', message: 'Name a member' }] });
      if (m.roles.some((g) => g.ms === system.slug && g.role === body.role && g.approvalStatus !== 'rejected')) {
        return refuse(409, ['Conflict', 'Konflik']);
      }
      if (body.isPrimary && s.members.some((x) => x.roles.some((g) => g.ms === system.slug && g.role === body.role && g.isPrimary && g.approvalStatus !== 'rejected'))) {
        return refuse(409, ['Another member holds the primary grant of this role in the system; revoke it first', 'Anggota lain memegang pemberian utama peran ini di sistem; cabut terlebih dahulu']);
      }
      const self = me();
      const pending = m.handle === self || m.adminRoles.length > 0;
      s.seq += 1;
      const grantId = `sample-grant-new-${s.seq}`;
      m.roles.push({ grantId, ms: system.slug, role: body.role, isPrimary: Boolean(body.isPrimary), approvalStatus: pending ? 'pending_approval' : 'active', validUntil: body.validUntil ?? null });
      const now = new Date().toISOString();
      s.history[grantId] = pending
        ? { requestedBy: person(getD(), self), requestedAt: now, decidedBy: null, decidedAt: null }
        : { requestedBy: null, requestedAt: null, decidedBy: person(getD(), self), decidedAt: now };
      const approvers = activeTenantAdmins(s.members).filter((x) => x.handle !== self && x.handle !== m.handle);
      return ok({ approvalStatus: pending ? 'pending_approval' as const : 'active' as const, grantId }, pending && approvers.length === 0 ? NO_APPROVER : null);
    },
    approve: async (system, grantId) => decide(system, grantId, 'active'),
    reject: async (system, grantId) => decide(system, grantId, 'rejected'),
    async revoke(system: SystemRef, grantId: string) {
      const found = grantOf(system.slug, grantId);
      if (!found) return refuse(404, ['Unknown role grant', 'Pemberian peran tidak dikenal']);
      found.member.roles = found.member.roles.filter((g) => g.grantId !== grantId);
      return ok(null);
    },
    async holdings(userId: string) {
      const m = find(userId);
      if (!m) return refuse(404, ['Not a member of this organisation', 'Bukan anggota organisasi ini']);
      return ok(sampleUserHoldings(getD(), m.handle));
    },
    async registerIdentity(userId: string, body) {
      const m = find(userId);
      if (!m) return refuse(404, ['Not a member of this organisation', 'Bukan anggota organisasi ini']);
      const { sampleProviderRefs } = await import('../identity-providers/sample');
      if (!sampleProviderRefs().some((p) => p.slug === body.provider)) return refuse(404, ['Unknown identity provider of this organisation', 'Penyedia identitas tidak dikenal']);
      return ok(null);
    },
    async resetMfa(userId: string) {
      const m = find(userId);
      if (!m) return refuse(404, ['Not a member of this organisation', 'Bukan anggota organisasi ini']);
      if (m.otherMemberships) return refuse(403, ['Forbidden', 'Forbidden']);
      m.mfaEnrolled = false;
      return ok(null);
    },
    history: async (ids) => {
      const all = current().history;
      if (ids === null) return ok({ ...all });
      return ok(Object.fromEntries(ids.filter((id) => all[id]).map((id) => [id, all[id]])));
    },
    currentGrant: async (member, grantId) => {
      const g = find(member.id)?.roles.find((r) => r.grantId === grantId);
      return ok(g ? { ...g } : null);
    },
    // The sample build has no session: a change of your own roles renews nothing.
    renewSession: async () => ok(null),
  };
}
