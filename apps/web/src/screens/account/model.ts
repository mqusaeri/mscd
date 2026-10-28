// The view model of the My account screen (MILESTONE-2 M2-16) and the interface both adapters implement (api.ts in
// API builds, sample.ts in the sample build): the security overview of `GET /me/security`, the company sign-in
// providers that can be linked, password change, new recovery codes, preferences, identity linking and calendar feeds.
import type { ApiError } from '../../data/api/ApiClient';
import type { TextPair } from '../types';
import { TEXT } from './text';

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface LinkedIdentity {
  provider: string;
  kind: 'oidc' | 'saml';
  label: string;
  linkedAt: string;
}

export interface SecurityModel {
  passwordSet: boolean;
  ssoOnly: boolean;
  authenticatorSetUpAt: string | null;
  recoveryCodesLeft: number;
  identities: LinkedIdentity[];
}

/** A company sign-in provider of the organisation (`GET /auth/providers`). */
export interface ProviderModel {
  slug: string;
  kind: 'oidc' | 'saml';
  label: string;
}

export const LANGUAGES = ['en', 'id'] as const;
export const THEMES = ['light', 'dark'] as const;
export const DENSITIES = ['dense', 'comfortable', 'airy'] as const;

/** The preference keys that boot applies before the first render (M2-01 C.3). */
export interface Preferences {
  language: (typeof LANGUAGES)[number];
  theme: (typeof THEMES)[number];
  density: (typeof DENSITIES)[number];
}

export interface AccountAdapter {
  security(): Promise<Result<SecurityModel>>;
  /** The organisation's company sign-in providers; empty when none (or when they cannot be read). */
  providers(org: string | null): Promise<ProviderModel[]>;
  changePassword(currentPassword: string, newPassword: string): Promise<Result<null>>;
  /** Ten new recovery codes; `code` is the current authenticator code (null to rely on a proof of the last 5 minutes). */
  recoveryCodes(code: string | null): Promise<Result<string[]>>;
  savePreferences(preferences: Preferences): Promise<Result<null>>;
  /** Starts linking a provider: the address the browser follows to the provider. */
  linkIdentity(slug: string): Promise<Result<string>>;
  /** Revokes the session user's calendar feed of a system; the server's message. */
  revokeCalendarFeed(ms: string): Promise<Result<TextPair | null>>;
  /** Opens the enrolment page in its re-enrolment mode; an error where there is none (the sample build). */
  replaceAuthenticator(): Result<null>;
  /** The email of a session person without `Me` (a persona of the sample build); null in API builds, where `Me` has it. */
  personEmail(name: string): Promise<string | null>;
}

export const LANGUAGE_TEXT: Readonly<Record<Preferences['language'], TextPair>> = { en: TEXT.langEn, id: TEXT.langId };
export const THEME_TEXT: Readonly<Record<Preferences['theme'], TextPair>> = { light: TEXT.themeLight, dark: TEXT.themeDark };
export const DENSITY_TEXT: Readonly<Record<Preferences['density'], TextPair>> = { dense: TEXT.densityDense, comfortable: TEXT.densityComfortable, airy: TEXT.densityAiry };

const pick = <T extends string>(value: unknown, valid: readonly T[]): T | null => (typeof value === 'string' && (valid as readonly string[]).includes(value) ? (value as T) : null);

/** The preferences to show: the saved ones (`language` or `lang`, `theme`, `density`), else what the app shows now. */
export function preferencesOf(saved: Record<string, unknown> | null | undefined, current: Preferences): Preferences {
  const prefs = saved ?? {};
  return {
    language: pick(prefs.language ?? prefs.lang, LANGUAGES) ?? current.language,
    theme: pick(prefs.theme, THEMES) ?? current.theme,
    density: pick(prefs.density, DENSITIES) ?? current.density,
  };
}

/**
 * Preferences saved in this page session, per user. `Me` is read again only at the next start, so a page opened after a
 * save shows these instead of the older `Me.preferences`.
 */
const saved = new Map<string, Preferences>();

export function rememberSaved(user: string, preferences: Preferences): void {
  saved.set(user, { ...preferences });
}

export function savedFor(user: string): Preferences | null {
  return saved.get(user) ?? null;
}

/** Forgets the preferences saved in this page session (unit tests). */
export function resetSaved(): void {
  saved.clear();
}

/** Problems of the change password form before it is sent. */
export function passwordErrors(form: { current: string; next: string; repeat: string }): Partial<Record<'current' | 'next' | 'repeat', TextPair>> {
  const out: Partial<Record<'current' | 'next' | 'repeat', TextPair>> = {};
  if (!form.current) out.current = TEXT.currentRequired;
  if (form.next.length < 12) out.next = TEXT.tooShort;
  else if (form.repeat !== form.next) out.repeat = TEXT.mismatch;
  return out;
}

/** The text of the session's sign-in method. */
export function methodText(method: string | null | undefined): TextPair | null {
  if (!method) return null;
  if (method === 'local') return TEXT.methodLocal;
  if (method === 'oidc') return TEXT.methodOidc;
  if (method === 'saml') return TEXT.methodSaml;
  if (method === 'guest') return TEXT.methodGuest;
  return TEXT.methodOther;
}

/** The linkable providers: those of the organisation without a linked identity. */
export function linkable(providers: readonly ProviderModel[], security: SecurityModel): ProviderModel[] {
  const linked = new Set(security.identities.map((i) => i.provider));
  return providers.filter((p) => !linked.has(p.slug));
}

/** The text file of recovery codes for Download. */
export function codesFile(codes: readonly string[], header: string): string {
  return `${header}\n\n${codes.join('\n')}\n`;
}
