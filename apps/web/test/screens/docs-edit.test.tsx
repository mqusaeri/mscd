// The document control forms (MILESTONE-2 M2-12): routes against the shared table, the full-grant rules against the F.6
// matrix, the checks before Save (BR-16, BR-17, the New document fields), the api adapter over a fake fetch (method,
// path, body, If-Match, Idempotency-Key, X-CSRF-Token, refusals kept), the sample adapter on the sample data source
// (a new version goes to In review and another person approves it), the claims that open the forms, and the
// panel, the review panel and the forms in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_MATRIX, routeById } from '@mscd/shared';
import type { DocumentVersionItem, Permission } from '@mscd/shared';
import { ApiClient, CONNECTION_LOST } from '../../src/data/api/ApiClient';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { makeDates } from '../../src/data/dates.js';
import type { ControllerData, DataSource, UiRole } from '../../src/data/types';
import { claims, detailExtensions, docArgs, layerItems, newDocument, openReviewPanel } from '../../src/screens/docs-edit/actions';
import { adapterFor, deferredAdapter } from '../../src/screens/docs-edit/adapter';
import { createApiAdapter, fromVersion, patchBody, templatesOf } from '../../src/screens/docs-edit/api';
import DocPanel, { VersionItem, panelActions, stateHint } from '../../src/screens/docs-edit/DocPanel';
import Forms, { EditForm, NewDocumentForm, OwnerForm, ReassignForm, ReviewPanel, UploadForm, approveBlock, doneText, editChange } from '../../src/screens/docs-edit/Forms';
import {
  FULL_ROLES, approvalAuthorOf, br16Conflicts, checkNew, codeOfKey, createBody, dayOf, docOf, docTypeOfTemplate, hasVersion, holdsInFull, inReviewOf, mayActOn,
  needsConfirmation, nextVersionLabel, returnedOf,
} from '../../src/screens/docs-edit/model';
import type { DocRecord, NewDocumentInput, VersionRow } from '../../src/screens/docs-edit/model';
import { ROUTES, ROUTE_IDS } from '../../src/screens/docs-edit/routes';
import { createSampleAdapter, resetSampleDocs, sampleFacts, seedVersions } from '../../src/screens/docs-edit/sample';
import { closeForm, formRequest } from '../../src/screens/docs-edit/store';
import { CLASSIFICATIONS, DOC_TYPES, TEXT } from '../../src/screens/docs-edit/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';

const FORBIDDEN = /[—·]/;
const UUID = '3f4a5b6c-7d8e-4f9a-8b0c-1d2e3f4a5b6c';
const OBJECT = '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d';

/** The sample snapshot as the controller holds it (snapshot plus the date helpers). */
async function sampleData(ds = createSampleDataSource()): Promise<{ ds: DataSource; D: ControllerData; reload(): Promise<void> }> {
  const out = { ds: ds as unknown as DataSource, D: null as unknown as ControllerData, async reload() {} };
  const snap = await ds.load();
  out.D = { ...snap, ...makeDates(snap.today) } as unknown as ControllerData;
  out.reload = async () => {
    const next = await ds.reload(out.D, snap.MS.map((m: { id: string }) => m.id));
    out.D = { ...next, ...makeDates(snap.today) } as unknown as ControllerData;
  };
  return out;
}

/** The same snapshot with the refs of the api (uuid and ETag per document key). */
function withRefs(D: ControllerData): ControllerData {
  return { ...D, refs: { 'isms:doc:PRC-07': { module: 'implementation', entityType: 'document', id: UUID, code: 'PRC-07', etag: 'W/"1790000000000"' } } } as unknown as ControllerData;
}

function ctxOf(lang: Lang, D: ControllerData | null, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: D?.MS?.[0] ?? null, org: null, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'docs', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: async () => undefined, command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

/** An api session context: `roles` are the business roles in isms, `perms` the permissions of `Me`. */
function apiCtx(roles: string[], perms: string[], handle = 'rina', D: ControllerData | null = null): HostContext {
  return ctxOf('en', D, {
    mode: 'api', role: null,
    me: { user: { handle }, rolesByMs: { isms: roles } } as unknown as HostContext['me'],
    person: { handle, name: handle, jobTitle: '-' },
    can: (_ms, perm) => (Array.isArray(perm) ? perm : [perm]).some((p) => perms.includes(p as string)),
  });
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const t = (pair: readonly [string, string], lang: Lang) => pair[lang === 'id' ? 1 : 0];

const DOC: DocRecord = {
  id: 'PRC-07', title: 'Access Control Procedure', tier: 'Procedure', ver: '3.2', st: 'approved', appr: '2025-09-24', rev: '2026-09-24',
  owner: 'bagus', shared: false, ms: 'isms', approver: 'hendra',
};

const VERSION: DocumentVersionItem = {
  id: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e', label: '4.0', status: 'in_review', storageObjectId: OBJECT, submittedBy: 'bagus',
  submittedAt: '2026-10-20T03:00:00Z', approvedBy: null, approvedAt: null, rejectionNote: null, changeSummary: 'Quarterly access review',
};

afterEach(() => {
  resetSampleDocs();
  closeForm();
});

describe('Document control routes', () => {
  it('match the shared route table', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.create).permission).toBe('document.manage');
    expect(routeById(ROUTE_IDS.update).permission).toBe('document.manage');
    expect(routeById(ROUTE_IDS.addVersion).permission).toBe('document.version.create');
    expect(routeById(ROUTE_IDS.assign).permission).toBe('record.assign');
    expect(routeById(ROUTE_IDS.versions).permission).toBe('ms.read');
  });
});

describe('Document control rules', () => {
  it('full grants follow the F.6 matrix (the other roles hold the permission for their own records only)', () => {
    for (const [perm, roles] of Object.entries(FULL_ROLES)) {
      const grant = PERMISSION_MATRIX[perm as Permission];
      expect(grant.scope, perm).toBe('ms');
      expect([...roles].sort(), perm).toEqual([...grant.roles].sort());
    }
    expect(PERMISSION_MATRIX['document.version.create' as Permission].own).toContain('domain_owner');
  });

  it('holds a permission in full or for own documents', () => {
    const manager = apiCtx(['ms_manager'], ['document.manage', 'document.approve', 'document.version.create', 'record.assign']);
    const owner = apiCtx(['domain_owner'], ['document.version.create', 'document.review'], 'bagus');
    expect(holdsInFull(manager, 'isms', 'document.manage')).toBe(true);
    expect(holdsInFull(owner, 'isms', 'document.version.create')).toBe(false);
    expect(mayActOn(owner, 'isms', 'document.version.create', 'bagus')).toBe(true);
    expect(mayActOn(owner, 'isms', 'document.version.create', 'yusuf')).toBe(false);
    const sampleOwner = ctxOf('en', null, { role: 'owner', person: { handle: 'bagus', name: 'Bagus', jobTitle: '-' } });
    expect(holdsInFull(sampleOwner, 'isms', 'document.manage')).toBe(false);
    expect(mayActOn(sampleOwner, 'isms', 'document.version.create', 'bagus')).toBe(true);
  });

  it('infers the document type of a template code and labels the next version', () => {
    expect(['SCO-01', 'POL-A01', 'QM-01', 'STD-06', 'PRC-04', 'IMS-02', 'PLN-B01', 'REG-Q02', 'SOA-01', 'REC-04', 'FRM-01', 'XYZ-1'].map(docTypeOfTemplate))
      .toEqual(['policy', 'policy', 'policy', 'standard', 'procedure', 'procedure', 'plan', 'register', 'register', 'record', 'form', '']);
    expect(nextVersionLabel(['2.1', '3.2', 'v1'])).toBe('4.0');
    expect(nextVersionLabel([])).toBe('1.0');
  });

  it('checks BR-16 before Save: the owner as approver, or the submitter of the version in review', () => {
    expect(br16Conflicts('bagus', 'bagus', null)).toEqual(['same']);
    expect(br16Conflicts('bagus', 'yusuf', 'yusuf')).toEqual(['submitter']);
    expect(br16Conflicts('bagus', 'hendra', 'bagus')).toEqual([]);
    expect(br16Conflicts('bagus', '', 'bagus')).toEqual([]);
  });

  it('checks the New document fields and builds the request body', () => {
    const input: NewDocumentInput = {
      docCode: ' ', title: '', docType: '', ownerHandle: '', classification: 'internal', orgWide: false, linkedMs: ['isms'], origin: 'external', externalSource: '',
    };
    expect(checkNew(input)).toEqual({ docCode: 'required', title: 'required', docType: 'required', ownerHandle: 'required', externalSource: 'sourceRequired' });
    expect(checkNew({ ...input, docCode: ' ISP-001', title: 'x', docType: 'policy', ownerHandle: 'rina', origin: 'internal' })).toEqual({ docCode: 'codeFormat' });
    expect(checkNew({ ...input, docCode: 'X'.repeat(31), title: 'x'.repeat(256), docType: 'policy', ownerHandle: 'rina', origin: 'internal' })).toEqual({ docCode: 'codeFormat', title: 'titleLong' });
    const body = createBody({ ...input, docCode: 'ISP-001', title: ' Policy ', docType: 'policy', ownerHandle: 'rina', approverHandle: 'hendra', nextReviewAt: '2027-10-01', externalSource: 'Regulator', externalRef: '', receivedAt: '2026-10-01' });
    expect(body).toEqual({
      docCode: 'ISP-001', title: 'Policy', docType: 'policy', ownerHandle: 'rina', approverHandle: 'hendra', nextReviewAt: '2027-10-01', classification: 'internal', orgWide: false,
      linkedMs: ['isms'], origin: 'external', externalSource: 'Regulator', receivedAt: '2026-10-01',
    });
    expect(createBody({ ...input, docCode: 'A', title: 'B', docType: 'plan', ownerHandle: 'rina', origin: 'internal', externalSource: 'ignored', approverHandle: 'none' })).not.toHaveProperty('externalSource');
  });

  it('builds an edit from what differs only', () => {
    const v = { title: 'Access Control Procedure', classification: '', nextReviewAt: '2026-09-24', origin: 'internal' as const, externalSource: '', externalRef: '', receivedAt: '' };
    expect(editChange(DOC, v)).toEqual({});
    expect(editChange(DOC, { ...v, title: 'Access Control Procedure v4', classification: 'confidential', nextReviewAt: '' })).toEqual({ title: 'Access Control Procedure v4', classification: 'confidential', nextReviewAt: null });
    expect(editChange(DOC, { ...v, origin: 'external', externalSource: 'Bank Indonesia' })).toEqual({ origin: 'external', externalSource: 'Bank Indonesia' });
  });

  it('reads keys, dates and versions', () => {
    expect(codeOfKey('isms:doc:PRC-07')).toBe('PRC-07');
    expect(codeOfKey('isms:ev:EV-1')).toBeNull();
    expect(dayOf('2026-10-20T03:00:00Z')).toBe('2026-10-20');
    expect(hasVersion({ ver: '-' })).toBe(false);
    const rows = [fromVersion({ ...VERSION, status: 'rejected', rejectionNote: 'No' }), fromVersion({ ...VERSION, id: 'x', status: 'approved' })];
    expect(returnedOf(rows)?.rejectionNote).toBe('No');
    expect(inReviewOf(rows)).toBeNull();
    // BR-16: the author of the version in review, else (a review started without a new file) of the version in force.
    const inForce = fromVersion({ ...VERSION, id: 'f', status: 'approved', submittedBy: 'rina' });
    expect(approvalAuthorOf([fromVersion({ ...VERSION, id: 'n', status: 'in_review', submittedBy: 'bagus' }), inForce])).toBe('bagus');
    expect(approvalAuthorOf([fromVersion({ ...VERSION, id: 's', status: 'superseded', submittedBy: 'bagus' }), inForce])).toBe('rina');
    expect(approvalAuthorOf([inForce, fromVersion({ ...VERSION, id: 'o', status: 'superseded', submittedBy: 'bagus' })])).toBe('rina');
    expect(approvalAuthorOf([])).toBeNull();
    expect(approvalAuthorOf(null)).toBeNull();
    expect(needsConfirmation({ status: 409, slug: 'confirmation-required', message: ['a', 'b'] })).toBe(true);
    expect(needsConfirmation({ status: 409, slug: 'conflict', message: ['a', 'b'] })).toBe(false);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries(TEXT)) {
      expect(pair[0].trim(), key).not.toBe('');
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(FORBIDDEN);
    }
    // Pack lookup labels: some words are the same in both languages (Register, Internal).
    expect(DOC_TYPES.map((d) => d.value)).toEqual(['policy', 'standard', 'procedure', 'plan', 'register', 'record', 'form']);
    expect(CLASSIFICATIONS.map((c) => c.value)).toEqual(['public', 'internal', 'confidential', 'restricted']);
  });
});

describe('Document control API adapter', () => {
  const client = (routes: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(routes);
    const c = new ApiClient({ fetch: f.fetch });
    c.setCsrfToken('csrf-token-0123456789abcdef');
    return { ...f, client: c };
  };
  const D = withRefs({ bundles: { isms: { docs: [DOC] } } } as unknown as ControllerData);

  it('registers a document with POST, an idempotency key, the CSRF token and the body of the form', async () => {
    const f = client({ 'POST /api/v1/ms/isms/documents': json({ ok: true, changed: ['isms'], ref: { module: 'implementation', entityType: 'document', id: UUID, code: 'ISP-001' } }, 201) });
    const res = await createApiAdapter(f.client, () => D).create('isms', {
      docCode: 'ISP-001', title: 'Information Security Policy', docType: 'policy', ownerHandle: 'rina', classification: 'internal', orgWide: false, linkedMs: ['isms'], origin: 'internal',
    });
    expect(res.ok && res.data.changed).toEqual(['isms']);
    expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/ms/isms/documents', body: { docCode: 'ISP-001', docType: 'policy', origin: 'internal' } });
    expect(f.calls[0].headers['idempotency-key']).toBeTruthy();
    expect(f.calls[0].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
  });

  it('changes a document with If-Match and keeps the BR-22 question, then sends confirm', async () => {
    const question = problem(409, 'confirmation-required', { rule: 'BR-22', messages: { en: 'This change also applies to: QMS. Continue?', id: 'Perubahan ini juga berlaku untuk: QMS. Lanjutkan?' }, affected: ['qms'] });
    const f = client({ [`PATCH /api/v1/ms/isms/documents/${UUID}`]: [question, json({ ok: true, changed: ['isms', 'qms'] })] });
    const adapter = createApiAdapter(f.client, () => D);
    const first = await adapter.update('isms', 'PRC-07', { title: 'New title' }, false);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(needsConfirmation(first.error)).toBe(true);
      expect(first.error.message[0]).toContain('QMS');
    }
    const second = await adapter.update('isms', 'PRC-07', { title: 'New title' }, true);
    expect(second.ok && second.data.changed).toEqual(['isms', 'qms']);
    expect(f.calls[0].headers['if-match']).toBe('W/"1790000000000"');
    expect(f.calls[1].body).toEqual({ title: 'New title', confirm: true });
    expect(patchBody({ approverHandle: null, title: undefined }, false)).toEqual({ approverHandle: null });
  });

  it('approves and returns to draft with the transitions route; a refusal keeps its rule', async () => {
    const br16 = problem(422, 'business-rule', { rule: 'BR-16', messages: { en: 'A document cannot be approved by its own author.', id: 'Dokumen tidak dapat disetujui oleh penulisnya sendiri.' } });
    const f = client({ [`POST /api/v1/ms/isms/documents/${UUID}/transitions`]: [br16, json({ ok: true, changed: ['isms'] })] });
    const adapter = createApiAdapter(f.client, () => D);
    const refused = await adapter.transition('isms', 'PRC-07', 'approved');
    expect(!refused.ok && refused.error.rule).toBe('BR-16');
    const back = await adapter.transition('isms', 'PRC-07', 'draft', '  Section 4 needs the new roles ');
    expect(back.ok).toBe(true);
    expect(f.calls[0].body).toEqual({ to: 'approved' });
    expect(f.calls[1].body).toEqual({ to: 'draft', note: 'Section 4 needs the new roles' });
    expect(f.calls[1].headers['if-match']).toBe('W/"1790000000000"');
  });

  it('reassigns with records.assign (kind doc) and keeps the BR-41 warning', async () => {
    const f = client({ [`POST /api/v1/ms/isms/records/document/${UUID}/assignment`]: json({ ok: true, changed: ['isms'], warnings: [{ rule: 'BR-41', messages: { en: 'After the audit', id: 'Setelah audit' } }] }) });
    const res = await createApiAdapter(f.client, () => D).assign('isms', 'PRC-07', 'rina', '2026-11-30');
    expect(f.calls[0].body).toEqual({ kind: 'doc', holder: 'rina', dueAt: '2026-11-30' });
    expect(res.ok && res.data.warnings).toEqual([{ rule: 'BR-41', message: ['After the audit', 'Setelah audit'] }]);
  });

  it('adds a version from a link or an upload with its change summary', async () => {
    const f = client({ [`POST /api/v1/ms/isms/documents/${UUID}/versions`]: json({ ok: true, changed: ['isms'], message: ['PRC-07 v4.0 submitted for review', 'PRC-07 v4.0 diajukan untuk review'] }) });
    const adapter = createApiAdapter(f.client, () => D);
    const linked = await adapter.addVersion('isms', 'PRC-07', { source: 'link', repository: 'sp', externalItemId: 'demo-sp-doc-1', fileName: 'a.docx' }, '  Quarterly review ');
    expect(linked.ok && linked.data.message).toEqual(['PRC-07 v4.0 submitted for review', 'PRC-07 v4.0 diajukan untuk review']);
    await adapter.addVersion('isms', 'PRC-07', { source: 'upload', uploadIntentId: VERSION.id, fileName: 'a.pdf' }, '');
    expect(f.calls[0].body).toEqual({ source: 'link', repository: 'sp', externalItemId: 'demo-sp-doc-1', changeSummary: 'Quarterly review' });
    expect(f.calls[1].body).toEqual({ source: 'upload', uploadIntentId: VERSION.id });
    expect(f.calls[1].headers['idempotency-key']).toBeTruthy();
  });

  it('lists versions, opens a stored file and reads the templates of Required documented information', async () => {
    const f = client({
      [`GET /api/v1/ms/isms/documents/${UUID}/versions`]: json([VERSION]),
      [`GET /api/v1/storage/objects/${OBJECT}/open`]: json({ url: `/api/v1/storage/objects/${OBJECT}/redirect?t=abcdefghijklmnop`, expiresAt: '2026-10-28T06:05:00Z' }),
      'GET /api/v1/ms/isms/documented-information': json([
        { code: 'DI-01', requirementCode: '4.3', kind: 'maintain', title: 'Scope of the ISMS', templateCode: 'SCO-01', state: 'missing', document: null, evidence: [] },
        { code: 'DI-03', requirementCode: '6.1.2', kind: 'retain', title: 'Risk assessment', templateCode: 'PRC-04', state: 'missing', document: null, evidence: [] },
        { code: 'DI-04', requirementCode: '6.1.3', kind: 'retain', title: 'Risk treatment', templateCode: 'PRC-04', state: 'missing', document: null, evidence: [] },
        { code: 'DI-09', requirementCode: '8.1', kind: 'retain', title: 'Records', templateCode: null, state: 'missing', document: null, evidence: [] },
      ]),
    });
    const adapter = createApiAdapter(f.client, () => D);
    const versions = await adapter.versions('isms', 'PRC-07');
    expect(versions.ok && versions.data[0]).toEqual(fromVersion(VERSION));
    const opened = await adapter.openFile('isms', OBJECT);
    expect(opened.ok && opened.data.url).toContain('/redirect?t=');
    expect(f.calls[1].url).toContain('?ms=isms');
    const templates = await adapter.templates('isms');
    expect(templates.ok && templates.data).toEqual([
      { code: 'SCO-01', title: 'Scope of the ISMS', docType: 'policy' },
      { code: 'PRC-04', title: 'Risk assessment', docType: 'procedure' },
    ]);
    expect(templatesOf([])).toEqual([]);
    expect(adapter.recordId('isms', 'PRC-07')).toBe(UUID);
    // The output codes of the activities that no documented information row names follow, typed by their prefix.
    const acts = [
      { no: '2.4', title: 'Establish document control procedure', out: 'IMS-01' },
      { no: '4.1', title: 'Define risk assessment methodology', out: 'PRC-04' },
      { no: '5.8', title: 'Establish incident management process', out: 'PRC-13' },
      { no: '7.5', title: 'Handle incidents per procedure', out: 'PRC-13' },
      { no: '1.1', title: 'Secure top management mandate', out: null },
    ];
    const withActs = createApiAdapter(f.client, () => ({ ...D, bundles: { isms: { ...D.bundles.isms, phases: [{ no: 2, acts }] } } }) as unknown as ControllerData);
    const all = await withActs.templates('isms');
    expect(all.ok && all.data).toEqual([
      { code: 'SCO-01', title: 'Scope of the ISMS', docType: 'policy' },
      { code: 'PRC-04', title: 'Risk assessment', docType: 'procedure' },
      { code: 'IMS-01', title: '', docType: 'procedure', activity: { no: '2.4', title: 'Establish document control procedure' } },
      { code: 'PRC-13', title: '', docType: 'procedure', activity: { no: '5.8', title: 'Establish incident management process' } },
    ]);
  });

  it('answers 404 without a request for a document the snapshot has no ref for', async () => {
    const f = client({});
    const adapter = createApiAdapter(f.client, () => D);
    const res = await adapter.transition('isms', 'NOPE-1', 'approved');
    expect(!res.ok && res.error.status).toBe(404);
    expect(!res.ok && res.error.message).toEqual([...TEXT.noRecordId]);
    expect(f.calls).toHaveLength(0);
    expect(adapter.recordId('isms', 'NOPE-1')).toBeNull();
  });
});

describe('Document control sample adapter', () => {
  it('seeds the version in force, a draft version, and nothing for a document without one', () => {
    expect(seedVersions(DOC, null)).toMatchObject([{ label: '3.2', status: 'approved', submittedBy: 'bagus', approvedBy: 'hendra', approvedAt: '2025-09-24' }]);
    expect(seedVersions({ ...DOC, st: 'draft', appr: '' }, null)).toMatchObject([{ label: '3.2', status: 'draft', approvedAt: null }]);
    expect(seedVersions({ ...DOC, ver: '-' }, null)).toEqual([]);
  });

  it('a new version goes to In review; its author cannot approve it; another person approves it', async () => {
    const data = await sampleData();
    let me = 'bagus';
    const adapter = createSampleAdapter(() => data.D, data.ds, () => me);
    const added = await adapter.addVersion('isms', 'STD-05', { source: 'link', repository: 'sp', externalItemId: 'picker-sp-1', fileName: 'Log.xlsx' }, 'Retention raised to 12 months');
    expect(added.ok && added.data.message).toEqual(['STD-05 v2.0 submitted for review', 'STD-05 v2.0 diajukan untuk review']);
    await data.reload();
    expect(docOf(data.D, 'isms', 'STD-05')?.st).toBe('review');
    const twice = await adapter.addVersion('isms', 'STD-05', { source: 'link', repository: 'sp', externalItemId: 'picker-sp-1', fileName: 'Log.xlsx' });
    expect(!twice.ok && twice.error.status).toBe(409);
    const versions = await adapter.versions('isms', 'STD-05');
    expect(versions.ok && versions.data.map((v) => [v.label, v.status, v.submittedBy, v.changeSummary])).toEqual([
      ['2.0', 'in_review', 'bagus', 'Retention raised to 12 months'], ['1.1', 'approved', 'bagus', null],
    ]);
    const own = await adapter.transition('isms', 'STD-05', 'approved');
    expect(!own.ok && own.error.rule).toBe('BR-16');
    me = 'rina';
    const approved = await adapter.transition('isms', 'STD-05', 'approved');
    expect(approved.ok).toBe(true);
    await data.reload();
    expect(docOf(data.D, 'isms', 'STD-05')).toMatchObject({ st: 'approved', ver: '2.0', appr: data.D.TODAY_S });
    const after = await adapter.versions('isms', 'STD-05');
    expect(after.ok && after.data.map((v) => [v.label, v.status, v.approvedBy])).toEqual([['2.0', 'approved', 'rina'], ['1.1', 'superseded', 'hendra']]);
  });

  it('returns a version to draft with its note', async () => {
    const data = await sampleData();
    const adapter = createSampleAdapter(() => data.D, data.ds, () => 'bagus');
    await adapter.addVersion('isms', 'PRC-09', { source: 'upload', uploadIntentId: 'sample-upload-1', fileName: 'x.pdf' });
    await data.reload();
    const back = await adapter.transition('isms', 'PRC-09', 'draft', 'Add the rollback step');
    expect(back.ok).toBe(true);
    await data.reload();
    expect(docOf(data.D, 'isms', 'PRC-09')?.st).toBe('draft');
    const versions = await adapter.versions('isms', 'PRC-09');
    expect(versions.ok && returnedOf(versions.data)?.rejectionNote).toBe('Add the rollback step');
  });

  it('a review started with the Milestone 1 command still reaches In review and approval through its override', async () => {
    const data = await sampleData();
    const adapter = createSampleAdapter(() => data.D, data.ds, () => 'bagus');
    await data.ds.startReview('isms:doc:STD-04');
    await data.ds.uploadFile('isms:doc:PRC-10', null);
    await data.reload();
    expect(docOf(data.D, 'isms', 'PRC-10')).toMatchObject({ st: 'approved', ver: '3.0' });
    const added = await adapter.addVersion('isms', 'PRC-10', { source: 'upload', uploadIntentId: 'sample-upload-2', fileName: 'x.pdf' });
    expect(added.ok).toBe(true);
    await data.reload();
    expect(docOf(data.D, 'isms', 'PRC-10')?.st).toBe('review');
    const other = createSampleAdapter(() => data.D, data.ds, () => 'rina');
    expect((await other.transition('isms', 'PRC-10', 'approved')).ok).toBe(true);
    await data.reload();
    expect(docOf(data.D, 'isms', 'PRC-10')).toMatchObject({ st: 'approved', ver: '4.0' });
  });

  it('registers a document, refuses a code twice, and asks before changing a shared document', async () => {
    const data = await sampleData();
    const adapter = createSampleAdapter(() => data.D, data.ds, () => 'rina');
    const input: NewDocumentInput = {
      docCode: 'SCO-01', title: 'Scope of the ISMS', docType: 'policy', ownerHandle: 'bagus', classification: 'internal', orgWide: false, linkedMs: ['isms'], origin: 'external', externalSource: 'Head office',
    };
    expect((await adapter.create('isms', input)).ok).toBe(true);
    await data.reload();
    expect(docOf(data.D, 'isms', 'SCO-01')).toMatchObject({ st: 'draft', ver: '-', tier: 'Policy', owner: 'bagus', origin: 'external' });
    expect(sampleFacts('isms', 'SCO-01')).toMatchObject({ classification: 'internal', externalSource: 'Head office' });
    const again = await adapter.create('isms', input);
    expect(!again.ok && again.error.status).toBe(409);
    const shared = await adapter.update('isms', 'IMS-01', { title: 'Document Control Procedure v4' }, false);
    expect(!shared.ok && needsConfirmation(shared.error)).toBe(true);
    expect(!shared.ok && shared.error.message[0]).toBe('This change also applies to: QMS, BCMS, ABMS. Continue?');
    const confirmed = await adapter.update('isms', 'IMS-01', { title: 'Document Control Procedure v4' }, true);
    expect(confirmed.ok && confirmed.data.changed).toEqual(['isms', 'qms', 'bcms', 'abms']);
    await data.reload();
    expect(docOf(data.D, 'qms', 'IMS-01')?.title).toBe('Document Control Procedure v4');
    const templates = await adapter.templates('isms');
    expect(templates.ok && templates.data.slice(0, 2)).toEqual([{ code: 'SCO-01', title: 'Scope of the ISMS', docType: 'policy' }, { code: 'POL-01', title: 'Information security policy', docType: 'policy' }]);
    // The activity outputs of the sample ISMS that no documented information row names (IMS-01 to IMS-04, PRC-07, ...).
    const outputs = templates.ok ? templates.data.filter((o) => o.activity).map((o) => [o.code, o.docType]) : [];
    expect(outputs).toEqual(expect.arrayContaining([['IMS-01', 'procedure'], ['IMS-04', 'procedure'], ['PRC-13', 'procedure']]));
    expect(templates.ok && new Set(templates.data.map((o) => o.code)).size).toBe(templates.ok && templates.data.length);
    expect(adapter.recordId('isms', 'POL-01')).toBe('POL-01');
    const file = await adapter.openFile('isms', 'x');
    expect(file.ok).toBe(false);
  });

  it('reassigns through the sample data source', async () => {
    const data = await sampleData();
    const adapter = createSampleAdapter(() => data.D, data.ds, () => 'rina');
    expect((await adapter.assign('isms', 'PLN-02', 'rina', '2026-10-30')).ok).toBe(true);
    await data.reload();
    const item = data.D.bundles.isms.chain.items.find((i) => i.key === 'isms:doc:PLN-02');
    expect(item).toMatchObject({ h: 'rina', due: '2026-10-30' });
  });

  it('the build picks the sample adapter in tests; a failed module load answers Connection lost and retries', async () => {
    const data = await sampleData();
    const adapter = adapterFor(null, data.ds, () => data.D, () => 'rina');
    expect(adapter.recordId('isms', 'POL-01')).toBe('POL-01');
    expect((await adapter.versions('isms', 'POL-01')).ok).toBe(true);
    let calls = 0;
    const flaky = deferredAdapter(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('chunk')) : Promise.resolve(createSampleAdapter(() => data.D, data.ds, () => 'rina'));
    }, () => null);
    const failed = await flaky.versions('isms', 'POL-01');
    expect(!failed.ok && failed.error.message).toEqual(CONNECTION_LOST);
    expect((await flaky.versions('isms', 'POL-01')).ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('Document control claims', () => {
  it('registers every claim, the doc extension and the layer item', () => {
    expect(Object.keys(claims ?? {}).sort()).toEqual(['docs.continueDraft', 'docs.new', 'docs.openReview', 'mytasks.openDoc']);
    expect(detailExtensions?.map((e) => [e.id, e.kind])).toEqual([['docs-edit.doc', 'doc']]);
    expect(layerItems?.map((l) => l.id)).toEqual(['docs-edit.forms']);
  });

  it('New document: the form for an MS Manager; a refusal for anyone else', async () => {
    const { D } = await sampleData();
    const ctx = ctxOf('en', D);
    newDocument(ctx, { ms: 'isms' });
    expect(ctx.toast).not.toHaveBeenCalled();
    expect(formRequest()).toMatchObject({ type: 'new', ms: 'isms' });
    closeForm();
    const owner = ctxOf('id', D, { role: 'owner' as UiRole });
    newDocument(owner, { ms: 'isms' });
    expect(owner.toast).toHaveBeenCalledWith('Hanya MS Manager sistem ini yang mendaftarkan dokumen.');
    expect(formRequest()).toBeNull();
  });

  it('Open review, Continue draft and Open document open the review panel of the document', async () => {
    const { D } = await sampleData();
    const ctx = ctxOf('en', D);
    const doc = docOf(D, 'isms', 'PLN-02')!;
    claims!['docs.openReview']!(ctx, { ms: 'isms', key: 'isms:doc:PLN-02', record: doc });
    expect(formRequest()).toMatchObject({ type: 'review', ms: 'isms', code: 'PLN-02' });
    claims!['docs.continueDraft']!(ctx, { ms: 'isms', key: 'isms:doc:SOA-01' });
    expect(formRequest()).toMatchObject({ type: 'review', ms: 'isms', code: 'SOA-01' });
    openReviewPanel(ctx, { ms: 'isms', key: 'isms:doc:STD-04' });
    expect(formRequest()).toMatchObject({ type: 'review', ms: 'isms', code: 'STD-04' });
    expect(ctx.toast).not.toHaveBeenCalled();
    expect(docArgs(ctx, {})).toBeNull();
  });
});

describe('Document control views', () => {
  it('offers the actions of the session: manager, owner of the document, another owner, top management', () => {
    const manager = apiCtx(['ms_manager'], ['document.manage', 'document.approve', 'document.version.create', 'record.assign', 'storage.object.read']);
    const owner = apiCtx(['domain_owner'], ['document.version.create'], 'bagus');
    const top = apiCtx(['top_management'], ['ms.read']);
    const ids = (ctx: HostContext, doc: DocRecord) => panelActions(ctx, 'isms', doc).map((a) => [a.id, a.label[0]]);
    expect(ids(manager, DOC)).toEqual([['edit', 'Edit'], ['owner', 'Change owner or approver'], ['upload', 'Upload with change summary']]);
    expect(ids(manager, { ...DOC, st: 'review' })).toEqual([['edit', 'Edit'], ['owner', 'Change owner or approver'], ['reassign', 'Reassign']]);
    expect(ids(owner, { ...DOC, st: 'draft', ver: '-' })).toEqual([['upload', 'Attach first version']]);
    expect(ids(owner, { ...DOC, st: 'expired' })).toEqual([['upload', 'Upload new version']]);
    expect(ids(owner, { ...DOC, owner: 'yusuf' })).toEqual([]);
    expect(ids(top, DOC)).toEqual([]);
    expect(stateHint({ st: 'draft', ver: '-' })).toBe(TEXT.hintDraftEmpty);
    expect(stateHint({ st: 'review', ver: '1.0' })).toBe(TEXT.hintReview);
  });

  it('Approve is blocked for the author of the version and for someone without the approval right', () => {
    const manager = apiCtx(['ms_manager'], ['document.approve']);
    const owner = apiCtx(['domain_owner'], ['document.version.create'], 'bagus');
    expect(approveBlock(manager, 'isms', 'bagus')).toBeNull();
    expect(approveBlock(manager, 'isms', 'rina')).toBe(TEXT.youSubmitted);
    expect(approveBlock(owner, 'isms', 'bagus')).toBe(TEXT.youSubmitted);
    expect(approveBlock(owner, 'isms', 'rina')).toBe(TEXT.noApproveRight);
    // A review started without a new file: the author of the version in force cannot approve it either.
    const inForce: VersionRow[] = [{ ...fromVersion(VERSION), status: 'approved', submittedBy: 'rina' }];
    expect(approveBlock(manager, 'isms', approvalAuthorOf(inForce))).toBe(TEXT.youSubmitted);
    expect(approveBlock(manager, 'isms', approvalAuthorOf([{ ...inForce[0], submittedBy: 'bagus' }]))).toBeNull();
  });

  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`renders the panel, a version, the review panel and the forms in ${lang}, ${theme} theme`, async () => {
        const { D } = await sampleData();
        const ctx = ctxOf(lang, D, { theme });
        const panel = render(<DocPanel ctx={ctx} kind="doc" ms="isms" recordKey="isms:doc:PRC-07" record={docOf(D, 'isms', 'PRC-07')} close={() => undefined} />, ctx, theme);
        expect(panel).toContain(t(TEXT.panelTitle, lang));
        expect(panel).toContain(t(TEXT.tabVersions, lang));
        expect(panel).toContain(t(TEXT.edit, lang));
        expect(panel).toContain(t(TEXT.uploadNew, lang));
        const version: VersionRow = { ...fromVersion(VERSION), status: 'rejected', rejectionNote: 'Section 4' };
        const item = render(<ul><VersionItem ctx={ctx} version={version} onOpen={() => undefined} /></ul>, ctx, theme);
        expect(item).toContain('v4.0');
        expect(item).toContain(t(TEXT.vRejected, lang));
        expect(item).toContain('Quarterly access review');
        expect(item).toContain('Section 4');
        expect(item).toContain(t(TEXT.openFile, lang));
        const doc = docOf(D, 'isms', 'PLN-02')!;
        const review = render(<ReviewPanel ctx={ctx} ms="isms" doc={doc} onClose={() => undefined} />, ctx, theme);
        expect(review).toContain(ctx.fill(TEXT.reviewTitle, { code: 'PLN-02' }));
        expect(review).toContain(t(TEXT.approve, lang));
        const draft = render(<ReviewPanel ctx={ctx} ms="isms" doc={docOf(D, 'isms', 'SOA-01')!} onClose={() => undefined} />, ctx, theme);
        expect(draft).toContain(ctx.fill(TEXT.draftTitle, { code: 'SOA-01' }));
        const form = render(<NewDocumentForm ctx={ctx} request={{ type: 'new', ms: 'isms', prefill: { docCode: 'SCO-01', title: 'Scope of the ISMS', docType: 'policy' }, at: 1 }} />, ctx, theme);
        expect(form).toContain(t(TEXT.newTitle, lang));
        expect(form).toContain('value="SCO-01"');
        expect(form).toContain(t(TEXT.register, lang));
        for (const node of [
          <EditForm key="e" ctx={ctx} ms="isms" doc={doc} onClose={() => undefined} />,
          <OwnerForm key="o" ctx={ctx} ms="isms" doc={{ ...doc, approver: 'bagus' }} onClose={() => undefined} />,
          <ReassignForm key="r" ctx={ctx} ms="isms" doc={doc} onClose={() => undefined} />,
          <UploadForm key="u" ctx={ctx} request={{ type: 'upload', ms: 'isms', code: 'PLN-02', file: { source: 'upload', uploadIntentId: 'x', fileName: 'Plan.pdf' }, first: false, at: 1 }} doc={doc} onClose={() => undefined} />,
        ]) {
          const html = render(node, ctx, theme);
          expect(html).toContain('role="dialog"');
          expect(html).not.toMatch(FORBIDDEN);
        }
        expect(render(<OwnerForm ctx={ctx} ms="isms" doc={{ ...doc, approver: 'bagus' }} onClose={() => undefined} />, ctx, theme)).toContain(t(TEXT.br16Same, lang));
        const gone = render(<Forms ctx={ctx} request={{ type: 'review', ms: 'isms', code: 'NOPE-9', at: 1 }} />, ctx, theme);
        expect(gone).toContain(t(TEXT.gone, lang));
        expect(panel + review + form).not.toMatch(FORBIDDEN);
      });
    }
  }

  it('the toast of a write carries the server message and the warnings', async () => {
    const ctx = ctxOf('id', null);
    expect(doneText(ctx, 'Disimpan', { changed: [], warnings: [{ rule: 'BR-41', message: ['After', 'Setelah audit'] }] })).toBe('Disimpan Setelah audit');
    expect(doneText(ctx, 'x', { changed: [], warnings: [], message: ['Sent', 'Terkirim'] })).toBe('Terkirim');
  });
});
