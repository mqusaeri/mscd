// Required documented information (MILESTONE-2 M2-12): routes against the shared table, the screen definition, the rules
// of the screen (clause groups, the scope statement row of H.9, the actions of a row, the missing count of the badge),
// the api adapter over a fake fetch, the sample adapter on the sample snapshot (resolution by code and by link), and the
// scope panel, the clause tables and the link dialog in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { DocumentedInfoItem } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { makeDates } from '../../src/data/dates.js';
import type { ControllerData } from '../../src/data/types';
import screen from '../../src/screens/documented-info/index';
import { layerItems } from '../../src/screens/documented-info/actions';
import { adapterFor } from '../../src/screens/documented-info/adapter';
import { codeSourcesOf, createApiAdapter, fromItem } from '../../src/screens/documented-info/api';
import { badgeCount, badgeKey, loadMissingCount, resetBadges, setBadgeCount } from '../../src/screens/documented-info/badge';
import {
  cannotVerify, clauseGroup, codeDocumentOf, documentForCode, groupRows, linkableCode, missingCount, packCodeOf, rowActions, scopeRow, standingDocument, withTemplateDocuments,
} from '../../src/screens/documented-info/model';
import type { DiRow } from '../../src/screens/documented-info/model';
import { ROUTES, ROUTE_IDS } from '../../src/screens/documented-info/routes';
import { SAMPLE_INFO, createSampleAdapter, maintainState, resetSampleLinks, sampleRows } from '../../src/screens/documented-info/sample';
import { ClauseTable, LinkDialog, STATE_TEXT, ScopePanel, loadRows, registerFromTemplate, rowTitle } from '../../src/screens/documented-info/Screen';
import { TEXT } from '../../src/screens/documented-info/text';
import { closeForm, formRequest } from '../../src/screens/docs-edit/store';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';

const FORBIDDEN = /[—·]/;
const UUID = '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b';

async function sampleD(): Promise<ControllerData> {
  const snap = await createSampleDataSource().load();
  return { ...snap, ...makeDates(snap.today) } as unknown as ControllerData;
}

function ctxOf(lang: Lang, D: ControllerData | null, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: D?.MS?.[0] ?? null, org: { id: 'ndt', name: 'PT Nusantara Digital Teknologi', ms: [], deploy: 'saas', sites: 2 }, me: null,
    person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: '-' }, role: 'manager', mode: 'sample', client: null, ds: null, screen: 'documented-info', params: {},
    can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(), track: <T,>(p: Promise<T>) => p, reload: async () => undefined,
    command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);
const t = (pair: readonly [string, string], lang: Lang) => pair[lang === 'id' ? 1 : 0];

const ITEM: DocumentedInfoItem = {
  code: 'DI-02', requirementCode: '5.2', kind: 'maintain', title: 'Information security policy', templateCode: 'POL-01', state: 'approved',
  document: { id: UUID, code: 'ISP-001', title: 'Information Security Policy', status: 'approved', nextReviewAt: '2027-03-01', owner: 'rina', linked: true },
  evidence: [],
};

const row = (over: Partial<DiRow>): DiRow => ({
  code: 'DI-01', requirementCode: '4.3', kind: 'maintain', title: 'Scope of the ISMS', templateCode: 'SCO-01', state: 'missing', document: null, evidence: [], ...over,
});

afterEach(() => {
  resetSampleLinks();
  resetBadges();
  closeForm();
});

describe('Required documented information routes and definition', () => {
  it('match the shared route table', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.list).permission).toBe('ms.read');
    expect(routeById(ROUTE_IDS.link).permission).toBe('document.manage');
  });

  it('is a screen of the Implementation group after Document register, for everyone who reads the system', () => {
    expect(screen).toMatchObject({ id: 'documented-info', group: 'impl', order: 45, scope: 'ms', perm: 'ms.read', path: '/ms/:ms/documented-info' });
    expect(screen.roles).toEqual(['manager', 'owner', 'auditor', 'top']);
    expect(screen.label).toEqual(['Required documented information', 'Informasi terdokumentasi wajib']);
    expect(layerItems.map((l) => l.id)).toEqual(['documented-info-badge']);
    const ctx = ctxOf('en', null);
    expect(layerItems[0].visible?.(ctx)).toBe(false);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries(TEXT)) {
      expect(pair[0].trim(), key).not.toBe('');
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(FORBIDDEN);
    }
  });
});

describe('Required documented information rules', () => {
  it('groups rows by clause 4 to 10 and finds the scope statement row (H.9)', () => {
    expect(clauseGroup('9.2.2')).toBe('9');
    const rows = [row({ code: 'A', requirementCode: '10.2' }), row({ code: 'B', requirementCode: '4.3' }), row({ code: 'C', requirementCode: '9.1' }), row({ code: 'D', requirementCode: 'A.1' })];
    expect(groupRows(rows).map((g) => [g.group, g.rows.map((r) => r.code)])).toEqual([['4', ['B']], ['9', ['C']], ['10', ['A']], ['', ['D']]]);
    expect(scopeRow([row({ code: 'X', templateCode: 'POL-01', requirementCode: '5.2' }), row({ code: 'DI-02', requirementCode: '4.3.2', templateCode: 'SCO-B01' })])?.code).toBe('DI-02');
    expect(scopeRow([row({ templateCode: null, requirementCode: '4.3' })])?.code).toBe('DI-01');
    expect(scopeRow([row({ templateCode: 'POL-01', requirementCode: '5.2' })])).toBeNull();
  });

  it('offers Register from template and Link existing document only where they apply', () => {
    const doc = { id: 'x', code: 'SCO-01', title: 't', status: 'draft', nextReviewAt: null, owner: 'rina', linked: false };
    expect(rowActions(row({}))).toEqual({ register: true, link: true, relink: false, unlink: false });
    expect(rowActions(row({ templateCode: null }))).toEqual({ register: false, link: true, relink: false, unlink: false });
    expect(rowActions(row({ document: doc, state: 'draft' }))).toEqual({ register: false, link: false, relink: false, unlink: false });
    expect(rowActions(row({ document: { ...doc, code: 'ISP-001', linked: true }, state: 'draft' }))).toEqual({ register: false, link: false, relink: true, unlink: true });
    // Found through an implementing document of the clause only: activities do not use it, so both are offered.
    expect(rowActions(row({ document: { ...doc, code: 'QM-09' }, state: 'approved' }))).toEqual({ register: true, link: true, relink: false, unlink: false });
    expect(rowActions(row({ templateCode: null, document: { ...doc, code: 'QM-09' }, state: 'approved' }))).toEqual({ register: false, link: true, relink: false, unlink: false });
    expect(rowActions(row({ templateCode: null, code: 'DI-01', document: { ...doc, code: 'DI-01' }, state: 'draft' }))).toEqual({ register: false, link: false, relink: false, unlink: false });
    expect(rowActions(row({ kind: 'retain', templateCode: null }))).toEqual({ register: false, link: false, relink: false, unlink: false });
    expect(standingDocument(row({}))).toBeNull();
    expect(standingDocument(row({ document: doc }))).toEqual(doc);
    expect(standingDocument(row({ document: { ...doc, code: 'ISP-001', linked: true } }))?.code).toBe('ISP-001');
    expect(standingDocument(row({ document: { ...doc, code: 'POL-A01' } }))).toBeNull();
    expect(packCodeOf(row({}))).toBe('SCO-01');
    expect(packCodeOf(row({ templateCode: null }))).toBe('DI-01');
    expect(missingCount([row({}), row({ state: 'fresh' }), row({ state: 'missing' })])).toBe(2);
  });

  it('a record to retain with a template code offers the actions of its template code, whatever its evidence (BR-40, PRC-04)', () => {
    // ISO/IEC 27001: activity 4.1 expects PRC-04, which only the records DI-03 and DI-04 name.
    const record = row({ code: 'DI-03', requirementCode: '6.1.2', kind: 'retain', title: 'Information security risk assessment process', templateCode: 'PRC-04', state: 'fresh', evidence: [{ code: 'EV-1', title: 'Risk assessment', fresh: 'fresh' }], templateLinkable: true });
    expect(packCodeOf(record)).toBe('PRC-04');
    expect(codeDocumentOf(record)).toBeNull();
    expect(rowActions(record)).toEqual({ register: true, link: true, relink: false, unlink: false });
    expect(rowActions({ ...record, state: 'missing', evidence: [] })).toEqual({ register: true, link: true, relink: false, unlink: false });
    const own = { ...record, templateDocument: { code: 'PRC-04', title: 'Risk assessment method', linked: false } };
    expect(codeDocumentOf(own)?.code).toBe('PRC-04');
    expect(rowActions(own)).toEqual({ register: false, link: false, relink: false, unlink: false });
    const linked = { ...record, templateDocument: { code: 'RA-METH-01', title: 'Risk method', linked: true } };
    expect(rowActions(linked)).toEqual({ register: false, link: false, relink: true, unlink: true });
    // The document field of a record stays empty: only the template document counts.
    expect(rowActions({ ...record, document: { id: 'x', code: 'PRC-04', title: 't', status: 'approved', nextReviewAt: null, owner: 'rina', linked: false } })).toEqual(rowActions(record));
    // A template code that no activity expects and no row to maintain names: a link could not be read back after a new
    // page load, so the record offers Register from template only.
    expect(rowActions({ ...record, templateLinkable: false })).toEqual({ register: true, link: false, relink: false, unlink: false });
    expect(rowActions({ ...record, templateLinkable: undefined })).toEqual({ register: true, link: false, relink: false, unlink: false });
  });

  it('finds the document that stands for a template code from the list and the snapshot (api build)', () => {
    const plan = row({ code: 'DI-06', requirementCode: '6.1.3', title: 'Risk treatment plan', templateCode: 'PLN-01', document: { id: 'u', code: 'RTP-001', title: 'Risk treatment plan 2026', status: 'draft', nextReviewAt: null, owner: 'rina', linked: true }, state: 'draft' });
    const prc = row({ code: 'DI-03', requirementCode: '6.1.2', kind: 'retain', templateCode: 'PRC-04', state: 'missing' });
    const result = row({ code: 'DI-11', requirementCode: '8.3', kind: 'retain', templateCode: 'PLN-01', state: 'missing' });
    const rec = row({ code: 'DI-12', requirementCode: '9.1', kind: 'retain', templateCode: 'REC-01', state: 'missing' });
    const docs = [{ code: 'RTP-001', title: 'Risk treatment plan 2026' }, { code: 'RA-01', title: 'Risk method' }, { code: 'REC-01', title: 'Monitoring results' }];
    const rows = [plan, prc, result, rec];
    // No activity resolves PRC-04 to a document yet; the document with the code REC-01 stands for itself; the record of
    // PLN-01 takes the document of the row to maintain with that pack code.
    let out = withTemplateDocuments(rows, { docs, acts: [{ out: 'PRC-04', doc: null }] });
    expect(out.map((r) => r.templateDocument ?? null)).toEqual([null, null, { code: 'RTP-001', title: 'Risk treatment plan 2026', linked: true }, { code: 'REC-01', title: 'Monitoring results', linked: false }]);
    expect(rowActions(out[1])).toEqual({ register: true, link: true, relink: false, unlink: false });
    // After a link the activity that expects PRC-04 resolves to RA-01 (BR-40).
    out = withTemplateDocuments(rows, { docs, acts: [{ out: 'PRC-04', doc: 'RA-01' }] });
    expect(out[1].templateDocument).toEqual({ code: 'RA-01', title: 'Risk method', linked: true });
    expect(rowActions(out[1])).toEqual({ register: false, link: false, relink: true, unlink: true });
    // The record of PLN-01 is linkable through the row to maintain that names the code, and shows its link.
    expect(out[2]).toMatchObject({ templateLinkable: true });
    expect(rowActions(out[2])).toEqual({ register: false, link: false, relink: true, unlink: true });
    // A code that no activity expects and no row to maintain names offers Register from template only.
    const other = row({ code: 'DI-13', requirementCode: '9.2.2', kind: 'retain', templateCode: 'REC-02', state: 'missing' });
    const plain = withTemplateDocuments([...rows, other], { docs, acts: [{ out: 'PRC-04', doc: null }] })[4];
    expect(plain).toMatchObject({ templateDocument: null, templateLinkable: false });
    expect(rowActions(plain)).toEqual({ register: true, link: false, relink: false, unlink: false });
    expect(documentForCode('REC-02', rows, { docs, acts: [] })).toBeNull();
    expect(linkableCode('PLN-01', rows, [])).toBe(true);
    expect(linkableCode('REC-02', rows, [{ out: 'PRC-04' }])).toBe(false);
    expect(linkableCode('REC-02', rows, [{ out: 'REC-02' }])).toBe(true);
    expect(out.find((r) => r.code === 'DI-06')).toBe(plan);
  });

  it('shows the title of a row in the language of the session', () => {
    expect(rowTitle(ctxOf('id', null), row({ titleId: 'Lingkup ISMS' }))).toBe('Lingkup ISMS');
    expect(rowTitle(ctxOf('en', null), row({ titleId: 'Lingkup ISMS' }))).toBe('Scope of the ISMS');
    expect(rowTitle(ctxOf('id', null), row({}))).toBe('Scope of the ISMS');
  });
});

describe('Required documented information API adapter', () => {
  it('reads the list and maps every row', async () => {
    const f = fakeFetch({ 'GET /api/v1/ms/isms/documented-information': json([ITEM, { ...ITEM, code: 'DI-12', kind: 'retain', state: 'fresh', document: null, evidence: [{ code: 'EV-0920', title: 'Audit', fresh: 'fresh' }] }]) });
    const res = await createApiAdapter(new ApiClient({ fetch: f.fetch }), () => null).list('isms');
    expect(res.ok && res.data).toEqual([fromItem(ITEM), expect.objectContaining({ code: 'DI-12', evidence: [{ code: 'EV-0920', title: 'Audit', fresh: 'fresh' }] })]);
  });

  it('adds the document that stands for the template code of a record from the snapshot, and the link actions only where a link can be read back', async () => {
    const prc: DocumentedInfoItem = { code: 'DI-03', requirementCode: '6.1.2', kind: 'retain', title: 'Information security risk assessment process', templateCode: 'PRC-04', state: 'missing', document: null, evidence: [] };
    const rec: DocumentedInfoItem = { ...prc, code: 'DI-12', requirementCode: '9.1', title: 'Monitoring and measurement results', templateCode: 'REC-01' };
    const f = fakeFetch({ 'GET /api/v1/ms/isms/documented-information': json([prc, rec]) });
    const acts = [{ no: '4.1', out: 'PRC-04', doc: { id: 'RA-01' }, docId: 'RA-01' }];
    const D = { bundles: { isms: { docs: [{ id: 'RA-01', title: 'Risk method' }], phases: [{ no: 4, acts }] } } } as unknown as ControllerData;
    expect(codeSourcesOf(D, 'isms')).toEqual({ docs: [{ code: 'RA-01', title: 'Risk method' }], acts: [{ out: 'PRC-04', doc: 'RA-01' }] });
    const first = await createApiAdapter(new ApiClient({ fetch: f.fetch }), () => D).list('isms');
    expect(first.ok && first.data.map((r) => [r.templateDocument, r.templateLinkable])).toEqual([[{ code: 'RA-01', title: 'Risk method', linked: true }, true], [null, false]]);
    // Activity 4.1 shows the link of PRC-04 after every page load; no activity expects REC-01 and no row to maintain
    // names it, so its record offers Register from template only.
    expect(first.ok && first.data.map(rowActions)).toEqual([
      { register: false, link: false, relink: true, unlink: true },
      { register: true, link: false, relink: false, unlink: false },
    ]);
  });

  it('links a pack code with PUT and the uuid of the document; removes it with null; keeps a refusal', async () => {
    const refused = problem(422, 'business-rule', { messageKey: 'documented_info.unknown_document', messages: { en: 'The document is not registered for this management system', id: 'Dokumen tidak terdaftar untuk sistem manajemen ini' } });
    const f = fakeFetch({ 'PUT /api/v1/ms/isms/documented-information/POL-01/link': [json({ ok: true, changed: ['isms'], data: { code: 'POL-01', documentId: UUID } }), json({ ok: true, changed: ['isms'] }), refused] });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const D = { refs: { 'isms:doc:ISP-001': { module: 'implementation', entityType: 'document', id: UUID, code: 'ISP-001' } } } as unknown as ControllerData;
    const adapter = createApiAdapter(client, () => D);
    expect(adapter.documentId('isms', 'ISP-001')).toBe(UUID);
    expect(adapter.documentId('isms', 'NOPE')).toBeNull();
    expect((await adapter.link('isms', 'POL-01', UUID)).ok).toBe(true);
    expect((await adapter.link('isms', 'POL-01', null)).ok).toBe(true);
    const third = await adapter.link('isms', 'POL-01', UUID);
    expect(!third.ok && third.error.message[0]).toBe('The document is not registered for this management system');
    expect(f.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['PUT', '/api/v1/ms/isms/documented-information/POL-01/link', { documentId: UUID }],
      ['PUT', '/api/v1/ms/isms/documented-information/POL-01/link', { documentId: null }],
      ['PUT', '/api/v1/ms/isms/documented-information/POL-01/link', { documentId: UUID }],
    ]);
    expect(f.calls[0].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
  });
});

describe('Required documented information sample adapter', () => {
  it('holds the documented information rows of the four sample packs', () => {
    expect(Object.fromEntries(Object.entries(SAMPLE_INFO).map(([ms, rows]) => [ms, rows.length]))).toEqual({ isms: 15, qms: 27, bcms: 15, abms: 13 });
    expect(maintainState({ st: 'approved', rev: '2026-01-01' }, '2026-09-29')).toBe('review_overdue');
    expect(maintainState({ st: 'review', rev: '' }, '2026-09-29')).toBe('in_review');
    expect(maintainState(null, '2026-09-29')).toBe('missing');
  });

  it('resolves documents by template code and evidence by clause, and a link makes a row stand for another document', async () => {
    const D = await sampleD();
    const rows = sampleRows(D, 'isms');
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(byCode['DI-02']).toMatchObject({ state: 'approved', document: { code: 'POL-01', linked: false } });
    expect(byCode['DI-05']).toMatchObject({ state: 'draft', document: { code: 'SOA-01' } });
    expect(byCode['DI-06']).toMatchObject({ state: 'missing', document: null });
    const qms = sampleRows(D, 'qms');
    expect(qms.find((r) => r.code === 'DI-25')?.evidence.length).toBeGreaterThan(0);
    // As on the server, a row of a clause requirement falls back on the requirement's implementing document: the scope
    // row of the ABMS shows the anti-bribery policy of clause 4.3, which is not a scope statement. The ISMS applies
    // Annex A controls, so its rows have no such fallback.
    const abmsScope = sampleRows(D, 'abms').find((r) => r.code === 'DI-01')!;
    expect(abmsScope).toMatchObject({ state: 'draft', document: { code: 'POL-A01', linked: false } });
    expect(standingDocument(abmsScope)).toBeNull();
    expect(rowActions(abmsScope)).toEqual({ register: true, link: true, relink: false, unlink: false });
    expect(sampleRows(D, 'bcms').find((r) => r.code === 'DI-02')).toMatchObject({ state: 'missing', document: null });
    const adapter = createSampleAdapter(() => D);
    expect((await adapter.link('isms', 'PLN-01', 'PLN-02')).ok).toBe(true);
    const linked = (await adapter.list('isms'));
    expect(linked.ok && linked.data.find((r) => r.code === 'DI-06')).toMatchObject({ state: 'in_review', document: { code: 'PLN-02', linked: true } });
    expect(linked.ok && missingCount(linked.data)).toBe(missingCount(rows) - 1);
    const unknown = await adapter.link('isms', 'XYZ-9', 'PLN-02');
    expect(!unknown.ok && unknown.error.status).toBe(404);
    const noDoc = await adapter.link('isms', 'PLN-01', 'NOPE-1');
    expect(!noDoc.ok && noDoc.error.status).toBe(422);
    expect((await adapter.link('isms', 'PLN-01', null)).ok).toBe(true);
    expect(sampleRows(D, 'isms').find((r) => r.code === 'DI-06')?.state).toBe('missing');
    expect(adapter.documentId('isms', 'PLN-02')).toBe('PLN-02');
  });

  it('a link of PRC-04 makes both records that name it stand for the document, and the record keeps its evidence state', async () => {
    const D = await sampleD();
    const before = sampleRows(D, 'isms');
    const prc = before.filter((r) => r.templateCode === 'PRC-04');
    expect(prc.map((r) => [r.code, r.kind, r.templateDocument])).toEqual([['DI-03', 'retain', null], ['DI-04', 'retain', null]]);
    expect(prc.map(rowActions)).toEqual([{ register: true, link: true, relink: false, unlink: false }, { register: true, link: true, relink: false, unlink: false }]);
    const adapter = createSampleAdapter(() => D);
    expect((await adapter.link('isms', 'PRC-04', 'PRC-05')).ok).toBe(true);
    const after = sampleRows(D, 'isms').filter((r) => r.templateCode === 'PRC-04');
    expect(after.map((r) => r.templateDocument)).toEqual([
      { code: 'PRC-05', title: 'Asset & Information Handling Procedure', linked: true },
      { code: 'PRC-05', title: 'Asset & Information Handling Procedure', linked: true },
    ]);
    expect(after.map((r) => r.state)).toEqual(prc.map((r) => r.state));
    expect(after.map(rowActions)).toEqual([{ register: false, link: false, relink: true, unlink: true }, { register: false, link: false, relink: true, unlink: true }]);
    expect(missingCount(sampleRows(D, 'isms'))).toBe(missingCount(before));
    // A record whose template is a document of the system shows it, without a link (PLN-B01 of the BCMS).
    expect(sampleRows(D, 'bcms').find((r) => r.code === 'DI-06')?.templateDocument).toMatchObject({ code: 'PLN-B01', linked: false });
    // As in the api build, a record whose template code no activity expects and no row to maintain names offers no link.
    const objectives = sampleRows(D, 'isms').find((r) => r.code === 'DI-07')!;
    expect(objectives).toMatchObject({ templateCode: 'REG-01', templateLinkable: false });
    expect(rowActions(objectives).link).toBe(false);
    expect(sampleRows(D, 'isms').find((r) => r.code === 'DI-11')).toMatchObject({ templateCode: 'PLN-01', templateLinkable: true });
  });

  it('carries an Indonesian title for every sample row', () => {
    for (const [ms, tuples] of Object.entries(SAMPLE_INFO)) {
      for (const tuple of tuples) {
        expect(tuple[5], `${ms} ${tuple[0]}`).not.toBe('');
        expect(tuple[5], `${ms} ${tuple[0]}`).not.toBe(tuple[3]);
        expect(tuple[5], `${ms} ${tuple[0]}`).not.toMatch(FORBIDDEN);
        expect(tuple[5], `${ms} ${tuple[0]}`).not.toMatch(/\bshowing\b/);
      }
    }
  });

  it('the build picks the sample adapter in tests; the badge counts the missing items of the selected system', async () => {
    const D = await sampleD();
    const ctx = ctxOf('en', D);
    const res = await loadRows(adapterFor(null, () => D), 'isms');
    expect(res.rows?.length).toBe(15);
    const n = await loadMissingCount(ctx);
    expect(n).toBe(missingCount(sampleRows(D, 'isms')));
    const key = badgeKey(ctx)!;
    expect(key).toBe('ndt:isms');
    expect(badgeCount(ctx)).toBe(0);
    expect(setBadgeCount(key, n!)).toBe(true);
    expect(setBadgeCount(key, n!)).toBe(false);
    expect(badgeCount(ctx)).toBe(n);
    expect(screen.count?.(ctx)).toBe(n);
    expect(badgeCount(ctxOf('en', D, { msObj: null }))).toBe(0);
  });
});

describe('Required documented information views', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`renders the scope panel, the clause table and the link dialog in ${lang}, ${theme} theme`, async () => {
        const D = await sampleD();
        const ctx = ctxOf(lang, D, { theme });
        const rows = sampleRows(D, 'isms');
        const none = render(<ScopePanel ctx={ctx} ms="isms" rows={rows} canManage />, ctx, theme);
        expect(none).toContain(t(TEXT.noScope, lang));
        expect(none).toContain(t(TEXT.registerTemplate, lang));
        expect(none).toContain('Data centre &amp; managed services operations: Jakarta and Surabaya');
        expect(none).not.toContain(t(TEXT.linkExisting, lang));
        expect(render(<ScopePanel ctx={ctx} ms="isms" rows={rows} canManage onLink={() => undefined} />, ctx, theme)).toContain(t(TEXT.linkExisting, lang));
        expect(render(<ScopePanel ctx={ctx} ms="isms" rows={rows} canManage={false} onLink={() => undefined} />, ctx, theme)).not.toMatch(
          new RegExp(`${t(TEXT.registerTemplate, lang)}|${t(TEXT.linkExisting, lang)}`),
        );
        // An implementing document of clause 4.3 is not the scope statement (H.9).
        const abmsCtx = ctxOf(lang, D, { theme, msObj: D.MS.find((m) => m.id === 'abms') ?? null });
        const abms = render(<ScopePanel ctx={abmsCtx} ms="abms" rows={sampleRows(D, 'abms')} canManage onLink={() => undefined} />, abmsCtx, theme);
        expect(abms).toContain('data-scope="none"');
        expect(abms).toContain(t(TEXT.noScopeText, lang));
        expect(abms).toContain(t(TEXT.registerTemplate, lang));
        expect(abms).not.toContain('POL-A01');
        const approvedRows = rows.map((r) => (r.code === 'DI-01' ? { ...r, state: 'approved' as const, document: { id: 'POL-01', code: 'POL-01', title: 'Information Security Policy', status: 'approved', nextReviewAt: '2027-02-10', owner: 'hendra', linked: true } } : r));
        const approved = render(<ScopePanel ctx={ctx} ms="isms" rows={approvedRows} canManage />, ctx, theme);
        expect(approved).toContain('data-scope="approved"');
        expect(approved).toContain('v4.0');
        expect(approved).toContain('10 Feb 2026');
        const table = render(<ClauseTable ctx={ctx} ms="isms" rows={rows} canManage onLink={() => undefined} onUnlink={() => undefined} />, ctx, theme);
        expect(table).toContain(t(TEXT.colLinked, lang));
        expect(table).toContain(t(TEXT.linkExisting, lang));
        expect(table).toContain(t(STATE_TEXT.missing, lang));
        expect(table).toContain('POL-01');
        expect(table).toContain(lang === 'id' ? 'Proses penilaian risiko keamanan informasi' : 'Information security risk assessment process');
        const prcRow = { ...rows.find((r) => r.code === 'DI-03')!, templateDocument: { code: 'PRC-05', title: 'Asset handling', linked: true } };
        const record = render(<ClauseTable ctx={ctx} ms="isms" rows={[prcRow]} canManage onLink={() => undefined} onUnlink={() => undefined} />, ctx, theme);
        expect(record).toContain('data-template-doc="PRC-05"');
        expect(record).toContain(ctx.fill(TEXT.linkedTag, { code: 'PRC-04' }));
        expect(record).toContain(t(TEXT.changeLink, lang));
        expect(record).toContain(t(TEXT.removeLink, lang));
        const prcDialog = render(<LinkDialog ctx={ctx} ms="isms" row={rows.find((r) => r.code === 'DI-03')!} adapter={createSampleAdapter(() => D)} onClose={() => undefined} onLinked={() => undefined} />, ctx, theme);
        expect(prcDialog).toContain(ctx.fill(TEXT.linkTitle, { code: 'PRC-04' }));
        expect(render(<ClauseTable ctx={ctx} ms="isms" rows={rows} canManage={false} onLink={() => undefined} onUnlink={() => undefined} />, ctx, theme)).not.toContain(t(TEXT.colActions, lang));
        const adapter = createSampleAdapter(() => D);
        const dialog = render(<LinkDialog ctx={ctx} ms="isms" row={rows.find((r) => r.code === 'DI-06')!} adapter={adapter} onClose={() => undefined} onLinked={() => undefined} />, ctx, theme);
        expect(dialog).toContain(ctx.fill(TEXT.linkTitle, { code: 'PLN-01' }));
        expect(dialog).toContain('PLN-02');
        const empty = render(<LinkDialog ctx={ctxOf(lang, { ...D, bundles: { isms: { ...D.bundles.isms, docs: [] } } } as ControllerData)} ms="isms" row={rows[0]} adapter={adapter} onClose={() => undefined} onLinked={() => undefined} />, ctx, theme);
        expect(empty).toContain(t(TEXT.noDocs, lang));
        expect(none + table + dialog).not.toMatch(FORBIDDEN);
      });
    }
  }

  for (const lang of ['en', 'id'] as Lang[]) {
    it(`marks evidence whose file cannot be verified and keeps the state of the record (decision 8), ${lang}`, async () => {
      const D = await sampleD();
      const evs = D.bundles.isms.evs.slice(0, 5);
      const integs = ['changed', 'moved', 'missing', 'revoked', 'nohash'] as const;
      const marked = { ...D, bundles: { ...D.bundles, isms: { ...D.bundles.isms, evs: evs.map((e, i) => ({ ...e, integ: integs[i] })) } } } as unknown as ControllerData;
      const ctx = ctxOf(lang, marked);
      const record = row({ code: 'DI-12', requirementCode: '9.1', kind: 'retain', templateCode: 'REC-01', state: 'fresh', evidence: evs.map((e) => ({ code: e.code, title: e.title, fresh: 'fresh' })) });
      const html = render(<ClauseTable ctx={ctx} ms="isms" rows={[record]} canManage onLink={() => undefined} onUnlink={() => undefined} />, ctx);
      expect(html.match(/data-integrity="cannot"/g)?.length).toBe(4);
      expect(html).toContain(t(TEXT.cannotVerify, lang));
      expect(html).toContain(t(STATE_TEXT.fresh, lang));
      expect(cannotVerify('ok')).toBe(false);
      expect(cannotVerify('pending')).toBe(false);
      expect(cannotVerify(undefined)).toBe(false);
      expect(cannotVerify('moved')).toBe(true);
    });
  }

  it('Register from template opens New document prefilled with the template code, title and type', () => {
    registerFromTemplate('isms', row({}));
    expect(formRequest()).toMatchObject({ type: 'new', ms: 'isms', prefill: { docCode: 'SCO-01', title: 'Scope of the ISMS', docType: 'policy' } });
  });
});
