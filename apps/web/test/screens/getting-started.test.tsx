// Getting started (MILESTONE-2 M2-16): the route against the shared table, the API adapter over a fake fetch, the
// progress and grouping of the D.5 steps, the single administrator and separation of duties warnings, the steps of the
// MS Manager (prepared email, or the screen when the session may do the step), the scenes of MOT-03, the sample
// adapter and the definition, in both languages and themes.
import { beforeAll, describe, expect, it } from 'vitest';
import { routeById } from '@mscd/shared';
import type { OnboardingStep } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/getting-started/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/getting-started/routes';
import { createApiAdapter, fromStep } from '../../src/screens/getting-started/api';
import { adapterFor, deferredAdapter, loadSteps } from '../../src/screens/getting-started/adapter';
import {
  OPTIONAL_KEYS, STEP_KEYS, countText, groupsOf, mailtoOf, progressOf, singleAdmin, warningOf,
} from '../../src/screens/getting-started/model';
import type { StepModel } from '../../src/screens/getting-started/model';
import { createSampleAdapter, sampleSteps } from '../../src/screens/getting-started/sample';
import { Checklist, StepRow, doesItself, screenLabel, systemName } from '../../src/screens/getting-started/Screen';
import { TEXT } from '../../src/screens/getting-started/text';
import { HOST_SCREENS } from '../../src/screens/registry';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, sampleD, t, textProblems } from './ctx-m2-16';

const RINA = { name: 'Rina Kusuma', email: 'rina.kusuma@nusantaradigital.co.id' };

const WIRE: OnboardingStep[] = [
  { key: 'licence', state: 'done', screen: 'license', count: 12, limit: 50 },
  { key: 'second_admin', state: 'pending', screen: 'users', count: 1 },
  { key: 'sign_in', state: 'optional', screen: 'identity-providers', count: 0 },
  { key: 'local_login', state: 'optional', screen: 'identity-providers' },
  { key: 'repository', state: 'done', screen: 'storage', count: 1 },
  { key: 'routing', state: 'pending', screen: 'routing', count: 0 },
  { key: 'systems', state: 'done', screen: 'systems', count: 1 },
  { key: 'team', state: 'pending', screen: 'users', count: 0 },
  { key: 'ms_manager', state: 'done', screen: 'users', ms: 'isms' },
  { key: 'verifiers', state: 'pending', screen: 'users', ms: 'isms', count: 1 },
  { key: 'internal_auditor', state: 'optional', screen: 'users', ms: 'isms', count: 0 },
  { key: 'implementing', state: 'pending', screen: 'systems', ms: 'isms' },
  { key: 'applicability', state: 'done', screen: 'controls', ms: 'isms', count: 123, doneBy: 'ms_manager', assignee: RINA },
  { key: 'audit_dates', state: 'pending', screen: 'timeline', ms: 'isms', count: 0, doneBy: 'ms_manager', assignee: RINA },
  { key: 'pending_grants', state: 'done', screen: 'approvals', count: 0 },
];
const STEPS = WIRE.map(fromStep).filter((s): s is StepModel => s !== null);

beforeAll(async () => {
  await loadSampleD();
});

describe('Getting started routes and definition', () => {
  it('match the shared route table and its permission', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.onboarding).permission).toBe('ms.admin');
  });

  it('is first in the Administration group, ahead of Licence, with ms.admin', () => {
    expect(screen).toMatchObject({ id: 'getting-started', path: '/admin/getting-started', group: 'admin', scope: 'org', perm: 'ms.admin' });
    const admin = HOST_SCREENS.filter((d) => d.group === 'admin' && d.nav !== false);
    expect(admin[0].id).toBe('getting-started');
    expect(screen.order).toBeLessThan(HOST_SCREENS.find((d) => d.id === 'license')!.order);
    // Built-in Administration entries have the orders 10 and 20 (Framework library, Storage repositories).
    expect(screen.order).toBeLessThan(10);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    expect(textProblems(TEXT)).toEqual([]);
  });

  it('the step keys are those of the contract', async () => {
    const { ONBOARDING_STEP_KEYS } = await import('@mscd/shared');
    expect([...STEP_KEYS]).toEqual([...ONBOARDING_STEP_KEYS]);
  });
});

describe('Getting started API adapter', () => {
  it('reads GET /admin/onboarding and keeps a refusal', async () => {
    const f = fakeFetch({ 'GET /api/v1/admin/onboarding': [json([...WIRE, { key: 'unknown_step', state: 'done', screen: 'x' }]), problem(403, 'forbidden', { messages: { en: 'Not allowed', id: 'Tidak diizinkan' } })] });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    const first = await adapter.load();
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.steps).toEqual(STEPS);
    expect(f.calls[0]).toMatchObject({ method: 'GET', path: '/api/v1/admin/onboarding' });
    const second = await adapter.load();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toEqual(['Not allowed', 'Tidak diizinkan']);
  });

  it('the build chooses the sample adapter outside the api build, through a deferred import', async () => {
    const res = await adapterFor(null, () => sampleD()).load();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.steps.some((s) => s.key === 'licence')).toBe(true);
  });

  it('a failed module load becomes a connection error, and the next load tries again', async () => {
    let calls = 0;
    const adapter = deferredAdapter(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('chunk')) : Promise.resolve(createSampleAdapter(() => sampleD()));
    });
    const failed = await loadSteps(adapter);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.status).toBe(0);
    expect((await loadSteps(adapter)).ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('Getting started model', () => {
  it('progress counts the required steps only; optional steps stay out', () => {
    const p = progressOf(STEPS);
    const required = STEPS.filter((s) => !OPTIONAL_KEYS.has(s.key));
    expect(p.total).toBe(required.length);
    expect(p.done).toBe(required.filter((s) => s.state === 'done').length);
    expect(p.allDone).toBe(false);
    expect(progressOf(STEPS.map((s) => ({ ...s, state: OPTIONAL_KEYS.has(s.key) ? 'optional' : 'done' }))).allDone).toBe(true);
    expect(progressOf([])).toMatchObject({ done: 0, total: 0, allDone: false, share: 0 });
  });

  it('groups the organisation steps first, then each system', () => {
    const groups = groupsOf(STEPS);
    expect(groups.map((g) => g.ms)).toEqual([null, 'isms']);
    expect(groups[0].steps.map((s) => s.key)).toEqual(['licence', 'second_admin', 'sign_in', 'local_login', 'repository', 'routing', 'systems', 'team', 'pending_grants']);
    expect(groups[1].steps).toHaveLength(6);
  });

  it('warns while one administrator is alone, and for verifiers and the team while pending', () => {
    expect(singleAdmin(STEPS)).toBe(true);
    expect(singleAdmin(STEPS.map((s) => (s.key === 'second_admin' ? { ...s, state: 'done' } : s)))).toBe(false);
    expect(warningOf(STEPS.find((s) => s.key === 'verifiers')!)).toBe(TEXT.verifiersWarning);
    expect(warningOf(STEPS.find((s) => s.key === 'team')!)).toBe(TEXT.teamWarning);
    expect(warningOf({ ...STEPS.find((s) => s.key === 'verifiers')!, state: 'done' })).toBeNull();
    expect(warningOf(STEPS.find((s) => s.key === 'routing')!)).toBeNull();
  });

  it('count texts: seats against the limit, and the plain counts', () => {
    expect(countText(STEPS[0])).toEqual({ text: TEXT.licenceCount, values: { count: 12, limit: 50 } });
    expect(countText({ ...STEPS[0], limit: undefined })).toEqual({ text: TEXT.licenceCountOnly, values: { count: 12 } });
    expect(countText(STEPS.find((s) => s.key === 'verifiers')!)).toEqual({ text: TEXT.verifiersCount, values: { count: 1 } });
    expect(countText(STEPS.find((s) => s.key === 'local_login')!)).toBeNull();
  });

  it('counts above two read correctly: three verifiers, or a rescheduled audit counted twice', () => {
    for (const key of ['verifiers', 'audit_dates'] as const) {
      const c = countText({ ...STEPS.find((s) => s.key === key)!, count: 3 })!;
      for (const lang of ['en', 'id'] as Lang[]) {
        const text = t(c.text, lang).replace('{count}', String(c.values.count));
        expect(text, key).toMatch(/: 3$/);
        expect(text, key).not.toMatch(/\b(of|dari) 2\b/);
      }
    }
  });

  it('the prepared email names the system and the step, and keeps the address clean', () => {
    const href = mailtoOf({ name: 'Rina Kusuma', email: 'rina.kusuma@nusantaradigital.co.id?cc=x' }, { step: 'Plan the Stage 1 and Stage 2 audits', system: 'ISMS, ISO/IEC 27001' }, (p, v) => t(p).replace(/\{(\w+)\}/g, (_m, k: string) => v[k]));
    expect(href.startsWith('mailto:rina.kusuma@nusantaradigital.co.idcc=x?subject=')).toBe(true);
    const url = new URL(href.replace('mailto:', 'mailto://'));
    expect(url.searchParams.get('subject')).toBe('MSCD: Plan the Stage 1 and Stage 2 audits for ISMS, ISO/IEC 27001');
    expect(url.searchParams.get('body')).toContain('Hello Rina Kusuma,');
    expect(url.searchParams.get('body')).toContain('for the management system ISMS, ISO/IEC 27001: Plan the Stage 1 and Stage 2 audits.');
  });
});

describe('Getting started checklist', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`shows the progress, warnings and steps in ${lang}, ${theme} theme`, () => {
        // A Tenant Admin without a business role: the steps of the MS Manager go to Rina by email.
        const ctx = ctxOf({ lang, theme, mode: 'api', org: ['ms.admin', 'license.read', 'user.manage', 'storage.repository.read'] });
        const html = render(<Checklist ctx={ctx} steps={STEPS} />, ctx, theme);
        const p = progressOf(STEPS);
        expect(html).toContain(esc(ctx.fill(TEXT.progress, { done: p.done, total: p.total })));
        expect(html).toContain('data-scene="getting-started"');
        expect(html).toContain(esc(t(TEXT.singleAdminTitle, lang)));
        expect(html).toContain(esc(t(TEXT.verifiersWarning, lang)));
        expect(html).toContain(esc(t(TEXT.teamWarning, lang)));
        expect(html).toContain(esc(t(TEXT.forManager, lang)));
        expect(html).toContain(esc(t(TEXT.stateOptional, lang)));
        expect(html).toContain(esc(ctx.fill(TEXT.licenceCount, { count: 12, limit: 50 })));
        expect(html).toContain('href="mailto:rina.kusuma@nusantaradigital.co.id?subject=');
        expect(html).toContain(esc(ctx.fill(TEXT.emailManager, { name: 'Rina Kusuma' })));
        expect(html).toContain(esc(systemName(ctx, 'isms')));
        expect(html).not.toMatch(/[—·]/);
      });
    }
  }

  it('the manager who may do a step of the MS Manager gets the screen instead of the email', () => {
    const ctx = ctxOf({ mode: 'api', org: ['ms.admin'], ms: { isms: ['ms.read', 'audit_event.manage', 'applicability.manage'] } });
    const audit = STEPS.find((s) => s.key === 'audit_dates')!;
    expect(doesItself(ctx, audit)).toBe(true);
    const html = render(<ol><StepRow ctx={ctx} step={audit} /></ol>, ctx);
    expect(html).not.toContain('mailto:');
    expect(html).toContain(esc(ctx.fill(TEXT.open, { screen: 'Certification timeline' })));
    // Without the permission: the email to the assignee; without an assignee: the hint to grant one first.
    const admin = ctxOf({ mode: 'api', org: ['ms.admin'] });
    expect(render(<ol><StepRow ctx={admin} step={audit} /></ol>, admin)).toContain('mailto:');
    expect(render(<ol><StepRow ctx={admin} step={{ ...audit, assignee: null }} /></ol>, admin)).toContain(esc(t(TEXT.noManager)));
  });

  it('in the sample build the persona does the steps of its own system and emails the other managers', () => {
    const ctx = ctxOf();
    const steps = sampleSteps(sampleD());
    expect(doesItself(ctx, steps.find((s) => s.key === 'audit_dates' && s.ms === 'isms')!)).toBe(true);
    expect(doesItself(ctx, steps.find((s) => s.key === 'audit_dates' && s.ms === 'qms')!)).toBe(false);
  });

  it('a step whose screen the session cannot open says so', () => {
    const ctx = ctxOf({ mode: 'api', org: ['ms.admin'] });
    const html = render(<ol><StepRow ctx={ctx} step={STEPS.find((s) => s.key === 'routing')!} /></ol>, ctx);
    const routing = screenLabel('routing');
    if (routing) expect(html).toContain(esc(ctx.fill(TEXT.notAvailable, { screen: t(routing) })));
    else expect(html).not.toContain('<button');
  });

  it('every step done shows the all-done scene; no system shows the no-systems scene', () => {
    const ctx = ctxOf();
    const done = STEPS.map((s) => ({ ...s, state: OPTIONAL_KEYS.has(s.key) ? ('optional' as const) : ('done' as const) }));
    const html = render(<Checklist ctx={ctx} steps={done} />, ctx);
    expect(html).toContain('data-scene="all-done"');
    expect(html).toContain(esc(t(TEXT.allDone)));
    const none = render(<Checklist ctx={ctx} steps={STEPS.filter((s) => !s.ms)} />, ctx);
    expect(none).toContain('data-scene="no-systems"');
    expect(none).toContain(esc(t(TEXT.noSystems)));
  });
});

describe('Getting started sample adapter', () => {
  it('builds the checklist of the sample snapshot', async () => {
    const res = await createSampleAdapter(() => sampleD()).load();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const D = sampleD();
    expect(res.steps.filter((s) => s.key === 'ms_manager').map((s) => s.ms)).toEqual(D.MS.map((m) => m.id));
    expect(res.steps.find((s) => s.key === 'licence')).toMatchObject({ state: 'done', count: 86, limit: 150 });
    // ABMS: only its manager verifies, so its separation of duties warning shows.
    expect(res.steps.find((s) => s.key === 'verifiers' && s.ms === 'abms')).toMatchObject({ state: 'pending', count: 1 });
    // ISMS has a Stage 1 and a Stage 2 event in the sample; ABMS has none.
    expect(res.steps.find((s) => s.key === 'audit_dates' && s.ms === 'isms')!.state).toBe('done');
    expect(res.steps.find((s) => s.key === 'audit_dates' && s.ms === 'abms')).toMatchObject({ state: 'pending', doneBy: 'ms_manager', assignee: { name: 'Lina Marlina', email: 'lina.marlina@nusantaradigital.co.id' } });
    expect(sampleSteps(null)).toEqual([]);
  });
});
