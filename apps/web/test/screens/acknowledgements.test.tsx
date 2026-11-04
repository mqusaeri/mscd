// Policy read confirmations (MILESTONE-3 M3-05, D.7): routes against the shared table, the model (audience texts, tones,
// checks before a request), the API adapter over a fake fetch (requests, the person list, a request by hand,
// reminders, close and file, the CSV link, the settings of a document with If-Match and the BR-22 confirmation), the
// sample adapter and its rules, the page action and the section of a document's detail, and the views in both
// languages and themes. M3-14: each person's own due date and the day they were added, the excusal reasons in both
// languages, the register columns, the close dialog's proposal and warning, and "Ask the people who have not confirmed".
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/acknowledgements/index';
import { ROUTES, ROUTE_IDS, pathOf } from '../../src/screens/acknowledgements/routes';
import { createApiAdapter, fromDetail, fromItem, outcomeOf, resetSavedSettings } from '../../src/screens/acknowledgements/api';
import { createSampleAdapter, csvCell, registerCsv, REGISTER_COLUMNS } from '../../src/screens/acknowledgements/sample';
import { personDue, resetSampleAcknowledgements, sampleAudience, sampleState } from '../../src/screens/acknowledgements/sample-store';
import { adapterFor, deferredAdapter } from '../../src/screens/acknowledgements/adapter';
import {
  AUDIENCE_ROLES, DEFAULT_SETTINGS, EXCUSED_REASONS, SCREEN_PERMS, approvedDocuments, askBlock, audienceText, confirmedShare, errorText, evidenceItems,
  earlierConfirmedOf, excusedReasonText, mayAskAgain, otherRegisterOf, personStatus, proposedEvidenceId, recordSettings, requestsOf, settingsBody,
} from '../../src/screens/acknowledgements/model';
import type { AcknowledgementsAdapter, RequestRow } from '../../src/screens/acknowledgements/model';
import { AskDialog, CloseDialog, PeopleTable, RequestDrawer, RequestsTable, TotalsTiles } from '../../src/screens/acknowledgements/Screen';
import AcknowledgementsScreen from '../../src/screens/acknowledgements/Screen';
import DocSection, { SettingsDialog, latestLine, settingsBlock } from '../../src/screens/acknowledgements/DocSection';
import { detailExtensions, extraPageActions, mayOpenRegister, sectionVisible } from '../../src/screens/acknowledgements/actions';
import { TEXT } from '../../src/screens/acknowledgements/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { fakeFetch, json, problem } from '../auth/helpers';

const snapshot = await createSampleDataSource().load();
const D = { ...makeDates(SAMPLE.TODAY_S), ...snapshot, TODAY_S: SAMPLE.TODAY_S } as unknown as ControllerData;
const isms = D.MS.find((m) => m.id === 'isms')!;
const DOC_ID = '0f1a2b3c-4d5e-4f6a-9b7c-8d9e0f1a2b3c';
const API_D = { ...D, refs: { 'isms:doc:POL-01': { module: 'implementation', entityType: 'document', id: DOC_ID, code: 'POL-01', etag: 'W/"7"' }, 'isms:ev:EV-0101': { module: 'implementation', entityType: 'evidence', id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', code: 'EV-0101' } } } as unknown as ControllerData;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: isms, org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'acknowledgements', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

/** Text as React writes it into markup. */
const html = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const ITEM = {
  id: '9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b', ms: 'isms', document: { id: DOC_ID, code: 'POL-01', title: 'Information Security Policy' },
  version: { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', label: '4.0' }, status: 'open', audienceScope: 'system_roles', audienceRoles: null,
  dueOn: '2026-10-13', createdAt: '2026-09-29T02:00:00Z', lastRemindedAt: null, closedAt: null, evidenceId: null,
  totals: { audience: 10, confirmed: 6, pending: 3, overdue: 1, excused: 1 },
} as const;
const PERSON = {
  person: { handle: 'bagus', displayName: 'Bagus Prasetyo' }, status: 'confirmed', openedAt: '2026-09-30T03:00:00Z', confirmedAt: '2026-09-30T03:05:00Z', reminderCount: 0,
  excusedReason: null, overdue: false, addedOn: '2026-09-29', dueOn: '2026-10-13',
} as const;
const ROW: RequestRow = fromItem(ITEM as never);

afterEach(() => {
  resetSampleAcknowledgements();
  resetSavedSettings();
});

describe('acknowledgement routes', () => {
  it('match the shared route table, with the permissions of D.1', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.create).permission).toBe('acknowledgement.manage');
    expect(routeById(ROUTE_IDS.export).permission).toBe('audit.pending.all');
    expect(routeById(ROUTE_IDS.get).anyOf!.map((a) => a.permission)).toEqual(['audit.pending.all', 'audit.pending.aggregate']);
    expect(routeById(ROUTE_IDS.list).anyOf!.map((a) => a.permission)).toEqual(['acknowledgement.manage', 'audit.pending.aggregate']);
    expect(pathOf(ROUTES.export, { ms: 'isms', id: 'a b' })).toBe('/api/v1/ms/isms/acknowledgement-requests/a%20b/export');
  });
});

describe('acknowledgement model', () => {
  const ctx = ctxOf('en');
  it('names the audience, the status of a person and the confirmed share', () => {
    expect(audienceText(ctx, 'system_roles', null)).toBe(TEXT.scopeSystemRoles[0]);
    expect(audienceText(ctx, 'organisation', null)).toBe(TEXT.scopeOrganisation[0]);
    expect(audienceText(ctx, 'roles', ['domain_owner', 'top_management'])).toBe('Holders of: Domain Owner, Top Management');
    expect(audienceText(ctxOf('id'), 'roles', ['ms_manager'])).toBe('Pemegang peran: Management System Manager');
    expect(personStatus({ status: 'pending', overdue: true })).toEqual({ tone: 'bad', label: TEXT.personOverdue });
    expect(personStatus({ status: 'pending', overdue: false })).toEqual({ tone: 'warn', label: TEXT.personPending });
    expect(personStatus({ status: 'confirmed', overdue: false }).tone).toBe('ok');
    expect(personStatus({ status: 'excused', overdue: false }).tone).toBe('mute');
    expect(confirmedShare(ROW.totals)).toBe(67);
    expect(confirmedShare({ audience: 0, confirmed: 0, pending: 0, overdue: 0, excused: 0 })).toBe(0);
    expect(AUDIENCE_ROLES).not.toContain('external_auditor');
  });

  it('picks approved documents and evidence items of the snapshot, the requests of a document, and checks a request', () => {
    const docs = approvedDocuments(D, 'isms');
    expect(docs.map((d) => d.code)).toContain('POL-01');
    expect(docs.every((d) => d.version !== '-')).toBe(true);
    expect(docs.map((d) => d.code)).not.toContain('PRC-16');
    expect(evidenceItems(D, 'isms').length).toBeGreaterThan(5);
    expect(requestsOf([ROW, { ...ROW, id: 'x', createdAt: '2026-10-01T00:00:00Z' }, { ...ROW, id: 'y', document: { ...ROW.document, code: 'POL-14' } }], 'POL-01').map((r) => r.id)).toEqual(['x', ROW.id]);
    expect(askBlock({ documentId: null, scope: 'system_roles', roles: [], dueDays: '14' })).toEqual(TEXT.chooseDocument);
    expect(askBlock({ documentId: 'd', scope: 'roles', roles: [], dueDays: '14' })).toEqual(TEXT.chooseRoles);
    for (const days of ['0', '91', '1.5', '', 'x']) expect(askBlock({ documentId: 'd', scope: 'system_roles', roles: [], dueDays: days }), days).toEqual(TEXT.badDays);
    expect(askBlock({ documentId: 'd', scope: 'roles', roles: ['domain_owner'], dueDays: '30' })).toBeNull();
    expect(settingsBody({ required: true, scope: 'system_roles', roles: ['domain_owner'], dueDays: 14 })).toEqual({ required: true, scope: 'system_roles', roles: null, dueDays: 14 });
    expect(recordSettings({ acknowledgement: { required: true, scope: 'roles', roles: ['risk_owner'], dueDays: 7 } })).toEqual({ required: true, scope: 'roles', roles: ['risk_owner'], dueDays: 7 });
    expect(recordSettings({ id: 'POL-01' })).toBeNull();
    expect(errorText(ctx, { status: 500, message: ['Failed', 'Failed'], detail: 'boom' })).toBe('Failed: boom');
    expect(settingsBlock({ required: true, scope: 'roles', roles: [], dueDays: '14' })).toEqual(TEXT.chooseRoles);
    expect(settingsBlock({ required: false, scope: 'system_roles', roles: [], dueDays: '100' })).toEqual(TEXT.badDays);
    expect(settingsBlock({ required: true, scope: 'organisation', roles: [], dueDays: '14' })).toBeNull();
    // Unknown stored settings: nothing is saved until the manager chose whether people are asked.
    expect(settingsBlock({ required: null, scope: 'system_roles', roles: [], dueDays: '14' })).toEqual(TEXT.chooseRequired);
    expect(settingsBlock({ required: false, scope: 'system_roles', roles: [], dueDays: '14' })).toBeNull();
  });

  it('shows the stored excusal reasons in both languages, and an unknown one as stored (M3-14, texts B4)', () => {
    expect(excusedReasonText('Membership of the organisation ended')).toEqual(['Membership of the organisation ended', 'Keanggotaan di organisasi telah berakhir']);
    expect(excusedReasonText('No longer holds a role that is asked to confirm')[1]).toBe('Tidak lagi memegang peran yang diminta mengonfirmasi');
    expect(excusedReasonText('The document is restricted to its owner, Management System Managers and Programme Owners')[1]).toBe('Dokumen dibatasi untuk pemiliknya, Management System Manager, dan Pemilik Program');
    expect(excusedReasonText('The person was erased at their request')[1]).toBe('Data pribadi orang tersebut dihapus atas permintaannya');
    expect(excusedReasonText('Replaced by version 5.0')).toEqual(['Replaced by version 5.0', 'Diganti oleh versi 5.0']);
    expect(excusedReasonText('Left for another reason')).toEqual(['Left for another reason', 'Left for another reason']);
    for (const [stored, pair] of Object.entries(EXCUSED_REASONS)) {
      expect(pair[0], stored).toBe(stored);
      expect(pair[1], stored).not.toBe(stored);
    }
  });

  it('proposes the evidence item of the policy, warns about another policy\'s register, and offers to ask again (M3-14)', () => {
    const EV_A = 'ev-a';
    const EV_B = 'ev-b';
    const earlier = { ...ROW, id: 'p1', status: 'closed' as const, createdAt: '2026-06-01T00:00:00Z', closedAt: '2026-06-20T00:00:00Z', evidenceId: EV_A };
    const otherDoc = { ...ROW, id: 'p2', status: 'closed' as const, document: { ...ROW.document, code: 'POL-14' }, closedAt: '2026-07-01T00:00:00Z', evidenceId: EV_B };
    const rows = [ROW, earlier, otherDoc];
    expect(proposedEvidenceId(rows, 'POL-01', ROW.id)).toBe(EV_A);
    expect(proposedEvidenceId(rows, 'POL-14', 'p2')).toBeNull();
    expect(otherRegisterOf(rows, EV_B, 'POL-01')).toBe('POL-14');
    expect(otherRegisterOf(rows, EV_A, 'POL-01')).toBeNull();
    expect(otherRegisterOf(rows, null, 'POL-01')).toBeNull();
    // The confirmations of earlier requests of the same version, which the register lists too.
    const firstOfVersion = { ...earlier, totals: { ...earlier.totals, confirmed: 4 } };
    const otherVersion = { ...earlier, id: 'p0', version: { id: 'v-old', label: '3.0' }, createdAt: '2026-01-01T00:00:00Z' };
    expect(earlierConfirmedOf([ROW, firstOfVersion, otherVersion, otherDoc], ROW)).toBe(4);
    expect(earlierConfirmedOf([ROW, firstOfVersion], firstOfVersion)).toBe(0);
    expect(earlierConfirmedOf([ROW], ROW)).toBe(0);
    const approved = [{ code: 'POL-01', version: '4.0' }];
    const closed = { ...ROW, status: 'closed' as const, closedAt: '2026-10-20T00:00:00Z' };
    expect(mayAskAgain([closed], closed, approved)).toBe(true);
    // Not while the document has an open request, not when everyone confirmed, not for an earlier version.
    expect(mayAskAgain([closed, ROW], closed, approved)).toBe(false);
    expect(mayAskAgain([closed], { ...closed, totals: { ...closed.totals, confirmed: 10 } }, approved)).toBe(false);
    expect(mayAskAgain([closed], closed, [{ code: 'POL-01', version: '5.0' }])).toBe(false);
    expect(mayAskAgain([ROW], ROW, approved)).toBe(false);
  });
});

describe('acknowledgement API adapter', () => {
  it('reads requests and the person list, asks, reminds, closes into an evidence item and offers the CSV link', async () => {
    const f = fakeFetch({
      'GET /api/v1/ms/isms/acknowledgement-requests': json([ITEM]),
      [`GET /api/v1/ms/isms/acknowledgement-requests/${ITEM.id}`]: json({ ...ITEM, people: [PERSON] }),
      'POST /api/v1/ms/isms/acknowledgement-requests': json({ ok: true, changed: ['isms'], data: { id: ITEM.id, audience: 9, dueOn: '2026-10-13' }, message: ['Asked 9 people to confirm POL-01 version 4.0', '9 orang diminta mengonfirmasi POL-01 versi 4.0'] }, 201),
      [`POST /api/v1/ms/isms/acknowledgement-requests/${ITEM.id}/remind`]: [json({ ok: true, changed: ['isms'], count: 3 }), problem(409, 'conflict', { messageKey: 'acknowledgements.reminded_today', messages: { en: 'Reminded today', id: 'Sudah diingatkan' } })],
      [`POST /api/v1/ms/isms/acknowledgement-requests/${ITEM.id}/close`]: json({ ok: true, changed: ['isms'], data: { evidenceCode: 'EV-0101' } }),
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client, () => API_D);
    expect(await adapter.list('isms')).toEqual({ ok: true, data: [ROW] });
    const detail = await adapter.get('isms', ITEM.id);
    expect(detail).toMatchObject({ ok: true, data: { people: [{ handle: 'bagus', name: 'Bagus Prasetyo', status: 'confirmed', reminderCount: 0, addedOn: '2026-09-29', dueOn: '2026-10-13' }] } });
    expect(fromDetail(ITEM as never).people).toBeUndefined();
    const asked = await adapter.ask('isms', { documentId: DOC_ID, scope: 'roles', roles: ['domain_owner'], dueDays: 21 });
    expect(asked).toMatchObject({ ok: true, data: { changed: ['isms'], message: ['Asked 9 people to confirm POL-01 version 4.0', '9 orang diminta mengonfirmasi POL-01 versi 4.0'] } });
    expect(f.calls.at(-1)).toMatchObject({ method: 'POST', body: { documentId: DOC_ID, audience: { scope: 'roles', roles: ['domain_owner'] }, dueDays: 21 }, headers: { 'idempotency-key': expect.any(String) } });
    await adapter.ask('isms', { documentId: DOC_ID, scope: 'system_roles', roles: ['domain_owner'], dueDays: 14 });
    expect(f.calls.at(-1)!.body).toEqual({ documentId: DOC_ID, audience: { scope: 'system_roles' }, dueDays: 14 });
    expect(await adapter.remind('isms', ITEM.id)).toMatchObject({ ok: true, data: { count: 3 } });
    expect(await adapter.remind('isms', ITEM.id)).toMatchObject({ ok: false, error: { status: 409, messageKey: 'acknowledgements.reminded_today' } });
    expect(await adapter.close('isms', ITEM.id, adapter.evidenceId('isms', 'EV-0101'))).toMatchObject({ ok: true, data: { data: { evidenceCode: 'EV-0101' } } });
    expect(f.calls.at(-1)!.body).toEqual({ evidenceId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e' });
    await adapter.close('isms', ITEM.id, null);
    expect(f.calls.at(-1)!.body).toEqual({});
    const csv = await adapter.exportCsv('isms', ROW);
    expect(csv).toMatchObject({ ok: true, data: { href: `/api/v1/ms/isms/acknowledgement-requests/${ITEM.id}/export`, fileName: expect.stringMatching(/^read-confirmations-POL-01-v4\.0-\d{4}-\d{2}-\d{2}\.csv$/) } });
    expect(adapter.documentId('isms', 'POL-01')).toBe(DOC_ID);
    expect(adapter.documentId('isms', 'POL-99')).toBeNull();
    expect(outcomeOf({ ok: true, status: 200, data: { ok: true, changed: [] } })).toEqual({ ok: true, data: { changed: [], message: null, warnings: [] } });
  });

  it('saves the settings of a document with its ETag, asks first for a shared document, and remembers them', async () => {
    const shared = problem(409, 'confirmation-required', { rule: 'BR-22', affected: ['qms'], messages: { en: 'This change also applies to: QMS. Continue?', id: 'Perubahan ini juga berlaku untuk: QMS. Lanjutkan?' } });
    const f = fakeFetch({ [`PATCH /api/v1/ms/isms/documents/${DOC_ID}`]: [shared, json({ ok: true, changed: ['isms', 'qms'] })] });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client, () => API_D, () => 'org-a');
    const settings = { required: true, scope: 'roles' as const, roles: ['domain_owner' as const], dueDays: 21 };
    expect(adapter.settingsOf('isms', 'POL-01', { id: 'POL-01' })).toEqual(DEFAULT_SETTINGS);
    expect(adapter.settingsOf('isms', 'POL-01', null)).toBeNull();
    expect(await adapter.saveSettings('isms', 'POL-01', settings, false)).toMatchObject({ ok: false, error: { status: 409, slug: 'confirmation-required' } });
    expect(f.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { acknowledgement: settings }, headers: { 'if-match': 'W/"7"' } });
    expect(await adapter.saveSettings('isms', 'POL-01', settings, true)).toMatchObject({ ok: true, data: { changed: ['isms', 'qms'] } });
    expect(f.calls.at(-1)!.body).toEqual({ acknowledgement: settings, confirm: true });
    expect(adapter.settingsOf('isms', 'POL-01', { id: 'POL-01' })).toEqual(settings);
    expect(adapter.settingsOf('qms', 'POL-01', { id: 'POL-01' })).toEqual(settings);
    // The snapshot's own member wins once it carries one.
    expect(adapter.settingsOf('isms', 'POL-01', { id: 'POL-01', acknowledgement: DEFAULT_SETTINGS })).toEqual(DEFAULT_SETTINGS);
    expect(await adapter.saveSettings('isms', 'POL-99', settings, false)).toMatchObject({ ok: false, error: { status: 404 } });
  });

  it('keeps the settings saved in this page session per organisation, so another organisation with the same code shows none', async () => {
    const f = fakeFetch({ [`PATCH /api/v1/ms/isms/documents/${DOC_ID}`]: json({ ok: true, changed: ['isms'] }) });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    // Switching organisation keeps the page and the adapter; only the host context's organisation changes.
    let org: string | null = 'org-a';
    const adapter = createApiAdapter(client, () => API_D, () => org);
    const settings = { required: true, scope: 'organisation' as const, roles: null, dueDays: 30 };
    expect(await adapter.saveSettings('isms', 'POL-01', settings, false)).toMatchObject({ ok: true });
    expect(adapter.settingsOf('isms', 'POL-01', { id: 'POL-01' })).toEqual(settings);
    org = 'org-b';
    expect(adapter.settingsOf('isms', 'POL-01', { id: 'POL-01' })).toEqual(DEFAULT_SETTINGS);
    org = null;
    expect(adapter.settingsOf('isms', 'POL-01', { id: 'POL-01' })).toEqual(DEFAULT_SETTINGS);
    org = 'org-a';
    expect(adapter.settingsOf('isms', 'POL-01', { id: 'POL-01' })).toEqual(settings);
    // Without the host's organisation, the snapshot's `me.org` names it.
    const viaMe = createApiAdapter(client, () => ({ ...API_D, me: { org: { id: 'org-b', slug: 'b', name: 'B' } } }) as unknown as ControllerData);
    expect(viaMe.settingsOf('isms', 'POL-01', { id: 'POL-01' })).toEqual(DEFAULT_SETTINGS);
    const viaMeA = createApiAdapter(client, () => ({ ...API_D, me: { org: { id: 'org-a', slug: 'a', name: 'A' } } }) as unknown as ControllerData);
    expect(viaMeA.settingsOf('isms', 'POL-01', { id: 'POL-01' })).toEqual(settings);
  });
});

describe('acknowledgement sample adapter', () => {
  const scope = { getD: () => D, org: () => 'ndt' };

  it('starts with an open and a closed request of the ISMS policies, which every persona has confirmed', async () => {
    const adapter = createSampleAdapter(scope);
    const list = await adapter.list('isms');
    if (!list.ok) throw new Error('list failed');
    expect(list.data.map((r) => [r.document.code, r.status])).toEqual([['POL-01', 'open'], ['POL-14', 'closed']]);
    const open = list.data[0]!;
    expect(open.totals.audience).toBe(sampleAudience(D, ['isms'], 'system_roles', null, 'isms').length);
    expect(open.totals.pending).toBeGreaterThan(0);
    expect(open.totals.excused).toBe(1);
    const detail = await adapter.get('isms', open.id);
    if (!detail.ok) throw new Error('get failed');
    for (const persona of ['rina', 'bagus', 'maya', 'hendra']) expect(detail.data.people!.find((p) => p.handle === persona)?.status, persona).toBe('confirmed');
    expect(detail.data.people![0]!.status).toBe('pending');
    // One pending person joined three days after the start, with their own due date (M3-14).
    const newcomer = detail.data.people!.find((p) => p.addedOn !== open.createdAt.slice(0, 10))!;
    expect(newcomer.status).toBe('pending');
    expect(newcomer.dueOn > open.dueOn).toBe(true);
    expect(detail.data.people!.filter((p) => p !== newcomer).every((p) => p.dueOn === open.dueOn)).toBe(true);
    expect((await adapter.list('qms')).ok && (await adapter.list('qms') as { data: RequestRow[] }).data).toEqual([]);
    expect(adapter.settingsOf('isms', 'POL-01', null)).toEqual({ required: true, scope: 'system_roles', roles: null, dueDays: 14 });
    // The tab's store is the whole truth of the sample build: another document of the system has the defaults.
    const other = D.bundles!.isms!.docs.find((d) => d.id !== 'POL-01' && d.id !== 'POL-14')!;
    expect(adapter.settingsOf('isms', other.id, null)).toEqual(DEFAULT_SETTINGS);
    expect(adapter.settingsOf('isms', 'NO-SUCH-DOC', null)).toBeNull();
  });

  it('asks for confirmation (closing the earlier request), reminds once a day, closes once and writes the register', async () => {
    const adapter = createSampleAdapter(scope);
    expect(await adapter.ask('isms', { documentId: 'PRC-16', scope: 'system_roles', roles: [], dueDays: 14 })).toMatchObject({ ok: false, error: { status: 422, messageKey: 'acknowledgements.not_approved' } });
    expect(await adapter.ask('isms', { documentId: 'POL-01', scope: 'system_roles', roles: [], dueDays: 14 })).toMatchObject({ ok: false, error: { status: 409, messageKey: 'acknowledgements.open_request' } });
    // A document without a request yet (POL-14's managers confirmed its version already, so they are not asked again).
    const fresh = approvedDocuments(D, 'isms').find((d) => d.code !== 'POL-01' && d.code !== 'POL-14')!;
    const asked = await adapter.ask('isms', { documentId: fresh.code, scope: 'roles', roles: ['ms_manager'], dueDays: 7 });
    expect(asked).toMatchObject({ ok: true, data: { changed: ['isms'], data: { dueOn: '2026-10-06' } } });
    const state = sampleState(D, 'ndt');
    const created = state.requests.at(-1)!;
    expect(created.people.map((p) => p.handle)).toContain('rina');
    expect(created.people.every((p) => p.status === 'pending')).toBe(true);
    expect(await adapter.remind('isms', created.id)).toMatchObject({ ok: true, data: { count: created.people.length } });
    expect(await adapter.remind('isms', created.id)).toMatchObject({ ok: false, error: { messageKey: 'acknowledgements.reminded_today' } });
    const evidence = evidenceItems(D, 'isms')[0]!.code;
    expect(await adapter.close('isms', created.id, evidence)).toMatchObject({ ok: true, data: { message: [`Request closed. The register is filed as a new file of ${evidence}.`, expect.any(String)] } });
    expect(await adapter.close('isms', created.id, null)).toMatchObject({ ok: false, error: { messageKey: 'acknowledgements.request_closed' } });
    expect(await adapter.get('isms', 'nope')).toMatchObject({ ok: false, error: { status: 404 } });
    const csv = registerCsv(D, created, '2026-10-30');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(REGISTER_COLUMNS.join(','));
    expect(REGISTER_COLUMNS).toEqual([
      'Document', 'Title', 'Version', 'Version approved on', 'Version SHA-256', 'User name', 'Name', 'Roles', 'Request opened on', 'Added on',
      'Due date', 'Status', 'Opened at (link issued by MSCD)', 'Confirmed at', 'Statement confirmed', 'Reminders', 'Overdue', 'Excused reason',
    ]);
    expect(lines.find((l) => l.includes(',rina,'))).toMatch(new RegExp(`^${fresh.code},.+,rina,Rina Kusuma,"?ISMS: [^"]*Management System Manager[^"]*"?,2026-09-29,2026-09-29,2026-10-06,pending,,,,1,yes,$`));
    // A confirmed person's row carries the statement they confirmed.
    const earlier = state.requests.find((r) => r.document.code === 'POL-01')!;
    const confirmedLine = registerCsv(D, earlier, '2026-09-29').split('\r\n').find((l) => l.includes(',bagus,'))!;
    expect(confirmedLine).toContain(',confirmed,');
    expect(confirmedLine).toContain(',I have read and understood this document,');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
  });

  it('does not ask again the people who confirmed the same version, and refuses when everyone did (M3-14)', async () => {
    const adapter = createSampleAdapter(scope);
    const state = sampleState(D, 'ndt');
    const closed = state.requests.find((r) => r.document.code === 'POL-14')!;
    const doc = D.bundles!.isms!.docs.find((d) => d.id === 'POL-14')!;
    // The seeded closed request asked for the current version: its confirmed people are not asked again.
    expect(closed.version.label).toBe(doc.ver);
    const confirmed = closed.people.filter((p) => p.status === 'confirmed').map((p) => p.handle);
    expect(confirmed.length).toBeGreaterThan(0);
    const asked = await adapter.ask('isms', { documentId: 'POL-14', scope: 'system_roles', roles: [], dueDays: 14 });
    expect(asked.ok).toBe(true);
    const created = state.requests.at(-1)!;
    expect(created.people.map((p) => p.handle).filter((h) => confirmed.includes(h))).toEqual([]);
    expect(created.people.length).toBe(closed.people.length - confirmed.length);
    // Everyone of the new request confirms; it closes; a third request has nobody left to ask.
    for (const p of created.people) Object.assign(p, { status: 'confirmed', confirmedAt: '2026-09-29T04:00:00Z' });
    expect(await adapter.close('isms', created.id, null)).toMatchObject({ ok: true });
    expect(await adapter.ask('isms', { documentId: 'POL-14', scope: 'system_roles', roles: [], dueDays: 14 })).toMatchObject({ ok: false, error: { status: 422, messageKey: 'acknowledgements.everyone_confirmed' } });
    expect(personDue(created, created.people[0]!)).toBe(created.dueOn);
    // The register of the new request also lists the people who confirmed the version in the closed one, with the day
    // that request opened, so its file holds every confirmation of the version; the closed one keeps its own people.
    const lines = registerCsv(D, created, '2026-09-29', state.requests).trim().split('\r\n').slice(1);
    expect(lines).toHaveLength(created.people.length + confirmed.length);
    for (const handle of confirmed) {
      expect(lines.filter((l) => l.includes(`,${handle},`))).toHaveLength(1);
      expect(lines.find((l) => l.includes(`,${handle},`))).toContain(`,${closed.createdAt.slice(0, 10)},`);
    }
    expect(registerCsv(D, closed, '2026-09-29', state.requests).trim().split('\r\n')).toHaveLength(1 + closed.people.length);
    expect(registerCsv(D, created, '2026-09-29').trim().split('\r\n')).toHaveLength(1 + created.people.length);
  });

  it('keeps the settings of a document in the tab, in every system of a shared document', async () => {
    const adapter = createSampleAdapter(scope);
    const settings = { required: true, scope: 'organisation' as const, roles: null, dueDays: 30 };
    expect(await adapter.saveSettings('isms', 'IMS-01', settings, false)).toMatchObject({ ok: true });
    for (const ms of ['isms', 'qms', 'bcms', 'abms']) expect(adapter.settingsOf(ms, 'IMS-01', null), ms).toEqual(settings);
    expect(await adapter.saveSettings('isms', 'NOPE-1', settings, false)).toMatchObject({ ok: false, error: { status: 404 } });
    expect(adapter.documentId('isms', 'POL-01')).toBe('POL-01');
    expect(adapter.documentId('isms', 'NOPE-1')).toBeNull();
    expect(adapter.evidenceId('isms', evidenceItems(D, 'isms')[0]!.code)).toBe(evidenceItems(D, 'isms')[0]!.code);
  });

  it('the build chooses the sample adapter; a deferred adapter retries a failed module load', async () => {
    expect(adapterFor(ctxOf('en')).sample).toBe(true);
    expect(await adapterFor(ctxOf('en')).list('isms')).toMatchObject({ ok: true });
    const load = vi.fn<() => Promise<AcknowledgementsAdapter>>().mockRejectedValueOnce(new Error('chunk')).mockResolvedValue(createSampleAdapter(scope));
    const adapter = deferredAdapter(load);
    expect(await adapter.list('isms')).toMatchObject({ ok: false, error: { status: 0 } });
    expect(await adapter.list('isms')).toMatchObject({ ok: true });
    expect(adapter.documentId('isms', 'POL-01')).toBe('POL-01');
  });
});

describe('acknowledgement extension points', () => {
  it('adds "Read confirmations" to the Document register in API builds only, for whoever sees the register', () => {
    const action = extraPageActions[0]!;
    expect(action).toMatchObject({ screen: 'docs', id: 'docs.readConfirmations', label: TEXT.pageAction });
    expect(mayOpenRegister(ctxOf('en'))).toBe(false);
    const api = ctxOf('en', { mode: 'api', can: (_ms, perm) => (Array.isArray(perm) ? perm : [perm]).includes('audit.pending.aggregate') });
    expect(mayOpenRegister(api)).toBe(true);
    expect(mayOpenRegister(ctxOf('en', { mode: 'api', can: () => false }))).toBe(false);
    const go = vi.fn();
    action.run(ctxOf('en', { go }));
    expect(go).toHaveBeenCalledWith('acknowledgements');
  });

  it('shows the section of a document to managers of documents and to whoever sees the register', () => {
    const ext = detailExtensions![0]!;
    expect(ext).toMatchObject({ id: 'acknowledgements.doc', kind: 'doc' });
    const props = { kind: 'doc' as const, ms: 'isms', recordKey: 'isms:doc:POL-01', record: { id: 'POL-01' }, close: () => undefined };
    expect(sectionVisible(ctxOf('en'), props)).toBe(true);
    expect(sectionVisible(ctxOf('en', { can: () => false }), props)).toBe(false);
    expect(sectionVisible(ctxOf('en'), { ...props, record: null })).toBe(false);
  });

  it('opens the Ask dialog from the page action of the screen for a manager only', () => {
    const go = vi.fn();
    const actions = screen.pageActions!(ctxOf('en', { go }));
    expect(actions.map((a) => a.label)).toEqual([TEXT.ask]);
    actions[0]!.run(ctxOf('en', { go }));
    expect(go).toHaveBeenCalledWith('acknowledgements', { params: { ask: expect.any(Number) } });
    expect(screen.pageActions!(ctxOf('en', { can: () => false }))).toEqual([]);
  });
});

describe('acknowledgement views', () => {
  const adapter = createSampleAdapter({ getD: () => D, org: () => 'ndt' });
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the requests, the totals, the people and the drawer in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf(lang);
        const t = (p: readonly [string, string]) => html(p[lang === 'id' ? 1 : 0]);
        const table = render(<RequestsTable ctx={ctx} rows={[ROW, { ...ROW, id: 'c', status: 'closed' }]} onOpen={() => undefined} />, ctx, theme);
        for (const p of [TEXT.colDocument, TEXT.colVersion, TEXT.colDue, TEXT.colConfirmed, TEXT.colPending, TEXT.colOverdue, TEXT.colExcused, TEXT.colState, TEXT.stateOpen, TEXT.stateClosed]) expect(table, p[0]).toContain(t(p));
        expect(table).toContain(html(ctx.fill(TEXT.confirmedOf, { confirmed: 6, audience: 10 })));
        expect(table).toContain(`data-request="${ROW.id}"`);
        const tiles = render(<TotalsTiles ctx={ctx} totals={ROW.totals} />, ctx, theme);
        expect(tiles).toContain('data-stat="overdue"');
        expect(tiles).toContain('data-tone="bad"');
        const people = render(<PeopleTable ctx={ctx} people={fromDetail({ ...ITEM, people: [
          PERSON,
          { ...PERSON, person: { handle: 'dewi', displayName: 'Dewi Anggraini' }, status: 'pending', overdue: true, confirmedAt: null, addedOn: '2026-10-02', dueOn: '2026-10-16' },
          { ...PERSON, person: { handle: 'joko', displayName: 'Joko Widodo' }, status: 'excused', confirmedAt: null, excusedReason: 'Membership of the organisation ended' },
        ] } as never).people!} />, ctx, theme);
        for (const p of [TEXT.colPerson, TEXT.colAdded, TEXT.colDue, TEXT.colOpened, TEXT.colConfirmedAt, TEXT.colReminders, TEXT.personConfirmed, TEXT.personOverdue, TEXT.personExcused]) expect(people, p[0]).toContain(t(p));
        expect(people).toContain('data-added="2026-10-02"');
        expect(people).toContain('data-due="2026-10-16"');
        // The excusal reason in the interface language (texts B4).
        expect(people).toContain(t(EXCUSED_REASONS['Membership of the organisation ended']!));
        const drawer = render(<RequestDrawer ctx={ctx} adapter={adapter} ms="isms" row={ROW} onClose={() => undefined} onChanged={() => undefined} />, ctx, theme);
        for (const p of [TEXT.drawerCrumb, TEXT.factDocument, TEXT.factAudience, TEXT.factDue, TEXT.remind, TEXT.exportCsv, TEXT.closeFile, TEXT.newcomersNote]) expect(drawer, p[0]).toContain(t(p));
        expect(drawer).not.toContain(t(TEXT.askNewcomers));
        // A closed request of the current version that someone did not confirm offers "Ask the people who have not confirmed".
        const doc = approvedDocuments(D, 'isms').find((d) => d.code === 'POL-01')!;
        const closedRow = { ...ROW, status: 'closed' as const, closedAt: '2026-10-20T00:00:00Z', version: { ...ROW.version, label: doc.version } };
        const again = render(<RequestDrawer ctx={ctx} adapter={adapter} ms="isms" row={closedRow} rows={[closedRow]} onClose={() => undefined} onChanged={() => undefined} onAskAgain={() => undefined} />, ctx, theme);
        expect(again).toContain(t(TEXT.askNewcomers));
        expect(again).toContain(t(TEXT.closedNote));
        const top = render(<RequestDrawer ctx={ctxOf(lang, { can: (_ms, perm) => (Array.isArray(perm) ? perm : [perm]).includes('audit.pending.aggregate') })} adapter={adapter} ms="isms" row={ROW} onClose={() => undefined} onChanged={() => undefined} />, ctx, theme);
        expect(top).toContain(t(TEXT.totalsOnly));
        expect(top).not.toContain(t(TEXT.remind));
        expect(top).not.toContain(t(TEXT.exportCsv));
        expect(table + tiles + people + drawer + top).not.toMatch(/[—·]/);
      });

      it(`the dialogs and the section of a document in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf(lang);
        const t = (p: readonly [string, string]) => html(p[lang === 'id' ? 1 : 0]);
        const ask = render(<AskDialog ctx={ctx} adapter={adapter} ms="isms" onCancel={() => undefined} onDone={() => undefined} />, ctx, theme);
        for (const p of [TEXT.askTitle, TEXT.askDocument, TEXT.audience, TEXT.scopeSystemRoles, TEXT.scopeRoles, TEXT.scopeOrganisation, TEXT.dueDays, TEXT.send, TEXT.askSkipConfirmed, TEXT.newcomersNote]) expect(ask, p[0]).toContain(t(p));
        expect(ask).toContain('POL-01');
        // "Ask the people who have not confirmed" fills in the document and the audience of the closed request.
        const again = render(<AskDialog ctx={ctx} adapter={adapter} ms="isms" start={{ code: 'POL-01', scope: 'roles', roles: ['domain_owner'] }} onCancel={() => undefined} onDone={() => undefined} />, ctx, theme);
        expect(again).toMatch(/<option value="POL-01" selected="">/);
        expect(again).toMatch(/name="role-domain_owner" checked=""/);
        const close = render(<CloseDialog ctx={ctx} adapter={adapter} ms="isms" row={ROW} onCancel={() => undefined} onDone={() => undefined} />, ctx, theme);
        for (const p of [TEXT.closeSub, TEXT.closeEvidence, TEXT.closeEvidenceHint, TEXT.closeAndFile, TEXT.closeOnly]) expect(close, p[0]).toContain(t(p));
        // The item of an earlier register of the same policy is proposed; an item holding another policy's register is warned about.
        const ev = evidenceItems(D, 'isms');
        const proposed = render(<CloseDialog ctx={ctx} adapter={adapter} ms="isms" row={ROW} rows={[ROW, { ...ROW, id: 'old', status: 'closed', evidenceId: ev[1]!.code }]} onCancel={() => undefined} onDone={() => undefined} />, ctx, theme);
        expect(proposed).toMatch(new RegExp(`aria-selected="true"[^>]*>(<span>)?<span class="mx-mono"[^>]*>${ev[1]!.code}<`));
        const warned = render(<CloseDialog ctx={ctx} adapter={adapter} ms="isms" row={ROW} rows={[ROW, { ...ROW, id: 'old', status: 'closed', evidenceId: ev[1]!.code, document: { ...ROW.document, code: 'POL-14' } }, { ...ROW, id: 'mine', status: 'closed', evidenceId: ev[1]!.code, createdAt: '2026-01-01T00:00:00Z', closedAt: '2026-01-02T00:00:00Z' }]} onCancel={() => undefined} onDone={() => undefined} />, ctx, theme);
        expect(warned).toContain('data-other-register="POL-14"');
        expect(warned).toContain(html(ctx.fill(TEXT.otherRegister, { code: 'POL-14' })));
        // After an earlier request of the same version the dialog says that the register lists its confirmations too.
        expect(close).not.toContain('data-earlier-note');
        const reAsk = render(<CloseDialog ctx={ctx} adapter={adapter} ms="isms" row={ROW} rows={[ROW, { ...ROW, id: 'first', status: 'closed', createdAt: '2026-09-01T02:00:00Z', evidenceId: ev[1]!.code }]} onCancel={() => undefined} onDone={() => undefined} />, ctx, theme);
        expect(reAsk).toContain('data-earlier-note=""');
        expect(reAsk).toContain(html(ctx.fill(TEXT.earlierNote, { version: '4.0', n: 6 })));
        const settings = render(<SettingsDialog ctx={ctx} adapter={adapter} ms="isms" code="POL-01" initial={{ required: true, scope: 'roles', roles: ['domain_owner'], dueDays: 21 }} onCancel={() => undefined} onSaved={() => undefined} />, ctx, theme);
        for (const p of [TEXT.required, TEXT.roles, TEXT.save]) expect(settings, p[0]).toContain(t(p));
        expect(settings).toMatch(/name="role-domain_owner" checked=""/);
        expect(settings).toContain('value="21"');
        const section = render(<DocSection ctx={ctx} kind="doc" ms="isms" recordKey="isms:doc:POL-01" record={{ id: 'POL-01' }} close={() => undefined} />, ctx, theme);
        for (const p of [TEXT.sectionTitle, TEXT.settings, TEXT.openRegister]) expect(section, p[0]).toContain(t(p));
        expect(latestLine(ctx, ROW)).toBe(`${ctx.fill(TEXT.sectionLatest, { version: '4.0', confirmed: 6, audience: 10 })}, ${ctx.fill(TEXT.sectionOverdue, { n: 1 })}`);
        expect(ask + close + settings + section).not.toMatch(/[—·]/);
      });
    }
  }

  it('shows no current value when the stored settings of a document are unknown (API build without the document record)', () => {
    vi.stubEnv('VITE_DATA_SOURCE', 'api');
    try {
      for (const lang of ['en', 'id'] as Lang[]) {
        const ctx = ctxOf(lang, { mode: 'api', D: API_D } as Partial<HostContext>);
        const t = (p: readonly [string, string]) => html(p[lang === 'id' ? 1 : 0]);
        const api = createApiAdapter(null, () => API_D);
        expect(api.settingsOf('isms', 'POL-01', { id: 'POL-01' })).toEqual(DEFAULT_SETTINGS);
        // A document record without the `acknowledgement` member has the default settings (M3-04).
        const section = render(<DocSection ctx={ctx} kind="doc" ms="isms" recordKey="isms:doc:POL-01" record={{ id: 'POL-01' }} close={() => undefined} />, ctx);
        expect(section).toContain(t(TEXT.sectionOff));
        expect(section).not.toContain(t(TEXT.sectionUnknown));
        // The dialog: a notice, "ask for confirmation" as a yes or no choice with neither chosen, and no checkbox that
        // would show the default "off" as the current value.
        const dialog = render(<SettingsDialog ctx={ctx} adapter={api} ms="isms" code="POL-01" initial={null} onCancel={() => undefined} onSaved={() => undefined} />, ctx);
        for (const p of [TEXT.settingsUnknown, TEXT.requiredLegend, TEXT.required, TEXT.notRequired, TEXT.scopeSystemRoles, TEXT.save]) expect(dialog, p[0]).toContain(t(p));
        expect(dialog).toContain('data-settings-known="false"');
        expect(dialog).not.toContain('type="checkbox" name="required"');
        expect(dialog).toMatch(/type="radio" name="required" value="yes"\/>/);
        expect(dialog).toMatch(/type="radio" name="required" value="no"\/>/);
        expect(dialog).not.toMatch(/name="required" value="(yes|no)" checked=""/);
        expect(dialog + section).not.toMatch(/[—·]/);
        // Known settings keep the checkbox with the stored value.
        const known = render(<SettingsDialog ctx={ctx} adapter={api} ms="isms" code="POL-01" initial={{ required: true, scope: 'system_roles', roles: null, dueDays: 14 }} onCancel={() => undefined} onSaved={() => undefined} />, ctx);
        expect(known).toContain('data-settings-known="true"');
        expect(known).toContain('type="checkbox" name="required" checked=""');
        expect(known).not.toContain(t(TEXT.settingsUnknown));
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('asks for a system, says who is asked, and shows the totals-only note without audit.pending.all', () => {
    expect(render(<AcknowledgementsScreen ctx={ctxOf('en', { msObj: null })} />, ctxOf('en'))).toContain(TEXT.noSystem[0]);
    const top = ctxOf('id', { can: (_ms, perm) => (Array.isArray(perm) ? perm : [perm]).includes('audit.pending.aggregate') });
    const body = render(<AcknowledgementsScreen ctx={top} />, top);
    expect(body).toContain(TEXT.totalsOnly[1]);
    expect(body).toContain(html(TEXT.audienceNote[1]));
    expect(body).not.toContain(TEXT.ask[1]);
    expect(render(<AcknowledgementsScreen ctx={ctxOf('en')} />, ctxOf('en'))).toContain(html(TEXT.audienceNote[0]));
  });

  it('uses the Indonesian words of the text review (M3-14: texts A3, A6, B1, B2, B3, B5)', () => {
    expect(TEXT.colDue[1]).toBe('Jatuh tempo');
    expect(TEXT.colState[1]).toBe('Status');
    for (const p of [TEXT.colPending, TEXT.statPending, TEXT.personPending]) expect(p[1]).toBe('Belum konfirmasi');
    for (const p of [TEXT.colExcused, TEXT.statExcused, TEXT.personExcused]) expect(p).toEqual(['No longer asked', 'Tidak lagi diminta']);
    expect(TEXT.closeOnly[1]).toBe('Tutup tanpa menyimpan sebagai bukti');
    expect(TEXT.closeAndFile[1]).toBe('Tutup dan simpan sebagai bukti');
    expect(TEXT.totalsOnly[1]).toContain('Management System Manager dan Pemilik Program');
    expect(JSON.stringify(TEXT)).not.toMatch(/[Tt]ertunda|Tenggat|Keadaan|Dikecualikan/);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries(TEXT)) {
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(/[—·]/);
    }
  });

  it('is in the Implementation group of the system with the three permissions of C.2', () => {
    expect(screen).toMatchObject({ id: 'acknowledgements', path: '/ms/:ms/acknowledgements', group: 'impl', scope: 'ms', roles: ['manager', 'top', 'sponsor'] });
    expect(screen.perm).toEqual([...SCREEN_PERMS]);
  });
});
