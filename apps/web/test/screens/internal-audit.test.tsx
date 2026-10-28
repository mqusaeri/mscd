// Internal audit (MILESTONE-2 M2-14): routes against the shared table, the cycle, programme and form helpers, the API
// adapter over a fake fetch (cycles with the scope and report of each audit, the programme of a cycle, planning, the
// audit detail, activities, the report from a registered record or a new record with its file), the sample adapter
// (coverage, templates, AUD-INDEP, state per organisation) and the views in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { AuditActivityItem, CertificationCycleItem, InternalAuditProgramme, SurveillanceEvent } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import screen from '../../src/screens/internal-audit/index';
import meta from '../../src/screens/internal-audit/meta.json';
import { adapterFor } from '../../src/screens/internal-audit/adapter';
import { createApiAdapter, fromActivity, fromCycle, isRecordTier, snapshotRecords } from '../../src/screens/internal-audit/api';
import { ActivityDialog, PlanDialog, ReportDialog } from '../../src/screens/internal-audit/dialogs';
import { EventDrawer } from '../../src/screens/internal-audit/EventDrawer';
import {
  activityFormOf, activityPatch, covers, defaultCycle, emptyPlan, filterProgramme, mayRun, noTemplates, planBody, planErrors, reportCode,
} from '../../src/screens/internal-audit/model';
import type { CycleModel, InternalAuditAdapter } from '../../src/screens/internal-audit/model';
import { ROUTES, ROUTE_IDS } from '../../src/screens/internal-audit/routes';
import { createSampleAdapter, ownsWorkOf, resetSampleAudit } from '../../src/screens/internal-audit/sample';
import { AuditsTable, ProgrammeCard, cycleLabel } from '../../src/screens/internal-audit/Screen';
import { TEXT } from '../../src/screens/internal-audit/text';
import { createSampleAdapter as createFindingsSample } from '../../src/screens/findings/sample';
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
    client: null, ds: null, screen: 'internal-audit', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const CYCLE: CertificationCycleItem = {
  id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', status: 'certified', cycleStart: '2025-03-14', cycleEnd: '2028-03-13', certificateNo: 'ISMS-1', certifiedAt: '2025-03-14',
  certificateExpiresAt: '2028-03-13', certificationBody: 'Body', certifiedScope: null, items: { total: 1, done: 0 }, etag: 'W/"1"',
  events: [
    { id: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', eventType: 'internal_audit', shortLabel: 'IA 2026', scheduledAt: '2026-09-14', outcome: null, scopeText: 'Clauses 4 to 10', reportDocumentId: '0b7e8c2a-1d3f-4e5a-8b6c-7d8e9f0a1b2c' },
    { id: '8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f', eventType: 'stage2', shortLabel: 'Stage 2', scheduledAt: '2025-03-10', outcome: 'recommended', scopeText: null, reportDocumentId: null },
    { id: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a', eventType: 'internal_audit', shortLabel: 'IA 2025', scheduledAt: '2025-11-10', outcome: null, scopeText: null, reportDocumentId: null },
  ],
};
const ACTIVITY: AuditActivityItem = {
  ref: { module: 'audit', entityType: 'audit_activity', id: '3f4a5b6c-7d8e-4f9a-8b0c-1d2e3f4a5b6c', code: 'AA-IA-01', etag: 'W/"2"' }, templateCode: 'AA-IA-01',
  title: 'Check the scope', clauseRef: '4.3', keyQuestions: 'Is the scope documented?', evidenceToRequest: 'Scope statement', auditee: 'rina', scheduledAt: '2026-09-14',
  status: 'planned', note: null, auditor: 'maya', targetCode: null,
};

afterEach(() => resetSampleAudit());

describe('internal audit routes', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.programme).permission).toBe('ms.read');
    expect(routeById(ROUTE_IDS.eventCreate).permissionBy?.cases.internal_audit.permission).toBe('internal_audit.manage');
    expect(routeById(ROUTE_IDS.activityUpdate).anyOf?.map((p) => p.permission)).toEqual(['audit_event.manage', 'internal_audit.manage']);
    expect(routeById(ROUTE_IDS.documentCreate).permission).toBe('document.manage');
  });
});

describe('cycles, programme and forms', () => {
  it('lists the internal audits of a cycle by date and picks the open cycle first, else the newest', () => {
    const cycle = fromCycle(CYCLE);
    expect(cycle.audits.map((a) => a.shortLabel)).toEqual(['IA 2025', 'IA 2026']);
    expect(cycle.audits[1]).toMatchObject({ scopeText: 'Clauses 4 to 10', reportDocumentId: '0b7e8c2a-1d3f-4e5a-8b6c-7d8e9f0a1b2c' });
    const c = (id: string, status: CycleModel['status'], start: string): CycleModel => ({ id, status, cycleStart: start, cycleEnd: start, audits: [] });
    expect(defaultCycle([c('a', 'certified', '2025-03-14'), c('b', 'active', '2028-03-01')])?.id).toBe('b');
    expect(defaultCycle([c('a', 'certified', '2022-03-14'), c('b', 'closed', '2025-03-01')])?.id).toBe('b');
    expect(defaultCycle([])).toBeNull();
    expect(cycleLabel(ctxOf('id'), cycle)).toBe('14 Mar 2025 sampai 13 Mar 2028, tersertifikasi');
  });

  it('covers a clause with its sub-clauses and parents, a control only by its own code; filters the programme', () => {
    expect([covers('9.2', '9.2.1', 'clause'), covers('9.2.1', '9.2', 'clause'), covers('9.2', '9.3', 'clause'), covers('A.5', 'A.5.1', 'control'), covers('A.5.1', 'A.5.1', 'control')])
      .toEqual([true, true, false, false, true]);
    const rows = [
      { code: '4.1', title: 'a', kind: 'clause' as const, clauseGroup: '4', covered: true, audits: [] },
      { code: 'A.5.1', title: 'b', kind: 'control' as const, clauseGroup: null, covered: false, audits: [] },
    ];
    expect(filterProgramme(rows, 'uncovered').map((r) => r.code)).toEqual(['A.5.1']);
    expect(filterProgramme(rows, 'clause').map((r) => r.code)).toEqual(['4.1']);
    expect(filterProgramme(rows, 'all')).toHaveLength(2);
  });

  it('checks the plan form and builds an internal audit event with the lead auditor by name', () => {
    const form = { ...emptyPlan('en', '2026'), scheduledAt: '2026-12-08', auditDays: '2', lead: 'maya', scopeText: ' Clauses 4 to 10 ' };
    expect(form).toMatchObject({ name: 'Internal audit 2026', shortLabel: 'IA 2026' });
    expect(emptyPlan('id', '2026').name).toBe('Audit internal 2026');
    expect(planErrors(form)).toEqual({});
    expect(planBody(form, 'Maya Putri')).toEqual({
      eventType: 'internal_audit', nameEn: 'Internal audit 2026', nameId: 'Internal audit 2026', shortLabel: 'IA 2026', scheduledAt: '2026-12-08', auditDays: 2,
      leadAuditorName: 'Maya Putri', scopeText: 'Clauses 4 to 10',
    });
    expect(planBody({ ...form, nameId: 'Audit internal 2026', auditDays: '', scopeText: '' }, null)).toEqual({
      eventType: 'internal_audit', nameEn: 'Internal audit 2026', nameId: 'Audit internal 2026', shortLabel: 'IA 2026', scheduledAt: '2026-12-08',
    });
    expect(planErrors({ ...form, name: '', shortLabel: '', scheduledAt: '', auditDays: '400' })).toEqual({ name: TEXT.required, shortLabel: TEXT.required, scheduledAt: TEXT.required, auditDays: TEXT.badDays });
  });

  it('the activity patch holds only what changed; none and null clear the auditor and the target', () => {
    const a = fromActivity({ ...ACTIVITY, targetCode: '4.3' });
    expect(a.code).toBe('AA-IA-01');
    expect(activityPatch(activityFormOf(a), a)).toBeNull();
    expect(activityPatch({ ...activityFormOf(a), auditor: '', targetCode: '', status: 'done', note: ' ok ' }, a)).toEqual({ auditorHandle: 'none', targetCode: null, status: 'done', note: 'ok' });
    expect(activityPatch({ ...activityFormOf(a), auditor: 'dewi', targetCode: 'A.5.18' }, a)).toEqual({ auditorHandle: 'dewi', targetCode: 'A.5.18' });
  });

  it('records of the snapshot are documents of type record with their uuid; the report code follows the audit label', () => {
    const data = {
      ...D,
      bundles: { ...D.bundles, isms: { ...D.bundles.isms, docs: [...D.bundles.isms.docs, { id: 'REC-IA-2026', title: 'Report', tier: 'Record', ver: '1', st: 'approved', appr: '', rev: '', owner: 'maya', shared: false, ms: 'isms' }] } },
      refs: { 'isms:doc:REC-IA-2026': { id: 'd1' } },
    } as unknown as ControllerData;
    expect(snapshotRecords(data, 'isms')).toEqual([{ id: 'd1', code: 'REC-IA-2026', title: 'Report' }]);
    expect([isRecordTier('Record'), isRecordTier('Rekaman'), isRecordTier('Policy')]).toEqual([true, false, false]);
    expect(reportCode('IA 2026')).toBe('REC-IA-2026');
  });

  it('MS Managers and Internal Auditors run internal audits', () => {
    expect(mayRun(ctxOf('en', { can: (_ms, p) => (Array.isArray(p) ? p : [p]).includes('internal_audit.manage') }), 'isms')).toBe(true);
    expect(mayRun(ctxOf('en', { can: () => false }), 'isms')).toBe(false);
  });
});

describe('the API adapter', () => {
  it('reads cycles and the programme of a cycle, plans, reads the detail and the activities, generates and saves', async () => {
    const programme: InternalAuditProgramme = {
      cycle: { id: CYCLE.id, cycleStart: CYCLE.cycleStart, cycleEnd: CYCLE.cycleEnd },
      rows: [{ code: '9.2', title: 'Internal audit', kind: 'clause', clauseGroup: '9', covered: true, audits: [{ eventId: 'e', shortLabel: 'IA 2026', scheduledAt: '2026-09-14', activities: 2 }] }],
    };
    const event: SurveillanceEvent = {
      id: CYCLE.events[0].id, type: 'internal_audit', name: 'Internal audit 2026', shortLabel: 'IA 2026', scheduledAt: '2026-09-14', auditDays: 2, leadAuditor: 'Maya Putri',
      expectedFocus: null, outcome: null, outcomeSummary: 'Two minor nonconformities', next: false, past: true, prep: [],
      findings: [{ ref: { module: 'audit', entityType: 'finding', id: 'f1', code: 'IA-2026-01' }, code: 'IA-2026-01', classification: 'major', clause: '6.1.3', title: 't', status: 'open', note: null }],
    };
    const ev = CYCLE.events[0].id;
    const f = fakeFetch({
      'GET /api/v1/ms/isms/certification-cycles': json([CYCLE]),
      'GET /api/v1/ms/isms/internal-audit/programme': json(programme),
      'POST /api/v1/ms/isms/audit-events': json({ ok: true, changed: ['isms'], ref: { module: 'audit', entityType: 'audit_event', id: ev, code: 'IA 2027' } }, 201),
      [`GET /api/v1/ms/isms/surveillance/events/${ev}`]: json(event),
      [`GET /api/v1/ms/isms/audit-events/${ev}/activities`]: json([ACTIVITY]),
      [`POST /api/v1/ms/isms/audit-events/${ev}/activities/generate`]: json({ ok: true, changed: ['isms'], count: 0, message: ['Every template activity of this event already exists', 'Semua aktivitas templat untuk audit ini sudah ada'] }),
      [`PATCH /api/v1/ms/isms/audit-activities/${ACTIVITY.ref.id}`]: json({ ok: true, changed: ['isms'], warnings: [{ rule: 'AUD-INDEP', messages: { en: 'Maya owns work of 4.3.', id: 'Maya memiliki pekerjaan 4.3.' } }] }),
      [`PATCH /api/v1/ms/isms/audit-events/${ev}`]: problem(422, 'business-rule', { messageKey: 'audit.report_not_record', messages: { en: 'The report must be a record', id: 'Laporan harus berupa rekaman' } }),
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client, () => D);
    const cycles = await adapter.cycles('isms');
    expect(cycles.ok && cycles.data[0].audits.map((a) => a.id)).toEqual([CYCLE.events[2].id, ev]);
    const prog = await adapter.programme('isms', CYCLE.id);
    expect(prog.ok && prog.data.rows[0].covered).toBe(true);
    expect(new URL(f.calls[1].url, 'http://x').searchParams.get('cycle')).toBe(CYCLE.id);
    await adapter.programme('isms', null);
    expect(new URL(f.calls[2].url, 'http://x').searchParams.get('cycle')).toBeNull();
    const body = planBody({ ...emptyPlan('en', '2027'), scheduledAt: '2027-01-20' }, null);
    const planned = await adapter.plan('isms', body, 'key-7');
    expect(planned.ok && planned.data.ref?.id).toBe(ev);
    expect(f.calls[3]).toMatchObject({ method: 'POST', body: { eventType: 'internal_audit', nameEn: 'Internal audit 2027', shortLabel: 'IA 2027', scheduledAt: '2027-01-20', auditDays: 1 } });
    expect(f.calls[3].headers['idempotency-key']).toBe('key-7');
    expect(f.calls[3].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    const detail = await adapter.detail('isms', ev);
    expect(detail.ok && detail.data).toMatchObject({ name: 'Internal audit 2026', auditDays: 2, leadAuditor: 'Maya Putri', findings: [{ id: 'f1', code: 'IA-2026-01' }] });
    const acts = await adapter.activities('isms', ev);
    expect(acts.ok && acts.data[0]).toMatchObject({ code: 'AA-IA-01', auditor: 'maya', keyQuestions: 'Is the scope documented?' });
    const gen = await adapter.generate('isms', ev);
    expect(gen.ok && gen.data.count).toBe(0);
    const saved = await adapter.updateActivity('isms', fromActivity(ACTIVITY), { targetCode: '4.3' });
    expect(saved.ok && saved.data.warnings).toEqual([{ rule: 'AUD-INDEP', message: ['Maya owns work of 4.3.', 'Maya memiliki pekerjaan 4.3.'] }]);
    const refused = await adapter.updateEvent('isms', ev, { reportDocumentId: 'd1' });
    expect(!refused.ok && refused.error.message[0]).toBe('The report must be a record');
    expect(f.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { reportDocumentId: 'd1' } });
  });

  it('registers a new record of type record, then adds the chosen file as its version', async () => {
    const id = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
    const f = fakeFetch({
      'POST /api/v1/ms/isms/documents': json({ ok: true, changed: ['isms'], ref: { module: 'implementation', entityType: 'document', id, code: 'REC-IA-2026' } }, 201),
      [`POST /api/v1/ms/isms/documents/${id}/versions`]: json({ ok: true, changed: ['isms'] }),
    });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }), () => D);
    const made = await adapter.registerRecord('isms', { code: 'REC-IA-2026', title: 'IA 2026 report', owner: 'rina' }, 'key-8');
    expect(made).toEqual({ ok: true, data: { id, code: 'REC-IA-2026', title: 'IA 2026 report' } });
    expect(f.calls[0].body).toEqual({ docCode: 'REC-IA-2026', title: 'IA 2026 report', docType: 'record', ownerHandle: 'rina', classification: 'internal', orgWide: false, linkedMs: ['isms'] });
    await adapter.addFile('isms', made.ok ? made.data : (null as never), { source: 'link', repository: 'sp', externalItemId: 'item-1', fileName: 'report.pdf' });
    expect(f.calls[1].body).toEqual({ source: 'link', repository: 'sp', externalItemId: 'item-1' });
    await adapter.addFile('isms', made.ok ? made.data : (null as never), { source: 'upload', uploadIntentId: 'u1', fileName: 'report.pdf' });
    expect(f.calls[2].body).toEqual({ source: 'upload', uploadIntentId: 'u1' });
  });
});

describe('the sample adapter', () => {
  const scope = (org = 'ndt', me = 'rina') => ({ getD: () => D, org: () => org, me: () => me, lang: () => 'en' as const });

  it('lists the cycles and internal audits of each system, with the coverage of the programme', async () => {
    const adapter = createSampleAdapter(scope());
    const cycles = await adapter.cycles('isms');
    expect(cycles.ok && cycles.data.map((c) => [c.status, c.audits.map((a) => a.shortLabel)])).toEqual([['certified', ['IA 2025', 'IA 2026']]]);
    expect((await adapter.cycles('abms')).ok && ((await adapter.cycles('abms')) as { data: unknown[] }).data).toEqual([]);
    const prog = await adapter.programme('isms', null);
    const rows = prog.ok ? prog.data.rows : [];
    expect(rows.find((r) => r.code === '9.3.2')).toMatchObject({ kind: 'clause', covered: true });
    expect(rows.find((r) => r.code === '8.1')).toMatchObject({ covered: false });
    expect(rows.find((r) => r.code === 'A.5.18')).toMatchObject({ kind: 'control', covered: true, audits: [{ shortLabel: 'IA 2026', activities: 1 }] });
    expect(rows.some((r) => r.kind === 'control' && D.bundles.isms.reqs.find((q) => q.id === r.code)?.st === 'na')).toBe(false);
  });

  it('generates the template activities once, plans an audit into the cycle, and warns with AUD-INDEP', async () => {
    const adapter = createSampleAdapter(scope());
    const cycles = ((await adapter.cycles('qms')) as { data: CycleModel[] }).data;
    const planned = cycles[0].audits.find((a) => a.shortLabel === 'IA 2026')!;
    expect((await adapter.generate('qms', planned.id)) as unknown).toMatchObject({ ok: true, data: { count: 8 } });
    expect((await adapter.generate('qms', planned.id)) as unknown).toMatchObject({ ok: true, data: { count: 0 } });
    const acts = ((await adapter.activities('qms', planned.id)) as { data: ReturnType<typeof fromActivity>[] }).data;
    // Nothing new while every template exists is "already exists"; nothing at all means the pack has no template.
    expect(noTemplates(0, acts.length)).toBe(false);
    expect([noTemplates(0, 0), noTemplates(undefined, 0), noTemplates(3, 0)]).toEqual([true, true, false]);
    expect(TEXT.noTemplates[1]).not.toBe(TEXT.noTemplates[0]);
    expect(acts.map((a) => a.code)).toEqual(['IA-01', 'IA-02', 'IA-03', 'IA-04', 'IA-05', 'IA-06', 'IA-07', 'IA-08']);
    // andi owns QMS 8.4 (the sample's owner of that requirement).
    expect(ownsWorkOf(D, 'qms', 'andi', '8.4')).toBe(true);
    const warned = await adapter.updateActivity('qms', acts[4], { auditorHandle: 'andi', targetCode: '8.4' });
    expect(warned.ok && warned.data.warnings[0]).toMatchObject({ rule: 'AUD-INDEP', message: [expect.stringContaining('Andi Saputra owns'), expect.any(String)] });
    const clean = await adapter.updateActivity('qms', acts[5], { auditorHandle: 'maya', targetCode: '9.1' });
    expect(clean.ok && clean.data.warnings).toEqual([]);
    expect(await adapter.updateActivity('qms', acts[5], { targetCode: 'Z.9' })).toMatchObject({ ok: false, error: { status: 422 } });
    const made = await adapter.plan('isms', planBody({ ...emptyPlan('en', '2027'), shortLabel: 'IA 2027', scheduledAt: '2027-02-01' }, 'Maya Putri'), 'k');
    expect(made.ok).toBe(true);
    const after = ((await adapter.cycles('isms')) as { data: CycleModel[] }).data[0].audits.map((a) => a.shortLabel);
    expect(after).toEqual(['IA 2025', 'IA 2026', 'IA 2027']);
  });

  it('attaches a report from a record, registers a new record, and shares raised findings with the findings screen', async () => {
    const adapter = createSampleAdapter(scope());
    const audit = ((await adapter.cycles('isms')) as { data: CycleModel[] }).data[0].audits[1];
    expect(audit.reportDocumentId).toBeNull();
    const records = ((await adapter.records('isms')) as { data: { id: string; code: string }[] }).data;
    expect(records.map((r) => r.code)).toEqual(['REC-IA-2025']);
    const made = await adapter.registerRecord('isms', { code: 'REC-IA-2026', title: 'Report 2026', owner: 'rina' }, 'k');
    expect(made.ok).toBe(true);
    expect(await adapter.registerRecord('isms', { code: 'POL-01', title: 'x', owner: 'rina' }, 'k')).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await adapter.updateEvent('isms', audit.id, { reportDocumentId: made.ok ? made.data.id : '', outcomeSummary: 'Two findings' })).toMatchObject({ ok: true });
    const again = ((await adapter.cycles('isms')) as { data: CycleModel[] }).data[0].audits[1];
    expect(again.reportDocumentId).toBe(made.ok ? made.data.id : '');
    const detail = await adapter.detail('isms', audit.id);
    expect(detail.ok && [detail.data.outcomeSummary, detail.data.findings.map((f) => f.code)]).toEqual(['Two findings', ['IA-2026-01', 'IA-2026-02']]);
    // A finding raised through the findings sample shows on the audit.
    const findings = createFindingsSample({ getD: () => D, org: () => 'ndt', me: () => 'maya' });
    await findings.raise('isms', { code: 'IA-2026-04', title: 'Log review gaps', classification: 'minor', source: 'internal_audit', auditEventId: audit.id, ownerHandle: 'bagus' }, 'k');
    const withNew = await adapter.detail('isms', audit.id);
    expect(withNew.ok && withNew.data.findings.map((f) => f.code)).toContain('IA-2026-04');
    // Another organisation keeps its own internal audits.
    const other = createSampleAdapter(scope('rmn'));
    const otherAudits = ((await other.cycles('isms')) as { data: CycleModel[] }).data[0].audits;
    expect(otherAudits[1].reportDocumentId).toBeNull();
  });

  it('the build chooses the deferred sample adapter outside api builds', async () => {
    const adapter = adapterFor(() => ctxOf('en'));
    expect(adapter.sample).toBe(true);
    const res = await adapter.cycles('isms');
    expect(res.ok && res.data).toHaveLength(1);
  });
});

describe('the screen and its views', () => {
  it('has a definition that matches its meta.json and the Plan internal audit page action', () => {
    expect([meta.id, meta.group, meta.order]).toEqual([screen.id, screen.group, screen.order]);
    const ctx = ctxOf('en');
    const actions = screen.pageActions!(ctx);
    expect(actions.map((a) => a.label)).toEqual([TEXT.plan]);
    actions[0].run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('internal-audit', { params: { plan: expect.any(Number) } });
    expect(screen.pageActions!(ctxOf('en', { can: (_ms, p) => !(Array.isArray(p) ? p : [p]).some((x) => String(x).endsWith('.manage')) }))).toEqual([]);
  });

  it('renders the audits, the programme, the drawer and the dialogs in both languages and themes', async () => {
    const adapter = createSampleAdapter({ getD: () => D, org: () => 'ndt', me: () => 'rina', lang: () => 'en' }) as InternalAuditAdapter;
    const findings = createFindingsSample({ getD: () => D, org: () => 'ndt', me: () => 'rina' });
    const cycle = ((await adapter.cycles('isms')) as { data: CycleModel[] }).data[0];
    const programme = (await adapter.programme('isms', cycle.id)) as { data: Parameters<typeof ProgrammeCard>[0]['programme'] };
    const acts = ((await adapter.activities('isms', cycle.audits[1].id)) as { data: ReturnType<typeof fromActivity>[] }).data;
    const records = ((await adapter.records('isms')) as { data: { id: string; code: string; title: string }[] }).data;
    for (const lang of ['en', 'id'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = ctxOf(lang, { theme });
        const html = render(
          <>
            <AuditsTable ctx={ctx} audits={cycle.audits} records={records} onOpen={() => undefined} />
            <ProgrammeCard ctx={ctx} programme={programme.data} />
            <EventDrawer ctx={ctx} ms="isms" audit={cycle.audits[0]} adapter={adapter} findingsAdapter={findings} records={records} targets={[]} onClose={() => undefined} onChanged={() => undefined} />
            <PlanDialog ctx={ctx} ms="isms" open adapter={adapter} hasCycle onClose={() => undefined} onPlanned={() => undefined} />
            <ActivityDialog ctx={ctx} ms="isms" activity={acts[0]} adapter={adapter} targets={[{ code: '4.3', title: 'Scope', kind: 'requirement' }]} onClose={() => undefined} onSaved={() => undefined} />
            <ReportDialog ctx={ctx} ms="isms" open adapter={adapter} eventId={cycle.audits[1].id} label="IA 2026" records={records} onClose={() => undefined} onAttached={() => undefined} />
          </>,
          ctx,
          theme,
        );
        const t = (pair: readonly [string, string]) => pair[lang === 'id' ? 1 : 0];
        for (const text of [TEXT.colAudit, TEXT.programme, TEXT.covered, TEXT.notCovered, TEXT.planTitle, TEXT.fLead, TEXT.fAuditor, TEXT.fQuestions, TEXT.reportTitle, TEXT.fromRecord, TEXT.replaceReport, TEXT.recordOutcome]) {
          expect(html, `${lang} ${theme}: ${t(text)}`).toContain(t(text));
        }
        expect(html).toContain('REC-IA-2025');
        expect(html).not.toMatch(/—|·/);
      }
    }
  });
});
