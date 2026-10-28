// Invitations (MILESTONE-2 M2-16): routes against the shared table, the API adapter over a fake fetch (accept with
// the LIC-USERS refusal kept, decline), the invitations the banner shows (Me.pendingMemberships less those handled in
// this page session), the banner in both languages and themes and the host layer rule.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routeById } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import { ROUTES, ROUTE_IDS } from '../../src/screens/invitations/routes';
import { createApiAdapter } from '../../src/screens/invitations/api';
import { markHandled, pendingOf, resetHandled } from '../../src/screens/invitations/model';
import { InvitationBanner } from '../../src/screens/invitations/Banner';
import { layerItems } from '../../src/screens/invitations/actions';
import { TEXT } from '../../src/screens/invitations/text';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, t, textProblems } from './ctx-m2-16';

const PENDING = [
  { org: 'bsd', name: 'PT Bank Sentosa Digital', invitedBy: 'Andi Wijaya', invitedAt: '2026-10-20T03:00:00Z' },
  { org: 'rmn', name: 'Rumah Sakit Nusantara', invitedBy: null, invitedAt: '2026-10-21T08:30:00Z' },
];
const me = (pendingMemberships = PENDING) => ({ user: { id: 'u-1', handle: 'sari' }, org: { id: 'o', slug: 'ndt', name: 'N' }, pendingMemberships }) as never;

beforeAll(async () => {
  await loadSampleD();
});
beforeEach(() => resetHandled());

describe('Invitation routes', () => {
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

describe('Invitation API adapter', () => {
  it('accepts and declines with the CSRF token; the LIC-USERS refusal is kept', async () => {
    const f = fakeFetch({
      'POST /api/v1/me/memberships/bsd/accept': [
        problem(422, 'business-rule', { rule: 'LIC-USERS', messages: { en: 'The organisation has no free seat', id: 'Organisasi tidak memiliki kursi kosong' } }),
        json({}),
      ],
      'POST /api/v1/me/memberships/rmn/decline': { status: 204 },
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789');
    const adapter = createApiAdapter(client);
    const full = await adapter.accept('bsd');
    expect(full.ok).toBe(false);
    if (!full.ok) expect([full.error.rule, full.error.message]).toEqual(['LIC-USERS', ['The organisation has no free seat', 'Organisasi tidak memiliki kursi kosong']]);
    expect(await adapter.accept('bsd')).toEqual({ ok: true });
    expect(await adapter.decline('rmn')).toEqual({ ok: true });
    expect(f.calls.map((c) => [c.method, c.path, c.headers['x-csrf-token']])).toEqual([
      ['POST', '/api/v1/me/memberships/bsd/accept', 'csrf-token-0123456789'],
      ['POST', '/api/v1/me/memberships/bsd/accept', 'csrf-token-0123456789'],
      ['POST', '/api/v1/me/memberships/rmn/decline', 'csrf-token-0123456789'],
    ]);
  });
});

describe('the invitations the banner shows', () => {
  it('come from Me, oldest first, without those handled in this page session', () => {
    const ctx = ctxOf({ mode: 'api', me: me() });
    expect(pendingOf(ctx).map((i) => i.org)).toEqual(['bsd', 'rmn']);
    markHandled(ctx, 'bsd');
    expect(pendingOf(ctx).map((i) => i.org)).toEqual(['rmn']);
    expect(pendingOf(ctxOf({ mode: 'api', me: { user: { id: 'u-1' }, org: null } as never }))).toEqual([]);
    expect(pendingOf(ctxOf())).toEqual([]);
  });

  it('the banner shows in API builds only while an invitation waits', () => {
    const item = layerItems![0];
    expect(item.visible!(ctxOf({ mode: 'api', me: me() }))).toBe(true);
    expect(item.visible!(ctxOf({ mode: 'api', me: me([]) }))).toBe(false);
    expect(item.visible!(ctxOf())).toBe(false);
  });

  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the banner names the organisation and offers Accept, Decline and Later in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme, mode: 'api', me: me() });
        const html = render(<InvitationBanner ctx={ctx} />, ctx, theme);
        expect(html).toContain(esc(ctx.fill(TEXT.invited, { organisation: 'PT Bank Sentosa Digital' })));
        expect(html).toContain(esc(ctx.fill(TEXT.invitedBy, { name: 'Andi Wijaya', date: ctx.D!.fmt('2026-10-20', lang) })));
        expect(html).toContain(esc(t(TEXT.moreOne, lang)));
        for (const label of [TEXT.accept, TEXT.decline, TEXT.later]) expect(html).toContain(`>${esc(t(label, lang))}</button>`);
        expect(html).toContain(`aria-label="${esc(t(TEXT.region, lang))}"`);
        expect(html).not.toMatch(/[—·]/);
      });
    }
  }

  it('an invitation from an operator command names no person; nothing shows without invitations', () => {
    const ctx = ctxOf({ mode: 'api', me: me([PENDING[1]]) });
    const html = render(<InvitationBanner ctx={ctx} />, ctx);
    expect(html).toContain(esc(ctx.fill(TEXT.invitedOn, { date: ctx.D!.fmt('2026-10-21', 'en') })));
    expect(html).not.toContain(esc(t(TEXT.moreOne)));
    expect(render(<InvitationBanner ctx={ctxOf({ mode: 'api', me: me([]) })} />, ctx)).not.toContain('mx-invite');
  });
});
