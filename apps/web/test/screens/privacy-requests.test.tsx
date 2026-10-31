// Personal data requests (MILESTONE-3 M3-04, D.6): routes against the shared table, the definition and its page action,
// the model (time left, the actions a request offers, the record form), the API adapter over a fake fetch (list
// filters, create with an Idempotency-Key, If-Match on the moves, the commands of each type and a queued export), the
// sample adapter with the server's rules, and the views in both languages and themes.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/privacy-requests/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/privacy-requests/routes';
import { createApiAdapter, fromDetail, messageOf } from '../../src/screens/privacy-requests/api';
import { createSampleAdapter } from '../../src/screens/privacy-requests/sample';
import { adapterFor, deferredAdapter } from '../../src/screens/privacy-requests/adapter';
import { requestsOf, resetSamplePrivacy } from '../../src/screens/privacy-requests/sample-store';
import {
  ACTION_TEXT, RESULT_TEXT, actionsFor, filterRows, instantOf, isOpen, recordBody, recordErrors, statusTone, timeLeft,
} from '../../src/screens/privacy-requests/model';
import type { PrivacyRequestsAdapter, RequestDetail } from '../../src/screens/privacy-requests/model';
import { notePrivacyChanged, privacyVersion, subscribePrivacy } from '../../src/screens/privacy-requests/store';
import PrivacyRequestsScreen, { RecordDialog, RequestList } from '../../src/screens/privacy-requests/Screen';
import { ChecksTable, RectifyDialog, RequestView, TextDialog } from '../../src/screens/privacy-requests/detail';
import { TEXT } from '../../src/screens/privacy-requests/text';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, sampleD, t, textProblems } from './ctx-m2-16';
import meta from '../../src/screens/privacy-requests/meta.json';

const ID = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const CHECK = { id: '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f', ms: 'isms', status: 'open', doneBy: null, doneAt: null, note: null } as const;
const ITEM = {
  id: ID, requestNo: 'PR-2026-004', type: 'access', status: 'received',
  subject: { kind: 'member', userId: '9d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a', handle: 'bagus', name: 'Bagus Prasetyo', email: 'bagus.prasetyo@nusantaradigital.co.id' },
  channel: 'email', receivedAt: '2026-10-30T09:00:00Z', dueAt: '2026-11-02T09:00:00Z', closedAt: null, handledBy: null, overdue: false, etag: 'W/"3"',
} as const;
const DETAIL = {
  ...ITEM, note: 'Asked by email', identityCheckNote: null, identityCheckedBy: null, outcome: null, result: null,
  checks: [CHECK], actions: [{ action: 'privacy_request.created', at: '2026-10-30T09:05:00Z', actor: { handle: 'rina', displayName: 'Rina Kusuma' } }], exportTaskId: null,
} as const;
const D0: RequestDetail = fromDetail(DETAIL as never);

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes);
  const c = new ApiClient({ fetch: f.fetch });
  c.setCsrfToken('csrf-token-0123456789abcdef');
  return { ...f, client: c };
}

beforeAll(async () => {
  await loadSampleD();
});
afterEach(() => resetSamplePrivacy());

describe('personal data request routes and definition', () => {
  it('match the shared route table; the request routes need privacy_request.manage', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    for (const name of ['list', 'create', 'get', 'update', 'rectify', 'restrict', 'erase', 'close', 'exportPerson'] as const) {
      expect(routeById(ROUTE_IDS[name]).permission, name).toBe('privacy_request.manage');
    }
    expect(routeById(ROUTE_IDS.create).idempotent).toBe(true);
  });

  it('is in Administration for the Tenant Admins, with the page action "Record request"', () => {
    expect(screen).toMatchObject({ id: 'privacy-requests', path: '/admin/privacy-requests', group: 'admin', order: 44, scope: 'org', perm: 'privacy_request.manage', roles: ['manager'] });
    expect(meta).toMatchObject({ id: screen.id, group: screen.group, order: screen.order, scope: screen.scope, perm: screen.perm, pageActions: [[...TEXT.record]] });
    const ctx = ctxOf();
    const [action] = screen.pageActions!(ctx);
    expect(action).toMatchObject({ label: [...TEXT.record], primary: true });
    action!.run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('privacy-requests', { params: { record: expect.any(Number) } });
    expect(screen.pageActions!(ctxOf({ mode: 'api', org: [] }))).toEqual([]);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    const same = ['filterStatus', 'colStatus', 'channelEmail', 'factEmail', 'factStatus'];
    expect(textProblems(TEXT, same)).toEqual([]);
    expect(textProblems(RESULT_TEXT as Record<string, readonly [string, string]>)).toEqual([]);
    expect(textProblems(ACTION_TEXT as Record<string, readonly [string, string]>)).toEqual([]);
  });

  it('the change counter tells its listeners', () => {
    const heard = vi.fn();
    const stop = subscribePrivacy(heard);
    const v = privacyVersion();
    notePrivacyChanged();
    expect(privacyVersion()).toBe(v + 1);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    notePrivacyChanged();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('personal data request model', () => {
  const now = new Date('2026-10-31T09:00:00Z').getTime();
  const day = (iso: string) => iso.slice(0, 10);

  it('gives the time left in hours, days and hours, overdue, or the answer date', () => {
    const ctx = ctxOf();
    expect(timeLeft(ctx, { status: 'received', dueAt: '2026-11-02T10:00:00Z', closedAt: null }, now, day)).toEqual({ text: '2 d 1 h left', tone: 'ok' });
    expect(timeLeft(ctx, { status: 'in_progress', dueAt: '2026-10-31T14:30:00Z', closedAt: null }, now, day)).toEqual({ text: '5 h left', tone: 'warn' });
    expect(timeLeft(ctx, { status: 'received', dueAt: '2026-10-31T06:00:00Z', closedAt: null }, now, day)).toEqual({ text: 'Overdue by 3 h', tone: 'bad' });
    expect(timeLeft(ctx, { status: 'received', dueAt: '2026-10-28T06:00:00Z', closedAt: null }, now, day)).toEqual({ text: 'Overdue by 3 d', tone: 'bad' });
    expect(timeLeft(ctx, { status: 'completed', dueAt: '2026-10-28T06:00:00Z', closedAt: '2026-10-27T06:00:00Z' }, now, day)).toEqual({ text: 'Answered 2026-10-27', tone: 'mute' });
    expect(timeLeft(ctxOf({ lang: 'id' }), { status: 'received', dueAt: '2026-11-02T10:00:00Z', closedAt: null }, now, day).text).toBe('Sisa 2 h 1 j');
    expect([isOpen('received'), isOpen('in_progress'), isOpen('completed'), isOpen('refused')]).toEqual([true, true, false, false]);
    expect([statusTone('completed'), statusTone('in_progress'), statusTone('received'), statusTone('withdrawn')]).toEqual(['ok', 'acc', 'warn', 'mute']);
  });

  it('offers the actions of the type, each with the reason it waits', () => {
    const received = actionsFor(D0);
    expect(received).toMatchObject({ start: true, refuse: true, withdraw: true, exportData: { shown: true, waits: TEXT.startFirst }, close: { shown: true, waits: TEXT.startFirst } });
    const started = { ...D0, status: 'in_progress' as const };
    expect(actionsFor(started).exportData).toEqual({ shown: true, waits: null });
    expect(actionsFor(started).close.waits).toEqual(TEXT.waitChecks);
    const checked = { ...started, checks: [{ ...D0.checks[0]!, status: 'done' as const }] };
    expect(actionsFor(checked).close.waits).toEqual(TEXT.needExport);
    expect(actionsFor({ ...checked, result: { exportsQueued: 1 } }).close.waits).toBeNull();
    const erasure = { ...started, type: 'erasure' as const };
    expect(actionsFor(erasure).erase).toEqual({ shown: true, waits: TEXT.waitChecks });
    expect(actionsFor({ ...erasure, checks: [] }).erase.waits).toBeNull();
    expect(actionsFor({ ...erasure, checks: [], result: { erased: 1 } })).toMatchObject({ erase: { shown: false }, close: { waits: null } });
    const restriction = { ...started, type: 'restriction' as const, checks: [] };
    expect(actionsFor(restriction).close.waits).toEqual(TEXT.needRestrict);
    expect(actionsFor({ ...restriction, result: { restricted: 1 } })).toMatchObject({ restrict: { shown: false }, close: { waits: null } });
    expect(actionsFor({ ...started, type: 'rectification', checks: [] })).toMatchObject({ rectify: { shown: true, waits: null }, close: { waits: null } });
    // Nobody to copy or restrict: the action is not shown and closing does not wait for it.
    const other = { ...started, subject: { kind: 'other' as const, userId: null, handle: null, name: 'Bima Haryanto', email: null }, checks: [] };
    expect(actionsFor(other)).toMatchObject({ exportData: { shown: false }, close: { waits: null } });
    expect(actionsFor({ ...D0, status: 'completed' })).toMatchObject({ start: false, refuse: false, close: { shown: false }, exportData: { shown: false } });
  });

  it('checks the record form and builds its body', () => {
    const form = { type: 'erasure' as const, kind: 'other' as const, userId: '', name: '', email: 'not-an-email', date: '', time: '09:30', channel: 'letter' as const, note: '' };
    expect(Object.keys(recordErrors(form)).sort()).toEqual(['date', 'email', 'name']);
    expect(recordErrors({ ...form, kind: 'member' })).toMatchObject({ userId: TEXT.chooseMember });
    const ok = { ...form, name: ' Bima Haryanto ', email: '', date: '2026-10-30', note: ' Letter of 30 October ' };
    expect(recordErrors(ok)).toEqual({});
    expect(recordBody(ok)).toEqual({ type: 'erasure', subject: { name: 'Bima Haryanto' }, receivedAt: instantOf('2026-10-30', '09:30'), channel: 'letter', note: 'Letter of 30 October' });
    expect(recordBody({ ...ok, kind: 'member', userId: 'u1', note: '' })).toEqual({ type: 'erasure', subject: { userId: 'u1' }, receivedAt: instantOf('2026-10-30', '09:30'), channel: 'letter' });
    const at = new Date(instantOf('2026-10-30', '09:30'));
    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()]).toEqual([2026, 9, 30, 9, 30]);
  });

  it('filters rows by status, type and search text', () => {
    const rows = [D0, { ...D0, id: 'b', requestNo: 'PR-2026-005', type: 'erasure' as const, status: 'completed' as const, subject: { ...D0.subject, name: 'Dewi Lestari', handle: 'dewi' } }];
    expect(filterRows(rows, { status: 'open', type: '', q: '' }).map((r) => r.id)).toEqual([ID]);
    expect(filterRows(rows, { status: '', type: 'erasure', q: '' }).map((r) => r.id)).toEqual(['b']);
    expect(filterRows(rows, { status: '', type: '', q: 'dewi' }).map((r) => r.id)).toEqual(['b']);
    expect(filterRows(rows, { status: '', type: '', q: 'pr-2026-004' }).map((r) => r.id)).toEqual([ID]);
  });
});

describe('personal data request API adapter', () => {
  const ok = (message: [string, string], extra: Record<string, unknown> = {}) => json({ ok: true, changed: [], message, ...extra });

  it('lists with the server filters, reads members, records with an Idempotency-Key and reads one request', async () => {
    const f = client({
      'GET /api/v1/admin/privacy-requests': json({ items: [ITEM, { ...ITEM, id: 'x', status: 'completed', closedAt: '2026-10-31T01:00:00Z' }], page: 1, pageSize: 200, total: 2 }),
      'GET /api/v1/admin/users': json({
        items: [
          { id: 'u1', handle: 'bagus', displayName: 'Bagus Prasetyo', email: 'bagus@nusantaradigital.co.id', membershipStatus: 'active', kind: 'human' },
          { id: 'u2', handle: 'inv', displayName: 'Invited Person', email: 'inv@nusantaradigital.co.id', membershipStatus: 'invited', kind: 'human' },
        ],
        page: 1, pageSize: 200, total: 2,
      }),
      'POST /api/v1/admin/privacy-requests': json({ ok: true, changed: [], data: { id: ID, requestNo: 'PR-2026-004' }, message: ['Request PR-2026-004 recorded', 'Permintaan PR-2026-004 dicatat'] }, 201),
      [`GET /api/v1/admin/privacy-requests/${ID}`]: json(DETAIL),
    });
    const adapter = createApiAdapter(f.client);
    const open = await adapter.list({ status: 'open', type: 'access', q: ' Bagus ' });
    expect(open.ok && open.data.map((r) => r.id)).toEqual([ID]);
    expect(f.calls[0]!.url).toContain('pageSize=200');
    expect(f.calls[0]!.url).toContain('type=access');
    expect(f.calls[0]!.url).toContain('q=Bagus');
    expect(f.calls[0]!.url).not.toContain('status=');
    await adapter.list({ status: 'refused', type: '', q: '' });
    expect(f.calls[1]!.url).toContain('status=refused');
    // Invited members are offered as well: the server accepts a request about any member that is not removed.
    expect(await adapter.members()).toEqual({
      ok: true, status: 200, data: [
        { id: 'u1', handle: 'bagus', name: 'Bagus Prasetyo', email: 'bagus@nusantaradigital.co.id' },
        { id: 'u2', handle: 'inv', name: 'Invited Person', email: 'inv@nusantaradigital.co.id' },
      ],
    });
    const created = await adapter.create({ type: 'access', subject: { userId: 'u1' }, receivedAt: '2026-10-30T09:00:00Z', channel: 'email' });
    expect(created).toMatchObject({ ok: true, data: { id: ID, requestNo: 'PR-2026-004' } });
    const post = f.calls.find((c) => c.method === 'POST')!;
    expect(post.headers['idempotency-key']).toMatch(/.{8,}/);
    expect(post.body).toEqual({ type: 'access', subject: { userId: 'u1' }, receivedAt: '2026-10-30T09:00:00Z', channel: 'email' });
    expect(await adapter.get(ID)).toEqual({ ok: true, status: 200, data: D0 });
  });

  it('reads every page of the member list for the subject picker, and stops at the first refusal', async () => {
    const person = (n: number) => ({ id: `u${n}`, handle: `staff${n}`, displayName: `Staff ${n}`, email: `staff${n}@nusantaradigital.co.id`, membershipStatus: 'active', kind: 'human' });
    const pages: Record<string, unknown[]> = {
      '1': Array.from({ length: 200 }, (_, i) => person(i + 1)),
      '2': [person(201), { ...person(202), kind: 'system' }],
    };
    const f = client({
      'GET /api/v1/admin/users': (req) => {
        const page = new URL(req.url, 'http://localhost').searchParams.get('page') ?? '1';
        return json({ items: pages[page] ?? [], page: Number(page), pageSize: 200, total: 202 });
      },
    });
    const members = await createApiAdapter(f.client).members();
    expect(members.ok && members.data.length).toBe(201);
    expect(members.ok && members.data.at(-1)).toEqual({ id: 'u201', handle: 'staff201', name: 'Staff 201', email: 'staff201@nusantaradigital.co.id' });
    expect(f.calls.map((c) => new URL(c.url, 'http://localhost').searchParams.get('page'))).toEqual(['1', '2']);
    expect(f.calls.every((c) => c.url.includes('pageSize=200'))).toBe(true);
    const refused = client({ 'GET /api/v1/admin/users': [json({ items: pages['1'], page: 1, pageSize: 200, total: 202 }), problem(403, 'forbidden')] });
    expect(await createApiAdapter(refused.client).members()).toMatchObject({ ok: false, error: { status: 403 } });
  });

  it('sends the moves with If-Match and the commands of each type; keeps the server refusals', async () => {
    const checks = problem(409, 'conflict', { messageKey: 'privacy.checks_open', messages: { en: 'Every system check must be done first.', id: 'Setiap pemeriksaan sistem harus selesai terlebih dahulu.' } });
    const f = client({
      [`PATCH /api/v1/admin/privacy-requests/${ID}`]: ok(['Work on PR-2026-004 started', 'Penanganan PR-2026-004 dimulai']),
      [`POST /api/v1/admin/privacy-requests/${ID}/rectify`]: ok(['Corrected', 'Dikoreksi']),
      [`POST /api/v1/admin/privacy-requests/${ID}/restrict`]: ok(['Restricted', 'Dibatasi']),
      [`POST /api/v1/admin/privacy-requests/${ID}/erase`]: [checks, ok(['Erased', 'Dihapus'])],
      [`POST /api/v1/admin/privacy-requests/${ID}/close`]: ok(['Completed', 'Selesai']),
      [`POST /api/v1/admin/privacy-requests/${ID}/export`]: json({ ok: true, changed: [], taskId: '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b', message: ['Queued', 'Diantrekan'] }, 202),
      'GET /api/v1/exports/8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b': json({ id: '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b', kind: 'export', status: 'succeeded', progress: 100, downloadUrl: '/api/v1/exports/8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b/download' }),
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.update(ID, { action: 'start', identityCheckNote: 'Video call' }, 'W/"3"')).toEqual({ ok: true, status: 200, data: { message: ['Work on PR-2026-004 started', 'Penanganan PR-2026-004 dimulai'] } });
    expect(f.calls[0]).toMatchObject({ method: 'PATCH', headers: { 'if-match': 'W/"3"' }, body: { action: 'start', identityCheckNote: 'Video call' } });
    expect(await adapter.rectify(ID, { displayName: 'Bagus Prasetyo' })).toMatchObject({ ok: true });
    expect(f.calls[1]!.body).toEqual({ displayName: 'Bagus Prasetyo' });
    expect(await adapter.restrict(ID)).toMatchObject({ ok: true });
    expect(await adapter.erase(ID)).toMatchObject({ ok: false, error: { status: 409, messageKey: 'privacy.checks_open', message: ['Every system check must be done first.', 'Setiap pemeriksaan sistem harus selesai terlebih dahulu.'] } });
    expect(await adapter.erase(ID)).toMatchObject({ ok: true });
    expect(f.calls.filter((c) => c.path.endsWith('/erase')).map((c) => c.body)).toEqual([{ confirm: true }, { confirm: true }]);
    expect(await adapter.close(ID, 'Copy sent by email')).toMatchObject({ ok: true });
    expect(f.calls.find((c) => c.path.endsWith('/close'))!.body).toEqual({ outcome: 'Copy sent by email' });
    expect(await adapter.exportPerson(ID)).toEqual({ ok: true, status: 202, data: { message: ['Queued', 'Diantrekan'], taskId: '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b' } });
    expect(f.calls.at(-1)!.headers['idempotency-key']).toBeTruthy();
    expect(await adapter.exportState('8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b')).toEqual({ ok: true, status: 200, data: { status: 'succeeded', downloadUrl: '/api/v1/exports/8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b/download' } });
    expect(messageOf({ ok: true, changed: [] })).toBeNull();
  });
});

describe('personal data request sample adapter', () => {
  const adapter = () => createSampleAdapter(() => sampleD(), () => 'ndt');

  it('starts with three requests, open ones first, and records a new one with a check per system', async () => {
    const a = adapter();
    const list = await a.list({ status: '', type: '', q: '' });
    if (!list.ok) throw new Error('list failed');
    expect(list.data.map((r) => [r.type, r.status])).toEqual([['erasure', 'received'], ['access', 'in_progress'], ['rectification', 'completed']]);
    const members = await a.members();
    expect(members.ok && members.data.some((m) => m.handle === 'bagus')).toBe(true);
    const created = await a.create({ type: 'erasure', subject: { userId: 'sample-dewi' }, receivedAt: new Date().toISOString(), channel: 'email', note: 'Leaving' });
    if (!created.ok) throw new Error('create failed');
    expect(created.data.requestNo).toMatch(/^PR-\d{4}-004$/);
    const detail = await a.get(created.data.id);
    expect(detail.ok && [detail.data.subject.handle, detail.data.checks.length, detail.data.status]).toEqual(['dewi', requestsOf(sampleD(), 'ndt')[0]!.checks.length, 'received']);
    expect(await a.get('nope')).toMatchObject({ ok: false, error: { status: 404 } });
  });

  it('follows the server rules: start first, every check before erasing, the action before closing', async () => {
    const a = adapter();
    const [access, erasure] = requestsOf(sampleD(), 'ndt');
    expect(await a.erase(erasure!.id)).toMatchObject({ ok: false, error: { messageKey: 'privacy.start_first' } });
    expect(await a.update(erasure!.id, { action: 'start', identityCheckNote: 'Letter signed' }, erasure!.etag)).toMatchObject({ ok: true });
    expect(await a.erase(erasure!.id)).toMatchObject({ ok: false, error: { messageKey: 'privacy.checks_open' } });
    for (const c of erasure!.checks) c.status = 'done';
    expect(await a.close(erasure!.id, 'Done')).toMatchObject({ ok: false, error: { messageKey: 'privacy.action_first' } });
    expect(await a.erase(erasure!.id)).toMatchObject({ ok: true });
    expect(await a.close(erasure!.id, 'Erased and answered by letter')).toMatchObject({ ok: true });
    expect(await a.close(erasure!.id, 'Again')).toMatchObject({ ok: false, error: { messageKey: 'privacy.request_closed' } });
    expect(await a.rectify(access!.id, { displayName: 'X' })).toMatchObject({ ok: false, error: { messageKey: 'privacy.wrong_type' } });
    const queued = await a.exportPerson(access!.id);
    expect(queued.ok && queued.data.taskId).toBeTruthy();
    expect(await a.exportState('x')).toEqual({ ok: true, status: 200, data: { status: 'succeeded', downloadUrl: null } });
    for (const c of access!.checks) c.status = 'done';
    expect(await a.close(access!.id, 'Copy sent')).toMatchObject({ ok: true });
    const withdrawn = await a.create({ type: 'restriction', subject: { name: 'Sari Wulandari' }, receivedAt: new Date().toISOString(), channel: 'other' });
    if (!withdrawn.ok) throw new Error('create failed');
    expect(await a.update(withdrawn.data.id, { action: 'withdraw', reason: 'Asked by phone to stop' }, null)).toMatchObject({ ok: true });
    expect((await a.get(withdrawn.data.id)).ok && requestsOf(sampleD(), 'ndt').find((r) => r.id === withdrawn.data.id)!.status).toBe('withdrawn');
  });

  it('the build chooses the sample adapter; a deferred adapter retries a failed module load', async () => {
    const ctx = ctxOf();
    expect(adapterFor(ctx).sample).toBe(true);
    expect(await adapterFor(ctx).list({ status: '', type: '', q: '' })).toMatchObject({ ok: true });
    const load = vi.fn<() => Promise<PrivacyRequestsAdapter>>().mockRejectedValueOnce(new Error('chunk')).mockResolvedValue(adapter());
    const deferred = deferredAdapter(load);
    await expect(deferred.list({ status: '', type: '', q: '' })).rejects.toThrow('chunk');
    expect(await deferred.list({ status: '', type: '', q: '' })).toMatchObject({ ok: true });
  });
});

describe('personal data request views', () => {
  const sample = createSampleAdapter(() => sampleD(), () => 'ndt');
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the register, the record form and a request in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme });
        const tr = (p: readonly [string, string]) => esc(t(p, lang));
        const list = render(<RequestList ctx={ctx} adapter={sample} onOpen={() => undefined} />, ctx, theme);
        for (const p of [TEXT.title, TEXT.filterStatus, TEXT.filterType, TEXT.search, TEXT.loading]) expect(list, p[0]).toContain(tr(p));
        const form = render(<RecordDialog ctx={ctx} adapter={sample} open onClose={() => undefined} onDone={() => undefined} />, ctx, theme);
        for (const p of [TEXT.recordTitle, TEXT.recordSub, TEXT.type, TEXT.subjectMember, TEXT.subjectOther, TEXT.member, TEXT.receivedAt, TEXT.channel, TEXT.save]) expect(form, p[0]).toContain(tr(p));
        expect(form).toContain('data-form="privacy-record"');
        const view = render(<RequestView ctx={ctx} adapter={sample} detail={D0} />, ctx, theme);
        for (const p of [TEXT.facts, TEXT.checks, TEXT.steps, TEXT.actions, TEXT.start, TEXT.exportData, TEXT.close, TEXT.refuse, TEXT.withdraw, TEXT.addNote, TEXT.startFirst, ACTION_TEXT['privacy_request.created']!]) expect(view, p[0]).toContain(tr(p));
        expect(view).toContain('data-request="PR-2026-004"');
        expect(view).toContain('Bagus Prasetyo');
        const erasing = render(<RequestView ctx={ctx} adapter={sample} detail={{ ...D0, type: 'erasure', status: 'in_progress', checks: [] }} initialDialog="erase" />, ctx, theme);
        for (const p of [TEXT.eraseBody, TEXT.eraseStays]) expect(erasing, p[0]).toContain(tr(p));
        expect(erasing).toContain('data-erase="member"');
        expect(erasing).toContain('ERASE');
        const other = render(<RequestView ctx={ctx} adapter={sample} detail={{ ...D0, type: 'erasure', status: 'in_progress', checks: [], subject: { kind: 'other', userId: null, handle: null, name: 'Bima Haryanto', email: null } }} initialDialog="erase" />, ctx, theme);
        expect(other).toContain('data-erase="other"');
        expect(other).toContain(tr(TEXT.eraseOther));
        const restrict = render(<RequestView ctx={ctx} adapter={sample} detail={{ ...D0, type: 'restriction', status: 'in_progress', checks: [] }} initialDialog="restrict" />, ctx, theme);
        expect(restrict).toContain(tr(TEXT.restrictBody));
        const done = render(<RequestView ctx={ctx} adapter={sample} detail={{ ...D0, status: 'completed', closedAt: '2026-10-31T02:00:00Z', outcome: 'Copy sent', result: { exportsQueued: 1, systemsChecked: 4 }, checks: [{ ...D0.checks[0]!, status: 'done', doneBy: { handle: 'rina', displayName: 'Rina Kusuma' }, doneAt: '2026-10-31T01:00:00Z', note: 'Nothing found' }] }} />, ctx, theme);
        for (const p of [TEXT.result, TEXT.factOutcome, RESULT_TEXT.exportsQueued!, TEXT.checkDone]) expect(done, p[0]).toContain(tr(p));
        expect(done).not.toContain(tr(TEXT.start));
        const checks = render(<ChecksTable ctx={ctx} checks={[...D0.checks]} />, ctx, theme);
        expect(checks).toContain(tr(TEXT.checkOpen));
        const dialog = render(<TextDialog ctx={ctx} open title="Start" label={TEXT.identityNote} hint={TEXT.identityHint} confirm={TEXT.start} busy={false} error={null} onSubmit={() => undefined} onClose={() => undefined} />, ctx, theme);
        expect(dialog).toContain(tr(TEXT.identityHint));
        const rectify = render(<RectifyDialog ctx={ctx} open detail={D0} busy={false} error={['Shared account', 'Akun bersama']} onSubmit={() => undefined} onClose={() => undefined} />, ctx, theme);
        for (const p of [TEXT.rectifySub, TEXT.displayName, TEXT.jobTitle]) expect(rectify, p[0]).toContain(tr(p));
        const body = render(<PrivacyRequestsScreen ctx={ctx} />, ctx, theme);
        expect(body).toContain('data-filters="privacy-requests"');
        expect(list + form + view + erasing + done + body).not.toMatch(/[—·]/);
      });
    }
  }
});
