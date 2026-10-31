// Retention and disposal (MILESTONE-3 M3-06): routes against the shared table and their permissions, the definition, the
// forms and their checks, month arithmetic and dates, who may approve (SOD-SELF-APPROVE), the API adapter over a fake
// fetch (rules, reviews with filters, decisions, approval, rejection, "File removed", the register and its CSV link,
// holds with an Idempotency-Key), the sample adapter per organisation and system (due list, the persona's own proposal,
// holds that hide a review, RET-HOLD and SOD-SELF-APPROVE refusals, the register and its CSV), the detail extensions,
// and the dialogs in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { RetentionHoldItem, RetentionRegisterItem, RetentionReviewItem, RetentionRuleItem } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { detailExtensions } from '../../src/screens/retention/actions';
import { createApiAdapter, fromRegister, registerCsvHref } from '../../src/screens/retention/api';
import { HoldDialog, ReleaseDialog } from '../../src/screens/retention/holds';
import screen from '../../src/screens/retention/index';
import meta from '../../src/screens/retention/meta.json';
import {
  CLASS_TEXT, RECORD_CLASSES, addMonths, decisionBody, decisionErrors, emptyDecision, formatDay, holdErrors, mayApprove, mayManage, mayRead, myHandle, noteError,
  proposedByMe, ruleBody, ruleErrors, ruleFor,
} from '../../src/screens/retention/model';
import type { HoldModel, ReviewModel, RuleModel } from '../../src/screens/retention/model';
import { DecisionDialog, RejectDialog } from '../../src/screens/retention/reviews';
import { RuleDialog } from '../../src/screens/retention/rules';
import { ROUTES, ROUTE_IDS } from '../../src/screens/retention/routes';
import { createSampleAdapter, resetSampleRetention } from '../../src/screens/retention/sample';
import { TABS } from '../../src/screens/retention/Screen';
import { TEXT } from '../../src/screens/retention/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';

const TODAY = SAMPLE.TODAY_S as string;
const D = { ...makeDates(TODAY), ...(await createSampleDataSource().load()), TODAY_S: TODAY } as unknown as ControllerData;
const FORBIDDEN = /[—·]/;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: D.MS[0], org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'retention', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}
const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const REVIEW: RetentionReviewItem = {
  id: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a', recordClass: 'evidence_file', itemId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b', itemCode: 'EV-0313 v2', itemTitle: 'Backup job log',
  retentionEndsOn: '2026-09-15', status: 'awaiting_approval', decision: 'dispose', decidedBy: { handle: 'rina', displayName: 'Rina Kusuma' }, decidedAt: '2026-09-29T02:00:00Z',
  reason: 'Replaced by later logs', keepUntil: null, approvedBy: null, approvedAt: null, rejectedNote: null, disposedAt: null, fileAction: null, fileRemovedAt: null, onHold: false,
};
const RULE: RetentionRuleItem = { recordClass: 'document_version', docType: 'policy', docTypeLabel: ['Policy', 'Kebijakan'], retainMonths: 36, source: 'default', basis: null };
const HOLD: RetentionHoldItem = {
  id: '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c', recordClass: 'finding', itemId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', itemCode: 'NC-2025-01', reason: 'Legal claim',
  setBy: { handle: 'rina', displayName: 'Rina Kusuma' }, setAt: '2026-09-01T02:00:00Z', releasedBy: null, releasedAt: null, releaseReason: null,
};

afterEach(() => {
  resetSampleRetention();
});

describe('retention routes and definition', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    for (const id of ['putRule', 'decide', 'fileRemoved', 'createHold', 'releaseHold'] as const) expect(routeById(ROUTE_IDS[id]).permission, id).toBe('retention.manage');
    for (const id of ['approve', 'reject'] as const) expect(routeById(ROUTE_IDS[id]).permission, id).toBe('retention.approve');
    for (const id of ['rules', 'reviews', 'register', 'holds'] as const) {
      expect(routeById(ROUTE_IDS[id]).anyOf?.map((c) => c.permission), id).toEqual(['retention.manage', 'retention.approve']);
    }
  });

  it('is the implementation screen of the plan with its five tabs', () => {
    expect(screen).toMatchObject({ id: 'retention', path: '/ms/:ms/retention', group: 'impl', scope: 'ms', perm: ['retention.manage', 'retention.approve'] });
    expect(meta).toMatchObject({ id: 'retention', label: ['Retention and disposal', 'Retensi dan pemusnahan'], sampleRole: 'manager' });
    expect(TABS).toEqual(['rules', 'due', 'approval', 'holds', 'register']);
  });

  it('has both languages in every text, without an em dash or a centre dot', () => {
    for (const [name, pair] of Object.entries(TEXT)) {
      expect(pair, name).toHaveLength(2);
      expect(pair[0].trim(), name).not.toBe('');
      expect(pair[1].trim(), name).not.toBe('');
      expect(pair.join(' '), name).not.toMatch(FORBIDDEN);
    }
    for (const c of RECORD_CLASSES) expect(CLASS_TEXT[c][1]).not.toBe(CLASS_TEXT[c][0]);
  });
});

describe('model', () => {
  it('checks the rule form and builds its body; a reset sends no period', () => {
    expect(ruleErrors({ months: '0', basis: '' }, false)).toEqual({ months: TEXT.badMonths, basis: TEXT.badBasis });
    expect(ruleErrors({ months: '1201', basis: 'x' }, false)).toEqual({ months: TEXT.badMonths });
    expect(ruleErrors({ months: '', basis: 'Back to the default' }, true)).toEqual({});
    expect(ruleBody({ recordClass: 'document_version', docType: 'policy' }, { months: '84', basis: ' Tax law ' }, false)).toEqual({ docType: 'policy', retainMonths: 84, basis: 'Tax law' });
    expect(ruleBody({ recordClass: 'finding', docType: null }, { months: '84', basis: 'Back' }, true)).toEqual({ retainMonths: null, basis: 'Back' });
  });

  it('checks the decision form: a decision, a date after today, whole months, a reason', () => {
    expect(decisionErrors(emptyDecision(), '2026-09-29')).toEqual({ decision: TEXT.badDecision, reason: TEXT.badReason });
    expect(decisionErrors({ decision: 'keep', keepUntil: '2026-09-29', months: '', reason: 'x' }, '2026-09-29')).toEqual({ keepUntil: TEXT.badKeepUntil });
    expect(decisionErrors({ decision: 'extend', keepUntil: '', months: '0', reason: 'x' }, '2026-09-29')).toEqual({ months: TEXT.badMonths });
    expect(decisionErrors({ decision: 'dispose', keepUntil: '', months: '', reason: 'Period over' }, '2026-09-29')).toEqual({});
    expect(decisionBody(['a'], { decision: 'keep', keepUntil: '2027-01-31', months: '12', reason: ' Audit ' })).toEqual({ ids: ['a'], decision: 'keep', reason: 'Audit', keepUntil: '2027-01-31' });
    expect(decisionBody(['a', 'b'], { decision: 'extend', keepUntil: '', months: '6', reason: 'Dispute' })).toEqual({ ids: ['a', 'b'], decision: 'extend', reason: 'Dispute', extendMonths: 6 });
    expect(decisionBody(['a'], { decision: 'dispose', keepUntil: '2027-01-31', months: '6', reason: 'Over' })).toEqual({ ids: ['a'], decision: 'dispose', reason: 'Over' });
  });

  it('checks the hold form and notes', () => {
    expect(holdErrors({ recordClass: '', code: '', reason: '' }, false)).toEqual({ recordClass: TEXT.badClass, code: TEXT.badCode, reason: TEXT.badReason });
    expect(holdErrors({ recordClass: '', code: '', reason: 'Claim' }, true)).toEqual({});
    expect(noteError('', 500)).toBe(TEXT.badReason);
    expect(noteError('x'.repeat(501), 500)).toBe(TEXT.tooLong500);
    expect(noteError('Settled', 500)).toBeNull();
  });

  it('adds months as the server does and formats dates in both languages', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-06-15', 3)).toBe('2026-09-15');
    expect(addMonths('2026-11-30', 36)).toBe('2029-11-30');
    expect(formatDay('2026-09-15', 'en')).toMatch(/15 Sept? 2026/);
    expect(formatDay('2026-09-15', 'id')).toMatch(/15 Sep 2026/);
    expect(formatDay(null, 'en')).toBe('-');
  });

  it('knows who may manage, approve and read, and who proposed a disposal', () => {
    const approver = ctxOf('en', { can: (_m, p) => p === 'retention.approve' || (Array.isArray(p) && p.includes('retention.approve')) });
    expect([mayManage(approver, 'isms'), mayApprove(approver, 'isms'), mayRead(approver, 'isms')]).toEqual([false, true, true]);
    expect(mayRead(ctxOf('en', { can: () => false }), 'isms')).toBe(false);
    expect(mayManage(ctxOf('en'), null)).toBe(false);
    const rina = ctxOf('en');
    expect(myHandle(rina)).toBe('rina');
    expect(proposedByMe(rina, { decidedBy: { handle: 'rina', displayName: 'Rina' } })).toBe(true);
    expect(proposedByMe(rina, { decidedBy: { handle: 'sari', displayName: 'Sari' } })).toBe(false);
    expect(myHandle(ctxOf('en', { me: { user: { handle: 'sari' } } as never }))).toBe('sari');
  });

  it('finds the rule of a class and document type', () => {
    const rules: RuleModel[] = [
      { recordClass: 'document_version', docType: 'policy', docTypeLabel: ['Policy', 'Kebijakan'], retainMonths: 60, source: 'set', basis: 'x' },
      { recordClass: 'evidence_file', docType: null, docTypeLabel: null, retainMonths: 36, source: 'default', basis: null },
    ];
    expect(ruleFor(rules, 'document_version', 'policy')?.retainMonths).toBe(60);
    expect(ruleFor(rules, 'evidence_file')?.retainMonths).toBe(36);
    expect(ruleFor(rules, 'finding')).toBeNull();
  });
});

describe('API adapter', () => {
  function setup(routes: Parameters<typeof fakeFetch>[0]) {
    const f = fakeFetch(routes);
    const client = new ApiClient({ fetch: f.fetch, lang: 'en' });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    return { calls: f.calls, adapter: createApiAdapter(client) };
  }

  it('reads and sets rules and pages the reviews with their filters', async () => {
    const { calls, adapter } = setup({
      'GET /api/v1/ms/qms/retention/rules': json([RULE]),
      'PUT /api/v1/ms/qms/retention/rules/document_version': json({ ok: true, changed: ['qms'] }),
      'GET /api/v1/ms/qms/retention/reviews': json({ items: [REVIEW], page: 1, pageSize: 50, total: 1 }),
    });
    const rules = await adapter.rules('qms');
    expect(rules.ok && rules.data[0]).toMatchObject({ docType: 'policy', docTypeLabel: ['Policy', 'Kebijakan'], source: 'default' });
    expect((await adapter.putRule('qms', 'document_version', { docType: 'policy', retainMonths: 84, basis: 'Tax law' })).ok).toBe(true);
    expect(calls[1]).toMatchObject({ method: 'PUT', body: { docType: 'policy', retainMonths: 84, basis: 'Tax law' } });
    expect(calls[1]!.headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    const page = await adapter.reviews('qms', { status: 'awaiting_approval', recordClass: 'evidence_file', code: 'EV-0313', page: 2, pageSize: 50 });
    expect(page.ok && page.data).toMatchObject({ total: 1, items: [{ itemCode: 'EV-0313 v2', decidedBy: { handle: 'rina' } }] });
    expect(calls[2]!.url).toContain('status=awaiting_approval');
    expect(calls[2]!.url).toContain('recordClass=evidence_file');
    expect(calls[2]!.url).toContain('code=EV-0313');
    expect(calls[2]!.url).toContain('page=2');
  });

  it('decides, approves, rejects and records a removed file; a refusal keeps its rule and message', async () => {
    const { calls, adapter } = setup({
      'POST /api/v1/ms/qms/retention/reviews/decide': [
        json({ ok: true, changed: ['qms'], count: 1, message: ['1 disposal(s) sent for approval', '1 pemusnahan dikirim untuk persetujuan'] }),
        problem(422, 'business-rule', { rule: 'RET-HOLD', messages: { en: 'EV-0313 v2 is under a legal hold', id: 'EV-0313 v2 ditahan' } }),
      ],
      'POST /api/v1/ms/qms/retention/reviews/4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a/approve': problem(422, 'business-rule', { rule: 'SOD-SELF-APPROVE', messages: { en: 'You cannot approve', id: 'Anda tidak dapat' } }),
      'POST /api/v1/ms/qms/retention/reviews/4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a/reject': json({ ok: true, changed: ['qms'] }),
      'POST /api/v1/ms/qms/retention/reviews/4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a/file-removed': json({ ok: true, changed: ['qms'] }),
    });
    const decided = await adapter.decide('qms', { ids: [REVIEW.id], decision: 'dispose', reason: 'Over' });
    expect(decided.ok && decided.data.message).toEqual(['1 disposal(s) sent for approval', '1 pemusnahan dikirim untuk persetujuan']);
    expect(calls[0]).toMatchObject({ body: { ids: [REVIEW.id], decision: 'dispose', reason: 'Over' } });
    const refused = await adapter.decide('qms', { ids: [REVIEW.id], decision: 'dispose', reason: 'Over' });
    expect(refused.ok ? null : [refused.error.rule, refused.error.message[0]]).toEqual(['RET-HOLD', 'EV-0313 v2 is under a legal hold']);
    const self = await adapter.approve('qms', { ...REVIEW } as ReviewModel);
    expect(self.ok ? null : self.error.rule).toBe('SOD-SELF-APPROVE');
    expect((await adapter.reject('qms', { ...REVIEW } as ReviewModel, 'Keep it')).ok).toBe(true);
    expect(calls[3]).toMatchObject({ body: { note: 'Keep it' } });
    expect((await adapter.fileRemoved('qms', fromRegister({ ...REVIEW, status: 'disposed', retainMonths: 36 } as RetentionRegisterItem))).ok).toBe(true);
  });

  it('pages the register, links its CSV and keeps holds with an Idempotency-Key', async () => {
    const { calls, adapter } = setup({
      'GET /api/v1/ms/qms/retention/register': json({ items: [{ ...REVIEW, status: 'disposed', approvedBy: { handle: 'sari', displayName: 'Sari' }, disposedAt: '2026-09-30T02:00:00Z', fileAction: 'owner_asked', retainMonths: 36 }], page: 1, pageSize: 50, total: 1 }),
      'GET /api/v1/ms/qms/retention/holds': json([HOLD]),
      'POST /api/v1/ms/qms/retention/holds': json({ ok: true, changed: ['qms'] }, 201),
      'POST /api/v1/ms/qms/retention/holds/6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c/release': json({ ok: true, changed: ['qms'] }),
    });
    const register = await adapter.register('qms', 1, 50);
    expect(register.ok && register.data.items[0]).toMatchObject({ retainMonths: 36, fileAction: 'owner_asked' });
    expect(register.ok && 'onHold' in register.data.items[0]!).toBe(false);
    const csv = await adapter.exportCsv('qms');
    expect(csv.ok && csv.data.href).toBe(registerCsvHref('qms'));
    expect(registerCsvHref('qms')).toBe('/api/v1/ms/qms/retention/register?format=csv');
    const holds = await adapter.holds('qms');
    expect(holds.ok && holds.data[0]).toMatchObject({ itemCode: 'NC-2025-01', releasedAt: null });
    expect((await adapter.createHold('qms', { recordClass: 'finding', itemCode: 'NC-2025-01', reason: 'Claim' }, 'idem-3')).ok).toBe(true);
    expect(calls[2]!.headers['idempotency-key']).toBe('idem-3');
    expect(calls[2]).toMatchObject({ body: { recordClass: 'finding', itemCode: 'NC-2025-01', reason: 'Claim' } });
    expect((await adapter.releaseHold('qms', holds.ok ? (holds.data[0] as HoldModel) : (null as never), 'Settled')).ok).toBe(true);
    expect(calls[3]).toMatchObject({ body: { reason: 'Settled' } });
  });
});

describe('sample adapter', () => {
  const sampleOf = (org = 'ndt', me = 'rina') => createSampleAdapter(() => D, () => org, () => me);

  it('starts with records due for review, two disposals awaiting approval, holds and a register, per organisation', async () => {
    const a = sampleOf();
    const due = await a.reviews('isms', { status: 'open', page: 1, pageSize: 50 });
    expect(due.ok && due.data.total).toBeGreaterThanOrEqual(4);
    expect(due.ok && due.data.items.every((r) => r.status === 'open' && !r.onHold)).toBe(true);
    expect(due.ok && due.data.items.map((r) => r.recordClass)).toEqual(expect.arrayContaining(['document_version', 'evidence_file', 'finding']));
    const awaiting = await a.reviews('isms', { status: 'awaiting_approval', page: 1, pageSize: 50 });
    expect(awaiting.ok && awaiting.data.items.map((r) => r.decidedBy?.handle).sort()).toEqual(['rina', 'sari']);
    const holds = await a.holds('isms');
    expect(holds.ok && holds.data.map((h) => Boolean(h.releasedAt))).toEqual([false, true]);
    const register = await a.register('isms', 1, 50);
    expect(register.ok && register.data.items.map((r) => r.status).sort()).toEqual(['disposed', 'disposed', 'kept']);
    const rules = await a.rules('isms');
    expect(rules.ok && rules.data.filter((r) => r.recordClass === 'document_version').map((r) => r.docType)).toEqual(['policy', 'standard', 'procedure', 'plan', 'register', 'record', 'form']);
    expect(rules.ok && rules.data.every((r) => r.retainMonths === 36 && r.source === 'default')).toBe(true);
    // Another organisation keeps its own state.
    await a.putRule('isms', 'finding', { retainMonths: 60, basis: 'Contract' });
    const other = await sampleOf('rmn').rules('isms');
    expect(other.ok && other.data.find((r) => r.recordClass === 'finding')?.source).toBe('default');
    const mine = await a.rules('isms');
    expect(mine.ok && mine.data.find((r) => r.recordClass === 'finding')).toMatchObject({ retainMonths: 60, source: 'set', basis: 'Contract' });
  });

  it('proposes a disposal, refuses the proposer and lets another person approve; rejects with a note', async () => {
    const rina = sampleOf();
    const due = await rina.reviews('isms', { status: 'open', page: 1, pageSize: 50 });
    const first = due.ok ? due.data.items[0]! : (null as never);
    expect((await rina.decide('isms', { ids: [first.id], decision: 'dispose', reason: 'Period over' })).ok).toBe(true);
    const self = await rina.approve('isms', { ...first, status: 'awaiting_approval' });
    expect(self.ok ? null : self.error.rule).toBe('SOD-SELF-APPROVE');
    const sari = sampleOf('ndt', 'sari');
    expect((await sari.approve('isms', first)).ok).toBe(true);
    const register = await rina.register('isms', 1, 50);
    expect(register.ok && register.data.items[0]).toMatchObject({ id: first.id, status: 'disposed', approvedBy: { handle: 'sari' } });
    const awaiting = await rina.reviews('isms', { status: 'awaiting_approval', page: 1, pageSize: 50 });
    const theirs = awaiting.ok ? awaiting.data.items.find((r) => r.decidedBy?.handle === 'sari')! : (null as never);
    expect((await rina.reject('isms', theirs, 'Keep until the audit')).ok).toBe(true);
    const back = await rina.reviews('isms', { status: 'open', page: 1, pageSize: 50 });
    expect(back.ok && back.data.items.find((r) => r.id === theirs.id)).toMatchObject({ rejectedNote: 'Keep until the audit' });
  });

  it('keeps and extends, hides a held record from the list and refuses its disposal with RET-HOLD', async () => {
    const a = sampleOf();
    const due = await a.reviews('isms', { status: 'open', page: 1, pageSize: 50 });
    const [one, two] = due.ok ? due.data.items : [];
    expect((await a.decide('isms', { ids: [one!.id], decision: 'keep', reason: 'Audit', keepUntil: '2027-06-30' })).ok).toBe(true);
    expect((await a.decide('isms', { ids: [one!.id], decision: 'keep', reason: 'Again', keepUntil: '2027-06-30' })).ok).toBe(false);
    expect((await a.createHold('isms', { recordClass: two!.recordClass, itemId: two!.itemId, reason: 'Claim' }, 'k')).ok).toBe(true);
    const after = await a.reviews('isms', { status: 'open', page: 1, pageSize: 50 });
    expect(after.ok && after.data.items.map((r) => r.id)).not.toContain(two!.id);
    const refused = await a.decide('isms', { ids: [two!.id], decision: 'dispose', reason: 'Over' });
    expect(refused.ok ? null : refused.error.rule).toBe('RET-HOLD');
    const again = await a.createHold('isms', { recordClass: two!.recordClass, itemId: two!.itemId, reason: 'Claim' }, 'k2');
    expect(again.ok ? null : again.error.status).toBe(409);
    const holds = await a.holds('isms');
    const held = holds.ok ? holds.data.find((h) => h.itemId === two!.itemId)! : (null as never);
    expect((await a.releaseHold('isms', held, 'Settled')).ok).toBe(true);
    const register = await a.register('isms', 1, 50);
    expect(register.ok && register.data.items.some((r) => r.id === one!.id && r.status === 'kept' && r.keepUntil === '2027-06-30')).toBe(true);
  });

  it('records a removed file once and builds the register CSV', async () => {
    const a = sampleOf();
    const register = await a.register('isms', 1, 50);
    const asked = register.ok ? register.data.items.find((r) => r.fileAction === 'owner_asked')! : (null as never);
    expect((await a.fileRemoved('isms', asked)).ok).toBe(true);
    expect((await a.fileRemoved('isms', asked)).ok).toBe(false);
    const csv = await a.exportCsv('isms');
    expect(csv.ok && csv.data.fileName).toMatch(/^disposal-register-isms-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe('detail extensions', () => {
  it('extend documents and evidence for readers of retention only', () => {
    expect(detailExtensions!.map((e) => [e.id, e.kind])).toEqual([['retention.doc', 'doc'], ['retention.ev', 'ev']]);
    const props = { kind: 'doc' as const, ms: 'isms', recordKey: null, record: {}, close: () => undefined };
    expect(detailExtensions![0]!.visible!(ctxOf('en'), props)).toBe(true);
    expect(detailExtensions![0]!.visible!(ctxOf('en', { can: () => false }), props)).toBe(false);
  });
});

describe('dialogs in both languages and themes', () => {
  const review = { ...REVIEW, status: 'open', decision: null } as ReviewModel;
  const rule: RuleModel = { recordClass: 'document_version', docType: 'policy', docTypeLabel: ['Policy', 'Kebijakan'], retainMonths: 36, source: 'default', basis: null };

  for (const lang of ['en', 'id'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      it(`renders the forms in ${lang}, ${theme}`, () => {
        const ctx = ctxOf(lang, { theme });
        const pick = (pair: readonly [string, string]) => pair[lang === 'id' ? 1 : 0];
        const decision = render(<DecisionDialog ctx={ctx} ms="isms" reviews={[review]} onClose={() => undefined} onDecided={() => undefined} />, ctx, theme);
        expect(decision).toContain(pick(TEXT.dKeep));
        expect(decision).toContain(pick(TEXT.dDispose));
        expect(decision).toContain('EV-0313 v2');
        const reject = render(<RejectDialog ctx={ctx} ms="isms" review={review} onClose={() => undefined} onRejected={() => undefined} />, ctx, theme);
        expect(reject).toContain(pick(TEXT.fNote));
        const hold = render(<HoldDialog ctx={ctx} ms="isms" item={null} onClose={() => undefined} onHeld={() => undefined} />, ctx, theme);
        expect(hold).toContain(pick(TEXT.fCode));
        const holdOf = render(<HoldDialog ctx={ctx} ms="isms" item={review} onClose={() => undefined} onHeld={() => undefined} />, ctx, theme);
        expect(holdOf).toContain('EV-0313 v2');
        expect(holdOf).not.toContain(pick(TEXT.fCode));
        const release = render(<ReleaseDialog ctx={ctx} ms="isms" hold={HOLD as HoldModel} onClose={() => undefined} onReleased={() => undefined} />, ctx, theme);
        expect(release).toContain('NC-2025-01');
        const edit = render(<RuleDialog ctx={ctx} ms="isms" rule={rule} reset={false} onClose={() => undefined} onSaved={() => undefined} />, ctx, theme);
        expect(edit).toContain(pick(TEXT.fMonths));
        const reset = render(<RuleDialog ctx={ctx} ms="isms" rule={{ ...rule, source: 'set', retainMonths: 60 }} reset onClose={() => undefined} onSaved={() => undefined} />, ctx, theme);
        expect(reset).not.toContain(pick(TEXT.fMonths));
        expect(reset).toContain(pick(TEXT.resetText));
        for (const html of [decision, reject, hold, release, edit, reset]) expect(html).not.toMatch(FORBIDDEN);
      });
    }
  }
});
