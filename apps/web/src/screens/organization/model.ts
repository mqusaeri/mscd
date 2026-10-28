// The view model of the Organisation screen (MILESTONE-2 M2-16) and the interface both adapters implement (api.ts in
// API builds, sample.ts in the sample build), with the form checks and the list of IANA time zones.
import type { ApiError } from '../../data/api/ApiClient';
import type { TextPair } from '../types';
import { TEXT } from './text';

export type LocalLogin = 'allowed' | 'admins_only' | 'disabled';

export interface OrgSettings {
  slug: string;
  name: string;
  timeZone: string;
  siteCount: number;
  localLogin: LocalLogin;
  installationId: string;
  tenancyMode: 'single' | 'multi';
  activeAdminCount: number;
  /** ETag of the organisation row, sent back as `If-Match`. */
  etag: string;
}

export interface OrgPatch {
  name?: string;
  timeZone?: string;
  siteCount?: number;
}

export type Loaded = { ok: true; settings: OrgSettings } | { ok: false; error: ApiError };

export interface OrgAdapter {
  load(): Promise<Loaded>;
  /** `PATCH /admin/organization` with `If-Match`, then the settings as they are now. 412 when another change came first. */
  save(patch: OrgPatch, etag: string): Promise<Loaded>;
}

export const LOCAL_LOGIN_TEXT: Readonly<Record<LocalLogin, TextPair>> = {
  allowed: TEXT.localAllowed,
  admins_only: TEXT.localAdminsOnly,
  disabled: TEXT.localDisabled,
};

/** Time zones offered when the browser cannot list them (`Intl.supportedValuesOf`). */
const FALLBACK_ZONES = [
  'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Bangkok', 'Asia/Manila',
  'Asia/Tokyo', 'Australia/Sydney', 'Europe/London', 'Europe/Amsterdam', 'America/New_York', 'UTC',
];

/** The IANA time zones of the browser, with `UTC` and the current value, sorted. */
export function timeZones(current?: string | null): string[] {
  let zones: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    zones = typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    zones = [];
  }
  if (!zones.length) zones = FALLBACK_ZONES;
  const all = new Set([...zones, 'UTC', ...(current ? [current] : [])]);
  return [...all].sort((a, b) => a.localeCompare(b));
}

export interface OrgForm {
  name: string;
  timeZone: string;
  siteCount: string;
}

export const formOf = (s: OrgSettings): OrgForm => ({ name: s.name, timeZone: s.timeZone, siteCount: String(s.siteCount) });

/** Field errors of the form (before anything is sent). */
export function formErrors(form: OrgForm): Partial<Record<keyof OrgForm, TextPair>> {
  const out: Partial<Record<keyof OrgForm, TextPair>> = {};
  const name = form.name.trim();
  if (!name) out.name = TEXT.nameRequired;
  else if (name.length > 200) out.name = TEXT.nameTooLong;
  if (!/^\d+$/.test(form.siteCount.trim()) || Number(form.siteCount) > 10_000) out.siteCount = TEXT.sitesInvalid;
  return out;
}

/** The fields that changed against the loaded settings; empty when nothing changed. */
export function patchOf(form: OrgForm, settings: OrgSettings): OrgPatch {
  const patch: OrgPatch = {};
  const name = form.name.trim();
  if (name !== settings.name) patch.name = name;
  if (form.timeZone !== settings.timeZone) patch.timeZone = form.timeZone;
  const sites = Number(form.siteCount.trim());
  if (sites !== settings.siteCount) patch.siteCount = sites;
  return patch;
}

/**
 * Whether the snapshot must be read again after a save: the sidebar shows the organisation's name and, under it, its
 * number of sites (`org.sites` of the snapshot).
 */
export const changesSnapshot = (before: OrgSettings, after: OrgSettings): boolean =>
  before.name !== after.name || before.siteCount !== after.siteCount;
