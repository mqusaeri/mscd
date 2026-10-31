// The view model of the My account screen (MILESTONE-2 M2-16) and the interface both adapters implement (api.ts in
// API builds, sample.ts in the sample build): the security overview of `GET /me/security`, the company sign-in
// providers that can be linked, password change, new recovery codes, preferences, identity linking and calendar feeds,
// and My data (MILESTONE-3 M3-04, D.6.6): the copy of one's own data, the correction of name and job title, and the
// requests to the organisation.
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

/** What the person can ask the organisation for in My account (a copy is downloaded without a request). */
export const ASK_TYPES = ['rectification', 'restriction', 'erasure'] as const;
export type AskType = (typeof ASK_TYPES)[number];
export type MyRequestType = AskType | 'access';
export type MyRequestStatus = 'received' | 'in_progress' | 'completed' | 'refused' | 'withdrawn';

/** One of the person's own requests (`GET /me/privacy-requests`). */
export interface MyRequest {
  id: string;
  requestNo: string;
  type: MyRequestType;
  status: MyRequestStatus;
  receivedAt: string;
  dueAt: string;
  closedAt: string | null;
}

/** "Download my data": a queued export (API) or a file made in the browser (the sample build). */
export type MyDataTicket = { taskId: string } | { file: { text: string; fileName: string } };

/** The state of the queued export of one's own data. */
export interface MyDataState {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  downloadUrl: string | null;
}

/** The profile a correction saves. */
export interface ProfileCorrection {
  displayName: string;
  jobTitle: string | null;
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
  /** The person's own requests in the current organisation. */
  myRequests(): Promise<Result<MyRequest[]>>;
  /** Asks the organisation for a correction, a stop to the use or an erasure; the number of the new request. */
  askOrganisation(type: AskType, note: string | null): Promise<Result<{ requestNo: string }>>;
  /** Queues the export of one's own data (API), or makes the file in the browser from `profile` (sample). */
  requestMyData(profile: { name: string; email: string | null; jobTitle: string | null }): Promise<Result<MyDataTicket>>;
  /** The state of a queued export of one's own data. */
  myDataState(taskId: string): Promise<Result<MyDataState>>;
  /** Corrects one's own display name and job title. */
  correctProfile(correction: ProfileCorrection): Promise<Result<null>>;
}

export const ASK_TEXT: Readonly<Record<AskType, TextPair>> = {
  rectification: TEXT.askRectification, restriction: TEXT.askRestriction, erasure: TEXT.askErasure,
};
export const MY_TYPE_TEXT: Readonly<Record<MyRequestType, TextPair>> = {
  access: TEXT.typeAccess, rectification: TEXT.typeRectification, restriction: TEXT.typeRestriction, erasure: TEXT.typeErasure,
};
export const MY_STATUS_TEXT: Readonly<Record<MyRequestStatus, TextPair>> = {
  received: TEXT.statusReceived, in_progress: TEXT.statusInProgress, completed: TEXT.statusCompleted, refused: TEXT.statusRefused, withdrawn: TEXT.statusWithdrawn,
};

/** The file name of a copy of one's own data (`personal-data-bagus-2026-10-31.json`). */
export function myDataFileName(handle: string, today: string): string {
  return `personal-data-${handle.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}-${today}.json`;
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
