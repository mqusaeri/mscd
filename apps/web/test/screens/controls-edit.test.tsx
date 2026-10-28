// The controls and requirements forms (MILESTONE-2 M2-11): routes against the shared table, the full grants against the
// F.6 matrix, the model (values, PATCH body of the changed fields, checks, targets the Add form offers), the api adapter
// over a fake fetch (If-Match, Idempotency-Key, X-CSRF-Token, field errors and warnings kept), the sample adapter over
// the sample data source (BR-02, BR-03, APPL-ASSESS), the panel and the forms in both languages and themes, and the
// claim of "Add control".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_MATRIX, routeById } from '@mscd/shared';
import type { Permission } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import type { ControllerData, DataSource, Requirement } from '../../src/data/types';
import { addControl, claims, detailExtensions, layerItems } from '../../src/screens/controls-edit/actions';
import AddDialog from '../../src/screens/controls-edit/AddDialog';
import { adapterFor } from '../../src/screens/controls-edit/adapter';
import { createApiAdapter } from '../../src/screens/controls-edit/api';
import {
  FULL_ROLES, entryIdOf, frequencyOptions, holdsInFull, mayActOn, outcomeOf, peopleOf, refFor, targetOfEntry,
} from '../../src/screens/controls-edit/common';
import type { EntryRecord } from '../../src/screens/controls-edit/common';
import { DeleteDialog, EditDialog, EntryForms, NotApplicableDialog, RejectDialog, entryRefOf } from '../../src/screens/controls-edit/dialogs';
import EntryPanel from '../../src/screens/controls-edit/EntryPanel';
import {
  addable, assessableOf, checkCreate, checkReason, checkValues, createBodyOf, criteriaOf, implementingDocuments, patchOf, targetOf, valuesOf,
} from '../../src/screens/controls-edit/model';
import type { ControlsAdapter, TargetItem } from '../../src/screens/controls-edit/model';
import { placeErrors, placeWarnings } from '../../src/screens/controls-edit/parts';
import { ROUTES, ROUTE_IDS } from '../../src/screens/controls-edit/routes';
import { createSampleAdapter, emptyJustification, sampleTargets } from '../../src/screens/controls-edit/sample';
import { controlsRequest, requestControls } from '../../src/screens/controls-edit/store';
import { forgetTargets, loadTargets } from '../../src/screens/controls-edit/targets';
import { TEXT } from '../../src/screens/controls-edit/text';
import { fakeFetch, json, problem } from '../auth/helpers';
import { FORBIDDEN, apiCtxOf, ctxOf, pairProblems, render, sampleWorld } from './m2-11-fixtures';

const CSRF = 'csrf-token-0123456789abcdef';
const UUID = '0b7e8c2a-1d3f-4e5a-8b6c-7d8e9f0a1b2c';
const ETAG = 'W/"1790000000000"';

let D: ControllerData;
let ds: DataSource;
beforeEach(async () => {
  ({ D, ds } = await sampleWorld());
  forgetTargets();
});
afterEach(() => requestControls(null));

const isms = () => (D.bundles.isms.reqs as EntryRecord[]);
const entry = (id: string) => isms().find((c) => c.id === id)!;
const TARGETS: TargetItem[] = [
  { kind: 'catalogue_item', code: 'A.5.1', title: 'Policies', clauseGroup: null, hasEntry: true, retired: false, assessable: true, documentedInfo: false },
  { kind: 'requirement', code: '5.1', title: 'Leadership and commitment', clauseGroup: '5', hasEntry: false, retired: false, assessable: false, documentedInfo: false },
  { kind: 'requirement', code: '4.3', title: 'Scope of the management system', clauseGroup: '4', hasEntry: true, retired: false, assessable: false, documentedInfo: true },
  { kind: 'requirement', code: '10.3', title: 'Continual improvement', clauseGroup: '10', hasEntry: false, retired: true, assessable: false, documentedInfo: false },
];

describe('controls-edit routes and grants', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.create).permission).toBe('applicability.manage');
    expect(routeById(ROUTE_IDS.update).permission).toBe('applicability.manage');
    expect(routeById(ROUTE_IDS.criteria).permission).toBe('applicability.manage');
    expect(routeById(ROUTE_IDS.remove).permission).toBe('record.delete');
    expect(routeById(ROUTE_IDS.targets).permission).toBe('ms.read');
    expect(routeById(ROUTE_IDS.update).ifMatch).toBe(true);
    expect(routeById(ROUTE_IDS.create).idempotent).toBe(true);
  });

  it('name the roles that hold each permission in full, as the F.6 matrix does', () => {
    for (const [perm, roles] of Object.entries(FULL_ROLES)) {
      const grant = PERMISSION_MATRIX[perm as Permission];
      expect(grant.scope, perm).toBe('ms');
      expect([...roles].sort(), perm).toEqual([...grant.roles].sort());
    }
  });

  it('has every text in both languages without an em dash or a centre dot', () => {
    expect(pairProblems(TEXT)).toEqual([]);
  });
});

describe('controls-edit model', () => {
  it('reads the snapshot id of a target and back', () => {
    expect(targetOfEntry({ id: 'A.5.23' })).toEqual({ targetType: 'catalogue_item', code: 'A.5.23' });
    expect(targetOfEntry({ id: 'Cl. 9.2.1' })).toEqual({ targetType: 'requirement', code: '9.2.1' });
    expect(entryIdOf('requirement', '5.1')).toBe('Cl. 5.1');
    expect(entryIdOf('catalogue_item', 'A.5.1')).toBe('A.5.1');
  });

  it('starts the Edit form from the snapshot and sends only what changed', () => {
    const c = entry('A.5.1');
    const initial = valuesOf(c, ['POL-01']);
    expect(initial).toMatchObject({ isApplicable: true, inclusion: c.just, exclusion: '', risks: c.risks, documents: ['POL-01'], owner: c.owner, frequency: c.freq });
    expect(patchOf(initial, initial, { documentsKnown: true })).toBeNull();
    expect(criteriaOf(initial, initial)).toBeNull();
    const next = { ...initial, owner: 'bagus', risks: ['R-003'], documents: ['POL-01', 'PRC-07'], note: ' Reviewed ', inclusion: '' };
    expect(patchOf(initial, next, { documentsKnown: true })).toEqual({
      ownerHandle: 'bagus', riskCodes: ['R-003'], documentCodes: ['POL-01', 'PRC-07'], statusNote: 'Reviewed', inclusionJustification: null,
    });
    // The snapshot names only the first implementing document, so an unknown list is never replaced.
    expect(patchOf(initial, next, { documentsKnown: false })).not.toHaveProperty('documentCodes');
    expect(patchOf(initial, { ...initial, isApplicable: false, exclusion: 'Outside the scope of the cloud service' }, { documentsKnown: true }))
      .toEqual({ isApplicable: false, exclusionJustification: 'Outside the scope of the cloud service' });
    expect(patchOf(initial, { ...initial, holdsGate: true, gateReason: 'Waiting for the board' }, { documentsKnown: true })).toEqual({ holdsGate: true, gateReason: 'Waiting for the board' });
    expect(criteriaOf(initial, { ...initial, frequency: 'quarterly' })).toEqual({ frequencyCode: 'quarterly' });
    expect(criteriaOf(initial, { ...initial, description: ' Weekly review ' })).toEqual({ frequencyCode: c.freq, description: 'Weekly review' });
  });

  it('checks the Edit form before Save', () => {
    const initial = valuesOf(entry('A.5.1'), []);
    expect(checkValues(initial, true, initial)).toEqual({});
    expect(checkValues({ ...initial, isApplicable: false }, true, initial)).toEqual({ exclusion: TEXT.exclusionRequired });
    expect(checkValues({ ...initial, isApplicable: false, exclusion: 'x' }, false, initial)).toEqual({ isApplicable: TEXT.alwaysApplicableReason });
    expect(checkValues({ ...initial, holdsGate: true }, true, initial)).toEqual({ gateReason: TEXT.gateReasonRequired });
    // An entry that already holds the gate keeps its stored reason when the field stays empty.
    const gated = { ...initial, holdsGate: true };
    expect(checkValues(gated, true, gated)).toEqual({});
    expect(checkValues({ ...initial, description: 'x'.repeat(2001) }, true, initial)).toEqual({ description: TEXT.descriptionTooLong });
    expect(checkReason('short', 10, 500)).toEqual(TEXT.reasonTooShort);
    expect(checkReason('', 1, 1000)).toEqual(TEXT.reasonRequired);
    expect(checkReason('A reason long enough', 10, 500)).toBeNull();
    expect(checkReason('x'.repeat(501), 10, 500)).toEqual(TEXT.reasonTooLong);
  });

  it('offers targets without an entry that are still in the standard, with a search', () => {
    expect(addable(TARGETS, '').map((t) => t.code)).toEqual(['5.1']);
    expect(addable(TARGETS, 'leader').map((t) => t.code)).toEqual(['5.1']);
    expect(addable(TARGETS, 'scope')).toEqual([]);
    expect(targetOf(TARGETS, { id: 'Cl. 4.3' })?.documentedInfo).toBe(true);
    expect(assessableOf(null, { id: 'Cl. 4.3' })).toBe(false);
    expect(assessableOf(null, { id: 'A.5.1' })).toBe(true);
    expect(assessableOf(TARGETS[0], { id: 'A.5.1' })).toBe(true);
  });

  it('builds the create body and checks the Add form', () => {
    const base = { target: TARGETS[1], isApplicable: true, inclusion: ' Leadership commitment ', exclusion: '', owner: 'rina', frequency: 'annual' };
    expect(checkCreate(base)).toEqual({});
    expect(createBodyOf(base)).toEqual({ targetType: 'requirement', code: '5.1', isApplicable: true, ownerHandle: 'rina', frequencyCode: 'annual', inclusionJustification: 'Leadership commitment' });
    expect(checkCreate({ ...base, isApplicable: false })).toEqual({ isApplicable: TEXT.alwaysApplicableReason, exclusion: TEXT.exclusionRequired });
    expect(checkCreate({ ...base, target: null, frequency: '' })).toEqual({ target: TEXT.targetRequired, frequency: TEXT.frequencyRequired });
    const control = { ...base, target: TARGETS[0], isApplicable: false, exclusion: 'No development in scope' };
    expect(createBodyOf(control)).toEqual({ targetType: 'catalogue_item', code: 'A.5.1', isApplicable: false, ownerHandle: 'rina', frequencyCode: 'annual', exclusionJustification: 'No development in scope' });
  });

  it('lists the implementing documents of an entry from the register', () => {
    expect(implementingDocuments([{ code: 'POL-01', title: 'P', implements: ['A.5.1', 'A.5.2'] }, { code: 'PRC-07', title: 'A', implements: ['A.5.15'] }], { id: 'A.5.1' })).toEqual(['POL-01']);
  });

  it('maps a command answer, field errors and warnings onto the form', () => {
    const ok = outcomeOf({ ok: true, status: 200, data: { ok: true, changed: ['isms'], warnings: [{ rule: 'BR-03', messages: { en: 'Explain', id: 'Jelaskan' } }] } });
    expect(ok).toEqual({ ok: true, data: { changed: ['isms'], warnings: [{ rule: 'BR-03', message: ['Explain', 'Jelaskan'] }] } });
    const li = (t: readonly [string, string]) => t[0];
    const placed = placeErrors({ status: 400, message: ['Invalid', 'Invalid'], errors: [{ path: 'body.exclusionJustification', message: 'Too long' }] }, li, { exclusionJustification: 'exclusion' });
    expect(placed).toEqual({ fields: { exclusion: 'Too long' }, general: null });
    const rule = placeErrors({ status: 422, rule: 'BR-02', message: ['Link a risk', 'Tautkan'] }, li, {}, { 'BR-02': 'risks' });
    expect(rule).toEqual({ fields: { risks: 'Link a risk' }, general: null });
    expect(placeErrors({ status: 409, message: ['Changed', 'Berubah'] }, li, {}).general?.status).toBe(409);
    expect(placeWarnings([{ rule: 'BR-03', message: ['a', 'b'] }, { rule: 'BR-47', message: ['c', 'd'] }], { 'BR-03': 'exclusion' }))
      .toEqual({ fields: { exclusion: [{ rule: 'BR-03', message: ['a', 'b'] }] }, general: [{ rule: 'BR-47', message: ['c', 'd'] }] });
  });
});

describe('controls-edit grants of the session', () => {
  it('tells a full grant from an own grant', () => {
    const manager = apiCtxOf(D, 'isms', ['applicability.manage', 'record.delete', 'evidence.manage', 'activity.transition'], ['ms_manager']);
    const owner = apiCtxOf(D, 'isms', ['evidence.manage', 'activity.transition'], ['domain_owner'], 'en', { person: { handle: 'bagus', name: 'Bagus', jobTitle: '-' } });
    expect(holdsInFull(manager, 'isms', 'applicability.manage')).toBe(true);
    expect(holdsInFull(owner, 'isms', 'evidence.manage')).toBe(false);
    expect(mayActOn(owner, 'isms', 'evidence.manage', 'bagus')).toBe(true);
    expect(mayActOn(owner, 'isms', 'evidence.manage', 'rina')).toBe(false);
    expect(holdsInFull(manager, 'qms', 'applicability.manage')).toBe(false);
    // Sample builds: the manager persona holds every right, the other personas their own records only.
    expect(holdsInFull(ctxOf(D), 'isms', 'record.delete')).toBe(true);
    expect(holdsInFull(ctxOf(D, 'en', { role: 'owner' }), 'isms', 'record.delete')).toBe(false);
  });

  it('reads people, frequencies and refs of the snapshot', () => {
    expect(peopleOf(D).some((p) => p.id === 'none')).toBe(false);
    expect(frequencyOptions(D).map((o) => o.value)).toEqual(D.FREQ_ORDER);
    const withRefs = { ...D, refs: { 'isms:req:A.5.1': { module: 'implementation', entityType: 'applicability_entry', id: UUID, code: 'A.5.1', etag: ETAG } } } as unknown as ControllerData;
    expect(refFor(withRefs, 'isms:req:A.5.1')?.id).toBe(UUID);
    expect(entryRefOf({ D: withRefs }, 'isms', { id: 'A.5.1' })).toEqual({ ms: 'isms', key: 'isms:req:A.5.1', id: 'A.5.1', uuid: UUID, etag: ETAG });
    expect(entryRefOf({ D }, 'isms', { id: 'A.5.1' }).uuid).toBeNull();
  });
});

describe('controls-edit api adapter', () => {
  const ref = { ms: 'isms', key: 'isms:req:A.5.1', id: 'A.5.1', uuid: UUID, etag: ETAG };
  const command = { ok: true, changed: ['isms'], warnings: [{ rule: 'BR-03', messages: { en: 'Explain why', id: 'Jelaskan' } }] };

  function adapter(routes: Parameters<typeof fakeFetch>[0]) {
    const f = fakeFetch(routes);
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken(CSRF);
    return { ...f, adapter: createApiAdapter(client) };
  }

  it('reads the targets with the retired rows', async () => {
    const t = adapter({ 'GET /api/v1/ms/isms/applicability/targets': json(TARGETS) });
    expect(await t.adapter.targets('isms')).toEqual({ ok: true, data: TARGETS });
    expect(t.calls[0]!.url).toContain('retired=true');
  });

  it('creates with an Idempotency-Key and changes with If-Match and the CSRF token', async () => {
    const t = adapter({
      'POST /api/v1/ms/isms/applicability': json({ ok: true, changed: ['isms'], warnings: [{ rule: 'BR-02', messages: { en: 'Link a risk', id: 'Tautkan' } }] }, 201),
      [`PATCH /api/v1/ms/isms/applicability/${UUID}`]: json(command),
      [`PUT /api/v1/ms/isms/applicability/${UUID}/operating-criteria`]: json({ ok: true, changed: ['isms'] }),
      [`POST /api/v1/ms/isms/applicability/${UUID}/transitions`]: json({ ok: true, changed: ['isms'] }),
      [`POST /api/v1/ms/isms/records/applicability_entry/${UUID}/delete`]: json({ ok: true, changed: ['isms'] }),
    });
    const body = { targetType: 'requirement' as const, code: '5.1', isApplicable: true, ownerHandle: 'rina', frequencyCode: 'annual' };
    const created = await t.adapter.create('isms', body, 'key-1');
    expect(created).toEqual({ ok: true, data: { changed: ['isms'], warnings: [{ rule: 'BR-02', message: ['Link a risk', 'Tautkan'] }] } });
    expect(t.calls[0]).toMatchObject({ method: 'POST', body });
    expect(t.calls[0]!.headers).toMatchObject({ 'idempotency-key': 'key-1', 'x-csrf-token': CSRF });

    const updated = await t.adapter.update(ref, { exclusionJustification: 'n/a', isApplicable: false });
    expect(updated.ok && updated.data.warnings[0]!.rule).toBe('BR-03');
    expect(t.calls[1]!.headers['if-match']).toBe(ETAG);
    expect(t.calls[1]!.body).toEqual({ exclusionJustification: 'n/a', isApplicable: false });

    await t.adapter.criteria(ref, { frequencyCode: 'quarterly', description: 'Quarterly review' });
    expect(t.calls[2]).toMatchObject({ method: 'PUT', body: { frequencyCode: 'quarterly', description: 'Quarterly review' } });
    await t.adapter.transition(ref, { to: 'partially_implemented', reason: 'Evidence misses Q3' });
    expect(t.calls[3]).toMatchObject({ method: 'POST', body: { to: 'partially_implemented', reason: 'Evidence misses Q3' } });
    expect(t.calls[3]!.headers['if-match']).toBe(ETAG);
    await t.adapter.remove(ref, ' Duplicate of A.5.2 entry ', true);
    expect(t.calls[4]).toMatchObject({ method: 'POST', body: { reason: 'Duplicate of A.5.2 entry', confirm: true } });
  });

  it('keeps the refusals of the api with their rule and field errors', async () => {
    const t = adapter({
      [`PATCH /api/v1/ms/isms/applicability/${UUID}`]: problem(422, 'business-rule', { rule: 'BR-02', messages: { en: 'Link this applicable entry to at least one risk.', id: 'Tautkan.' } }),
      [`POST /api/v1/ms/isms/applicability/${UUID}/transitions`]: problem(400, 'validation', { errors: [{ path: 'body.exclusionJustification', message: 'Required' }] }),
      [`POST /api/v1/ms/isms/records/applicability_entry/${UUID}/delete`]: problem(409, 'confirmation-required', { rule: 'BR-22', messages: { en: 'This change also applies to: QMS. Continue?', id: 'Lanjutkan?' } }),
    });
    const refused = await t.adapter.update(ref, { riskCodes: [] });
    expect(refused).toMatchObject({ ok: false, error: { status: 422, rule: 'BR-02' } });
    const invalid = await t.adapter.transition(ref, { to: 'not_applicable', exclusionJustification: ' ' });
    expect(!invalid.ok && invalid.error.errors).toEqual([{ path: 'body.exclusionJustification', message: 'Required' }]);
    const confirm = await t.adapter.remove(ref, 'Duplicate entry, merged', false);
    expect(confirm).toMatchObject({ ok: false, error: { status: 409, slug: 'confirmation-required' } });
  });

  it('sends nothing for an entry without a uuid', async () => {
    const t = adapter({});
    const res = await t.adapter.update({ ...ref, uuid: null }, { statusNote: 'x' });
    expect(res).toMatchObject({ ok: false, error: { status: 404, message: TEXT.notFound } });
    expect(t.calls).toHaveLength(0);
  });

  it('reads every page of the risk register and the document register', async () => {
    const risk = (code: string) => ({ ref: { module: 'audit', entityType: 'risk', id: UUID, code }, code, title: `Risk ${code}`, owner: 'rina', updatedAt: '2026-09-01T00:00:00Z', shared: false, ms: ['isms'] });
    const t = adapter({
      'GET /api/v1/ms/isms/registers/risks': [json({ items: [risk('R-001')], page: 1, pageSize: 1, total: 2 }), json({ items: [risk('R-002')], page: 2, pageSize: 1, total: 2 })],
      'GET /api/v1/ms/isms/documents': json({ items: [{ id: 'POL-01', title: 'Policy', requirements: ['A.5.1'] }], page: 1, pageSize: 200, total: 1 }),
    });
    expect(await t.adapter.risks('isms')).toEqual({ ok: true, data: [{ code: 'R-001', title: 'Risk R-001' }, { code: 'R-002', title: 'Risk R-002' }] });
    expect(await t.adapter.documents('isms')).toEqual({ ok: true, data: [{ code: 'POL-01', title: 'Policy', implements: ['A.5.1'] }] });
  });

  it('caches the targets for a minute and forgets them after a change', async () => {
    const targets = vi.fn(async () => ({ ok: true as const, data: TARGETS }));
    const fake = { targets } as unknown as ControlsAdapter;
    await loadTargets(fake, 'api:ndt', 'isms');
    await loadTargets(fake, 'api:ndt', 'isms');
    expect(targets).toHaveBeenCalledTimes(1);
    await loadTargets(fake, 'api:ndt', 'isms', true);
    expect(targets).toHaveBeenCalledTimes(2);
    forgetTargets('isms');
    await loadTargets(fake, 'api:ndt', 'isms');
    expect(targets).toHaveBeenCalledTimes(3);
  });

  it('chooses the sample adapter in the sample build and never rejects', async () => {
    const a = adapterFor(ctxOf(D, 'en', { ds }));
    const res = await a.targets('isms');
    expect(res.ok && res.data.some((t) => t.code === '5.1' && !t.hasEntry)).toBe(true);
    const broken = adapterFor({ client: null, ds: null, D: null });
    expect((await broken.update({ ms: 'isms', key: 'k', id: 'A.5.1', uuid: null, etag: null }, { statusNote: 'x' })).ok).toBe(false);
  });
});

describe('controls-edit sample adapter', () => {
  const adapterOf = () => createSampleAdapter(() => D, ds);
  const reload = async (ms = 'isms') => {
    const snap = await ds.reload(D, [ms]);
    D = { ...D, ...snap, bundles: snap.bundles };
  };
  const ref = (id: string, ms = 'isms') => ({ ms, key: `${ms}:req:${id}`, id, uuid: null, etag: null });

  it('lists the clause rows a catalogue system has not added, and the documented information', () => {
    const targets = sampleTargets(D, 'isms');
    expect(targets.filter((t) => t.kind === 'requirement' && !t.hasEntry)).toHaveLength(30);
    expect(targets.find((t) => t.code === '4.3')).toMatchObject({ assessable: false, documentedInfo: true });
    expect(targets.find((t) => t.code === 'A.5.1')).toMatchObject({ hasEntry: true, assessable: true });
    expect(sampleTargets(D, 'qms').every((t) => t.hasEntry)).toBe(true);
  });

  it('adds a clause entry that holds the gate until a risk is linked (BR-02)', async () => {
    const res = await adapterOf().create('isms', { targetType: 'requirement', code: '5.1', isApplicable: true, ownerHandle: 'rina', frequencyCode: 'annual', inclusionJustification: 'Leadership' }, 'k');
    expect(res).toMatchObject({ ok: true, data: { changed: ['isms'], warnings: [{ rule: 'BR-02' }] } });
    await reload();
    expect(isms().find((c) => c.id === 'Cl. 5.1')).toMatchObject({ key: 'cl-5.1', st: 'blocked', gate: true, owner: 'rina' });
    expect(await adapterOf().create('isms', { targetType: 'requirement', code: '5.1', isApplicable: true, ownerHandle: 'rina', frequencyCode: 'annual' }, 'k')).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await adapterOf().create('isms', { targetType: 'requirement', code: '6.3', isApplicable: false, exclusionJustification: 'x', ownerHandle: 'rina', frequencyCode: 'annual' }, 'k'))
      .toMatchObject({ ok: false, error: { rule: 'APPL-ASSESS' } });
  });

  it('changes an entry, refuses an applicable control without a risk and warns on an empty exclusion', async () => {
    const a = adapterOf();
    expect(await a.update(ref('A.5.1'), { ownerHandle: 'bagus', inclusionJustification: 'Required by R-003' })).toMatchObject({ ok: true });
    await reload();
    expect(entry('A.5.1')).toMatchObject({ owner: 'bagus', just: 'Required by R-003' });
    expect(await a.update(ref('A.5.1'), { riskCodes: [] })).toMatchObject({ ok: false, error: { rule: 'BR-02' } });
    const excluded = await a.update(ref('A.5.2'), { isApplicable: false, exclusionJustification: 'n/a' });
    expect(excluded).toMatchObject({ ok: true, data: { warnings: [{ rule: 'BR-03' }] } });
    await reload();
    expect(entry('A.5.2')).toMatchObject({ st: 'na', just: 'n/a' });
    expect(await a.criteria(ref('A.5.3'), { frequencyCode: 'monthly' })).toMatchObject({ ok: true });
    await reload();
    expect(entry('A.5.3').freq).toBe('monthly');
    expect(emptyJustification('Not applicable.')).toBe(true);
    expect(emptyJustification('No software development is done in the scope')).toBe(false);
  });

  it('rejects a completed entry, refuses a clause row as not applicable, and keeps every entry on delete', async () => {
    const a = adapterOf();
    // QMS Cl. 8.7 waits for verification in the sample data.
    const qms = () => D.bundles.qms.reqs as Requirement[];
    expect(qms().find((c) => c.id === 'Cl. 8.7')!.st).toBe('complete');
    expect(await a.transition(ref('Cl. 8.7', 'qms'), { to: 'partially_implemented', reason: 'Evidence misses Q3' })).toMatchObject({ ok: true });
    await reload('qms');
    expect(qms().find((c) => c.id === 'Cl. 8.7')).toMatchObject({ st: 'partial', note: 'Evidence misses Q3' });
    expect(await a.transition(ref('A.5.1'), { to: 'partially_implemented', reason: 'Not complete' })).toMatchObject({ ok: false, error: { status: 409 } });
    const qmsClause = (D.bundles.qms.reqs as Requirement[]).find((c) => c.id === 'Cl. 5.1')!;
    expect(await a.transition(ref(qmsClause.id, 'qms'), { to: 'not_applicable', exclusionJustification: 'Out of scope' })).toMatchObject({ ok: false, error: { rule: 'APPL-ASSESS' } });
    expect(await a.remove(ref('A.5.1'), 'Duplicate entry, merged', false)).toMatchObject({ ok: false, error: { message: TEXT.sampleNoDelete } });
    expect((await a.risks('isms')).ok).toBe(true);
    const docs = await a.documents('isms');
    expect(docs.ok && docs.data.find((d) => d.code === 'POL-01')?.implements).toContain('A.5.1');
  });
});

describe('controls-edit panel and forms', () => {
  const adapter = () => createSampleAdapter(() => D, ds);

  it('shows the entry panel for an MS Manager in both languages and themes', () => {
    for (const lang of ['en', 'id'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = ctxOf(D, lang);
        const html = render(<EntryPanel ctx={ctx} kind="req" ms="isms" recordKey="isms:req:A.5.1" record={entry('A.5.1')} close={() => undefined} />, ctx, theme);
        expect(html).toContain(lang === 'en' ? 'Manage this entry' : 'Kelola entri ini');
        expect(html).toContain(lang === 'en' ? 'Edit entry' : 'Ubah entri');
        expect(html).toContain(lang === 'en' ? 'Delete entry' : 'Hapus entri');
        expect(html).not.toMatch(FORBIDDEN);
      }
    }
  });

  it('disables Mark not applicable on a clause row with the APPL-ASSESS reason, and shows Reject to a verifier', () => {
    const ctx = ctxOf(D);
    const clause = (D.bundles.qms.reqs as EntryRecord[]).find((c) => c.id === 'Cl. 5.1')!;
    const html = render(<EntryPanel ctx={ctx} kind="req" ms="qms" recordKey="qms:req:Cl. 5.1" record={clause} close={() => undefined} />, ctx);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Mark not applicable<\/button>/);
    expect(html).toContain(TEXT.alwaysApplicableReason[0]);
    const complete = { ...entry('A.5.1'), st: 'complete' as const };
    expect(render(<EntryPanel ctx={ctx} kind="req" ms="isms" recordKey="k" record={complete} close={() => undefined} />, ctx)).toContain('>Reject<');
    const retired = { ...entry('A.5.1'), retired: true };
    expect(render(<EntryPanel ctx={ctxOf(D, 'en', { role: 'top', can: () => false })} kind="req" ms="isms" recordKey="k" record={retired} close={() => undefined} />, ctx)).toContain('No longer in the standard');
  });

  it('shows nothing to a reader of a plain entry', () => {
    const reader = ctxOf(D, 'en', { role: 'top', can: (_ms, p) => p === 'ms.read' });
    expect(render(<EntryPanel ctx={reader} kind="req" ms="isms" recordKey="k" record={entry('A.5.1')} close={() => undefined} />, reader)).not.toContain('mx-m11-panel');
  });

  it('renders the Edit, Reject, Not applicable and Delete forms in both languages and themes', () => {
    for (const lang of ['en', 'id'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = ctxOf(D, lang);
        const props = { ctx, adapter: adapter(), ms: 'isms', entry: entry('A.5.1'), onClose: () => undefined };
        const edit = render(<EditDialog {...props} assessable />, ctx, theme);
        expect(edit).toContain(lang === 'en' ? 'Justification for inclusion' : 'Justifikasi penyertaan');
        expect(edit).toContain(lang === 'en' ? 'Linked risks' : 'Risiko tertaut');
        expect(edit).toContain(lang === 'en' ? 'Operating frequency' : 'Frekuensi operasi');
        expect(edit).toContain('R-003');
        for (const node of [<RejectDialog key="r" {...props} />, <NotApplicableDialog key="n" {...props} />, <DeleteDialog key="d" {...props} />]) {
          const html = render(node, ctx, theme);
          expect(html).toContain('role="dialog"');
          expect(html).not.toMatch(FORBIDDEN);
        }
        expect(render(<EntryForms ctx={ctx} request={{ kind: 'delete', ms: 'isms', entry: entry('A.5.1'), assessable: true }} onClose={() => undefined} />, ctx))
          .toContain(lang === 'en' ? 'Delete entry A.5.1' : 'Hapus entri A.5.1');
      }
    }
  });

  it('renders the Add form while the targets load', () => {
    for (const lang of ['en', 'id'] as const) {
      const ctx = ctxOf(D, lang, { ds });
      const html = render(<AddDialog ctx={ctx} ms="isms" onClose={() => undefined} />, ctx);
      expect(html).toContain(lang === 'en' ? 'Add control or requirement' : 'Tambah kontrol atau persyaratan');
      expect(html).toContain(lang === 'en' ? 'Loading the controls and requirements' : 'Memuat kontrol dan persyaratan');
    }
  });
});

describe('controls-edit claim and extensions', () => {
  it('keeps the Milestone 1 toast of Add control in the sample build', () => {
    const ctx = ctxOf(D);
    addControl(ctx, { ms: 'isms' });
    expect(ctx.toast).toHaveBeenCalledWith('New custom control form opened');
    expect(controlsRequest()).toBeNull();
  });

  it('opens the Add form for an MS Manager in API builds and refuses others', () => {
    const manager = apiCtxOf(D, 'isms', ['applicability.manage'], ['ms_manager']);
    claims!['controls.add']!(manager, { ms: 'isms' });
    expect(controlsRequest()).toMatchObject({ kind: 'add', ms: 'isms' });
    requestControls(null);
    const owner = apiCtxOf(D, 'isms', ['ms.read'], ['domain_owner']);
    addControl(owner, { ms: 'isms' });
    expect(owner.toast).toHaveBeenCalled();
    expect(controlsRequest()).toBeNull();
  });

  it('registers the entry panel for requirements and the form layer', () => {
    expect(detailExtensions).toEqual([expect.objectContaining({ id: 'controls-edit.entry', kind: 'req' })]);
    expect(layerItems).toEqual([expect.objectContaining({ id: 'controls-edit.forms' })]);
  });
});
