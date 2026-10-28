// Registers (MILESTONE-2 M2-13): routes against the shared table, the full-permission roles against the F.6 matrix,
// the form helpers (RegisterCreate and RegisterPatch of risk-registers.ts per kind), who may do what, the C.13 moves of
// treatments with BR-04, the API adapter over a fake fetch (method, path, body, `X-CSRF-Token`, `If-Match`,
// `Idempotency-Key`, field errors kept, treatments read as chain records of the risk), the sample adapter with its
// rules (BR-17, BR-22, BR-04, H.5) and one cache per organisation, and the views in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_MATRIX, REGISTER_KINDS, RegisterCreate, RegisterPatch, routeById } from '@mscd/shared';
import type { RegisterItem } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/registers/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/registers/routes';
import { createApiAdapter, resetApiRegisters, rowOf, treatmentOf } from '../../src/screens/registers/api';
import { createSampleAdapter, resetSampleRegisters, sampleId, sampleOrgKey } from '../../src/screens/registers/sample';
import { adapterFor, deferredAdapter } from '../../src/screens/registers/adapter';
import { FIRST_KIND, cacheAge, cacheFirstPage, cachedFirstPage, firstPageKey, keepUnlinkedProof, proofKey, resetRegisterCache, unlinkedProof } from '../../src/screens/registers/cache';
import { preloadScreen, screenModule } from '../../src/screens/registers/load';
import { layerItems, prefetchVisible } from '../../src/screens/registers/actions';
import {
  FULL_ROLES, KINDS, KIND_DEFS, TREATMENT_ACTIONS, acceptBlock, acceptCandidates, canAdd, canChangeLinks, canMove, canRecordValue, competenceCode,
  createBody, editScope, emptyForm, formErrors, formOfRow, keepsCompetenceProof, linkTargets, linkedAfter, moveBlock, moveLabel, movesFrom, nextCode,
  outcomeOf, ownerFixed, patchBody, proofHoldersOf, residualBody, residualErrors, scoreOf, scoreTone, statusFromAction, treatmentBody, treatmentErrors,
  validityOf, valueBody, valueErrors,
} from '../../src/screens/registers/model';
import type { RegistersAdapter, RowModel, TreatmentModel } from '../../src/screens/registers/model';
import { RegisterList, addableKinds, columnsOf } from '../../src/screens/registers/Screen';
import { RowPanel, factsOf } from '../../src/screens/registers/RowPanel';
import { LinkDialog, ResidualDialog, RowFormDrawer, TreatmentDialog, ValueDialog, rememberProof, treatmentCode, tryAddTreatment, trySaveRow } from '../../src/screens/registers/Forms';
import type { RowSaveInput } from '../../src/screens/registers/Forms';
import { KIND_TEXT, TEXT } from '../../src/screens/registers/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData, DataSource } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { fakeFetch, json, problem } from '../auth/helpers';

const dataOf = (snapshot: object) => ({ ...makeDates(SAMPLE.TODAY_S), ...snapshot, TODAY_S: SAMPLE.TODAY_S }) as unknown as ControllerData;
const sampleSource = createSampleDataSource();
const D = dataOf(await sampleSource.load());

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: D.MS[0], org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'registers', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

/** An api session: business roles per system and the permissions of `Me` (own-scoped ones included, as the api lists them). */
function apiCtx(handle: string, roles: string[], perms: string[], over: Partial<HostContext> = {}): HostContext {
  return ctxOf('en', {
    mode: 'api', person: { handle, name: handle, jobTitle: '-' },
    me: { user: { handle }, rolesByMs: { isms: roles }, permissions: { org: [], ms: { isms: perms } } } as never,
    can: (ms: string | null | undefined, perm: string | readonly string[]) => ms === 'isms' && (Array.isArray(perm) ? perm : [perm]).some((p) => perms.includes(p)),
    ...over,
  });
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const REF = (entityType: string, code: string, id = '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b') => ({ module: 'audit' as const, entityType, id, code, etag: 'W/"1790000000000"' });

const RISK_ITEM: RegisterItem = {
  ref: REF('risk', 'R-014'), code: 'R-014', title: 'Privileged credential misuse', owner: 'bagus', status: 'open', updatedAt: '2026-09-10T04:00:00Z', shared: true, ms: ['isms', 'qms'],
  riskProfileCode: 'information_security', isOpportunity: false, likelihood: 3, consequence: 4, residualLikelihood: 1, residualConsequence: 3, treatmentOption: 'modify',
  assessedAt: '2025-09-10', nextReviewAt: '2026-09-10', description: null, residualAcceptedAt: null,
};
const RISK: RowModel = rowOf(RISK_ITEM);

afterEach(() => {
  resetSampleRegisters();
  resetApiRegisters();
  resetRegisterCache();
});

describe('registers routes and permissions', () => {
  it('match the shared route table', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.list).permission).toBe('ms.read');
    expect(routeById(ROUTE_IDS.metricValue).permission).toBe('metric.record');
    expect(routeById(ROUTE_IDS.treatmentCreate).permission).toBe('risk.manage');
    expect(routeById(ROUTE_IDS.residualAcceptance).permission).toBe('risk.residual.accept');
    expect(routeById(ROUTE_IDS.entityLinkCreate).permission).toBe('entity_link.manage');
  });

  it('name every register kind of the contract, with the full-permission roles of F.6', () => {
    expect([...KINDS].sort()).toEqual([...REGISTER_KINDS].sort());
    for (const [perm, roles] of Object.entries(FULL_ROLES)) {
      expect([...roles].sort(), perm).toEqual([...PERMISSION_MATRIX[perm as keyof typeof PERMISSION_MATRIX].roles].sort());
    }
    expect(PERMISSION_MATRIX['register.manage'].own).toEqual(expect.arrayContaining(['domain_owner', 'risk_owner']));
    expect(PERMISSION_MATRIX['risk.residual.accept'].roles).toEqual([]);
  });

  it('every kind field is a member of RegisterItem and the create bodies parse with the shared schema', () => {
    const me = 'rina';
    for (const kind of KINDS) {
      const form = emptyForm(kind, [], me, '2026-09-29');
      form.title = 'A title';
      if (kind === 'risks') form.ownerHandle = 'bagus';
      if (kind === 'competence') Object.assign(form, { personHandle: 'maya', competenceRequired: 'Lead auditor training' });
      expect(formErrors(kind, form), kind).toEqual({});
      const body = createBody(kind, form, { ownerFixed: false, me });
      expect(RegisterCreate.safeParse(body).success, `${kind} ${JSON.stringify(body)}`).toBe(true);
      expect(body.code === undefined, kind).toBe(kind === 'competence');
    }
  });
});

describe('register forms', () => {
  it('suggest the next code and check code, title, owner, lengths and numbers', () => {
    expect(nextCode('R-', ['R-031', 'R-014', 'CI-09', 'R-0100'])).toBe('R-0101');
    expect(nextCode('IP-', [])).toBe('IP-001');
    const risk = emptyForm('risks', ['R-040'], 'rina', '2026-09-29');
    expect(risk).toMatchObject({ code: 'R-041', ownerHandle: '', assessedAt: '2026-09-29' });
    expect(formErrors('risks', risk)).toEqual({ title: TEXT.required, ownerHandle: TEXT.required });
    expect(formErrors('metrics', { ...emptyForm('metrics', [], 'rina', null), code: `M-${'1'.repeat(29)}`, title: 'x', targetValue: 'abc' })).toEqual({ code: TEXT.badCode, targetValue: TEXT.badNumber });
    const competence = { ...emptyForm('competence', [], 'rina', null), title: 'x'.repeat(151), personHandle: '', competenceRequired: '', achievedAt: '2026-01-02', validUntil: '2025-01-01' };
    expect(formErrors('competence', competence)).toMatchObject({ title: ['At most 150 characters', 'Paling banyak 150 karakter'], personHandle: TEXT.required, competenceRequired: TEXT.required, validUntil: TEXT.validBeforeAchieved });
    expect(formErrors('objectives', { ...emptyForm('objectives', [], 'rina', null), title: 'x', ownerHandle: 'none', targetText: 'y'.repeat(151) })).toMatchObject({ ownerHandle: TEXT.required, targetText: ['At most 150 characters', 'Paling banyak 150 karakter'] });
  });

  it('builds RegisterCreate with typed values and the fixed owner of an own-row editor', () => {
    const form = { ...emptyForm('risks', [], 'rina', '2026-09-29'), title: ' Loss of backup site ', ownerHandle: 'bagus', likelihood: '2', consequence: '5', treatmentOption: 'modify', isOpportunity: true };
    expect(createBody('risks', form, { ownerFixed: false, me: 'rina' })).toEqual({
      code: 'R-001', title: 'Loss of backup site', ownerHandle: 'bagus', isOpportunity: true, likelihood: 2, consequence: 5, treatmentOption: 'modify', assessedAt: '2026-09-29',
    });
    const metric = { ...emptyForm('metrics', ['M-07'], 'bagus', null), title: 'Patch SLA', targetValue: '97.5', unit: '%', frequencyCode: 'monthly', ownerHandle: 'rina' };
    expect(createBody('metrics', metric, { ownerFixed: true, me: 'bagus' })).toEqual({ code: 'M-008', title: 'Patch SLA', ownerHandle: 'bagus', unit: '%', targetValue: 97.5, frequencyCode: 'monthly' });
    const asset = { ...emptyForm('assets', [], 'rina', null), title: 'Laptop', ownerHandle: '' };
    expect(createBody('assets', asset, { ownerFixed: false, me: 'rina' })).toMatchObject({ ownerHandle: 'none' });
    const competence = { ...emptyForm('competence', [], 'rina', null), title: 'Internal auditor', personHandle: 'maya', competenceRequired: 'Training', validUntil: '2028-03-14' };
    expect(createBody('competence', competence, { ownerFixed: false, me: 'rina', proofObjectId: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f' })).toEqual({
      title: 'Internal auditor', ownerHandle: 'rina', personHandle: 'maya', competenceRequired: 'Training', proofType: 'certificate', validUntil: '2028-03-14', proofObjectId: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f',
    });
  });

  it('builds a RegisterPatch of the changed fields only, limited to the assessment fields of a Risk Owner', () => {
    const form = formOfRow('risks', RISK);
    expect(form).toMatchObject({ code: 'R-014', ownerHandle: 'bagus', likelihood: '3', isOpportunity: false });
    expect(patchBody('risks', form, RISK, 'all')).toBeNull();
    const changed = { ...form, title: 'Privileged misuse', likelihood: '2', description: 'Shared admin accounts', nextReviewAt: '', ownerHandle: 'rina' };
    const patch = patchBody('risks', changed, RISK, 'all');
    expect(patch).toEqual({ title: 'Privileged misuse', ownerHandle: 'rina', description: 'Shared admin accounts', likelihood: 2, nextReviewAt: null });
    expect(RegisterPatch.safeParse(patch).success).toBe(true);
    expect(patchBody('risks', changed, RISK, 'assessment')).toEqual({ likelihood: 2, nextReviewAt: null });
    expect(patchBody('risks', { ...form, ownerHandle: '' }, RISK, 'all')).toEqual({ ownerHandle: 'none' });
    const competence: RowModel = { ...RISK, code: 'CMP-1D2E3F4A', ms: ['isms'], shared: false, personHandle: 'maya', competenceRequired: 'Training', proofType: 'certificate', proofObjectId: null };
    expect(patchBody('competence', formOfRow('competence', competence), competence, 'own', '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f')).toEqual({ proofObjectId: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f' });
  });

  it('checks and builds metric values, treatments and residual acceptance', () => {
    expect(valueErrors({ periodStart: '2026-09-30', periodEnd: '2026-09-01', value: 'x', note: '' })).toEqual({ periodEnd: TEXT.periodOrder, value: TEXT.badNumber });
    expect(valueBody({ periodStart: '2026-07-01', periodEnd: '2026-09-30', value: '97.5', note: ' ok ' })).toEqual({ periodStart: '2026-07-01', periodEnd: '2026-09-30', value: 97.5, note: 'ok' });
    expect(treatmentErrors({ option: 'modify', code: '', title: '', owner: 'none', due: '', target: '' })).toEqual({ code: TEXT.required, title: TEXT.required, owner: TEXT.required, due: TEXT.required, target: TEXT.required });
    const targets = [{ kind: 'catalogue_item' as const, code: 'A.8.2', title: 'Privileged access rights' }, { kind: 'requirement' as const, code: '6.1.3', title: 'Risk treatment' }];
    expect(treatmentBody(RISK, { option: 'modify', code: 'T-040', title: ' Deploy PAM ', owner: 'bagus', due: '2026-12-15', target: '6.1.3' }, targets)).toEqual({
      riskCode: 'R-014', code: 'T-040', title: 'Deploy PAM', ownerHandle: 'bagus', targetType: 'requirement', targetCode: '6.1.3', targetDate: '2026-12-15',
    });
    expect(treatmentCode(RISK, [])).toBe('T-014');
    expect(treatmentCode(RISK, ['T-014'])).toBe('T-015');
    expect(residualErrors({ treatmentId: '', likelihood: '', consequence: '2', note: '' })).toEqual({ likelihood: TEXT.required, note: TEXT.required });
    expect(residualBody({ treatmentId: '', likelihood: '1', consequence: '3', note: ' PAM in place ' })).toEqual({ residualLikelihood: 1, residualConsequence: 3, note: 'PAM in place' });
    expect(linkedAfter({ ms: ['isms', 'qms', 'bcms'] }, 'bcms', 'primary')).toEqual(['bcms', 'isms', 'qms']);
    expect(linkedAfter({ ms: ['isms', 'qms'] }, 'qms', 'remove')).toEqual(['isms']);
  });

  it('labels scores, validity and competence codes', () => {
    expect([scoreOf(3, 4), scoreOf(null, 4)]).toEqual([12, null]);
    expect([scoreTone(16), scoreTone(12), scoreTone(4), scoreTone(null)]).toEqual(['bad', 'warn', 'ok', 'mute']);
    expect([validityOf('2026-09-01', '2026-09-29'), validityOf('2026-10-20', '2026-09-29'), validityOf('2027-01-01', '2026-09-29'), validityOf(null, '2026-09-29')]).toEqual(['expired', 'soon', null, null]);
    expect(competenceCode('1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a')).toBe('CMP-1D2E3F4A');
  });

  it('offers only evidence records of competence to keep a proof file, those without a file first', () => {
    expect(['Cl. 7.2', '7.2', '7.2.1', 'A.6.3'].map(keepsCompetenceProof)).toEqual([true, true, true, true]);
    // A.7.2 is physical entry; 7.2.2 of ISO 37001 is the employment process; other controls keep their own evidence.
    expect(['A.7.2', '7.2.2', 'A.8.13', 'Cl. 7.3', '', null].map(keepsCompetenceProof)).toEqual([false, false, false, false, false, false]);
    const evs = [
      { code: 'EQ-0133', ctrl: 'Cl. 7.2', title: 'Competence matrix', loc: 'vault' },
      { code: 'EQ-0140', ctrl: 'Cl. 7.2', title: 'Training certificates', loc: '' },
      { code: 'EQ-0103', ctrl: 'Cl. 8.4', title: 'Supplier evaluation', loc: '' },
    ];
    expect(proofHoldersOf(evs, (code) => `id-${code}`)).toEqual([
      { id: 'id-EQ-0140', code: 'EQ-0140', title: 'Training certificates', hasFile: false },
      { id: 'id-EQ-0133', code: 'EQ-0133', title: 'Competence matrix', hasFile: true },
    ]);
    expect(proofHoldersOf(evs, () => '')).toEqual([]);
  });

  it('keeps the ETag a command result names for the record it changed', () => {
    expect(outcomeOf({ changed: ['isms'], ref: { id: 'r1', code: 'R-014', etag: 'W/"2"' } }).ref).toEqual({ id: 'r1', code: 'R-014', etag: 'W/"2"' });
    expect(outcomeOf({ changed: ['isms'], ref: { id: 'r1', code: 'R-014' } }).ref).toEqual({ id: 'r1', code: 'R-014' });
  });
});

describe('treatment moves (C.13) and residual acceptance (BR-04)', () => {
  const t = (over: Partial<TreatmentModel> = {}): TreatmentModel => ({ id: 't1', code: 'T-014', title: 'Deploy PAM', owner: 'bagus', due: null, target: 'A.8.2', status: 'in_progress', etag: null, implementedBy: null, ...over });

  it('reads the status from the pending action and offers the moves of C.13', () => {
    expect(Object.entries(TREATMENT_ACTIONS).filter(([, a]) => a).map(([, a]) => statusFromAction(a))).toEqual(['proposed', 'approved', 'in_progress', 'delayed']);
    expect([statusFromAction(null), statusFromAction('Confirm completion with photos')]).toEqual(['done', 'open']);
    expect(movesFrom('proposed')).toEqual(['approved']);
    expect(movesFrom('in_progress')).toEqual(['delayed', 'implemented']);
    expect(movesFrom('delayed')).toEqual(['in_progress', 'implemented']);
    expect(movesFrom('residual_accepted')).toEqual(['closed']);
    expect(movesFrom('closed')).toEqual([]);
    expect(moveLabel('delayed', 'in_progress')).toEqual(TEXT.moveResume);
    expect(moveBlock(t({ status: 'implemented' }), 'closed')).toEqual(TEXT.closeBlocked);
    expect(moveBlock(t({ status: 'residual_accepted' }), 'closed')).toBeNull();
    expect(moveBlock(t({ status: 'done' }), 'closed')).toBeNull();
  });

  it('lets the MS Manager approve and close, the treatment owner implement, and nobody else', () => {
    const rina = apiCtx('rina', ['ms_manager'], ['ms.read', 'risk.manage', 'risk.treatment.update', 'risk.residual.accept', 'entity_link.manage', 'register.manage', 'metric.record']);
    const bagus = apiCtx('bagus', ['domain_owner'], ['ms.read', 'risk.treatment.update', 'risk.residual.accept', 'register.manage', 'metric.record']);
    const maya = apiCtx('maya', ['internal_auditor'], ['ms.read']);
    expect([canMove(rina, 'isms', t(), 'approved'), canMove(rina, 'isms', t(), 'implemented')]).toEqual([true, true]);
    expect([canMove(bagus, 'isms', t(), 'approved'), canMove(bagus, 'isms', t(), 'implemented'), canMove(bagus, 'isms', t({ owner: 'yusuf' }), 'implemented')]).toEqual([false, true, false]);
    expect(canMove(maya, 'isms', t(), 'implemented')).toBe(false);
    expect([canAdd(rina, 'isms', 'risks'), canAdd(bagus, 'isms', 'risks'), canAdd(bagus, 'isms', 'assets'), canAdd(maya, 'isms', 'assets')]).toEqual([true, false, true, false]);
    expect([ownerFixed(rina, 'isms', 'assets'), ownerFixed(bagus, 'isms', 'assets')]).toEqual([false, true]);
    expect([editScope(rina, 'isms', 'risks', RISK), editScope(bagus, 'isms', 'assets', RISK), editScope(bagus, 'isms', 'assets', { owner: 'rina' }), editScope(maya, 'isms', 'risks', RISK)]).toEqual(['all', 'own', null, null]);
    const riskOwner = apiCtx('bagus', ['risk_owner'], ['ms.read', 'risk.manage', 'risk.treatment.update', 'risk.residual.accept']);
    expect(editScope(riskOwner, 'isms', 'risks', RISK)).toBe('assessment');
    expect([canRecordValue(bagus, 'isms', { owner: 'bagus' }), canRecordValue(bagus, 'isms', { owner: 'rina' })]).toEqual([true, false]);
    expect([canChangeLinks(rina, 'isms', 'risks'), canChangeLinks(bagus, 'isms', 'assets')]).toEqual([true, false]);
    expect(addableKinds(bagus, 'isms', 'risks')).toEqual(['context-issues', 'interested-parties', 'assets', 'metrics', 'objectives', 'competence']);
    expect(addableKinds(rina, 'isms', 'risks')[0]).toBe('risks');
  });

  it('only the risk owner accepts, never the implementer of the treatment', () => {
    const bagus = apiCtx('bagus', ['domain_owner'], ['ms.read', 'risk.residual.accept']);
    const rina = apiCtx('rina', ['ms_manager'], ['ms.read', 'risk.residual.accept'], { D: { ...D, PEOPLE: { ...D.PEOPLE } } });
    const implemented = t({ status: 'implemented', owner: 'yusuf' });
    expect(acceptCandidates([t(), implemented, t({ id: 't3', status: 'done' })])).toEqual([implemented]);
    expect(acceptCandidates([t({ status: 'done' })]).length).toBe(1);
    expect(acceptBlock(bagus, 'isms', RISK, [implemented], null)).toBeNull();
    expect(acceptBlock(bagus, 'isms', RISK, [], null)).toEqual(TEXT.noImplemented);
    expect(acceptBlock(bagus, 'isms', RISK, [t({ status: 'implemented', implementedBy: 'bagus' })], null)).toEqual(TEXT.implementerBlocked);
    // The treatment's owner is not taken for its implementer: without a known implementer the api decides.
    expect(acceptBlock(bagus, 'isms', RISK, [t({ status: 'implemented' })], null)).toBeNull();
    expect(acceptBlock(rina, 'isms', RISK, [implemented], null)).toBe('Only the risk owner, Bagus Prasetyo, can accept the residual risk.');
  });

  it('offers to link a record to the systems where the session manages links and it is not linked yet', () => {
    const ctx = ctxOf('en', { can: (ms: string | null | undefined, p: unknown) => p === 'entity_link.manage' && ms !== 'abms' });
    expect(linkTargets(ctx, { ms: ['isms', 'qms'] }).map((t) => t.id)).toEqual(['bcms']);
  });
});

describe('registers API adapter', () => {
  const D_API = {
    ...D,
    STAGES: { isms: [{ id: 'context', l: ['Context', 'Konteks'], q: '' }, { id: 'risk', l: ['Risk', 'Risiko'], q: '' }, { id: 'treatment', l: ['Treatment', 'Perlakuan'], q: '' }, { id: 'control', l: ['Control', 'Kontrol'], q: '', src: 'req' }] },
    X: { isms: { treatment: [{ id: 'T-014', t: 'Deploy PAM', act: 'Report implementation progress', h: 'bagus', due: '2026-09-15', up: ['R-014'] }] } },
    refs: {
      'isms:x:T-014': REF('risk_treatment', 'T-014', '9b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e'),
      'isms:ev:EV-0313': REF('evidence', 'EV-0313', '5a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d'),
      'isms:ev:EV-0217': REF('evidence', 'EV-0217', '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d'),
    },
    bundles: {
      isms: {
        evs: [
          { code: 'EV-0313', ctrl: 'A.8.13', title: 'Backup job log', loc: 'sp' },
          { code: 'EV-0217', ctrl: 'A.6.3', title: 'Awareness training attendance', loc: 'sp' },
          { code: 'EV-9999', ctrl: 'A.6.3', title: 'No ref', loc: '' },
        ],
      },
    },
  } as unknown as ControllerData;
  const record = (code: string, id: string, action: string | null, up: string[], holder = 'bagus') => ({
    ref: { ...REF('risk_treatment', code, id), stage: 'treatment' }, title: `Treatment ${code}`, status: action ? 'pending' : 'ready', state: 'x', action,
    holder: { handle: holder, displayName: holder, roleLabel: 'x' }, dueAt: '2026-12-15', daysToDue: 10, afterAudit: false,
    upstream: up.map((id2) => ({ stage: 'risk', id: id2 })), downstream: [{ stage: 'control', id: 'A.8.2' }],
  });
  const api = (routes: Parameters<typeof fakeFetch>[0], getD = () => D_API, org: () => string = () => 'ndt') => {
    const f = fakeFetch(routes);
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    return { ...f, adapter: createApiAdapter(client, { getD, me: () => 'rina', org }) };
  };

  it('lists a register page with the search and keeps the uuid and ETag of each row', async () => {
    const { adapter, calls } = api({ 'GET /api/v1/ms/isms/registers/risks': json({ items: [RISK_ITEM], page: 2, pageSize: 50, total: 51 }) });
    const res = await adapter.list('isms', 'risks', { q: 'priv', page: 2, pageSize: 50 });
    expect(res).toEqual({ ok: true, data: { items: [RISK], page: 2, pageSize: 50, total: 51 } });
    expect(RISK).toMatchObject({ id: RISK_ITEM.ref.id, etag: 'W/"1790000000000"', code: 'R-014' });
    expect(calls[0].url).toContain('/api/v1/ms/isms/registers/risks?');
    expect(new URL(calls[0].url, 'http://x').searchParams.toString()).toBe('page=2&pageSize=50&q=priv');
    // registers.list takes a search of at most 100 characters.
    await adapter.list('isms', 'risks', { q: `  ${'x'.repeat(150)}`, page: 1, pageSize: 50 });
    expect(new URL(calls[1].url, 'http://x').searchParams.get('q')).toBe('x'.repeat(100));
  });

  it('creates and changes rows with Idempotency-Key, If-Match and the CSRF token, and keeps the field errors', async () => {
    const { adapter, calls } = api({
      'POST /api/v1/ms/isms/registers/assets': json({ ok: true, changed: ['isms'], ref: REF('asset', 'AS-12') }, 201),
      'PATCH /api/v1/ms/isms/registers/risks/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b': [
        problem(409, 'confirmation-required', { rule: 'BR-22', messages: { en: 'R-014 is shared with QMS', id: 'R-014 dibagi dengan QMS' } }),
        json({ ok: true, changed: ['isms', 'qms'], warnings: [{ rule: 'BR-17', messages: { en: 'Owner', id: 'Pemilik' } }] }),
      ],
      'POST /api/v1/ms/isms/metrics/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b/values': problem(400, 'validation', { errors: [{ path: 'body.periodEnd', message: 'periodEnd is before periodStart' }] }),
    });
    const created = await adapter.create('isms', 'assets', { code: 'AS-12', title: 'Hypervisor', ownerHandle: 'bagus' }, 'key-1');
    expect(created).toMatchObject({ ok: true, data: { changed: ['isms'], ref: { code: 'AS-12' } } });
    expect(calls[0]).toMatchObject({ method: 'POST', body: { code: 'AS-12', title: 'Hypervisor', ownerHandle: 'bagus' } });
    expect(calls[0].headers['idempotency-key']).toBe('key-1');
    expect(calls[0].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    const refused = await adapter.update('isms', 'risks', RISK, { likelihood: 2 });
    expect(refused).toMatchObject({ ok: false, error: { status: 409, slug: 'confirmation-required', rule: 'BR-22', message: ['R-014 is shared with QMS', 'R-014 dibagi dengan QMS'] } });
    expect(calls[1].headers['if-match']).toBe('W/"1790000000000"');
    const ok = await adapter.update('isms', 'risks', RISK, { likelihood: 2, confirm: true });
    expect(ok).toMatchObject({ ok: true, data: { changed: ['isms', 'qms'], warnings: [['Owner', 'Pemilik']] } });
    expect(calls[2].body).toEqual({ likelihood: 2, confirm: true });
    const bad = await adapter.recordValue('isms', RISK, { periodStart: '2026-09-30', periodEnd: '2026-09-01', value: 1 }, 'key-2');
    expect(bad).toMatchObject({ ok: false, error: { status: 400, errors: [{ path: 'body.periodEnd', message: 'periodEnd is before periodStart' }] } });
  });

  it('reads the treatments of a risk as chain records of the treatment stage, with the status of a move made on screen', async () => {
    const records = [
      record('T-014', '9b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e', 'Report implementation progress', ['R-014']),
      record('T-022', '1b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e', null, ['R-014'], 'yusuf'),
      record('T-031', '2b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e', 'Approve the treatment', ['R-031']),
    ];
    const { adapter, calls } = api({
      'GET /api/v1/ms/isms/audit/stages/treatment/records': json({ items: records, page: 1, pageSize: 200, total: 3 }),
      'POST /api/v1/ms/isms/treatments/9b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e/transitions': json({ ok: true, changed: ['isms'] }),
    });
    const res = await adapter.treatments('isms', RISK);
    expect(res.ok && res.data.map((t) => [t.code, t.status, t.owner, t.target])).toEqual([['T-014', 'in_progress', 'bagus', 'A.8.2'], ['T-022', 'done', 'yusuf', 'A.8.2']]);
    expect(calls).toHaveLength(1);
    const t014 = res.ok ? res.data[0] : null;
    const moved = await adapter.moveTreatment('isms', RISK, t014!, 'implemented');
    expect(moved.ok).toBe(true);
    expect(calls[1]).toMatchObject({ method: 'POST', body: { to: 'implemented' } });
    expect(calls[1].headers['if-match']).toBe('W/"1790000000000"');
    // The record now has no pending action; the move made here says it is implemented, by rina.
    expect(treatmentOf('ndt', 'isms', { ...records[0], action: null } as never)).toMatchObject({ status: 'implemented', implementedBy: 'rina' });
    // The move is kept for this organisation only.
    expect(treatmentOf('other-org', 'isms', { ...records[0], action: null } as never)).toMatchObject({ status: 'done', implementedBy: null });
    // When another change gives it a pending action again, the record wins.
    expect(treatmentOf('ndt', 'isms', { ...records[0], action: 'Approve the treatment' } as never)).toMatchObject({ status: 'proposed', implementedBy: null });
    // Treatment codes are unique per system: the codes of every risk's treatments.
    expect(await adapter.treatmentCodes('isms')).toEqual({ ok: true, data: ['T-014', 'T-022', 'T-031'] });
  });

  it('a create refused after the option change keeps the change and its ETag, so the next try sends neither again', async () => {
    const risk = { ...RISK, treatmentOption: null, ms: ['isms'] } as RowModel;
    const riskRef = (etag: string) => ({ ...REF('risk', 'R-014'), etag });
    const { adapter, calls } = api({
      'PATCH /api/v1/ms/isms/registers/risks/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b': [
        json({ ok: true, changed: ['isms'], ref: riskRef('W/"1790000000999"') }),
        json({ ok: true, changed: ['isms'], ref: riskRef('W/"1790000001000"') }),
      ],
      'POST /api/v1/ms/isms/risks/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b/treatments': [
        problem(409, 'conflict', { messageKey: 'register.duplicate_code', messages: { en: 'T-014 already exists in this system', id: 'T-014 sudah ada di sistem ini' } }),
        json({ ok: true, changed: ['isms'], ref: REF('risk_treatment', 'T-040') }, 201),
      ],
    });
    const form = { option: 'modify', code: 'T-014', title: 'Deploy PAM', owner: 'bagus', due: '2026-12-15', target: 'A.8.2' };
    const first = await tryAddTreatment(adapter, 'isms', risk, form, [], 'key-5');
    expect(first.result).toMatchObject({ ok: false, error: { status: 409, messageKey: 'register.duplicate_code' } });
    expect(first.optionChanged).toMatchObject({ changed: ['isms'] });
    expect(first.risk).toMatchObject({ treatmentOption: 'modify', etag: 'W/"1790000000999"' });
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST']);
    expect(calls[0].headers['if-match']).toBe('W/"1790000000000"');
    expect(calls[0].body).toEqual({ treatmentOption: 'modify' });
    // The retry with the risk the first try answered sends the create only.
    const second = await tryAddTreatment(adapter, 'isms', first.risk, { ...form, code: 'T-040' }, [], 'key-5');
    expect(second.result).toMatchObject({ ok: true, data: { ref: { code: 'T-040' } } });
    expect(second.optionChanged).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST', 'POST']);
    // Another option is sent with the ETag the first change answered.
    await tryAddTreatment(adapter, 'isms', first.risk, { ...form, option: 'avoid', code: 'T-041' }, [], 'key-6');
    expect(calls[3]).toMatchObject({ method: 'PATCH', body: { treatmentOption: 'avoid' } });
    expect(calls[3].headers['if-match']).toBe('W/"1790000000999"');
  });

  it('a shared risk changes its option with confirm, and the create names the systems of both writes', async () => {
    const { adapter, calls } = api({
      'PATCH /api/v1/ms/isms/registers/risks/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b': json({ ok: true, changed: ['isms', 'qms'], ref: REF('risk', 'R-014') }),
      'POST /api/v1/ms/isms/risks/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b/treatments': json({ ok: true, changed: ['isms'], ref: REF('risk_treatment', 'T-040') }, 201),
    });
    const run = await tryAddTreatment(adapter, 'isms', RISK, { option: 'avoid', code: 'T-040', title: 'Stop the service', owner: 'bagus', due: '2026-12-15', target: 'A.8.2' }, [], 'key-7');
    expect(calls[0].body).toEqual({ treatmentOption: 'avoid', confirm: true });
    expect(run.result).toMatchObject({ ok: true, data: { changed: ['isms', 'qms'], ref: { code: 'T-040' } } });
    // The option the risk already has is not sent again.
    await tryAddTreatment(adapter, 'isms', RISK, { option: 'modify', code: 'T-041', title: 'Deploy PAM', owner: 'bagus', due: '2026-12-15', target: 'A.8.2' }, [], 'key-8');
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST', 'POST']);
  });

  it('finds the treatment stage by reading each entity stage once when no open treatment names it', async () => {
    const empty = { ...D_API, X: {}, refs: {} } as unknown as ControllerData;
    const { adapter, calls } = api({
      'GET /api/v1/ms/isms/audit/stages/context/records': json({ items: [{ ...record('CI-02', '3b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e', null, []), ref: { ...REF('context_issue', 'CI-02'), stage: 'context' } }], page: 1, pageSize: 1, total: 4 }),
      'GET /api/v1/ms/isms/audit/stages/risk/records': json({ items: [{ ...record('R-014', '4b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e', null, []), ref: { ...REF('risk', 'R-014'), stage: 'risk' } }], page: 1, pageSize: 1, total: 6 }),
      'GET /api/v1/ms/isms/audit/stages/treatment/records': (req) => json({ items: [record('T-003', '5b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e', null, ['R-014'])], page: 1, pageSize: Number(new URL(req.url, 'http://x').searchParams.get('pageSize')), total: 1 }),
    }, () => empty);
    const res = await adapter.treatments('isms', RISK);
    expect(res.ok && res.data.map((t) => t.code)).toEqual(['T-003']);
    expect(calls.map((c) => c.path)).toEqual([
      '/api/v1/ms/isms/audit/stages/context/records', '/api/v1/ms/isms/audit/stages/risk/records', '/api/v1/ms/isms/audit/stages/treatment/records', '/api/v1/ms/isms/audit/stages/treatment/records',
    ]);
    await adapter.treatments('isms', RISK);
    expect(calls).toHaveLength(5);
  });

  it('adds treatments, accepts residual risk, links by code in the target system, and competence through linkedMs', async () => {
    const { adapter, calls } = api({
      'POST /api/v1/ms/isms/risks/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b/treatments': json({ ok: true, changed: ['isms'], ref: REF('risk_treatment', 'T-040') }, 201),
      'POST /api/v1/ms/isms/risks/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b/residual-acceptance': problem(422, 'business-rule', { rule: 'BR-04', messages: { en: 'The implementer cannot accept', id: 'Pelaksana tidak dapat menerima' } }),
      'POST /api/v1/ms/bcms/entity-links': json({ ok: true, changed: ['isms', 'bcms'], data: { linkId: '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f' } }, 201),
      'PATCH /api/v1/ms/isms/registers/competence/8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b': json({ ok: true, changed: ['isms', 'qms'] }),
    });
    const body = { riskCode: 'R-014', code: 'T-040', title: 'Deploy PAM', ownerHandle: 'bagus', targetType: 'catalogue_item' as const, targetCode: 'A.8.2', targetDate: '2026-12-15' };
    expect(await adapter.addTreatment('isms', RISK, body, 'key-3')).toMatchObject({ ok: true, data: { ref: { code: 'T-040' } } });
    expect(calls[0]).toMatchObject({ body });
    const refused = await adapter.acceptResidual('isms', RISK, { residualLikelihood: 1, residualConsequence: 3, note: 'PAM in place' }, 'key-4');
    expect(refused).toMatchObject({ ok: false, error: { status: 422, rule: 'BR-04', message: ['The implementer cannot accept', 'Pelaksana tidak dapat menerima'] } });
    expect(await adapter.link('isms', 'risks', RISK, 'bcms', ' Also a continuity risk ')).toMatchObject({ ok: true, data: { changed: ['isms', 'bcms'] } });
    expect(calls[2].body).toEqual({ entityType: 'risk', entityCode: 'R-014', relevanceNote: 'Also a continuity risk' });
    await adapter.link('isms', 'competence', { ...RISK, ms: ['isms'] }, 'qms', '');
    expect(calls[3]).toMatchObject({ method: 'PATCH', body: { linkedMs: ['isms', 'qms'], confirm: true } });
  });

  it('lists live targets, keeps a proof file with an evidence record and opens it', async () => {
    const { adapter, calls } = api({
      'GET /api/v1/ms/isms/applicability/targets': json([
        { kind: 'catalogue_item', code: 'A.8.2', title: 'Privileged access rights', clauseGroup: '8', hasEntry: true, retired: false, assessable: true, documentedInfo: false },
        { kind: 'requirement', code: '6.1.3', title: 'Risk treatment', clauseGroup: '6', hasEntry: true, retired: false, assessable: false, documentedInfo: true },
        { kind: 'catalogue_item', code: 'A.9.9', title: 'Retired', clauseGroup: null, hasEntry: false, retired: true, assessable: true, documentedInfo: false },
      ]),
      'POST /api/v1/ms/isms/evidence/6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d/files': json({ ok: true, changed: ['isms'], data: { storageObjectId: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f', versionLabel: 'v4' } }, 201),
      'GET /api/v1/storage/objects/6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f/open': json({ url: '/api/v1/storage/objects/x/redirect?t=abc', expiresAt: '2026-09-29T06:05:00Z' }),
    });
    expect(await adapter.targets('isms')).toEqual({ ok: true, data: [{ kind: 'catalogue_item', code: 'A.8.2', title: 'Privileged access rights' }, { kind: 'requirement', code: '6.1.3', title: 'Risk treatment' }] });
    // Only an evidence record of competence keeps a proof: the backup log of A.8.13 is never offered.
    expect(adapter.proofHolders('isms')).toEqual([{ id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', code: 'EV-0217', title: 'Awareness training attendance', hasFile: true }]);
    const attached = await adapter.attachProof('isms', adapter.proofHolders('isms')[0], { source: 'link', repository: 'sp', externalItemId: 'demo-sp-picker-1', fileName: 'Certificate.pdf' });
    expect(attached).toEqual({ ok: true, data: { storageObjectId: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f', fileName: 'Certificate.pdf' } });
    expect(calls[1].body).toEqual({ source: 'link', repository: 'sp', externalItemId: 'demo-sp-picker-1', mode: 'submit' });
    await adapter.attachProof('isms', adapter.proofHolders('isms')[0], { source: 'upload', uploadIntentId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e', fileName: 'Scan.pdf' });
    expect(calls[2].body).toEqual({ source: 'upload', uploadIntentId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e', mode: 'submit' });
    expect(await adapter.openProof('isms', { ...RISK, proofObjectId: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f' })).toEqual({ ok: true, data: '/api/v1/storage/objects/x/redirect?t=abc' });
    expect(new URL(calls[3].url, 'http://x').searchParams.get('ms')).toBe('isms');
  });

  it('keeps the treatment stage per organisation, so a slug of another organisation reads its own stage', async () => {
    // Organisation A uses `isms` for a system whose treatments are the `action` stage; organisation B for one whose
    // treatments are the `treatment` stage. Switching organisation reloads the snapshot without a page reload.
    const orgA = {
      ...D_API, STAGES: { isms: [{ id: 'risk', l: ['Risk', 'Risiko'], q: '' }, { id: 'action', l: ['Action', 'Tindakan'], q: '' }] },
      X: { isms: { action: [{ id: 'T-001', t: 'Supplier review', act: 'Approve the treatment', h: 'bagus', due: '2026-09-15', up: ['R-014'] }] } },
      refs: { 'isms:x:T-001': REF('risk_treatment', 'T-001', '7b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e') },
    } as unknown as ControllerData;
    let org = 'org-a';
    const { adapter, calls } = api({
      'GET /api/v1/ms/isms/audit/stages/action/records': json({ items: [{ ...record('T-001', '7b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e', 'Approve the treatment', ['R-014']), ref: { ...REF('risk_treatment', 'T-001', '7b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e'), stage: 'action' } }], page: 1, pageSize: 200, total: 1 }),
      'GET /api/v1/ms/isms/audit/stages/treatment/records': json({ items: [record('T-014', '9b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e', 'Report implementation progress', ['R-014'])], page: 1, pageSize: 200, total: 1 }),
    }, () => (org === 'org-a' ? orgA : D_API), () => org);
    const a = await adapter.treatments('isms', RISK);
    expect(a.ok && a.data.map((t) => t.code)).toEqual(['T-001']);
    org = 'org-b';
    const b = await adapter.treatments('isms', RISK);
    expect(b.ok && b.data.map((t) => [t.code, t.status])).toEqual([['T-014', 'in_progress']]);
    expect(await adapter.treatmentCodes('isms')).toEqual({ ok: true, data: ['T-014'] });
    org = 'org-a';
    expect(await adapter.treatmentCodes('isms')).toEqual({ ok: true, data: ['T-001'] });
    expect(calls.map((c) => c.path.split('/')[7])).toEqual(['action', 'treatment', 'treatment', 'action']);
  });
});

describe('the competence proof file is attached only after the register write went through', () => {
  const COMPETENCE_ID = '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b';
  const NEW_ID = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
  const STORED = '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f';
  const EVIDENCE_FILES = 'POST /api/v1/ms/isms/evidence/6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d/files';
  const D_PROOF = {
    ...D,
    refs: { 'isms:ev:EV-0217': REF('evidence', 'EV-0217', '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d') },
    bundles: { isms: { evs: [{ code: 'EV-0217', ctrl: 'A.6.3', title: 'Awareness training attendance', loc: 'sp' }] } },
  } as unknown as ControllerData;
  const competence: RowModel = {
    id: COMPETENCE_ID, etag: 'W/"1790000000000"', code: 'CMP-8A1F2D3C', title: 'Internal auditor', owner: 'rina', status: 'ready', updatedAt: '2026-09-10T04:00:00Z',
    shared: true, ms: ['isms', 'qms'], personHandle: 'maya', competenceRequired: 'Lead auditor training', proofType: 'certificate', proofObjectId: null, validUntil: '2028-03-14',
  };
  const file = { source: 'link' as const, repository: 'sp', externalItemId: 'demo-sp-picker-1', fileName: 'Certificate.pdf' };
  const ref = (id: string, etag: string) => ({ ...REF('competence_record', 'CMP-8A1F2D3C', id), etag });
  const stored = json({ ok: true, changed: ['isms'], data: { storageObjectId: STORED, versionLabel: 'v4' } }, 201);
  const api = (routes: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(routes);
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client, { getD: () => D_PROOF, me: () => 'rina', org: () => 'ndt' });
    const holder = adapter.proofHolders('isms')[0];
    const attachCalls = () => f.calls.filter((c) => `${c.method} ${c.path}` === EVIDENCE_FILES);
    return { ...f, adapter, holder, attachCalls };
  };
  const input = (over: Partial<RowSaveInput> & Pick<RowSaveInput, 'proof'>): RowSaveInput => ({
    kind: 'competence', row: competence, create: null, patch: null, confirm: false, attached: null, idempotencyKey: 'key-9', ...over,
  });

  it('a BR-22 confirmation that is cancelled, a stale ETag and a refused create send no evidence.files call', async () => {
    const { adapter, holder, calls, attachCalls } = api({
      [`PATCH /api/v1/ms/isms/registers/competence/${COMPETENCE_ID}`]: [
        problem(409, 'confirmation-required', { rule: 'BR-22', messages: { en: 'CMP-8A1F2D3C is shared with QMS', id: 'CMP-8A1F2D3C dibagi dengan QMS' } }),
        problem(409, 'confirmation-required', { rule: 'BR-22', messages: { en: 'CMP-8A1F2D3C is shared with QMS', id: 'CMP-8A1F2D3C dibagi dengan QMS' } }),
        problem(412, 'precondition-failed'),
      ],
      'POST /api/v1/ms/isms/registers/competence': [
        problem(422, 'business-rule', { rule: 'NOT-A-MEMBER', messages: { en: 'maya is not a member of this organisation', id: 'maya bukan anggota organisasi ini' } }),
        problem(400, 'validation', { errors: [{ path: 'body.title', message: 'A role has at most 150 characters' }] }),
      ],
      [EVIDENCE_FILES]: stored,
    });
    const proof = { holder, file };
    // Edit of a shared record with a changed field and a proof: the server asks for the BR-22 confirmation first.
    const changed = await trySaveRow(adapter, 'isms', input({ patch: { validUntil: '2029-03-14' }, proof }));
    expect(changed.result).toMatchObject({ ok: false, error: { status: 409, slug: 'confirmation-required', rule: 'BR-22' } });
    expect(calls.map((c) => [c.method, c.body])).toEqual([['PATCH', { validUntil: '2029-03-14' }]]);
    // Cancel in the confirmation sends nothing more, so the evidence record keeps its file.
    expect(attachCalls()).toHaveLength(0);
    // Only the proof changes: the role is sent unchanged, so the server checks BR-22 before any file moves.
    const proofOnly = await trySaveRow(adapter, 'isms', input({ proof }));
    expect(proofOnly.result).toMatchObject({ ok: false, error: { slug: 'confirmation-required' } });
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: { title: 'Internal auditor' } });
    expect(calls[1].headers['if-match']).toBe('W/"1790000000000"');
    // A record changed by someone else since it was read.
    const stale = await trySaveRow(adapter, 'isms', input({ patch: { validUntil: '2029-03-14' }, confirm: true, proof }));
    expect(stale.result).toMatchObject({ ok: false, error: { status: 412 } });
    expect(stale.attached).toBeNull();
    // A create the server refuses: a person who is not a member, a role over 150 characters.
    const body = { title: 'Internal auditor', ownerHandle: 'rina', personHandle: 'maya', competenceRequired: 'Lead auditor training', proofType: 'certificate' as const };
    const notMember = await trySaveRow(adapter, 'isms', input({ row: null, create: body, proof }));
    expect(notMember.result).toMatchObject({ ok: false, error: { status: 422, rule: 'NOT-A-MEMBER' } });
    const invalid = await trySaveRow(adapter, 'isms', input({ row: null, create: { ...body, title: 'x'.repeat(151) }, proof }));
    expect(invalid.result).toMatchObject({ ok: false, error: { status: 400 } });
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'PATCH', 'PATCH', 'POST', 'POST']);
    expect(attachCalls()).toHaveLength(0);
  });

  it('writes the record first, then attaches the file and points the record to it with the ETag of the first write', async () => {
    const { adapter, holder, calls } = api({
      'POST /api/v1/ms/isms/registers/competence': json({ ok: true, changed: ['isms'], ref: ref(NEW_ID, 'W/"1790000000500"') }, 201),
      [EVIDENCE_FILES]: stored,
      [`PATCH /api/v1/ms/isms/registers/competence/${NEW_ID}`]: json({ ok: true, changed: ['isms'], ref: ref(NEW_ID, 'W/"1790000000600"') }),
      [`PATCH /api/v1/ms/isms/registers/competence/${COMPETENCE_ID}`]: [
        json({ ok: true, changed: ['isms', 'qms'], ref: ref(COMPETENCE_ID, 'W/"1790000000700"') }),
        json({ ok: true, changed: ['isms', 'qms'], ref: ref(COMPETENCE_ID, 'W/"1790000000800"'), warnings: [{ rule: 'BR-23', messages: { en: 'Renew soon', id: 'Segera perbarui' } }] }),
      ],
    });
    const create = createBody('competence', { ...emptyForm('competence', [], 'rina', '2026-09-29'), title: 'Internal auditor', personHandle: 'maya', competenceRequired: 'Lead auditor training' }, { ownerFixed: false, me: 'rina' });
    const added = await trySaveRow(adapter, 'isms', input({ row: null, create, proof: { holder, file } }));
    expect(added.result).toMatchObject({ ok: true, data: { changed: ['isms'], warnings: [], message: null, ref: { code: 'CMP-8A1F2D3C', etag: 'W/"1790000000600"' } } });
    expect(added.attached).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/ms/isms/registers/competence', EVIDENCE_FILES, `PATCH /api/v1/ms/isms/registers/competence/${NEW_ID}`,
    ]);
    expect(calls[0].body).not.toHaveProperty('proofObjectId');
    expect(calls[2].body).toEqual({ proofObjectId: STORED });
    expect(calls[2].headers['if-match']).toBe('W/"1790000000500"');
    // A shared record after its BR-22 confirmation: both writes carry the confirmation, the second the newer ETag.
    const edited = await trySaveRow(adapter, 'isms', input({ patch: { validUntil: '2029-03-14' }, confirm: true, proof: { holder, file } }));
    expect(edited.result).toMatchObject({ ok: true, data: { changed: ['isms', 'qms'], warnings: [['Renew soon', 'Segera perbarui']] } });
    expect(calls.slice(3).map((c) => [c.method, c.body])).toEqual([
      ['PATCH', { validUntil: '2029-03-14', confirm: true }], ['POST', { source: 'link', repository: 'sp', externalItemId: 'demo-sp-picker-1', mode: 'submit' }], ['PATCH', { proofObjectId: STORED, confirm: true }],
    ]);
    expect(calls[5].headers['if-match']).toBe('W/"1790000000700"');
  });

  it('a refused proof step keeps the saved record with a warning, and a proof-only edit reuses the attached file on the next try', async () => {
    const { adapter, holder, calls, attachCalls } = api({
      'POST /api/v1/ms/isms/registers/competence': json({ ok: true, changed: ['isms'], ref: ref(NEW_ID, 'W/"1790000000500"') }, 201),
      [EVIDENCE_FILES]: [
        problem(403, 'forbidden', { messages: { en: 'You cannot submit evidence files', id: 'Anda tidak dapat mengirim berkas bukti' } }),
        stored,
      ],
      [`PATCH /api/v1/ms/isms/registers/competence/${NEW_ID}`]: problem(422, 'business-rule', { messageKey: 'register.unknown_proof', messages: { en: 'The proof file is not stored in this organisation', id: 'Berkas bukti tidak tersimpan di organisasi ini' } }),
      [`PATCH /api/v1/ms/isms/registers/competence/${COMPETENCE_ID}`]: [
        json({ ok: true, changed: ['isms', 'qms'], message: ['Nothing to change', 'Tidak ada yang diubah'], ref: ref(COMPETENCE_ID, 'W/"1790000000000"') }),
        problem(412, 'precondition-failed'),
        json({ ok: true, changed: ['isms', 'qms'], message: ['Nothing to change', 'Tidak ada yang diubah'], ref: ref(COMPETENCE_ID, 'W/"1790000000000"') }),
        json({ ok: true, changed: ['isms', 'qms'], ref: ref(COMPETENCE_ID, 'W/"1790000000900"') }),
      ],
    });
    const create = { title: 'Internal auditor', ownerHandle: 'rina', personHandle: 'maya', competenceRequired: 'Lead auditor training', proofType: 'certificate' as const };
    // The file cannot be attached: the record is saved, without its proof, and the warning says why.
    const noFile = await trySaveRow(adapter, 'isms', input({ row: null, create, proof: { holder, file } }));
    expect(noFile.result).toMatchObject({ ok: true, data: { ref: { code: 'CMP-8A1F2D3C' } } });
    expect(noFile.result.ok && noFile.result.data.warnings).toEqual([[
      'CMP-8A1F2D3C is saved without its proof file. You cannot submit evidence files. Open the record, choose the file again and save.',
      'CMP-8A1F2D3C tersimpan tanpa berkas bukti. Anda tidak dapat mengirim berkas bukti. Buka catatan ini, pilih berkasnya lagi, lalu simpan.',
    ]]);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
    // The file is attached but the record refuses it: the record is saved, the warning names the evidence record, and
    // the stored file is handed back for the next Edit of the new record.
    const notLinked = await trySaveRow(adapter, 'isms', input({ row: null, create, proof: { holder, file } }));
    expect(notLinked.result.ok && notLinked.result.data.warnings[0][0]).toBe(
      'CMP-8A1F2D3C is saved without its proof file. The proof file is not stored in this organisation. The chosen file is already the current file of EV-0217. Open CMP-8A1F2D3C and save it again: the form has that file chosen and links it without adding it to EV-0217 a second time.',
    );
    expect(notLinked.attached).toEqual({ file, holder: holder.id, storageObjectId: STORED });
    expect(notLinked.recordId).toBe(NEW_ID);
    expect(noFile.attached).toBeNull();
    expect(attachCalls()).toHaveLength(2);
    // Only the proof changes and its patch is refused after the attach: the form keeps the stored object, and the
    // next try sends the check and the patch again without attaching the file a second time.
    const first = await trySaveRow(adapter, 'isms', input({ proof: { holder, file } }));
    expect(first.result).toMatchObject({ ok: false, error: { status: 412 } });
    expect(first.attached).toEqual({ file, holder: holder.id, storageObjectId: STORED });
    expect(attachCalls()).toHaveLength(3);
    const again = await trySaveRow(adapter, 'isms', input({ proof: { holder, file }, attached: first.attached }));
    expect(again.result).toMatchObject({ ok: true, data: { message: null, ref: { etag: 'W/"1790000000900"' } } });
    expect(attachCalls()).toHaveLength(3);
    expect(calls.slice(-2).map((c) => c.body)).toEqual([{ title: 'Internal auditor' }, { proofObjectId: STORED }]);
    // Another file picked after that is attached on its own.
    const other = { ...file, externalItemId: 'demo-sp-picker-2', fileName: 'Renewed.pdf' };
    expect((await trySaveRow(adapter, 'isms', input({ proof: { holder, file: other }, attached: first.attached }))).result.ok).toBe(true);
    expect(attachCalls()).toHaveLength(4);
    expect(attachCalls()[3].body).toMatchObject({ externalItemId: 'demo-sp-picker-2' });
  });

  it('a proof the record refused after a saved change is attached once: the next Edit starts with it and links it', async () => {
    const { adapter, holder, calls, attachCalls } = api({
      [EVIDENCE_FILES]: stored,
      [`PATCH /api/v1/ms/isms/registers/competence/${COMPETENCE_ID}`]: [
        json({ ok: true, changed: ['isms', 'qms'], ref: ref(COMPETENCE_ID, 'W/"1790000000700"') }),
        problem(403, 'forbidden', { messages: { en: 'You cannot change the proof of this record', id: 'Anda tidak dapat mengubah bukti catatan ini' } }),
        json({ ok: true, changed: ['isms', 'qms'], message: ['Nothing to change', 'Tidak ada yang diubah'], ref: ref(COMPETENCE_ID, 'W/"1790000000700"') }),
        problem(403, 'forbidden', { messages: { en: 'You cannot change the proof of this record', id: 'Anda tidak dapat mengubah bukti catatan ini' } }),
        json({ ok: true, changed: ['isms', 'qms'], message: ['Nothing to change', 'Tidak ada yang diubah'], ref: ref(COMPETENCE_ID, 'W/"1790000000700"') }),
        json({ ok: true, changed: ['isms', 'qms'], ref: ref(COMPETENCE_ID, 'W/"1790000000800"') }),
      ],
    });
    const ctx = apiCtx('rina', ['ms_manager'], ['ms.read', 'register.manage']);
    const key = proofKey(ctx, 'isms', COMPETENCE_ID);
    // The changed field is saved, the file is attached, and the record refuses to point to it.
    const saved = await trySaveRow(adapter, 'isms', input({ patch: { validUntil: '2029-03-14' }, confirm: true, proof: { holder, file } }));
    expect(saved.result.ok && saved.result.data.warnings[0][0]).toContain('Open CMP-8A1F2D3C and save it again');
    rememberProof(ctx, 'isms', saved);
    expect(unlinkedProof(key)).toEqual({ file, holder: holder.id, storageObjectId: STORED });
    expect(attachCalls()).toHaveLength(1);
    // The next Edit of the record starts with that file chosen and says that saving links it.
    const record = { ...competence, etag: 'W/"1790000000700"', validUntil: '2029-03-14' };
    const html = render(<RowFormDrawer ctx={ctx} adapter={adapter} ms="isms" kind="competence" row={record} codes={[]} onClose={vi.fn()} onSaved={vi.fn()} />, ctx);
    expect(html).toContain('Chosen: Certificate.pdf');
    expect(html).toContain('Certificate.pdf is already the current file of EV-0217, but this record does not point to it yet. Save to link it.');
    expect(html).not.toContain('Saving puts the chosen file in its place');
    // The same refusal again: the stored file is sent again and nothing more is attached.
    const kept = unlinkedProof(key);
    const refused = await trySaveRow(adapter, 'isms', input({ row: record, proof: { holder, file: kept!.file }, attached: kept }));
    expect(refused.result).toMatchObject({ ok: false, error: { status: 403 } });
    rememberProof(ctx, 'isms', refused);
    expect(unlinkedProof(key)).toEqual(kept);
    expect(attachCalls()).toHaveLength(1);
    // Once the record points to the file, nothing waits to be linked.
    const linked = await trySaveRow(adapter, 'isms', input({ row: record, proof: { holder, file: kept!.file }, attached: kept }));
    expect(linked.result).toMatchObject({ ok: true, data: { ref: { etag: 'W/"1790000000800"' } } });
    rememberProof(ctx, 'isms', linked);
    expect(unlinkedProof(key)).toBeNull();
    expect(attachCalls()).toHaveLength(1);
    expect(calls.slice(-2).map((c) => c.body)).toEqual([{ title: 'Internal auditor' }, { proofObjectId: STORED }]);
    // The kept file belongs to the session person: another person's Edit starts without it.
    keepUnlinkedProof(key, kept);
    expect(unlinkedProof(proofKey(apiCtx('bagus', ['ms_manager'], ['ms.read', 'register.manage']), 'isms', COMPETENCE_ID))).toBeNull();
  });
});

describe('registers sample adapter', () => {
  const scopeOf = (getD: () => ControllerData, role: 'manager' | 'owner' | 'auditor' | 'top' = 'manager', me = 'rina', ds: DataSource | null = null) => ({
    getD, me: () => me, role: () => role, ds: () => ds,
  });

  it('builds the registers of the sample ISMS from the snapshot', async () => {
    const a = createSampleAdapter(scopeOf(() => D));
    const page = async (kind: Parameters<RegistersAdapter['list']>[1]) => {
      const res = await a.list('isms', kind, { page: 1, pageSize: 50 });
      if (!res.ok) throw new Error('list failed');
      return res.data;
    };
    expect((await page('context-issues')).items.map((r) => r.code)).toEqual(['CI-09', 'CI-02', 'CI-05', 'CI-03', 'CI-01']);
    const risks = await page('risks');
    expect(risks.items.map((r) => r.code)).toEqual(['R-031', 'R-014', 'R-022', 'R-027', 'R-035', 'R-003']);
    expect(risks.items.find((r) => r.code === 'R-014')).toMatchObject({ owner: 'bagus', status: 'open', riskProfileCode: 'information_security' });
    expect((await page('metrics')).total).toBe(6);
    expect((await page('assets')).items.find((r) => r.code === 'AS-02')).toMatchObject({ ms: ['isms', 'bcms'], shared: true, classification: 'confidential' });
    const competence = (await page('competence')).items;
    expect(competence.map((r) => r.personHandle)).toEqual(['maya', 'bagus', 'dewi']);
    expect(competence[0].code).toBe(competenceCode(sampleId('competence:maya-auditor')));
    expect(competence[1].status).toBe('open');
    const r003 = risks.items.find((r) => r.code === 'R-003')!;
    const treatments = await a.treatments('isms', r003);
    expect(treatments.ok && treatments.data.map((t) => [t.code, t.status, t.implementedBy])).toEqual([['T-003', 'implemented', 'bagus']]);
    const searched = await a.list('isms', 'risks', { q: 'bagus', page: 1, pageSize: 50 });
    expect(searched.ok && searched.data.items.map((r) => r.code)).toEqual(['R-014']);
  });

  it('applies BR-17, duplicate codes and BR-22 to new and changed rows', async () => {
    const a = createSampleAdapter(scopeOf(() => D));
    expect(await a.create('isms', 'risks', { code: 'R-040', title: 'Backup site', ownerHandle: 'none' }, 'k')).toMatchObject({ ok: false, error: { status: 422, rule: 'BR-17' } });
    expect(await a.create('isms', 'risks', { code: 'R-014', title: 'Again', ownerHandle: 'bagus' }, 'k')).toMatchObject({ ok: false, error: { status: 409, messageKey: 'register.duplicate_code' } });
    const added = await a.create('isms', 'risks', { code: 'R-040', title: 'Backup site', ownerHandle: 'bagus', likelihood: 2, consequence: 5 }, 'k');
    expect(added).toMatchObject({ ok: true, data: { ref: { code: 'R-040' } } });
    const list = await a.list('isms', 'risks', { page: 1, pageSize: 50 });
    const row = list.ok ? list.data.items.find((r) => r.code === 'R-040')! : null;
    expect(row).toMatchObject({ status: 'open', likelihood: 2, owner: 'bagus' });
    const assets = await a.list('isms', 'assets', { page: 1, pageSize: 50 });
    const shared = assets.ok ? assets.data.items.find((r) => r.code === 'AS-02')! : null;
    expect(await a.update('isms', 'assets', shared!, { classification: 'restricted' })).toMatchObject({ ok: false, error: { status: 409, slug: 'confirmation-required', rule: 'BR-22' } });
    expect((await a.update('isms', 'assets', shared!, { classification: 'restricted', confirm: true })).ok).toBe(true);
    expect((await a.update('isms', 'assets', shared!, { linkedMs: ['bcms', 'isms'], confirm: true })).ok).toBe(true);
    const after = await a.list('isms', 'assets', { page: 1, pageSize: 50 });
    expect(after.ok && after.data.items.find((r) => r.code === 'AS-02')).toMatchObject({ classification: 'restricted', ms: ['bcms', 'isms'] });
  });

  it('moves treatments along C.13, refuses closing before the residual acceptance (BR-04), and lets only the risk owner accept', async () => {
    const a = createSampleAdapter(scopeOf(() => D));
    const risks = await a.list('isms', 'risks', { page: 1, pageSize: 50 });
    const r031 = risks.ok ? risks.data.items.find((r) => r.code === 'R-031')! : null;
    const t = await a.addTreatment('isms', r031!, { riskCode: 'R-031', code: 'T-131', title: 'Patch the hypervisors', ownerHandle: 'bagus', targetType: 'catalogue_item', targetCode: 'A.8.8', targetDate: '2026-12-15' }, 'k');
    expect(t.ok).toBe(true);
    const list = async () => {
      const res = await a.treatments('isms', r031!);
      return res.ok ? res.data.find((x) => x.code === 'T-131')! : null;
    };
    expect(await list()).toMatchObject({ status: 'proposed' });
    expect(await a.moveTreatment('isms', r031!, (await list())!, 'implemented')).toMatchObject({ ok: false, error: { status: 409 } });
    for (const to of ['approved', 'in_progress', 'implemented'] as const) expect((await a.moveTreatment('isms', r031!, (await list())!, to)).ok).toBe(true);
    expect(await list()).toMatchObject({ status: 'implemented', implementedBy: 'rina' });
    expect(await a.moveTreatment('isms', r031!, (await list())!, 'closed')).toMatchObject({ ok: false, error: { status: 422, rule: 'BR-04' } });
    // rina owns R-031 but implemented the treatment herself: BR-04.
    expect(await a.acceptResidual('isms', r031!, { residualLikelihood: 1, residualConsequence: 2, note: 'Patched' }, 'k')).toMatchObject({ ok: false, error: { rule: 'BR-04' } });
    // R-003 is rina's and bagus implemented T-003: she accepts, then T-003 closes.
    const r003 = risks.ok ? risks.data.items.find((r) => r.code === 'R-003')! : null;
    expect((await a.acceptResidual('isms', r003!, { residualLikelihood: 1, residualConsequence: 2, note: 'Quarterly review works' }, 'k')).ok).toBe(true);
    const t003 = await a.treatments('isms', r003!);
    expect(t003.ok && t003.data[0].status).toBe('residual_accepted');
    expect((await a.moveTreatment('isms', r003!, t003.ok ? t003.data[0] : (null as never), 'closed')).ok).toBe(true);
    const r022 = risks.ok ? risks.data.items.find((r) => r.code === 'R-022')! : null;
    expect(await a.acceptResidual('isms', r022!, { residualLikelihood: 1, residualConsequence: 2, note: 'x' }, 'k')).toMatchObject({ ok: false, error: { status: 403 } });
    // Treatment codes are unique per system: the codes of every risk's treatments, the new one included.
    const codes = await a.treatmentCodes('isms');
    expect(codes.ok && codes.data).toEqual(expect.arrayContaining(['T-003', 'T-131']));
    expect(treatmentCode(r031!, codes.ok ? codes.data : [])).not.toMatch(/^T-(003|131)$/);
  });

  it('records metric values without overlapping periods and keeps competence of other people to the full read scope (H.5)', async () => {
    const a = createSampleAdapter(scopeOf(() => D));
    const metrics = await a.list('isms', 'metrics', { page: 1, pageSize: 50 });
    const m07 = metrics.ok ? metrics.data.items.find((r) => r.code === 'M-07')! : null;
    expect((await a.recordValue('isms', m07!, { periodStart: '2026-09-01', periodEnd: '2026-09-28', value: 97 }, 'k')).ok).toBe(true);
    expect(await a.recordValue('isms', m07!, { periodStart: '2026-09-15', periodEnd: '2026-09-30', value: 98 }, 'k')).toMatchObject({ ok: false, error: { status: 422, messageKey: 'metric.period_overlap' } });
    const after = await a.list('isms', 'metrics', { page: 1, pageSize: 50 });
    expect(after.ok && after.data.items.find((r) => r.code === 'M-07')).toMatchObject({ status: 'ready', lastMeasuredAt: '2026-09-28' });
    const bagus = createSampleAdapter(scopeOf(() => D, 'owner', 'bagus'));
    const own = await bagus.list('isms', 'competence', { page: 1, pageSize: 50 });
    expect(own.ok && own.data.items.map((r) => r.personHandle)).toEqual(['bagus']);
    const maya = createSampleAdapter(scopeOf(() => D, 'auditor', 'maya'));
    const all = await maya.list('isms', 'competence', { page: 1, pageSize: 50 });
    expect(all.ok && all.data.total).toBe(3);
    const hendra = createSampleAdapter(scopeOf(() => D, 'top', 'hendra'));
    const risks = await hendra.list('isms', 'risks', { page: 1, pageSize: 50 });
    expect(risks.ok && risks.data.items.find((r) => r.code === 'R-014')).toMatchObject({ owner: 'none', nextReviewAt: null });
    expect(risks.ok && risks.data.items.find((r) => r.code === 'R-022')).toMatchObject({ owner: 'hendra' });
  });

  it('keeps each organisation its own registers and adds new risks to the sample chain records', async () => {
    const ds = createSampleDataSource();
    let snap = dataOf(await ds.load());
    const a = createSampleAdapter(scopeOf(() => snap, 'manager', 'rina', ds as unknown as DataSource));
    expect(sampleOrgKey(snap)).toBe('abms,bcms,isms,qms');
    const added = await a.create('isms', 'risks', { code: 'R-050', title: 'Ransomware on backups', ownerHandle: 'bagus' }, 'k');
    expect(added.ok && added.data.changed).toEqual(['isms']);
    snap = dataOf(await ds.reload(await ds.load(), ['isms']));
    expect(snap.X.isms.risk.map((x: { id: string }) => x.id)).toContain('R-050');
    expect((await a.create('isms', 'assets', { code: 'AS-50', title: 'Backup appliance', ownerHandle: 'bagus' }, 'k')).ok).toBe(true);
    snap = dataOf(await ds.switchOrg('rmn'));
    expect(sampleOrgKey(snap)).toBe('isms');
    const other = await a.list('isms', 'assets', { page: 1, pageSize: 50 });
    expect(other.ok && other.data.items.map((r) => r.code)).not.toContain('AS-50');
    expect((await a.create('isms', 'assets', { code: 'AS-50', title: 'Another appliance', ownerHandle: 'rina' }, 'k')).ok).toBe(true);
    snap = dataOf(await ds.switchOrg('ndt'));
    const back = await a.list('isms', 'assets', { page: 1, pageSize: 50 });
    expect(back.ok && back.data.items.filter((r) => r.code === 'AS-50').map((r) => r.title)).toEqual(['Backup appliance']);
  });

  it('the build picks the deferred sample adapter, which loads its module on first use and tries again after a failure', async () => {
    const a = adapterFor(() => ctxOf('en'));
    expect(a.sample).toBe(true);
    expect(a.proofHolders('isms')).toEqual([]);
    const res = await a.list('isms', 'assets', { page: 1, pageSize: 50 });
    expect(res.ok && res.data.total).toBeGreaterThan(0);
    // The sample ISMS keeps competence proofs with the awareness training evidence of A.6.3 only.
    expect(a.proofHolders('isms').map((h) => h.code)).toEqual(['EV-0217']);
    expect(a.proofHolders('isms')[0].hasFile).toBe(true);
    let tries = 0;
    const flaky = deferredAdapter(async () => {
      tries += 1;
      if (tries === 1) throw new Error('chunk');
      return createSampleAdapter(scopeOf(() => D));
    }, true);
    await expect(flaky.list('isms', 'assets', { page: 1, pageSize: 50 })).rejects.toThrow('chunk');
    expect((await flaky.list('isms', 'assets', { page: 1, pageSize: 50 })).ok).toBe(true);
  });
});

describe('registers views', () => {
  const sampleRows = async (kind: Parameters<RegistersAdapter['list']>[1]) => {
    const a = createSampleAdapter({ getD: () => D, me: () => 'rina', role: () => 'manager', ds: () => null });
    const res = await a.list('isms', kind, { page: 1, pageSize: 50 });
    return { adapter: a, rows: res.ok ? res.data : { items: [], page: 1, pageSize: 50, total: 0 } };
  };

  it('render every register list in both languages and themes, with the search and the item count of the drill pattern', async () => {
    for (const kind of KINDS) {
      const { rows } = await sampleRows(kind);
      for (const lang of ['en', 'id'] as const) {
        for (const theme of ['light', 'dark'] as const) {
          const ctx = ctxOf(lang, { theme });
          const html = render(<RegisterList ctx={ctx} kind={kind} state={{ loading: false, data: rows, error: null }} query="" onQuery={vi.fn()} onPage={vi.fn()} onOpen={vi.fn()} onAdd={vi.fn()} onRetry={vi.fn()} />, ctx, theme);
          expect(html, `${kind} ${lang}`).toContain(lang === 'id' ? 'placeholder="Cari kode' : 'placeholder="Search code');
          expect(html).toContain(lang === 'id' ? `Menampilkan ${rows.items.length} item dari ${rows.total}` : `Showing ${rows.items.length} of ${rows.total} items`);
          expect(html).toContain('style="cursor:pointer"');
          for (const c of columnsOf(ctx, kind)) expect(html).toContain(ctx.li(c.label));
          expect(html).not.toMatch(/undefined|NaN|\[object/);
        }
      }
    }
  });

  it('show the empty register with its illustration, the failed load and the loading state', () => {
    const ctx = ctxOf('id');
    const empty = render(<RegisterList ctx={ctx} kind="assets" state={{ loading: false, data: { items: [], page: 1, pageSize: 50, total: 0 }, error: null }} query="" onQuery={vi.fn()} onPage={vi.fn()} onOpen={vi.fn()} onAdd={null} onRetry={vi.fn()} />, ctx);
    expect(empty).toContain(TEXT.emptyTitle[1]);
    expect(empty).toContain('Menampilkan 0 item dari 0');
    expect(empty).toContain('<svg');
    expect(empty).not.toContain(TEXT.addFirst[1]);
    // With the right to add, the empty state offers its own button, named apart from the "Add" of the tool row.
    const addable = render(<RegisterList ctx={ctx} kind="assets" state={{ loading: false, data: { items: [], page: 1, pageSize: 50, total: 0 }, error: null }} query="" onQuery={vi.fn()} onPage={vi.fn()} onOpen={vi.fn()} onAdd={vi.fn()} onRetry={vi.fn()} />, ctx);
    expect(addable).toContain(`>${TEXT.addFirst[1]}<`);
    expect(addable.split(`>${TEXT.add[1]}<`)).toHaveLength(2);
    const failed = render(<RegisterList ctx={ctx} kind="assets" state={{ loading: false, data: null, error: { status: 0, message: ['Connection lost', 'Koneksi terputus'] } }} query="" onQuery={vi.fn()} onPage={vi.fn()} onOpen={vi.fn()} onAdd={null} onRetry={vi.fn()} />, ctx);
    expect(failed).toContain(TEXT.loadFailed[1]);
    expect(failed).toContain('Koneksi terputus');
    const loading = render(<RegisterList ctx={ctx} kind="assets" state={{ loading: true, data: null, error: null }} query="x" onQuery={vi.fn()} onPage={vi.fn()} onOpen={vi.fn()} onAdd={null} onRetry={vi.fn()} />, ctx);
    expect(loading).toContain(TEXT.loading[1]);
  });

  it('render the drawer of a row of every kind in both languages, with the treatments, links and actions', async () => {
    for (const kind of KINDS) {
      const { adapter, rows } = await sampleRows(kind);
      const row = rows.items.find((r) => r.shared) ?? rows.items[0];
      for (const lang of ['en', 'id'] as const) {
        const ctx = ctxOf(lang);
        const html = render(<RowPanel ctx={ctx} adapter={adapter} ms="isms" kind={kind} row={row} onClose={vi.fn()} onEdit={vi.fn()} onChanged={vi.fn()} />, ctx);
        expect(html).toContain(row.code);
        expect(html).toContain(ctx.li(KIND_TEXT[kind].one));
        expect(html).toContain(ctx.li(TEXT.edit));
        if (KIND_DEFS[kind].shared) expect(html).toContain(ctx.li(TEXT.linkedSystems));
        if (kind === 'risks') expect(html).toContain(ctx.li(TEXT.treatments));
        if (kind === 'metrics') expect(html).toContain(ctx.li(TEXT.recordValue));
        for (const fact of factsOf(ctx, kind, row)) expect(html).toContain(ctx.li(fact.label));
        expect(html).not.toMatch(/undefined|NaN|\[object/);
      }
    }
    const top = ctxOf('en', { role: 'top', can: (_ms: unknown, p: unknown) => p === 'ms.read' });
    const { adapter, rows } = await sampleRows('risks');
    const readOnly = render(<RowPanel ctx={top} adapter={adapter} ms="isms" kind="risks" row={rows.items[0]} onClose={vi.fn()} onEdit={vi.fn()} onChanged={vi.fn()} />, top);
    expect(readOnly).not.toContain('>Edit<');
    expect(readOnly).not.toContain(TEXT.addTreatment[0]);
  });

  it('render the forms of every kind in both languages and themes', async () => {
    for (const kind of KINDS) {
      const { adapter, rows } = await sampleRows(kind);
      for (const lang of ['en', 'id'] as const) {
        for (const theme of ['light', 'dark'] as const) {
          const ctx = ctxOf(lang, { theme });
          const add = render(<RowFormDrawer ctx={ctx} adapter={adapter} ms="isms" kind={kind} kinds={KINDS} row={null} codes={rows.items.map((r) => r.code)} onClose={vi.fn()} onSaved={vi.fn()} />, ctx, theme);
          expect(add).toContain(ctx.fill(TEXT.formAdd, { kind: ctx.li(KIND_TEXT[kind].label) }));
          for (const key of KIND_DEFS[kind].fields) {
            const label = key === 'proofObjectId' ? TEXT.fProofFile : null;
            if (label) expect(add).toContain(ctx.li(label));
          }
          const edit = render(<RowFormDrawer ctx={ctx} adapter={adapter} ms="isms" kind={kind} row={rows.items[0]} codes={[]} onClose={vi.fn()} onSaved={vi.fn()} />, ctx, theme);
          expect(edit).toContain(ctx.fill(TEXT.formEdit, { code: rows.items[0].code }));
          expect(`${add}${edit}`).not.toMatch(/undefined|NaN|\[object/);
        }
      }
    }
    const { adapter, rows } = await sampleRows('risks');
    const risk = rows.items.find((r) => r.code === 'R-003')!;
    const treatments = await adapter.treatments('isms', risk);
    for (const lang of ['en', 'id'] as const) {
      const ctx = ctxOf(lang);
      const html = [
        render(<TreatmentDialog ctx={ctx} adapter={adapter} ms="isms" risk={risk} existing={[]} onClose={vi.fn()} onSaved={vi.fn()} />, ctx),
        render(<ResidualDialog ctx={ctx} adapter={adapter} ms="isms" risk={risk} treatments={treatments.ok ? treatments.data : []} onClose={vi.fn()} onSaved={vi.fn()} />, ctx),
        render(<ValueDialog ctx={ctx} adapter={adapter} ms="isms" row={{ ...risk, unit: '%' }} onClose={vi.fn()} onSaved={vi.fn()} />, ctx),
        render(<LinkDialog ctx={ctx} adapter={adapter} ms="isms" kind="risks" row={risk} targets={[{ id: 'qms', label: 'QMS' }]} onClose={vi.fn()} onSaved={vi.fn()} />, ctx),
      ].join('');
      expect(html).toContain(ctx.fill(TEXT.treatmentTitle, { code: 'R-003' }));
      expect(html).toContain(ctx.fill(TEXT.residualTitle, { code: 'R-003' }));
      expect(html).toContain(ctx.fill(TEXT.valueTitle, { code: 'R-003' }));
      expect(html).toContain(ctx.fill(TEXT.linkTitle, { code: 'R-003' }));
      expect(html).toContain('T-003');
      expect(html).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});

describe('the first page kept for the screen', () => {
  it('is kept per organisation, person, persona and system', () => {
    const rina = ctxOf('en');
    const key = firstPageKey(rina, 'isms', FIRST_KIND);
    expect(key).toBe('ndt|rina|manager|isms|context-issues');
    expect(firstPageKey(apiCtx('bagus', ['domain_owner'], ['ms.read']), 'isms', FIRST_KIND)).toBe('ndt|bagus|manager|isms|context-issues');
    expect([cachedFirstPage(key), cacheAge(key)]).toEqual([null, null]);
    cacheFirstPage(key, { items: [RISK], page: 1, pageSize: 50, total: 1 });
    expect(cachedFirstPage(key)?.items).toEqual([RISK]);
    expect(cacheAge(key)).toBeLessThan(1000);
  });

  it('is read by a layer item on every screen but the Registers screen, for a session that may open it', () => {
    expect(layerItems.map((i) => i.id)).toEqual(['registers-prefetch']);
    expect(prefetchVisible(ctxOf('en', { screen: 'portfolio' }))).toBe(true);
    expect(prefetchVisible(ctxOf('en', { screen: 'registers' }))).toBe(false);
    expect(prefetchVisible(ctxOf('en', { screen: 'portfolio', msObj: null }))).toBe(false);
    expect(prefetchVisible(apiCtx('maya', ['internal_auditor'], ['ms.read'], { screen: 'portfolio' }))).toBe(true);
    expect(prefetchVisible(apiCtx('ext', [], [], { screen: 'portfolio' }))).toBe(false);
  });

  it('hands the loaded screen code to React.lazy synchronously', async () => {
    const loaded = await preloadScreen();
    let got: unknown = null;
    void screenModule().then((m) => {
      got = m;
    });
    expect(got).toBe(loaded);
    expect(typeof loaded.default).toBe('function');
  });
});

describe('registers screen definition', () => {
  it('opens in the Implementation group with ms.read and offers Add record to whoever may add to a register', () => {
    expect(screen).toMatchObject({ id: 'registers', path: '/ms/:ms/registers', group: 'impl', scope: 'ms', perm: 'ms.read' });
    const actions = screen.pageActions!(ctxOf('en'));
    expect(actions.map((a) => a.label)).toEqual([TEXT.addRecord]);
    const go = vi.fn();
    actions[0].run(ctxOf('en', { go }));
    expect(go).toHaveBeenCalledWith('registers', { params: { add: expect.any(Number) } });
    expect(screen.pageActions!(ctxOf('en', { can: (_ms: unknown, p: unknown) => p === 'ms.read' }))).toEqual([]);
    expect(screen.pageActions!(ctxOf('en', { msObj: null }))).toEqual([]);
  });
});
