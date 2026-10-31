// Access reviews (MILESTONE-3 M3-07): routes against the shared table and their permissions, the definition and its
// texts, the forms and their checks, what holds up a sign-off or the completion, the texts of rows, the API adapter
// over a fake fetch (settings with If-Match, reviews, decisions, applying, completion, cancel, the report link, the
// system routes and the evidence of the snapshot), the sample adapter (the open review, REVIEW-OWN-ACCESS, a second
// reviewer, applying, completion refused while something waits and then completed, one open review at a time, the
// report CSV), and the pages and dialogs in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { AccessReviewDetail, AccessReviewItemView, AccessReviewPartDetail, AccessReviewSettings, AccessReviewSummary } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { createApiAdapter, reportHref } from '../../src/screens/access-reviews/api';
import screen from '../../src/screens/access-reviews/index';
import meta from '../../src/screens/access-reviews/meta.json';
import {
  DECISION_TEXT, FREQUENCIES, FREQUENCY_TEXT, ITEM_KINDS, KIND_TEXT, accessText, appliedText, completionBlocks, decisionBody, decisionErrors, formatDay, mayApplyOrg,
  mayDecide, mayManage, mayRevokeGuest, myHandle, noReviewerParts, noteError, settingsBody, settingsErrors, signOffBlock, waitsForApplication,
} from '../../src/screens/access-reviews/model';
import type { ItemRow, ReviewDetail } from '../../src/screens/access-reviews/model';
import { ApplyNoteDialog, DecisionDialog, ItemsTable } from '../../src/screens/access-reviews/parts';
import { ROUTES, ROUTE_IDS, pathOf } from '../../src/screens/access-reviews/routes';
import { createSampleAdapter, resetSampleAccessReviews } from '../../src/screens/access-reviews/sample';
import { SettingsDialog } from '../../src/screens/access-reviews/settings';
import { TEXT } from '../../src/screens/access-reviews/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';

const TODAY = SAMPLE.TODAY_S as string;
const D = { ...makeDates(TODAY), ...(await createSampleDataSource().load()), TODAY_S: TODAY } as unknown as ControllerData;
const FORBIDDEN = /[—·]/;
const ID = '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e';
const ITEM_ID = '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: D.MS[0], org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'access-reviews', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}
const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);
const li = (t: readonly [string, string]) => t[0];
const fill = (t: readonly [string, string], v: Record<string, string | number>) => t[0].replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));

const ITEM: AccessReviewItemView = {
  id: ITEM_ID, kind: 'business_role', subject: { handle: 'bagus', displayName: 'Bagus Prasetyo' }, ms: 'isms', role: 'domain_owner', grantedBy: { handle: 'rina', displayName: 'Rina Kusuma' },
  grantedAt: '2025-03-01T02:00:00Z', requestedBy: { handle: 'tono', displayName: 'Tono Wibowo' }, approvedBy: { handle: 'rina', displayName: 'Rina Kusuma' }, validUntil: null,
  lastSignInAt: '2026-09-20T02:00:00Z', decision: 'revoke', decisionNote: 'Moved to finance', decidedBy: { handle: 'rina', displayName: 'Rina Kusuma' }, decidedAt: '2026-09-25T02:00:00Z', appliedAt: null, appliedBy: null, appliedAction: null, appliedNote: null, notAppliedReason: null, ownAccess: false, pendingApproval: false, needsSecondReviewer: false,
};
const PART = {
  id: '0d1e2f3a-4b5c-4d6e-9f7a-8b9c0d1e2f3a', reviewId: ID, reviewNo: 'AR-2026-02', reviewStatus: 'open', ms: 'isms', status: 'open', dueOn: '2026-10-13', items: 1, decided: 1,
  needsSecondReviewer: 0, noReviewer: false, signedOffBy: null, signedOffAt: null, evidenceId: null, evidenceCode: null, evidenceFiledAt: null,
} as const;
const SUMMARY: AccessReviewSummary = {
  id: ID, reviewNo: 'AR-2026-02', status: 'open', openedOn: '2026-09-29', dueOn: '2026-10-13', openedBy: { handle: 'tenant.admin', displayName: 'Tenant Admin' }, completedAt: null,
  completedBy: null, cancelReason: null, progress: { items: 20, decided: 10, revocations: 2, applied: 1, parts: 2, signedOff: 1 },
};
const DETAIL: AccessReviewDetail = {
  ...SUMMARY, organisationPart: { ...PART, id: 'org-part', ms: null, rows: [{ ...ITEM, kind: 'membership', ms: null, role: 'active', requestedBy: null, approvedBy: null, decision: null, decisionNote: null, decidedBy: null, decidedAt: null }], suggestedEvidence: null },
  parts: [PART], pendingApplications: [ITEM], warnings: [{ rule: 'REVIEW-SINGLE-ADMIN', messages: { en: 'Only one reviewer', id: 'Hanya satu peninjau' } }],
};
const SETTINGS: AccessReviewSettings = { frequencyMonths: 3, nextDueOn: '2026-12-29', daysToComplete: 14, etag: 'W/"1793350800000"' };

afterEach(() => {
  resetSampleAccessReviews();
});

describe('access review routes and definition', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    for (const id of ['settings', 'putSettings', 'list', 'create', 'get', 'decide', 'complete', 'cancel', 'report'] as const) expect(routeById(ROUTE_IDS[id]).permission, id).toBe('access_review.manage');
    expect(routeById(ROUTE_IDS.apply).permission).toBe('user.manage');
    for (const id of ['msList', 'msGet', 'msDecide', 'signOff'] as const) expect(routeById(ROUTE_IDS[id]).permission, id).toBe('access_review.decide');
    expect(routeById(ROUTE_IDS.msApply).permission).toBe('auditor_access.grant');
    expect(routeById('admin.users.identities.remove').permission).toBe('user.manage');
    expect(pathOf(ROUTES.report, { id: ID })).toBe(`/api/v1/admin/access-reviews/${ID}/report`);
  });

  it('is the administration screen of the plan', () => {
    expect(screen).toMatchObject({ id: 'access-reviews', path: '/admin/access-reviews', group: 'admin', scope: 'org', perm: 'access_review.manage', roles: ['manager'] });
    expect(meta).toMatchObject({ id: 'access-reviews', label: ['Access reviews', 'Tinjauan akses'], sampleRole: 'manager', scope: 'org' });
  });

  it('has both languages in every text, without an em dash or a centre dot', () => {
    for (const [name, pair] of Object.entries(TEXT)) {
      expect(pair, name).toHaveLength(2);
      expect(pair[0].trim(), name).not.toBe('');
      expect(pair[1].trim(), name).not.toBe('');
      expect(pair.join(' '), name).not.toMatch(FORBIDDEN);
    }
    for (const k of ITEM_KINDS) expect(KIND_TEXT[k][1]).not.toBe(KIND_TEXT[k][0]);
    for (const f of FREQUENCIES) expect(FREQUENCY_TEXT[f][1]).not.toBe(FREQUENCY_TEXT[f][0]);
  });
});

describe('model', () => {
  it('checks the schedule form and builds its body', () => {
    expect(settingsErrors({ frequencyMonths: '2', nextDueOn: '2026-01-01', daysToComplete: '0' }, TODAY)).toEqual({ frequencyMonths: TEXT.badFrequency, nextDueOn: TEXT.badNextDue, daysToComplete: TEXT.badDays });
    expect(settingsErrors({ frequencyMonths: '6', nextDueOn: TODAY, daysToComplete: '60' }, TODAY)).toEqual({});
    expect(settingsBody({ frequencyMonths: '12', nextDueOn: '2027-01-15', daysToComplete: '21' })).toEqual({ frequencyMonths: 12, nextDueOn: '2027-01-15', daysToComplete: 21 });
  });

  it('checks the decision form: a decision, and a note for a change', () => {
    expect(decisionErrors({ decision: '', note: '' })).toEqual({ decision: TEXT.badDecision });
    expect(decisionErrors({ decision: 'change', note: ' ' })).toEqual({ note: TEXT.badChangeNote });
    expect(decisionErrors({ decision: 'revoke', note: 'x'.repeat(501) })).toEqual({ note: TEXT.tooLong500 });
    expect(decisionBody({ decision: 'keep', note: '  ' })).toEqual({ decision: 'keep' });
    expect(decisionBody({ decision: 'change', note: ' End on 30 Nov ' })).toEqual({ decision: 'change', note: 'End on 30 Nov' });
    expect(noteError('')).toBe(TEXT.badReason);
    expect(noteError('', true)).toBeNull();
    expect(noteError('x'.repeat(501), true)).toBe(TEXT.tooLong500);
  });

  it('names the access of a row and how it was applied', () => {
    expect(accessText({ kind: 'business_role', role: 'domain_owner' }, li)).toBe('Domain Owner');
    expect(accessText({ kind: 'admin_role', role: 'tenant_admin' }, li)).toBe('Tenant Admin');
    expect(accessText({ kind: 'membership', role: 'invited' }, li)).toBe(TEXT.mInvited[0]);
    expect(accessText({ kind: 'linked_sign_in', role: 'keycloak' }, li)).toBe('keycloak');
    expect(appliedText({ appliedAction: 'role.revoked', appliedAt: 'x', notAppliedReason: null }, li)).toBe(TEXT.aApplied[0]);
    expect(appliedText({ appliedAction: 'already_removed', appliedAt: 'x', notAppliedReason: null }, li)).toBe(TEXT.aAlreadyRemoved[0]);
    expect(appliedText({ appliedAction: 'not_applied', appliedAt: null, notAppliedReason: 'Still needed' }, li)).toBe(TEXT.aNotApplied[0]);
    expect(appliedText({ appliedAction: null, appliedAt: null, notAppliedReason: null }, li)).toBeNull();
    expect(waitsForApplication({ decision: 'revoke', appliedAt: null, notAppliedReason: null })).toBe(true);
    expect(waitsForApplication({ decision: 'keep', appliedAt: null, notAppliedReason: null })).toBe(false);
    expect(formatDay('2026-10-13', 'en')).toMatch(/13 Oct 2026/);
    expect(formatDay(null, 'id')).toBe('-');
    expect(DECISION_TEXT.revoke).toEqual(['Revoke', 'Cabut']);
  });

  it('tells what holds up a sign-off and the completion', () => {
    const row = (over: Partial<ItemRow>): ItemRow => ({ ...(ITEM as ItemRow), ...over });
    expect(signOffBlock({ status: 'open', reviewStatus: 'open', rows: [row({ decision: null })] })).toBe(TEXT.blockUndecided);
    expect(signOffBlock({ status: 'open', reviewStatus: 'open', rows: [row({ decision: null, needsSecondReviewer: true }), row({})] })).toBeNull();
    expect(signOffBlock({ status: 'signed_off', reviewStatus: 'open', rows: [] })).toBe(TEXT.blockSignedOff);
    expect(signOffBlock({ status: 'open', reviewStatus: 'cancelled', rows: [] })).toBe(TEXT.blockNotOpen);
    const detail = { status: 'open', parts: [{ ...PART, status: 'open' }], organisationPart: { rows: [row({ decision: null })] }, pendingApplications: [row({})] } as unknown as ReviewDetail;
    expect(completionBlocks(detail, li, fill)).toEqual(['Not signed off yet: ISMS', '1 organisation item(s) to decide', '1 revocation(s) or change(s) to apply or explain']);
    expect(completionBlocks({ ...detail, parts: [], organisationPart: { rows: [] }, pendingApplications: [] } as unknown as ReviewDetail, li, fill)).toEqual([]);
    // A system nobody may review now is named on its own: a Tenant Admin assigns a reviewer or cancels the review.
    const unreviewable = { ...detail, parts: [{ ...PART, ms: 'qms', noReviewer: true }, { ...PART, status: 'open' }], organisationPart: { rows: [] }, pendingApplications: [] } as unknown as ReviewDetail;
    expect(noReviewerParts(unreviewable).map((p) => p.ms)).toEqual(['qms']);
    expect(completionBlocks(unreviewable, li, fill)).toEqual([
      'Not signed off yet: ISMS',
      'QMS has no Management System Manager or Programme Owner to review it; assign one on People and roles, or cancel the review',
    ]);
    expect(noReviewerParts({ ...unreviewable, status: 'cancelled' })).toEqual([]);
  });

  it('knows who may manage, apply, decide and revoke guest access', () => {
    const admin = ctxOf('en', { orgCan: (p) => p === 'access_review.manage', can: () => false });
    expect([mayManage(admin), mayApplyOrg(admin), mayDecide(admin, 'isms'), mayRevokeGuest(admin, 'isms')]).toEqual([true, false, false, false]);
    const owner = ctxOf('en', { orgCan: () => false, can: (_m, p) => p === 'access_review.decide' });
    expect([mayDecide(owner, 'isms'), mayRevokeGuest(owner, 'isms'), mayDecide(owner, null)]).toEqual([true, false, false]);
    expect(myHandle(ctxOf('en'))).toBe('rina');
    expect(myHandle(ctxOf('en', { me: { user: { handle: 'tenant.admin' } } as never }))).toBe('tenant.admin');
  });
});

describe('API adapter', () => {
  function setup(routes: Parameters<typeof fakeFetch>[0], getD: () => ControllerData | null = () => null) {
    const f = fakeFetch(routes);
    const client = new ApiClient({ fetch: f.fetch, lang: 'en' });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    return { calls: f.calls, adapter: createApiAdapter(client, getD) };
  }

  it('reads and saves the settings with If-Match; a stale ETag answers 412', async () => {
    const { calls, adapter } = setup({
      'GET /api/v1/admin/access-reviews/settings': json(SETTINGS),
      'PUT /api/v1/admin/access-reviews/settings': [json({ ...SETTINGS, frequencyMonths: 6 }), problem(412, 'precondition-failed')],
    });
    const read = await adapter.settings();
    expect(read.ok && read.data).toEqual(SETTINGS);
    const saved = await adapter.putSettings({ frequencyMonths: 6, nextDueOn: '2026-12-29', daysToComplete: 14 }, SETTINGS.etag);
    expect(saved.ok && saved.data.frequencyMonths).toBe(6);
    expect(calls[1]).toMatchObject({ method: 'PUT', body: { frequencyMonths: 6, nextDueOn: '2026-12-29', daysToComplete: 14 } });
    expect(calls[1]!.headers['if-match']).toBe(SETTINGS.etag);
    const stale = await adapter.putSettings({ frequencyMonths: 6, nextDueOn: '2026-12-29', daysToComplete: 14 }, 'W/"1"');
    expect(stale.ok ? null : stale.error.status).toBe(412);
  });

  it('lists, starts, reads, decides, applies, completes and cancels; a refusal keeps its rule', async () => {
    const { calls, adapter } = setup({
      'GET /api/v1/admin/access-reviews': json([SUMMARY]),
      'POST /api/v1/admin/access-reviews': [json({ ok: true, changed: [], count: 20, data: { id: ID, reviewNo: 'AR-2026-02' } }, 201), problem(409, 'conflict', { messages: { en: 'An access review is already open', id: 'Sudah dibuka' } })],
      [`GET /api/v1/admin/access-reviews/${ID}`]: json(DETAIL),
      [`POST /api/v1/admin/access-reviews/${ID}/items/${ITEM_ID}/decision`]: problem(422, 'business-rule', { rule: 'REVIEW-OWN-ACCESS', messages: { en: 'You cannot decide on your own access', id: 'Anda tidak dapat' } }),
      [`POST /api/v1/admin/access-reviews/${ID}/items/${ITEM_ID}/apply`]: json({ ok: true, changed: ['isms'], message: ['Applied', 'Diterapkan'], data: { appliedAction: 'role.revoked' } }),
      [`POST /api/v1/admin/access-reviews/${ID}/complete`]: json({ ok: true, changed: ['isms'], warnings: [{ rule: 'REVIEW-SINGLE-ADMIN', messages: { en: 'One reviewer', id: 'Satu peninjau' } }] }),
      [`POST /api/v1/admin/access-reviews/${ID}/cancel`]: json({ ok: true, changed: ['isms'] }),
    });
    const list = await adapter.list();
    expect(list.ok && list.data[0]).toMatchObject({ reviewNo: 'AR-2026-02', progress: { decided: 10 } });
    const created = await adapter.create('key-1');
    expect(created.ok && created.data.data).toEqual({ id: ID, reviewNo: 'AR-2026-02' });
    expect(calls[1]!.headers['idempotency-key']).toBe('key-1');
    const again = await adapter.create('key-2');
    expect(again.ok ? null : again.error.status).toBe(409);
    const detail = await adapter.get(ID);
    expect(detail.ok && detail.data).toMatchObject({
      pendingApplications: [{ id: ITEM_ID, decision: 'revoke', requestedBy: { handle: 'tono' }, approvedBy: { handle: 'rina' } }], warnings: [{ rule: 'REVIEW-SINGLE-ADMIN' }],
      parts: [{ ms: 'isms', noReviewer: false }],
    });
    const own = await adapter.decide(ID, ITEM_ID, { decision: 'keep' });
    expect(own.ok ? null : own.error.rule).toBe('REVIEW-OWN-ACCESS');
    expect(calls[4]!.body).toEqual({ decision: 'keep' });
    const applied = await adapter.apply(ID, ITEM_ID, { action: 'apply' });
    expect(applied.ok && applied.data).toMatchObject({ message: ['Applied', 'Diterapkan'], changed: ['isms'], data: { appliedAction: 'role.revoked' } });
    const done = await adapter.complete(ID);
    expect(done.ok && done.data.warnings).toEqual([{ rule: 'REVIEW-SINGLE-ADMIN', messages: { en: 'One reviewer', id: 'Satu peninjau' } }]);
    expect((await adapter.cancel(ID, 'Started by mistake')).ok).toBe(true);
    expect(calls.at(-1)!.body).toEqual({ reason: 'Started by mistake' });
    const report = await adapter.report({ id: ID, reviewNo: 'AR-2026-02' });
    expect(report.ok && report.data).toEqual({ href: reportHref(ID), fileName: 'access-review-AR-2026-02.csv' });
  });

  it('reads, decides, revokes guest access and signs off a system part; evidence comes from the snapshot refs', async () => {
    const part: AccessReviewPartDetail = { ...PART, rows: [ITEM], suggestedEvidence: { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', code: 'EV-0115' } };
    const evs = [{ code: 'EV-0115', title: 'Quarterly access rights review' }, { code: 'EV-0100', title: 'Policy' }];
    const d = { bundles: { isms: { evs } }, refs: { 'isms:ev:EV-0115': { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e' }, 'isms:ev:EV-0100': { id: '1b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e' } } } as unknown as ControllerData;
    const { calls, adapter } = setup({
      'GET /api/v1/ms/isms/access-reviews': json([PART]),
      [`GET /api/v1/ms/isms/access-reviews/${ID}`]: json(part),
      [`POST /api/v1/ms/isms/access-reviews/${ID}/items/${ITEM_ID}/decision`]: json({ ok: true, changed: ['isms'] }),
      [`POST /api/v1/ms/isms/access-reviews/${ID}/items/${ITEM_ID}/apply`]: json({ ok: true, changed: ['isms'], data: { appliedAction: 'auditor_access.revoked' } }),
      [`POST /api/v1/ms/isms/access-reviews/${ID}/sign-off`]: json({ ok: true, changed: ['isms'], message: ['ISMS signed off', 'ISMS ditandatangani'] }),
    }, () => d);
    const parts = await adapter.msList('isms');
    expect(parts.ok && parts.data[0]).toMatchObject({ reviewNo: 'AR-2026-02', status: 'open' });
    const got = await adapter.msGet('isms', ID);
    expect(got.ok && got.data).toMatchObject({ suggestedEvidence: { code: 'EV-0115' }, rows: [{ id: ITEM_ID }] });
    expect((await adapter.msDecide('isms', ID, ITEM_ID, { decision: 'change', note: 'End on 30 Nov' })).ok).toBe(true);
    expect(calls[2]!.body).toEqual({ decision: 'change', note: 'End on 30 Nov' });
    expect((await adapter.msApply('isms', ID, ITEM_ID, { action: 'apply' })).ok).toBe(true);
    const signed = await adapter.signOff('isms', ID, '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e');
    expect(signed.ok && signed.data.message).toEqual(['ISMS signed off', 'ISMS ditandatangani']);
    expect(calls[4]!.body).toEqual({ evidenceId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e' });
    await adapter.signOff('isms', ID, null);
    expect(calls[5]!.body).toEqual({});
    expect(adapter.evidence('isms').map((e) => e.code)).toEqual(['EV-0100', 'EV-0115']);
  });
});

describe('sample adapter', () => {
  const adapter = () => createSampleAdapter(() => D, () => 'ndt', () => 'rina');

  it('holds an open review and a completed one; rina\'s own organisation items were decided by tono', async () => {
    const list = await adapter().list();
    expect(list.ok && list.data.map((r) => r.status)).toEqual(['open', 'completed']);
    const open = list.ok ? list.data[0]! : null;
    const detail = await adapter().get(open!.id);
    if (!detail.ok) throw new Error('no detail');
    const own = detail.data.organisationPart.rows.filter((r) => r.ownAccess);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r) => r.decision === 'keep' && r.decidedBy?.handle === 'tono')).toBe(true);
    expect(detail.data.organisationPart.rows.some((r) => r.kind === 'linked_sign_in' && r.subject.handle === 'bagus')).toBe(true);
    expect(detail.data.parts.length).toBe(D.MS.length);
    expect(detail.data.parts.every((p) => !p.noReviewer)).toBe(true);
    const roles = ((await adapter().msGet(detail.data.parts[0]!.ms!, open!.id)) as { ok: true; data: { rows: ItemRow[] } }).data.rows.filter((r) => r.kind === 'business_role');
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.every((r) => r.requestedBy !== null && r.requestedBy.handle !== r.subject.handle)).toBe(true);
    expect(roles.filter((r) => r.approvedBy).every((r) => r.approvedBy!.handle !== r.requestedBy!.handle && r.approvedBy!.handle !== r.subject.handle)).toBe(true);
    const settings = await adapter().settings();
    expect(settings.ok && settings.data.frequencyMonths).toBe(3);
  });

  it('refuses a decision on one\'s own access, records others, and applies a revocation', async () => {
    const a = adapter();
    const open = (await a.list()).ok ? ((await a.list()) as { ok: true; data: { id: string }[] }).data[0]!.id : '';
    const detail = await a.get(open);
    if (!detail.ok) throw new Error('no detail');
    const ms = detail.data.parts[0]!.ms!;
    const part = await a.msGet(ms, open);
    if (!part.ok) throw new Error('no part');
    const own = part.data.rows.find((r) => r.ownAccess)!;
    const refused = await a.msDecide(ms, open, own.id, { decision: 'keep' });
    expect(refused.ok ? null : refused.error.rule).toBe('REVIEW-OWN-ACCESS');
    expect(own.needsSecondReviewer).toBe(true);
    const guest = part.data.rows.find((r) => r.kind === 'auditor_access')!;
    expect((await a.msApply(ms, open, guest.id, { action: 'apply' })).ok).toBe(false);
    expect((await a.msDecide(ms, open, guest.id, { decision: 'revoke', note: 'Audit ended' })).ok).toBe(true);
    const revoked = await a.msApply(ms, open, guest.id, { action: 'apply' });
    expect(revoked.ok && revoked.data.data).toEqual({ appliedAction: 'auditor_access.revoked' });
    expect((await a.apply(open, guest.id, { action: 'apply' })).ok).toBe(false);
    const block = await a.signOff(ms, open, null);
    expect(block.ok).toBe(false);
    for (const row of part.data.rows.filter((r) => !r.ownAccess && r.kind !== 'auditor_access')) expect((await a.msDecide(ms, open, row.id, { decision: 'keep' })).ok).toBe(true);
    const signed = await a.signOff(ms, open, a.evidence(ms).find((e) => e.code === part.data.suggestedEvidence?.code)?.id ?? null);
    expect(signed.ok && signed.data.warnings).toEqual([expect.objectContaining({ rule: 'REVIEW-SINGLE-ADMIN' })]);
    expect((await a.msDecide(ms, open, guest.id, { decision: 'keep' })).ok).toBe(false);
  });

  it('completes only when nothing waits, then refuses a second open review only while one is open', async () => {
    const a = adapter();
    const open = ((await a.list()) as { ok: true; data: { id: string }[] }).data[0]!.id;
    const early = await a.complete(open);
    expect(early.ok ? null : early.error.message[0]).toMatch(/^The review cannot be completed yet: Not signed off yet/);
    const detail = (await a.get(open)) as { ok: true; data: ReviewDetail };
    for (const row of detail.data.organisationPart.rows) if (!row.ownAccess && row.decision === null) expect((await a.decide(open, row.id, { decision: 'keep' })).ok).toBe(true);
    for (const p of detail.data.parts) {
      const part = (await a.msGet(p.ms!, open)) as { ok: true; data: { rows: ItemRow[] } };
      for (const row of part.data.rows.filter((r) => !r.ownAccess && r.decision === null)) expect((await a.msDecide(p.ms!, open, row.id, { decision: 'keep' })).ok).toBe(true);
      const own = part.data.rows.filter((r) => r.ownAccess && !r.needsSecondReviewer && r.decision === null);
      if (own.length) expect((await a.signOff(p.ms!, open, null)).ok).toBe(false);
      // The system's own manager decides rina's own roles there.
      const manager = D.MS.find((m) => m.id === p.ms)!.mgr;
      const other = createSampleAdapter(() => D, () => 'ndt', () => manager);
      for (const row of own) expect((await other.msDecide(p.ms!, open, row.id, { decision: 'keep' })).ok).toBe(true);
      expect((await a.signOff(p.ms!, open, null)).ok, p.ms!).toBe(true);
    }
    expect((await a.create('k')).ok).toBe(false);
    const done = await a.complete(open);
    expect(done.ok).toBe(true);
    const report = await a.report({ id: open, reviewNo: 'x' });
    expect(report.ok && report.data.fileName).toMatch(/^access-review-AR-\d{4}-03\.csv$/);
    const started = await a.create('k');
    expect(started.ok && (started.data.data as { reviewNo: string }).reviewNo).toMatch(/^AR-\d{4}-\d{2}$/);
    const cancelled = await a.cancel((started as { ok: true; data: { data: { id: string } } }).data.data.id, 'Test');
    expect(cancelled.ok).toBe(true);
  });

  it('saves the schedule with its ETag and refuses a stale one', async () => {
    const a = adapter();
    const s = (await a.settings()) as { ok: true; data: { etag: string } };
    const saved = await a.putSettings({ frequencyMonths: 6, nextDueOn: '2099-01-01', daysToComplete: 21 }, s.data.etag);
    expect(saved.ok && saved.data).toMatchObject({ frequencyMonths: 6, daysToComplete: 21 });
    expect((await a.putSettings({ frequencyMonths: 6, nextDueOn: '2099-01-01', daysToComplete: 21 }, s.data.etag)).ok).toBe(false);
  });
});

describe('pages and dialogs', () => {
  const row = { ...(ITEM as ItemRow) };
  for (const lang of ['en', 'id'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      it(`render readable in ${lang} and ${theme} without an em dash or centre dot`, () => {
        const ctx = ctxOf(lang);
        const html = [
          render(<ItemsTable ctx={ctx} rows={[row, { ...row, id: 'b', ownAccess: true, decision: null, needsSecondReviewer: true, pendingApproval: true }]} selection={{ selected: new Set(), toggle: () => undefined, can: () => true }} />, ctx, theme),
          render(<DecisionDialog ctx={ctx} rows={[row]} run={async () => ({ ok: true, data: { message: null, warnings: [], changed: [], data: null } })} onClose={() => undefined} onDone={() => undefined} />, ctx, theme),
          render(<ApplyNoteDialog ctx={ctx} row={row} kind="not_applied" run={async () => ({ ok: true, data: { message: null, warnings: [], changed: [], data: null } })} onClose={() => undefined} onDone={() => undefined} />, ctx, theme),
          render(<SettingsDialog ctx={ctx} settings={{ ...SETTINGS }} onClose={() => undefined} onSaved={() => undefined} />, ctx, theme),
        ].join('\n');
        expect(html).not.toMatch(FORBIDDEN);
        expect(html).toContain(lang === 'en' ? 'Needs a second reviewer' : 'Memerlukan peninjau kedua');
        expect(html).toContain(lang === 'en' ? 'Waiting for approval' : 'Menunggu persetujuan');
        expect(html).toContain('Bagus Prasetyo');
        expect(html).toContain(lang === 'en' ? 'Requested by Tono Wibowo' : 'Diminta oleh Tono Wibowo');
        expect(html).toContain(lang === 'en' ? 'Approved by Rina Kusuma' : 'Disetujui oleh Rina Kusuma');
      });
    }
  }
});
