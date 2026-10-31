// Sample adapter of the My account screen: the persona's email, a password, an authenticator set up in February and
// eight recovery codes left, the organisation's Microsoft sign-in not linked yet. A changed password and new codes follow the server's
// checks (12 characters, a 6-digit code) and stay for the browser session: after a change, the current password is the
// new one; before it, any current password is taken. My data (M3-04): the copy is a file made in the browser from the
// profile shown, and the requests to the organisation stay in this browser session with the server's rule of one open
// request per type.
import type { AccountAdapter, MyRequest, Result, SecurityModel } from './model';
import { myDataFileName } from './model';
import { TEXT } from './text';

let state: SecurityModel | null = null;
/** The password set in this session; null until a change. */
let password: string | null = null;
/** The persona's requests of this session. */
let mine: MyRequest[] = [];
let numbers = 40;

/** Forgets the changes of the session (unit tests). */
export function resetSampleAccount(): void {
  state = null;
  password = null;
  mine = [];
  numbers = 40;
}

function security(): SecurityModel {
  state ??= { passwordSet: true, ssoOnly: false, authenticatorSetUpAt: '2026-02-03T04:05:06Z', recoveryCodesLeft: 8, identities: [] };
  return state;
}

const refuse = <T,>(status: number, message: readonly [string, string], extra: { messageKey?: string; errors?: { path: string; message: string }[] } = {}): Result<T> => ({
  ok: false,
  error: { status, message: [message[0], message[1]], ...extra },
});

/** Ten codes in the shape of F.5 (`xxxx-xxxx-xx`, lowercase base32). */
function newCodes(): string[] {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const part = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return Array.from({ length: 10 }, () => `${part(4)}-${part(4)}-${part(2)}`);
}

/** The email of a person of the sample organisation: `first.last` at its domain. */
export function sampleEmail(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).join('.')}@nusantaradigital.co.id`;
}

export function createSampleAdapter(): AccountAdapter {
  return {
    async security() {
      return { ok: true, data: { ...security(), identities: [...security().identities] } };
    },
    async providers() {
      return [{ slug: 'entra', kind: 'oidc', label: 'Sign in with Microsoft' }];
    },
    async changePassword(currentPassword, newPassword) {
      if (password !== null && currentPassword !== password) return refuse(401, ['The current password is not correct.', 'Kata sandi saat ini tidak benar.'], { messageKey: 'auth.password_invalid' });
      if (newPassword.length < 12) return refuse(400, TEXT.tooShort, { errors: [{ path: 'body.newPassword', message: TEXT.tooShort[0] }] });
      password = newPassword;
      return { ok: true, data: null };
    },
    async recoveryCodes(code) {
      if (!code) return refuse(422, ['Enter the current code from your authenticator app.', 'Masukkan kode saat ini dari aplikasi autentikator Anda.'], { messageKey: 'auth.proof_required' });
      if (!/^\d{6}$/.test(code)) return refuse(422, ['The code is not valid.', 'Kode tidak valid.'], { messageKey: 'auth.proof_invalid' });
      security().recoveryCodesLeft = 10;
      return { ok: true, data: newCodes() };
    },
    async savePreferences() {
      return { ok: true, data: null };
    },
    async linkIdentity() {
      return refuse(503, TEXT.sampleNoSso);
    },
    async revokeCalendarFeed() {
      return { ok: true, data: ['Calendar feed revoked', 'Umpan kalender dicabut'] };
    },
    replaceAuthenticator() {
      return refuse(0, TEXT.sampleOnly);
    },
    async personEmail(name) {
      return sampleEmail(name);
    },
    async myRequests() {
      return { ok: true, data: mine.map((r) => ({ ...r })) };
    },
    async askOrganisation(type) {
      if (mine.some((r) => r.type === type && (r.status === 'received' || r.status === 'in_progress'))) {
        return refuse(409, ['You already have an open request of this type. The organisation answers it first.', 'Anda sudah memiliki permintaan terbuka dengan jenis ini. Organisasi menjawabnya terlebih dahulu.'], { messageKey: 'privacy.open_request' });
      }
      numbers += 1;
      const now = new Date();
      const requestNo = `PR-${now.getUTCFullYear()}-${String(numbers).padStart(3, '0')}`;
      mine = [{ id: `sample-request-${numbers}`, requestNo, type, status: 'received', receivedAt: now.toISOString(), dueAt: new Date(now.getTime() + 72 * 3_600_000).toISOString(), closedAt: null }, ...mine];
      return { ok: true, data: { requestNo } };
    },
    async requestMyData(profile) {
      const now = new Date();
      const handle = profile.email ? profile.email.split('@')[0] : profile.name;
      const text = JSON.stringify({
        format: 'mscd-personal-data-v1',
        generatedAt: now.toISOString(),
        sample: true,
        account: { displayName: profile.name, email: profile.email, jobTitle: profile.jobTitle },
      }, null, 2);
      return { ok: true, data: { file: { text, fileName: myDataFileName(handle, now.toISOString().slice(0, 10)) } } };
    },
    async myDataState() {
      return { ok: true, data: { status: 'succeeded', downloadUrl: null } };
    },
    async correctProfile(correction) {
      if (!correction.displayName.trim()) return refuse(400, TEXT.nameRequired, { errors: [{ path: 'body.displayName', message: TEXT.nameRequired[0] }] });
      return { ok: true, data: null };
    },
  };
}
