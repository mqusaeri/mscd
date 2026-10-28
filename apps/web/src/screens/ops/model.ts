// The model of the operator console (MILESTONE-2 M2-16) and the interface both adapters implement (api.ts in API
// builds, sample.ts in the sample build). M2-S12 extends the organisations with status, plan, domains and entitlements.
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext, TextPair } from '../types';
import { TEXT } from './text';

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type ComponentStatus = 'ok' | 'degraded' | 'down';
export type LicenceState = 'valid' | 'grace' | 'read_only';

export interface QueueStat {
  name: string;
  waiting: number;
  active: number;
  failed: number;
  oldestAgeSeconds: number;
}

export interface Health {
  components: { name: string; status: ComponentStatus; detail: string }[];
  migrations: { schema: string; latest: string | null; expected: string | null }[];
  queues: QueueStat[];
  licences: { org: string; state: LicenceState; validUntil: string }[];
}

export interface OrgItem {
  slug: string;
  name: string;
  status: string;
  licence: { state: LicenceState; validUntil: string } | null;
  memberCount: number;
  systemCount: number;
  plan: string | null;
  createdAt: string;
}

export interface OrgPage {
  items: OrgItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface OrgCreate {
  slug: string;
  name: string;
  timeZone: string;
  siteCount: number;
  firstAdmin: { email: string; displayName: string };
}

export interface Created {
  slug: string;
  invitationSent: boolean;
  /** The one-time invitation link, only when mail is not required and the email did not go out (never on SaaS). */
  invitationUrl: string | null;
  message: TextPair | null;
}

export interface PackItem {
  packId: string;
  version: string;
  frameworkCode: string;
  edition: string;
  status: 'validating' | 'installed' | 'failed' | 'superseded';
  preRelease: boolean;
  installedAt: string | null;
}

export interface PackImported {
  packId: string;
  version: string;
  /** `queued` while the worker installs it, `unchanged` when that version is installed already. */
  status: 'queued' | 'unchanged';
  message: TextPair | null;
}

export interface OpsAdapter {
  health(): Promise<Result<Health>>;
  queues(): Promise<Result<QueueStat[]>>;
  runJob(name: string, org: string | null): Promise<Result<string>>;
  /** `POST /ops/diagnostics`: the archive and its file name. */
  diagnostics(): Promise<Result<{ blob: Blob; fileName: string }>>;
  organizations(query: { page: number; pageSize: number; q?: string }): Promise<Result<OrgPage>>;
  createOrganization(body: OrgCreate, idempotencyKey: string): Promise<Result<Created>>;
  /** `PUT /admin/license` with `{org, licence}` (multi tenancy). */
  installLicence(org: string, licence: unknown): Promise<Result<null>>;
  packs(): Promise<Result<PackItem[]>>;
  importPack(file: Blob, fileName: string, idempotencyKey: string): Promise<Result<PackImported>>;
  resetMfa(email: string, reason: string): Promise<Result<null>>;
}

/** The jobs `POST /ops/jobs/{name}/run` accepts (`OPS_RUNNABLE_JOBS` of @mscd/shared; the unit test compares them). */
export const OPS_JOBS = [
  'freshness.sweep', 'link-health.plan', 'link-health.repository', 'audit.verify-chain', 'cleanup.expired',
  'notifications.dispatch', 'packs.lifecycle', 'drift.evaluate', 'cycle.derive',
] as const;

/** Rows per page of the organisation list. */
export const ORG_PAGE_SIZE = 25;
/** The pack import polls the installed list this often, at most `PACK_POLLS` times. */
export const PACK_POLL_MS = 2000;
export const PACK_POLLS = 60;
/** Largest bundle the import takes (F.12: 50 MiB). */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
/** `valid_until` of an entitlement without an end date (M2-S10). */
export const NO_END_DATE = '9999-12-31';

const SLUG = /^[a-z][a-z0-9_]{1,39}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Multi tenancy: the platform operator installs licences and packs (`license.manage` and `pack.install` are platform
 * permissions there, F.6 tenancy rows D-17 and D-32). With one organisation they belong to its Tenant Admin.
 */
export function multiTenancy(ctx: HostContext): boolean {
  return ctx.platformCan('license.manage') || ctx.platformCan('pack.install');
}

/** A 409 `single_tenancy` of the organisation routes: the installation runs one organisation. */
export function isSingleTenancy(error: ApiError | null | undefined): boolean {
  return Boolean(error && error.status === 409 && error.messageKey === 'single_tenancy');
}

export const STATUS_TEXT: Readonly<Record<ComponentStatus, TextPair>> = { ok: TEXT.statusOk, degraded: TEXT.statusDegraded, down: TEXT.statusDown };
export const LICENCE_TEXT: Readonly<Record<LicenceState, TextPair>> = { valid: TEXT.stateValid, grace: TEXT.stateGrace, read_only: TEXT.stateReadOnly };
export const PACK_TEXT: Readonly<Record<PackItem['status'], TextPair>> = {
  installed: TEXT.packInstalled, validating: TEXT.packValidating, failed: TEXT.packFailed, superseded: TEXT.packSuperseded,
};

/** The age of the oldest waiting job: seconds, minutes or hours. */
export function ageText(seconds: number): { text: TextPair; n: number } {
  if (seconds < 120) return { text: TEXT.seconds, n: Math.round(seconds) };
  if (seconds < 7200) return { text: TEXT.minutes, n: Math.round(seconds / 60) };
  return { text: TEXT.hours, n: Math.round(seconds / 3600) };
}

export interface CreateForm {
  slug: string;
  name: string;
  timeZone: string;
  siteCount: string;
  email: string;
  displayName: string;
}

export const EMPTY_CREATE: CreateForm = { slug: '', name: '', timeZone: 'Asia/Jakarta', siteCount: '1', email: '', displayName: '' };

/** Field errors of the create form before it is sent; keys as the server's paths (`firstAdmin.email`). */
export function createErrors(form: CreateForm): Record<string, TextPair> {
  const out: Record<string, TextPair> = {};
  if (!SLUG.test(form.slug.trim())) out.slug = TEXT.slugInvalid;
  if (!form.name.trim()) out.name = TEXT.nameRequired;
  if (!/^\d+$/.test(form.siteCount.trim()) || Number(form.siteCount) > 10_000) out.siteCount = TEXT.sitesInvalid;
  if (!EMAIL.test(form.email.trim())) out['firstAdmin.email'] = TEXT.emailInvalid;
  if (!form.displayName.trim()) out['firstAdmin.displayName'] = TEXT.nameRequired;
  return out;
}

export function createBody(form: CreateForm): OrgCreate {
  return {
    slug: form.slug.trim(),
    name: form.name.trim(),
    timeZone: form.timeZone,
    siteCount: Number(form.siteCount.trim()),
    firstAdmin: { email: form.email.trim(), displayName: form.displayName.trim() },
  };
}

/** True for a slug the job form may send (empty means every organisation). */
export const validJobOrg = (org: string): boolean => !org.trim() || SLUG.test(org.trim());

/** The rows of a pack version in the installed list, newest first (the list holds every installation). */
export function packRows(list: readonly PackItem[], packId: string, version: string): PackItem[] {
  return list.filter((p) => p.packId === packId && p.version === version);
}

/** The newest row of a pack version in the installed list (the list holds every installation, newest first). */
export function packRow(list: readonly PackItem[], packId: string, version: string): PackItem | null {
  return packRows(list, packId, version)[0] ?? null;
}
