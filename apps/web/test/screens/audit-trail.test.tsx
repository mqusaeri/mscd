// Audit trail (MILESTONE-2 M2-15): routes against the shared table, who may read and verify, the filters of the loaded
// entries, the API adapter over a fake fetch (system and organisation queries with the date range and paging, the CSV
// and the anchors saved as files, the chain results, a 429 kept), the sample trail, and the screen in both languages
// and themes. The list keeps the answers of its newest query only.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { AuditEntry, AuditEntryMeta } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { createApiAdapter, fromEntry } from '../../src/screens/audit-trail/api';
import screen from '../../src/screens/audit-trail/index';
import meta from '../../src/screens/audit-trail/meta.json';
import {
  actionsOf, applyFilters, changeLines, latestOnly, mayReadOrg, mayReadSystem, mayVerify, peopleOfEntries, rangeError,
} from '../../src/screens/audit-trail/model';
import { ROUTES, ROUTE_IDS } from '../../src/screens/audit-trail/routes';
import { createSampleAdapter, sampleEntries } from '../../src/screens/audit-trail/sample';
import AuditTrailScreen, { EntryDrawer, chainLine } from '../../src/screens/audit-trail/Screen';
import { TEXT } from '../../src/screens/audit-trail/text';
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
    client: null, ds: null, screen: 'audit-trail', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}
const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const ENTRY: AuditEntry = {
  seq: 1042, occurredAt: '2026-09-29T03:15:00Z', actor: { handle: 'rina', displayName: 'Rina Kusuma', kind: 'user' }, action: 'applicability.transition',
  entityType: 'applicability_entry', entityId: '0b7e8c2a-1d3f-4e5a-8b6c-7d8e9f0a1b2c', entityCode: 'A.8.13', ms: 'isms',
  before: { implementation_status: 'complete' }, after: { implementation_status: 'implemented' }, edition: 'ISO27001-2022 1.2.0', requestId: 'req-12345678',
};
const META: AuditEntryMeta = { seq: 7, occurredAt: '2026-09-28T01:00:00Z', actor: { handle: null, displayName: null, kind: 'system' }, action: 'freshness.downgrade', entityType: 'evidence', entityId: null };

describe('audit trail routes and definition', () => {
  it('match the shared route table', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.export).permission).toBe('audit_trail.read');
    expect(routeById(ROUTE_IDS.verify).anyOf?.map((p) => p.permission)).toEqual(['audit_trail.read', 'audit_trail.metadata.read']);
  });

  it('is the audit screen of the plan', () => {
    expect(screen).toMatchObject({ id: 'audit-trail', path: '/ms/:ms/audit-trail', group: 'audit', scope: 'ms', perm: ['audit_trail.read', 'audit_trail.metadata.read'] });
    expect(meta.pageActions).toEqual([]);
    // F.6: audit_trail.read belongs to the MS Manager and the external auditor; the Internal Auditor persona has neither.
    expect(screen.roles).toEqual(['manager']);
    expect(meta.roles).toEqual(['manager']);
  });
});

describe('rights and filters', () => {
  it('reads full entries with audit_trail.read, metadata with the organisation permission; the external auditor does not verify', () => {
    const api = (roles: string[], perms: string[], org: string[] = []) => ctxOf('en', {
      mode: 'api', me: { rolesByMs: { isms: roles } } as unknown as HostContext['me'],
      can: (_ms, p) => (Array.isArray(p) ? p : [p]).some((x) => perms.includes(x as string)), orgCan: (p) => (Array.isArray(p) ? p : [p]).some((x) => org.includes(x as string)),
    });
    expect([mayReadSystem(api(['ms_manager'], ['audit_trail.read']), 'isms'), mayVerify(api(['ms_manager'], ['audit_trail.read']), 'isms')]).toEqual([true, true]);
    expect(mayVerify(api(['external_auditor'], ['audit_trail.read']), 'isms')).toBe(false);
    expect([mayReadOrg(api([], [], ['audit_trail.metadata.read'])), mayVerify(api([], [], ['audit_trail.metadata.read']), 'isms')]).toEqual([true, true]);
    expect(mayReadSystem(api(['domain_owner'], ['ms.read']), 'isms')).toBe(false);
  });

  it('filters the loaded entries by action and person and lists both', () => {
    const entries = [fromEntry(ENTRY, 0), fromEntry(META, 1)];
    expect(entries.map((e) => e.full)).toEqual([true, false]);
    expect(actionsOf(entries)).toEqual(['applicability.transition', 'freshness.downgrade']);
    expect(peopleOfEntries(ctxOf('en'), entries)).toEqual([{ value: 'rina', label: 'Rina Kusuma' }, { value: 'kind:system', label: 'System job' }]);
    expect(applyFilters(entries, { action: 'freshness.downgrade', person: '' }).map((e) => e.seq)).toEqual([7]);
    expect(applyFilters(entries, { action: '', person: 'rina' }).map((e) => e.seq)).toEqual([1042]);
    expect(changeLines(ENTRY.before, ENTRY.after)).toEqual(['implementation_status: complete > implemented']);
    expect(rangeError('2026-10-01', '2026-09-01')).toEqual(TEXT.badRange);
    expect(rangeError('', '2026-09-01')).toBeNull();
  });

  it('keeps the answers of the newest query only: a late answer or a Load more of an earlier query is dropped', async () => {
    const latest = latestOnly();
    const later = <T,>(value: T) => {
      let resolve: (v: T) => void = () => undefined;
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, answer: () => resolve(value) };
    };
    latest.start();
    const slow = later('first range');
    const more = later('page 2 of the first range');
    const askedSlow = latest.ask(slow.promise);
    const askedMore = latest.ask(more.promise);
    latest.start();
    const fresh = later('second range');
    const askedFresh = latest.ask(fresh.promise);
    fresh.answer();
    slow.answer();
    more.answer();
    expect(await askedFresh).toBe('second range');
    expect(await askedSlow).toBeNull();
    expect(await askedMore).toBeNull();
    // Leaving the screen starts a generation too, so nothing lands after it.
    const last = later('after leaving');
    const askedLast = latest.ask(last.promise);
    latest.start();
    last.answer();
    expect(await askedLast).toBeNull();
  });

  it('describes each chain result', () => {
    const ctx = ctxOf('en');
    expect(chainLine(ctx, { chain: 'org_ndt.audit_trail', checked: 120, firstBrokenSeq: null, anchorOk: true })).toEqual({ tone: 'ok', text: 'org_ndt.audit_trail: intact, 120 entries checked, the newest anchor matches.' });
    expect(chainLine(ctx, { chain: 'x', checked: 9, firstBrokenSeq: 4, anchorOk: true }).tone).toBe('bad');
    expect(chainLine(ctxOf('id'), { chain: 'x', checked: 9, firstBrokenSeq: null, anchorOk: false }).text).toBe('x: utuh, 9 entri diperiksa, tetapi anchor terbaru tidak cocok.');
  });
});

describe('API adapter', () => {
  function setup(routes: Parameters<typeof fakeFetch>[0]) {
    const f = fakeFetch(routes);
    const client = new ApiClient({ fetch: f.fetch, lang: 'en' });
    return { calls: f.calls, adapter: createApiAdapter(client) };
  }

  it('asks for the system or the organisation with the date range and the page', async () => {
    const { calls, adapter } = setup({ 'GET /api/v1/admin/audit-trail': json({ items: [ENTRY], page: 2, pageSize: 100, total: 101 }) });
    const page = await adapter.list({ ms: 'isms', from: '2026-09-01', to: null }, 2, 100);
    expect(page.ok && page.data.total).toBe(101);
    expect(new URL(calls[0].url, 'http://x').search).toBe('?ms=isms&from=2026-09-01&page=2&pageSize=100');
    await adapter.list({ ms: null, from: null, to: null }, 1, 100);
    expect(new URL(calls[1].url, 'http://x').search).toBe('?page=1&pageSize=100');
  });

  it('saves the CSV and the anchors as files, keeps a 429 and reads the chain results', async () => {
    const created = vi.fn(() => 'blob:x');
    const revoked = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked }));
    const { calls, adapter } = setup({
      'GET /api/v1/admin/audit-trail/export': [{ status: 200, body: 'seq,action\n1,auth.login\n', headers: { 'content-type': 'text/csv' } }, problem(429, 'rate-limited', {}, { 'retry-after': '60' })],
      'GET /api/v1/admin/audit-trail/anchors': { status: 200, body: '{"chain":"a"}\n', headers: { 'content-type': 'application/x-ndjson' } },
      'GET /api/v1/admin/audit-trail/verify': json([{ chain: 'org_ndt.audit_trail', checked: 120, firstBrokenSeq: null, anchorOk: true }]),
    });
    const csv = await adapter.exportCsv('isms');
    expect(csv.ok && csv.data.fileName).toMatch(/^audit-trail-isms-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(new URL(calls[0].url, 'http://x').search).toBe('?ms=isms&format=csv');
    const limited = await adapter.exportCsv('isms');
    expect(limited.ok ? null : [limited.error.status, limited.error.retryAfter]).toEqual([429, 60]);
    const anchors = await adapter.anchors('2026-09-01', null);
    expect(anchors.ok && anchors.data.fileName).toMatch(/\.ndjson$/);
    expect(new URL(calls[2].url, 'http://x').search).toBe('?from=2026-09-01');
    const verify = await adapter.verify();
    expect(verify.ok && verify.data).toEqual([{ chain: 'org_ndt.audit_trail', checked: 120, firstBrokenSeq: null, anchorOk: true }]);
    expect(created).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

describe('sample trail', () => {
  it('is made from the snapshot, newest first, with metadata at organisation level', async () => {
    const entries = sampleEntries(D);
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.map((e) => e.seq)).toEqual([...entries.map((e) => e.seq)].sort((a, b) => b - a));
    const adapter = createSampleAdapter(() => D, () => 'ndt');
    const isms = await adapter.list({ ms: 'isms', from: null, to: null }, 1, 10);
    expect(isms.ok && isms.data.items.every((e) => e.ms === 'isms' && e.full)).toBe(true);
    const org = await adapter.list({ ms: null, from: null, to: null }, 1, 500);
    expect(org.ok && org.data.items.every((e) => !e.full && e.entityCode === null)).toBe(true);
    const none = await adapter.list({ ms: 'isms', from: '2030-01-01', to: null }, 1, 10);
    expect(none.ok && none.data.total).toBe(0);
    const verify = await adapter.verify();
    expect(verify.ok && verify.data.every((r) => r.firstBrokenSeq === null && r.anchorOk)).toBe(true);
  });
});

describe('views', () => {
  for (const lang of ['en', 'id'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the screen and an entry in ${lang}, ${theme}`, () => {
        const ctx = ctxOf(lang);
        const html = render(<AuditTrailScreen ctx={ctx} />, ctx, theme) + render(<EntryDrawer ctx={ctx} entry={fromEntry(ENTRY, 0)} onClose={() => undefined} />, ctx, theme);
        for (const t of [TEXT.tools, TEXT.exportCsv, TEXT.verify, TEXT.anchors, TEXT.fAction, TEXT.fPerson, TEXT.fFrom, TEXT.viewSystem, TEXT.fRecord]) expect(html).toContain(ctx.li(t));
        expect(html).toContain('implementation_status: complete &gt; implemented');
        expect(html).not.toMatch(/[—·]/);
      });
    }
  }

  it('every text pair has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, [en, id]] of Object.entries(TEXT)) {
      expect(en.trim(), key).not.toBe('');
      expect(id, key).not.toBe(en);
      expect(`${en} ${id}`, key).not.toMatch(/[—·]/);
    }
  });
});
