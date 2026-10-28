// The view model of the Licence screen and the interface both adapters implement (api.ts in API builds, sample.ts in
// the sample build), chosen by the build in Screen.tsx (adapterFor, MILESTONE-2 C.6).
import type { ApiError } from '../../data/api/ApiClient';

export type LicenceState = 'valid' | 'grace' | 'read_only';

export interface LicenceModel {
  licenseId: string;
  organization: string;
  state: LicenceState;
  validFrom: string | null;
  validUntil: string | null;
  graceDays: number | null;
  binding: 'organization' | 'installation' | 'trial' | null;
  users: { used: number; limit: number } | null;
  systems: { used: number; limit: number } | null;
  frameworks: string[];
  storageAdapters: string[];
  /** Feature codes, or labels already given as [English, Indonesian]. */
  features: (string | readonly [string, string])[];
  signature: { alg: string; keyId: string; verified: boolean } | null;
  clockRollback: boolean;
  /**
   * Multi tenancy only (M2-S10): where the effective licence comes from, the entitlement row's source; a plan preset
   * or limits the operator set carry no signature. Absent (null) in single tenancy.
   */
  source?: 'preset' | 'manual' | 'signed_licence' | null;
  /** Multi tenancy only: the plan preset of the entitlement row. */
  plan?: string | null;
  sample?: boolean;
}

/** The installation id for licence requests and the tenancy mode, from `GET /admin/organization` (M2-16). */
export interface InstallationInfo {
  installationId: string;
  tenancyMode: 'single' | 'multi';
}

export type Loaded = { ok: true; licence: LicenceModel | null } | { ok: false; error: ApiError };
export type Installed = { ok: true; licence: LicenceModel } | { ok: false; error: ApiError };

export interface LicenceAdapter {
  /** The licence of the organisation; `licence: null` when none is installed (404). */
  load(): Promise<Loaded>;
  /** Installs a parsed licence document (`PUT /admin/license`). */
  install(document: unknown): Promise<Installed>;
  /** The installation id panel's data; null when it cannot be read (the session lacks `org.settings.manage`). */
  installation(): Promise<InstallationInfo | null>;
}

/** `valid_until` of an entitlement without an end date (M2-S10 `NO_END_DATE`). */
export const NO_END_DATE = '9999-12-31';

/** True when the licence is the entitlement of a multi tenancy service (it names its source). */
export function isMultiTenancy(licence: LicenceModel): boolean {
  return Boolean(licence.source);
}

/** True when the licence carries a signature to show: not for a plan preset or limits set by the operator. */
export function hasSignature(licence: LicenceModel): boolean {
  return Boolean(licence.signature) && licence.source !== 'preset' && licence.source !== 'manual';
}

/** Display names of the framework codes of a licence. */
export const FRAMEWORK_NAMES: Readonly<Record<string, string>> = {
  ISO27001: 'ISO/IEC 27001',
  ISO9001: 'ISO 9001',
  ISO22301: 'ISO 22301',
  ISO37001: 'ISO 37001',
};

/** Display names of the storage adapter codes (D-28). */
export const ADAPTER_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  managed_vault: ['Managed Vault', 'Managed Vault'],
  m365: ['Microsoft 365', 'Microsoft 365'],
  google_drive: ['Google Drive', 'Google Drive'],
  smb: ['File share (SMB)', 'Berbagi berkas (SMB)'],
  s3: ['S3 object storage', 'Penyimpanan objek S3'],
  webdav: ['WebDAV', 'WebDAV'],
};

/** Labels of the licence feature codes (D-15). */
export const FEATURE_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  integrated_mode: ['Integrated Management System', 'Sistem Manajemen Terintegrasi'],
  edition_transition: ['Edition Transition Assistant', 'Asisten Transisi Edisi'],
  link_health_monitor: ['Link Health Monitor', 'Pemantau Kesehatan Tautan'],
  auditor_guest_access: ['Auditor guest access', 'Akses tamu auditor'],
};

/** True when the licence end date lies before `today` (both YYYY-MM-DD). */
export function isExpired(licence: LicenceModel, today: string | null | undefined): boolean {
  return Boolean(licence.validUntil && licence.validUntil !== NO_END_DATE && today && licence.validUntil < today);
}
