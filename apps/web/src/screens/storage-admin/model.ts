// The view model of the repository administration (MILESTONE-2 M2-09) and the interface both adapters implement
// (api.ts in API builds, sample.ts in the sample build, chosen by the build in adapter.ts). The form helpers turn the
// wizard and settings form into the bodies of `admin.storage.repositories.create`, `.update` and `.credentials`
// (`RepositoryCreate`, `RepositoryPatch` and `RepositoryCredential` of @mscd/shared, D.2) and check the id patterns
// of D.5 next to each field before anything is sent.
import type { RepositoryCreate, RepositoryCredential, RepositoryPatch } from '@mscd/shared';
import type { ApiError } from '../../data/api/ApiClient';
import { fieldErrors } from '../api';
import type { TextPair } from '../types';
import { PROVIDER_MODES, WIZARD_ADAPTERS } from './labels';
import type { AdapterCode, ConnectionCode, ModeCode, OwnershipCode, WizardAdapter } from './labels';
import { TEXT } from './text';

/** Microsoft Graph drive and item id pattern (D.5, `GRAPH_ID_RE` of @mscd/shared). */
export const GRAPH_ID = /^[A-Za-z0-9!_-]+$/;
/** Google Drive id pattern (D.5, `DRIVE_ID_RE` of @mscd/shared). */
export const DRIVE_ID = /^[A-Za-z0-9_-]+$/;
/** Repository and management system slug (`RepositorySlug`, `MsId`). */
export const SLUG = /^[a-z][a-z0-9-]{1,19}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The drive id stored for a My Drive: the Drive API alias of the account's own root (the adapter ignores it, WP-15). */
export const MY_DRIVE_ID = 'root';

export interface RepoRoot {
  folderId: string;
  path: string;
}

/** A repository as the administration shows it (`RepositoryView` of D.2, without the card texts). */
export interface RepoModel {
  /** Uuid the admin routes take. */
  ref: string;
  slug: string;
  name: string;
  adapter: AdapterCode;
  modes: ModeCode[];
  ownershipType: OwnershipCode;
  connectionStatus: ConnectionCode;
  message: TextPair | null;
  /** Site, library or drive summary (`RepositoryView.tenant`). */
  summary: string | TextPair;
  /** Codes of the systems that use it. */
  systems: string[];
  last: string;
  retentionConfirmed: boolean;
  metadataMinimization: boolean;
  readOnly: boolean;
  credentialSet: boolean;
  credentialExpiresAt: string | null;
  config: Record<string, unknown>;
  /** Card actions: `reauthorise` marks a delegated Google credential. */
  actions: string[];
}

/** A management system the per-system root folders are for. */
export interface SystemRef {
  slug: string;
  code: string;
}

export interface AdminData {
  repos: RepoModel[];
  /** The storage adapters of the licence; null when the licence could not be read (the server still checks it). */
  licensed: AdapterCode[] | null;
  systems: SystemRef[];
  /** Organisation id for the Managed Vault prefix (`tenants/<org id>/`). */
  orgId: string | null;
  sample?: boolean;
}

export type Result<T> = { ok: true; data: T; message?: TextPair } | { ok: false; error: ApiError };

/** `RepositoryTestResult` of D.2. */
export interface TestOutcome {
  status: ConnectionCode;
  permissions: string[];
  references: number;
  nextCheckAt: string | null;
  message: TextPair;
}

export interface StorageAdminAdapter {
  /** Repositories, the licensed adapters and the systems of the organisation. */
  load(): Promise<Result<AdminData>>;
  /** `POST /admin/storage/repositories` with an `Idempotency-Key`. */
  create(body: RepositoryCreate, idempotencyKey: string): Promise<Result<RepoModel>>;
  /** `PATCH /admin/storage/repositories/{id}`. */
  update(ref: string, body: RepositoryPatch): Promise<Result<RepoModel>>;
  /** `PUT /admin/storage/repositories/{id}/credentials` (204). */
  setCredential(ref: string, body: RepositoryCredential): Promise<Result<null>>;
  /** `POST /admin/storage/repositories/{id}/test`. */
  test(ref: string): Promise<Result<TestOutcome>>;
  /** `POST /admin/storage/repositories/{id}/reauthorize`: the consent page to open, or null when there is none. */
  consent(ref: string): Promise<Result<{ redirectUrl: string | null }>>;
}

// ---------------------------------------------------------------------------------------------------------------
// The settings form
// ---------------------------------------------------------------------------------------------------------------

export interface RepoForm {
  adapter: WizardAdapter;
  name: string;
  slug: string;
  ownershipType: OwnershipCode;
  modes: ModeCode[];
  retentionConfirmed: boolean;
  metadataMinimization: boolean;
  /** Microsoft 365: the directory (tenant) id, kept for the credential. */
  tenantId: string;
  siteId: string;
  /** Microsoft 365 library or Google shared drive id. */
  driveId: string;
  rootFolderId: string;
  /** Google Drive: a shared drive or the My Drive of one account (product decision 1). */
  driveKind: 'shared' | 'my';
  oauthClientId: string;
  /** Root folder per system slug; an empty pair means no folder for that system. */
  roots: Record<string, RepoRoot>;
}

export type FormErrors = Partial<Record<string, TextPair | string>>;

/** The adapters the wizard offers: those of the licence, or all of them when the licence is unknown. */
export function wizardAdapters(licensed: readonly AdapterCode[] | null): WizardAdapter[] {
  return WIZARD_ADAPTERS.filter((a) => !licensed || licensed.includes(a));
}

export function emptyForm(adapter: WizardAdapter): RepoForm {
  return {
    adapter,
    name: '',
    slug: '',
    ownershipType: 'organizational',
    modes: adapter === 'managed_vault' ? ['stored'] : ['link'],
    retentionConfirmed: false,
    metadataMinimization: false,
    tenantId: '',
    siteId: '',
    driveId: '',
    rootFolderId: '',
    driveKind: 'shared',
    oauthClientId: '',
    roots: {},
  };
}

/** A slug suggestion from a name: lower case, words joined by hyphens, at most 20 characters. */
export function suggestSlug(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '');
  return base.slice(0, 20).replace(/-+$/, '');
}

/** The Managed Vault key prefix of a new vault: `tenants/<org id>/<slug>/` (VaultRepositoryConfig, C.8 step 5). */
export function vaultPrefix(orgId: string | null, slug: string): string {
  return `tenants/${orgId ?? '<organisation>'}/${slug || '<short id>'}/`;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The form of an existing repository (Settings). */
export function formOf(repo: RepoModel): RepoForm {
  const config = repo.config ?? {};
  const roots: Record<string, RepoRoot> = {};
  const rawRoots = config.roots && typeof config.roots === 'object' ? (config.roots as Record<string, unknown>) : {};
  for (const [ms, value] of Object.entries(rawRoots)) {
    const v = (value ?? {}) as Record<string, unknown>;
    roots[ms] = { folderId: str(v.folderId), path: str(v.path) };
  }
  const adapter: WizardAdapter = (WIZARD_ADAPTERS as readonly string[]).includes(repo.adapter) ? (repo.adapter as WizardAdapter) : 'm365';
  const driveId = str(config.driveId);
  return {
    adapter,
    name: repo.name,
    slug: repo.slug,
    ownershipType: repo.ownershipType,
    modes: [...repo.modes],
    retentionConfirmed: repo.retentionConfirmed,
    metadataMinimization: repo.metadataMinimization,
    tenantId: '',
    siteId: str(config.siteId),
    driveId: adapter === 'google_drive' && driveId === MY_DRIVE_ID ? '' : driveId,
    rootFolderId: str(config.rootFolderId),
    driveKind: adapter === 'google_drive' && driveId === MY_DRIVE_ID ? 'my' : 'shared',
    oauthClientId: str(config.oauthClientId),
    roots,
  };
}

/** Field problems found before sending; keys are the form fields (`root:<ms>` for a system folder). */
export function formErrors(form: RepoForm, mode: 'create' | 'edit'): FormErrors {
  const out: FormErrors = {};
  if (!form.name.trim()) out.name = TEXT.required;
  if (mode === 'create') {
    if (!form.slug) out.slug = TEXT.required;
    else if (!SLUG.test(form.slug)) out.slug = TEXT.badSlug;
  }
  if (form.adapter !== 'managed_vault' && !form.modes.length) out.modes = TEXT.noModes;
  if (form.adapter === 'm365') {
    if (mode === 'create' && form.tenantId.trim() && !UUID.test(form.tenantId.trim())) out.tenantId = TEXT.badUuid;
    if (!form.siteId.trim()) out.siteId = TEXT.required;
    for (const key of ['driveId', 'rootFolderId'] as const) {
      if (!form[key].trim()) out[key] = TEXT.required;
      else if (!GRAPH_ID.test(form[key].trim())) out[key] = TEXT.badGraphId;
    }
  }
  if (form.adapter === 'google_drive') {
    const keys = form.driveKind === 'shared' ? (['driveId', 'rootFolderId'] as const) : (['rootFolderId'] as const);
    for (const key of keys) {
      if (!form[key].trim()) out[key] = TEXT.required;
      else if (!DRIVE_ID.test(form[key].trim())) out[key] = TEXT.badDriveId;
    }
  }
  if (form.adapter !== 'managed_vault') {
    const pattern = form.adapter === 'm365' ? GRAPH_ID : DRIVE_ID;
    for (const [ms, root] of Object.entries(form.roots)) {
      const id = root.folderId.trim();
      const path = root.path.trim();
      if (!id && !path) continue;
      if (!id || !path) out[`root:${ms}`] = TEXT.rootPair;
      else if (!pattern.test(id)) out[`root:${ms}`] = form.adapter === 'm365' ? TEXT.badGraphId : TEXT.badDriveId;
    }
  }
  return out;
}

/** The provider config of a form (no secrets): site, library or drive, root folder and the folder per system. */
export function configOf(form: RepoForm): Record<string, unknown> {
  const roots: Record<string, RepoRoot> = {};
  for (const [ms, root] of Object.entries(form.roots)) {
    if (root.folderId.trim() && root.path.trim()) roots[ms] = { folderId: root.folderId.trim(), path: root.path.trim() };
  }
  if (form.adapter === 'm365') {
    return { siteId: form.siteId.trim(), driveId: form.driveId.trim(), rootFolderId: form.rootFolderId.trim(), roots };
  }
  return {
    driveId: form.driveKind === 'my' ? MY_DRIVE_ID : form.driveId.trim(),
    rootFolderId: form.rootFolderId.trim(),
    roots,
    ...(form.oauthClientId.trim() ? { oauthClientId: form.oauthClientId.trim() } : {}),
  };
}

/** The card summary (`display.configSummary`, shown as `REPOS[].tenant`). */
export function summaryOf(form: RepoForm): TextPair | null {
  if (form.adapter === 'm365') return [`Site ${form.siteId.trim()}, library ${form.driveId.trim()}`, `Situs ${form.siteId.trim()}, library ${form.driveId.trim()}`];
  if (form.adapter === 'google_drive') {
    return form.driveKind === 'my'
      ? [`My Drive, root folder ${form.rootFolderId.trim()}`, `My Drive, folder akar ${form.rootFolderId.trim()}`]
      : [`Shared drive ${form.driveId.trim()}, root folder ${form.rootFolderId.trim()}`, `Shared drive ${form.driveId.trim()}, folder akar ${form.rootFolderId.trim()}`];
  }
  return null;
}

/** The ownership a form saves: a My Drive belongs to one account (personal, BR-30). */
function ownershipOf(form: RepoForm): OwnershipCode {
  return form.adapter === 'google_drive' && form.driveKind === 'my' ? 'personal' : form.ownershipType;
}

function modesOf(form: RepoForm): ModeCode[] {
  if (form.adapter === 'managed_vault') return ['stored'];
  return PROVIDER_MODES.filter((m) => form.modes.includes(m));
}

/** `RepositoryCreate` of a wizard form (D.2). */
export function createBody(form: RepoForm, orgId: string | null): RepositoryCreate {
  const common = {
    slug: form.slug,
    name: form.name.trim(),
    ownershipType: ownershipOf(form),
    metadataMinimization: form.metadataMinimization,
    retentionConfirmed: form.retentionConfirmed,
  };
  if (form.adapter === 'managed_vault') {
    return { ...common, adapter: 'managed_vault', modes: ['stored'], config: { prefix: vaultPrefix(orgId, form.slug) } };
  }
  const summary = summaryOf(form);
  const display: Record<string, unknown> = { ...(summary ? { configSummary: summary } : {}), ...(form.adapter === 'm365' && form.tenantId.trim() ? { tenantId: form.tenantId.trim() } : {}) };
  const modes = modesOf(form) as ('pass_through' | 'link' | 'zero_transit')[];
  if (form.adapter === 'm365') {
    type M365 = Extract<RepositoryCreate, { adapter: 'm365' }>;
    const body: M365 = { ...common, adapter: 'm365', modes, config: configOf(form) as M365['config'], display };
    return body;
  }
  type Google = Extract<RepositoryCreate, { adapter: 'google_drive' }>;
  const body: Google = { ...common, adapter: 'google_drive', modes, config: configOf(form) as Google['config'], display };
  return body;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Sorted copy of a config, so two configs compare by content. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** `RepositoryPatch` of the settings form: only the fields that changed; null when nothing changed. */
export function patchBody(form: RepoForm, repo: RepoModel): RepositoryPatch | null {
  const patch: Record<string, unknown> = {};
  if (form.name.trim() !== repo.name) patch.name = form.name.trim();
  const ownership = ownershipOf(form);
  if (ownership !== repo.ownershipType) patch.ownershipType = ownership;
  if (form.adapter !== 'managed_vault') {
    const modes = modesOf(form);
    if (!sameJson([...modes].sort(), [...repo.modes].sort())) patch.modes = modes;
    const config = configOf(form);
    if (!sameJson(canonical(config), canonical(repo.config))) {
      patch.config = config;
      const summary = summaryOf(form);
      if (summary) patch.display = { configSummary: summary };
    }
  }
  if (form.retentionConfirmed !== repo.retentionConfirmed) patch.retentionConfirmed = form.retentionConfirmed;
  if (form.metadataMinimization !== repo.metadataMinimization) patch.metadataMinimization = form.metadataMinimization;
  return Object.keys(patch).length ? (patch as RepositoryPatch) : null;
}

/** Whether a patch changes the provider config, which revokes the sealed credential (D-08). */
export function changesConfig(patch: RepositoryPatch | null): boolean {
  return Boolean(patch && patch.config !== undefined);
}

/** Server field errors keyed by the form fields (`config.siteId` is `siteId`, `config.roots.isms` is `root:isms`). */
export function serverFieldErrors(error: ApiError | null | undefined): FormErrors {
  const out: FormErrors = {};
  for (const [path, message] of Object.entries(fieldErrors(error))) {
    // `fieldErrors` keys each message by its full path and by the path without `body.`; the short one is used.
    if (!path || /^(body|query|params)(\.|$)/.test(path)) continue;
    const root = /^config\.roots\.([a-z][a-z0-9-]*)/.exec(path);
    let key = root ? `root:${root[1]}` : path.replace(/^(config|secret)\./, '');
    if (key === 'prefix') key = 'slug';
    if (!out[key]) out[key] = message;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The credential form
// ---------------------------------------------------------------------------------------------------------------

export type CredentialKindCode = 'm365_certificate' | 'google_service_account' | 'oauth_refresh_token';

export interface CredentialForm {
  kind: CredentialKindCode;
  tenantId: string;
  clientId: string;
  certificatePem: string;
  privateKeyPem: string;
  clientEmail: string;
  clientSecret: string;
}

/** The credential kinds an adapter takes (D.2 `CREDENTIAL_KINDS` of the server); none for the vault. */
export function credentialKinds(adapter: AdapterCode): CredentialKindCode[] {
  if (adapter === 'm365') return ['m365_certificate'];
  if (adapter === 'google_drive') return ['google_service_account', 'oauth_refresh_token'];
  return [];
}

export function emptyCredential(adapter: AdapterCode, tenantId = ''): CredentialForm {
  return { kind: credentialKinds(adapter)[0] ?? 'm365_certificate', tenantId, clientId: '', certificatePem: '', privateKeyPem: '', clientEmail: '', clientSecret: '' };
}

/** The OAuth client of a Google repository (`config.oauthClientId`), which a delegated credential must name. */
export function oauthClientOf(repo: Pick<RepoModel, 'config'>): string | null {
  const id = repo.config?.oauthClientId;
  return typeof id === 'string' && id ? id : null;
}

export function credentialErrors(form: CredentialForm, repo: Pick<RepoModel, 'config'>): FormErrors {
  const out: FormErrors = {};
  if (form.kind === 'm365_certificate') {
    if (!form.tenantId.trim()) out.tenantId = TEXT.required;
    else if (!UUID.test(form.tenantId.trim())) out.tenantId = TEXT.badUuid;
    if (!form.clientId.trim()) out.clientId = TEXT.required;
    if (!form.certificatePem.includes('BEGIN CERTIFICATE')) out.certificatePem = TEXT.badCert;
    if (!form.privateKeyPem.includes('PRIVATE KEY')) out.privateKeyPem = TEXT.badKey;
  } else if (form.kind === 'google_service_account') {
    if (!EMAIL.test(form.clientEmail.trim())) out.clientEmail = TEXT.badEmail;
    if (!form.privateKeyPem.includes('PRIVATE KEY')) out.privateKeyPem = TEXT.badKey;
  } else {
    if (!oauthClientOf(repo)) out.kind = TEXT.noOauthClient;
    if (!form.clientSecret) out.clientSecret = TEXT.required;
  }
  return out;
}

/** `RepositoryCredential` of a credential form (D.2). The delegated kind names the repository's OAuth client. */
export function credentialBody(form: CredentialForm, repo: Pick<RepoModel, 'config'>): RepositoryCredential {
  if (form.kind === 'm365_certificate') {
    return { kind: 'm365_certificate', secret: { tenantId: form.tenantId.trim(), clientId: form.clientId.trim(), certificatePem: form.certificatePem.trim() + '\n', privateKeyPem: form.privateKeyPem.trim() + '\n' } };
  }
  if (form.kind === 'google_service_account') {
    return { kind: 'google_service_account', secret: { clientEmail: form.clientEmail.trim(), privateKeyPem: form.privateKeyPem.trim() + '\n' } };
  }
  return { kind: 'oauth_refresh_token', secret: { clientId: oauthClientOf(repo) ?? '', clientSecret: form.clientSecret } };
}

/** True when the repository's credential is a delegated Google consent (its card offers re-authorisation). */
export function isDelegated(repo: Pick<RepoModel, 'actions'>): boolean {
  return repo.actions.includes('reauthorise');
}
