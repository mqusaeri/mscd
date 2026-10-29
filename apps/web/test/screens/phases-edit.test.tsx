// The activity forms (MILESTONE-2 M2-11): the route against the shared table, the gate items and the BR-46 count from
// the snapshot, the checks of Record blocker, the api adapter over a fake fetch (start and block with If-Match and the
// CSRF token, BR-12 and BR-39 refusals kept), the sample adapter, the panel and the form in both languages and themes,
// and the claim of "Record blocker".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import type { Activity, ControllerData, DataSource, Phase } from '../../src/data/types';
import { claims, detailExtensions, layerItems, recordBlocker } from '../../src/screens/phases-edit/actions';
import { adapterFor } from '../../src/screens/phases-edit/adapter';
import { createApiAdapter } from '../../src/screens/phases-edit/api';
import { ActivityPanel, BlockerDialog, activityRefOf, mayWorkOn } from '../../src/screens/phases-edit/forms';
import { blockBody, checkBlocker, gateChoices, gateConsistency, phaseOfActivity, startBody } from '../../src/screens/phases-edit/model';
import { ROUTES, ROUTE_IDS } from '../../src/screens/phases-edit/routes';
import { createSampleAdapter } from '../../src/screens/phases-edit/sample';
import { blockerRequest, requestBlocker } from '../../src/screens/phases-edit/store';
import { TEXT } from '../../src/screens/phases-edit/text';
import { fakeFetch, json, problem } from '../auth/helpers';
import { FORBIDDEN, apiCtxOf, ctxOf, pairProblems, render, sampleWorld } from './m2-11-fixtures';

const CSRF = 'csrf-token-0123456789abcdef';
const UUID = '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const ETAG = 'W/"1790000000000"';

let D: ControllerData;
let ds: DataSource;
beforeEach(async () => {
  ({ D, ds } = await sampleWorld());
});
afterEach(() => requestBlocker(null));

const phases = (ms = 'isms') => D.bundles[ms].phases as Phase[];
const acts = (ms = 'isms') => phases(ms).flatMap((p) => p.acts);
const act = (no: string, ms = 'isms') => acts(ms).find((a) => a.no === no)!;

describe('phases-edit route and texts', () => {
  it('match the shared route table', () => {
    const route = routeById(ROUTE_IDS.transition);
    expect([route.method, route.path]).toEqual([...ROUTES.transition]);
    expect(route.ifMatch).toBe(true);
    expect(route.machine).toBe('implementation_activity_progress.status');
  });

  it('has every text in both languages without an em dash or a centre dot', () => {
    expect(pairProblems(TEXT)).toEqual([]);
    // The sample build keeps the Milestone 1 toast word for word (static.js `toastBlocker`), with the M2-17 term.
    expect(TEXT.sampleBlockerToast).toEqual(['Blocker recorded and linked to the checkpoint item', 'Blokir dicatat dan ditautkan ke item checkpoint']);
  });
});

describe('phases-edit model', () => {
  it('lists the gate items of the snapshot with the activities they block', () => {
    const gates = gateChoices(D, 'isms');
    expect(gates.map((g) => g.id)).toEqual((D.bundles.isms.gates).map((g) => g.id));
    const blocked = acts().filter((a) => a.st === 'blocked');
    for (const a of blocked) expect(gates.find((g) => g.id === a.blocker)?.blocks).toContain(a.no);
  });

  it('counts blocked activities against open gate items for BR-46', () => {
    const gate = phases().find((p) => p.gate && p.c.verified < p.total)!;
    const count = gateConsistency(D, 'isms');
    expect(count).toEqual({ phase: gate.no, blocked: gate.acts.filter((a) => a.st === 'blocked').length, open: D.bundles.isms.gates.length });
    const later = acts().find((a) => a.pno > gate.no)!;
    expect(phaseOfActivity(D, 'isms', later)?.no).toBe(later.pno);
  });

  it('checks Record blocker and builds the transition bodies', () => {
    expect(checkBlocker('', ' ')).toEqual({ gate: TEXT.gateRequired, reason: TEXT.reasonRequired });
    expect(checkBlocker('A.8.12', 'Risk owner has not approved')).toEqual({});
    expect(checkBlocker('A.8.12', 'x'.repeat(1001))).toEqual({ reason: TEXT.reasonRequired });
    expect(startBody()).toEqual({ to: 'in_progress' });
    expect(blockBody(' A.8.12 ', ' Waiting ')).toEqual({ to: 'blocked', blockerGateItemRef: 'A.8.12', blockerReason: 'Waiting' });
  });
});

describe('phases-edit adapters', () => {
  const ref = { ms: 'isms', key: 'isms:act:4.10', no: '4.10', uuid: UUID, etag: ETAG };

  it('starts and blocks with If-Match and the CSRF token, and keeps BR-12 and BR-39 refusals', async () => {
    const f = fakeFetch({
      [`POST /api/v1/ms/isms/activities/${UUID}/transitions`]: [
        json({ ok: true, changed: ['isms'] }),
        json({ ok: true, changed: ['isms'] }),
        problem(422, 'business-rule', { rule: 'BR-12', messages: { en: 'This activity stays locked until every activity of critical checkpoint phase 4 is verified.', id: 'Terkunci.' } }),
        problem(422, 'business-rule', { rule: 'BR-39', messages: { en: 'State what is holding this activity and which checkpoint item causes it.', id: 'Sebutkan.' } }),
      ],
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken(CSRF);
    const a = createApiAdapter(client);
    expect(await a.start(ref)).toEqual({ ok: true, data: { changed: ['isms'], warnings: [] } });
    expect(f.calls[0]).toMatchObject({ method: 'POST', body: { to: 'in_progress' } });
    expect(f.calls[0]!.headers).toMatchObject({ 'if-match': ETAG, 'x-csrf-token': CSRF });
    await a.block(ref, 'A.8.12', 'Risk owner has not approved');
    expect(f.calls[1]!.body).toEqual({ to: 'blocked', blockerGateItemRef: 'A.8.12', blockerReason: 'Risk owner has not approved' });
    expect(await a.start(ref)).toMatchObject({ ok: false, error: { rule: 'BR-12' } });
    expect(await a.block(ref, 'X-1', 'Something')).toMatchObject({ ok: false, error: { rule: 'BR-39' } });
    expect(await a.start({ ...ref, uuid: null })).toMatchObject({ ok: false, error: { status: 404, message: TEXT.notFound } });
    expect(f.calls).toHaveLength(4);
  });

  it('reads the activity ref of the snapshot', () => {
    const a = acts()[0]!;
    const withRefs = { ...D, refs: { [a.key]: { module: 'implementation', entityType: 'implementation_activity_progress', id: UUID, code: a.no, etag: ETAG } } } as unknown as ControllerData;
    expect(activityRefOf({ D: withRefs }, 'isms', a)).toEqual({ ms: 'isms', key: a.key, no: a.no, uuid: UUID, etag: ETAG });
  });

  it('answers in the sample build that activities keep their status, and acknowledges a blocker', async () => {
    const a = createSampleAdapter(ds);
    const blocker = vi.spyOn(ds, 'recordBlocker');
    const one = acts().find((x) => x.st === 'progress' || x.st === 'ns')!;
    const ref2 = { ms: 'isms', key: one.key, no: one.no, uuid: null, etag: null };
    expect(await a.start(ref2)).toMatchObject({ ok: false, error: { message: TEXT.sampleStart } });
    expect(await a.block(ref2, 'A.8.12', 'Waiting')).toMatchObject({ ok: true });
    expect(blocker).toHaveBeenCalledWith(one.key, 'A.8.12', 'Waiting');
    expect((await adapterFor({ client: null, ds, D }).start(ref2)).ok).toBe(false);
    expect((await adapterFor({ client: null, ds: null, D }).block(ref2, 'A', 'B')).ok).toBe(false);
  });
});

describe('phases-edit panel and form', () => {
  it('offers Start on a not started activity, disabled with its reason in the sample build', () => {
    const notStarted = acts().find((a) => a.st === 'ns')!;
    expect(notStarted).toBeDefined();
    for (const lang of ['en', 'id'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = ctxOf(D, lang, { ds });
        const html = render(<ActivityPanel ctx={ctx} kind="activity" ms="isms" recordKey={notStarted.key} record={notStarted} close={() => undefined} />, ctx, theme);
        expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${lang === 'en' ? 'Start' : 'Mulai'}</button>`));
        expect(html).toContain(TEXT.sampleStart[lang === 'en' ? 0 : 1]);
        expect(html).not.toMatch(FORBIDDEN);
      }
    }
    const api = apiCtxOf(D, 'isms', ['activity.transition'], ['ms_manager']);
    const html = render(<ActivityPanel ctx={api} kind="activity" ms="isms" recordKey={notStarted.key} record={notStarted} close={() => undefined} />, api);
    expect(html).toMatch(/<button[^>]*>Start<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Start/);
    expect(html).toContain(TEXT.startHint[0]);
  });

  it('shows no panel for a started activity or for someone else’s activity with an own grant', () => {
    const ctx = ctxOf(D);
    const started = acts().find((a) => a.st === 'verified')!;
    expect(render(<ActivityPanel ctx={ctx} kind="activity" ms="isms" recordKey="k" record={started} close={() => undefined} />, ctx)).not.toContain('mx-m11-panel');
    const notStarted = acts().find((a) => a.st === 'ns')!;
    const owner = apiCtxOf(D, 'isms', ['activity.transition'], ['domain_owner'], 'en', { person: { handle: 'nobody', name: 'Nobody', jobTitle: '-' } });
    expect(render(<ActivityPanel ctx={owner} kind="activity" ms="isms" recordKey="k" record={notStarted} close={() => undefined} />, owner)).not.toContain('mx-m11-panel');
    const own = apiCtxOf(D, 'isms', ['activity.transition'], ['domain_owner'], 'en', { person: { handle: notStarted.owner, name: 'Owner', jobTitle: '-' } });
    expect(mayWorkOn(own, 'isms', notStarted)).toBe(true);
    expect(render(<ActivityPanel ctx={own} kind="activity" ms="isms" recordKey="k" record={notStarted} close={() => undefined} />, own)).toContain('mx-m11-panel');
  });

  it('renders Record blocker with the gate items and the BR-46 count in both languages and themes', () => {
    const a = act('9.4');
    for (const lang of ['en', 'id'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = ctxOf(D, lang, { ds });
        const html = render(<BlockerDialog ctx={ctx} ms="isms" activity={a} onClose={() => undefined} />, ctx, theme);
        expect(html).toContain(lang === 'en' ? 'Record blocker for 9.4' : 'Catat blokir untuk 9.4');
        for (const g of D.bundles.isms.gates) expect(html).toContain(g.id);
        expect(html).toContain(lang === 'en' ? 'Checkpoint phase 4:' : 'Fase checkpoint 4:');
        expect(html).not.toMatch(FORBIDDEN);
      }
    }
  });

  it('says so when the system has no open gate item', () => {
    const empty = { ...D, bundles: { ...D.bundles, isms: { ...D.bundles.isms, gates: [] } } } as unknown as ControllerData;
    const ctx = ctxOf(empty);
    const html = render(<BlockerDialog ctx={ctx} ms="isms" activity={act('9.4')} onClose={() => undefined} />, ctx);
    expect(html).toContain(TEXT.noGateItems[0]);
    expect(html).not.toContain('Record blocker</button>');
  });
});

describe('phases-edit claim and extensions', () => {
  const record = (): Activity => act('9.4');

  it('keeps the Milestone 1 toast of Record blocker in the sample build', () => {
    const ctx = ctxOf(D);
    recordBlocker(ctx, { ms: 'isms', key: record().key, record: record() });
    expect(ctx.toast).toHaveBeenCalledWith('Blocker recorded and linked to the checkpoint item');
    expect(blockerRequest()).toBeNull();
  });

  it('opens Record blocker in API builds for the MS Manager or the owner, and refuses others', () => {
    const manager = apiCtxOf(D, 'isms', ['activity.transition', 'activity.verify'], ['ms_manager']);
    claims!['phases.recordBlocker']!(manager, { ms: 'isms', key: record().key, record: record() });
    expect(blockerRequest()).toMatchObject({ ms: 'isms', activity: { no: '9.4' } });
    requestBlocker(null);
    const stranger = apiCtxOf(D, 'isms', ['activity.transition'], ['domain_owner'], 'en', { person: { handle: 'nobody', name: 'Nobody', jobTitle: '-' } });
    recordBlocker(stranger, { ms: 'isms', key: record().key, record: record() });
    expect(stranger.toast).toHaveBeenCalledWith(TEXT.noPermission[0]);
    expect(blockerRequest()).toBeNull();
  });

  it('registers the activity panel and the form layer', () => {
    expect(detailExtensions!.map((x) => [x.id, x.kind])).toEqual([['phases-edit.activity', 'activity']]);
    expect(layerItems!.map((x) => x.id)).toEqual(['phases-edit.blocker']);
  });
});
