// Findings and actions (MILESTONE-2 M2-14): routes against the shared table, the forms and permission helpers, the API
// adapter over a fake fetch (paths, bodies, If-Match, Idempotency-Key, CSRF, refusals and field errors kept), the
// sample adapter with BR-06, BR-07, BR-08 and BR-09 and its state per organisation, the open findings extension of
// `req`, and the views in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_MATRIX, routeById } from '@mscd/shared';
import type { CertificationCycleItem, CorrectiveActionItem, FindingItem, SelfAssessmentItem } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import screen from '../../src/screens/findings/index';
import meta from '../../src/screens/findings/meta.json';
import { detailExtensions } from '../../src/screens/findings/actions';
import { adapterFor } from '../../src/screens/findings/adapter';
import { createApiAdapter, eventsOfCycles, fromActionItem, fromFindingItem } from '../../src/screens/findings/api';
import {
  actionErrors, actionPatch, assessBody, assessErrors, assessFormOf, closeNeedsNote, editFormOf, editPatch, emptyRaise, evidenceCodes, mayStep,
  raiseBody, raiseErrors, stepIndex, verifyBlock,
} from '../../src/screens/findings/model';
import type { FindingsAdapter, SelfRow } from '../../src/screens/findings/model';
import { ActionDrawer, ActionsList } from '../../src/screens/findings/ActionsTab';
import { FindingDrawer, FindingsList, clauseOf, filterFindings } from '../../src/screens/findings/FindingsTab';
import { RaiseDialog } from '../../src/screens/findings/RaiseDialog';
import { ROUTES, ROUTE_IDS } from '../../src/screens/findings/routes';
import { createSampleAdapter, resetSampleAudit } from '../../src/screens/findings/sample';
import { AssessDialog, SelfList } from '../../src/screens/findings/SelfTab';
import { OWN_SCOPED, codeOfRequirement, nextCode, outcomeOf, outcomeText } from '../../src/screens/findings/shared';
import { TEXT } from '../../src/screens/findings/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';

const snapshot = await createSampleDataSource().load();
const D = { ...makeDates(SAMPLE.TODAY_S), ...snapshot, TODAY_S: SAMPLE.TODAY_S } as unknown as ControllerData;
const bsdSnapshot = await createSampleDataSource({ org: 'bsd' }).load();
const bsd = { ...makeDates(SAMPLE.TODAY_S), ...bsdSnapshot, TODAY_S: SAMPLE.TODAY_S } as unknown as ControllerData;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: D.MS[0], org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'findings', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const REF = { module: 'audit', entityType: 'finding', id: '0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f', code: 'IA-2026-01', etag: 'W/"1790000000000"' } as const;
const CA_REF = { module: 'audit', entityType: 'corrective_action', id: '1d2e3f4a-5b6c-4d7e-9f8a-9b0c1d2e3f4a', code: 'CA-2026-01', etag: 'W/"1790000000001"' } as const;
const FINDING: FindingItem = {
  ref: REF, code: 'IA-2026-01', title: 'Risk treatment plan not approved', classification: 'major', source: 'internal_audit', clauseRef: '6.1.3', targetCode: '6.1.3',
  status: 'open', owner: 'rina', raisedAt: '2026-09-15', dueAt: '2026-11-13', auditEvent: { id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', shortLabel: 'IA 2026' },
  correctiveActions: [{ ref: CA_REF, code: 'CA-2026-01', status: 'action' }],
};
const ACTION: CorrectiveActionItem = {
  ref: CA_REF, code: 'CA-2026-01', title: 'Approve the plan', status: 'effectiveness_verification', owner: 'bagus', dueAt: null, correctionText: 'a', rcaText: 'b',
  systemicCheckText: 'c', actionText: 'd', implementedAt: '2026-09-20', implementedBy: 'dewi', verifiedAt: null, verifiedBy: null, effective: null, findings: [{ ref: REF, code: 'IA-2026-01' }],
};
const SELF: SelfAssessmentItem = {
  ref: { module: 'audit', entityType: 'self_assessment', id: '2e3f4a5b-6c7d-4e8f-8a9b-0c1d2e3f4a5b', code: 'FC-04' }, conditionCode: 'FC-04', classification: 'minor',
  requirementCode: '7.5', text: 'Controlled document used after its review date', status: 'gap', owner: 'bagus', targetFixAt: '2026-10-31', note: null, assessedAt: '2026-09-01', evidence: [], findingCode: null,
};
const page = <T,>(items: T[]) => ({ items, page: 1, pageSize: 200, total: items.length });

afterEach(() => resetSampleAudit());

describe('findings routes', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.findingsCreate).permission).toBe('finding.raise');
    expect(routeById(ROUTE_IDS.findingsUpdate).permission).toBe('finding.manage');
    expect(routeById(ROUTE_IDS.actionsCreate).permission).toBe('corrective_action.manage');
    expect(routeById(ROUTE_IDS.selfUpdate).permission).toBe('self_assessment.manage');
    expect(routeById(ROUTE_IDS.selfRaise).permission).toBe('finding.raise');
    expect(routeById(ROUTE_IDS.findingsList).permission).toBe('ms.read');
  });

  it('the own-scoped list matches the F.6 matrix: corrective_action.update in full for MS Managers only', () => {
    for (const [perm, roles] of Object.entries(OWN_SCOPED)) {
      const grant = PERMISSION_MATRIX[perm as keyof typeof PERMISSION_MATRIX];
      expect([...grant.roles].sort(), perm).toEqual([...roles].sort());
      expect(grant.own.length, perm).toBeGreaterThan(0);
    }
  });
});

describe('forms and rules of the screen', () => {
  it('checks the raise form and builds FindingCreate with the target code and the audit event', () => {
    const form = { ...emptyRaise({ source: 'internal_audit', auditEventId: 'e1' }), code: 'IA-2026-04', title: ' Access log gaps ', classification: 'minor' as const, owner: 'bagus', targetCode: 'A.8.15', dueAt: '2026-12-01' };
    expect(raiseErrors(form, [])).toEqual({});
    expect(raiseBody(form)).toEqual({ code: 'IA-2026-04', title: 'Access log gaps', classification: 'minor', source: 'internal_audit', targetCode: 'A.8.15', auditEventId: 'e1', ownerHandle: 'bagus', dueAt: '2026-12-01' });
    expect(raiseErrors({ ...form, code: 'IA-2026-04' }, ['IA-2026-04'])).toEqual({ code: TEXT.codeTaken });
    expect(raiseErrors({ ...emptyRaise(), code: 'X'.repeat(31) }, [])).toEqual({ code: TEXT.badCode, title: TEXT.required, classification: TEXT.required, owner: TEXT.required });
    expect(raiseBody({ ...form, targetCode: '', auditEventId: '', dueAt: '', clauseRef: ' 8.8 / A.8.8 ' })).toEqual({ code: 'IA-2026-04', title: 'Access log gaps', classification: 'minor', source: 'internal_audit', clauseRef: '8.8 / A.8.8', ownerHandle: 'bagus' });
  });

  it('the edit patch holds only what changed, and clears the target with null', () => {
    const f = fromFindingItem(FINDING);
    expect(editPatch(editFormOf(f), f)).toBeNull();
    expect(editPatch({ ...editFormOf(f), targetCode: '', dueAt: '', classification: 'minor' }, f)).toEqual({ classification: 'minor', targetCode: null, dueAt: null });
  });

  it('OFI, signals and not a finding close with a note; nonconformities through a corrective action (BR-08)', () => {
    expect(['major', 'minor', 'ofi', 'signal', 'not_a_finding'].map((c) => closeNeedsNote({ classification: c as 'major' }))).toEqual([false, false, true, true, true]);
  });

  it('the assessment form needs an owner and a target date for a gap and sends the evidence codes', () => {
    const row: SelfRow = { id: null, conditionCode: 'FC-03', classification: 'minor', requirementCode: '6.1', text: 't', status: 'not_assessed', owner: null, targetFixAt: null, note: null, assessedAt: null, evidence: [], findingCode: null };
    const form = assessFormOf(row);
    expect(form.status).toBe('conforming');
    expect(assessErrors({ ...form, status: 'gap' })).toEqual({ owner: TEXT.gapNeedsOwner, targetFixAt: TEXT.gapNeedsDate });
    expect(evidenceCodes('EV-0130, EV-0133 EV-0130;')).toEqual(['EV-0130', 'EV-0133']);
    expect(assessBody({ ...form, status: 'gap', owner: 'bagus', targetFixAt: '2026-11-30', note: ' fix ', evidence: 'EV-0130' }))
      .toEqual({ status: 'gap', ownerHandle: 'bagus', targetFixAt: '2026-11-30', note: 'fix', evidenceCodes: ['EV-0130'] });
    expect(assessBody({ ...form, targetFixAt: '2026-11-30' })).toEqual({ status: 'conforming', evidenceCodes: [] });
  });

  it('corrective action forms: findings, a free code, the patch of what changed', () => {
    const a = fromActionItem(ACTION);
    expect(actionErrors({ findingIds: [], code: 'CA-2025-02', title: '', owner: '', dueAt: '' }, ['CA-2025-02'], true))
      .toEqual({ findingIds: TEXT.pickFinding, code: TEXT.codeTaken, title: TEXT.required, owner: TEXT.required });
    expect(actionPatch({ findingIds: [REF.id], code: a.code, title: a.title, owner: 'bagus', dueAt: '' }, a)).toBeNull();
    expect(actionPatch({ findingIds: [REF.id, 'f2'], code: a.code, title: 'New', owner: 'dewi', dueAt: '2026-12-01' }, a))
      .toEqual({ title: 'New', ownerHandle: 'dewi', dueAt: '2026-12-01', findingIds: [REF.id, 'f2'].sort() });
    expect([stepIndex('correction'), stepIndex('action'), stepIndex('effectiveness_verification'), stepIndex('closed')]).toEqual([0, 3, 4, 5]);
  });

  it('BR-09: the implementer and the owner never check effectiveness; the right is needed', () => {
    const a = fromActionItem(ACTION);
    const api = (handle: string, roles: string[], perms: string[]) => ctxOf('en', {
      mode: 'api', me: { user: { handle }, rolesByMs: { isms: roles } } as never, can: (_ms, p) => (Array.isArray(p) ? p : [p]).some((x) => perms.includes(x as string)),
    });
    expect(verifyBlock(api('maya', ['internal_auditor'], ['corrective_action.verify']), 'isms', a)).toBeNull();
    expect(verifyBlock(api('dewi', ['ms_manager'], ['corrective_action.verify']), 'isms', a)).toEqual(TEXT.verifyImplementer);
    expect(verifyBlock(api('bagus', ['ms_manager'], ['corrective_action.verify']), 'isms', a)).toEqual(TEXT.verifyOwner);
    expect(verifyBlock(api('fajar', ['domain_owner'], []), 'isms', a)).toEqual(TEXT.verifyNoRight);
    // Steps: manage, or update in full (MS Manager), or update as the owner (Domain Owner).
    expect(mayStep(api('bagus', ['domain_owner'], ['corrective_action.update']), 'isms', a)).toBe(true);
    expect(mayStep(api('fajar', ['domain_owner'], ['corrective_action.update']), 'isms', a)).toBe(false);
    expect(mayStep(api('rina', ['ms_manager'], ['corrective_action.update']), 'isms', a)).toBe(true);
  });

  it('codes, clauses and toasts', () => {
    expect(nextCode('IA', '2026', ['IA-2026-01', 'IA-2026-07', 'NC-2026-09', 'IA-2025-12'])).toBe('IA-2026-08');
    expect(nextCode('MR', '2026', ['MR-2025'], true)).toBe('MR-2026');
    expect(nextCode('MR', '2026', ['MR-2026'], true)).toBe('MR-2026-01');
    expect([codeOfRequirement('Cl. 5.1'), codeOfRequirement('A.5.18'), codeOfRequirement(undefined)]).toEqual(['5.1', 'A.5.18', '']);
    expect(clauseOf({ targetCode: null, clauseRef: '8.8 / A.8.8' })).toBe('8.8 / A.8.8');
    const ctx = ctxOf('en');
    expect(outcomeText(ctx, { changed: [], warnings: [] }, 'Saved')).toBe('Saved');
    expect(outcomeText(ctx, { changed: [], warnings: [{ rule: 'AUD-INDEP', message: ['Owns work.', 'Milik.'] }] }, 'Saved')).toBe('Saved. Owns work.');
    expect(outcomeOf({ ok: true, status: 200, data: { ok: true, changed: ['isms'], warnings: [{ rule: 'BR-41', messages: { en: 'a', id: 'b' } }], ref: CA_REF, count: 2 } }))
      .toEqual({ ok: true, data: { changed: ['isms'], warnings: [{ rule: 'BR-41', message: ['a', 'b'] }], count: 2, ref: { id: CA_REF.id, code: CA_REF.code, etag: CA_REF.etag } } });
  });

  it('filters findings: open and in progress first by due date, all, closed, by classification', () => {
    const f = fromFindingItem(FINDING);
    const rows = [{ ...f, id: 'a', status: 'closed' as const }, { ...f, id: 'b', dueAt: '2026-12-01' }, { ...f, id: 'c', dueAt: '2026-10-01', classification: 'minor' as const }];
    expect(filterFindings(rows, 'open', '').map((r) => r.id)).toEqual(['c', 'b']);
    expect(filterFindings(rows, 'all', '').map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(filterFindings(rows, 'closed', '').map((r) => r.id)).toEqual(['a']);
    expect(filterFindings(rows, 'all', 'minor').map((r) => r.id)).toEqual(['c']);
  });
});

describe('the API adapter', () => {
  const ms = 'isms';

  it('reads every page of findings with the target code filter and keeps the texts it saved', async () => {
    const f = fakeFetch({
      'GET /api/v1/ms/isms/findings': [json({ items: [FINDING], page: 1, pageSize: 1, total: 2 }), json({ items: [{ ...FINDING, ref: { ...REF, id: 'f2' }, code: 'IA-2026-02' }], page: 2, pageSize: 1, total: 2 })],
      'PATCH /api/v1/ms/isms/findings/0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f': json({ ok: true, changed: ['isms'], ref: REF }),
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client, () => 'ndt');
    const res = await adapter.findings(ms, { targetCode: 'A.5.18' });
    expect(res.ok && res.data.map((x) => x.code)).toEqual(['IA-2026-01', 'IA-2026-02']);
    expect(new URL(f.calls[0].url, 'http://x').searchParams.get('targetCode')).toBe('A.5.18');
    expect(new URL(f.calls[1].url, 'http://x').searchParams.get('page')).toBe('2');
    const first = res.ok ? res.data[0] : null;
    expect(first?.rcaText).toBeUndefined();
    await adapter.update(ms, first!, { rcaText: 'Approval step missing' });
    expect(f.calls[2]).toMatchObject({ method: 'PATCH', body: { rcaText: 'Approval step missing' } });
    expect(f.calls[2].headers['if-match']).toBe(REF.etag);
    expect(f.calls[2].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
  });

  it('keeps the saved texts for the browser session: a new adapter of the organisation shows them, another organisation does not', async () => {
    const page1 = () => json({ items: [FINDING], page: 1, pageSize: 200, total: 1 });
    const routes: Parameters<typeof fakeFetch>[0] = {
      'GET /api/v1/ms/isms/findings': [page1(), page1(), page1()],
      'PATCH /api/v1/ms/isms/findings/0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f': json({ ok: true, changed: ['isms'], ref: REF }),
    };
    const f = fakeFetch(routes);
    const client = new ApiClient({ fetch: f.fetch });
    await createApiAdapter(client, () => 'org-texts').update(ms, fromFindingItem(FINDING), { rcaText: 'No approval step', systemicCheckText: 'Checked the other plans' });
    // The screen builds a new adapter each time it opens (and the Internal audit screen has its own).
    const again = await createApiAdapter(client, () => 'org-texts').findings(ms);
    expect(again.ok && again.data[0]).toMatchObject({ rcaText: 'No approval step', systemicCheckText: 'Checked the other plans' });
    const other = await createApiAdapter(client, () => 'org-other').findings(ms);
    expect(other.ok && other.data[0].rcaText).toBeUndefined();
    // Texts the item carries win over the saved ones.
    routes['GET /api/v1/ms/isms/findings'] = [json({ items: [{ ...FINDING, rcaText: 'From the server', systemicCheckText: null }], page: 1, pageSize: 200, total: 1 })];
    const carried = await createApiAdapter(client, () => 'org-texts').findings(ms);
    expect(carried.ok && carried.data[0]).toMatchObject({ rcaText: 'From the server', systemicCheckText: null });
  });

  it('raises with the Idempotency-Key, moves with If-Match and keeps rule refusals and field errors', async () => {
    const f = fakeFetch({
      'POST /api/v1/ms/isms/findings': [problem(400, 'validation', { errors: [{ path: 'body.targetCode', message: 'Invalid code' }] }), json({ ok: true, changed: ['isms'], ref: REF }, 201)],
      'POST /api/v1/ms/isms/findings/0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f/transitions': problem(422, 'business-rule', { rule: 'BR-06', messages: { en: 'A major finding cannot be closed without a root cause analysis.', id: 'Temuan mayor tidak dapat ditutup tanpa analisis akar masalah.' } }),
    });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    const body = { code: 'IA-2026-04', title: 't', classification: 'minor' as const, source: 'internal_audit' as const, ownerHandle: 'bagus', targetCode: 'X' };
    const bad = await adapter.raise(ms, body, 'key-1');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error.errors).toEqual([{ path: 'body.targetCode', message: 'Invalid code' }]);
    const good = await adapter.raise(ms, body, 'key-1');
    expect(good.ok && good.data.ref?.code).toBe('IA-2026-01');
    expect(f.calls[1].headers['idempotency-key']).toBe('key-1');
    const moved = await adapter.move(ms, fromFindingItem(FINDING), { to: 'closed' });
    expect(!moved.ok && [moved.error.rule, moved.error.message[0]]).toEqual(['BR-06', 'A major finding cannot be closed without a root cause analysis.']);
    expect(f.calls[2]).toMatchObject({ method: 'POST', body: { to: 'closed' } });
    expect(f.calls[2].headers['if-match']).toBe(REF.etag);
  });

  it('corrective actions, the self-assessment, targets and events', async () => {
    const cycle: CertificationCycleItem = {
      id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', status: 'certified', cycleStart: '2025-03-14', cycleEnd: '2028-03-13', certificateNo: null, certifiedAt: null, certificateExpiresAt: null,
      certificationBody: null, certifiedScope: null, items: { total: 0, done: 0 }, etag: 'W/"1"',
      events: [
        { id: 'e1', eventType: 'stage2', shortLabel: 'Stage 2', scheduledAt: '2025-03-10', outcome: 'recommended', scopeText: null, reportDocumentId: null },
        { id: 'e2', eventType: 'internal_audit', shortLabel: 'IA 2026', scheduledAt: '2026-09-14', outcome: null, scopeText: 'x', reportDocumentId: null },
      ],
    };
    const f = fakeFetch({
      'GET /api/v1/ms/isms/corrective-actions': json(page([ACTION])),
      'POST /api/v1/ms/isms/corrective-actions': json({ ok: true, changed: ['isms'], ref: CA_REF }, 201),
      'POST /api/v1/ms/isms/corrective-actions/1d2e3f4a-5b6c-4d7e-9f8a-9b0c1d2e3f4a/transitions': json({ ok: true, changed: ['isms'], ref: CA_REF }),
      'GET /api/v1/ms/isms/self-assessments': json(page([SELF, { ...SELF, ref: null, conditionCode: 'FC-05', status: 'not_assessed' }])),
      'PUT /api/v1/ms/isms/self-assessments/FC-04': json({ ok: true, changed: ['isms'] }),
      'POST /api/v1/ms/isms/self-assessments/2e3f4a5b-6c7d-4e8f-8a9b-0c1d2e3f4a5b/raise-finding': json({ ok: true, changed: ['isms'], ref: { ...REF, code: 'SA-2026-01' } }, 201),
      'GET /api/v1/ms/isms/applicability/targets': json([
        { kind: 'catalogue_item', code: 'A.5.18', title: 'Access rights', clauseGroup: '8', hasEntry: true, retired: false, assessable: true, documentedInfo: false },
        { kind: 'requirement', code: '10.3', title: 'Continual improvement', clauseGroup: '10', hasEntry: true, retired: true, assessable: false, documentedInfo: false },
      ]),
      'GET /api/v1/ms/isms/certification-cycles': json([cycle]),
    });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    const actions = await adapter.actions(ms);
    expect(actions.ok && actions.data[0]).toMatchObject({ code: 'CA-2026-01', implementedBy: 'dewi', findings: [{ id: REF.id, code: 'IA-2026-01' }], etag: CA_REF.etag });
    await adapter.createAction(ms, { findingIds: [REF.id], code: 'CA-2026-02', title: 't', ownerHandle: 'bagus' }, 'key-2');
    expect(f.calls[1]).toMatchObject({ method: 'POST', body: { findingIds: [REF.id], code: 'CA-2026-02', title: 't', ownerHandle: 'bagus' } });
    expect(f.calls[1].headers['idempotency-key']).toBe('key-2');
    await adapter.moveAction(ms, fromActionItem(ACTION), { to: 'closed', effective: true, note: 'checked' });
    expect(f.calls[2]).toMatchObject({ body: { to: 'closed', effective: true, note: 'checked' } });
    expect(f.calls[2].headers['if-match']).toBe(CA_REF.etag);
    const self = await adapter.selfAssessment(ms);
    expect(self.ok && self.data.map((r) => [r.conditionCode, r.id])).toEqual([['FC-04', SELF.ref!.id], ['FC-05', null]]);
    const rows = self.ok ? self.data : [];
    await adapter.assess(ms, rows[0], { status: 'conforming', evidenceCodes: ['EV-0130'] });
    expect(f.calls[4]).toMatchObject({ method: 'PUT', path: '/api/v1/ms/isms/self-assessments/FC-04', body: { status: 'conforming', evidenceCodes: ['EV-0130'] } });
    const raised = await adapter.raiseFromGap(ms, rows[0], { classification: 'minor' }, 'key-3');
    expect(raised.ok && raised.data.ref?.code).toBe('SA-2026-01');
    expect((await adapter.raiseFromGap(ms, rows[1], { classification: 'minor' }, 'key-4')).ok).toBe(false);
    const targets = await adapter.targets(ms);
    expect(targets.ok && targets.data).toEqual([{ code: 'A.5.18', title: 'Access rights', kind: 'catalogue_item' }]);
    const events = await adapter.events(ms);
    expect(events.ok && events.data.map((e) => e.id)).toEqual(['e2', 'e1']);
    expect(eventsOfCycles([cycle, cycle])).toHaveLength(2);
  });
});

describe('the sample adapter', () => {
  const scope = (data: ControllerData, org: string, me = 'rina') => ({ getD: () => data, org: () => org, me: () => me });

  it('seeds the findings of the sample: PAST and the internal findings that make MS.findings', async () => {
    const adapter = createSampleAdapter(scope(D, 'ndt'));
    for (const ms of D.MS) {
      const res = await adapter.findings(ms.id);
      const open = res.ok ? res.data.filter((f) => f.status !== 'closed') : [];
      expect([open.length, open.filter((f) => f.classification === 'major').length], ms.id).toEqual([ms.findings.open, ms.findings.major]);
    }
    const isms = await adapter.findings('isms');
    expect(isms.ok && isms.data.map((f) => f.code)).toEqual(['NC-2025-01', 'NC-2025-02', 'OFI-2025-01', 'IA-2026-01', 'IA-2026-02']);
    const byTarget = await adapter.findings('isms', { targetCode: 'A.5.18' });
    expect(byTarget.ok && byTarget.data.map((f) => f.code)).toEqual(['IA-2026-02']);
  });

  it('closes a major finding only with its texts and an effective corrective action (BR-06, BR-07, BR-08); BR-09 on the check', async () => {
    const adapter = createSampleAdapter(scope(D, 'ndt'));
    const find = async (code: string) => ((await adapter.findings('isms')) as { data: { code: string }[] }).data.find((f) => f.code === code) as never;
    const major = await find('IA-2026-01');
    expect(await adapter.move('isms', major, { to: 'closed' })).toMatchObject({ ok: false, error: { rule: 'BR-06' } });
    await adapter.update('isms', major, { rcaText: 'root' });
    expect(await adapter.move('isms', major, { to: 'closed' })).toMatchObject({ ok: false, error: { rule: 'BR-07' } });
    await adapter.update('isms', major, { systemicCheckText: 'systemic' });
    expect(await adapter.move('isms', major, { to: 'closed' })).toMatchObject({ ok: false, error: { rule: 'BR-08' } });
    // CA-2025-02 is implemented by bagus on 30 Aug: rina checks it, so NC-2025-02 closes.
    const ca = ((await adapter.actions('isms')) as { data: { code: string }[] }).data.find((a) => a.code === 'CA-2025-02') as never;
    const asOwner = createSampleAdapter(scope(D, 'ndt', 'bagus'));
    expect(await asOwner.moveAction('isms', ca, { to: 'closed', effective: true })).toMatchObject({ ok: false, error: { rule: 'BR-09' } });
    expect(await adapter.moveAction('isms', ca, { to: 'closed', effective: true })).toMatchObject({ ok: true });
    expect(await adapter.move('isms', await find('NC-2025-02'), { to: 'closed' })).toMatchObject({ ok: true });
    // A new action implemented today cannot be checked today (BR-08), and an OFI closes with a note.
    const created = await adapter.createAction('isms', { findingIds: [(major as { id: string }).id], code: 'CA-2026-09', title: 't', ownerHandle: 'bagus' }, 'k');
    expect(created.ok).toBe(true);
    let action = ((await adapter.actions('isms')) as { data: { code: string }[] }).data.find((a) => a.code === 'CA-2026-09') as never;
    expect(await adapter.moveAction('isms', action, { to: 'systemic_check', text: 'x' })).toMatchObject({ ok: false, error: { slug: 'transition-not-allowed' } });
    for (const [to, text] of [['rca', 'c'], ['systemic_check', 'r'], ['action', 's'], ['effectiveness_verification', 'a']] as const) {
      action = ((await adapter.actions('isms')) as { data: { code: string }[] }).data.find((a) => a.code === 'CA-2026-09') as never;
      expect(await adapter.moveAction('isms', action, { to, text })).toMatchObject({ ok: true });
    }
    action = ((await adapter.actions('isms')) as { data: { code: string }[] }).data.find((a) => a.code === 'CA-2026-09') as never;
    expect(action).toMatchObject({ status: 'effectiveness_verification', implementedBy: 'rina', implementedAt: SAMPLE.TODAY_S });
    expect(await createSampleAdapter(scope(D, 'ndt', 'maya')).moveAction('isms', action, { to: 'closed', effective: true })).toMatchObject({ ok: false, error: { rule: 'BR-08' } });
    expect(await createSampleAdapter(scope(D, 'ndt', 'maya')).moveAction('isms', action, { to: 'closed', effective: false })).toMatchObject({ ok: true, data: { message: [expect.stringMatching(/^Not effective/), expect.any(String)] } });
    expect(await adapter.move('isms', await find('OFI-2025-01'), { to: 'in_progress' })).toMatchObject({ ok: false });
    expect(await adapter.move('isms', await find('OFI-2025-01'), { to: 'in_progress', note: 'Targets missing again' })).toMatchObject({ ok: true });
    expect(await adapter.move('isms', await find('OFI-2025-01'), { to: 'closed' })).toMatchObject({ ok: false, error: { slug: 'validation' } });
  });

  it('assesses a condition and raises a finding from its gap once; each organisation keeps its own state', async () => {
    const adapter = createSampleAdapter(scope(D, 'ndt'));
    const rows = ((await adapter.selfAssessment('isms')) as { data: SelfRow[] }).data;
    expect(rows.map((r) => [r.conditionCode, r.status])).toEqual([['FC-01', 'conforming'], ['FC-02', 'conforming'], ['FC-03', 'not_assessed'], ['FC-04', 'gap'], ['FC-05', 'not_assessed'], ['FC-06', 'conforming']]);
    expect(await adapter.assess('isms', rows[2], { status: 'gap', evidenceCodes: [] })).toMatchObject({ ok: false });
    expect(await adapter.assess('isms', rows[2], { status: 'conforming', evidenceCodes: ['EV-9999'] })).toMatchObject({ ok: false });
    expect(await adapter.assess('isms', rows[2], { status: 'gap', ownerHandle: 'rina', targetFixAt: '2026-11-30', evidenceCodes: [] })).toMatchObject({ ok: true });
    expect(await adapter.raiseFromGap('isms', rows[3], { classification: 'minor' }, 'k')).toMatchObject({ ok: true, data: { ref: { code: 'SA-2026-01' } } });
    expect(await adapter.raiseFromGap('isms', rows[3], { classification: 'minor' }, 'k')).toMatchObject({ ok: false, error: { status: 409 } });
    const raised = ((await adapter.findings('isms')) as { data: { code: string; source: string; owner: string }[] }).data.find((f) => f.code === 'SA-2026-01');
    expect(raised).toMatchObject({ source: 'self_assessment', owner: 'bagus' });
    expect(await adapter.raise('isms', { code: 'NC-2025-01', title: 't', classification: 'minor', source: 'other', ownerHandle: 'rina' }, 'k')).toMatchObject({ ok: false, error: { status: 409 } });
    // Another organisation with the same system id starts from its own seed.
    const other = createSampleAdapter(scope(bsd, 'bsd'));
    const otherFindings = ((await other.findings('isms')) as { data: { code: string }[] }).data.map((f) => f.code);
    expect(otherFindings).not.toContain('SA-2026-01');
    const targets = await adapter.targets('isms');
    expect(targets.ok && targets.data.some((t) => t.code === '6.1.3' && t.kind === 'requirement') && targets.data.some((t) => t.code === 'A.5.18')).toBe(true);
    const events = await adapter.events('isms');
    expect(events.ok && events.data.some((e) => e.eventType === 'internal_audit' && e.shortLabel === 'IA 2026')).toBe(true);
  });

  it('the build chooses the deferred sample adapter outside api builds', async () => {
    const adapter = adapterFor(() => ctxOf('en'));
    expect(adapter.sample).toBe(true);
    const res = await adapter.findings('isms');
    expect(res.ok && res.data.length).toBe(5);
  });
});

describe('the screen and its views', () => {
  it('has a definition that matches its meta.json, the Raise finding page action for finding.raise', () => {
    expect(meta.id).toBe(screen.id);
    expect(screen.perm).toBe('ms.read');
    const ctx = ctxOf('en');
    const actions = screen.pageActions!(ctx);
    expect(actions.map((a) => a.label)).toEqual([TEXT.raise]);
    actions[0].run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('findings', { params: { raise: expect.any(Number) } });
    expect(screen.pageActions!(ctxOf('en', { can: () => false }))).toEqual([]);
  });

  it('adds the open findings panel to the requirement detail for readers of the system', () => {
    expect(detailExtensions).toHaveLength(1);
    const ext = detailExtensions![0];
    expect([ext.id, ext.kind]).toEqual(['findings.open', 'req']);
    expect(ext.visible!(ctxOf('en'), { kind: 'req', ms: 'isms', recordKey: 'isms:req:A.5.18', record: {}, close: () => undefined })).toBe(true);
    expect(ext.visible!(ctxOf('en', { can: () => false }), { kind: 'req', ms: 'isms', recordKey: 'isms:req:A.5.18', record: {}, close: () => undefined })).toBe(false);
  });

  it('renders the lists, drawers and dialogs in both languages and themes', async () => {
    const adapter = createSampleAdapter({ getD: () => D, org: () => 'ndt', me: () => 'rina' }) as FindingsAdapter;
    const findings = ((await adapter.findings('isms')) as { data: never[] }).data as Parameters<typeof FindingsList>[0]['rows'];
    const actions = ((await adapter.actions('isms')) as { data: never[] }).data as Parameters<typeof ActionsList>[0]['rows'];
    const self = ((await adapter.selfAssessment('isms')) as { data: SelfRow[] }).data;
    for (const lang of ['en', 'id'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = ctxOf(lang, { theme });
        const html = render(
          <>
            <FindingsList ctx={ctx} rows={findings} canRaise onRaise={() => undefined} onOpen={() => undefined} />
            <ActionsList ctx={ctx} rows={actions} canCreate onCreate={() => undefined} onOpen={() => undefined} />
            <SelfList ctx={ctx} ms="isms" rows={self} onAssess={() => undefined} onRaise={() => undefined} />
            <FindingDrawer ctx={ctx} ms="isms" finding={findings[3]} adapter={adapter} targets={[]} onClose={() => undefined} onChanged={() => undefined} onCreateAction={() => undefined} onOpenAction={() => undefined} />
            <ActionDrawer ctx={ctx} ms="isms" action={actions[1]} adapter={adapter} findings={findings} codes={[]} onClose={() => undefined} onChanged={() => undefined} onOpenFinding={() => undefined} />
            <RaiseDialog ctx={ctx} ms="isms" open adapter={adapter} codes={['IA-2026-02']} prefill={{ source: 'internal_audit' }} onClose={() => undefined} onRaised={() => undefined} />
            <AssessDialog ctx={ctx} ms="isms" row={self[3]} adapter={adapter} onClose={() => undefined} onSaved={() => undefined} />
          </>,
          ctx,
          theme,
        );
        const t = (pair: readonly [string, string]) => pair[lang === 'id' ? 1 : 0];
        for (const text of [TEXT.tabFindings, TEXT.colClassification, TEXT.major, TEXT.createAction, TEXT.rootCause, TEXT.recordCheck, TEXT.raiseTitle, TEXT.assessTitle[0].includes('{') ? TEXT.fAssessment : TEXT.assessTitle, TEXT.selfIntro]) {
          expect(html, `${lang} ${theme}: ${t(text)}`).toContain(t(text).replace(/&/g, '&amp;'));
        }
        expect(html).toContain('IA-2026-01');
        expect(html).toContain('CA-2025-02');
        expect(html).not.toMatch(/—|·/);
      }
    }
  });

  it('shows the empty states with the no-findings scene', () => {
    const ctx = ctxOf('en');
    const html = render(<><FindingsList ctx={ctx} rows={[]} canRaise onRaise={() => undefined} onOpen={() => undefined} /><ActionsList ctx={ctx} rows={[]} canCreate={false} onCreate={() => undefined} onOpen={() => undefined} /></>, ctx);
    expect(html).toContain(TEXT.noFindings[0]);
    expect(html).toContain(TEXT.noActions[0]);
    expect(html).toContain('mx-empty-art');
  });
});
