// Personal data checks (MILESTONE-3 M3-04, D.6.4): routes against the shared table, the definition in My Tasks, the
// model (record kinds, the screen that edits a mentioned record, the order), the API adapter over a fake fetch, the
// sample adapter on the store shared with Personal data requests, and the views in both languages and themes.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/privacy-checks/index';
import meta from '../../src/screens/privacy-checks/meta.json';
import { ROUTES, ROUTE_IDS } from '../../src/screens/privacy-checks/routes';
import { createApiAdapter, fromItem } from '../../src/screens/privacy-checks/api';
import { createSampleAdapter } from '../../src/screens/privacy-checks/sample';
import { adapterFor, deferredAdapter } from '../../src/screens/privacy-checks/adapter';
import { fieldText, kindText, sortChecks, targetOf } from '../../src/screens/privacy-checks/model';
import type { CheckRow, Mention, PrivacyChecksAdapter } from '../../src/screens/privacy-checks/model';
import PrivacyChecksScreen, { CheckDrawer, CheckStatus, MarkDialog, MentionsTable } from '../../src/screens/privacy-checks/Screen';
import { KIND_TEXT, TEXT } from '../../src/screens/privacy-checks/text';
import { createSampleAdapter as createRequestsAdapter } from '../../src/screens/privacy-requests/sample';
import { requestsOf, resetSamplePrivacy } from '../../src/screens/privacy-requests/sample-store';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, sampleD, t, textProblems } from './ctx-m2-16';

const ID = '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const ITEM = { id: ID, requestNo: 'PR-2026-004', type: 'erasure', subject: { name: 'Andi Wijaya', handle: null }, dueAt: '2026-11-02T09:00:00Z', status: 'open', doneAt: null } as const;
const ROW: CheckRow = fromItem(ITEM as never);
const MENTION: Mention = { recordKind: 'risk', recordId: '8d9e0f1a-2b3c-4d4e-9f5a-6b7c8d9e0f1a', code: 'R-031', field: 'description', excerpt: '... reported by Andi Wijaya of the supplier ...' };

beforeAll(async () => {
  await loadSampleD();
});
afterEach(() => resetSamplePrivacy());

describe('personal data check routes and definition', () => {
  it('match the shared route table and need privacy_request.assist in the system', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
      expect(route.permission, name).toBe('privacy_request.assist');
      expect(route.scope, name).toBe('ms');
    }
  });

  it('is in My Tasks for the Management System Managers, with no page action', () => {
    expect(screen).toMatchObject({ id: 'privacy-checks', path: '/ms/:ms/privacy-checks', group: 'tasks', order: 30, scope: 'ms', perm: 'privacy_request.assist', roles: ['manager'] });
    expect(meta).toMatchObject({ id: screen.id, group: screen.group, order: screen.order, scope: screen.scope, perm: screen.perm, pageActions: [] });
    expect(screen.pageActions).toBeUndefined();
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    expect(textProblems(TEXT, ['colStatus'])).toEqual([]);
    expect(textProblems(KIND_TEXT)).toEqual([]);
  });
});

describe('personal data check model', () => {
  it('names record kinds and fields, and opens the screen that edits a record', () => {
    expect(kindText('risk')).toEqual(['Risk', 'Risiko']);
    expect(kindText('new_kind')).toEqual(['New kind', 'New kind']);
    expect(fieldText('pending_action')).toBe('Pending action');
    expect(targetOf('isms', MENTION)).toEqual({ screen: 'registers', extra: { ms: 'isms', params: { tab: 'risks' } } });
    expect(targetOf('isms', { ...MENTION, recordKind: 'interested_party' })!.extra.params).toEqual({ tab: 'interested-parties' });
    expect(targetOf('isms', { ...MENTION, recordKind: 'document', code: 'POL-01' })).toEqual({ screen: 'docs', extra: { ms: 'isms', sel: 'isms:doc:POL-01', expanded: { 'isms:doc:POL-01': true } } });
    expect(targetOf('isms', { ...MENTION, recordKind: 'evidence', code: 'EV-007' })).toEqual({ screen: 'fresh', extra: { ms: 'isms', sel: 'isms:ev:EV-007', expanded: { 'isms:ev:EV-007': true } } });
    expect(targetOf('isms', { ...MENTION, recordKind: 'finding' })).toMatchObject({ screen: 'findings', extra: { params: { finding: MENTION.recordId } } });
    expect(targetOf('isms', { ...MENTION, recordKind: 'corrective_action' })).toMatchObject({ screen: 'findings', extra: { params: { tab: 'actions' } } });
    expect(targetOf('isms', { ...MENTION, recordKind: 'retention_hold' })).toEqual({ screen: 'retention', extra: { ms: 'isms' } });
    expect(targetOf('isms', { ...MENTION, recordKind: 'access_review' })).toEqual({ screen: 'access-review', extra: { ms: 'isms' } });
    expect(targetOf('isms', { ...MENTION, recordKind: 'management_review' })).toEqual({ screen: 'management-review', extra: { ms: 'isms' } });
    expect(targetOf('isms', { ...MENTION, recordKind: 'document', code: null })).toBeNull();
    expect(targetOf('isms', { ...MENTION, recordKind: 'task' })).toBeNull();
  });

  it('orders open checks by due time and done ones newest first', () => {
    const rows = [
      { ...ROW, id: 'd1', status: 'done' as const, doneAt: '2026-10-30T01:00:00Z' },
      { ...ROW, id: 'o2', dueAt: '2026-11-03T09:00:00Z' },
      { ...ROW, id: 'd2', status: 'done' as const, doneAt: '2026-10-31T01:00:00Z' },
      { ...ROW, id: 'o1' },
    ];
    expect(sortChecks(rows).map((r) => r.id)).toEqual(['o1', 'o2', 'd2', 'd1']);
  });
});

describe('personal data check API adapter', () => {
  it('lists the checks, reads the mentions and marks a check done; keeps a refusal', async () => {
    const done = problem(409, 'conflict', { messageKey: 'privacy.check_done', messages: { en: 'This check is already done.', id: 'Pemeriksaan ini sudah selesai.' } });
    const f = fakeFetch({
      'GET /api/v1/ms/isms/privacy-checks': json([ITEM]),
      [`GET /api/v1/ms/isms/privacy-checks/${ID}/mentions`]: json({ items: [MENTION], truncated: true }),
      [`POST /api/v1/ms/isms/privacy-checks/${ID}/done`]: [json({ ok: true, changed: ['isms'], message: ['Check of PR-2026-004 marked done', 'Pemeriksaan PR-2026-004 ditandai selesai'] }), done],
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client);
    expect(await adapter.list('isms')).toEqual({ ok: true, status: 200, data: [ROW] });
    expect(await adapter.mentions('isms', ID)).toEqual({ ok: true, status: 200, data: { items: [MENTION], truncated: true } });
    expect(await adapter.done('isms', ID, 'Risk R-031 edited')).toEqual({ ok: true, status: 200, data: { message: ['Check of PR-2026-004 marked done', 'Pemeriksaan PR-2026-004 ditandai selesai'] } });
    expect(f.calls.at(-1)).toMatchObject({ method: 'POST', body: { note: 'Risk R-031 edited' }, headers: { 'x-csrf-token': 'csrf-token-0123456789abcdef' } });
    expect(await adapter.done('isms', ID, 'Again')).toMatchObject({ ok: false, error: { status: 409, messageKey: 'privacy.check_done' } });
  });
});

describe('personal data check sample adapter', () => {
  const me = () => ({ handle: 'rina', displayName: 'Rina Kusuma' });
  const adapter = () => createSampleAdapter(() => sampleD(), () => 'ndt', me);

  it('lists the system\'s checks of the shared store, shows their mentions and marks one done for the request', async () => {
    const a = adapter();
    const ms = requestsOf(sampleD(), 'ndt')[0]!.checks[0]!.ms;
    const list = await a.list(ms);
    if (!list.ok) throw new Error('list failed');
    expect(list.data.map((r) => [r.requestNo.slice(-3), r.status])).toEqual([['002', 'open'], ['001', 'done']]);
    const open = list.data[0]!;
    expect(open.subject).toEqual({ name: 'Bima Haryanto', handle: null });
    const mentions = await a.mentions(ms, open.id);
    expect(mentions.ok && mentions.data.items.map((m) => m.recordKind)).toEqual(['document', 'risk']);
    expect(await a.done(ms, open.id, 'Risk R-031 edited')).toEqual({ ok: true, status: 200, data: { message: null } });
    expect(await a.done(ms, open.id, 'Again')).toMatchObject({ ok: false, error: { status: 409, messageKey: 'privacy.check_done' } });
    expect(await a.mentions('qms-none', open.id)).toMatchObject({ ok: false, error: { status: 404 } });
    // The request of Personal data requests sees the check done.
    const requests = createRequestsAdapter(() => sampleD(), () => 'ndt');
    const detail = await requests.get(requestsOf(sampleD(), 'ndt')[1]!.id);
    expect(detail.ok && detail.data.checks.find((c) => c.ms === ms)).toMatchObject({ status: 'done', doneBy: { handle: 'rina' }, note: 'Risk R-031 edited' });
    // A check of a closed request is refused.
    const closed = requestsOf(sampleD(), 'ndt')[1]!;
    closed.status = 'withdrawn';
    const other = closed.checks.find((c) => c.status === 'open');
    if (other) expect(await a.done(other.ms, other.id, 'x')).toMatchObject({ ok: false, error: { messageKey: 'privacy.check_closed' } });
  });

  it('the build chooses the sample adapter; a deferred adapter retries a failed module load', async () => {
    const ctx = ctxOf();
    expect(adapterFor(ctx).sample).toBe(true);
    expect(await adapterFor(ctx).list('isms')).toMatchObject({ ok: true });
    const load = vi.fn<() => Promise<PrivacyChecksAdapter>>().mockRejectedValueOnce(new Error('chunk')).mockResolvedValue(adapter());
    const deferred = deferredAdapter(load);
    await expect(deferred.list('isms')).rejects.toThrow('chunk');
    expect(await deferred.list('isms')).toMatchObject({ ok: true });
  });
});

describe('personal data check views', () => {
  const sample = createSampleAdapter(() => sampleD(), () => 'ndt', () => ({ handle: 'rina', displayName: 'Rina Kusuma' }));
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the checks, a check and its mentions in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme });
        const tr = (p: readonly [string, string]) => esc(t(p, lang));
        const body = render(<PrivacyChecksScreen ctx={ctx} />, ctx, theme);
        expect(body).toContain(tr(TEXT.title));
        expect(body).toContain(tr(TEXT.loading));
        const drawer = render(<CheckDrawer ctx={ctx} adapter={sample} ms="isms" row={{ ...ROW, subject: { name: 'Bagus Prasetyo', handle: 'bagus' } }} onClose={() => undefined} />, ctx, theme);
        for (const p of [TEXT.facts, TEXT.mentions, TEXT.mentionsSub, TEXT.mentionsLoading, TEXT.markDone, TEXT.handover, TEXT.handoverOpen]) expect(drawer, p[0]).toContain(tr(p));
        expect(drawer).toContain('data-check="PR-2026-004"');
        const noAccount = render(<CheckDrawer ctx={ctx} adapter={sample} ms="isms" row={{ ...ROW, status: 'done', doneAt: '2026-10-31T01:00:00Z' }} onClose={() => undefined} />, ctx, theme);
        expect(noAccount).toContain(tr(TEXT.noAccount));
        expect(noAccount).toContain(tr(TEXT.alreadyDone));
        expect(noAccount).not.toContain(tr(TEXT.handoverOpen));
        const table = render(<MentionsTable ctx={ctx} ms="isms" mentions={{ items: [MENTION, { ...MENTION, recordKind: 'task', recordId: 'b', code: null, field: 'title_en' }], truncated: true }} />, ctx, theme);
        for (const p of [TEXT.colRecord, TEXT.colCode, TEXT.colField, TEXT.colText, TEXT.openRecord, TEXT.noPage, TEXT.truncated, KIND_TEXT.risk!]) expect(table, p[0]).toContain(tr(p));
        expect(table).toContain('R-031');
        const status = render(<CheckStatus ctx={ctx} row={{ status: 'open', doneAt: null, dueAt: '2020-01-01T00:00:00Z' }} />, ctx, theme);
        expect(status).toContain(tr(TEXT.overdue));
        const mark = render(<MarkDialog ctx={ctx} open row={ROW} busy={false} error={null} onSubmit={() => undefined} onClose={() => undefined} />, ctx, theme);
        for (const p of [TEXT.markNote, TEXT.markHint]) expect(mark, p[0]).toContain(tr(p));
        expect(mark).toContain('data-form="privacy-check-done"');
        expect(body + drawer + table + mark).not.toMatch(/[—·]/);
      });
    }
  }
});
