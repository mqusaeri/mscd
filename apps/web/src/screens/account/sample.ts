// Sample adapter of the My account screen: the persona's email, a password, an authenticator set up in February and
// eight recovery codes left, the organisation's Microsoft sign-in not linked yet. A changed password and new codes follow the server's
// checks (12 characters, a 6-digit code) and stay for the browser session: after a change, the current password is the
// new one; before it, any current password is taken.
import type { AccountAdapter, Result, SecurityModel } from './model';
import { TEXT } from './text';

let state: SecurityModel | null = null;
/** The password set in this session; null until a change. */
let password: string | null = null;

/** Forgets the changes of the session (unit tests). */
export function resetSampleAccount(): void {
  state = null;
  password = null;
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
  };
}
