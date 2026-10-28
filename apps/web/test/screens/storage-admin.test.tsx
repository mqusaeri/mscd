// Repository administration (MILESTONE-2 M2-09): routes against the shared table, the form helpers (id patterns of
// D.5, the create, patch and credential bodies of D.2), the API adapter over a fake fetch (method, path, body,
// X-CSRF-Token, Idempotency-Key, refusals kept), the sample adapter, the views in both languages and themes, and the
// claims of the Storage repositories screen.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { RepositoryView } from '@mscd/shared';
import { ApiClient, CONNECTION_LOST } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/storage-admin/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/storage-admin/routes';
import { createApiAdapter, fromView } from '../../src/screens/storage-admin/api';
import { createSampleAdapter, resetSampleRepositories, sampleData } from '../../src/screens/storage-admin/sample';
import { adapterFor, deferredAdapter, readScopeOf, settled } from '../../src/screens/storage-admin/adapter';
import {
  configOf, createBody, credentialBody, credentialErrors, emptyCredential, emptyForm, formErrors, formOf, patchBody, serverFieldErrors, suggestSlug,
  vaultPrefix, wizardAdapters,
} from '../../src/screens/storage-admin/model';
import type { AdminData, RepoForm, RepoModel, StorageAdminAdapter } from '../../src/screens/storage-admin/model';
import { ConnectWizard, RepositoryPanel, RepoFields, CredentialSection, TestSection, stepsOf } from '../../src/screens/storage-admin/panels';
import { RepositoryTable, credentialText } from '../../src/screens/storage-admin/Screen';
import { claims, connectRepository, layerItems, repositorySettings, SAMPLE_TOASTS } from '../../src/screens/storage-admin/actions';
import { requestStorage, storageRequest } from '../../src/screens/storage-admin/store';
import { repoOf } from '../../src/screens/storage-admin/LayerHost';
import { TEXT } from '../../src/screens/storage-admin/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData } from '../../src/data/types';
import { LICENCE, MS, PEOPLE, REPOS, TODAY_S } from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { fakeFetch, json, problem } from '../auth/helpers';

const D = { ...makeDates(TODAY_S), LICENCE, MS, PEOPLE, REPOS, TODAY_S } as unknown as ControllerData;
const ORG = '00000000-0000-4000-8000-00000000a004';

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: null, org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'storage-admin', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const SP_VIEW: RepositoryView = {
  id: 'sp', ref: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', name: 'SharePoint Online', type: 'Microsoft 365', status: 'ok', tenant: 'drive-sp-compliance',
  ms: ['ISMS'], last: '29 Sep 2026 06:00', adapter: 'm365', modes: ['link', 'pass_through'], ownershipType: 'organizational', connectionStatus: 'ok',
  retentionConfirmed: true, metadataMinimization: false, readOnly: false, credentialSet: true, credentialExpiresAt: '2027-06-30T00:00:00.000Z',
  config: { siteId: 'contoso.sharepoint.com,1,2', driveId: 'drive-sp-compliance', rootFolderId: 'root-compliance', roots: { isms: { folderId: 'f-isms', path: 'Compliance/ISMS' } } },
  actions: ['test'],
};
const VAULT_VIEW: RepositoryView = {
  ...SP_VIEW, id: 'vault', ref: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a', name: 'Managed Vault', type: '', tenant: ['Encryption per tenant', 'Enkripsi per tenant'],
  adapter: 'managed_vault', modes: ['stored'], credentialSet: false, credentialExpiresAt: null, config: { prefix: `tenants/${ORG}/` },
};

const M365_FORM: RepoForm = {
  ...emptyForm('m365'), name: 'SharePoint E2E', slug: 'sp-e2e', tenantId: '6d3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b', siteId: 'contoso.sharepoint.com,1,2',
  driveId: 'drive-sp-compliance', rootFolderId: 'demo-sp-compliance', modes: ['link', 'pass_through'], retentionConfirmed: true,
  roots: { isms: { folderId: 'demo-sp-isms', path: 'Compliance/ISMS' }, qms: { folderId: '', path: '' } },
};

afterEach(() => {
  resetSampleRepositories();
  requestStorage(null);
});

describe('repository administration routes', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.reposCreate).permission).toBe('storage.repository.manage');
    expect(routeById(ROUTE_IDS.reposCredentials).permission).toBe('storage.repository.manage');
    expect(routeById(ROUTE_IDS.reposTest).permission).toBe('storage.repository.test');
    expect(routeById(ROUTE_IDS.reposList).permission).toBe('storage.repository.read');
  });
});

describe('the settings form', () => {
  it('checks the short id, the Graph and Drive id patterns and the folder pairs before sending', () => {
    expect(formErrors(M365_FORM, 'create')).toEqual({});
    const bad = formErrors({ ...M365_FORM, slug: 'SP 1', driveId: 'drive/1', rootFolderId: '', tenantId: 'x', modes: [], roots: { isms: { folderId: 'a b', path: 'X' }, qms: { folderId: 'f', path: '' } } }, 'create');
    expect(bad).toEqual({
      slug: TEXT.badSlug, driveId: TEXT.badGraphId, rootFolderId: TEXT.required, tenantId: TEXT.badUuid, modes: TEXT.noModes, 'root:isms': TEXT.badGraphId, 'root:qms': TEXT.rootPair,
    });
    const gd: RepoForm = { ...emptyForm('google_drive'), name: 'Drive', slug: 'gd2', driveId: 'drive!x', rootFolderId: 'root-1' };
    expect(formErrors(gd, 'create')).toEqual({ driveId: TEXT.badDriveId });
    // A My Drive needs no drive id (product decision 1).
    expect(formErrors({ ...gd, driveKind: 'my', driveId: '' }, 'create')).toEqual({});
    expect(formErrors({ ...emptyForm('managed_vault'), name: 'Vault 2', slug: 'vault2' }, 'create')).toEqual({});
    expect(formErrors({ ...M365_FORM, slug: '' }, 'edit')).toEqual({});
  });

  it('builds RepositoryCreate for Microsoft 365, Google shared drive, My Drive and the Managed Vault', () => {
    expect(createBody(M365_FORM, ORG)).toEqual({
      slug: 'sp-e2e', name: 'SharePoint E2E', ownershipType: 'organizational', metadataMinimization: false, retentionConfirmed: true, adapter: 'm365',
      modes: ['link', 'pass_through'],
      config: { siteId: 'contoso.sharepoint.com,1,2', driveId: 'drive-sp-compliance', rootFolderId: 'demo-sp-compliance', roots: { isms: { folderId: 'demo-sp-isms', path: 'Compliance/ISMS' } } },
      display: { configSummary: ['Site contoso.sharepoint.com,1,2, library drive-sp-compliance', 'Situs contoso.sharepoint.com,1,2, library drive-sp-compliance'], tenantId: '6d3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' },
    });
    const shared = createBody({ ...emptyForm('google_drive'), name: 'BCMS drive', slug: 'gd2', driveId: 'drive-gd', rootFolderId: 'root-1', oauthClientId: 'client-1', modes: ['zero_transit', 'link'] }, ORG);
    expect(shared).toMatchObject({ adapter: 'google_drive', ownershipType: 'organizational', modes: ['link', 'zero_transit'], config: { driveId: 'drive-gd', rootFolderId: 'root-1', roots: {}, oauthClientId: 'client-1' } });
    const mine = createBody({ ...emptyForm('google_drive'), name: 'My files', slug: 'mine', driveKind: 'my', rootFolderId: 'root-2' }, ORG);
    expect(mine).toMatchObject({ ownershipType: 'personal', config: { driveId: 'root', rootFolderId: 'root-2' } });
    expect(createBody({ ...emptyForm('managed_vault'), name: 'Vault 2', slug: 'vault2' }, ORG)).toEqual({
      slug: 'vault2', name: 'Vault 2', ownershipType: 'organizational', metadataMinimization: false, retentionConfirmed: false, adapter: 'managed_vault', modes: ['stored'],
      config: { prefix: `tenants/${ORG}/vault2/` },
    });
    expect(vaultPrefix(null, '')).toBe('tenants/<organisation>/<short id>/');
    expect(suggestSlug('SharePoint Compliance Library 2026')).toBe('sharepoint-complianc');
    expect(suggestSlug('2026 drive')).toBe('drive');
  });

  it('a patch holds only the changed fields; a config change adds the card summary', () => {
    const repo = fromView(SP_VIEW);
    const form = formOf(repo);
    expect(form).toMatchObject({ adapter: 'm365', siteId: 'contoso.sharepoint.com,1,2', roots: { isms: { folderId: 'f-isms', path: 'Compliance/ISMS' } } });
    expect(patchBody(form, repo)).toBeNull();
    expect(patchBody({ ...form, name: 'SharePoint Compliance' }, repo)).toEqual({ name: 'SharePoint Compliance' });
    expect(patchBody({ ...form, modes: ['pass_through', 'link'] }, repo)).toBeNull();
    const moved = patchBody({ ...form, rootFolderId: 'root-2' }, repo)!;
    expect(moved.config).toEqual({ ...configOf(form), rootFolderId: 'root-2' });
    expect(moved.display).toEqual({ configSummary: expect.any(Array) });
    const myDrive = formOf({ ...repo, adapter: 'google_drive', config: { driveId: 'root', rootFolderId: 'r', roots: {} } });
    expect([myDrive.driveKind, myDrive.driveId]).toEqual(['my', '']);
  });

  it('maps server field errors to the form fields', () => {
    const error = { status: 400, message: ['Check', 'Periksa'] as [string, string], errors: [
      { path: 'body.config.siteId', message: 'Required' }, { path: 'body.config.roots.qms', message: 'No management system with this slug' },
      { path: 'body.slug', message: 'Invalid' }, { path: 'body.secret.tenantId', message: 'Invalid uuid' }, { path: 'body.config.prefix', message: 'Bad prefix' },
    ] };
    expect(serverFieldErrors(error)).toEqual({ siteId: 'Required', 'root:qms': 'No management system with this slug', slug: 'Invalid', tenantId: 'Invalid uuid' });
    expect(serverFieldErrors(null)).toEqual({});
  });

  it('checks and builds the credential: certificate, service account and delegated consent', () => {
    const repo = fromView(SP_VIEW);
    const m365 = { ...emptyCredential('m365', '6d3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b'), clientId: 'app-1', certificatePem: '-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----' };
    expect(credentialErrors(m365, repo)).toEqual({});
    expect(credentialErrors({ ...m365, tenantId: 'nope', certificatePem: 'x', privateKeyPem: '' }, repo)).toEqual({ tenantId: TEXT.badUuid, certificatePem: TEXT.badCert, privateKeyPem: TEXT.badKey });
    expect(credentialBody(m365, repo)).toEqual({ kind: 'm365_certificate', secret: { tenantId: '6d3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b', clientId: 'app-1', certificatePem: `${m365.certificatePem}\n`, privateKeyPem: `${m365.privateKeyPem}\n` } });
    const gd = { ...repo, adapter: 'google_drive' as const, config: { driveId: 'd', rootFolderId: 'r', roots: {}, oauthClientId: 'client-1' } };
    const sa = { ...emptyCredential('google_drive'), clientEmail: 'mscd@p.iam.gserviceaccount.com', privateKeyPem: '-----BEGIN PRIVATE KEY-----' };
    expect(sa.kind).toBe('google_service_account');
    expect(credentialErrors(sa, gd)).toEqual({});
    expect(credentialErrors({ ...sa, clientEmail: 'nope' }, gd)).toEqual({ clientEmail: TEXT.badEmail });
    const oauth = { ...emptyCredential('google_drive'), kind: 'oauth_refresh_token' as const, clientSecret: 's3cret' };
    expect(credentialBody(oauth, gd)).toEqual({ kind: 'oauth_refresh_token', secret: { clientId: 'client-1', clientSecret: 's3cret' } });
    expect(credentialErrors(oauth, { config: {} })).toEqual({ kind: TEXT.noOauthClient });
  });

  it('offers the licensed wizard adapters, or all of them when the licence is unknown', () => {
    expect(wizardAdapters(['managed_vault', 'm365', 'smb'])).toEqual(['managed_vault', 'm365']);
    expect(wizardAdapters(null)).toEqual(['managed_vault', 'm365', 'google_drive']);
    expect(stepsOf('managed_vault')).toEqual(['type', 'settings', 'test']);
    expect(stepsOf('m365')).toEqual(['type', 'settings', 'credential', 'test']);
  });
});

describe('repository administration API adapter', () => {
  const scope = { licence: true, systems: true, fallbackSystems: [], orgId: ORG };

  it('loads the repositories, the licensed adapters and the systems that are not archived', async () => {
    const f = fakeFetch({
      'GET /api/v1/admin/storage/repositories': json([SP_VIEW, VAULT_VIEW]),
      'GET /api/v1/license': json({ storageAdapters: ['managed_vault', 'm365'] }),
      'GET /api/v1/admin/management-systems': json([{ slug: 'isms', code: 'ISMS', status: 'implementing' }, { slug: 'old', code: 'OLD', status: 'archived' }]),
    });
    const res = await createApiAdapter(new ApiClient({ fetch: f.fetch }), scope).load();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.repos.map((r) => [r.slug, r.ref, r.credentialSet])).toEqual([['sp', SP_VIEW.ref, true], ['vault', VAULT_VIEW.ref, false]]);
    expect(res.data.licensed).toEqual(['managed_vault', 'm365']);
    expect(res.data.systems).toEqual([{ slug: 'isms', code: 'ISMS' }]);
    expect(res.data.orgId).toBe(ORG);
  });

  it('without license.read and ms.admin it reads neither and offers the snapshot systems', async () => {
    const f = fakeFetch({ 'GET /api/v1/admin/storage/repositories': json([SP_VIEW]) });
    const res = await createApiAdapter(new ApiClient({ fetch: f.fetch }), { licence: false, systems: false, fallbackSystems: [{ slug: 'isms', code: 'ISMS' }], orgId: ORG }).load();
    expect(f.calls.map((c) => c.path)).toEqual(['/api/v1/admin/storage/repositories']);
    expect(res).toMatchObject({ ok: true, data: { licensed: null, systems: [{ slug: 'isms', code: 'ISMS' }] } });
  });

  it('creates with POST, the Idempotency-Key and the CSRF token; changes with PATCH; seals with PUT; tests with POST', async () => {
    const f = fakeFetch({
      'POST /api/v1/admin/storage/repositories': json({ ...SP_VIEW, id: 'sp-e2e', credentialSet: false }, 201),
      [`PATCH /api/v1/admin/storage/repositories/${SP_VIEW.ref}`]: json({ ...SP_VIEW, name: 'Renamed' }),
      [`PUT /api/v1/admin/storage/repositories/${SP_VIEW.ref}/credentials`]: { status: 204 },
      [`POST /api/v1/admin/storage/repositories/${SP_VIEW.ref}/test`]: json({ ok: true, changed: [], message: ['Connected', 'Terhubung'], data: { status: 'ok', permissions: ['Sites.Selected: read'], references: 3, nextCheckAt: '2026-09-30T19:30:00Z', message: ['Connected to Compliance', 'Terhubung ke Compliance'] } }),
      [`POST /api/v1/admin/storage/repositories/${SP_VIEW.ref}/reauthorize`]: json({ ok: true, changed: [], redirectUrl: 'https://accounts.example/o/oauth2/v2/auth?x=1', message: ['Continue', 'Lanjutkan'] }),
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client, scope);
    const body = createBody(M365_FORM, ORG);
    expect(await adapter.create(body, 'key-1')).toMatchObject({ ok: true, data: { slug: 'sp-e2e' } });
    expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/admin/storage/repositories', body });
    expect(f.calls[0].headers['idempotency-key']).toBe('key-1');
    expect(f.calls[0].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    expect(await adapter.update(SP_VIEW.ref, { name: 'Renamed' })).toMatchObject({ ok: true, data: { name: 'Renamed' } });
    expect(f.calls[1]).toMatchObject({ method: 'PATCH', body: { name: 'Renamed' } });
    const secret = { kind: 'google_service_account' as const, secret: { clientEmail: 'a@b.co', privateKeyPem: 'PRIVATE KEY' } };
    expect(await adapter.setCredential(SP_VIEW.ref, secret)).toEqual({ ok: true, data: null });
    expect(f.calls[2]).toMatchObject({ method: 'PUT', body: secret });
    expect(await adapter.test(SP_VIEW.ref)).toEqual({ ok: true, data: { status: 'ok', permissions: ['Sites.Selected: read'], references: 3, nextCheckAt: '2026-09-30T19:30:00Z', message: ['Connected to Compliance', 'Terhubung ke Compliance'] } });
    expect(await adapter.consent(SP_VIEW.ref)).toEqual({ ok: true, data: { redirectUrl: 'https://accounts.example/o/oauth2/v2/auth?x=1' }, message: ['Continue', 'Lanjutkan'] });
  });

  it('keeps refusals with their field errors and rule', async () => {
    const f = fakeFetch({
      'POST /api/v1/admin/storage/repositories': [
        problem(400, 'validation', { errors: [{ path: 'body.config.driveId', message: 'Invalid' }] }),
        problem(422, 'business-rule', { rule: 'LIC-FEATURE', messages: { en: 'The licence does not include the m365 storage adapter', id: 'Lisensi tidak mencakup adapter penyimpanan m365' } }),
      ],
    });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }), scope);
    const first = await adapter.create(createBody(M365_FORM, ORG), 'k');
    expect(first.ok).toBe(false);
    if (!first.ok) expect(serverFieldErrors(first.error)).toEqual({ driveId: 'Invalid' });
    const second = await adapter.create(createBody(M365_FORM, ORG), 'k');
    if (second.ok) throw new Error('expected a refusal');
    expect(second.error.rule).toBe('LIC-FEATURE');
    expect(second.error.message).toEqual(['The licence does not include the m365 storage adapter', 'Lisensi tidak mencakup adapter penyimpanan m365']);
  });
});

describe('repository administration sample adapter', () => {
  it('lists the sample repositories with their settings, the licensed adapters and the systems', () => {
    const data = sampleData(D, 'ndt');
    expect(data.repos.map((r) => r.slug)).toEqual(REPOS.map((r: { id: string }) => r.id));
    const sp = data.repos.find((r) => r.slug === 'sp')!;
    expect(sp).toMatchObject({ adapter: 'm365', modes: ['link', 'pass_through'], credentialSet: true, connectionStatus: 'ok' });
    expect(data.repos.find((r) => r.slug === 'gd')).toMatchObject({ connectionStatus: 'revoked', actions: ['test', 'reauthorise'] });
    expect(data.licensed).toEqual(['managed_vault', 'm365', 'google_drive', 'smb']);
    expect(data.systems.map((s) => s.code)).toEqual(['ISMS', 'QMS', 'BCMS', 'ABMS']);
  });

  it('connects a repository for the session: create, credential, test; a config change asks for the credential again', async () => {
    const adapter = createSampleAdapter(() => D, 'ndt');
    const created = await adapter.create(createBody(M365_FORM, 'ndt'), 'k');
    if (!created.ok) throw new Error('create failed');
    expect(created.data).toMatchObject({ slug: 'sp-e2e', credentialSet: false, connectionStatus: 'failed' });
    expect((await adapter.create(createBody(M365_FORM, 'ndt'), 'k')).ok).toBe(false);
    expect(await adapter.test(created.data.ref)).toMatchObject({ ok: true, data: { status: 'failed' } });
    await adapter.setCredential(created.data.ref, { kind: 'm365_certificate', secret: { tenantId: '6d3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b', clientId: 'a', certificatePem: 'BEGIN CERTIFICATE', privateKeyPem: 'PRIVATE KEY' } });
    expect(await adapter.test(created.data.ref)).toMatchObject({ ok: true, data: { status: 'ok', message: ['Connected to SharePoint E2E, Compliance/ISMS', 'Terhubung ke SharePoint E2E, Compliance/ISMS'] } });
    const changed = await adapter.update(created.data.ref, { config: { ...configOf(M365_FORM), rootFolderId: 'other' } });
    expect(changed).toMatchObject({ ok: true, data: { credentialSet: false, connectionStatus: 'failed' } });
    const listed = await adapter.load();
    if (listed.ok) expect(listed.data.repos.map((r) => r.slug)).toContain('sp-e2e');
    expect(await adapter.consent(created.data.ref)).toMatchObject({ ok: false, error: { status: 409 } });
    const gd = listed.ok ? listed.data.repos.find((r) => r.slug === 'gd')! : null;
    expect(await adapter.consent(gd!.ref)).toMatchObject({ ok: true, data: { redirectUrl: null } });
  });

  it('keeps the repositories and the changes of the session per organisation when the organisation switcher changes the snapshot', async () => {
    const source = createSampleDataSource();
    const snapshotOf = async (org: string) => ({ ...makeDates(TODAY_S), ...(await source.load(org)), TODAY_S }) as unknown as ControllerData;
    const [ndt, bsd, rmn] = [await snapshotOf('ndt'), await snapshotOf('bsd'), await snapshotOf('rmn')];
    let current = ndt;
    let org = 'ndt';
    // The screen makes its adapter with the organisation of the context when it opens; an organisation switch opens
    // the landing screen first, so each organisation gets a new adapter, and the session state is per organisation.
    const open = () => createSampleAdapter(() => current, org);
    const list = async (adapter: StorageAdminAdapter) => {
      const res = await adapter.load();
      return res.ok ? res.data.repos.map((r) => r.slug) : null;
    };
    const atNdt = open();
    expect(await list(atNdt)).toEqual(['sp', 'gd', 'vault', 'od']);
    expect(await atNdt.create(createBody(M365_FORM, 'ndt'), 'k')).toMatchObject({ ok: true });
    const ndtData = await atNdt.load();
    const sp = ndtData.ok ? ndtData.data.repos.find((r) => r.slug === 'sp') : undefined;
    expect(sp).toBeDefined();
    expect(await atNdt.update(sp!.ref, { name: 'Compliance library' })).toMatchObject({ ok: true });
    expect(await list(atNdt)).toEqual(['sp', 'gd', 'vault', 'od', 'sp-e2e']);
    [current, org] = [rmn, 'rmn'];
    const atRmn = open();
    expect(await list(atRmn)).toEqual(['sp', 'od']);
    const rmnData = await atRmn.load();
    expect(rmnData.ok ? rmnData.data.repos.map((r) => [r.name, r.systems]) : null).toEqual([['SharePoint Online', ['ISMS']], ['OneDrive personal', ['ISMS']]]);
    expect(rmnData.ok ? rmnData.data.systems.map((s) => s.code) : null).toEqual(['ISMS']);
    // The short id is taken only in the organisation that made it.
    expect(await atRmn.create(createBody(M365_FORM, 'rmn'), 'k')).toMatchObject({ ok: true });
    [current, org] = [bsd, 'bsd'];
    const atBsd = await open().load();
    expect(atBsd.ok ? atBsd.data.repos.map((r) => r.slug) : null).toEqual(['sp', 'vault', 'od']);
    expect(atBsd.ok ? atBsd.data.repos.find((r) => r.slug === 'vault')?.config : null).toEqual({ prefix: 'tenants/bsd/' });
    [current, org] = [ndt, 'ndt'];
    const back = await open().load();
    expect(back.ok ? back.data.repos.map((r) => [r.slug, r.name]) : null).toEqual([
      ['sp', 'Compliance library'], ['gd', 'Google Shared Drive'], ['vault', 'Managed Vault'], ['od', 'OneDrive personal'], ['sp-e2e', 'SharePoint E2E'],
    ]);
    expect(back.ok ? back.data.repos.find((r) => r.slug === 'vault')?.config : null).toEqual({ prefix: 'tenants/ndt/' });
  });

  it('the build chooses the adapter: outside an api build the sample one, loaded on first use', async () => {
    expect(import.meta.env.VITE_DATA_SOURCE).not.toBe('api');
    const res = await adapterFor(ctxOf('en'), () => D).load();
    expect(res).toMatchObject({ ok: true, data: { sample: true } });
  });

  it('a deferred adapter loads its module again after a failed load, and settled calls never reject', async () => {
    const load = vi.fn<() => Promise<StorageAdminAdapter>>()
      .mockRejectedValueOnce(new Error('chunk not loaded'))
      .mockResolvedValue(createSampleAdapter(() => D, 'ndt'));
    const adapter = deferredAdapter(load);
    expect(await settled(adapter.load())).toEqual({ ok: false, error: { status: 0, message: CONNECTION_LOST } });
    expect(await settled(adapter.load())).toMatchObject({ ok: true });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reads the licence and systems only with the permissions for them', () => {
    const can = (held: string[]) => (perm: string | readonly string[]) => (Array.isArray(perm) ? perm : [perm]).some((p) => held.includes(p));
    const ta = readScopeOf(ctxOf('en', { mode: 'api', orgCan: can(['license.read', 'ms.admin']), me: { org: { id: ORG, slug: 'tst', name: 'Test' } } as never }));
    expect(ta).toMatchObject({ licence: true, systems: true, orgId: ORG });
    const sa = readScopeOf(ctxOf('en', { mode: 'api', orgCan: can(['storage.repository.manage']) }));
    expect(sa).toMatchObject({ licence: false, systems: false, orgId: null });
    expect(sa.fallbackSystems.map((s) => s.code)).toEqual(['ISMS', 'QMS', 'BCMS', 'ABMS']);
  });
});

describe('repository administration views', () => {
  const data: AdminData = { ...sampleData(D, 'ndt') };
  const repos: RepoModel[] = data.repos;

  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the table, the wizard and the settings drawer in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf(lang);
        const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
        const table = render(<RepositoryTable ctx={ctx} repos={repos} onSettings={() => undefined} />, ctx, theme);
        for (const p of [TEXT.colName, TEXT.colStorage, TEXT.colModes, TEXT.colConnection, TEXT.colCredential, TEXT.colSystems, TEXT.settings]) expect(table).toContain(t(p));
        expect(table).toContain('SharePoint Online');
        expect(table).toContain(lang === 'id' ? 'Akses dicabut' : 'Access revoked');
        const wizard = render(<ConnectWizard ctx={ctx} adapter={createSampleAdapter(() => D, 'ndt')} data={data} open onClose={() => undefined} onChanged={() => undefined} />, ctx, theme);
        expect(wizard).toContain(t(TEXT.wizardTitle));
        // The first step shows no total: the number of steps depends on the storage type chosen there.
        expect(wizard).toContain(lang === 'id' ? 'Langkah 1: Jenis penyimpanan' : 'Step 1: Storage type');
        expect(wizard).not.toMatch(lang === 'id' ? /Langkah 1 dari/ : /Step 1 of/);
        expect(wizard).toContain(lang === 'id' ? 'Google Drive (shared drive atau My Drive)' : 'Google Drive (shared drive or My Drive)');
        expect(wizard).toMatch(/role="dialog"/);
        const panel = render(<RepositoryPanel ctx={ctx} adapter={createSampleAdapter(() => D, 'ndt')} data={data} repo={repos[0]} open onClose={() => undefined} onChanged={() => undefined} />, ctx, theme);
        for (const p of [TEXT.testTitle, TEXT.test, TEXT.configNote, TEXT.siteId, TEXT.libraryId, TEXT.rootFolderId, TEXT.credTitle, TEXT.replaceCredential, TEXT.credSealed]) expect(panel).toContain(t(p));
        expect(panel).not.toMatch(/[\u2014\u00b7]/);
      });
    }
  }

  it('the settings fields of each storage type', () => {
    const ctx = ctxOf('en');
    const fields = (form: RepoForm, mode: 'create' | 'edit' = 'create') => render(<RepoFields ctx={ctx} form={form} onChange={() => undefined} errors={{ slug: TEXT.badSlug }} systems={[{ slug: 'isms', code: 'ISMS' }]} mode={mode} orgId={ORG} prefix={`tenants/${ORG}/`} />, ctx);
    const m365 = fields(M365_FORM);
    for (const p of [TEXT.tenantId, TEXT.siteId, TEXT.libraryId, TEXT.rootFolderId, TEXT.roots, TEXT.modes, TEXT.retention]) expect(m365).toContain(p[0]);
    expect(m365).toContain('ISMS: folder id');
    expect(m365).toContain(TEXT.badSlug[0]);
    const my = fields({ ...emptyForm('google_drive'), driveKind: 'my' });
    expect(my).toContain(TEXT.myDriveWarn[0]);
    expect(my).not.toContain(TEXT.driveId[0]);
    expect(my).toContain(TEXT.oauthClientId[0]);
    const vault = fields({ ...emptyForm('managed_vault'), slug: 'vault2' });
    expect(vault).toContain(`tenants/${ORG}/vault2/`);
    expect(vault).toContain(TEXT.vaultMode[0]);
    expect(fields({ ...emptyForm('managed_vault'), slug: 'vault' }, 'edit')).toContain(`tenants/${ORG}/`);
  });

  it('the credential and test sections; the vault needs no credential', () => {
    const ctx = ctxOf('en');
    const adapter = createSampleAdapter(() => D, 'ndt');
    const gd = repos.find((r) => r.slug === 'gd')!;
    const cred = render(<CredentialSection ctx={ctx} adapter={adapter} repo={gd} onSaved={() => undefined} />, ctx);
    expect(cred).toContain(TEXT.kindServiceAccount[0]);
    expect(cred).toContain(TEXT.kindConsent[0]);
    expect(cred).toContain(TEXT.clientEmail[0]);
    const vault = repos.find((r) => r.slug === 'vault')!;
    expect(render(<CredentialSection ctx={ctx} adapter={adapter} repo={vault} onSaved={() => undefined} />, ctx)).toContain(TEXT.credVault[0]);
    const test = render(<TestSection ctx={ctx} adapter={adapter} repo={gd} onTested={() => undefined} />, ctx);
    expect(test).toContain('Access revoked');
    expect(test).toContain(TEXT.testHint[0]);
    expect(credentialText(ctx, vault).text).toBe(TEXT.credNone[0]);
    expect(credentialText(ctx, { ...gd, credentialSet: false }).text).toBe(TEXT.credNotSet[0]);
    expect(credentialText(ctx, repos.find((r) => r.slug === 'sp')!).text).toBe('Expires 30 Jun 2027');
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries(TEXT)) {
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(/[\u2014\u00b7]/);
    }
  });
});

describe('claims of the Storage repositories screen and the screen definition', () => {
  it('the sample build keeps the Milestone 1 toasts', () => {
    const ctx = ctxOf('en');
    claims!['storage.connect']!(ctx, {});
    claims!['storage.settings']!(ctx, { repo: REPOS[0] });
    expect(ctx.toast).toHaveBeenNthCalledWith(1, SAMPLE_TOASTS.connect[0]);
    expect(ctx.toast).toHaveBeenNthCalledWith(2, SAMPLE_TOASTS.settings[0]);
    expect(storageRequest()).toBeNull();
  });

  it('in API mode a manager of repositories gets the drawers; a reader is told who connects repositories', () => {
    const api = ctxOf('id', { mode: 'api' });
    connectRepository(api);
    expect(storageRequest()).toMatchObject({ kind: 'connect' });
    repositorySettings(api, { repo: { id: 'sp', ref: SP_VIEW.ref } });
    expect(storageRequest()).toMatchObject({ kind: 'settings', ref: SP_VIEW.ref, slug: 'sp' });
    const data = { repos: [fromView(SP_VIEW), fromView(VAULT_VIEW)] } as AdminData;
    expect(repoOf(data, storageRequest()!)?.slug).toBe('sp');
    expect(repoOf(data, { kind: 'settings', ref: null, slug: 'vault', at: 1 })?.slug).toBe('vault');
    requestStorage(null);
    const reader = ctxOf('id', { mode: 'api', orgCan: () => false });
    connectRepository(reader);
    expect(reader.toast).toHaveBeenCalledWith(TEXT.noPermission[1]);
    expect(storageRequest()).toBeNull();
    expect(layerItems!.map((i) => i.id)).toEqual(['storage-admin-drawers']);
  });

  it('has no sidebar entry, opens with storage.repository.manage and offers Connect repository', () => {
    expect(screen).toMatchObject({ id: 'storage-admin', path: '/admin/storage/storage-admin', group: 'admin', scope: 'org', perm: 'storage.repository.manage', nav: false });
    const ctx = ctxOf('en');
    const actions = screen.pageActions!(ctx);
    expect(actions.map((a) => a.label[0])).toEqual(['Connect repository']);
    actions[0].run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('storage-admin', { params: { connect: expect.any(Number) } });
    expect(screen.pageActions!(ctxOf('en', { orgCan: () => false }))).toEqual([]);
  });
});
