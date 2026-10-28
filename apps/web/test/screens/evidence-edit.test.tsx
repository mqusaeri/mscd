// The evidence forms (MILESTONE-2 M2-11): routes against the shared table, the model (checks, bodies, code suggestion,
// freshness limits), the targets as the panel shows them, the api adapter over a fake fetch (If-Match, Idempotency-Key,
// X-CSRF-Token, target ids, the first file), the sample adapter over the sample data source (BR-23, never the last
// target), the panels and forms in both languages and themes, and the page actions of Evidence freshness.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import type { ControllerData, DataSource, Evidence } from '../../src/data/types';
import { detailExtensions, extraPageActions, layerItems } from '../../src/screens/evidence-edit/actions';
import { adapterFor } from '../../src/screens/evidence-edit/adapter';
import { createApiAdapter, targetsOfRow } from '../../src/screens/evidence-edit/api';
import { DefinePanel } from '../../src/screens/evidence-edit/DefinePanel';
import { AddTargetDialog, EditEvidenceDialog, EvidenceForms, FirstFileStep, NewEvidenceDialog, RemoveTargetDialog, evidenceRefOf, servableEntries } from '../../src/screens/evidence-edit/dialogs';
import EvidencePanel from '../../src/screens/evidence-edit/EvidencePanel';
import {
  DEFAULT_LIMITS, checkEvidence, createBodyOf, idOfTarget, patchOf, suggestCode, targetOfId, thresholdBodyOf, thresholdValuesOf, valuesOfEvidence,
} from '../../src/screens/evidence-edit/model';
import type { EvidenceValues } from '../../src/screens/evidence-edit/model';
import { ROUTES, ROUTE_IDS } from '../../src/screens/evidence-edit/routes';
import { createSampleAdapter, resetSampleEvidence, sampleTargetsOf } from '../../src/screens/evidence-edit/sample';
import { evidenceRequest, requestEvidence } from '../../src/screens/evidence-edit/store';
import { forgetTarget, learnTarget, resetLearnedTargets, shownTargets, snapshotTargets, targetScopeOf } from '../../src/screens/evidence-edit/targets';
import { ThresholdsDialog, putLimits } from '../../src/screens/evidence-edit/ThresholdsDialog';
import { TEXT } from '../../src/screens/evidence-edit/text';
import { fakeFetch, json, problem } from '../auth/helpers';
import { FORBIDDEN, apiCtxOf, ctxOf, pairProblems, render, sampleWorld } from './m2-11-fixtures';

const CSRF = 'csrf-token-0123456789abcdef';
const UUID = '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b';
const TARGET_ID = '9b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e';
const ETAG = 'W/"1790000000000"';

let D: ControllerData;
let ds: DataSource;
beforeEach(async () => {
  ({ D, ds } = await sampleWorld());
  resetSampleEvidence();
  resetLearnedTargets();
});
afterEach(() => requestEvidence(null));

const evs = (ms = 'isms') => D.bundles[ms].evs as Evidence[];
const reload = async (ms = 'isms') => {
  const snap = await ds.reload(D, [ms]);
  D = { ...D, ...snap, bundles: snap.bundles };
};
const NEW: EvidenceValues = { code: 'EV-0900', title: 'Quarterly firewall rule review', owner: 'bagus', frequency: 'quarterly', classification: 'internal', targets: ['A.8.20'], others: [] };

describe('evidence-edit routes and texts', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    for (const name of ['create', 'update', 'targetAdd', 'targetRemove'] as const) expect(routeById(ROUTE_IDS[name]).permission, name).toBe('evidence.manage');
    expect(routeById(ROUTE_IDS.thresholdSet).permission).toBe('applicability.manage');
    expect(routeById(ROUTE_IDS.thresholds).permission).toBe('ms.read');
    expect(routeById(ROUTE_IDS.files).permission).toBe('evidence.file.submit');
  });

  it('has every text in both languages without an em dash or a centre dot', () => {
    expect(pairProblems(TEXT, ['classInternal'])).toEqual([]);
  });
});

describe('evidence-edit model', () => {
  it('reads targets from entry ids and back', () => {
    expect(targetOfId('Cl. 7.5.3')).toEqual({ targetType: 'requirement', code: '7.5.3' });
    expect(targetOfId('A.8.20')).toEqual({ targetType: 'catalogue_item', code: 'A.8.20' });
    expect(idOfTarget({ targetType: 'requirement', code: '9.1' })).toBe('Cl. 9.1');
  });

  it('checks New and Edit evidence', () => {
    expect(checkEvidence(NEW, 'new', ['EV-0313'])).toEqual({});
    expect(checkEvidence({ ...NEW, code: ' ', title: '', owner: 'none', targets: [], classification: '' }, 'new')).toEqual({
      code: TEXT.codeRequired, title: TEXT.titleRequired, owner: TEXT.ownerRequired, targets: TEXT.noTargets, classification: TEXT.classificationRequired,
    });
    expect(checkEvidence(NEW, 'new', ['ev-0900'])).toEqual({ code: ['EV-0900 already exists.', 'EV-0900 sudah ada.'] });
    expect(checkEvidence({ ...NEW, code: 'x'.repeat(31) }, 'new')).toEqual({ code: TEXT.codeRequired });
    // Edit has no code, classification or targets to check.
    expect(checkEvidence({ ...NEW, code: '', targets: [], classification: '' }, 'edit')).toEqual({});
  });

  it('builds the create body and the PATCH of what changed', () => {
    expect(createBodyOf({ ...NEW, targets: ['A.8.20', 'Cl. 8.1'] })).toEqual({
      code: 'EV-0900', title: 'Quarterly firewall rule review', ownerHandle: 'bagus', frequencyCode: 'quarterly', classification: 'internal',
      targets: [{ targetType: 'catalogue_item', code: 'A.8.20' }, { targetType: 'requirement', code: '8.1' }],
    });
    const e = evs()[0]!;
    const initial = valuesOfEvidence(e);
    expect(initial).toMatchObject({ code: e.code, title: e.title, frequency: e.freq, classification: '' });
    expect(patchOf(initial, initial)).toBeNull();
    expect(patchOf(initial, { ...initial, title: ` ${e.title} ` })).toBeNull();
    expect(patchOf(initial, { ...initial, frequency: 'monthly', classification: 'confidential' })).toEqual({ frequencyCode: 'monthly', classification: 'confidential' });
    expect(patchOf(initial, { ...initial, owner: 'dewi' }, true)).toEqual({ ownerHandle: 'dewi', confirm: true });
  });

  it('suggests the next free code with the prefix the system uses', () => {
    expect(suggestCode(['EV-0100', 'EV-0313', 'EQ-0154'])).toBe('EV-0314');
    expect(suggestCode([])).toBe('EV-0001');
    expect(suggestCode(['EB-09', 'EB-10'])).toBe('EB-11');
  });

  it('checks the freshness limits of a frequency', () => {
    expect(thresholdBodyOf({ graceDays: '7', agingFactor: '1.2', expiredFactor: '1.8' })).toEqual({ ok: true, body: { graceDays: 7, agingFactor: 1.2, expiredFactor: 1.8 } });
    expect(thresholdBodyOf({ graceDays: '-1', agingFactor: '0.5', expiredFactor: '1.5' })).toEqual({ ok: false, fields: { graceDays: TEXT.graceRange, agingFactor: TEXT.factorRange } });
    expect(thresholdBodyOf({ graceDays: '1', agingFactor: '2', expiredFactor: '1.5' })).toEqual({ ok: false, fields: { expiredFactor: TEXT.expiredBelowAging } });
    expect(thresholdValuesOf({ frequencyCode: 'monthly', ...DEFAULT_LIMITS, source: 'default' })).toEqual({ graceDays: '1', agingFactor: '1.25', expiredFactor: '2' });
  });
});

describe('evidence-edit targets', () => {
  it('shows the first target of each system and the targets learned in this session', () => {
    const code = evs()[0]!.code;
    const scope = targetScopeOf(apiCtxOf(D, 'isms', ['evidence.manage'], ['ms_manager']));
    const first = snapshotTargets(D, code);
    expect(first).toEqual([{ id: null, ms: 'isms', ...targetOfId(evs()[0]!.ctrl) }]);
    learnTarget(scope, code, { id: TARGET_ID, ms: 'qms', targetType: 'requirement', code: '7.5' });
    expect(shownTargets(null, D, scope, code)).toEqual({ complete: false, targets: [...first, { id: TARGET_ID, ms: 'qms', targetType: 'requirement', code: '7.5' }] });
    const server = { complete: true, targets: [{ id: UUID, ms: 'isms', targetType: 'catalogue_item' as const, code: 'A.8.13' }] };
    expect(shownTargets(server, D, scope, code)).toBe(server);
    forgetTarget(scope, code, { id: TARGET_ID, ms: 'qms', targetType: 'requirement', code: '7.5' });
    expect(shownTargets(null, D, scope, code)).toEqual({ complete: false, targets: first });
    expect(targetsOfRow({ targets: [{ id: TARGET_ID, ms: 'qms', targetType: 'requirement', code: '7.5' }, { ms: 'qms' }] })).toEqual([{ id: TARGET_ID, ms: 'qms', targetType: 'requirement', code: '7.5' }]);
    expect(targetsOfRow({ code: 'EV-1' })).toBeNull();
  });

  it('keeps the targets learned in one organisation out of another organisation', () => {
    const code = evs()[0]!.code;
    const first = snapshotTargets(D, code);
    const ndt = apiCtxOf(D, 'isms', ['evidence.manage'], ['ms_manager']);
    const other = { ...ndt, org: { ...ndt.org!, id: 'tst' } };
    expect(targetScopeOf(ndt)).toBe('api:ndt');
    expect(targetScopeOf(other)).toBe('api:tst');
    expect(targetScopeOf({ mode: 'sample', org: ndt.org })).toBe('sample:ndt');
    const learned = { id: TARGET_ID, ms: 'isms' as const, targetType: 'catalogue_item' as const, code: 'A.8.14' };
    learnTarget(targetScopeOf(ndt), code, learned);
    expect(shownTargets(null, D, targetScopeOf(ndt), code).targets).toEqual([...first, learned]);
    // The same evidence code in another organisation is another record: no learned target, so no Remove the server refuses.
    expect(shownTargets(null, D, targetScopeOf(other), code)).toEqual({ complete: false, targets: first });
    expect(shownTargets(null, D, targetScopeOf({ mode: 'sample', org: ndt.org }), code)).toEqual({ complete: false, targets: first });
    // The panel of the other organisation shows the learned target's Remove nowhere.
    const html = render(<EvidencePanel ctx={other} kind="ev" ms="isms" recordKey={`isms:ev:${code}`} record={evs()[0]!} close={() => undefined} />, other);
    expect(html).not.toContain('A.8.14');
    const own = render(<EvidencePanel ctx={ndt} kind="ev" ms="isms" recordKey={`isms:ev:${code}`} record={evs()[0]!} close={() => undefined} />, ndt);
    expect(own).toContain('A.8.14');
  });

  it('offers the entries of a system that still apply', () => {
    expect(servableEntries({ D }, 'isms').every((c) => c.st !== 'na')).toBe(true);
    expect(servableEntries({ D }, 'isms').length).toBe((D.bundles.isms.reqs).filter((c) => c.st !== 'na').length);
  });
});

describe('evidence-edit api adapter', () => {
  const ref = { ms: 'isms', code: 'EV-0313', uuid: UUID, etag: ETAG };
  function adapter(routes: Parameters<typeof fakeFetch>[0]) {
    const f = fakeFetch(routes);
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken(CSRF);
    return { ...f, adapter: createApiAdapter(client) };
  }

  it('creates, changes and targets evidence with the headers of D.1', async () => {
    const t = adapter({
      'POST /api/v1/ms/isms/evidence': json({ ok: true, changed: ['isms'], ref: { module: 'surveillance', entityType: 'evidence', id: UUID, code: 'EV-0900' } }, 201),
      [`PATCH /api/v1/ms/isms/evidence/${UUID}`]: json({ ok: true, changed: ['isms'] }),
      [`POST /api/v1/ms/isms/evidence/${UUID}/targets`]: json({ ok: true, changed: ['isms', 'qms'], warnings: [{ rule: 'BR-23', messages: { en: 'Similar', id: 'Mirip' } }], data: { targetId: TARGET_ID } }, 201),
      [`POST /api/v1/ms/isms/evidence/${UUID}/targets/${TARGET_ID}/remove`]: json({ ok: true, changed: ['isms', 'qms'] }),
    });
    const created = await t.adapter.create('isms', createBodyOf(NEW), 'key-1');
    expect(created.ok && created.data.ref?.id).toBe(UUID);
    expect(t.calls[0]!.headers).toMatchObject({ 'idempotency-key': 'key-1', 'x-csrf-token': CSRF });
    await t.adapter.update(ref, { frequencyCode: 'monthly', confirm: true });
    expect(t.calls[1]).toMatchObject({ method: 'PATCH', body: { frequencyCode: 'monthly', confirm: true } });
    expect(t.calls[1]!.headers['if-match']).toBe(ETAG);
    const added = await t.adapter.addTarget(ref, { ms: 'qms', targetType: 'requirement', code: '7.5', mappingNote: 'Same process' }, 'key-2');
    expect(added).toMatchObject({ ok: true, data: { warnings: [{ rule: 'BR-23', message: ['Similar', 'Mirip'] }], data: { targetId: TARGET_ID } } });
    expect(t.calls[2]).toMatchObject({ body: { ms: 'qms', targetType: 'requirement', code: '7.5', mappingNote: 'Same process' } });
    await t.adapter.removeTarget(ref, { id: TARGET_ID, ms: 'qms', targetType: 'requirement', code: '7.5' }, ' Mapped to the wrong clause ');
    expect(t.calls[3]).toMatchObject({ body: { reason: 'Mapped to the wrong clause' } });
  });

  it('sends nothing for a target without an id or evidence without a uuid', async () => {
    const t = adapter({});
    expect(await t.adapter.removeTarget(ref, { id: null, ms: 'isms', targetType: 'catalogue_item', code: 'A.8.13' }, 'Wrong')).toMatchObject({ ok: false, error: { message: TEXT.noTargetId } });
    expect(await t.adapter.update({ ...ref, uuid: null }, { title: 'x' })).toMatchObject({ ok: false, error: { status: 404 } });
    expect(t.calls).toHaveLength(0);
  });

  it('reads the targets from the evidence list when the server lists them', async () => {
    const row = { code: 'EV-0313', ref: { module: 'surveillance', entityType: 'evidence', id: UUID, code: 'EV-0313' } };
    const t = adapter({
      'GET /api/v1/ms/isms/evidence': [
        json({ items: [row], page: 1, pageSize: 50, total: 1 }),
        json({ items: [{ ...row, targets: [{ id: TARGET_ID, ms: 'isms', targetType: 'catalogue_item', code: 'A.8.13' }] }], page: 1, pageSize: 50, total: 1 }),
      ],
    });
    expect(await t.adapter.targets(ref)).toEqual({ ok: true, data: { targets: [], complete: false } });
    expect(t.calls[0]!.url).toContain('q=EV-0313');
    expect(await t.adapter.targets(ref)).toEqual({ ok: true, data: { complete: true, targets: [{ id: TARGET_ID, ms: 'isms', targetType: 'catalogue_item', code: 'A.8.13' }] } });
  });

  it('attaches the first file linked or uploaded, and reads and sets the freshness limits', async () => {
    const t = adapter({
      [`POST /api/v1/ms/isms/evidence/${UUID}/files`]: json({ ok: true, changed: ['isms'] }, 201),
      'GET /api/v1/ms/isms/freshness-thresholds': json([{ frequencyCode: 'monthly', graceDays: 1, agingFactor: 1.25, expiredFactor: 2, source: 'default' }]),
      'PUT /api/v1/ms/isms/freshness-thresholds/monthly': [json({ ok: true, changed: ['isms'] }), problem(422, 'validation', { errors: [{ path: 'body.expiredFactor', message: 'expiredFactor must be at least agingFactor' }] })],
    });
    await t.adapter.attach(ref, { source: 'link', repository: 'sp', externalItemId: 'demo-sp-picker-1', fileName: 'a.pdf' }, '2026-09-29');
    expect(t.calls[0]!.body).toEqual({ source: 'link', repository: 'sp', externalItemId: 'demo-sp-picker-1', producedAt: '2026-09-29', mode: 'submit' });
    expect(t.calls[0]!.headers['idempotency-key']).toBeTruthy();
    await t.adapter.attach(ref, { source: 'upload', uploadIntentId: TARGET_ID, fileName: 'b.pdf' }, '2026-09-29');
    expect(t.calls[1]!.body).toEqual({ source: 'upload', uploadIntentId: TARGET_ID, producedAt: '2026-09-29', mode: 'submit' });
    expect(await t.adapter.thresholds('isms')).toMatchObject({ ok: true, data: [{ frequencyCode: 'monthly', source: 'default' }] });
    expect(await t.adapter.setThreshold('isms', 'monthly', { graceDays: 7, agingFactor: 1.2, expiredFactor: 1.8 })).toMatchObject({ ok: true });
    const refused = await t.adapter.setThreshold('isms', 'monthly', { graceDays: null, agingFactor: null, expiredFactor: null });
    expect(!refused.ok && refused.error.errors?.[0]?.path).toBe('body.expiredFactor');
  });

  it('reads the evidence ref of the snapshot', () => {
    const withRefs = { ...D, refs: { 'isms:ev:EV-0313': { module: 'surveillance', entityType: 'evidence', id: UUID, code: 'EV-0313', etag: ETAG } } } as unknown as ControllerData;
    expect(evidenceRefOf({ D: withRefs }, 'isms', 'EV-0313')).toEqual(ref);
  });
});

describe('evidence-edit sample adapter', () => {
  const adapterOf = () => createSampleAdapter(() => D, ds);

  it('creates evidence without a file in the system repository, and refuses a code that exists', async () => {
    const a = adapterOf();
    expect(await a.create('isms', createBodyOf({ ...NEW, targets: ['A.8.20', 'A.8.21'] }), 'k')).toMatchObject({ ok: true, data: { changed: ['isms'] } });
    await reload();
    const e = evs().find((x) => x.code === 'EV-0900')!;
    expect(e).toMatchObject({ ctrl: 'A.8.20', freq: 'quarterly', p: D.FREQ.quarterly[2], prod: '', fresh: 'critical', loc: 'sp', owner: 'bagus' });
    expect(sampleTargetsOf(D, 'EV-0900').map(idOfTarget)).toEqual(['A.8.20', 'A.8.21']);
    expect(await a.create('isms', createBodyOf({ ...NEW, code: evs()[0]!.code }), 'k')).toMatchObject({ ok: false, error: { status: 409 } });
    // The first file restarts the cycle: produced today, fresh.
    expect(await a.attach({ ms: 'isms', code: 'EV-0900', uuid: null, etag: null }, { source: 'upload', uploadIntentId: 'x', fileName: 'a.pdf' }, D.TODAY_S)).toMatchObject({ ok: true });
    await reload();
    expect(evs().find((x) => x.code === 'EV-0900')).toMatchObject({ prod: D.TODAY_S, fresh: 'fresh' });
  });

  it('changes the frequency with the period and band', async () => {
    const e = evs().find((x) => x.p > 0 && x.prod)!;
    expect(await adapterOf().update({ ms: 'isms', code: e.code, uuid: null, etag: null }, { frequencyCode: 'annual', title: 'Renamed record' })).toMatchObject({ ok: true });
    await reload();
    expect(evs().find((x) => x.code === e.code)).toMatchObject({ title: 'Renamed record', freq: 'annual', p: 365, next: D.addD(e.prod, 365) });
  });

  it('adds targets with the BR-23 warning for another system and never removes the last one', async () => {
    const a = adapterOf();
    const e = evs()[0]!;
    const ref = { ms: 'isms', code: e.code, uuid: null, etag: null };
    const only = sampleTargetsOf(D, e.code)[0]!;
    expect(await a.removeTarget(ref, only, 'Wrong control')).toMatchObject({ ok: false, error: { message: TEXT.sampleLastTarget } });
    const qmsEntry = (D.bundles.qms.reqs)[0]!;
    const added = await a.addTarget(ref, { ms: 'qms', ...targetOfId(qmsEntry.id) }, 'k');
    expect(added).toMatchObject({ ok: true, data: { changed: ['isms', 'qms'], warnings: [{ rule: 'BR-23' }] } });
    expect(await a.addTarget(ref, { ms: 'qms', ...targetOfId(qmsEntry.id) }, 'k')).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await a.addTarget(ref, { ms: 'qms', targetType: 'requirement', code: '99.9' }, 'k')).toMatchObject({ ok: false, error: { status: 422 } });
    const list = (await a.targets(ref));
    expect(list.ok && list.data.targets).toHaveLength(2);
    expect(await a.removeTarget(ref, only, 'Wrong control')).toMatchObject({ ok: false });
    const extra = list.ok ? list.data.targets[1]! : only;
    expect(await a.removeTarget(ref, extra, 'Mapped to the wrong clause')).toMatchObject({ ok: true });
    expect((await a.targets(ref)).ok && (await a.targets(ref))).toMatchObject({ data: { targets: [only] } });
  });

  it('keeps the freshness limits set in the session', async () => {
    const a = adapterOf();
    const before = await a.thresholds('isms');
    expect(before.ok && before.data.map((t) => t.frequencyCode)).toEqual(D.FREQ_ORDER);
    expect(before.ok && before.data[0]).toMatchObject({ ...DEFAULT_LIMITS, source: 'default' });
    await a.setThreshold('isms', 'monthly', { graceDays: 5, agingFactor: 1.5, expiredFactor: 3 });
    expect((await a.thresholds('isms'))).toMatchObject({ ok: true, data: expect.arrayContaining([{ frequencyCode: 'monthly', graceDays: 5, agingFactor: 1.5, expiredFactor: 3, source: 'set' }]) });
    await a.setThreshold('isms', 'monthly', { graceDays: null, agingFactor: null, expiredFactor: null });
    expect((await a.thresholds('isms'))).toMatchObject({ ok: true, data: expect.arrayContaining([{ frequencyCode: 'monthly', ...DEFAULT_LIMITS, source: 'default' }]) });
  });

  it('loads the system again after the limits are set or reset, so the bands follow them', async () => {
    const reloadOf = () => vi.fn(async () => undefined);
    const body = { graceDays: 5, agingFactor: 1.5, expiredFactor: 3 };
    const answered = (changed: string[]) => ({ setThreshold: vi.fn(async () => ({ ok: true as const, data: { changed, warnings: [] } })) });

    let load = reloadOf();
    let adapter = answered(['isms']);
    expect(await putLimits(ctxOf(D, 'en', { reload: load }), adapter, 'isms', 'monthly', body)).toMatchObject({ ok: true });
    expect(adapter.setThreshold).toHaveBeenCalledWith('isms', 'monthly', body);
    expect(load).toHaveBeenCalledWith(['isms']);

    // An answer that names no system loads the form's system; a reset (nulls) loads it too.
    load = reloadOf();
    adapter = answered([]);
    await putLimits(ctxOf(D, 'en', { reload: load }), adapter, 'qms', 'monthly', { graceDays: null, agingFactor: null, expiredFactor: null });
    expect(load).toHaveBeenCalledWith(['qms']);

    // A refused write loads nothing; a failed load keeps the saved answer.
    load = reloadOf();
    const refused = { setThreshold: vi.fn(async () => ({ ok: false as const, error: { status: 403, slug: 'forbidden', message: ['No', 'Tidak'] } as never })) };
    expect(await putLimits(ctxOf(D, 'en', { reload: load }), refused, 'isms', 'monthly', body)).toMatchObject({ ok: false });
    expect(load).not.toHaveBeenCalled();
    const failing = vi.fn(async () => { throw new Error('offline'); });
    expect(await putLimits(ctxOf(D, 'en', { reload: failing }), answered(['isms']), 'isms', 'monthly', body)).toMatchObject({ ok: true });
    expect(failing).toHaveBeenCalledOnce();
  });

  it('is the adapter of the sample build', async () => {
    const res = await adapterFor(ctxOf(D, 'en', { ds })).thresholds('isms');
    expect(res.ok).toBe(true);
  });
});

describe('evidence-edit panels and forms', () => {
  const adapter = () => createSampleAdapter(() => D, ds);
  const e = () => evs()[0]!;

  it('shows the evidence panel with its targets in both languages and themes', () => {
    for (const lang of ['en', 'id'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = ctxOf(D, lang);
        const html = render(<EvidencePanel ctx={ctx} kind="ev" ms="isms" recordKey={`isms:ev:${e().code}`} record={e()} close={() => undefined} />, ctx, theme);
        expect(html).toContain(lang === 'en' ? 'Edit evidence' : 'Ubah bukti');
        expect(html).toContain(lang === 'en' ? 'Add target' : 'Tambah target');
        expect(html).toContain(lang === 'en' ? 'Freshness limits' : 'Batas kesegaran');
        expect(html).toContain(lang === 'en' ? TEXT.lastTarget[0] : TEXT.lastTarget[1]);
        expect(html).not.toMatch(FORBIDDEN);
      }
    }
  });

  it('hides the evidence panel from an owner of other evidence and shows it for own evidence', () => {
    const owner = apiCtxOf(D, 'isms', ['evidence.manage'], ['domain_owner'], 'en', { person: { handle: e().owner, name: 'Owner', jobTitle: '-' } });
    const props = { kind: 'ev' as const, ms: 'isms', recordKey: 'k', close: () => undefined };
    expect(render(<EvidencePanel ctx={owner} {...props} record={e()} />, owner)).toContain('Edit evidence');
    const other = evs().find((x) => x.owner !== e().owner)!;
    expect(render(<EvidencePanel ctx={owner} {...props} record={other} />, owner)).not.toContain('Edit evidence');
  });

  it('offers Define evidence on an entry that applies', () => {
    const ctx = ctxOf(D);
    const reqs = D.bundles.isms.reqs;
    const applies = reqs.find((c) => c.st !== 'na')!;
    const excluded = reqs.find((c) => c.st === 'na')!;
    expect(render(<DefinePanel ctx={ctx} kind="req" ms="isms" recordKey="k" record={applies} close={() => undefined} />, ctx)).toContain('Define evidence');
    expect(render(<DefinePanel ctx={ctx} kind="req" ms="isms" recordKey="k" record={excluded} close={() => undefined} />, ctx)).toBe('<div class="mscd" data-theme="light"></div>');
  });

  it('renders New, Edit, Add target, Remove target and the limits in both languages and themes', () => {
    for (const lang of ['en', 'id'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = ctxOf(D, lang, { ds });
        const neu = render(<NewEvidenceDialog ctx={ctx} ms="isms" target="A.5.1" onClose={() => undefined} />, ctx, theme);
        expect(neu).toContain(lang === 'en' ? 'Create evidence' : 'Buat bukti');
        expect(neu).toContain('value="EV-');
        expect(neu).toContain('A.5.1');
        const props = { ctx, adapter: adapter(), ms: 'isms', evidence: e(), onClose: () => undefined };
        expect(render(<EditEvidenceDialog {...props} />, ctx, theme)).toContain(lang === 'en' ? 'Keep the current classification' : 'Pertahankan klasifikasi saat ini');
        const targets = sampleTargetsOf(D, e().code);
        expect(render(<AddTargetDialog {...props} existing={targets} onDone={() => undefined} />, ctx, theme)).toContain(lang === 'en' ? 'Add a target to' : 'Tambah target ke');
        expect(render(<RemoveTargetDialog {...props} target={targets[0]!} onDone={() => undefined} />, ctx, theme)).toContain(lang === 'en' ? 'Remove' : 'Hapus');
        expect(render(<ThresholdsDialog ctx={ctx} ms="isms" onClose={() => undefined} />, ctx, theme)).toContain(lang === 'en' ? 'Loading the freshness limits' : 'Memuat batas kesegaran');
        expect(render(<EvidenceForms ctx={ctx} request={{ kind: 'edit', ms: 'isms', at: 1, evidence: e() }} onClose={() => undefined} />, ctx, theme)).not.toMatch(FORBIDDEN);
      }
    }
  });

  it('shows the first file step with the no-evidence scene, the warnings and the refused targets', () => {
    const created = {
      ref: { ms: 'isms' as const, code: 'EV-0371', uuid: null, etag: null },
      changed: ['isms' as const],
      warnings: [{ rule: 'BR-23', message: ['The mapping is not marked reusable.', 'Pemetaan tidak ditandai dapat dipakai ulang.'] as const }],
      failures: ['A.5.1 in QMS was not added: no licence'],
    };
    for (const lang of ['en', 'id'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = ctxOf(D, lang);
        const html = render(<FirstFileStep ctx={ctx} created={created} onLater={() => undefined} onAttach={() => undefined} />, ctx, theme);
        expect(html).toContain(lang === 'en' ? 'EV-0371 created' : 'EV-0371 dibuat');
        expect(html).toContain(lang === 'en' ? TEXT.noFileYet[0] : TEXT.noFileYet[1]);
        expect(html).toContain(lang === 'en' ? 'EV-0371 has no file yet' : 'EV-0371 belum punya berkas');
        expect(html).toContain(lang === 'en' ? 'Choose file' : 'Pilih berkas');
        expect(html).toContain('A.5.1 in QMS was not added');
        expect(html).toContain(lang === 'en' ? 'The mapping is not marked reusable.' : 'Pemetaan tidak ditandai dapat dipakai ulang.');
        // The scene sits in the empty state, hidden from screen readers (its title and text say everything).
        expect(html).toMatch(/class="mx-empty-art"><svg[^>]*aria-hidden="true"/);
        expect(html).not.toMatch(FORBIDDEN);
      }
    }
  });

  it('fixes the owner of new evidence for a person with an own grant', () => {
    const owner = apiCtxOf(D, 'isms', ['evidence.manage'], ['domain_owner'], 'en', { person: { handle: 'bagus', name: 'Bagus', jobTitle: '-' } });
    const html = render(<NewEvidenceDialog ctx={owner} ms="isms" onClose={() => undefined} />, owner);
    expect(html).toContain(TEXT.ownerSelf[0]);
    expect(html).toMatch(/<select[^>]*disabled[^>]*>/);
  });
});

describe('evidence-edit page actions and extensions', () => {
  it('adds New evidence and Freshness limits to Evidence freshness in API builds only', () => {
    expect(extraPageActions.map((a) => [a.screen, a.label[0]])).toEqual([['fresh', 'New evidence'], ['fresh', 'Freshness limits']]);
    const sample = ctxOf(D);
    expect(extraPageActions.map((a) => a.visible!(sample))).toEqual([false, false]);
    const manager = apiCtxOf(D, 'isms', ['ms.read', 'evidence.manage'], ['ms_manager']);
    expect(extraPageActions.map((a) => a.visible!(manager))).toEqual([true, true]);
    const reader = apiCtxOf(D, 'isms', ['ms.read'], ['top_management']);
    expect(extraPageActions.map((a) => a.visible!(reader))).toEqual([false, true]);
    extraPageActions[0]!.run(manager);
    expect(evidenceRequest()).toMatchObject({ kind: 'new', ms: 'isms' });
    extraPageActions[1]!.run(manager);
    expect(evidenceRequest()).toMatchObject({ kind: 'limits', ms: 'isms' });
  });

  it('registers the evidence panel, Define evidence and the form layer', () => {
    expect(detailExtensions!.map((x) => [x.id, x.kind])).toEqual([['evidence-edit.evidence', 'ev'], ['evidence-edit.define', 'req']]);
    expect(layerItems!.map((x) => x.id)).toEqual(['evidence-edit.forms']);
  });
});
