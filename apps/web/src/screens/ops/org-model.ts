// The organisation lifecycle of the operator console (MILESTONE-2 M2-S12): the detail, status, domain, entitlement and
// history models both adapters answer, and the pure rules of the drawer: the status machine of J.8 with the slug
// confirmation and the effects listed before a move, days left of a plan, the entitlement form with its plan picker and
// its body, the ETag of an entitlement, the texts of a domain check and of the refusals.
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext, TextPair } from '../types';
import type { Tone } from '../ui';
import { ORG_TEXT } from './org-text';

export const ORG_STATUSES = ['active', 'suspended', 'offboarding', 'archived'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const DOMAIN_STATUSES = ['pending', 'verified', 'failed'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];
export type DomainMethod = 'dns' | 'manual';
export type EntitlementSource = 'preset' | 'manual' | 'signed_licence';

export const STORAGE_ADAPTER_NAMES = ['managed_vault', 'm365', 'google_drive', 'smb', 's3', 'webdav'] as const;
export type StorageAdapterName = (typeof STORAGE_ADAPTER_NAMES)[number];
/** The adapters the form offers. SMB, S3 and WebDAV are not built (plan B); a row that holds one keeps it. */
export const OFFERED_ADAPTERS: readonly StorageAdapterName[] = ['managed_vault', 'm365', 'google_drive'];
export const FEATURE_NAMES = ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
/** Framework codes of the packs (ISO/IEC 27001, ISO 9001, ISO 22301, ISO 37001); a row may hold others, which it keeps. */
export const KNOWN_FRAMEWORKS: readonly string[] = ['ISO27001', 'ISO9001', 'ISO22301', 'ISO37001'];

/** The read-only period of an organisation in offboarding before it is archived (decision D-S5). */
export const READ_ONLY_DAYS = 30;
/** `valid_until` of an entitlement without an end date in the licence views (M2-S10). */
export const NO_END = '9999-12-31';
/** Rows per page of the status history. */
export const EVENT_PAGE_SIZE = 20;

/** `ops.organizations.get` (M2-S09). */
export interface OrgDetail {
  slug: string;
  name: string;
  status: OrgStatus;
  region: string | null;
  createdAt: string;
  memberCount: number;
  systemCount: number;
  entitlement: { plan: string | null; source: EntitlementSource; maxUsers: number; maxManagementSystems: number; validUntil: string | null } | null;
  domains: { domain: string; status: DomainStatus }[];
  lastSignInAt: string | null;
}

/** The body of `ops.organizations.status`. */
export interface StatusChange {
  status: OrgStatus;
  reason: string;
  confirmSlug?: string;
}

/** The answer of `ops.organizations.status`: the move, the sessions it ended and the Tenant Admins told by email. */
export interface StatusChanged {
  from: OrgStatus;
  to: OrgStatus;
  sessionsRevoked: number;
  tenantAdmins: number;
  tenantAdminsEmailed: number;
  message: TextPair | null;
}

export interface StatusEvent {
  id: string;
  from: OrgStatus;
  to: OrgStatus;
  reason: string;
  actor: { handle: string; displayName: string } | null;
  at: string;
}

export interface EventPage {
  items: StatusEvent[];
  page: number;
  pageSize: number;
  total: number;
}

/** `ops.domains.list` (M2-S11). */
export interface Domain {
  domain: string;
  status: DomainStatus;
  method: DomainMethod;
  requestedAt: string | null;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  /** Pending domains: the end of the hourly checks; null otherwise. */
  pendingUntil: string | null;
  txtName: string;
}

/** The answer of `ops.domains.add`: the record the customer adds to DNS. `txtValue` is shown once and never kept. */
export interface DomainAdded {
  domain: string;
  txtName: string;
  txtValue: string;
  status: DomainStatus;
}

/** The answer of "Verify now": the domain after the check and whether the record with its token was found. */
export interface DomainCheck extends Domain {
  recordFound: boolean;
}

export interface Limits {
  maxUsers: number;
  maxManagementSystems: number;
  frameworks: string[];
  storageAdapters: StorageAdapterName[];
  features: FeatureName[];
  rateUserPerMinute: number | null;
  rateOrgPerMinute: number | null;
  graceDays: number;
}

/** `ops.entitlements.get` (M2-S10): the row with its current use. */
export interface Entitlement extends Limits {
  plan: string | null;
  source: EntitlementSource;
  validFrom: string;
  /** Null (or `NO_END`) for no end date. */
  validUntil: string | null;
  version: number;
  updatedAt: string;
  usage: { users: number; managementSystems: number };
}

/** A preset of `license.plans` (`ops.plans.list`). */
export interface PlanPreset extends Limits {
  name: string;
  validDays: number;
}

/** The body of `ops.entitlements.set`: a preset, or explicit limits. */
export type EntitlementInput =
  | { preset: string; validFrom?: string }
  | (Limits & { plan: string | null; validFrom: string; validUntil: string | null });

/** The entitlement of an organisation and the `If-Match` value of its next change (`*` when it has none yet). */
export interface EntitlementRead {
  entitlement: Entitlement | null;
  etag: string;
}

export interface EntitlementSaved {
  entitlement: Entitlement;
  etag: string;
  /** The warnings of the answer: a limit below the current use (LIC-USERS, LIC-MS). */
  warnings: TextPair[];
}

// ---------------------------------------------------------------------------------------------------------------
// Status (J.8)
// ---------------------------------------------------------------------------------------------------------------

/** The moves of the machine `organization.status` (J.8); the unit test compares them with @mscd/shared. */
export const STATUS_MOVES: Readonly<Record<OrgStatus, readonly OrgStatus[]>> = {
  active: ['suspended', 'offboarding'],
  suspended: ['active', 'offboarding'],
  offboarding: ['active', 'archived'],
  archived: [],
};

/** `offboarding` and `archived` need the slug typed again (`confirmSlug`). */
export const needsSlug = (to: OrgStatus): boolean => to === 'offboarding' || to === 'archived';

export const STATUS_LABEL: Readonly<Record<OrgStatus, TextPair>> = {
  active: ORG_TEXT.statusActive, suspended: ORG_TEXT.statusSuspended, offboarding: ORG_TEXT.statusOffboarding, archived: ORG_TEXT.statusArchived,
};
export const STATUS_TONE: Readonly<Record<OrgStatus, Tone>> = { active: 'ok', suspended: 'bad', offboarding: 'warn', archived: 'mute' };
/** One plain sentence on what the members can do in each status. */
export const STATUS_MEANING: Readonly<Record<OrgStatus, TextPair>> = {
  active: ORG_TEXT.meaningActive, suspended: ORG_TEXT.meaningSuspended, offboarding: ORG_TEXT.meaningOffboarding, archived: ORG_TEXT.meaningArchived,
};
/** The action that moves an organisation to a status. */
export const MOVE_LABEL: Readonly<Record<OrgStatus, TextPair>> = {
  active: ORG_TEXT.moveReactivate, suspended: ORG_TEXT.moveSuspend, offboarding: ORG_TEXT.moveOffboard, archived: ORG_TEXT.moveArchive,
};
export const MOVE_TONE: Readonly<Record<OrgStatus, 'primary' | 'danger' | 'default'>> = { active: 'primary', suspended: 'danger', offboarding: 'default', archived: 'danger' };

const EFFECTS: Readonly<Record<OrgStatus, readonly TextPair[]>> = {
  suspended: [ORG_TEXT.effectSuspended1, ORG_TEXT.effectSuspended2, ORG_TEXT.effectSuspended3, ORG_TEXT.effectSuspended4],
  active: [ORG_TEXT.effectActive1, ORG_TEXT.effectActive2],
  offboarding: [ORG_TEXT.effectOffboarding1, ORG_TEXT.effectOffboarding2, ORG_TEXT.effectOffboarding3, ORG_TEXT.effectOffboarding4],
  archived: [ORG_TEXT.effectArchived1, ORG_TEXT.effectArchived2, ORG_TEXT.effectArchived3, ORG_TEXT.effectArchived4],
};

/** What a move does, listed before the operator confirms it (texts may hold `{days}`). */
export function moveEffects(from: OrgStatus, to: OrgStatus): TextPair[] {
  const out = [...EFFECTS[to]];
  if (to === 'active' && from === 'offboarding') out.push(ORG_TEXT.effectRenewPlan);
  out.push(ORG_TEXT.effectEmail);
  return out;
}

export interface StatusForm {
  reason: string;
  confirm: string;
}

export const EMPTY_STATUS_FORM: StatusForm = { reason: '', confirm: '' };

/** Errors of the status form before it is sent: a reason of 3 characters or more, and the slug for the two final moves. */
export function statusErrors(slug: string, to: OrgStatus, form: StatusForm): Partial<Record<'reason' | 'confirmSlug', TextPair>> {
  const out: Partial<Record<'reason' | 'confirmSlug', TextPair>> = {};
  if (form.reason.trim().length < 3) out.reason = ORG_TEXT.reasonShort;
  if (needsSlug(to)) {
    const typed = form.confirm.trim();
    if (!typed) out.confirmSlug = ORG_TEXT.slugMissing;
    else if (typed !== slug) out.confirmSlug = ORG_TEXT.slugMismatch;
  }
  return out;
}

/** The body of the move; `confirmSlug` is what the operator typed, which the server checks again (422 `confirmation_mismatch`). */
export function statusBody(to: OrgStatus, form: StatusForm): StatusChange {
  return { status: to, reason: form.reason.trim(), ...(needsSlug(to) ? { confirmSlug: form.confirm.trim() } : {}) };
}

/** The start of the current offboarding: the newest move to `offboarding` of the history (newest first), or null. */
export function offboardingStart(status: OrgStatus, events: readonly StatusEvent[]): string | null {
  if (status !== 'offboarding') return null;
  return events.find((e) => e.to === 'offboarding')?.at ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The local date of a Date as `YYYY-MM-DD`. */
export function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Today: the controller's date (the sample's day, the organisation's local date), else the browser's. */
export function todayOf(ctx: Pick<HostContext, 'D'>): string {
  const day = (ctx.D as { TODAY_S?: unknown } | null)?.TODAY_S;
  return typeof day === 'string' && ISO_DAY.test(day) ? day : localIso(new Date());
}

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 864e5;
};

/** Whole days from `from` to `to` (both `YYYY-MM-DD`; negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round(dayNumber(to) - dayNumber(from));
}

/** The day `n` days after `iso`. */
export function addDays(iso: string, n: number): string {
  const d = new Date((dayNumber(iso) + n) * 864e5);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** True for a date that stands for "no end date" (null with a plan, or `9999-12-31`). */
export const isOpenEnded = (iso: string | null | undefined): boolean => !iso || iso.slice(0, 10) === NO_END;

/** Days left until the last day of a plan, as text with a tone: past is bad, 30 days or fewer warn. */
export function daysLeftOf(validUntil: string, today: string): { text: TextPair; n: number; tone: Tone } {
  const n = daysBetween(today, validUntil);
  if (n > 1) return { text: ORG_TEXT.daysLeft, n, tone: n <= 30 ? 'warn' : 'mute' };
  if (n === 1) return { text: ORG_TEXT.dayLeft, n, tone: 'warn' };
  if (n === 0) return { text: ORG_TEXT.endsToday, n, tone: 'warn' };
  if (n === -1) return { text: ORG_TEXT.endedYesterday, n: 1, tone: 'bad' };
  return { text: ORG_TEXT.endedDaysAgo, n: -n, tone: 'bad' };
}

/** A date in the interface language (`-` when empty). */
export function dayText(ctx: Pick<HostContext, 'D' | 'lang'>, iso: string | null | undefined): string {
  if (!iso) return '-';
  const day = iso.slice(0, 10);
  return ctx.D ? ctx.D.fmt(day, ctx.lang) : day;
}

/** Date and local time of an instant in the interface language. */
export function whenText(ctx: Pick<HostContext, 'D' | 'lang'>, instant: string | null | undefined): string {
  if (!instant) return '-';
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return instant;
  return `${dayText(ctx, localIso(d))}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------------------------------------------

/**
 * The ETag of an entitlement as the server sends it with the read (`W/"<version>-<updated at in epoch ms>"`, M2-S10
 * `entitlementEtag`). The host's client answers the body only, so the screen builds the `If-Match` value from the
 * body's version and time (handoff deviation 2); the API spec checks it with the server's own `ifMatchOf`.
 */
export function entitlementEtag(e: Pick<Entitlement, 'version' | 'updatedAt'>): string {
  return `W/"${e.version}-${Date.parse(e.updatedAt)}"`;
}

export const SOURCE_TEXT: Readonly<Record<EntitlementSource, TextPair>> = {
  preset: ORG_TEXT.sourcePreset, manual: ORG_TEXT.sourceManual, signed_licence: ORG_TEXT.sourceSignedLicence,
};
export const ADAPTER_TEXT: Readonly<Record<StorageAdapterName, TextPair>> = {
  managed_vault: ORG_TEXT.adapterManagedVault, m365: ORG_TEXT.adapterM365, google_drive: ORG_TEXT.adapterGoogleDrive,
  smb: ORG_TEXT.adapterSmb, s3: ORG_TEXT.adapterS3, webdav: ORG_TEXT.adapterWebdav,
};
export const FEATURE_TEXT: Readonly<Record<FeatureName, TextPair>> = {
  integrated_mode: ORG_TEXT.featureIntegrated, edition_transition: ORG_TEXT.featureTransition,
  link_health_monitor: ORG_TEXT.featureLinkHealth, auditor_guest_access: ORG_TEXT.featureGuest,
};

export interface EntitlementForm {
  /** A preset name, or '' for custom limits. */
  preset: string;
  validFrom: string;
  plan: string;
  maxUsers: string;
  maxSystems: string;
  graceDays: string;
  rateUser: string;
  rateOrg: string;
  frameworks: string[];
  storageAdapters: string[];
  features: string[];
  validUntil: string;
  noEnd: boolean;
}

/**
 * The form of an entitlement: its current values as custom limits, or for an organisation without one the first
 * preset (the smallest of `license.plans` when the profile keeps its D-S4 order) starting today.
 */
export function entitlementForm(e: Entitlement | null, today: string, presets: readonly PlanPreset[] = []): EntitlementForm {
  if (!e) {
    return {
      preset: presets[0]?.name ?? '', validFrom: today, plan: '', maxUsers: '', maxSystems: '', graceDays: '30', rateUser: '', rateOrg: '',
      frameworks: [], storageAdapters: [...OFFERED_ADAPTERS], features: [...FEATURE_NAMES], validUntil: '', noEnd: false,
    };
  }
  return {
    preset: '',
    validFrom: e.validFrom,
    plan: e.plan ?? '',
    maxUsers: String(e.maxUsers),
    maxSystems: String(e.maxManagementSystems),
    graceDays: String(e.graceDays),
    rateUser: e.rateUserPerMinute === null ? '' : String(e.rateUserPerMinute),
    rateOrg: e.rateOrgPerMinute === null ? '' : String(e.rateOrgPerMinute),
    frameworks: [...e.frameworks],
    storageAdapters: [...e.storageAdapters],
    features: [...e.features],
    validUntil: isOpenEnded(e.validUntil) ? '' : (e.validUntil ?? ''),
    noEnd: isOpenEnded(e.validUntil),
  };
}

const WHOLE = /^\d+$/;

/** Field errors of the entitlement form, keyed by the body's paths. */
export function entitlementErrors(form: EntitlementForm): Record<string, TextPair> {
  const out: Record<string, TextPair> = {};
  if (!ISO_DAY.test(form.validFrom)) out.validFrom = ORG_TEXT.dateRequired;
  if (form.preset) return out;
  if (!WHOLE.test(form.maxUsers.trim())) out.maxUsers = ORG_TEXT.wholeNumber;
  if (!WHOLE.test(form.maxSystems.trim())) out.maxManagementSystems = ORG_TEXT.wholeNumber;
  if (!WHOLE.test(form.graceDays.trim()) || Number(form.graceDays) > 365) out.graceDays = ORG_TEXT.graceNumber;
  for (const [key, value] of [['rateUserPerMinute', form.rateUser], ['rateOrgPerMinute', form.rateOrg]] as const) {
    if (value.trim() && (!WHOLE.test(value.trim()) || Number(value) < 1)) out[key] = ORG_TEXT.rateNumber;
  }
  if (!form.noEnd) {
    if (!ISO_DAY.test(form.validUntil)) out.validUntil = ORG_TEXT.dateRequired;
    else if (ISO_DAY.test(form.validFrom) && form.validUntil < form.validFrom) out.validUntil = ORG_TEXT.untilBeforeFrom;
  }
  return out;
}

/** The body of `ops.entitlements.set` from a checked form. */
export function entitlementBody(form: EntitlementForm): EntitlementInput {
  if (form.preset) return { preset: form.preset, validFrom: form.validFrom };
  const rate = (v: string) => (v.trim() ? Number(v.trim()) : null);
  return {
    plan: form.plan.trim() || null,
    maxUsers: Number(form.maxUsers.trim()),
    maxManagementSystems: Number(form.maxSystems.trim()),
    frameworks: [...form.frameworks],
    storageAdapters: form.storageAdapters.filter((a): a is StorageAdapterName => (STORAGE_ADAPTER_NAMES as readonly string[]).includes(a)),
    features: form.features.filter((f): f is FeatureName => (FEATURE_NAMES as readonly string[]).includes(f)),
    rateUserPerMinute: rate(form.rateUser),
    rateOrgPerMinute: rate(form.rateOrg),
    graceDays: Number(form.graceDays.trim()),
    validFrom: form.validFrom,
    validUntil: form.noEnd ? null : form.validUntil,
  };
}

/**
 * The change of the plan picker. A preset picked in place of custom limits starts today, so a renewal (for example after
 * a reactivation) does not take the first day of the plan that ends; back to custom limits, the first day is the row's
 * again (`rowFrom`); a move from one preset to another keeps the day the operator sees.
 */
export function planPicked(form: Pick<EntitlementForm, 'preset'>, preset: string, today: string, rowFrom: string): Partial<EntitlementForm> {
  if (preset && !form.preset) return { preset, validFrom: today };
  if (!preset && form.preset) return { preset, validFrom: rowFrom };
  return { preset };
}

/** The last day of a preset that starts on `validFrom` (the server: valid from plus the preset's days, less one). */
export function presetUntil(preset: Pick<PlanPreset, 'validDays'>, validFrom: string): string {
  return addDays(validFrom, preset.validDays - 1);
}

/** The values of a list toggled on or off. */
export function toggled(list: readonly string[], value: string, on: boolean): string[] {
  return on ? (list.includes(value) ? [...list] : [...list, value]) : list.filter((v) => v !== value);
}

// ---------------------------------------------------------------------------------------------------------------
// Domains and refusals
// ---------------------------------------------------------------------------------------------------------------

export const DOMAIN_LABEL: Readonly<Record<DomainStatus, TextPair>> = { pending: ORG_TEXT.domainPending, verified: ORG_TEXT.domainVerified, failed: ORG_TEXT.domainFailed };
export const DOMAIN_TONE: Readonly<Record<DomainStatus, Tone>> = { pending: 'info', verified: 'ok', failed: 'bad' };

/** A typed domain worth sending: 4 to 253 characters with a dot. The server normalises and checks it. */
export function domainInputError(value: string): TextPair | null {
  const v = value.trim();
  return v.length >= 4 && v.length <= 253 && v.includes('.') && !/\s/.test(v) ? null : ORG_TEXT.domainInvalid;
}

/** The result of "Verify now" for the domain's status before the check. */
export function checkOutcome(before: DomainStatus, check: DomainCheck): { tone: Tone; text: TextPair } {
  if (check.recordFound) return { tone: 'ok', text: before === 'verified' ? ORG_TEXT.foundAgain : ORG_TEXT.foundNow };
  if (check.status === 'verified') return { tone: 'warn', text: ORG_TEXT.recordGone };
  if (check.status === 'failed') return { tone: 'bad', text: ORG_TEXT.notFoundFailed };
  return { tone: 'info', text: ORG_TEXT.notFoundPending };
}

/** Refusals whose server answer carries no text of its own (no `messages`): the console's text for the message key. */
const LOCAL_REFUSALS: Readonly<Record<string, TextPair>> = {
  organization_archived: ORG_TEXT.refusedArchived,
  domain_changed: ORG_TEXT.refusedChanged,
};

/**
 * The text of a refusal: the server's `messages` (409 `domain_taken`, `invalid_status_transition`, 422
 * `confirmation_mismatch`, `domain_not_allowed` and the others carry both languages), the console's text where the
 * answer has none (412, 503 of a DNS check, `organization_archived`), else the problem title.
 */
export function refusalText(error: ApiError, options: { dns?: boolean } = {}): TextPair {
  if (error.status === 412) return ORG_TEXT.conflict;
  if (options.dns && error.status === 503) return ORG_TEXT.dnsUnavailable;
  const local = error.messageKey ? LOCAL_REFUSALS[error.messageKey] : undefined;
  if (local && error.message[0] === error.message[1]) return local;
  return error.message;
}

/** Runs `fn` over `items` with at most `limit` at a time, keeping the order of the results. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
