// Policies to confirm (MILESTONE-3 M3-05, D.7 "Confirming"): routes against the shared table, the model (open and done
// lists, the checks before "Confirm"), the API adapter over a fake fetch (the list, open, confirm, ACK-OPEN-FIRST), the
// sample adapter on the store shared with "Policy read confirmations", the store and the banner of the host layer, the
// sidebar entry with its badge and the page action of My Tasks, and the views in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/my-confirmations/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/my-confirmations/routes';
import { createApiAdapter, fromItem } from '../../src/screens/my-confirmations/api';
import { ACK_OPEN_FIRST, createSampleAdapter } from '../../src/screens/my-confirmations/sample';
import { adapterFor, deferredAdapter } from '../../src/screens/my-confirmations/adapter';
import { confirmBlock, doneOf, openOf } from '../../src/screens/my-confirmations/model';
import type { Confirmation, ConfirmationsAdapter } from '../../src/screens/my-confirmations/model';
import {
  confirmationsState, invalidateConfirmations, keyOf, loadConfirmations, openConfirmationCount, putOffBanner, resetConfirmations,
} from '../../src/screens/my-confirmations/store';
import { ConfirmationBanner } from '../../src/screens/my-confirmations/Banner';
import MyConfirmationsScreen, { DoneTable, OpenItem } from '../../src/screens/my-confirmations/Screen';
import { extraPageActions, hasOpenConfirmations, layerItems } from '../../src/screens/my-confirmations/actions';
import { hostExtraActions, hostNav } from '../../src/screens/host';
import { TEXT } from '../../src/screens/my-confirmations/text';
import { createSampleAdapter as createRegisterAdapter } from '../../src/screens/acknowledgements/sample';
import { resetSampleAcknowledgements } from '../../src/screens/acknowledgements/sample-store';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { fakeFetch, json, problem } from '../auth/helpers';

const snapshot = await createSampleDataSource().load();
const D = { ...makeDates(SAMPLE.TODAY_S), ...snapshot, TODAY_S: SAMPLE.TODAY_S } as unknown as ControllerData;
const isms = D.MS.find((m) => m.id === 'isms')!;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: isms, org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'chain', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

/** Text as React writes it into markup. */
const html = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const ITEM = {
  id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', requestId: '9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b', ms: 'isms',
  document: { code: 'POL-01', title: 'Information Security Policy' }, versionLabel: '4.0', status: 'pending', dueOn: '2026-10-13', openedAt: null,
  confirmedAt: null, overdue: false,
} as const;
const OPEN: Confirmation = fromItem(ITEM as never);
const OVERDUE: Confirmation = { ...OPEN, id: 'o', document: { code: 'POL-14', title: 'Cloud Services Security Policy' }, dueOn: '2026-09-20', overdue: true };
const DONE: Confirmation = { ...OPEN, id: 'd', status: 'confirmed', openedAt: '2026-09-30T03:00:00Z', confirmedAt: '2026-09-30T03:05:00Z' };

afterEach(() => {
  resetSampleAcknowledgements();
  resetConfirmations();
});

describe('my confirmation routes', () => {
  it('match the shared route table and need an active session only', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
      expect(route.permission).toBeUndefined();
      expect(route.auth).toBe('session');
    }
  });
});

describe('my confirmation model', () => {
  it('orders the open ones overdue first and the done ones newest first; Confirm needs the open and the statement', () => {
    expect(openOf([OPEN, DONE, OVERDUE]).map((c) => c.id)).toEqual(['o', OPEN.id]);
    expect(doneOf([OPEN, DONE, { ...DONE, id: 'e', status: 'excused', confirmedAt: null }]).map((c) => c.id)).toEqual(['d', 'e']);
    expect(confirmBlock(OPEN, false, false)).toEqual(TEXT.openFirst);
    expect(confirmBlock(OPEN, true, false)).toEqual(TEXT.tickFirst);
    expect(confirmBlock(OPEN, true, true)).toBeNull();
    expect(confirmBlock({ openedAt: '2026-09-30T03:00:00Z' }, false, true)).toBeNull();
  });
});

describe('my confirmation API adapter', () => {
  it('reads the list, opens a version and confirms it; keeps the ACK-OPEN-FIRST refusal', async () => {
    const early = problem(422, 'business-rule', { rule: 'ACK-OPEN-FIRST', messageKey: 'rule.ACK-OPEN-FIRST', messages: { en: 'Open POL-01 first.', id: 'Buka POL-01 terlebih dahulu.' } });
    const f = fakeFetch({
      'GET /api/v1/me/acknowledgements': json([ITEM]),
      [`POST /api/v1/me/acknowledgements/${ITEM.id}/open`]: json({ url: '/api/v1/storage/objects/x/content?ms=isms&inline=true', expiresAt: '2026-09-29T03:05:00Z' }),
      [`POST /api/v1/me/acknowledgements/${ITEM.id}/confirm`]: [early, json({ ok: true, changed: ['isms'], message: ['You confirmed POL-01 version 4.0', 'Anda telah mengonfirmasi POL-01 versi 4.0'] })],
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client);
    expect(await adapter.mine()).toEqual({ ok: true, data: [OPEN] });
    expect(await adapter.confirm(ITEM.id)).toMatchObject({ ok: false, error: { status: 422, rule: 'ACK-OPEN-FIRST' } });
    expect(await adapter.open(ITEM.id)).toEqual({ ok: true, data: { url: '/api/v1/storage/objects/x/content?ms=isms&inline=true' } });
    expect(await adapter.confirm(ITEM.id)).toEqual({ ok: true, data: { message: ['You confirmed POL-01 version 4.0', 'Anda telah mengonfirmasi POL-01 versi 4.0'], changed: ['isms'] } });
    expect(f.calls.at(-1)).toMatchObject({ method: 'POST', headers: { 'x-csrf-token': 'csrf-token-0123456789abcdef' } });
  });
});

describe('my confirmation sample adapter', () => {
  const scope = (me: string) => ({ getD: () => D, org: () => 'ndt', me: () => me });

  it('lists the persona\'s confirmations (done at the start), and a new request asks the persona to confirm', async () => {
    const mine = createSampleAdapter(scope('rina'));
    const start = await mine.mine();
    if (!start.ok) throw new Error('mine failed');
    expect(openOf(start.data)).toEqual([]);
    expect(doneOf(start.data).map((c) => c.document.code)).toEqual(expect.arrayContaining(['POL-01']));
    const register = createRegisterAdapter({ getD: () => D, org: () => 'ndt' });
    expect(await register.ask('isms', { documentId: 'POL-14', scope: 'roles', roles: ['ms_manager'], dueDays: 7 })).toMatchObject({ ok: true });
    const after = await mine.mine();
    const open = after.ok ? openOf(after.data) : [];
    expect(open.map((c) => [c.document.code, c.versionLabel, c.dueOn])).toEqual([['POL-14', '1.0', '2026-10-06']]);
    const id = open[0]!.id;
    expect(await mine.confirm(id)).toEqual({
      ok: false,
      error: { status: 422, slug: 'business-rule', rule: 'ACK-OPEN-FIRST', messageKey: 'rule.ACK-OPEN-FIRST', message: [ACK_OPEN_FIRST[0].replace('{document}', 'POL-14'), ACK_OPEN_FIRST[1].replace('{document}', 'POL-14')] },
    });
    expect(await mine.open(id)).toEqual({ ok: true, data: { url: null } });
    expect(await mine.confirm(id)).toMatchObject({ ok: true, data: { message: ['You confirmed POL-14 version 1.0', 'Anda telah mengonfirmasi POL-14 versi 1.0'] } });
    expect(await mine.confirm(id)).toMatchObject({ ok: false, error: { messageKey: 'acknowledgements.confirmed' } });
    // Another persona's row is not theirs.
    expect(await createSampleAdapter(scope('bagus')).open(id)).toMatchObject({ ok: false, error: { status: 404 } });
  });

  it('the build chooses the sample adapter; a deferred adapter retries a failed module load', async () => {
    expect(adapterFor(ctxOf('en')).sample).toBe(true);
    expect(await adapterFor(ctxOf('en')).mine()).toMatchObject({ ok: true });
    const load = vi.fn<() => Promise<ConfirmationsAdapter>>().mockRejectedValueOnce(new Error('chunk')).mockResolvedValue(createSampleAdapter(scope('rina')));
    const adapter = deferredAdapter(load);
    expect(await adapter.mine()).toMatchObject({ ok: false, error: { status: 0 } });
    expect(await adapter.mine()).toMatchObject({ ok: true });
  });
});

describe('the store and the banner', () => {
  it('loads the list of the session person and shows the banner until it is put off', async () => {
    const ctx = ctxOf('en');
    expect(keyOf(ctx)).toBe('rina:ndt');
    await createRegisterAdapter({ getD: () => D, org: () => 'ndt' }).ask('isms', { documentId: 'POL-14', scope: 'roles', roles: ['ms_manager'], dueDays: 7 });
    await loadConfirmations(ctx);
    expect(confirmationsState()).toMatchObject({ key: 'rina:ndt', loading: false, error: null });
    expect(confirmationsState().items!.filter((c) => c.status === 'pending')).toHaveLength(1);
    const banner = render(<ConfirmationBanner ctx={ctx} />, ctx);
    expect(banner).toContain('data-confirmation-banner="1"');
    expect(banner).toContain(TEXT.bannerOne[0]);
    expect(banner).toContain(TEXT.bannerOpen[0]);
    // Not on the screen itself.
    expect(render(<ConfirmationBanner ctx={ctxOf('en', { screen: 'my-confirmations' })} />, ctx)).not.toContain('data-confirmation-banner');
    putOffBanner();
    expect(render(<ConfirmationBanner ctx={ctx} />, ctx)).not.toContain('data-confirmation-banner');
    const version = confirmationsState().version;
    invalidateConfirmations();
    expect(confirmationsState().version).toBe(version + 1);
    // Another person sees nothing until their own list loads.
    expect(render(<ConfirmationBanner ctx={ctxOf('en', { person: { handle: 'bagus', name: 'Bagus Prasetyo', jobTitle: '-' } })} />, ctx)).not.toContain('data-confirmation-banner');
    expect(layerItems![0]).toMatchObject({ id: 'my-confirmations.banner' });
    expect(layerItems![0]!.visible!(ctx)).toBe(true);
    expect(layerItems![0]!.visible!(ctxOf('en', { org: null }))).toBe(false);
  });

  for (const lang of ['en', 'id'] as Lang[]) {
    it(`the banner of several confirmations in ${lang}`, async () => {
      const register = createRegisterAdapter({ getD: () => D, org: () => 'ndt' });
      await register.ask('isms', { documentId: 'POL-14', scope: 'roles', roles: ['ms_manager'], dueDays: 7 });
      await register.ask('isms', { documentId: 'STD-05', scope: 'roles', roles: ['ms_manager'], dueDays: 7 });
      const ctx = ctxOf(lang);
      await loadConfirmations(ctx);
      const banner = render(<ConfirmationBanner ctx={ctx} />, ctx);
      expect(banner).toContain(html(ctx.fill(TEXT.bannerMany, { n: 2 })));
      expect(banner).not.toMatch(/[—·]/);
    });
  }
});

describe('my confirmation views', () => {
  const adapter = createSampleAdapter({ getD: () => D, org: () => 'ndt', me: () => 'rina' });
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`an open confirmation and the done ones in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf(lang);
        const t = (p: readonly [string, string]) => html(p[lang === 'id' ? 1 : 0]);
        const item = render(<OpenItem ctx={ctx} adapter={adapter} item={OPEN} onChanged={() => undefined} />, ctx, theme);
        for (const p of [TEXT.openDocument, TEXT.statement, TEXT.confirm, TEXT.notOpened, TEXT.openFirst]) expect(item, p[0]).toContain(t(p));
        expect(item).toContain(html(ctx.fill(TEXT.dueOn, { date: D.fmt('2026-10-13', lang) })));
        expect(item).toMatch(/<input type="checkbox" name="statement-[^"]+" disabled=""/);
        expect(item).toContain('data-confirmation="POL-01"');
        const late = render(<OpenItem ctx={ctx} adapter={adapter} item={{ ...OVERDUE, openedAt: '2026-09-25T03:00:00Z' }} onChanged={() => undefined} />, ctx, theme);
        expect(late).toContain('data-overdue="true"');
        expect(late).toContain(t(TEXT.openAgain));
        expect(late).toContain(t(TEXT.tickFirst));
        const done = render(<DoneTable ctx={ctx} items={[DONE, { ...DONE, id: 'e', status: 'excused', confirmedAt: null }]} />, ctx, theme);
        for (const p of [TEXT.colDocument, TEXT.colVersion, TEXT.colResult, TEXT.excused]) expect(done, p[0]).toContain(t(p));
        expect(done).toContain(html(ctx.fill(TEXT.confirmedOn, { date: D.fmt('2026-09-30', lang) })));
        const body = render(<MyConfirmationsScreen ctx={ctx} />, ctx, theme);
        expect(body).toContain('data-confirmations=""');
        expect(body).toContain(t(TEXT.intro));
        expect(item + late + done + body).not.toMatch(/[—·]/);
      });
    }
  }

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries(TEXT)) {
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(/[—·]/);
    }
  });

  it('is in the My Tasks group of the sidebar for every business role (ms.read), after My Tasks', () => {
    expect(screen).toMatchObject({ id: 'my-confirmations', path: '/my-confirmations', group: 'tasks', order: 20, scope: 'ms', perm: 'ms.read', roles: ['manager', 'owner', 'auditor', 'top'] });
    expect(screen.nav).not.toBe(false);
    expect(screen.pageActions).toBeUndefined();
  });
});

describe('the sidebar entry and the link from My Tasks (C.2, C.5)', () => {
  const tasksGroup = [{ id: 'tasks' as const, label: 'My Tasks', items: [{ id: 'mytasks', label: 'My Tasks' }] }];

  it('counts the open confirmations of the session person as the badge of the entry after My Tasks', async () => {
    const ctx = ctxOf('en', { role: 'owner' });
    expect(openConfirmationCount(ctx)).toBe(0);
    expect(screen.count!(ctx)).toBe(0);
    const before = hostNav(tasksGroup, ctx, 'owner').find((g) => g.id === 'tasks')!;
    expect(before.items.map((i) => [i.id, i.n ?? 0])).toEqual([['mytasks', 0], ['my-confirmations', 0]]);
    const register = createRegisterAdapter({ getD: () => D, org: () => 'ndt' });
    await register.ask('isms', { documentId: 'POL-14', scope: 'roles', roles: ['ms_manager'], dueDays: 7 });
    await register.ask('isms', { documentId: 'STD-05', scope: 'roles', roles: ['ms_manager'], dueDays: 7 });
    await loadConfirmations(ctx);
    expect(openConfirmationCount(ctx)).toBe(2);
    const after = hostNav(tasksGroup, ctx, 'owner').find((g) => g.id === 'tasks')!;
    expect(after.items.find((i) => i.id === 'my-confirmations')).toMatchObject({ label: 'Policies to confirm', host: true, n: 2 });
    // Another person or another organisation counts nothing until their own list loads.
    expect(openConfirmationCount(ctxOf('en', { person: { handle: 'bagus', name: 'Bagus Prasetyo', jobTitle: '-' } }))).toBe(0);
    expect(openConfirmationCount(ctxOf('en', { org: { id: 'tst' } as never }))).toBe(0);
    // Putting the banner off keeps the badge.
    putOffBanner();
    expect(openConfirmationCount(ctx)).toBe(2);
    // API mode: the entry follows ms.read in the selected system.
    const api = ctxOf('en', { mode: 'api', can: (_ms: string, perm: unknown) => perm === 'ms.read' });
    expect(hostNav([], api, 'owner').find((g) => g.id === 'tasks')!.items.map((i) => i.id)).toEqual(['my-confirmations']);
    const none = ctxOf('en', { mode: 'api', can: () => false });
    expect(hostNav([], none, 'owner').some((g) => g.items.some((i) => i.id === 'my-confirmations'))).toBe(false);
  });

  it('adds "Policies to confirm" to My Tasks while confirmations are open, which opens the screen', async () => {
    expect(extraPageActions).toHaveLength(1);
    expect(extraPageActions[0]).toMatchObject({ screen: 'mytasks', id: 'mytasks.policiesToConfirm', label: TEXT.title });
    const ctx = ctxOf('en', { screen: 'mytasks' });
    expect(hasOpenConfirmations(ctx)).toBe(false);
    expect(hostExtraActions('mytasks', ctx)).toEqual([]);
    await createRegisterAdapter({ getD: () => D, org: () => 'ndt' }).ask('isms', { documentId: 'POL-14', scope: 'roles', roles: ['ms_manager'], dueDays: 7 });
    await loadConfirmations(ctx);
    expect(hasOpenConfirmations(ctx)).toBe(true);
    const [action] = hostExtraActions('mytasks', ctx);
    expect(action).toMatchObject({ label: 'Policies to confirm', primary: true });
    action!.go();
    expect(ctx.go).toHaveBeenCalledWith('my-confirmations');
    expect(hostExtraActions('mytasks', ctxOf('id', { screen: 'mytasks' }))[0]!.label).toBe(TEXT.title[1]);
    expect(hasOpenConfirmations(ctxOf('en', { msObj: null }))).toBe(false);
    expect(hostExtraActions('docs', ctx).map((a) => a.label)).not.toContain('Policies to confirm');
  });
});
