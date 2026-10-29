// Certification timeline forms (MILESTONE-2 M2-15): routes against the shared table, the event, cycle, certificate,
// activity and item helpers, the API adapter over a fake fetch (both languages of an event, the BR-42 count, If-Match
// with the cycle's ETag and a 412 kept, the two steps of "Mark done", CSRF, field errors kept), the sample adapter over
// the sample data source (cycles as the demo seed writes them, the certificate after a recommended result, the moves
// of J.8, BR-43, activities from the templates, one state per organisation), the claim and page actions, and the
// panels and forms in both languages and themes (with "Try again" when the audit event of a form could not be loaded,
// and no "Start certification cycle" while the newest certificate is suspended).
import { isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { AuditActivityItem, CertificationCycleItem, SurveillanceEvent } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import type { ControllerData, Snapshot } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import * as actions from '../../src/screens/timeline-edit/actions';
import { addEvent, extraPageActions } from '../../src/screens/timeline-edit/actions';
import { createApiAdapter, fromCycle, itemRef } from '../../src/screens/timeline-edit/api';
import { deferredAdapter } from '../../src/screens/timeline-edit/adapter';
import { CyclePanel } from '../../src/screens/timeline-edit/EventPanel';
import Forms, { DetailLoadError, detailReason } from '../../src/screens/timeline-edit/Forms';
import { itemOf, itemVisible } from '../../src/screens/timeline-edit/items';
import {
  activityPatch, addYears, breaksBr43, certificateBody, certificateErrors, createBody, cycleMayStart, emptyCertificate, emptyEventForm, eventErrors, eventFormOf,
  eventPatch, expiringSoon, expiryText, itemErrors, itemPatch, mayFinishItem, mayReassignItem, movesOf, reasonError, recommendation, resolveEvent,
  resultPatch, startErrors, withType,
} from '../../src/screens/timeline-edit/model';
import type { CycleModel, EventDetail, EventModel, ItemModel } from '../../src/screens/timeline-edit/model';
import { ROUTES, ROUTE_IDS } from '../../src/screens/timeline-edit/routes';
import { createSampleAdapter, resetSampleTimeline, sampleEventType, sampleExpiry } from '../../src/screens/timeline-edit/sample';
import { closeForm, cyclesEntry, formRequest, loadCycles, resetTimelineStore } from '../../src/screens/timeline-edit/store';
import { TEXT } from '../../src/screens/timeline-edit/text';
import { Button, HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';

const TODAY = SAMPLE.TODAY_S as string;
const dataOf = (snap: Snapshot) => ({ ...makeDates(TODAY), ...snap, TODAY_S: TODAY }) as unknown as ControllerData;
const base = await createSampleDataSource().load();
const D = dataOf(base);

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: D.MS[0], org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'timeline', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const CYCLE: CertificationCycleItem = {
  id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', status: 'certified', cycleStart: '2025-03-14', cycleEnd: '2028-03-14', certificateNo: 'ISMS-2025-0147',
  certifiedAt: '2025-03-14', certificateExpiresAt: '2028-03-13', certificationBody: 'PT Sertifikasi Nusantara', certifiedScope: 'Data centre operations',
  items: { total: 6, done: 2 }, etag: 'W/"1790000000000"',
  events: [
    { id: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', eventType: 'surveillance', shortLabel: 'Surveillance 1', scheduledAt: '2026-11-12', outcome: null, scopeText: null, reportDocumentId: null },
    { id: '8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f', eventType: 'stage2', shortLabel: 'Stage 2, certification', scheduledAt: '2025-03-10', outcome: 'recommended', scopeText: null, reportDocumentId: null },
  ],
};
const ACTIVE: CertificationCycleItem = { ...CYCLE, id: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a', status: 'active', certificateNo: null, certifiedAt: null, certificateExpiresAt: null, certificationBody: null, certifiedScope: null, etag: 'W/"5"' };
const DETAIL = (name: string): SurveillanceEvent => ({
  id: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', type: 'surveillance', name, shortLabel: 'Surveillance 1', scheduledAt: '2026-11-12', auditDays: 2,
  leadAuditor: 'Ir. Dwi Hartanto', expectedFocus: null, outcome: null, outcomeSummary: null, next: true, past: false, prep: [], findings: [],
});
const ACTIVITY: AuditActivityItem = {
  ref: { module: 'audit', entityType: 'audit_activity', id: '3f4a5b6c-7d8e-4f9a-8b0c-1d2e3f4a5b6c', code: 'AA-S1-01' }, templateCode: 'AA-S1-01',
  title: 'Review ISMS scope and context', clauseRef: '4.3', keyQuestions: 'Is the scope documented?', evidenceToRequest: 'Scope statement', auditee: null,
  scheduledAt: null, status: 'planned', note: null, auditor: null, targetCode: null,
};
const EVENT: EventModel = { id: CYCLE.events[0].id, eventType: 'surveillance', shortLabel: 'Surveillance 1', scheduledAt: '2026-11-12', outcome: null, ms: 'isms', cycleId: CYCLE.id, index: 2 };
const EVENT_DETAIL: EventDetail = {
  eventType: 'surveillance', nameEn: 'Surveillance audit 1', nameId: 'Audit surveilans 1', shortLabel: 'Surveillance 1', scheduledAt: '2026-11-12', auditDays: 2,
  leadAuditor: 'Ir. Dwi Hartanto', expectedFocus: null, prepWindowDays: null, outcome: null, outcomeSummary: null,
};

/** The first element of a rendered tree (before React renders it) that matches, for calling its handlers. */
function findElement(node: ReactNode, match: (el: ReactElement) => boolean): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child as ReactNode, match);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (match(node)) return node;
  return findElement((node.props as { children?: ReactNode }).children, match);
}

afterEach(() => {
  resetSampleTimeline();
  resetTimelineStore();
});

describe('timeline routes', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.cycleCreate).permission).toBe('audit_event.manage');
    expect(routeById(ROUTE_IDS.certification).permission).toBe('ms.transition');
    expect(routeById(ROUTE_IDS.cycleTransition)).toMatchObject({ permission: 'ms.transition', ifMatch: true });
    expect(routeById(ROUTE_IDS.prepUpdate).permission).toBe('prep_task.update');
    expect(routeById(ROUTE_IDS.cycleItemUpdate).permission).toBe('cycle_item.update');
  });
});

describe('events, cycles and forms', () => {
  const cycles = [fromCycle(CYCLE)];
  it('finds the event of a timeline row by date and short label, or by the only event of its date', () => {
    expect(resolveEvent(cycles, 'isms', 2, { t: 'Surveillance 1', d: '2026-11-12' })).toMatchObject({ id: EVENT.id, eventType: 'surveillance', cycleId: CYCLE.id, index: 2 });
    expect(resolveEvent(cycles, 'isms', 1, { t: ['Stage 2, certification', 'Tahap 2'], d: '2025-03-10' })?.outcome).toBe('recommended');
    expect(resolveEvent(cycles, 'isms', 1, { t: 'Renamed', d: '2025-03-10' })?.eventType).toBe('stage2');
    expect(resolveEvent(cycles, 'isms', 0, { t: 'Stage 1', d: '2025-01-20' })).toBeNull();
  });

  it('offers the moves of J.8 per status and finds the recommending audit of a cycle', () => {
    // J.8: only a suspended certificate is withdrawn; a certified cycle is suspended first (the server answers 409 otherwise).
    expect(movesOf('certified')).toEqual(['suspended']);
    expect(movesOf('suspended')).toEqual(['certified', 'withdrawn']);
    expect(movesOf('active')).toEqual(['closed']);
    for (const status of ['planned', 'withdrawn', 'expired', 'closed'] as const) expect(movesOf(status)).toEqual([]);
    expect(recommendation(cycles[0])?.shortLabel).toBe('Stage 2, certification');
    expect(recommendation({ ...cycles[0], events: cycles[0].events.map((e) => ({ ...e, outcome: 'not_recommended' as const })) })).toBeNull();
  });

  it('shows the expiry with the days left and warns 90 days before', () => {
    const ctx = ctxOf('en');
    expect(expiryText(ctx, '2026-10-29', '2026-09-29')).toBe('29 Oct 2026, in 30 days');
    expect(expiryText(ctx, '2026-09-29', '2026-09-29')).toBe('29 Sep 2026, today');
    expect(expiryText(ctxOf('id'), '2026-09-01', '2026-09-29')).toBe('1 Sep 2026, sudah berakhir');
    expect(expiringSoon({ ...cycles[0], certificateExpiresAt: '2026-12-01' }, '2026-09-29')).toBe(63);
    expect(expiringSoon(cycles[0], '2026-09-29')).toBeNull();
  });

  it('builds the new event with default names, keeps typed names on a type change and checks the fields', () => {
    const form = { ...emptyEventForm('stage1'), scheduledAt: '2027-02-10', leadAuditor: ' Ir. Dwi Hartanto ' };
    expect(withType(form, 'stage2')).toMatchObject({ nameEn: 'Stage 2 audit', nameId: 'Audit tahap 2', shortLabel: 'Stage 2' });
    expect(withType({ ...form, nameEn: 'Our Stage 1' }, 'stage2').nameEn).toBe('Our Stage 1');
    expect(createBody(form)).toEqual({
      eventType: 'stage1', nameEn: 'Stage 1 audit', nameId: 'Audit tahap 1', shortLabel: 'Stage 1', scheduledAt: '2027-02-10', auditDays: 1, leadAuditorName: 'Ir. Dwi Hartanto', prepWindowDays: 60,
    });
    expect(createBody({ ...form, nameId: '', auditDays: '', prepWindowDays: '' })).toMatchObject({ nameId: 'Stage 1 audit' });
    expect(eventErrors({ ...form, nameEn: '', shortLabel: '', scheduledAt: '', auditDays: '0', prepWindowDays: '400' })).toEqual({
      nameEn: TEXT.required, shortLabel: TEXT.required, scheduledAt: TEXT.required, auditDays: TEXT.badDays, prepWindowDays: TEXT.badWindow,
    });
  });

  it('sends only what changed in Edit and Record result; an empty value clears a nullable field', () => {
    const detail: EventDetail = {
      eventType: 'surveillance', nameEn: 'Surveillance audit 1', nameId: 'Audit surveilans 1', shortLabel: 'Surveillance 1', scheduledAt: '2026-11-12', auditDays: 2,
      leadAuditor: 'Ir. Dwi Hartanto', expectedFocus: null, prepWindowDays: null, outcome: null, outcomeSummary: null,
    };
    const form = eventFormOf(detail);
    expect(eventPatch(detail, form)).toBeNull();
    expect(eventPatch(detail, { ...form, scheduledAt: '2026-11-05', leadAuditor: '', auditDays: '' })).toEqual({ scheduledAt: '2026-11-05', leadAuditorName: null, auditDays: null });
    expect(eventPatch(detail, { ...form, prepWindowDays: '45' })).toEqual({ prepWindowDays: 45 });
    expect(resultPatch(detail, { outcome: 'recommended', summary: ' Passed, 1 OFI ' })).toEqual({ outcome: 'recommended', outcomeSummary: 'Passed, 1 OFI' });
    expect(resultPatch({ outcome: 'recommended', outcomeSummary: 'x' }, { outcome: '', summary: '' })).toEqual({ outcome: null, outcomeSummary: null });
    expect(resultPatch(detail, { outcome: '', summary: '' })).toBeNull();
  });

  it('checks the cycle start, the certificate and the reason of a move', () => {
    expect(startErrors({ cycleStart: '', cycleEnd: '' })).toEqual({ cycleStart: TEXT.required });
    expect(startErrors({ cycleStart: '2026-11-01', cycleEnd: '2026-10-01' })).toEqual({ cycleEnd: TEXT.endBeforeStart });
    const cert = emptyCertificate('2026-09-29', 'PT Sertifikasi Nusantara', 'Data centre');
    expect(cert).toMatchObject({ issuedAt: '2026-09-29', expiresAt: '2029-09-28', certificationBody: 'PT Sertifikasi Nusantara' });
    expect(addYears('2024-02-29', 3)).toBe('2027-02-28');
    expect(certificateErrors(cert)).toEqual({ certificateNo: TEXT.required });
    expect(certificateErrors({ ...cert, certificateNo: 'ISMS-1', expiresAt: '2026-09-01' })).toEqual({ expiresAt: TEXT.expiresBeforeIssued });
    expect(certificateBody({ ...cert, certificateNo: ' ISMS-1 ', certifiedScope: '' })).toEqual({ certificateNo: 'ISMS-1', issuedAt: '2026-09-29', expiresAt: '2029-09-28', certificationBody: 'PT Sertifikasi Nusantara' });
    expect(reasonError('ok')).toEqual(TEXT.reasonShort);
    expect(reasonError('Suspended by the certification body')).toBeNull();
  });

  it('activity and item forms send what changed; BR-43 keeps a preparation task before its audit', () => {
    const a = { id: 'a', code: 'AA-S1-01', templateCode: 'AA-S1-01', title: 't', clauseRef: '4.3', keyQuestions: null, evidenceToRequest: null, auditee: 'rina', auditor: 'maya', targetCode: null, scheduledAt: null, status: 'planned' as const, note: null };
    expect(activityPatch(a, { auditee: 'rina', auditor: '', targetCode: ' 4.3 ', scheduledAt: '2027-02-10', status: 'done', note: '' })).toEqual({ auditorHandle: 'none', targetCode: '4.3', scheduledAt: '2027-02-10', status: 'done' });
    const prep: ItemModel = { kind: 'prep', ms: 'isms', code: 'Approve SoA v3.0', title: 'Approve SoA v3.0', owner: 'hendra', due: '2026-10-15', status: 'open', auditDate: '2026-11-12' };
    expect(itemPatch(prep, { owner: 'rina', due: '2026-10-15' })).toEqual({ ownerHandle: 'rina' });
    expect(itemPatch(prep, { owner: 'hendra', due: '2026-10-15' })).toBeNull();
    expect(breaksBr43(prep, '2026-11-12')).toBe(true);
    expect(breaksBr43(prep, '2026-11-11')).toBe(false);
    expect(breaksBr43({ ...prep, kind: 'cycle' }, '2027-01-01')).toBe(false);
    expect(itemErrors(prep, { owner: '', due: '' })).toEqual({ owner: TEXT.required, due: TEXT.required });
  });

  it('gives Mark done to the MS Manager or the holder and Reassign to the MS Manager only (F.6)', () => {
    const prep: ItemModel = { kind: 'prep', ms: 'isms', code: 'x', title: 'x', owner: 'bagus', due: '2026-10-20', status: 'progress', auditDate: '2026-11-12' };
    const api = (roles: string[], handle: string, perms: string[]) => ctxOf('en', {
      mode: 'api', person: { handle, name: handle, jobTitle: '' }, me: { rolesByMs: { isms: roles } } as unknown as HostContext['me'],
      can: (_ms, perm) => (Array.isArray(perm) ? perm : [perm]).some((p) => perms.includes(p as string)),
    });
    const manager = api(['ms_manager'], 'rina', ['prep_task.update']);
    const owner = api(['domain_owner'], 'bagus', ['prep_task.update']);
    const other = api(['domain_owner'], 'dewi', ['prep_task.update']);
    expect([mayFinishItem(manager, prep), mayReassignItem(manager, prep)]).toEqual([true, true]);
    expect([mayFinishItem(owner, prep), mayReassignItem(owner, prep)]).toEqual([true, false]);
    expect([mayFinishItem(other, prep), mayReassignItem(other, prep)]).toEqual([false, false]);
    expect(itemVisible(manager, { kind: 'prep', ms: 'isms', recordKey: null, record: ['t', 'bagus', '2026-10-20', 'done'], close: () => undefined })).toBe(false);
    expect(itemVisible(manager, { kind: 'prep', ms: 'isms', recordKey: null, record: ['t', 'bagus', '2026-10-20', 'open'], close: () => undefined })).toBe(true);
    expect(itemOf('cycle', 'isms', ['9.3', 'Management review', 'hendra', '2026-10-28', 'open', ''], D)).toMatchObject({ kind: 'cycle', code: '9.3', auditDate: null });
    expect(itemOf('prep', 'isms', ['Approve SoA v3.0', 'hendra', '2026-10-15', 'open'], D)?.auditDate).toBe('2026-11-12');
  });
});

describe('API adapter', () => {
  const D_API = { ...D, refs: {
    'isms:prep:11111111-1111-4111-8111-111111111111': { module: 'audit', entityType: 'audit_prep_task', id: '11111111-1111-4111-8111-111111111111', code: 'Approve SoA v3.0', etag: 'W/"10"' },
    'isms:cycle:22222222-2222-4222-8222-222222222222': { module: 'surveillance', entityType: 'cycle_requirement_status', id: '22222222-2222-4222-8222-222222222222', code: '9.3', etag: 'W/"20"' },
  } } as unknown as ControllerData;
  const prep: ItemModel = { kind: 'prep', ms: 'isms', code: 'Approve SoA v3.0', title: 'Approve SoA v3.0', owner: 'hendra', due: '2026-10-15', status: 'open', auditDate: '2026-11-12' };

  function setup(routes: Parameters<typeof fakeFetch>[0]) {
    const f = fakeFetch(routes);
    const client = new ApiClient({ fetch: f.fetch, lang: 'en' });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    return { calls: f.calls, adapter: createApiAdapter(client, () => D_API) };
  }

  it('reads the cycles and the event detail in both languages', async () => {
    const { calls, adapter } = setup({
      'GET /api/v1/ms/isms/certification-cycles': json([CYCLE, ACTIVE]),
      'GET /api/v1/ms/isms/surveillance/events/7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e': (req) => json(DETAIL(req.headers['accept-language'] === 'id' ? 'Audit surveilans 1' : 'Surveillance audit 1')),
    });
    const cycles = await adapter.cycles('isms');
    expect(cycles.ok && cycles.data.map((c) => [c.status, c.etag, c.events.map((e) => e.shortLabel)])).toEqual([
      ['certified', 'W/"1790000000000"', ['Stage 2, certification', 'Surveillance 1']], ['active', 'W/"5"', ['Stage 2, certification', 'Surveillance 1']],
    ]);
    const detail = await adapter.eventDetail('isms', EVENT);
    expect(detail.ok && detail.data).toMatchObject({ nameEn: 'Surveillance audit 1', nameId: 'Audit surveilans 1', auditDays: 2, leadAuditor: 'Ir. Dwi Hartanto', eventType: 'surveillance' });
    expect(calls.filter((c) => c.path.includes('surveillance')).map((c) => c.headers['accept-language']).sort()).toEqual(['en', 'id']);
  });

  it('creates and edits an event: Idempotency-Key, CSRF, the BR-42 count, If-Match with the ETag of the last answer', async () => {
    const { calls, adapter } = setup({
      'POST /api/v1/ms/isms/audit-events': json({ ok: true, changed: ['isms'], message: ['Certification cycle started', 'Siklus sertifikasi dimulai'], ref: { module: 'audit', entityType: 'audit_event', id: EVENT.id, code: 'Stage 1', etag: 'W/"1"' } }, 201),
      'PATCH /api/v1/ms/isms/audit-events/7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e': [
        json({ ok: true, changed: ['isms'], count: 3, ref: { module: 'audit', entityType: 'audit_event', id: EVENT.id, code: 'Surveillance 1', etag: 'W/"2"' } }),
        problem(412, 'precondition-failed'),
      ],
    });
    const created = await adapter.createEvent('isms', createBody({ ...emptyEventForm('stage1'), scheduledAt: '2027-02-10' }), 'idem-1');
    expect(created.ok && created.data.message).toEqual(['Certification cycle started', 'Siklus sertifikasi dimulai']);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { eventType: 'stage1', scheduledAt: '2027-02-10' } });
    expect(calls[0].headers['idempotency-key']).toBe('idem-1');
    expect(calls[0].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    const first = await adapter.updateEvent('isms', EVENT, { scheduledAt: '2026-11-05' });
    expect(first.ok && first.data.count).toBe(3);
    expect(calls[1].headers['if-match']).toBeUndefined();
    const second = await adapter.updateEvent('isms', EVENT, { auditDays: 3 });
    expect(calls[2].headers['if-match']).toBe('W/"2"');
    expect(second.ok ? null : second.error.status).toBe(412);
  });

  it('starts a cycle, keeps the field errors of a refused certificate and moves a cycle with its ETag', async () => {
    const { calls, adapter } = setup({
      'POST /api/v1/ms/isms/certification-cycles': json({ ok: true, changed: ['isms'] }, 201),
      'POST /api/v1/ms/isms/certification': problem(400, 'validation', { errors: [{ path: 'body.expiresAt', message: 'expiresAt must be after issuedAt' }] }),
      'POST /api/v1/ms/isms/certification-cycles/6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d/transitions': json({ ok: true, changed: ['isms'] }),
    });
    expect((await adapter.startCycle('isms', { cycleStart: '2026-11-01' }, 'k')).ok).toBe(true);
    expect(calls[0].body).toEqual({ cycleStart: '2026-11-01' });
    const refused = await adapter.recordCertificate('isms', { certificateNo: 'X', issuedAt: '2026-10-01', expiresAt: '2026-09-01', certificationBody: 'B' });
    expect(refused.ok ? null : refused.error.errors).toEqual([{ path: 'body.expiresAt', message: 'expiresAt must be after issuedAt' }]);
    await adapter.transition('isms', fromCycle(CYCLE), 'suspended', '  Suspended by the body ');
    expect(calls[2]).toMatchObject({ method: 'POST', body: { to: 'suspended', reason: 'Suspended by the body' } });
    expect(calls[2].headers['if-match']).toBe('W/"1790000000000"');
  });

  it('marks a task that is not started done in two steps with the ETag chain, and changes holder and due date', async () => {
    const { calls, adapter } = setup({
      'PATCH /api/v1/ms/isms/prep-tasks/11111111-1111-4111-8111-111111111111': [
        json({ ok: true, changed: ['isms'], ref: { module: 'audit', entityType: 'audit_prep_task', id: '11111111-1111-4111-8111-111111111111', code: 'x', etag: 'W/"11"' } }),
        json({ ok: true, changed: ['isms'], ref: { module: 'audit', entityType: 'audit_prep_task', id: '11111111-1111-4111-8111-111111111111', code: 'x', etag: 'W/"12"' } }),
        problem(422, 'business-rule', { rule: 'BR-43', messages: { en: 'BR-43: due after the audit', id: 'BR-43: tenggat setelah audit' } }),
      ],
      'PATCH /api/v1/ms/isms/cycle-items/22222222-2222-4222-8222-222222222222': json({ ok: true, changed: ['isms'] }),
    });
    expect(itemRef(D_API, prep)?.id).toBe('11111111-1111-4111-8111-111111111111');
    expect((await adapter.markDone('isms', prep)).ok).toBe(true);
    expect(calls.map((c) => [c.body, c.headers['if-match']])).toEqual([[{ status: 'in_progress' }, 'W/"10"'], [{ status: 'done' }, 'W/"11"']]);
    const br43 = await adapter.updateItem('isms', prep, { dueAt: '2026-11-20' });
    expect(br43.ok ? null : [br43.error.rule, br43.error.message[0]]).toEqual(['BR-43', 'BR-43: due after the audit']);
    await adapter.markDone('isms', { ...prep, kind: 'cycle', code: '9.3', status: 'progress' });
    expect(calls[3]).toMatchObject({ path: '/api/v1/ms/isms/cycle-items/22222222-2222-4222-8222-222222222222', body: { status: 'done' } });
    expect(calls[3].headers['if-match']).toBe('W/"20"');
    expect((await adapter.markDone('isms', { ...prep, code: 'Unknown task' })).ok).toBe(false);
  });

  it('lists, generates and edits audit activities', async () => {
    const { calls, adapter } = setup({
      'GET /api/v1/ms/isms/audit-events/7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e/activities': json([ACTIVITY]),
      'POST /api/v1/ms/isms/audit-events/7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e/activities/generate': json({ ok: true, changed: ['isms'], count: 3, message: ['3 audit activities created from the templates', '3 aktivitas audit dibuat dari templat'] }),
      'PATCH /api/v1/ms/isms/audit-activities/3f4a5b6c-7d8e-4f9a-8b0c-1d2e3f4a5b6c': json({ ok: true, changed: ['isms'], warnings: [{ rule: 'AUD-INDEP', messages: { en: 'The auditor owns this control', id: 'Auditor memiliki kontrol ini' } }] }),
    });
    const list = await adapter.activities('isms', EVENT);
    expect(list.ok && list.data[0]).toMatchObject({ id: ACTIVITY.ref.id, code: 'AA-S1-01', clauseRef: '4.3' });
    const generated = await adapter.generate('isms', EVENT);
    expect(generated.ok && generated.data.count).toBe(3);
    const saved = await adapter.updateActivity('isms', list.ok ? list.data[0] : (null as never), { auditorHandle: 'bagus' });
    expect(saved.ok && saved.data.warnings).toEqual([{ rule: 'AUD-INDEP', message: ['The auditor owns this control', 'Auditor memiliki kontrol ini'] }]);
    expect(calls[2]).toMatchObject({ method: 'PATCH', body: { auditorHandle: 'bagus' } });
  });
});

describe('sample adapter', () => {
  async function sample(org = 'ndt') {
    const ds = createSampleDataSource({ org });
    let snap = await ds.load();
    const env = { getD: () => dataOf(snap), getDs: () => ds as never, getOrg: () => org };
    const adapter = createSampleAdapter(env);
    const reload = async (ms: string) => { snap = await ds.reload(snap, [ms]); };
    return { ds, adapter, reload, D: () => dataOf(snap) };
  }

  it('starts with the cycles the demo seed writes and the event types of the sample labels', async () => {
    const { adapter } = await sample();
    const isms = await adapter.cycles('isms');
    expect(isms.ok && isms.data[0]).toMatchObject({ status: 'certified', cycleStart: '2025-03-14', cycleEnd: '2028-03-14', certificateExpiresAt: '2028-03-13', certificationBody: 'PT Sertifikasi Nusantara' });
    expect(isms.ok && isms.data[0].events.map((e) => e.eventType)).toEqual(['stage1', 'stage2', 'surveillance', 'surveillance', 'recertification']);
    const bcms = await adapter.cycles('bcms');
    expect(bcms.ok && bcms.data[0].status).toBe('planned');
    expect(sampleExpiry('2026-06-22', '2026-09-29')).toBe('2026-12-31');
    expect(sampleEventType('Recert + transition')).toBe('recertification');
  });

  it('activates the planned cycle, refuses the certificate before a recommended result and records it after', async () => {
    const { adapter, reload, D: data } = await sample();
    expect((await adapter.startCycle('bcms', { cycleStart: '2026-10-01' }, 'k')).ok).toBe(true);
    expect((await adapter.startCycle('bcms', { cycleStart: '2026-10-01' }, 'k')).ok).toBe(false);
    const cycles = async () => { const r = await adapter.cycles('bcms'); return r.ok ? r.data : []; };
    expect((await cycles())[0]).toMatchObject({ status: 'active', cycleStart: '2026-10-01', cycleEnd: '2029-10-01' });
    const refused = await adapter.recordCertificate('bcms', { certificateNo: 'BCMS-1', issuedAt: '2026-10-01', expiresAt: '2029-09-30', certificationBody: 'PT Sertifikasi Nusantara' });
    expect(refused.ok ? null : refused.error.message).toEqual([TEXT.certNeedsResult[0], TEXT.certNeedsResult[1]]);
    const stage2 = resolveEvent(await cycles(), 'bcms', 1, data().EVENTS.bcms[1])!;
    expect(stage2.eventType).toBe('stage2');
    expect((await adapter.updateEvent('bcms', stage2, { scheduledAt: '2026-09-20', outcome: 'recommended', outcomeSummary: 'Recommended' })).ok).toBe(true);
    await reload('bcms');
    expect(data().EVENTS.bcms[1]).toMatchObject({ d: '2026-09-20', result: ['Recommended', 'Recommended'] });
    expect((await adapter.recordCertificate('bcms', { certificateNo: 'BCMS-1', issuedAt: '2026-10-01', expiresAt: '2029-09-30', certificationBody: 'PT Sertifikasi Nusantara' })).ok).toBe(true);
    expect((await cycles())[0]).toMatchObject({ status: 'certified', certificateNo: 'BCMS-1', certificateExpiresAt: '2029-09-30' });
  });

  it('moves a cycle with a reason and its ETag; a stale ETag answers 412', async () => {
    const { adapter } = await sample();
    const first = (await adapter.cycles('isms') as { ok: true; data: CycleModel[] }).data[0];
    // J.8: a certified cycle is not withdrawn directly; the sample answers 409 as the server does.
    const direct = await adapter.transition('isms', first, 'withdrawn', 'Withdrawn by the certification body');
    expect(direct.ok ? null : direct.error.status).toBe(409);
    expect((await adapter.transition('isms', first, 'suspended', 'Suspended by the certification body')).ok).toBe(true);
    const stale = await adapter.transition('isms', first, 'certified', 'Lifted');
    expect(stale.ok ? null : stale.error.status).toBe(412);
    const fresh = (await adapter.cycles('isms') as { ok: true; data: CycleModel[] }).data[0];
    expect(fresh.status).toBe('suspended');
    expect((await adapter.transition('isms', fresh, 'closed', 'Not allowed')).ok).toBe(false);
    expect((await adapter.transition('isms', fresh, 'certified', 'no')).ok).toBe(false);
    expect((await adapter.transition('isms', fresh, 'certified', 'Suspension lifted')).ok).toBe(true);
  });

  it('marks items done and reassigns them in the sample snapshot, with BR-43; generates the templates once', async () => {
    const { adapter, reload, D: data } = await sample();
    const item = itemOf('prep', 'isms', data().PREP.isms[2], data())!;
    expect((await adapter.updateItem('isms', item, { dueAt: '2026-11-12' })).ok).toBe(false);
    expect((await adapter.updateItem('isms', item, { ownerHandle: 'rina', dueAt: '2026-10-20' })).ok).toBe(true);
    expect((await adapter.markDone('isms', item)).ok).toBe(true);
    await reload('isms');
    expect(data().PREP.isms[2]).toEqual(['Approve SoA v3.0', 'rina', '2026-10-20', 'done']);
    const stage1 = resolveEvent((await adapter.cycles('isms') as { ok: true; data: CycleModel[] }).data, 'isms', 0, data().EVENTS.isms[0])!;
    const generated = await adapter.generate('isms', stage1);
    expect(generated.ok && generated.data.count).toBe(3);
    const again = await adapter.generate('isms', stage1);
    expect(again.ok && again.data.count).toBe(0);
    const list = await adapter.activities('isms', stage1);
    expect(list.ok && list.data.map((a) => a.code)).toEqual(['AA-S1-01', 'AA-S1-02', 'AA-S1-03']);
  });

  it('keeps one state per organisation', async () => {
    const a = await sample('ndt');
    const b = await sample('rmn');
    const isms = (await a.adapter.cycles('isms') as { ok: true; data: CycleModel[] }).data[0];
    await a.adapter.transition('isms', isms, 'suspended', 'Suspended by the body');
    expect((await a.adapter.cycles('isms') as { ok: true; data: CycleModel[] }).data[0].status).toBe('suspended');
    const other = await b.adapter.cycles('isms');
    expect(other.ok && other.data[0].status).not.toBe('suspended');
  });
});

describe('claim, page actions and store', () => {
  it('both builds open the form for the MS Manager only', () => {
    const toast = vi.fn();
    addEvent(ctxOf('en', { toast }), { ms: 'abms' });
    expect(toast).not.toHaveBeenCalled();
    expect(formRequest()).toMatchObject({ type: 'add', ms: 'abms' });
    closeForm();
    const top = vi.fn();
    addEvent(ctxOf('en', { toast: top, role: 'top', can: () => false }), { ms: 'abms' });
    expect(top).toHaveBeenCalledWith(TEXT.noAddRight[0]);
    expect(formRequest()).toBeNull();
    const refused = vi.fn();
    addEvent(ctxOf('id', { mode: 'api', toast: refused, can: () => false }), { ms: 'abms' });
    expect(refused).toHaveBeenCalledWith(TEXT.noAddRight[1]);
    addEvent(ctxOf('en', { mode: 'api' }), { ms: 'abms' });
    expect(formRequest()).toMatchObject({ type: 'add', ms: 'abms' });
    closeForm();
    expect(actions.claims?.['timeline.addEvent']).toBeTypeOf('function');
    expect(actions.detailExtensions?.map((e) => [e.id, e.kind])).toEqual([['timeline-edit.event', 'event'], ['timeline-edit.prep', 'prep'], ['timeline-edit.cycle', 'cycle']]);
  });

  it('shows "Start certification cycle" without an active cycle and "Record certificate" with one, in both builds', async () => {
    const [start, cert] = extraPageActions;
    const api = ctxOf('en', { mode: 'api' });
    expect([start.visible!(api), cert.visible!(api)]).toEqual([false, false]);
    const adapter = { cycles: async () => ({ ok: true as const, data: [fromCycle(CYCLE)] }) } as never;
    await loadCycles(api, adapter, 'isms');
    expect(cyclesEntry(api, 'isms')?.data?.length).toBe(1);
    expect([start.visible!(api), cert.visible!(api)]).toEqual([true, false]);
    await loadCycles(api, { cycles: async () => ({ ok: true as const, data: [fromCycle(ACTIVE)] }) } as never, 'isms', true);
    expect([start.visible!(api), cert.visible!(api)]).toEqual([false, true]);
    // A suspended certificate waits for the certification body to reinstate or withdraw it, as on the cycle panel.
    const suspended = fromCycle({ ...CYCLE, status: 'suspended' });
    await loadCycles(api, { cycles: async () => ({ ok: true as const, data: [suspended] }) } as never, 'isms', true);
    expect([start.visible!(api), cert.visible!(api)]).toEqual([false, false]);
    // Only the newest cycle counts: the sample adapter lists a new cycle after the older ones.
    const next = fromCycle({ ...CYCLE, id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e', status: 'withdrawn', cycleStart: '2026-01-10', cycleEnd: '2029-01-10' });
    expect(cycleMayStart([suspended, next])).toBe(true);
    expect(cycleMayStart([next, { ...suspended, cycleStart: '2026-06-01' }])).toBe(false);
    expect(cycleMayStart([])).toBe(true);
    await loadCycles(api, { cycles: async () => ({ ok: true as const, data: [{ ...suspended, status: 'certified' as const }] }) } as never, 'isms', true);
    expect([start.visible!(api), cert.visible!(api)]).toEqual([true, false]);
    // The sample build follows the same rule with the cycles its adapter loaded, for the persona that manages events.
    expect([start.visible!(ctxOf('en')), cert.visible!(ctxOf('en'))]).toEqual([true, false]);
    const top = ctxOf('en', { role: 'top', can: () => false });
    expect([start.visible!(top), cert.visible!(top)]).toEqual([false, false]);
    start.run(api);
    expect(formRequest()).toMatchObject({ type: 'start', ms: 'isms' });
  });

  it('a deferred adapter loads its module on first use and again after a failed load', async () => {
    let calls = 0;
    const adapter = deferredAdapter(async () => {
      calls += 1;
      if (calls === 1) throw new Error('chunk failed');
      return { cycles: async () => ({ ok: true, data: [] }) } as never;
    });
    await expect(adapter.cycles('isms')).rejects.toThrow('chunk failed');
    expect(await adapter.cycles('isms')).toEqual({ ok: true, data: [] });
    expect(adapter.sample).toBe(true);
  });
});

describe('panels and forms', () => {
  const certified = fromCycle({ ...CYCLE, certificateExpiresAt: '2026-11-30' });
  for (const lang of ['en', 'id'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the certification cycle panel in ${lang}, ${theme}`, () => {
        const ctx = ctxOf(lang);
        const html = render(<CyclePanel ctx={ctx} ms="isms" cycle={certified} cycles={[certified]} inCycle />, ctx, theme);
        expect(html).toContain(ctx.li(TEXT.panelTitle));
        expect(html).toContain('ISMS-2025-0147');
        expect(html).toContain(ctx.li(TEXT.suspend));
        expect(html).not.toContain(ctx.li(TEXT.withdraw));
        expect(html).toContain(lang === 'en' ? '30 Nov 2026, in 62 days' : '30 Nov 2026, 62 hari lagi');
        expect(html).toContain(ctx.fill(TEXT.expiringSoon, { n: 62 }));
        expect(html).not.toMatch(/[—·]/);
      });
    }
  }

  it('an active cycle offers Record certificate with its reason until a recommended result, and Close cycle', () => {
    const ctx = ctxOf('en');
    const active = fromCycle({ ...ACTIVE, events: [] });
    const html = render(<CyclePanel ctx={ctx} ms="isms" cycle={active} cycles={[active]} inCycle />, ctx);
    expect(html).toContain('Record certificate');
    expect(html).toContain(TEXT.certNeedsResult[0]);
    expect(html).toContain('Close cycle');
    const readOnly = render(<CyclePanel ctx={ctxOf('en', { can: () => false })} ms="isms" cycle={active} cycles={[active]} inCycle />, ctx);
    expect(readOnly).not.toContain('Record certificate');
    expect(readOnly).not.toContain('Close cycle');
    const none = render(<CyclePanel ctx={ctx} ms="abms" cycle={null} cycles={[]} inCycle={false} />, ctx);
    expect(none).toContain('Start certification cycle');
  });

  it('offers "Start certification cycle" after a cycle ended or next to a certified one, while no cycle is active', () => {
    const ctx = ctxOf('en');
    for (const status of ['withdrawn', 'closed', 'expired', 'certified', 'planned'] as const) {
      const cycle = fromCycle({ ...CYCLE, status });
      expect(render(<CyclePanel ctx={ctx} ms="isms" cycle={cycle} cycles={[cycle]} inCycle />, ctx), status).toContain('Start certification cycle');
      const withActive = render(<CyclePanel ctx={ctx} ms="isms" cycle={cycle} cycles={[fromCycle(ACTIVE), cycle]} inCycle />, ctx);
      expect(withActive, status).not.toContain('Start certification cycle');
      const readOnly = render(<CyclePanel ctx={ctxOf('en', { can: () => false })} ms="isms" cycle={cycle} cycles={[cycle]} inCycle />, ctx);
      expect(readOnly, status).not.toContain('Start certification cycle');
    }
    // A suspended certificate waits for the certification body: reinstate or withdraw, no new cycle yet.
    const suspended = fromCycle({ ...CYCLE, status: 'suspended' });
    const html = render(<CyclePanel ctx={ctx} ms="isms" cycle={suspended} cycles={[suspended]} inCycle />, ctx);
    expect(html).not.toContain('Start certification cycle');
    expect(html).toContain(TEXT.withdraw[0]);
  });

  for (const lang of ['en', 'id'] as const) {
    it(`a move the latest cycle no longer allows keeps Save off with the reason, in ${lang}`, () => {
      const ctx = ctxOf(lang);
      const at = Date.now();
      const suspended = fromCycle({ ...CYCLE, status: 'suspended' });
      const status = ctx.li(TEXT.cySuspended).toLowerCase();
      const already = render(<Forms ctx={ctx} request={{ type: 'move', ms: 'isms', cycle: suspended, to: 'suspended', at }} />, ctx);
      expect(already).toContain(ctx.fill(TEXT.moveAlready, { status }));
      expect(already).toMatch(/<button[^>]*disabled[^>]*>[^<]*<\/button>/);
      const closed = render(<Forms ctx={ctx} request={{ type: 'move', ms: 'isms', cycle: suspended, to: 'closed', at }} />, ctx);
      expect(closed).toContain(ctx.fill(TEXT.moveStale, { status }));
      const allowed = render(<Forms ctx={ctx} request={{ type: 'move', ms: 'isms', cycle: suspended, to: 'withdrawn', at }} />, ctx);
      expect(allowed).not.toContain(ctx.fill(TEXT.moveStale, { status }));
      expect(allowed).not.toContain(ctx.fill(TEXT.moveAlready, { status }));
    });
  }

  for (const lang of ['en', 'id'] as const) {
    it(`a form whose audit event could not be loaded says so, keeps Save off with that reason and offers Try again, in ${lang}`, () => {
      const ctx = ctxOf(lang);
      const error = { status: 503, slug: 'unavailable', message: ['The service is not available.', 'Layanan tidak tersedia.'] as [string, string] };
      // Save of Edit and Record result: off while the event loads, off with the failure once its load failed.
      expect(detailReason({ detail: null, error: null })).toBe(TEXT.loadingEvent);
      expect(detailReason({ detail: null, error })).toBe(TEXT.eventLoadFailed);
      expect(detailReason({ detail: EVENT_DETAIL, error: null })).toBeNull();
      expect(render(<DetailLoadError ctx={ctx} error={null} onRetry={() => undefined} />, ctx)).not.toContain('mx-alert');
      for (const theme of ['light', 'dark'] as const) {
        const html = render(<DetailLoadError ctx={ctx} error={error} onRetry={() => undefined} />, ctx, theme);
        expect(html).toContain(ctx.li(TEXT.eventLoadFailed));
        expect(html).toContain(ctx.li(error.message));
        expect(html).toMatch(new RegExp(`<button[^>]*>${ctx.li(TEXT.tryAgain)}</button>`));
        expect(html).not.toMatch(/<button[^>]*disabled/);
        expect(html).not.toMatch(/[—·]/);
      }
      // "Try again" loads the event once more.
      const onRetry = vi.fn();
      const retry = findElement(DetailLoadError({ ctx, error, onRetry }), (el) => el.type === Button);
      (retry?.props as { onClick(): void }).onClick();
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  }

  for (const lang of ['en', 'id'] as const) {
    it(`every form renders its fields in ${lang}`, () => {
      const ctx = ctxOf(lang);
      const at = Date.now();
      const item: ItemModel = { kind: 'prep', ms: 'isms', code: 'Approve SoA v3.0', title: 'Approve SoA v3.0', owner: 'hendra', due: '2026-10-15', status: 'open', auditDate: '2026-11-12' };
      const html = [
        render(<Forms ctx={ctx} request={{ type: 'add', ms: 'isms', at }} />, ctx),
        render(<Forms ctx={ctx} request={{ type: 'start', ms: 'bcms', at }} />, ctx),
        render(<Forms ctx={ctx} request={{ type: 'certificate', ms: 'isms', at }} />, ctx, 'dark'),
        render(<Forms ctx={ctx} request={{ type: 'move', ms: 'isms', cycle: certified, to: 'suspended', at }} />, ctx),
        render(<Forms ctx={ctx} request={{ type: 'activity', ms: 'isms', event: EVENT, activity: { id: 'a', code: 'AA-S1-01', templateCode: 'AA-S1-01', title: 'Review scope', clauseRef: '4.3', keyQuestions: 'Q?', evidenceToRequest: 'E', auditee: null, auditor: null, targetCode: null, scheduledAt: null, status: 'planned', note: null }, at }} />, ctx),
        render(<Forms ctx={ctx} request={{ type: 'item', ms: 'isms', item, at }} />, ctx),
      ].join('');
      for (const label of [TEXT.addTitle, TEXT.fNameEn, TEXT.fWindow, TEXT.startTitle, TEXT.fEnd, TEXT.certTitle, TEXT.fCertificate, TEXT.suspendTitle, TEXT.fReason, TEXT.fAuditee, TEXT.keyQuestions, TEXT.itemTitle, TEXT.fDue]) {
        expect(html).toContain(ctx.li(label));
      }
      expect(html).toContain('role="dialog"');
      expect(html).not.toMatch(/[—·]/);
    });
  }

  it('every text pair has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    const same = new Set(['fAuditor', 'fStatus']);
    for (const [key, [en, id]] of Object.entries(TEXT)) {
      expect(en.trim(), key).not.toBe('');
      expect(id.trim(), key).not.toBe('');
      if (!same.has(key)) expect(id, key).not.toBe(en);
      expect(`${en} ${id}`, key).not.toMatch(/[—·]/);
    }
  });
});
