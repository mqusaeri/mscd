// The Licence screen (MILESTONE-2 M2-01): routes against the shared table, the view in both languages and themes,
// the API adapter over a fake fetch (method, path, body, X-CSRF-Token, refusals kept), the sample adapter, the page
// action rule (license.manage) and the install dialog's error mapping.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { LicenceView as WireLicence } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/license/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/license/routes';
import { createApiAdapter, fromView } from '../../src/screens/license/api';
import { createSampleAdapter, fromSample, isoOfDay, resetSampleLicence, usageOf } from '../../src/screens/license/sample';
import { InstallDialog, LicenceView, adapterFor, deferredAdapter, installError, stateBadges } from '../../src/screens/license/Screen';
import { TEXT } from '../../src/screens/license/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData } from '../../src/data/types';
import { LICENCE, MS, TODAY_S } from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { fakeFetch, json, problem } from '../auth/helpers';

const VIEW: WireLicence = {
  licenseId: 'LIC-DEMO-NDT', organization: 'PT Nusantara Digital Teknologi', binding: { organizationId: '00000000-0000-4000-8000-00000000a001', trial: false },
  validFrom: '2026-04-01', validUntil: '2027-03-31', graceDays: 30, state: 'valid', clockRollback: false, frameworks: ['ISO27001', 'ISO9001'],
  maxManagementSystems: 10, maxUsers: 150, activeUsers: 86, managementSystems: 4, storageAdapters: ['managed_vault', 'm365'],
  features: ['integrated_mode', 'auditor_guest_access'], signature: { alg: 'Ed25519', keyId: '0a1b2c3d4e5f6789', verified: true, offline: true },
};

const D = { ...makeDates(TODAY_S), LICENCE, MS, TODAY_S } as unknown as ControllerData;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: null, org: null, me: null, person: { handle: 'rina', name: 'Rina', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'license', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: async () => undefined, command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

afterEach(() => resetSampleLicence());

describe('Licence routes', () => {
  it('match the shared route table', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.licenseGet).permission).toBe('license.read');
    expect(routeById(ROUTE_IDS.licensePut).permission).toBe('license.manage');
  });
});

describe('Licence view', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`shows the licence in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf(lang);
        const html = render(<LicenceView ctx={ctx} licence={fromView(VIEW)} />, ctx, theme);
        const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
        expect(html).toContain('LIC-DEMO-NDT');
        expect(html).toContain(t(TEXT.stateValid));
        expect(html).toContain(t(TEXT.details));
        expect(html).toContain(lang === 'id' ? '86 dari 150 anggota aktif' : '86 of 150 active members');
        expect(html).toContain(lang === 'id' ? '4 dari 10' : '4 of 10');
        expect(html).toContain('ISO/IEC 27001, ISO 9001');
        expect(html).toContain('Managed Vault, Microsoft 365');
        expect(html).toContain(lang === 'id' ? 'Sistem Manajemen Terintegrasi, Akses tamu auditor' : 'Integrated Management System, Auditor guest access');
        expect(html).toContain(lang === 'id' ? '31 Mar 2027' : '31 Mar 2027');
        expect(html).toContain(t(TEXT.seatsNote));
        expect(html).toContain(lang === 'id' ? 'kunci 0a1b2c3d4e5f6789, terverifikasi' : 'key 0a1b2c3d4e5f6789, verified');
        expect(html).not.toMatch(/[\u2014\u00b7]/);
      });
    }
  }

  it('warns in the grace period, when read-only and after a clock rollback', () => {
    const ctx = ctxOf('en');
    const grace = render(<LicenceView ctx={ctx} licence={fromView({ ...VIEW, state: 'grace', validUntil: '2026-09-01', clockRollback: true })} />, ctx);
    expect(grace).toContain(TEXT.graceAlert[0]);
    expect(grace).toContain(TEXT.rollbackAlert[0]);
    expect(grace).toContain(TEXT.stateExpired[0]);
    const ro = render(<LicenceView ctx={ctx} licence={fromView({ ...VIEW, state: 'read_only' })} />, ctx);
    expect(ro).toContain(TEXT.readOnlyAlert[0]);
  });

  it('badges: the state, and Expired once the end date passed', () => {
    const lic = fromView(VIEW);
    expect(stateBadges(lic, '2026-10-27').map((b) => [b.tone, b.label[0]])).toEqual([['ok', 'Valid']]);
    expect(stateBadges({ ...lic, state: 'grace' }, '2027-04-05').map((b) => b.label[0])).toEqual(['Grace period', 'Expired']);
    expect(stateBadges({ ...lic, state: 'read_only' }, '2027-06-01').map((b) => [b.tone, b.label[0]])).toEqual([['bad', 'Read-only'], ['bad', 'Expired']]);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries(TEXT)) {
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(/[\u2014\u00b7]/);
    }
  });
});

describe('Licence API adapter', () => {
  it('reads GET /license; 404 means no licence; another failure is kept', async () => {
    const f = fakeFetch({ 'GET /api/v1/license': [json(VIEW), problem(404, 'not-found'), problem(503, 'dependency-unavailable', { messages: { en: 'Busy', id: 'Sibuk' } })] });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    expect(await adapter.load()).toEqual({ ok: true, licence: fromView(VIEW) });
    expect(await adapter.load()).toEqual({ ok: true, licence: null });
    const failed = await adapter.load();
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toEqual(['Busy', 'Sibuk']);
  });

  it('installs with PUT /admin/license, the document as the body and the CSRF token', async () => {
    const f = fakeFetch({ 'PUT /api/v1/admin/license': json(VIEW) });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const doc = { license_id: 'LIC-DEMO-NDT', signature: 'ed25519:x' };
    const res = await createApiAdapter(client).install(doc);
    expect(res.ok).toBe(true);
    expect(f.calls[0]).toMatchObject({ method: 'PUT', path: '/api/v1/admin/license', body: doc });
    expect(f.calls[0].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
  });

  it('keeps LIC-BINDING and signature refusals for the field', async () => {
    const binding = problem(422, 'business-rule', { rule: 'LIC-BINDING', messages: { en: 'The licence is not for this installation or organisation: bound to another organisation.', id: 'Lisensi ini bukan untuk instalasi atau organisasi ini: terikat ke organisasi lain.' } });
    const signature = problem(400, 'validation', { errors: [{ path: 'body', message: 'signature does not verify' }] });
    const f = fakeFetch({ 'PUT /api/v1/admin/license': [binding, signature] });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    const first = await adapter.install({});
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.rule).toBe('LIC-BINDING');
    expect(installError(first.error)).toEqual({ field: first.error.message, detail: null });
    const second = await adapter.install({});
    if (second.ok) throw new Error('expected a refusal');
    expect(installError(second.error).detail).toBe('signature does not verify');
  });
});

describe('Licence sample adapter', () => {
  it('maps the sample licence card', () => {
    const lic = fromSample(D)!;
    expect(lic).toMatchObject({ organization: LICENCE.org, validUntil: '2027-03-31', users: { used: 86, limit: 150 }, systems: { used: 4, limit: 10 }, state: 'valid', sample: true });
    expect(lic.storageAdapters).toEqual(['managed_vault', 'm365', 'google_drive', 'smb']);
    expect(fromSample(null)).toBeNull();
    expect(isoOfDay('1 Sep 2026')).toBe('2026-09-01');
    expect(isoOfDay('soon')).toBeNull();
    expect(usageOf('3 of 4')).toEqual({ used: 3, limit: 4 });
    expect(usageOf('-')).toBeNull();
  });

  it('refuses a document that is not a signed licence and keeps an installed one for the session', async () => {
    const adapter = createSampleAdapter(() => D);
    const bad = await adapter.install({ hello: 1 });
    expect(bad.ok).toBe(false);
    const good = await adapter.install({ license_id: 'LIC-NEW', signature: 'ed25519:x', organization: 'PT Baru', valid_until: '2028-03-31', max_users: 200, frameworks: ['ISO9001'] });
    expect(good.ok).toBe(true);
    const again = await createSampleAdapter(() => D).load();
    expect(again).toMatchObject({ ok: true, licence: { licenseId: 'LIC-NEW', organization: 'PT Baru', users: { used: 86, limit: 200 }, frameworks: ['ISO9001'] } });
  });

  it('the build chooses the adapter: outside an api build the sample one, loaded on first use', async () => {
    expect(import.meta.env.VITE_DATA_SOURCE).not.toBe('api');
    const res = await adapterFor(null, () => D).load();
    expect(res).toMatchObject({ ok: true, licence: { licenseId: 'LIC-SAMPLE' } });
  });

  it('a deferred adapter loads its module once, and again after a failed load', async () => {
    const load = vi.fn<() => Promise<ReturnType<typeof createSampleAdapter>>>()
      .mockRejectedValueOnce(new Error('chunk not loaded'))
      .mockResolvedValue(createSampleAdapter(() => D));
    const adapter = deferredAdapter(load);
    await expect(adapter.load()).rejects.toThrow('chunk not loaded');
    expect(await adapter.load()).toMatchObject({ ok: true, licence: { licenseId: 'LIC-SAMPLE' } });
    expect(await adapter.install({ license_id: 'LIC-NEXT', signature: 'ed25519:x' })).toMatchObject({ ok: true, licence: { licenseId: 'LIC-NEXT' } });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('Licence screen definition', () => {
  it('is in the Administration group with license.read, and offers Install licence with license.manage only', () => {
    expect(screen).toMatchObject({ id: 'license', path: '/admin/license', group: 'admin', scope: 'org', perm: 'license.read' });
    const manage = ctxOf('id');
    const actions = screen.pageActions!(manage);
    expect(actions.map((a) => a.label[1])).toEqual(['Pasang lisensi']);
    actions[0].run(manage);
    expect(manage.go).toHaveBeenCalledWith('license', { params: { install: expect.any(Number) } });
    expect(screen.pageActions!(ctxOf('en', { orgCan: () => false }))).toEqual([]);
  });

  it('the install dialog shows the file and paste fields in the interface language', () => {
    const ctx = ctxOf('id');
    const html = render(<InstallDialog ctx={ctx} open adapter={createSampleAdapter(() => D)} onClose={() => undefined} onInstalled={() => undefined} />, ctx, 'dark');
    for (const pair of [TEXT.installTitle, TEXT.file, TEXT.paste, TEXT.pasteHint, TEXT.install]) expect(html).toContain(pair[1]);
    expect(html).toMatch(/accept="\.json,application\/json"/);
    expect(html).toMatch(/role="dialog"/);
  });
});
