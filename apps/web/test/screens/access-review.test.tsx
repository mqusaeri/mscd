// Access review of this system (MILESTONE-3 M3-07): its routes against the shared table, the definition and its texts,
// the re-exported adapters, and the part page and the sign-off dialog in both languages and themes: the decision
// actions, "Revoke guest access" for a guest grant decided "revoke" (only for holders of `auditor_access.grant`), the
// session's own access left to another reviewer, "Sign off" disabled while items wait, and the A.5.18 evidence item
// proposed in the sign-off.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { createApiAdapter } from '../../src/screens/access-review/api';
import screen from '../../src/screens/access-review/index';
import meta from '../../src/screens/access-review/meta.json';
import { ROUTES, ROUTE_IDS } from '../../src/screens/access-review/routes';
import { createSampleAdapter, resetSampleAccessReviews } from '../../src/screens/access-review/sample';
import { PartPage, SignOffDialog } from '../../src/screens/access-review/Screen';
import { TEXT } from '../../src/screens/access-review/text';
import type { ItemRow, PartDetail } from '../../src/screens/access-reviews/model';
import { TEXT as SHARED } from '../../src/screens/access-reviews/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';

const TODAY = SAMPLE.TODAY_S as string;
const D = { ...makeDates(TODAY), ...(await createSampleDataSource().load()), TODAY_S: TODAY } as unknown as ControllerData;
const FORBIDDEN = /[—·]/;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: D.MS[0], org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'access-review', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}
const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const ROW: ItemRow = {
  id: 'item-guest', kind: 'auditor_access', subject: { handle: 'ext.auditor', displayName: 'Eko Santoso' }, ms: 'isms', role: 'external_auditor', grantedBy: { handle: 'rina', displayName: 'Rina Kusuma' },
  grantedAt: '2026-09-20T02:00:00Z', requestedBy: null, approvedBy: null, validUntil: '2026-10-20', lastSignInAt: null, decision: 'revoke', decisionNote: 'The audit ended', decidedBy: { handle: 'rina', displayName: 'Rina Kusuma' },
  decidedAt: '2026-09-28T02:00:00Z', appliedAt: null, appliedBy: null, appliedAction: null, appliedNote: null, notAppliedReason: null, ownAccess: false, pendingApproval: false,
  needsSecondReviewer: false,
};
const OWN: ItemRow = { ...ROW, id: 'item-own', kind: 'business_role', subject: { handle: 'rina', displayName: 'Rina Kusuma' }, role: 'ms_manager', decision: null, decisionNote: null, decidedBy: null, decidedAt: null, ownAccess: true, needsSecondReviewer: true, validUntil: null };
const PART: PartDetail = {
  id: 'part-isms', reviewId: 'review-1', reviewNo: 'AR-2026-03', reviewStatus: 'open', ms: 'isms', status: 'open', dueOn: '2026-10-08', items: 2, decided: 1, needsSecondReviewer: 1,
  noReviewer: false, signedOffBy: null, signedOffAt: null, evidenceId: null, evidenceCode: null, evidenceFiledAt: null, rows: [ROW, OWN], suggestedEvidence: { id: 'EV-0115', code: 'EV-0115' },
};

afterEach(() => {
  resetSampleAccessReviews();
});

describe('access review of a system: routes and definition', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
      expect(route.scope, name).toBe('ms');
    }
    expect(Object.keys(ROUTES)).toEqual(['msList', 'msGet', 'msDecide', 'msApply', 'signOff']);
  });

  it('is the audit screen of a system of the plan', () => {
    expect(screen).toMatchObject({ id: 'access-review', path: '/ms/:ms/access-review', group: 'audit', scope: 'ms', perm: 'access_review.decide', roles: ['manager'] });
    expect(meta).toMatchObject({ id: 'access-review', label: ['Access review of this system', 'Tinjauan akses sistem ini'], sampleRole: 'manager', scope: 'ms' });
  });

  it('has both languages in every text, without an em dash or a centre dot', () => {
    for (const [name, pair] of Object.entries(TEXT)) {
      expect(pair, name).toHaveLength(2);
      expect(pair[0].trim(), name).not.toBe('');
      expect(pair[1].trim(), name).not.toBe('');
      expect(pair[1], name).not.toBe(pair[0]);
      expect(pair.join(' '), name).not.toMatch(FORBIDDEN);
    }
  });

  it('uses the shared adapters', async () => {
    expect(typeof createApiAdapter(null).msList).toBe('function');
    const sample = createSampleAdapter(() => D, () => 'ndt', () => 'rina');
    const parts = await sample.msList('isms');
    expect(parts.ok && parts.data.map((p) => p.reviewStatus)).toEqual(['open', 'completed']);
    const part = parts.ok ? await sample.msGet('isms', parts.data[0]!.reviewId) : null;
    expect(part?.ok && part.data.suggestedEvidence?.code).toMatch(/^EV-/);
  });
});

describe('part page and sign-off', () => {
  for (const lang of ['en', 'id'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      it(`render readable in ${lang} and ${theme} without an em dash or centre dot`, () => {
        const ctx = ctxOf(lang);
        const page = render(<PartPage ctx={ctx} ms="isms" part={PART} />, ctx, theme);
        const dialog = render(<SignOffDialog ctx={ctx} ms="isms" part={PART} onClose={() => undefined} onDone={() => undefined} />, ctx, theme);
        expect(page + dialog).not.toMatch(FORBIDDEN);
        const t = (pair: readonly [string, string]) => pair[lang === 'id' ? 1 : 0];
        expect(page).toContain(t(TEXT.revokeGuest));
        expect(page).toContain(t(SHARED.needsSecond));
        expect(page).toContain(t(TEXT.signOff));
        expect(dialog).toContain('EV-0115');
      });
    }
  }

  it('offers "Revoke guest access" only to holders of auditor_access.grant and disables "Sign off" while an item waits', () => {
    const programmeOwner = ctxOf('en', { can: (_m, p) => p !== 'auditor_access.grant' });
    expect(render(<PartPage ctx={programmeOwner} ms="isms" part={PART} />, programmeOwner)).not.toContain(TEXT.revokeGuest[0]);
    const ctx = ctxOf('en');
    const waiting = render(<PartPage ctx={ctx} ms="isms" part={{ ...PART, rows: [{ ...ROW, decision: null, decisionNote: null }], decided: 0, needsSecondReviewer: 0 }} />, ctx);
    expect(waiting).toContain(SHARED.blockUndecided[0]);
    const signed = render(<PartPage ctx={ctx} ms="isms" part={{ ...PART, status: 'signed_off', signedOffBy: { handle: 'rina', displayName: 'Rina Kusuma' }, signedOffAt: '2026-10-01T02:00:00Z' }} />, ctx);
    expect(signed).not.toContain(`>${TEXT.signOff[0]}<`);
  });
});
