// Sample adapter of the Licence screen: the sample organisation's licence card (`LICENCE` of the sample snapshot,
// G.5) in the screen's model. Installing checks that the text is a licence document and keeps it for this session.
import type { ControllerData } from '../../data/types';
import type { LicenceAdapter, LicenceModel } from './model';
import { FRAMEWORK_NAMES } from './model';

const MONTHS: Readonly<Record<string, string>> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

/** `31 Mar 2027` as `2027-03-31`; null for any other text. */
export function isoOfDay(text: string | null | undefined): string | null {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(String(text ?? '').trim());
  if (!m || !MONTHS[m[2]]) return null;
  return `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`;
}

/** `86 of 150` as `{used: 86, limit: 150}`; null for any other text. */
export function usageOf(text: string | null | undefined): { used: number; limit: number } | null {
  const m = /^(\d+) of (\d+)$/.exec(String(text ?? '').trim());
  return m ? { used: Number(m[1]), limit: Number(m[2]) } : null;
}

const CODE_OF_NAME: Readonly<Record<string, string>> = {
  'Managed Vault': 'managed_vault', 'Microsoft 365': 'm365', 'Google Workspace': 'google_drive', 'Google Drive': 'google_drive', SMB: 'smb',
};

/** The model of the sample snapshot's licence card; null when the snapshot has none. */
export function fromSample(D: ControllerData | null): LicenceModel | null {
  const card = D?.LICENCE;
  if (!card) return null;
  const until = isoOfDay(card.to);
  const today = D?.TODAY_S ?? null;
  const frameworks = Object.keys(FRAMEWORK_NAMES).filter((code) => (D?.MS ?? []).some((m) => m.code.replace(/[^0-9]/g, '') === code.replace(/[^0-9]/g, '')));
  return {
    licenseId: 'LIC-SAMPLE',
    organization: card.org,
    state: until && today && until < today ? 'grace' : 'valid',
    validFrom: null,
    validUntil: until,
    graceDays: 30,
    binding: 'organization',
    users: usageOf(card.users),
    systems: usageOf(card.ms),
    frameworks: frameworks.length ? frameworks : Object.keys(FRAMEWORK_NAMES),
    storageAdapters: card.adapters.split(',').map((s) => CODE_OF_NAME[s.trim()] ?? s.trim()).filter(Boolean),
    features: card.features.map((f) => (Array.isArray(f) ? [f[0], f[1]] as const : String(f))),
    signature: { alg: 'Ed25519', keyId: 'sample', verified: true },
    clockRollback: false,
    sample: true,
  };
}

/** The model of a licence document (`license_id`, `valid_until` and the other members of D-15). */
function fromDocument(doc: Record<string, unknown>, before: LicenceModel | null): LicenceModel {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    licenseId: String(doc.license_id),
    organization: str(doc.organization) ?? before?.organization ?? '',
    state: 'valid',
    validFrom: str(doc.valid_from),
    validUntil: str(doc.valid_until),
    graceDays: typeof doc.grace_days === 'number' ? doc.grace_days : null,
    binding: doc.organization_id ? 'organization' : doc.installation_id ? 'installation' : doc.trial ? 'trial' : null,
    users: typeof doc.max_users === 'number' ? { used: before?.users?.used ?? 0, limit: doc.max_users } : before?.users ?? null,
    systems: typeof doc.max_management_systems === 'number' ? { used: before?.systems?.used ?? 0, limit: doc.max_management_systems } : before?.systems ?? null,
    frameworks: list(doc.frameworks),
    storageAdapters: list(doc.storage_adapters),
    features: list(doc.features),
    signature: { alg: 'Ed25519', keyId: str(doc.key_id) ?? '-', verified: true },
    clockRollback: false,
    sample: true,
  };
}

// A licence installed in the sample build stays for the session (until the page is loaded again).
let installed: LicenceModel | null = null;

/** Forgets a licence installed in the sample build (unit tests). */
export function resetSampleLicence(): void {
  installed = null;
}

export function createSampleAdapter(getD: () => ControllerData | null): LicenceAdapter {
  return {
    async load() {
      return { ok: true, licence: installed ?? fromSample(getD()) };
    },
    async install(document) {
      const doc = document && typeof document === 'object' && !Array.isArray(document) ? (document as Record<string, unknown>) : null;
      if (!doc || typeof doc.license_id !== 'string' || typeof doc.signature !== 'string') {
        return { ok: false, error: { status: 400, message: ['This document is not a signed licence.', 'Dokumen ini bukan lisensi bertanda tangan.'], errors: [{ path: 'body', message: 'license_id and signature are required' }] } };
      }
      installed = fromDocument(doc, installed ?? fromSample(getD()));
      return { ok: true, licence: installed };
    },
  };
}
