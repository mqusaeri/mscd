// Labels of the storage values (MILESTONE-2 M2-09) in English and Indonesian, shared by the repository administration
// (storage-admin) and the routing rules screen. The codes are the enum values of the api (BP C.13, D.2): adapters,
// storage modes, ownership, connection states, classifications, object kinds, link states and hash algorithms.
import type { TextPair } from '../types';

export type AdapterCode = 'managed_vault' | 'm365' | 'google_drive' | 'smb' | 's3' | 'webdav';
export type ModeCode = 'stored' | 'pass_through' | 'link' | 'zero_transit';
export type OwnershipCode = 'organizational' | 'personal';
export type ConnectionCode = 'ok' | 'degraded' | 'failed' | 'revoked';
export type ClassificationCode = 'public' | 'internal' | 'confidential' | 'restricted';
export type ObjectKindCode = 'document' | 'evidence';
export type LinkStatusCode = 'intact' | 'moved' | 'version_changed' | 'verification_pending' | 'hash_mismatch' | 'pinned_version_lost' | 'missing' | 'access_denied';

/** The adapters the connect wizard offers (D-28; SMB, S3 and WebDAV are deferred, plan B). */
export const WIZARD_ADAPTERS = ['managed_vault', 'm365', 'google_drive'] as const satisfies readonly AdapterCode[];
export type WizardAdapter = (typeof WIZARD_ADAPTERS)[number];

export const ADAPTER_LABELS: Readonly<Record<AdapterCode, TextPair>> = {
  managed_vault: ['Managed Vault', 'Managed Vault'],
  m365: ['Microsoft 365 (SharePoint or OneDrive)', 'Microsoft 365 (SharePoint atau OneDrive)'],
  google_drive: ['Google Drive (shared drive or My Drive)', 'Google Drive (shared drive atau My Drive)'],
  smb: ['File share (SMB)', 'Berbagi berkas (SMB)'],
  s3: ['S3 object storage', 'Penyimpanan objek S3'],
  webdav: ['WebDAV', 'WebDAV'],
};

/** Short adapter names for tables. */
export const ADAPTER_SHORT: Readonly<Record<AdapterCode, TextPair>> = {
  managed_vault: ['Managed Vault', 'Managed Vault'],
  m365: ['Microsoft 365', 'Microsoft 365'],
  google_drive: ['Google Drive', 'Google Drive'],
  smb: ['File share', 'Berbagi berkas'],
  s3: ['S3', 'S3'],
  webdav: ['WebDAV', 'WebDAV'],
};

export const ADAPTER_HELP: Readonly<Record<WizardAdapter, TextPair>> = {
  managed_vault: [
    'Encrypted object storage run with MSCD. Files are uploaded, versioned and hashed with SHA-256.',
    'Penyimpanan objek terenkripsi yang dijalankan bersama MSCD. Berkas diunggah, diberi versi dan di-hash dengan SHA-256.',
  ],
  m365: [
    'A SharePoint document library or a OneDrive of your Microsoft 365 tenant, reached by an app registration with a certificate.',
    'Library dokumen SharePoint atau OneDrive di tenant Microsoft 365 Anda, dijangkau melalui registrasi aplikasi dengan sertifikat.',
  ],
  google_drive: [
    'A Google shared drive, or a folder in the My Drive of one account, reached by a service account or a delegated consent.',
    'Shared drive Google, atau folder di My Drive milik satu akun, dijangkau melalui service account atau persetujuan delegasi.',
  ],
};

/** Mode names are product terms and stay the same in Indonesian, as on the Storage repositories screen. */
export const MODE_LABELS: Readonly<Record<ModeCode, TextPair>> = {
  stored: ['Upload', 'Upload'],
  link: ['Link', 'Link'],
  pass_through: ['Pass-through', 'Pass-through'],
  zero_transit: ['Zero-transit', 'Zero-transit'],
};

export const MODE_HELP: Readonly<Record<ModeCode, TextPair>> = {
  stored: ['Files are uploaded into the vault, versioned and hashed with SHA-256.', 'Berkas diunggah ke vault, diberi versi dan di-hash dengan SHA-256.'],
  link: ['Files stay in the repository; MSCD keeps a link to the pinned version and its hash.', 'Berkas tetap di repositori; MSCD menyimpan tautan ke versi yang dipatok beserta hash-nya.'],
  pass_through: ['Files uploaded in MSCD pass through the storage gateway into the repository.', 'Berkas yang diunggah di MSCD diteruskan melalui storage gateway ke repositori.'],
  zero_transit: ['Uploads go straight to the repository without passing through MSCD; MSCD records the link and hash.', 'Unggahan langsung masuk ke repositori tanpa melalui MSCD; MSCD mencatat tautan dan hash-nya.'],
};

/** Modes a provider repository may offer (the vault has the single mode `stored`). */
export const PROVIDER_MODES = ['link', 'pass_through', 'zero_transit'] as const satisfies readonly ModeCode[];

export const OWNERSHIP_LABELS: Readonly<Record<OwnershipCode, TextPair>> = {
  organizational: ['Organisation', 'Organisasi'],
  personal: ['Personal (one account)', 'Pribadi (satu akun)'],
};

export const CONNECTION_LABELS: Readonly<Record<ConnectionCode, TextPair>> = {
  ok: ['Connected', 'Terhubung'],
  degraded: ['Degraded', 'Terganggu'],
  failed: ['Not connected', 'Tidak terhubung'],
  revoked: ['Access revoked', 'Akses dicabut'],
};

export const CONNECTION_TONE: Readonly<Record<ConnectionCode, 'ok' | 'warn' | 'bad'>> = { ok: 'ok', degraded: 'warn', failed: 'bad', revoked: 'bad' };

export const CLASSIFICATION_LABELS: Readonly<Record<ClassificationCode, TextPair>> = {
  public: ['Public', 'Publik'],
  internal: ['Internal', 'Internal'],
  confidential: ['Confidential', 'Rahasia'],
  restricted: ['Restricted', 'Terbatas'],
};

export const OBJECT_KIND_LABELS: Readonly<Record<ObjectKindCode, TextPair>> = {
  document: ['Documents', 'Dokumen'],
  evidence: ['Evidence', 'Bukti'],
};

export const LINK_STATUS_LABELS: Readonly<Record<LinkStatusCode, TextPair>> = {
  intact: ['Unchanged', 'Tidak berubah'],
  moved: ['Moved', 'Dipindahkan'],
  version_changed: ['Version changed', 'Versi berubah'],
  verification_pending: ['Check pending', 'Pemeriksaan tertunda'],
  hash_mismatch: ['Hash does not match', 'Hash tidak cocok'],
  pinned_version_lost: ['Pinned version lost', 'Versi yang dipatok hilang'],
  missing: ['Missing', 'Hilang'],
  access_denied: ['Access denied', 'Akses ditolak'],
};

export const LINK_STATUS_TONE: Readonly<Record<LinkStatusCode, 'ok' | 'warn' | 'bad' | 'info'>> = {
  intact: 'ok',
  moved: 'warn',
  version_changed: 'warn',
  verification_pending: 'info',
  hash_mismatch: 'bad',
  pinned_version_lost: 'bad',
  missing: 'bad',
  access_denied: 'bad',
};

/** The label of a code from a table, or the code itself. */
export function labelOf<K extends string>(table: Readonly<Partial<Record<K, TextPair>>>, code: string | null | undefined): TextPair {
  if (!code) return ['-', '-'];
  return (table as Record<string, TextPair | undefined>)[code] ?? [code, code];
}
