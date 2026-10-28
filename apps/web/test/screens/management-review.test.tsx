// Management review (MILESTONE-2 M2-14): routes against the shared table, input completeness, the plan and edit forms
// (the path system first, the PATCH of what changed), the API adapter over a fake fetch (If-Match on the PATCH, the input
// of the path system, the moves with the BR-13 and BR-14 refusals kept), the sample adapter and the views in both
// languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { ManagementReviewItem } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import screen from '../../src/screens/management-review/index';
import meta from '../../src/screens/management-review/meta.json';
import { adapterFor } from '../../src/screens/management-review/adapter';
import { createApiAdapter, fromReviewItem } from '../../src/screens/management-review/api';
import { completeness, createBody, formOf, inputsBySystem, mayManage, reviewErrors, reviewPatch } from '../../src/screens/management-review/model';
import type { ReviewAdapter, ReviewModel } from '../../src/screens/management-review/model';
import { ReviewDrawer, ReviewFormDialog } from '../../src/screens/management-review/ReviewDrawer';
import { ROUTES, ROUTE_IDS } from '../../src/screens/management-review/routes';
import { INPUT_DEFS, createSampleAdapter, resetSampleReviews } from '../../src/screens/management-review/sample';
import { ReviewsTable } from '../../src/screens/management-review/Screen';
import { TEXT } from '../../src/screens/management-review/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';

const snapshot = await createSampleDataSource().load();
const D = { ...makeDates(SAMPLE.TODAY_S), ...snapshot, TODAY_S: SAMPLE.TODAY_S } as unknown as ControllerData;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: D.MS[0], org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'management-review', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const ITEM: ManagementReviewItem = {
  ref: { module: 'audit', entityType: 'management_review', id: '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d', code: 'MR-2026', etag: 'W/"1790000000000"' }, code: 'MR-2026',
  title: 'Management review 2026', owner: 'hendra', plannedAt: '2026-10-28', heldAt: null, status: 'planned', decisionsRecorded: false, decisionsText: null, linkedMs: ['isms', 'qms'],
  inputs: [
    { defCode: 'MR-01', title: 'Status of actions', mandatory: true, ms: 'isms', complete: true, content: 'All closed' },
    { defCode: 'MR-02', title: 'Changes', mandatory: true, ms: 'isms', complete: false, content: null },
    { defCode: 'MR-01', title: 'Status of actions', mandatory: true, ms: 'qms', complete: false, content: null },
    { defCode: 'MR-99', title: 'Optional', mandatory: false, ms: 'qms', complete: true, content: 'x' },
  ],
};

afterEach(() => resetSampleReviews());

describe('management review routes', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.list).permission).toBe('ms.read');
    expect(routeById(ROUTE_IDS.create).permission).toBe('management_review.manage');
    expect(routeById(ROUTE_IDS.update).ifMatch).toBe(true);
  });
});

describe('completeness and forms', () => {
  it('counts the complete mandatory inputs, of all linked systems or of one, and groups them with the open system first', () => {
    const review = fromReviewItem(ITEM);
    expect(completeness(review)).toEqual({ done: 1, total: 3 });
    expect(completeness(review, 'qms')).toEqual({ done: 0, total: 1 });
    expect(inputsBySystem(review, 'qms').map((g) => [g.ms, g.inputs.length])).toEqual([['qms', 2], ['isms', 2]]);
  });

  it('checks the plan form and puts the open system first in the linked systems', () => {
    const form = { code: 'MR-2027', title: ' Review 2027 ', plannedAt: '2027-10-27', owner: 'hendra', linked: ['qms', 'isms'] };
    expect(reviewErrors(form, ['MR-2026'], true)).toEqual({});
    expect(createBody(form, 'isms')).toEqual({ code: 'MR-2027', title: 'Review 2027', plannedAt: '2027-10-27', ownerHandle: 'hendra', linkedMs: ['isms', 'qms'] });
    expect(reviewErrors({ code: 'MR-2026', title: '', plannedAt: '', owner: '', linked: [] }, ['MR-2026'], true))
      .toEqual({ code: TEXT.codeTaken, title: TEXT.required, plannedAt: TEXT.required, owner: TEXT.required });
    expect(reviewErrors({ code: '', title: 't', plannedAt: '2027-01-01', owner: 'hendra', linked: [] }, [], false)).toEqual({});
  });

  it('the edit patch holds only what changed', () => {
    const review = fromReviewItem(ITEM);
    expect(review.etag).toBe(ITEM.ref.etag);
    expect(reviewPatch(formOf(review), review, 'isms')).toBeNull();
    expect(reviewPatch({ ...formOf(review), plannedAt: '2026-11-03', linked: ['isms'] }, review, 'isms')).toEqual({ plannedAt: '2026-11-03', linkedMs: ['isms'] });
    expect(reviewPatch({ ...formOf(review), title: 'Joint review', owner: 'rina' }, review, 'isms')).toEqual({ title: 'Joint review', ownerHandle: 'rina' });
  });

  it('MS Managers and Programme Owners manage reviews', () => {
    expect(mayManage(ctxOf('en'), 'isms')).toBe(true);
    expect(mayManage(ctxOf('en', { can: () => false }), 'isms')).toBe(false);
    expect(mayManage(ctxOf('en'), null)).toBe(false);
  });
});

describe('the API adapter', () => {
  it('lists, plans, changes with If-Match, records an input and keeps the BR-13 and BR-14 refusals', async () => {
    const id = ITEM.ref.id;
    const f = fakeFetch({
      'GET /api/v1/ms/isms/management-reviews': json([ITEM]),
      'POST /api/v1/ms/isms/management-reviews': json({ ok: true, changed: ['isms'], ref: ITEM.ref, count: 10 }, 201),
      [`PATCH /api/v1/ms/isms/management-reviews/${id}`]: json({ ok: true, changed: ['isms'], ref: ITEM.ref }),
      [`PUT /api/v1/ms/isms/management-reviews/${id}/inputs/MR-02`]: json({ ok: true, changed: ['isms'] }),
      [`POST /api/v1/ms/isms/management-reviews/${id}/transitions`]: [
        problem(422, 'business-rule', { rule: 'BR-13', messages: { en: 'The management review cannot be closed while mandatory inputs are empty for a linked system.', id: 'x' } }),
        problem(422, 'business-rule', { rule: 'BR-14', messages: { en: 'The management review cannot be closed without recorded decisions.', id: 'y' } }),
        json({ ok: true, changed: ['isms', 'qms'] }),
      ],
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client);
    const list = await adapter.list('isms');
    const review = list.ok ? list.data[0] : (null as never);
    expect(review).toMatchObject({ code: 'MR-2026', linkedMs: ['isms', 'qms'] });
    await adapter.create('isms', { code: 'MR-2027', title: 't', plannedAt: '2027-10-27', ownerHandle: 'hendra', linkedMs: ['isms'] }, 'key-1');
    expect(f.calls[1].headers['idempotency-key']).toBe('key-1');
    expect(f.calls[1].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    await adapter.update('isms', review, { plannedAt: '2026-11-03' });
    expect(f.calls[2]).toMatchObject({ method: 'PATCH', body: { plannedAt: '2026-11-03' } });
    expect(f.calls[2].headers['if-match']).toBe(ITEM.ref.etag);
    await adapter.putInput('isms', review, 'MR-02', 'Two new legal requirements');
    expect(f.calls[3]).toMatchObject({ method: 'PUT', body: { content: 'Two new legal requirements' } });
    const br13 = await adapter.move('isms', review, { to: 'closed', decisionsText: 'Budget approved' });
    expect(!br13.ok && br13.error.rule).toBe('BR-13');
    const br14 = await adapter.move('isms', review, { to: 'closed' });
    expect(!br14.ok && br14.error.rule).toBe('BR-14');
    expect(f.calls[5].body).toEqual({ to: 'closed' });
    const closed = await adapter.move('isms', review, { to: 'closed', decisionsText: 'Budget approved' });
    expect(closed.ok && closed.data.changed).toEqual(['isms', 'qms']);
  });
});

describe('the sample adapter', () => {
  const scope = (org = 'ndt') => ({ getD: () => D, org: () => org });

  it('seeds the reviews of the sample systems with the mandatory inputs of their standards', async () => {
    const adapter = createSampleAdapter(scope());
    const isms = (await adapter.list('isms')) as { ok: true; data: ReviewModel[] };
    expect(isms.data.map((r) => [r.code, r.status, completeness(r).done, completeness(r).total])).toEqual([['MR-2026', 'planned', 8, 10], ['MR-2025', 'closed', 10, 10]]);
    const qms = (await adapter.list('qms')) as { ok: true; data: ReviewModel[] };
    expect(completeness(qms.data[0])).toEqual({ done: 0, total: INPUT_DEFS.qms.length });
    expect(((await adapter.list('abms')) as { data: unknown[] }).data).toEqual([]);
  });

  it('holds and closes a review only with every mandatory input and the decisions (BR-13, BR-14)', async () => {
    const adapter = createSampleAdapter(scope());
    const get = async () => ((await adapter.list('isms')) as { data: ReviewModel[] }).data.find((r) => r.code === 'MR-2026')!;
    expect(await adapter.move('isms', await get(), { to: 'closed', decisionsText: 'x' })).toMatchObject({ ok: false, error: { slug: 'transition-not-allowed' } });
    expect(await adapter.move('isms', await get(), { to: 'held', heldAt: '2026-10-28' })).toMatchObject({ ok: true });
    expect(await adapter.move('isms', await get(), { to: 'closed', decisionsText: 'x' })).toMatchObject({ ok: false, error: { rule: 'BR-13' } });
    for (const code of ['MR-04', 'MR-09']) expect(await adapter.putInput('isms', await get(), code, 'Prepared')).toMatchObject({ ok: true });
    expect(await adapter.putInput('isms', await get(), 'MR-99', 'x')).toMatchObject({ ok: false, error: { status: 404 } });
    expect(await adapter.move('isms', await get(), { to: 'closed' })).toMatchObject({ ok: false, error: { rule: 'BR-14' } });
    expect(await adapter.move('isms', await get(), { to: 'closed', decisionsText: 'Budget approved' })).toMatchObject({ ok: true });
    expect(await adapter.update('isms', await get(), { title: 'x' })).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await adapter.putInput('isms', await get(), 'MR-01', 'x')).toMatchObject({ ok: false, error: { status: 409 } });
  });

  it('plans a joint review, refuses a taken code, and keeps each organisation apart', async () => {
    const adapter = createSampleAdapter(scope());
    expect(await adapter.create('isms', { code: 'MR-2026', title: 't', plannedAt: '2027-01-01', ownerHandle: 'hendra', linkedMs: ['isms'] }, 'k')).toMatchObject({ ok: false, error: { status: 409 } });
    const made = await adapter.create('isms', { code: 'MR-2027', title: 'Joint review 2027', plannedAt: '2027-10-27', ownerHandle: 'hendra', linkedMs: ['isms', 'qms'] }, 'k');
    expect(made).toMatchObject({ ok: true, data: { changed: ['isms', 'qms'], count: INPUT_DEFS.isms.length + INPUT_DEFS.qms.length } });
    const fromQms = ((await adapter.list('qms')) as { data: ReviewModel[] }).data.map((r) => r.code);
    expect(fromQms).toContain('MR-2027');
    const other = createSampleAdapter(scope('rmn'));
    expect(((await other.list('isms')) as { data: ReviewModel[] }).data.map((r) => r.code)).toEqual(['MR-2026', 'MR-2025']);
  });

  it('the build chooses the deferred sample adapter outside api builds', async () => {
    const adapter = adapterFor(() => ctxOf('en'));
    expect(adapter.sample).toBe(true);
    expect(((await adapter.list('isms')) as { data: unknown[] }).data).toHaveLength(2);
  });
});

describe('the screen and its views', () => {
  it('has a definition that matches its meta.json and the Plan review page action', () => {
    expect([meta.id, meta.group, meta.order]).toEqual([screen.id, screen.group, screen.order]);
    const ctx = ctxOf('en');
    const actions = screen.pageActions!(ctx);
    expect(actions.map((a) => a.label)).toEqual([TEXT.plan]);
    actions[0].run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('management-review', { params: { plan: expect.any(Number) } });
    expect(screen.pageActions!(ctxOf('en', { can: () => false }))).toEqual([]);
  });

  it('renders the list, the drawer and the plan dialog in both languages and themes', async () => {
    const adapter = createSampleAdapter({ getD: () => D, org: () => 'ndt' }) as ReviewAdapter;
    const rows = ((await adapter.list('isms')) as { data: ReviewModel[] }).data;
    for (const lang of ['en', 'id'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = ctxOf(lang, { theme });
        const html = render(
          <>
            <ReviewsTable ctx={ctx} rows={rows} onOpen={() => undefined} />
            <ReviewDrawer ctx={ctx} ms="isms" review={rows[0]} adapter={adapter} codes={rows.map((r) => r.code)} onClose={() => undefined} onChanged={() => undefined} />
            <ReviewFormDialog ctx={ctx} ms="isms" open adapter={adapter} review={null} codes={rows.map((r) => r.code)} onClose={() => undefined} onSaved={() => undefined} />
          </>,
          ctx,
          theme,
        );
        const t = (pair: readonly [string, string]) => pair[lang === 'id' ? 1 : 0];
        for (const text of [TEXT.colInputs, TEXT.inputs, TEXT.markHeld, TEXT.recordInput, TEXT.editInput, TEXT.missing, TEXT.planTitle, TEXT.fSystems]) {
          expect(html, `${lang} ${theme}: ${t(text)}`).toContain(t(text));
        }
        expect(html).toContain(ctx.fill(TEXT.inputsDone, { done: 8, total: 10 }));
        expect(html).toContain('MR-2026-01');
        expect(html).not.toMatch(/—|·/);
      }
    }
  });
});
