// Notifications (MILESTONE-2 M2-16): routes against the shared table, the API adapter over a fake fetch (the unread
// count of `?unread=true&pageSize=1`, the list, Mark read, Mark all read), the link from a notification to its record,
// the bell and the panel items in both languages and themes, when the bell reads the count (only while the person is
// active, so it never keeps an unattended session alive), the top bar rule and the sample adapter.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { Notification } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import { ROUTES, ROUTE_IDS } from '../../src/screens/notifications/routes';
import { createApiAdapter, fromWire } from '../../src/screens/notifications/api';
import { adapterFor, deferredAdapter } from '../../src/screens/notifications/adapter';
import { IDLE_AFTER_MS, POLL_MS, keyOf, linkOf, whenOf } from '../../src/screens/notifications/model';
import { ACTIVITY_EVENTS, startPolling } from '../../src/screens/notifications/poll';
import type { NotificationModel } from '../../src/screens/notifications/model';
import { createSampleAdapter, resetSampleNotifications, sampleNotifications } from '../../src/screens/notifications/sample';
import { NotificationBell, countLabel, refreshAfter } from '../../src/screens/notifications/Bell';
import { NotificationItem, openableLink, readTurns } from '../../src/screens/notifications/Panel';
import { topbarItems } from '../../src/screens/notifications/actions';
import { TEXT } from '../../src/screens/notifications/text';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, sampleD, t, textProblems } from './ctx-m2-16';

const WIRE: Notification = {
  id: '9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c', kind: 'reminder', title: ['Reminder', 'Pengingat'],
  body: ['Reminder: Annual reassessment, due 10 Sep 2026', 'Pengingat: penilaian ulang tahunan, jatuh tempo 10 Sep 2026'], ms: 'isms',
  ref: { module: 'implementation', entityType: 'applicability_entry', id: '0b7e8c2a-1d3f-4e5a-8b6c-7d8e9f0a1b2c', code: 'A.5.23' },
  createdAt: '2026-09-29T02:00:00Z', readAt: null,
};
const page = (items: Notification[], total = items.length) => ({ items, page: 1, pageSize: 20, total });

beforeAll(async () => {
  await loadSampleD();
});
beforeEach(() => resetSampleNotifications());

describe('Notification routes', () => {
  it('match the shared route table', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    expect(textProblems(TEXT)).toEqual([]);
  });
});

describe('Notification API adapter', () => {
  it('reads the unread count, the list, and marks one or all read', async () => {
    const f = fakeFetch({
      'GET /api/v1/notifications': (req) => (req.url.includes('pageSize=1') ? json(page([WIRE], 7)) : json(page([WIRE, { ...WIRE, id: '1f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c', readAt: '2026-09-30T02:00:00Z' }]))),
      'POST /api/v1/notifications/9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c/read': { status: 204 },
      'POST /api/v1/notifications/read-all': { status: 204 },
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789');
    const adapter = createApiAdapter(client);
    expect(await adapter.unreadCount()).toEqual({ ok: true, data: 7 });
    expect(f.calls[0].url).toBe('/api/v1/notifications?unread=true&pageSize=1');
    const list = await adapter.list({ page: 2, pageSize: 20, unreadOnly: true });
    expect(list.ok && list.data.items.map((n) => n.id)).toHaveLength(2);
    expect(f.calls[1].url).toBe('/api/v1/notifications?page=2&pageSize=20&unread=true');
    await adapter.list({ page: 1, pageSize: 20, unreadOnly: false });
    expect(f.calls[2].url).toBe('/api/v1/notifications?page=1&pageSize=20');
    expect(await adapter.markRead(WIRE.id)).toEqual({ ok: true, data: null });
    expect(await adapter.markAllRead()).toEqual({ ok: true, data: null });
    expect(f.calls.slice(3).map((c) => [c.method, c.path, c.headers['x-csrf-token']])).toEqual([
      ['POST', `/api/v1/notifications/${WIRE.id}/read`, 'csrf-token-0123456789'],
      ['POST', '/api/v1/notifications/read-all', 'csrf-token-0123456789'],
    ]);
  });

  it('keeps a refusal', async () => {
    const f = fakeFetch({ 'GET /api/v1/notifications': problem(404, 'not-found', { messages: { en: 'No organisation is selected', id: 'Tidak ada organisasi' } }) });
    const res = await createApiAdapter(new ApiClient({ fetch: f.fetch })).unreadCount();
    expect(res.ok).toBe(false);
  });

  it('a failed module load answers a connection error', async () => {
    const adapter = deferredAdapter(() => Promise.reject(new Error('chunk')));
    const res = await adapter.unreadCount();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.status).toBe(0);
  });
});

describe('links from a notification to its record', () => {
  it('a requirement opens Controls in its system on its tab, with the record open', () => {
    const ctx = ctxOf();
    const req = sampleD().bundles.isms.reqs.find((r) => r.st === 'partial')!;
    const key = `isms:req:${req.id}`;
    const n: NotificationModel = { ...fromWire(WIRE), key };
    expect(linkOf(ctx, n)).toEqual({ screen: 'controls', extra: { ms: 'isms', tab: { controls: 'partial' }, chip: { controls: 'partial' }, sel: key, expanded: { [key]: true } } });
  });

  it('API mode finds the record key through the snapshot references', () => {
    const doc = sampleD().bundles.isms.docs[0];
    const key = `isms:doc:${doc.id}`;
    const ctx = ctxOf({ D: { ...sampleD(), refs: { [key]: { id: 'doc-uuid' } } } as never });
    const n: NotificationModel = { ...fromWire(WIRE), kind: 'document_review_due', ref: { entityType: 'document', id: 'doc-uuid', code: doc.id } };
    expect(keyOf(ctx, n)).toBe(key);
    expect(linkOf(ctx, n)).toEqual({ screen: 'docs', extra: { ms: 'isms', sel: key, expanded: { [key]: true } } });
  });

  it('falls back to the screen of the entity type or the kind, and to nothing', () => {
    const ctx = ctxOf();
    expect(linkOf(ctx, fromWire(WIRE))).toEqual({ screen: 'controls', extra: { ms: 'isms' } });
    expect(linkOf(ctx, { ...fromWire(WIRE), ref: null, kind: 'licence_expiring', ms: null })).toEqual({ screen: 'license', extra: {} });
    expect(linkOf(ctx, { ...fromWire(WIRE), ref: null, kind: 'security', ms: null })).toBeNull();
    // A system the snapshot does not hold is not switched to.
    expect(linkOf(ctx, { ...fromWire(WIRE), ms: 'other' })).toEqual({ screen: 'controls', extra: {} });
  });

  it('a host screen the session cannot open gives no link', () => {
    const n: NotificationModel = { ...fromWire(WIRE), ref: null, kind: 'licence_state', ms: null };
    expect(openableLink(ctxOf({ mode: 'api', org: ['license.read'] }), n)).toMatchObject({ screen: 'license' });
    expect(openableLink(ctxOf({ mode: 'api', org: [] }), n)).toBeNull();
  });
});

describe('bell and panel items', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`render in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme });
        const bell = render(<NotificationBell ctx={ctx} />, ctx, theme);
        expect(bell).toContain(`title="${t(TEXT.bell, lang)}"`);
        expect(bell).toContain('data-topbar="notifications"');
        const n: NotificationModel = { ...fromWire(WIRE), key: `isms:req:${sampleD().bundles.isms.reqs[0].id}` };
        const item = render(<ul><NotificationItem ctx={ctx} n={n} busy={false} onRead={() => undefined} onOpen={() => undefined} /></ul>, ctx, theme);
        expect(item).toContain(esc(t(WIRE.title as [string, string], lang)));
        expect(item).toContain(esc(t(WIRE.body as [string, string], lang)));
        expect(item).toContain(esc(t(TEXT.unread, lang)));
        expect(item).toContain(esc(t(TEXT.open, lang)));
        expect(item).toContain(esc(t(TEXT.markRead, lang)));
        expect(item).toContain(esc(whenOf(ctx, WIRE.createdAt)));
        const read = render(<ul><NotificationItem ctx={ctx} n={{ ...n, readAt: '2026-09-30T00:00:00Z' }} busy={false} onRead={() => undefined} onOpen={() => undefined} /></ul>, ctx, theme);
        expect(read).not.toContain(esc(t(TEXT.markRead, lang)));
        expect(item + read).not.toMatch(/[—·]/);
      });
    }
  }

  it('the count badge stops at 99+', () => {
    expect(countLabel(3)).toBe('3');
    expect(countLabel(120)).toBe('99+');
  });

  it('after Open the bell reads the count only once Mark read is answered', async () => {
    let answer: (v: unknown) => void = () => undefined;
    const marked = new Promise((resolve) => { answer = resolve; });
    const refresh = vi.fn();
    refreshAfter(marked, refresh);
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    answer({ ok: true, data: null });
    await marked;
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    // A refused or broken request still reads the count; a plain close reads it at once.
    const failed = Promise.reject(new Error('offline'));
    refreshAfter(failed, refresh);
    await failed.catch(() => undefined);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    refreshAfter(null, refresh);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('the panel applies only the answer of its newest read', () => {
    const next = readTurns();
    const full = next();
    expect(full()).toBe(true);
    // "Show unread only" reads again before the full list answers: the full list's answer is no longer applied.
    const unreadOnly = next();
    expect(full()).toBe(false);
    expect(unreadOnly()).toBe(true);
    // Closing the panel takes a turn too.
    next();
    expect(unreadOnly()).toBe(false);
  });

  it('the bell shows in the sample build and for API sessions in an organisation', () => {
    const item = topbarItems![0];
    expect(item.visible!(ctxOf())).toBe(true);
    expect(item.visible!(ctxOf({ mode: 'api', me: { org: { id: 'x', slug: 'ndt', name: 'N' } } as never }))).toBe(true);
    // A platform operator without a membership has no notifications.
    expect(item.visible!(ctxOf({ mode: 'api', me: { org: null } as never }))).toBe(false);
  });
});

describe('when the bell reads the unread count', () => {
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    vi.useFakeTimers();
    const f = fakeFetch({ 'GET /api/v1/notifications': json(page([WIRE], 1)) });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    const target = new EventTarget();
    const state = { hidden: false };
    const stop = startPolling(() => void adapter.unreadCount(), { target, hidden: () => state.hidden });
    return { f, target, state, stop };
  };

  it('sends no request after five minutes without input, so the session idle timeout still runs out', async () => {
    const { f, target, stop } = setup();
    expect(IDLE_AFTER_MS).toBeLessThan(30 * 60_000);
    // Every minute while the page was just opened: at 1, 2, 3 and 4 minutes.
    await vi.advanceTimersByTimeAsync(IDLE_AFTER_MS);
    expect(f.calls).toHaveLength(4);
    // Nobody uses the page for two hours: no request at all, while the idle timeout is 60 minutes (30 for guests).
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(f.calls).toHaveLength(4);
    // A mouse moved over the page is not input.
    target.dispatchEvent(new Event('pointermove'));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(f.calls).toHaveLength(4);
    expect(f.calls.every((c) => c.url === '/api/v1/notifications?unread=true&pageSize=1')).toBe(true);
    stop();
  });

  it('reads at once on the first input after a quiet spell, then every minute while the person stays active', async () => {
    const { f, target, stop } = setup();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f.calls).toHaveLength(4);
    target.dispatchEvent(new Event('keydown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(f.calls).toHaveLength(6);
    // Input within the window keeps the reads going; a second input without a skipped read sends nothing extra.
    target.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(f.calls).toHaveLength(7);
    expect([...ACTIVITY_EVENTS]).toEqual(['pointerdown', 'keydown', 'wheel', 'touchstart']);
    stop();
  });

  it('reads nothing while the page is hidden, and nothing after the bell is gone', async () => {
    const { f, target, state, stop } = setup();
    state.hidden = true;
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(f.calls).toHaveLength(0);
    state.hidden = false;
    target.dispatchEvent(new Event('wheel'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    stop();
    target.dispatchEvent(new Event('keydown'));
    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    expect(f.calls).toHaveLength(1);
  });
});

describe('notification sample adapter', () => {
  it('reads the sample notifications, marks one and then all read', async () => {
    const adapter = createSampleAdapter(() => sampleD());
    expect(await adapter.unreadCount()).toEqual({ ok: true, data: 3 });
    const unread = await adapter.list({ page: 1, pageSize: 20, unreadOnly: true });
    expect(unread.ok && unread.data.total).toBe(3);
    await adapter.markRead('sample-n1');
    expect(await adapter.unreadCount()).toEqual({ ok: true, data: 2 });
    await adapter.markAllRead();
    expect(await adapter.unreadCount()).toEqual({ ok: true, data: 0 });
    const all = await adapter.list({ page: 1, pageSize: 2, unreadOnly: false });
    expect(all.ok && [all.data.items.length, all.data.total]).toEqual([2, 4]);
    expect(sampleNotifications(sampleD()).every((n) => linkOf(ctxOf(), n))).toBe(true);
  });

  it('the build chooses the sample adapter outside the api build', async () => {
    expect(await adapterFor(null, () => sampleD()).unreadCount()).toEqual({ ok: true, data: 3 });
  });
});
