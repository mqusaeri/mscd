// The accounts and platform operators of the sample service (MILESTONE-2 M2-19), for the sample build of the operator
// console: the people of the sample snapshot in PT Nusantara Digital Teknologi, a few people of the two other sample
// organisations, a guest auditor, the system account and two operators, of which the signed-in one is "you". The
// actions follow the rules of the server (`ops.accounts.*`, `ops.operators.*`): the refusals with their message keys
// and texts in both languages, the ETag of an account for `If-Match`, the sessions an action ends and an audit entry
// with the reason. The changes stay for the browser session.
import type { ControllerData } from '../../data/types';
import type {
  AccountAuditEntry, AccountDetail, AccountItem, AccountPage, AccountQuery, AccountSession, AccountStatus, ActionDone, Membership, OperatorAdded,
  OperatorItem, OperatorRemoved,
} from './account-model';
import type { Result } from './model';

type Extra = { messageKey?: string; slug?: string; errors?: { path: string; message: string }[] };
const refuse = <T,>(status: number, message: readonly [string, string], extra: Extra = {}): Result<T> => ({
  ok: false,
  error: { status, message: [message[0], message[1]], ...extra },
});

/** The id of the system account of an installation (the server's `SYSTEM_USER_ID`). */
export const SYSTEM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';
/** The signed-in operator of the sample build. */
export const SAMPLE_SELF_ID = '00000000-0000-4000-8000-0000000c0001';

interface SampleAccount {
  item: AccountItem;
  sessions: AccountSession[];
  audit: AccountAuditEntry[];
  version: number;
  operator: { grantedAt: string; grantedBy: { handle: string; displayName: string } | null; passwordSet: boolean } | null;
}

interface State {
  accounts: SampleAccount[];
  next: number;
}

let state: State | null = null;

/** Forgets the changes of the session (unit tests). */
export function resetSampleAccounts(): void {
  state = null;
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORGS: Readonly<Record<string, string>> = { ndt: 'PT Nusantara Digital Teknologi', bsd: 'PT Bank Sentosa Digital', rmn: 'RS Medika Nusantara' };
const member = (org: string, status: Membership['status'] = 'active', adminRoles: Membership['adminRoles'] = []): Membership => ({ org, orgName: ORGS[org] ?? org, status, adminRoles });
const CHROME = 'Chrome 130, Windows';
const SAFARI = 'Safari 17, iOS';
const FIREFOX = 'Firefox 131, Linux';

function account(
  n: number,
  handle: string,
  email: string,
  displayName: string,
  memberships: Membership[],
  extra: Partial<AccountItem> = {},
  sessions: AccountSession[] = [],
): SampleAccount {
  return {
    item: {
      id: id(n), handle, email, displayName, kind: 'person', status: 'active', mfaEnrolled: true, locked: false, lastSignInAt: '2026-09-28T02:15:00Z',
      createdAt: '2026-02-03T03:00:00Z', platformOperator: false, memberships, etag: 'W/"1"', ...extra,
    },
    sessions,
    audit: [],
    version: 1,
    operator: null,
  };
}

const session = (org: string | null, browser: string, network: string, startedAt = '2026-09-29T01:05:00Z', lastSeenAt = '2026-09-29T02:40:00Z', method = 'local'): AccountSession => ({
  startedAt, lastSeenAt, method, state: 'active', network, browser, org,
});

/** The sample's people at ndt with the address form of the sample (`rina.kusuma@nusantaradigital.co.id`). */
function ndtPeople(D: ControllerData | null): SampleAccount[] {
  const people = Object.entries((D as { PEOPLE?: Record<string, [string, string]> } | null)?.PEOPLE ?? {}).filter(([handle]) => handle !== 'none');
  return people.map(([handle, [name]], i) => {
    const email = `${name.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).join('.')}@nusantaradigital.co.id`;
    const base = account(100 + i, handle, email, name, [member('ndt')]);
    if (handle === 'rina') {
      base.item.memberships = [member('ndt', 'active', ['tenant_admin']), member('bsd')];
      base.sessions = [session('ndt', CHROME, '203.0.113.0/24'), session('bsd', SAFARI, '2001:db8:12::/48', '2026-09-28T23:10:00Z', '2026-09-29T00:05:00Z')];
      base.audit = [
        { at: '2026-09-29T01:05:00Z', action: 'auth.login', actorKind: 'user', actor: { handle, displayName: name }, org: 'ndt', reason: null },
        { at: '2026-09-28T23:10:00Z', action: 'auth.login', actorKind: 'user', actor: { handle, displayName: name }, org: 'bsd', reason: null },
      ];
    } else if (handle === 'sari') {
      base.item.locked = true;
      base.audit = [{ at: '2026-09-29T00:42:00Z', action: 'auth.mfa_locked', actorKind: 'user', actor: { handle, displayName: name }, org: 'ndt', reason: null }];
    } else if (handle === 'lina') {
      Object.assign(base.item, { status: 'invited', mfaEnrolled: false, lastSignInAt: null, memberships: [member('ndt', 'invited')] });
    } else if (handle === 'tono') {
      Object.assign(base.item, { status: 'disabled', lastSignInAt: '2026-06-30T08:00:00Z' });
    } else if (handle === 'dewi') {
      Object.assign(base.item, { mfaEnrolled: false, lastSignInAt: null });
    } else if (handle === 'hendra') {
      base.sessions = [session('ndt', FIREFOX, '198.51.100.0/24', '2026-09-29T00:30:00Z', '2026-09-29T02:10:00Z')];
    }
    return base;
  });
}

function initial(D: ControllerData | null): State {
  const self = account(1, 'ops', 'ops@mscd.example', 'Platform Operator', [], { platformOperator: true, lastSignInAt: '2026-09-29T00:58:00Z' }, [
    session(null, CHROME, '203.0.113.0/24', '2026-09-29T00:58:00Z', '2026-09-29T02:44:00Z'),
  ]);
  self.item.id = SAMPLE_SELF_ID;
  self.operator = { grantedAt: '2026-01-20T03:00:00Z', grantedBy: null, passwordSet: true };
  const nadia = account(2, 'nadia.putri', 'nadia.putri@mscd.example', 'Nadia Putri', [], { platformOperator: true, mfaEnrolled: false, lastSignInAt: null, createdAt: '2026-09-27T04:00:00Z' });
  nadia.operator = { grantedAt: '2026-09-27T04:00:00Z', grantedBy: { handle: 'ops', displayName: 'Platform Operator' }, passwordSet: false };
  const system = account(0, 'system', 'system@mscd.invalid', 'System', [], { kind: 'system', mfaEnrolled: false, lastSignInAt: null, createdAt: '2026-01-20T02:00:00Z' });
  system.item.id = SYSTEM_ACCOUNT_ID;
  const guest = account(300, 'auditor.ext', 'auditor@sertifikasi-indonesia.co.id', 'Bambang Auditor', [], { kind: 'guest', mfaEnrolled: false, lastSignInAt: '2026-09-15T02:00:00Z' });
  return {
    next: 400,
    accounts: [
      self,
      nadia,
      system,
      ...ndtPeople(D),
      account(200, 'agus.salim', 'agus.salim@banksentosa.co.id', 'Agus Salim', [member('bsd', 'active', ['tenant_admin'])], {}, [session('bsd', CHROME, '192.0.2.0/24')]),
      account(201, 'putri.ayu', 'putri.ayu@banksentosa.co.id', 'Putri Ayu', [member('bsd', 'active', ['storage_admin'])], { mfaEnrolled: false }),
      account(210, 'wahyu.hidayat', 'wahyu.hidayat@medikanusantara.co.id', 'Wahyu Hidayat', [member('rmn', 'active', ['tenant_admin'])]),
      account(211, 'nurul.huda', 'nurul.huda@medikanusantara.co.id', 'Nurul Huda', [member('rmn', 'invited')], { status: 'invited', mfaEnrolled: false, lastSignInAt: null }),
      guest,
    ],
  };
}

const copy = (a: SampleAccount): AccountItem => ({ ...a.item, memberships: a.item.memberships.map((m) => ({ ...m, adminRoles: [...m.adminRoles] })) });

/** The sample adapter's account and operator methods over the session's state. */
export function sampleAccounts(getD: () => ControllerData | null, now: () => string) {
  const current = () => {
    state ??= initial(getD());
    return state;
  };
  const find = (accountId: string) => current().accounts.find((a) => a.item.id === accountId) ?? null;
  const unknown = <T,>() => refuse<T>(404, ['This account does not exist or was deleted.', 'Akun ini tidak ada atau telah dihapus.'], { slug: 'not-found', messageKey: 'unknown_account' });
  const systemRefusal = <T,>() => refuse<T>(409, [
    'This is a system account of the installation. It cannot sign in and takes no action.',
    'Ini akun sistem instalasi. Akun ini tidak dapat masuk dan tidak menerima tindakan apa pun.',
  ], { slug: 'conflict', messageKey: 'system_account' });
  const ownRefusal = <T,>() => refuse<T>(403, [
    'You cannot do this to your own account. Ask another platform operator.',
    'Anda tidak dapat melakukan ini pada akun Anda sendiri. Mintalah operator platform lain.',
  ], { slug: 'forbidden', messageKey: 'own_account' });
  const lastRefusal = <T,>() => refuse<T>(409, [
    'This is the last active platform operator. Add another operator first.',
    'Ini operator platform aktif terakhir. Tambahkan operator lain terlebih dahulu.',
  ], { slug: 'conflict', messageKey: 'last_operator' });
  const self = () => find(SAMPLE_SELF_ID)!;
  const record = (a: SampleAccount, action: string, reason: string) => {
    a.audit.unshift({ at: now(), action, actorKind: 'operator', actor: { handle: self().item.handle, displayName: self().item.displayName }, org: null, reason: reason.trim() });
  };
  const touch = (a: SampleAccount) => {
    a.version += 1;
    a.item.etag = `W/"${a.version}"`;
  };
  const done = (a: SampleAccount, sessionsRevoked: number, emailed: boolean, message: [string, string]): Result<ActionDone> => ({
    ok: true,
    data: { status: a.item.status, sessionsRevoked, emailed, link: null, message },
  });
  const endAll = (a: SampleAccount) => {
    const n = a.sessions.length;
    a.sessions = [];
    return n;
  };
  const activeOperators = () => current().accounts.filter((a) => a.operator && a.item.status === 'active');

  return {
    async accounts(query: AccountQuery): Promise<Result<AccountPage>> {
      const q = query.q?.trim().toLowerCase() ?? '';
      const rows = current().accounts
        .filter((a) => !q || a.item.displayName.toLowerCase().includes(q) || a.item.email.toLowerCase().includes(q) || a.item.handle.includes(q))
        .filter((a) => !query.org || a.item.memberships.some((m) => m.org === query.org))
        .filter((a) => !query.status || a.item.status === query.status)
        .filter((a) => !query.kind || a.item.kind === query.kind)
        .sort((x, y) => x.item.displayName.localeCompare(y.item.displayName) || x.item.email.localeCompare(y.item.email));
      const start = (query.page - 1) * query.pageSize;
      return { ok: true, data: { items: rows.slice(start, start + query.pageSize).map(copy), page: query.page, pageSize: query.pageSize, total: rows.length } };
    },
    async account(accountId: string): Promise<Result<AccountDetail>> {
      const a = find(accountId);
      if (!a) return unknown();
      return { ok: true, data: { ...copy(a), sessions: a.sessions.map((s) => ({ ...s })), audit: a.audit.slice(0, 20).map((e) => ({ ...e, actor: e.actor ? { ...e.actor } : null })) } };
    },
    async resetMfa(accountId: string, reason: string): Promise<Result<ActionDone>> {
      if (accountId === SAMPLE_SELF_ID) return ownRefusal();
      const a = find(accountId);
      if (!a) return unknown();
      if (a.item.kind === 'system') return systemRefusal();
      if (!a.item.mfaEnrolled) {
        return refuse(409, ['This account has no second factor set up, so there is nothing to reset.', 'Akun ini belum mengatur faktor kedua, jadi tidak ada yang perlu diatur ulang.'], { slug: 'conflict', messageKey: 'no_second_factor' });
      }
      a.item.mfaEnrolled = false;
      a.item.locked = false;
      const n = endAll(a);
      touch(a);
      record(a, 'auth.mfa_reset', reason);
      return done(a, n, true, [
        `The second factor of ${a.item.email} was reset. ${n} session(s) were ended and the account was told by email.`,
        `Faktor kedua ${a.item.email} telah diatur ulang. ${n} sesi diakhiri dan akun diberi tahu melalui email.`,
      ]);
    },
    async sendPasswordLink(accountId: string, reason: string): Promise<Result<ActionDone>> {
      const a = find(accountId);
      if (!a) return unknown();
      if (a.item.kind === 'system') return systemRefusal();
      if (a.item.kind === 'guest') return refuse(409, ['A guest account signs in with one-time codes and has no password.', 'Akun tamu masuk dengan kode sekali pakai dan tidak memiliki kata sandi.'], { slug: 'conflict', messageKey: 'guest_account' });
      if (a.item.status !== 'active') {
        return refuse(409, a.item.status === 'invited'
          ? ['This account has not accepted its invitation yet. Send the invitation again instead.', 'Akun ini belum menerima undangannya. Kirim ulang undangan sebagai gantinya.']
          : ['This account is disabled. Enable it before you send a password link.', 'Akun ini dinonaktifkan. Aktifkan terlebih dahulu sebelum mengirim tautan kata sandi.'], { slug: 'conflict', messageKey: 'account_not_active' });
      }
      record(a, 'auth.password_reset', reason);
      return done(a, 0, true, [
        `A link to set a new password was emailed to ${a.item.email}. It works once, for 30 minutes.`,
        `Tautan untuk mengatur kata sandi baru telah dikirim ke ${a.item.email}. Tautan berlaku sekali, selama 30 menit.`,
      ]);
    },
    async resendInvitation(accountId: string, org: string, reason: string): Promise<Result<ActionDone>> {
      const a = find(accountId);
      if (!a) return unknown();
      if (a.item.kind === 'system') return systemRefusal();
      const m = a.item.memberships.find((x) => x.org === org);
      if (!m) {
        return refuse(404, ['The account has no membership of this organisation.', 'Akun ini tidak memiliki keanggotaan di organisasi ini.'], { slug: 'not-found', messageKey: 'membership_not_found' });
      }
      if (m.status !== 'invited') {
        return refuse(409, ['This membership is not waiting for its invitation to be accepted.', 'Keanggotaan ini tidak sedang menunggu undangannya diterima.'], { slug: 'conflict', messageKey: 'membership_not_invited' });
      }
      record(a, 'user.invited', reason);
      return done(a, 0, true, [
        `A new invitation to ${m.orgName} was emailed to ${a.item.email}. The older links no longer work.`,
        `Undangan baru ke ${m.orgName} telah dikirim ke ${a.item.email}. Tautan lama tidak berlaku lagi.`,
      ]);
    },
    async endSessions(accountId: string, reason: string): Promise<Result<ActionDone>> {
      if (accountId === SAMPLE_SELF_ID) return ownRefusal();
      const a = find(accountId);
      if (!a) return unknown();
      if (a.item.kind === 'system') return systemRefusal();
      const n = endAll(a);
      record(a, 'auth.session_revoked', reason);
      return done(a, n, false, [`${n} session(s) of ${a.item.email} were ended. The person signs in again.`, `${n} sesi ${a.item.email} diakhiri. Orang tersebut masuk kembali.`]);
    },
    async setAccountStatus(accountId: string, status: 'active' | 'disabled', reason: string, ifMatch: string): Promise<Result<ActionDone>> {
      if (accountId === SAMPLE_SELF_ID) return ownRefusal();
      const a = find(accountId);
      if (!a) return unknown();
      if (a.item.kind === 'system') return systemRefusal();
      if (ifMatch && ifMatch !== a.item.etag) return refuse(412, ['The record has changed', 'The record has changed'], { slug: 'precondition-failed' });
      if (a.item.status === status) {
        return refuse(409, [`The account is ${status} already.`, status === 'active' ? 'Akun ini sudah aktif.' : 'Akun ini sudah dinonaktifkan.'], { slug: 'conflict', messageKey: 'status_unchanged' });
      }
      if (a.item.status === 'invited') {
        return refuse(409, status === 'active'
          ? ['An invited account becomes active when the person accepts the invitation.', 'Akun yang diundang menjadi aktif saat orang tersebut menerima undangan.']
          : ['An invited account becomes active when the person accepts the invitation. It can be disabled after that.', 'Akun yang diundang menjadi aktif saat orang tersebut menerima undangan. Setelah itu akun dapat dinonaktifkan.'],
        { slug: 'conflict', messageKey: 'account_invited' });
      }
      if (status === 'disabled' && a.operator && activeOperators().length === 1 && activeOperators()[0] === a) return lastRefusal();
      a.item.status = status as AccountStatus;
      const n = status === 'disabled' ? endAll(a) : 0;
      touch(a);
      record(a, 'user.updated', reason);
      return done(a, n, false, status === 'disabled'
        ? [`${a.item.email} was disabled. ${n} session(s) were ended.`, `${a.item.email} dinonaktifkan. ${n} sesi diakhiri.`]
        : [`${a.item.email} can sign in again.`, `${a.item.email} dapat masuk kembali.`]);
    },
    async operators(): Promise<Result<OperatorItem[]>> {
      const rows = current().accounts.filter((a) => a.operator).sort((x, y) => x.item.displayName.localeCompare(y.item.displayName));
      return {
        ok: true,
        data: rows.map((a) => ({
          id: a.item.id, handle: a.item.handle, email: a.item.email, displayName: a.item.displayName, status: a.item.status, mfaEnrolled: a.item.mfaEnrolled,
          passwordSet: a.operator!.passwordSet, lastSignInAt: a.item.lastSignInAt, grantedAt: a.operator!.grantedAt,
          grantedBy: a.operator!.grantedBy ? { ...a.operator!.grantedBy } : null, self: a.item.id === SAMPLE_SELF_ID,
        })),
      };
    },
    async addOperator(body: { email: string; name: string; reason: string }): Promise<Result<OperatorAdded>> {
      const email = body.email.trim();
      const s = current();
      const existing = s.accounts.find((a) => a.item.kind !== 'guest' && a.item.email.toLowerCase() === email.toLowerCase()) ?? null;
      if (existing?.item.kind === 'system') return systemRefusal();
      if (existing?.item.status === 'disabled') {
        return refuse(409, ['The account of this email address is disabled. Enable it first.', 'Akun dengan alamat email ini dinonaktifkan. Aktifkan terlebih dahulu.'], { slug: 'conflict', messageKey: 'account_disabled' });
      }
      if (existing?.operator && existing.operator.passwordSet) {
        return refuse(409, [`${existing.item.email} is a platform operator already.`, `${existing.item.email} sudah menjadi operator platform.`], { slug: 'conflict', messageKey: 'already_operator' });
      }
      const grantedBy = { handle: self().item.handle, displayName: self().item.displayName };
      let target = existing;
      if (!target) {
        s.next += 1;
        const handle = email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^[^a-z]+/, '') || `user${s.next}`;
        target = account(s.next, handle, email, body.name.trim(), [], { mfaEnrolled: false, lastSignInAt: null, createdAt: now() });
        s.accounts.push(target);
      } else {
        target.item.status = 'active';
      }
      const passwordSet = existing !== null && existing.item.status === 'active' && existing.item.lastSignInAt !== null;
      target.operator = { grantedAt: now(), grantedBy, passwordSet };
      target.item.platformOperator = true;
      touch(target);
      record(target, 'ops.operator_created', body.reason);
      const message: [string, string] = passwordSet
        ? [`${target.item.email} is now a platform operator and was told by email.`, `${target.item.email} sekarang operator platform dan telah diberi tahu melalui email.`]
        : [`${target.item.email} is now a platform operator. A link to set the password was emailed; it works once, for 72 hours.`, `${target.item.email} sekarang operator platform. Tautan untuk mengatur kata sandi telah dikirim; berlaku sekali, selama 72 jam.`];
      return { ok: true, data: { id: target.item.id, email: target.item.email, newAccount: existing === null, emailed: true, link: null, message } };
    },
    async removeOperator(accountId: string, reason: string): Promise<Result<OperatorRemoved>> {
      if (accountId === SAMPLE_SELF_ID) return ownRefusal();
      const a = find(accountId);
      if (!a) return unknown();
      if (a.item.kind === 'system') return systemRefusal();
      if (!a.operator) return refuse(404, ['The account is not a platform operator.', 'Akun ini bukan operator platform.'], { slug: 'not-found', messageKey: 'not_operator' });
      const active = activeOperators();
      if (a.item.status === 'active' && active.length === 1 && active[0] === a) return lastRefusal();
      a.operator = null;
      a.item.platformOperator = false;
      const n = endAll(a);
      touch(a);
      record(a, 'ops.operator_revoked', reason);
      const left = activeOperators().length;
      return {
        ok: true,
        data: { sessionsRevoked: n, operatorsLeft: left, message: [`${a.item.email} is no longer a platform operator. ${n} session(s) were ended.`, `${a.item.email} bukan lagi operator platform. ${n} sesi diakhiri.`] },
      };
    },
  };
}
