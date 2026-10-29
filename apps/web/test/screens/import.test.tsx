// The Import screen (MILESTONE-2 M2-08): routes against the shared table, the form and the results in both languages
// and themes, the api adapter over a fake fetch (multipart upload, the commit with X-CSRF-Token, refusals kept), the
// sample adapter (CSV check and import against the sample snapshot), the rules of the screen (kinds by permission,
// filters, when "Import N rows" is available) and the page action of Controls & requirements and Document register.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_MATRIX, routeById } from '@mscd/shared';
import type { ImportRun, Permission } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/import/index';
import { extraPageActions } from '../../src/screens/import/actions';
import { createApiAdapter } from '../../src/screens/import/api';
import { FULL_ROLES, IMPORT_KINDS, KIND_PERMS, OWN_RECORD_KINDS, filterRows, importBlocked, mayImport, rowsToImport } from '../../src/screens/import/model';
import { ROUTES, ROUTE_IDS, pathOf } from '../../src/screens/import/routes';
import { checkSample, createSampleAdapter, parseCsv, resetSampleImports } from '../../src/screens/import/sample';
import ImportScreen, { ImportResults, allowedKinds, deferredAdapter } from '../../src/screens/import/Screen';
import { KIND_TEXT, TEXT } from '../../src/screens/import/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData, DataSource } from '../../src/data/types';
import { MS, PEOPLE, TODAY_S, buildDocs, buildReqs } from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { fakeFetch, json, problem } from '../auth/helpers';

const FORBIDDEN = /[\u2014\u00b7]/;
const ISMS = MS.find((m: { id: string }) => m.id === 'isms')!;
const D = {
  ...makeDates(TODAY_S), MS, PEOPLE, TODAY_S, bundles: { isms: { reqs: buildReqs(ISMS), docs: buildDocs(ISMS), evs: [] } },
} as unknown as ControllerData;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: ISMS, org: null, me: null, person: { handle: 'rina', name: 'Rina', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'import', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: async () => undefined, command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const RUN: ImportRun = {
  id: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e', kind: 'applicability', fileName: 'soa-2026.xlsx', status: 'validated', rowCount: 3,
  counts: { ok: 1, warning: 1, error: 1 },
  results: [
    { row: 1, status: 'ok', messages: [], code: 'A.5.1', action: 'update' },
    { row: 2, status: 'warning', messages: [{ en: 'The exclusion justification does not look meaningful.', id: 'Justifikasi pengecualian tampaknya tidak bermakna.' }], code: 'A.5.2', action: 'update' },
    { row: 3, status: 'error', messages: [{ en: 'Owner: nobody is not an active member of this organisation.', id: 'Pemilik: nobody bukan anggota aktif organisasi ini.' }], code: 'A.5.3' },
  ],
  createdAt: '2026-10-28T03:00:00Z', committedAt: null, taskId: null,
};
const CLEAN: ImportRun = { ...RUN, counts: { ok: 1, warning: 1, error: 0 }, results: RUN.results.slice(0, 2), rowCount: 2 };

afterEach(() => resetSampleImports());

describe('Import routes', () => {
  it('match the shared route table', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.create).permissionBy?.member).toBe('kind');
    expect(routeById(ROUTE_IDS.get).permission).toBe('ms.read');
    expect(routeById(ROUTE_IDS.commit).permission).toBe('ms.read');
    const cases = routeById(ROUTE_IDS.create).permissionBy!.cases as Record<string, { permission: string }>;
    for (const kind of IMPORT_KINDS) expect((cases[kind] ?? cases['*'])!.permission).toBe(KIND_PERMS[kind]);
    expect(pathOf(ROUTES.get, { ms: 'isms', id: 'a b' })).toBe('/api/v1/ms/isms/imports/a%20b');
  });

  it('registers the screen in the Implementation group with the four permissions', () => {
    expect(screen).toMatchObject({ id: 'import', path: '/ms/:ms/import', group: 'impl', scope: 'ms', roles: ['manager'] });
    expect(screen.perm).toEqual(['applicability.manage', 'document.manage', 'risk.manage', 'evidence.manage']);
  });
});

describe('Import rules', () => {
  it('offers the kinds the session may manage, in screen order', () => {
    const adapter = { kinds: IMPORT_KINDS };
    expect(allowedKinds(ctxOf('en'), adapter, 'isms')).toEqual(['applicability', 'documents', 'risks', 'evidence']);
    const owner = ctxOf('en', { can: (_ms: unknown, perm: unknown) => perm === 'evidence.manage' } as Partial<HostContext>);
    expect(allowedKinds(owner, adapter, 'isms')).toEqual(['evidence']);
    expect(allowedKinds(ctxOf('en'), { kinds: ['applicability', 'documents'] }, 'isms')).toEqual(['applicability', 'documents']);
    expect(allowedKinds(ctxOf('en'), adapter, null)).toEqual([]);
  });

  it('offers a kind only when its permission is held in full, or for evidence also for own records (F.6)', () => {
    const adapter = { kinds: IMPORT_KINDS };
    const holding = (held: string[]) => (_ms: unknown, perm: unknown) => held.includes(String(perm));
    // Me.permissions lists permissions held for own records too: a Risk Owner holds risk.manage and evidence.manage so.
    const riskOwner = ctxOf('en', { mode: 'api', can: holding(['risk.manage', 'evidence.manage']), me: { rolesByMs: { isms: ['risk_owner'] } } } as unknown as Partial<HostContext>);
    expect(allowedKinds(riskOwner, adapter, 'isms')).toEqual(['evidence']);
    const manager = ctxOf('en', { mode: 'api', me: { rolesByMs: { isms: ['risk_owner', 'ms_manager'] } } } as unknown as Partial<HostContext>);
    expect(allowedKinds(manager, adapter, 'isms')).toEqual(['applicability', 'documents', 'risks', 'evidence']);
    const otherSystem = ctxOf('en', { mode: 'api', me: { rolesByMs: { qms: ['ms_manager'], isms: ['domain_owner'] } } } as unknown as Partial<HostContext>);
    expect(allowedKinds(otherSystem, adapter, 'isms')).toEqual(['evidence']);
    // The lists follow the shared matrix: ms-scoped rows that only business roles grant, own records only for evidence.
    for (const kind of IMPORT_KINDS) {
      const grant = PERMISSION_MATRIX[KIND_PERMS[kind] as Permission];
      expect(grant.scope).toBe('ms');
      expect([grant.orgRoles, grant.anyMsRoles, grant.platformRoles, grant.tenancy]).toEqual([[], [], [], undefined]);
      expect([...FULL_ROLES[kind]].sort()).toEqual([...grant.roles].sort());
      for (const role of grant.roles) expect(mayImport(kind, true, [role])).toBe(true);
      for (const role of grant.own) expect(mayImport(kind, true, [role])).toBe(OWN_RECORD_KINDS.includes(kind));
      expect(mayImport(kind, false, [...grant.roles])).toBe(false);
    }
  });

  it('filters rows and keeps "Import N rows" for a file without errors and with something to import', () => {
    expect(filterRows(RUN.results, 'error').map((r) => r.row)).toEqual([3]);
    expect(filterRows(RUN.results, 'warning').map((r) => r.row)).toEqual([2]);
    expect(filterRows(RUN.results, 'all')).toHaveLength(3);
    expect(rowsToImport(RUN)).toBe(2);
    expect(importBlocked(RUN)).toBe('errors');
    expect(importBlocked(CLEAN)).toBeNull();
    expect(importBlocked({ ...CLEAN, results: CLEAN.results.map((r) => ({ ...r, action: 'unchanged' as const })) })).toBe('nothing');
    expect(importBlocked({ ...CLEAN, status: 'expired' })).toBe('expired');
  });

  it('adds "Import" to Controls & requirements and Document register in both builds, with the kind of the screen', () => {
    expect(extraPageActions.map((a) => [a.screen, a.id])).toEqual([['controls', 'controls.import'], ['docs', 'docs.import']]);
    const go = vi.fn();
    const api = ctxOf('en', { mode: 'api', go, can: (_ms: unknown, perm: unknown) => perm === 'applicability.manage' } as Partial<HostContext>);
    expect(extraPageActions.map((a) => a.visible!(api))).toEqual([true, false]);
    // The sample build: the manager persona holds every permission, the other personas none of the kinds.
    expect(extraPageActions.map((a) => a.visible!(ctxOf('en')))).toEqual([true, true]);
    expect(extraPageActions.map((a) => a.visible!(ctxOf('en', { role: 'owner', can: () => false })))).toEqual([false, false]);
    expect(extraPageActions[0]!.visible!(ctxOf('en', { mode: 'api', msObj: null }))).toBe(false);
    expect(extraPageActions[0]!.visible!(ctxOf('en', { msObj: null }))).toBe(false);
    extraPageActions[0]!.run(api);
    expect(go).toHaveBeenCalledWith('import', { params: { kind: 'applicability', at: expect.any(Number) } });
    expect(extraPageActions[0]!.label).toEqual(['Import', 'Impor']);
  });
});

describe('Import views', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`show the form and the results in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf(lang);
        const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
        const form = render(<ImportScreen ctx={ctx} />, ctx, theme);
        for (const text of [TEXT.fileCard, TEXT.kind, TEXT.template, TEXT.file, TEXT.check, TEXT.chooseFirst, KIND_TEXT.applicability, KIND_TEXT.documents]) {
          expect(form).toContain(t(text).replace(/&/g, '&amp;'));
        }
        // The sample build imports controls and documents.
        expect(form).not.toContain(t(KIND_TEXT.risks));

        const blocked = render(<ImportResults ctx={ctx} run={RUN} committing={false} commitError={null} onCommit={vi.fn()} onReset={vi.fn()} />, ctx, theme);
        expect(blocked).toContain(t(TEXT.results));
        expect(blocked).toContain(lang === 'id' ? '1 dengan kesalahan' : '1 with an error');
        expect(blocked).toContain(t(TEXT.blockedByErrors));
        expect(blocked).toContain(lang === 'id' ? 'Impor 2 baris' : 'Import 2 rows');
        expect(blocked).toContain(lang === 'id' ? 'Pemilik: nobody bukan anggota aktif organisasi ini.' : 'Owner: nobody is not an active member of this organisation.');
        // The errors are shown first: the warning row is behind its filter.
        expect(blocked).not.toContain('A.5.2');
        expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(Import 2 rows|Impor 2 baris)/);

        const ready = render(<ImportResults ctx={ctx} run={CLEAN} committing={false} commitError={null} onCommit={vi.fn()} onReset={vi.fn()} />, ctx, theme);
        expect(ready).toContain(t(TEXT.warningsNote));
        expect(ready).toContain('A.5.2');
        expect(ready).not.toContain(t(TEXT.blockedByErrors));

        const running = render(<ImportResults ctx={ctx} run={{ ...CLEAN, status: 'committing', progress: 40, taskId: RUN.id }} committing={false} commitError={null} onCommit={vi.fn()} onReset={vi.fn()} />, ctx, theme);
        expect(running).toContain(lang === 'id' ? '40% selesai' : '40% done');

        const done = render(<ImportResults ctx={ctx} run={{ ...CLEAN, status: 'committed', progress: 100, summary: { created: 0, updated: 2, unchanged: 0 }, changed: ['isms'] }} committing={false} commitError={null} onCommit={vi.fn()} onReset={vi.fn()} />, ctx, theme);
        expect(done).toContain(t(TEXT.finished));
        expect(done).toContain(lang === 'id' ? '0 dibuat, 2 diubah, 0 dibiarkan apa adanya.' : '0 created, 2 changed, 0 left as they were.');
        expect(done).toContain(lang === 'id' ? 'Buka Kontrol &amp; persyaratan' : 'Open Controls &amp; requirements');

        const failed = render(<ImportResults ctx={ctx} run={{ ...CLEAN, status: 'failed', failure: { en: 'Row 2 (A.5.2): A.5.2 changed after the file was checked.', id: 'Baris 2 (A.5.2): A.5.2 berubah setelah berkas diperiksa.' } }} committing={false} commitError={null} onCommit={vi.fn()} onReset={vi.fn()} />, ctx, theme);
        expect(failed).toContain(t(TEXT.failed));
        expect(failed).toContain(lang === 'id' ? 'Baris 2 (A.5.2)' : 'Row 2 (A.5.2)');

        for (const html of [form, blocked, ready, running, done, failed]) expect(html).not.toMatch(FORBIDDEN);
      });
    }
  }

  it('shows why nothing can be imported without a system or a permission', () => {
    expect(render(<ImportScreen ctx={ctxOf('en', { msObj: null })} />, ctxOf('en'))).toContain(TEXT.noSystem[0]);
    const none = ctxOf('en', { can: () => false });
    expect(render(<ImportScreen ctx={none} />, none)).toContain(TEXT.noKindsText[0]);
  });

  it('keeps every text pair in both languages, Indonesian different from English where a word differs', () => {
    for (const [key, pair] of Object.entries({ ...TEXT, ...KIND_TEXT })) {
      expect(pair, key).toHaveLength(2);
      expect(pair[0], key).not.toMatch(FORBIDDEN);
      expect(pair[1], key).not.toMatch(FORBIDDEN);
    }
    expect(TEXT.importRows[1]).not.toBe(TEXT.importRows[0]);
  });
});

describe('Import api adapter', () => {
  it('uploads the file as multipart, reads the import and commits it with the CSRF token', async () => {
    const committed = { ok: true, changed: [], taskId: '6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f', message: ['Importing 2 rows', 'Mengimpor 2 baris'] };
    const f = fakeFetch({
      'POST /api/v1/ms/isms/imports/applicability': json(RUN, 201),
      [`GET /api/v1/ms/isms/imports/${RUN.id}`]: json({ ...RUN, status: 'committing', progress: 40 }),
      [`POST /api/v1/ms/isms/imports/${RUN.id}/commit`]: json(committed, 202),
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client);
    expect(adapter.kinds).toEqual(IMPORT_KINDS);
    const file = new File(['ID\nA.5.1\n'], 'soa.csv', { type: 'text/csv' });
    const checked = await adapter.check('isms', 'applicability', file);
    expect(checked).toEqual({ ok: true, data: RUN });
    expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/ms/isms/imports/applicability' });
    expect(f.calls[0]!.body).toBeInstanceOf(FormData);
    const sent = (f.calls[0]!.body as FormData).get('file') as File;
    expect(sent.name).toBe('soa.csv');
    expect(await sent.text()).toBe('ID\nA.5.1\n');
    expect(f.calls[0]!.headers['content-type']).toBeUndefined();
    expect(f.calls[0]!.headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    expect(await adapter.get('isms', RUN.id)).toMatchObject({ ok: true, data: { status: 'committing', progress: 40 } });
    expect(await adapter.commit('isms', RUN.id)).toEqual({ ok: true, data: committed });
    expect(f.calls[2]).toMatchObject({ method: 'POST', path: `/api/v1/ms/isms/imports/${RUN.id}/commit` });
    expect(f.calls[2]!.headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    expect(await adapter.template('isms', 'documents', 'en')).toEqual({ href: '/api/v1/ms/isms/imports/templates/documents?lang=en', fileName: 'isms-import-documents.xlsx' });
    // The app language goes with the link, so the help sheet follows the app, whatever the browser's language.
    expect((await adapter.template('isms', 'risks', 'id')).href).toBe('/api/v1/ms/isms/imports/templates/risks?lang=id');
  });

  it('keeps the refusals of the api with their messages', async () => {
    const f = fakeFetch({
      'POST /api/v1/ms/isms/imports/documents': problem(422, 'business-rule', { messageKey: 'imports.header_mismatch', messages: { en: 'The header row does not match the template.', id: 'Baris judul tidak sesuai dengan templat.' } }),
      [`POST /api/v1/ms/isms/imports/${RUN.id}/commit`]: problem(422, 'business-rule', { messageKey: 'imports.rows_with_errors', messages: { en: '1 row has an error.', id: '1 baris memiliki kesalahan.' } }),
    });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    const refused = await adapter.check('isms', 'documents', new File(['x'], 'docs.csv'));
    expect(refused).toMatchObject({ ok: false, error: { status: 422, messageKey: 'imports.header_mismatch', message: ['The header row does not match the template.', 'Baris judul tidak sesuai dengan templat.'] } });
    expect(await adapter.commit('isms', RUN.id)).toMatchObject({ ok: false, error: { status: 422, messageKey: 'imports.rows_with_errors' } });
  });

  it('loads the sample adapter once, and again after a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(createSampleAdapter(() => D, () => null));
    const adapter = deferredAdapter(['applicability', 'documents'], load);
    await expect(adapter.get('isms', 'x')).rejects.toThrow('offline');
    expect(await adapter.get('isms', 'x')).toMatchObject({ ok: false, error: { status: 404 } });
    await adapter.get('isms', 'y');
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('Import sample adapter', () => {
  it('parses CSV with quotes, separators and line breaks', () => {
    expect(parseCsv('\uFEFFID,Justification\r\nA.5.1,"Needed, as ""policy"" says"\nA.5.2,"two\nlines"\n')).toEqual([
      ['ID', 'Justification'], ['A.5.1', 'Needed, as "policy" says'], ['A.5.2', 'two\nlines'],
    ]);
    expect(parseCsv('ID;Owner\nA.5.1;rina')).toEqual([['ID', 'Owner'], ['A.5.1', 'rina']]);
  });

  it('checks a Statement of Applicability against the sample system', () => {
    const csv = [
      'ID,Applicable,Justification,Owner,Status note',
      'A.5.1,Yes,Required by risk treatment; see linked risks.,Rina Kusuma,',
      'A.5.2,No,N/A,bagus,',
      'A.99.9,Yes,,rina,',
      'A.5.3,,,nobody,',
      "A.5.4,,'=SUM(1),,Reviewed",
    ].join('\n');
    const checked = checkSample(D, 'isms', 'applicability', 'soa.csv', csv);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const { run, planned } = checked.data;
    expect(run.counts).toEqual({ ok: 2, warning: 1, error: 2 });
    expect(run.results.map((r) => [r.row, r.status, r.action])).toEqual([
      [1, 'ok', 'unchanged'], [2, 'warning', 'update'], [3, 'error', undefined], [4, 'error', undefined], [5, 'ok', 'update'],
    ]);
    expect(run.results[2]!.messages[0]!.en).toBe('A.99.9 is not a control or clause of this system.');
    expect(planned[1]!.apply).toEqual({ kind: 'req', id: 'A.5.2', patch: { st: 'na', just: 'N/A', owner: 'bagus' } });
    expect(planned[4]!.apply).toMatchObject({ kind: 'req', id: 'A.5.4', patch: { just: '=SUM(1)', note: 'Reviewed' } });

    const header = checkSample(D, 'isms', 'documents', 'docs.csv', 'Code,Name\nX,Y');
    expect(header).toMatchObject({ ok: false, error: { status: 422 } });
    if (!header.ok) expect(header.error.message[0]).toBe('The header row does not match the template. Columns that are not in the template: Code, Name. Required columns missing: ID, Title, Type.');
  });

  it('imports the checked rows into the sample snapshot, controls and documents', async () => {
    const mutate = vi.fn(async () => ({ ok: true, changed: ['isms'] }));
    const insert = vi.fn(async () => ({ ok: true, changed: ['isms'] }));
    const ds = { mutate, insert } as unknown as DataSource;
    const adapter = createSampleAdapter(() => D, () => ds);
    expect(adapter.kinds).toEqual(['applicability', 'documents']);
    const xlsx = await adapter.check('isms', 'applicability', new File(['x'], 'soa.xlsx'));
    expect(xlsx).toMatchObject({ ok: false, error: { status: 422, message: TEXT.sampleCsvOnly } });

    const soa = await adapter.check('isms', 'applicability', new File(['ID,Owner\nA.5.1,bagus\n'], 'soa.csv'));
    expect(soa.ok).toBe(true);
    if (!soa.ok) return;
    const committed = await adapter.commit('isms', soa.data.id);
    expect(committed).toMatchObject({ ok: true, data: { ok: true, changed: ['isms'] } });
    expect(mutate).toHaveBeenCalledWith('isms', 'req', 'A.5.1', { owner: 'bagus' });
    expect(await adapter.get('isms', soa.data.id)).toMatchObject({ ok: true, data: { status: 'committed', summary: { created: 0, updated: 1, unchanged: 0 }, progress: 100 } });
    expect(await adapter.commit('isms', soa.data.id)).toMatchObject({ ok: false, error: { status: 409 } });

    const docs = await adapter.check('isms', 'documents', new File(['ID,Title,Type,Owner,Next review\nPOL-01,Policy,Policy,,\nPRC-77,Remote work,Procedure,dewi,2027-01-31\n'], 'docs.csv'));
    expect(docs).toMatchObject({ ok: true, data: { counts: { ok: 1, warning: 1, error: 0 } } });
    if (!docs.ok) return;
    await adapter.commit('isms', docs.data.id);
    expect(insert).toHaveBeenCalledWith('isms', 'doc', { id: 'PRC-77', title: 'Remote work', tier: 'Procedure', ver: '-', st: 'draft', appr: '', rev: '2027-01-31', owner: 'dewi', shared: false, ms: 'isms' });

    const blocked = await adapter.check('isms', 'documents', new File(['ID,Title,Type\nPRC-78,,\n'], 'bad.csv'));
    if (!blocked.ok) throw new Error('check failed');
    expect(await adapter.commit('isms', blocked.data.id)).toMatchObject({ ok: false, error: { status: 422 } });
    const template = await adapter.template('isms', 'documents', 'id');
    expect(template.fileName).toBe('isms-import-documents.csv');
    expect(template.href).toMatch(/^blob:/);
    template.release?.();
  });
});
