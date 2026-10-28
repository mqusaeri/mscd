// Handover (MILESTONE-2 M2-10): routes against the shared table, the model (kinds, people, HoldingsReassign bodies
// and the checks before a move), the API adapter over a fake fetch (holdings, reassign with the BR-22 confirmation and
// the warnings per record), the sample adapter, and the views in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/handover/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/handover/routes';
import { createApiAdapter, fromHoldings, outcomeOf } from '../../src/screens/handover/api';
import { createSampleAdapter, resetSampleHandover, sampleHoldings } from '../../src/screens/handover/sample';
import { adapterFor, deferredAdapter, settled } from '../../src/screens/handover/adapter';
import { KIND_ORDER, formerPeople, handleOf, kindLabel, kindRows, moveBlock, nameOf, peopleOf, reassignBody, snapshotHolders, sortedItems } from '../../src/screens/handover/model';
import type { HandoverAdapter } from '../../src/screens/handover/model';
import HandoverScreen, { HandoverBody, HolderPicker, HoldingsView, TypedHolder } from '../../src/screens/handover/Screen';
import { TEXT } from '../../src/screens/handover/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData, DataSource } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { fakeFetch, json, problem } from '../auth/helpers';

const snapshot = await createSampleDataSource().load();
const D = { ...makeDates(SAMPLE.TODAY_S), ...snapshot, TODAY_S: SAMPLE.TODAY_S } as unknown as ControllerData;
const isms = D.MS.find((m) => m.id === 'isms')!;
/** The snapshot after bagus was disabled (or lost his last role): the api lists only active members with a role. */
const LEFT = { ...D, PEOPLE: Object.fromEntries(Object.entries(D.PEOPLE).filter(([h]) => h !== 'bagus')) } as ControllerData;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: isms, org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'handover', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const HOLDINGS = {
  handle: 'bagus', ms: 'isms',
  items: [
    { kind: 'risk' as const, ref: { module: 'audit', entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', code: 'R-014' }, code: 'R-014', title: 'Privileged credential misuse', dueAt: '2026-11-20' },
    { kind: 'evidence' as const, ref: { module: 'implementation', entityType: 'evidence', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6c', code: 'EV-0100' }, code: 'EV-0100', title: 'Backup log', dueAt: null },
  ],
  counts: { risk: 1, evidence: 1 },
};

afterEach(() => resetSampleHandover());

describe('handover routes', () => {
  it('match the shared route table and need record.assign in the system', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
      expect(route.permission).toBe('record.assign');
    }
  });
});

describe('handover model', () => {
  it('lists the kinds held, the people to choose from and the items in kind order', () => {
    const model = fromHoldings(HOLDINGS as never);
    expect(kindRows(model)).toEqual([{ kind: 'evidence', count: 1 }, { kind: 'risk', count: 1 }]);
    expect(sortedItems(model.items).map((i) => i.code)).toEqual(['EV-0100', 'R-014']);
    expect(peopleOf(ctxOf('en')).map((p) => p.id)).not.toContain('none');
    expect(peopleOf(ctxOf('en'))[0]).toEqual({ id: 'andi', name: 'Andi Saputra', jobTitle: 'Procurement Lead' });
    expect(nameOf(ctxOf('en'), 'bagus')).toBe('Bagus Prasetyo');
    expect(kindLabel('risk_treatment')).toEqual(TEXT.kind_risk_treatment);
    expect(KIND_ORDER).toHaveLength(13);
  });

  it('lists the people who still hold items but left the active members with a role, and reads typed user names', () => {
    const holders = snapshotHolders(ctxOf('en'), 'isms');
    expect(holders).toContain('bagus');
    expect(holders).not.toContain('none');
    // With every holder among the people, nobody is listed apart.
    expect(formerPeople(ctxOf('en'), 'isms')).toEqual([]);
    const left = ctxOf('en', { D: LEFT });
    expect(peopleOf(left).map((p) => p.id)).not.toContain('bagus');
    expect(formerPeople(left, 'isms')).toEqual([{ id: 'bagus', name: 'bagus', jobTitle: '' }]);
    // The person People and roles opened the screen with, and typed user names, with the names given.
    expect(formerPeople(left, 'isms', ['bagus', 'wulan', 'Not A Handle', 'none'], { bagus: 'Bagus Prasetyo' })).toEqual([
      { id: 'bagus', name: 'Bagus Prasetyo', jobTitle: '' },
      { id: 'wulan', name: 'wulan', jobTitle: '' },
    ]);
    expect(formerPeople(left, 'isms', ['dewi'])).toEqual([{ id: 'bagus', name: 'bagus', jobTitle: '' }]);
    expect(nameOf(left, 'bagus')).toBe('bagus');
    expect(nameOf(left, 'bagus', { bagus: 'Bagus Prasetyo' })).toBe('Bagus Prasetyo');
    expect(formerPeople(ctxOf('en', { D: null }), 'isms')).toEqual([]);
    expect(handleOf('  Bagus ')).toBe('bagus');
    expect(handleOf('ext.auditor')).toBe('ext.auditor');
    for (const bad of ['', 'none', 'b', 'bagus prasetyo', '1bagus', 'bagus@x.id']) expect(handleOf(bad), bad).toBeNull();
  });

  it('builds HoldingsReassign: every kind, chosen kinds in order, confirm after BR-22; checks before a move', () => {
    expect(reassignBody('sari', null)).toEqual({ successor: 'sari' });
    expect(reassignBody('sari', ['risk', 'evidence'], true)).toEqual({ successor: 'sari', kinds: ['evidence', 'risk'], confirm: true });
    expect(moveBlock('bagus', '', null)).toEqual(TEXT.chooseSuccessor);
    expect(moveBlock('bagus', 'bagus', null)).toEqual(TEXT.someoneElse);
    expect(moveBlock('bagus', 'sari', [])).toEqual(TEXT.chooseKinds);
    expect(moveBlock('bagus', 'sari', ['risk'])).toBeNull();
    expect(moveBlock('bagus', 'sari', null)).toBeNull();
  });
});

describe('handover API adapter', () => {
  it('reads the holdings and moves them with the warnings per record; keeps the BR-22 confirmation refusal', async () => {
    const shared = problem(409, 'confirmation-required', { rule: 'BR-22', affected: ['qms'], messages: { en: 'This record is shared with QMS; the change applies there too.', id: 'Rekaman ini dibagikan dengan QMS.' } });
    const moved = json({
      ok: true, changed: ['isms', 'qms'], count: 2, message: ['2 items moved from bagus to sari', '2 item dipindahkan dari bagus ke sari'],
      warnings: [{ rule: 'BR-41', messages: { en: 'R-014: due after the next audit', id: 'R-014: jatuh tempo setelah audit berikutnya' } }], data: { counts: { risk: 1, evidence: 1 } },
    });
    const f = fakeFetch({
      'GET /api/v1/ms/isms/holdings/bagus': json(HOLDINGS),
      'POST /api/v1/ms/isms/holdings/bagus/reassign': [shared, moved],
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client);
    expect(await adapter.holdings('isms', 'bagus')).toMatchObject({ ok: true, data: { handle: 'bagus', counts: { risk: 1 }, items: [{ code: 'R-014', dueAt: '2026-11-20' }, { code: 'EV-0100' }] } });
    const first = await adapter.reassign('isms', 'bagus', { successor: 'sari' });
    expect(first).toMatchObject({ ok: false, error: { status: 409, slug: 'confirmation-required', rule: 'BR-22' } });
    const second = await adapter.reassign('isms', 'bagus', { successor: 'sari', confirm: true });
    expect(second).toEqual({ ok: true, data: { count: 2, message: ['2 items moved from bagus to sari', '2 item dipindahkan dari bagus ke sari'], warnings: [{ rule: 'BR-41', text: ['R-014: due after the next audit', 'R-014: jatuh tempo setelah audit berikutnya'] }], changed: ['isms', 'qms'] } });
    expect(f.calls.at(-1)).toMatchObject({ method: 'POST', body: { successor: 'sari', confirm: true }, headers: { 'x-csrf-token': 'csrf-token-0123456789abcdef' } });
    expect(outcomeOf({ ok: true, changed: [] })).toEqual({ count: 0, message: null, warnings: [], changed: [] });
  });
});

describe('handover sample adapter', () => {
  it('lists the open items of a person and moves all or chosen kinds to the successor, changing the sample records', async () => {
    const mutate = vi.fn(async () => ({ ok: true, changed: ['isms'] }));
    const adapter = createSampleAdapter(() => D, () => ({ mutate } as unknown as DataSource));
    const before = await adapter.holdings('isms', 'bagus');
    if (!before.ok) throw new Error('holdings failed');
    expect(before.data.items.length).toBeGreaterThan(10);
    expect(before.data.counts.evidence).toBeGreaterThan(0);
    expect(await adapter.reassign('isms', 'bagus', { successor: 'bagus' })).toMatchObject({ ok: false, error: { status: 422, messageKey: 'holdings.same_person' } });
    expect(await adapter.reassign('isms', 'bagus', { successor: 'nobody' })).toMatchObject({ ok: false, error: { status: 400 } });
    const risks = await adapter.reassign('isms', 'bagus', { successor: 'dewi', kinds: ['risk'] });
    expect(risks).toMatchObject({ ok: true, data: { count: before.data.counts.risk, changed: ['isms'] } });
    const after = await adapter.holdings('isms', 'bagus');
    expect(after.ok && after.data.counts.risk).toBeUndefined();
    const all = await adapter.reassign('isms', 'bagus', { successor: 'dewi' });
    expect(all.ok && all.data.count).toBe(before.data.items.length - (before.data.counts.risk ?? 0));
    expect(mutate).toHaveBeenCalledWith('isms', 'ev', expect.any(String), { owner: 'dewi' });
    expect(sampleHoldings(D, 'isms', 'bagus').items).toEqual([]);
    expect((await adapter.holdings('isms', 'nobody')).ok).toBe(false);
  });

  it('asks for the BR-22 confirmation before a shared document moves, then moves it in every system that uses it', async () => {
    const mutate = vi.fn(async () => ({ ok: true, changed: ['isms'] }));
    const adapter = createSampleAdapter(() => D, () => ({ mutate } as unknown as DataSource));
    const before = sampleHoldings(D, 'isms', 'hendra');
    expect(before.items.some((i) => i.code === 'IMS-04' && i.kind === 'document_owner')).toBe(true);
    // A move without the shared document needs no confirmation.
    const others = KIND_ORDER.filter((k) => k !== 'document_owner' && before.counts[k]);
    if (others.length) expect(await adapter.reassign('isms', 'hendra', { successor: 'dewi', kinds: [...others] })).toMatchObject({ ok: true, data: { changed: ['isms'] } });
    const asked = await adapter.reassign('isms', 'hendra', { successor: 'dewi' });
    expect(asked).toEqual({
      ok: false,
      error: { status: 409, slug: 'confirmation-required', rule: 'BR-22', message: ['This change also applies to: ABMS, BCMS, QMS. Continue?', 'Perubahan ini juga berlaku untuk: ABMS, BCMS, QMS. Lanjutkan?'], detail: 'This change also applies to: ABMS, BCMS, QMS. Continue?' },
    });
    expect(mutate).not.toHaveBeenCalledWith(expect.anything(), 'doc', 'IMS-04', expect.anything());
    expect(sampleHoldings(D, 'isms', 'hendra').items.some((i) => i.code === 'IMS-04')).toBe(true);
    const moved = await adapter.reassign('isms', 'hendra', { successor: 'dewi', confirm: true });
    expect(moved).toMatchObject({ ok: true, data: { changed: ['isms', 'qms', 'bcms', 'abms'] } });
    for (const ms of ['isms', 'qms', 'bcms', 'abms']) {
      expect(mutate).toHaveBeenCalledWith(ms, 'doc', 'IMS-04', { owner: 'dewi' });
      expect(sampleHoldings(D, ms, 'hendra').items.some((i) => i.code === 'IMS-04')).toBe(false);
      expect(sampleHoldings(D, ms, 'dewi').items.some((i) => i.code === 'IMS-04')).toBe(true);
    }
    expect(sampleHoldings(D, 'isms', 'hendra').items).toEqual([]);
  });

  it('the build chooses the adapter; a deferred adapter retries a failed module load', async () => {
    expect(await adapterFor(() => ctxOf('en')).holdings('isms', 'maya')).toMatchObject({ ok: true });
    const load = vi.fn<() => Promise<HandoverAdapter>>().mockRejectedValueOnce(new Error('chunk')).mockResolvedValue(createSampleAdapter(() => D, () => null));
    const adapter = deferredAdapter(load);
    await expect(adapter.holdings('isms', 'maya')).rejects.toThrow('chunk');
    expect(await adapter.holdings('isms', 'maya')).toMatchObject({ ok: true });
    expect(await settled(Promise.reject(new Error('x')))).toMatchObject({ ok: false, error: { status: 0 } });
  });
});

describe('handover views', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the person picker and the open items in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf(lang, { params: { handle: 'bagus' } });
        const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
        const body = render(<HandoverBody ctx={ctx} adapter={createSampleAdapter(() => D, () => null)} ms="isms" />, ctx, theme);
        for (const p of [TEXT.person, TEXT.personHint]) expect(body, p[0]).toContain(t(p));
        expect(body).toContain('Bagus Prasetyo');
        const view = render(<HoldingsView ctx={ctx} model={fromHoldings(HOLDINGS as never)} chosen={['risk']} onChoose={() => undefined} />, ctx, theme);
        for (const p of [TEXT.summary, TEXT.summarySub, TEXT.itemsTitle, TEXT.colKind, TEXT.colCount, TEXT.colCode, TEXT.colTitle, TEXT.colDue, TEXT.kind_risk, TEXT.kind_evidence]) expect(view, p[0]).toContain(t(p));
        expect(view).toContain('R-014');
        expect(view).toMatch(/<input type="checkbox" name="kind-risk" checked=""/);
        expect(body + view).not.toMatch(/[—·]/);
      });
    }
  }

  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`a person who left is listed apart and can be typed, in ${lang}, ${theme} theme`, () => {
        const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
        const ctx = ctxOf(lang, { D: LEFT, params: { handle: 'bagus', name: 'Bagus Prasetyo' } });
        const body = render(<HandoverBody ctx={ctx} adapter={createSampleAdapter(() => LEFT, () => null)} ms="isms" />, ctx, theme);
        expect(body).toContain(`<optgroup label="${t(TEXT.groupMembers)}">`);
        expect(body).toContain(`<optgroup label="${t(TEXT.groupFormer)}" data-group="former"><option value="bagus" selected="">Bagus Prasetyo (bagus)</option></optgroup>`);
        expect(body).toContain(ctx.fill(TEXT.formerNote, { name: 'Bagus Prasetyo' }));
        for (const p of [TEXT.typedLabel, TEXT.typedHint, TEXT.showItems]) expect(body, p[0]).toContain(t(p));
        expect(body).toMatch(/<input[^>]*name="holderHandle"/);
        // Without anyone listed apart the picker has no groups.
        const plain = render(<HolderPicker ctx={ctx} value="" onChange={() => undefined} people={peopleOf(ctxOf(lang))} former={[]} />, ctx, theme);
        expect(plain).not.toContain('<optgroup');
        expect(plain).toContain('Bagus Prasetyo, ');
        expect(render(<TypedHolder ctx={ctx} onPick={() => undefined} />, ctx, theme)).toContain('type="submit"');
        expect(body + plain).not.toMatch(/[—·]/);
      });
    }
  }

  it('asks for a system, and shows the read-only notice without record.assign', () => {
    expect(render(<HandoverScreen ctx={ctxOf('en', { msObj: null })} />, ctxOf('en'))).toContain(TEXT.noSystem[0]);
    expect(render(<HandoverScreen ctx={ctxOf('id', { can: () => false })} />, ctxOf('id'))).toContain(TEXT.readOnly[1]);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries(TEXT)) {
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(/[—·]/);
    }
  });

  it('is in the Audit group of the system with record.assign', () => {
    expect(screen).toMatchObject({ id: 'handover', path: '/ms/:ms/handover', group: 'audit', scope: 'ms', perm: 'record.assign', roles: ['manager'] });
    expect(screen.pageActions).toBeUndefined();
  });
});
