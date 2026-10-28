// Auditor access (MILESTONE-2 M2-15): routes against the shared table, the grant form and states, the API adapter over a
// fake fetch (the grant body with 1 to 30 days, Idempotency-Key and CSRF, field errors kept, revoke, the packs and their
// download links), the sample adapter per organisation, the claim of Audit readiness in both builds, the definition,
// and the screen and grant form in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { AuditorAccessGrantView, EvidencePackView } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { auditorAccess, claims, layerItems } from '../../src/screens/auditor-access/actions';
import { createApiAdapter, fromPack } from '../../src/screens/auditor-access/api';
import { GrantDialog } from '../../src/screens/auditor-access/GrantDialog';
import screen from '../../src/screens/auditor-access/index';
import meta from '../../src/screens/auditor-access/meta.json';
import { emptyGrant, grantBody, grantErrors, grantState, mayGrant } from '../../src/screens/auditor-access/model';
import { ROUTES, ROUTE_IDS } from '../../src/screens/auditor-access/routes';
import { createSampleAdapter, resetSampleAccess } from '../../src/screens/auditor-access/sample';
import { GrantsTab, PacksTab } from '../../src/screens/auditor-access/Screen';
import { formatInstant } from '../../src/screens/auditor-access/shared';
import { grantRequest, openGrant } from '../../src/screens/auditor-access/store';
import { TEXT } from '../../src/screens/auditor-access/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';

const TODAY = SAMPLE.TODAY_S as string;
const D = { ...makeDates(TODAY), ...(await createSampleDataSource().load()), TODAY_S: TODAY } as unknown as ControllerData;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: D.MS[0], org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'auditor-access', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}
const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const GRANT: AuditorAccessGrantView = {
  id: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', email: 'ext.auditor@mscd.test', guestHandle: 'guest-1a2b3c4d', createdBy: 'rina', createdAt: '2026-09-29T06:00:00Z',
  expiresAt: '2026-10-13T06:00:00Z', linkUsedAt: null, lastUsedAt: null, revokedAt: null, revokedBy: null, active: true,
};
const PACK: EvidencePackView = {
  id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', status: 'ready', auditEventId: null, packFolder: '/Compliance/_packs/ISMS/Surveillance 1/', itemCount: 79, exceptionCount: 3,
  manifestUrls: { pdf: '/api/v1/ms/isms/evidence-packs/1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e/download?file=manifest_pdf', csv: '/api/v1/ms/isms/evidence-packs/1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e/download?file=manifest_csv' },
  archiveUrl: '/api/v1/ms/isms/evidence-packs/1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e/download?file=archive', builtAt: '2026-09-29T03:00:00Z', items: [],
};

afterEach(() => {
  resetSampleAccess();
  openGrant(null);
});

describe('auditor access routes and definition', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.grant).permission).toBe('auditor_access.grant');
    expect(routeById(ROUTE_IDS.packs).permission).toBe('ms.read');
  });

  it('is the audit screen of the plan, with Grant access for the MS Manager only', () => {
    expect(screen).toMatchObject({ id: 'auditor-access', group: 'audit', scope: 'ms', perm: ['auditor_access.grant', 'ms.read'] });
    expect(meta.pageActions).toEqual([[TEXT.grantAction[0], TEXT.grantAction[1]]]);
    expect(screen.pageActions!(ctxOf('en')).map((a) => a.label[0])).toEqual(['Grant access']);
    expect(screen.pageActions!(ctxOf('en', { can: (_m, p) => p === 'ms.read' }))).toEqual([]);
    const go = vi.fn();
    screen.pageActions!(ctxOf('en', { go }))[0].run(ctxOf('en', { go }));
    expect(go).toHaveBeenCalledWith('auditor-access', { params: { grant: expect.any(Number) } });
  });
});

describe('grants', () => {
  it('checks the email and 1 to 30 days and builds the body', () => {
    expect(emptyGrant()).toEqual({ email: '', days: '14' });
    expect(grantErrors({ email: 'auditor', days: '31' })).toEqual({ email: TEXT.badEmail, days: TEXT.badDays });
    expect(grantErrors({ email: 'a@b.co', days: '1' })).toEqual({});
    expect(grantBody({ email: ' a@b.co ', days: '30' })).toEqual({ email: 'a@b.co', expiresInDays: 30 });
  });

  it('tells active, revoked and expired grants apart', () => {
    expect(grantState(GRANT)).toBe('active');
    expect(grantState({ ...GRANT, revokedAt: '2026-09-30T00:00:00Z', active: false })).toBe('revoked');
    expect(grantState({ ...GRANT, active: false })).toBe('expired');
    expect(formatInstant('2026-09-29T06:00:00Z', 'en')).toMatch(/29 Sept? 2026/);
    expect(mayGrant(ctxOf('en', { can: () => false }), 'isms')).toBe(false);
  });
});

describe('API adapter', () => {
  function setup(routes: Parameters<typeof fakeFetch>[0]) {
    const f = fakeFetch(routes);
    const client = new ApiClient({ fetch: f.fetch, lang: 'en' });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    return { calls: f.calls, adapter: createApiAdapter(client) };
  }

  it('lists, grants with a length and an Idempotency-Key, keeps field errors and revokes', async () => {
    const { calls, adapter } = setup({
      'GET /api/v1/ms/isms/auditor-access': json([GRANT]),
      'POST /api/v1/ms/isms/auditor-access': [
        json({ ok: true, changed: ['isms'], data: { grantId: GRANT.id, expiresAt: GRANT.expiresAt } }, 201),
        problem(400, 'validation', { errors: [{ path: 'body.expiresInDays', message: 'Too big: expected number to be <=30' }] }),
      ],
      'POST /api/v1/ms/isms/auditor-access/2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f/revoke': problem(409, 'conflict'),
    });
    const list = await adapter.grants('isms');
    expect(list.ok && list.data[0]).toMatchObject({ email: 'ext.auditor@mscd.test', active: true });
    const granted = await adapter.grant('isms', { email: 'lead.auditor@certifier.co.id', expiresInDays: 7 }, 'idem-7');
    expect(granted.ok && granted.data.grantId).toBe(GRANT.id);
    expect(calls[1]).toMatchObject({ method: 'POST', body: { email: 'lead.auditor@certifier.co.id', expiresInDays: 7 } });
    expect(calls[1].headers['idempotency-key']).toBe('idem-7');
    expect(calls[1].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    const refused = await adapter.grant('isms', { email: 'a@b.co', expiresInDays: 31 }, 'idem-8');
    expect(refused.ok ? null : refused.error.errors).toEqual([{ path: 'body.expiresInDays', message: 'Too big: expected number to be <=30' }]);
    const revoked = await adapter.revoke('isms', list.ok ? list.data[0] : (null as never));
    expect(revoked.ok ? null : revoked.error.status).toBe(409);
  });

  it('lists the packs of a page and offers the api download links of a ready pack', async () => {
    const { calls, adapter } = setup({ 'GET /api/v1/ms/isms/evidence-packs': json({ items: [PACK, { ...PACK, id: '2b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', status: 'building', archiveUrl: undefined, builtAt: null }], page: 1, pageSize: 20, total: 2 }) });
    const page = await adapter.packs('isms', 1, 20);
    expect(calls[0].url).toContain('page=1&pageSize=20');
    expect(page.ok && page.data.items.map((p) => [p.status, p.files])).toEqual([['ready', ['manifest_pdf', 'manifest_csv', 'archive']], ['building', []]]);
    const file = await adapter.download('isms', page.ok ? page.data.items[0] : (null as never), 'archive');
    expect(file.ok && file.data.href).toBe(PACK.archiveUrl);
    expect(fromPack({ ...PACK, archiveUrl: undefined }).files).toEqual(['manifest_pdf', 'manifest_csv']);
  });
});

describe('sample adapter', () => {
  it('starts with the ISMS lead auditor grant, grants and revokes per organisation, and makes the CSV manifest', async () => {
    const a = createSampleAdapter(() => D, () => 'ndt');
    const b = createSampleAdapter(() => D, () => 'rmn');
    const first = await a.grants('isms');
    expect(first.ok && first.data.map((g) => g.email)).toEqual(['dwi.hartanto@sertifikasi-nusantara.co.id', 'auditor.stage2@sertifikasi-nusantara.co.id']);
    await a.grant('isms', { email: 'new@certifier.co.id', expiresInDays: 5 }, 'k');
    const after = await a.grants('isms');
    expect(after.ok && after.data[0].email).toBe('new@certifier.co.id');
    expect((await b.grants('isms')).ok && ((await b.grants('isms')) as { ok: true; data: unknown[] }).data).toHaveLength(2);
    expect((await a.revoke('isms', after.ok ? after.data[0] : (null as never))).ok).toBe(true);
    expect((await a.revoke('isms', after.ok ? after.data[0] : (null as never))).ok).toBe(false);
    const packs = await a.packs('isms', 1, 20);
    expect(packs.ok && packs.data.items[0]).toMatchObject({ status: 'ready', itemCount: D.bundles.isms.evs.length, files: ['manifest_csv'] });
    expect((await a.grants('abms')).ok && ((await a.grants('abms')) as { ok: true; data: unknown[] }).data).toEqual([]);
  });
});

describe('claim of Audit readiness', () => {
  it('keeps the Milestone 1 toast in the sample build and opens the form for the MS Manager in api builds', () => {
    const toast = vi.fn();
    auditorAccess(ctxOf('en', { toast }), { ms: 'isms' });
    expect(toast).toHaveBeenCalledWith('Guest access link created, valid 14 days');
    expect(grantRequest()).toBeNull();
    const refused = vi.fn();
    auditorAccess(ctxOf('en', { mode: 'api', toast: refused, can: () => false }), { ms: 'isms' });
    expect(refused).toHaveBeenCalledWith(TEXT.noGrantRight[0]);
    auditorAccess(ctxOf('en', { mode: 'api' }), { ms: 'isms' });
    expect(grantRequest()).toMatchObject({ ms: 'isms' });
    expect(claims?.['audit.auditorAccess']).toBeTypeOf('function');
    expect(layerItems?.map((i) => i.id)).toEqual(['auditor-access.grant']);
  });
});

describe('views', () => {
  for (const lang of ['en', 'id'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the tabs and the grant form in ${lang}, ${theme}`, () => {
        const ctx = ctxOf(lang);
        const html = [
          render(<GrantsTab ctx={ctx} ms="isms" />, ctx, theme),
          render(<PacksTab ctx={ctx} ms="isms" />, ctx, theme),
          render(<GrantDialog ctx={ctx} ms="isms" onClose={() => undefined} onGranted={() => undefined} />, ctx, theme),
        ].join('');
        for (const t of [TEXT.tabGrants, TEXT.tabPacks, TEXT.grantTitle, TEXT.fEmail, TEXT.fDays, TEXT.fDaysHint]) expect(html).toContain(ctx.li(t).replace(/'/g, '&#x27;'));
        expect(html).toContain('value="14"');
        expect(html).not.toMatch(/[—·]/);
      });
    }
  }

  it('every text pair has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    const same = new Set(['colStatus', 'colPackStatus']);
    for (const [key, [en, id]] of Object.entries(TEXT)) {
      expect(en.trim(), key).not.toBe('');
      if (!same.has(key)) expect(id, key).not.toBe(en);
      expect(`${en} ${id}`, key).not.toMatch(/[—·]/);
    }
  });
});
