// Routing rules (MILESTONE-2 M2-09): routes against the shared table, the form helpers (RoutingRuleRequest and
// RoutingRulePatch of D.2), who may decide on a pending rule (A-50, BR-38), the stored file helpers, the API adapter
// over a fake fetch, the sample adapter with the BR-38 confirmation, and the views in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { RoutingRuleView } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/routing/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/routing/routes';
import { createApiAdapter, fromRuleView, outcomeOf, repoChoiceOf } from '../../src/screens/routing/api';
import { createSampleAdapter, resetSampleRouting, sampleObjects, sampleRepos, sampleRules } from '../../src/screens/routing/sample';
import { adapterFor, deferredAdapter } from '../../src/screens/routing/adapter';
import {
  canEdit, decisionBlock, emptyRule, fileType, formOfRule, formatSize, isTenantAdmin, meOf, ruleErrors, rulePatch, ruleRequest, systemOfObject,
} from '../../src/screens/routing/model';
import type { RoutingAdapter, RoutingData, RuleModel } from '../../src/screens/routing/model';
import { RuleDrawer, RulesTable, STATE_LABELS, StoredFiles, hashText, systemLabel, visibleRules } from '../../src/screens/routing/Screen';
import { TEXT } from '../../src/screens/routing/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { fakeFetch, json, problem } from '../auth/helpers';

const snapshot = await createSampleDataSource().load();
const D = { ...makeDates(SAMPLE.TODAY_S), ...snapshot, TODAY_S: SAMPLE.TODAY_S } as unknown as ControllerData;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: null, org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'routing', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const RULE_VIEW: RoutingRuleView = {
  id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a', ms: 'isms', classification: 'internal', objectKind: null, repository: 'sp', mode: 'link', priority: 50,
  note: 'Internal to Link', approvalStatus: 'pending_approval', requestedBy: 'rina', approvedBy: null, createdAt: '2026-09-20T03:00:00Z',
};
const REPO_VIEW = {
  id: 'sp', ref: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', name: 'SharePoint Online', adapter: 'm365', modes: ['link', 'pass_through'], readOnly: false,
  config: { roots: { isms: { folderId: 'f', path: 'Compliance/ISMS' } } },
};

afterEach(() => resetSampleRouting());

describe('routing routes', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.rulesList).permission).toBe('storage.repository.read');
    expect(routeById(ROUTE_IDS.rulesCreate).permission).toBe('storage.routing.manage');
    expect(routeById(ROUTE_IDS.rulesApprove).permission).toBe('storage.routing.manage');
    expect(routeById(ROUTE_IDS.objectsList).permission).toBe('storage.object.metadata.read');
  });
});

describe('the rule form and who decides', () => {
  const repos = sampleRepos(D);

  it('checks the repository, its modes, the priority and the note', () => {
    const form = emptyRule(repos, 'isms');
    expect(form).toMatchObject({ ms: 'isms', repository: 'sp', mode: 'link', priority: '100' });
    expect(ruleErrors(form, repos)).toEqual({});
    expect(ruleErrors({ ...form, mode: 'stored' }, repos)).toEqual({ mode: TEXT.badMode });
    expect(ruleErrors({ ...form, repository: '', priority: '40000', note: 'x'.repeat(501) }, repos)).toEqual({ repository: TEXT.required, priority: TEXT.badPriority, note: TEXT.noteTooLong });
    expect(ruleErrors({ ...form, priority: '-1' }, repos)).toEqual({ priority: TEXT.badPriority });
  });

  it('builds RoutingRuleRequest and a RoutingRulePatch of the changed fields, with confirm after BR-38', () => {
    const form = { ...emptyRule(repos, 'bcms'), classification: 'restricted', objectKind: 'evidence', repository: 'vault', mode: 'stored', priority: '40', note: ' Vault ' };
    expect(ruleRequest(form)).toEqual({ ms: 'bcms', classification: 'restricted', objectKind: 'evidence', repository: 'vault', mode: 'stored', priority: 40, note: 'Vault' });
    expect(ruleRequest({ ...form, ms: '', classification: '', objectKind: '', note: '' }, true)).toEqual({ repository: 'vault', mode: 'stored', priority: 40, confirm: true });
    const rule = fromRuleView(RULE_VIEW);
    const same = formOfRule(rule);
    expect(rulePatch(same, rule)).toBeNull();
    expect(rulePatch({ ...same, classification: '', mode: 'pass_through', note: '' }, rule, true)).toEqual({ classification: null, mode: 'pass_through', note: null, confirm: true });
    expect(rulePatch({ ...same, priority: '10' }, rule)).toEqual({ priority: 10 });
  });

  it('the requester never decides, only a Tenant Admin does; the requester may still edit a pending rule', () => {
    const pending = fromRuleView(RULE_VIEW);
    const rina = ctxOf('en', { mode: 'api', me: { user: { handle: 'rina' }, adminRoles: ['tenant_admin', 'storage_admin'] } as never });
    const admin = ctxOf('en', { mode: 'api', me: { user: { handle: 'tenant.admin' }, adminRoles: ['tenant_admin'] } as never });
    const storageAdmin = ctxOf('en', { mode: 'api', me: { user: { handle: 'bagus' }, adminRoles: ['storage_admin'] } as never });
    expect(meOf(rina)).toBe('rina');
    expect(decisionBlock(rina, pending)).toEqual(TEXT.ownRequest);
    expect(decisionBlock(admin, pending)).toBeNull();
    expect(decisionBlock(storageAdmin, pending)).toEqual(TEXT.onlyTenantAdmin);
    expect([isTenantAdmin(admin), isTenantAdmin(storageAdmin), isTenantAdmin(ctxOf('en'))]).toEqual([true, false, true]);
    expect(canEdit(rina, pending)).toBe(true);
    expect(canEdit(admin, pending)).toBe(false);
    expect(canEdit(admin, { ...pending, approvalStatus: 'active' })).toBe(true);
    expect(canEdit(admin, { ...pending, approvalStatus: 'rejected' })).toBe(false);
    expect(canEdit(ctxOf('en', { orgCan: () => false }), { ...pending, approvalStatus: 'active' })).toBe(false);
  });

  it('shows pending rules first and hides replaced rules unless asked', () => {
    const rules = [{ ...fromRuleView(RULE_VIEW), id: 'a', approvalStatus: 'active' as const }, { ...fromRuleView(RULE_VIEW), id: 'b', approvalStatus: 'superseded' as const }, { ...fromRuleView(RULE_VIEW), id: 'c' }];
    expect(visibleRules(rules, false).map((r) => r.id)).toEqual(['c', 'a']);
    expect(visibleRules(rules, true).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('stored files', () => {
  it('tells the system from the repository folder and formats size, type and hash', () => {
    const repos = [repoChoiceOf(REPO_VIEW as never)];
    const object = { id: 'o', repository: 'sp', displayName: 'Backup-Job-Log-Q3.xlsx', folderPath: 'Compliance / ISMS / Evidence / 2026 / Q3', sizeBytes: 48211, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hashAlgorithm: 'quickxor' as const, hashSource: 'provider' as const, linkStatus: 'missing' as const, lastVerifiedAt: null };
    expect(systemOfObject(object, repos, [{ slug: 'isms', code: 'ISMS' }])).toBe('ISMS');
    expect(systemOfObject({ ...object, folderPath: 'Compliance/ISMS-old' }, repos, [])).toBeNull();
    expect(systemOfObject({ ...object, system: 'QMS' }, repos, [])).toBe('QMS');
    expect([formatSize(48211), formatSize(512), formatSize(3 * 1024 * 1024), formatSize(null)]).toEqual(['47.1 KB', '512 B', '3.0 MB', '-']);
    expect([fileType(object), fileType({ mimeType: null, displayName: 'scan.pdf' }), fileType({ mimeType: null, displayName: null })]).toEqual(['XLSX', 'PDF', '-']);
    const ctx = ctxOf('id');
    expect(hashText(ctx, object)).toBe('QuickXorHash, dari penyedia');
    expect(hashText(ctx, { ...object, hashAlgorithm: 'none', hashSource: 'none' })).toBe('Tanpa hash');
    expect(sampleObjects(D).length).toBeGreaterThan(50);
    expect(sampleObjects(D)[0]).toMatchObject({ system: 'ISMS' });
  });
});

describe('routing API adapter', () => {
  it('loads rules and repositories, and the systems for a Tenant Admin', async () => {
    const f = fakeFetch({
      'GET /api/v1/admin/storage/routing-rules': json([RULE_VIEW]),
      'GET /api/v1/admin/storage/repositories': json([REPO_VIEW]),
      'GET /api/v1/admin/management-systems': json([{ slug: 'isms', code: 'ISMS', status: 'certified' }]),
    });
    const res = await createApiAdapter(new ApiClient({ fetch: f.fetch }), { systems: true, fallbackSystems: [] }).load();
    expect(res).toMatchObject({ ok: true, data: { rules: [{ id: RULE_VIEW.id, approvalStatus: 'pending_approval' }], repos: [{ slug: 'sp', roots: { isms: 'Compliance/ISMS' } }], systems: [{ slug: 'isms', code: 'ISMS' }] } });
  });

  it('creates with the Idempotency-Key, keeps a BR-38 confirmation refusal, approves and rejects, and pages the stored files', async () => {
    const br38 = problem(409, 'confirmation-required', { rule: 'BR-38', affected: ['ISMS'], messages: { en: "Restricted files will be stored in the provider's cloud. This change needs a second approval.", id: 'File terbatas akan disimpan di cloud penyedia. Perubahan ini memerlukan persetujuan kedua.' } });
    const f = fakeFetch({
      'POST /api/v1/admin/storage/routing-rules': [br38, json({ ok: true, changed: [], message: ['Routing change waiting for approval by another Tenant Admin', 'Perubahan routing menunggu persetujuan Tenant Admin lain'], data: { id: RULE_VIEW.id, approvalStatus: 'pending_approval', rule: 'BR-38' } }, 201)],
      [`PATCH /api/v1/admin/storage/routing-rules/${RULE_VIEW.id}`]: json({ ok: true, changed: ['isms'], message: ['Routing rule saved', 'Aturan routing disimpan'], data: { id: RULE_VIEW.id, approvalStatus: 'active' } }),
      [`POST /api/v1/admin/storage/routing-rules/${RULE_VIEW.id}/approve`]: json({ ok: true, changed: ['isms'], message: ['Routing change approved and active', 'Perubahan routing disetujui dan aktif'], data: { id: RULE_VIEW.id, approvalStatus: 'active' } }),
      [`POST /api/v1/admin/storage/routing-rules/${RULE_VIEW.id}/reject`]: problem(422, 'business-rule', { messageKey: 'storage.routing.same_person', messages: { en: 'The person who asked for this routing change cannot decide on it', id: 'Orang yang meminta perubahan routing ini tidak dapat memutuskannya' } }),
      'GET /api/v1/admin/storage/objects': json({ items: [{ id: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f', repository: 'sp', externalItemId: 'x', externalVersionId: '3.0', versionLabel: 'v3.0', displayName: 'Log.xlsx', mimeType: null, sizeBytes: 10, hashAlgorithm: 'quickxor', hashValue: 'A', hashSource: 'provider', folderPath: 'Compliance/ISMS', linkStatus: 'missing', linkStatusSince: '2026-09-20T02:00:00Z', linkStatusReason: null, lastVerifiedAt: null, lastGoodCheckAt: null, nextCheckAt: null }], page: 2, pageSize: 50, total: 51 }),
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client, { systems: false, fallbackSystems: [] });
    const body = { ms: 'isms', repository: 'vault', mode: 'stored' as const, priority: 10 };
    const first = await adapter.create(body, 'key-1');
    if (first.ok) throw new Error('expected the BR-38 confirmation');
    expect([first.error.status, first.error.slug, first.error.rule]).toEqual([409, 'confirmation-required', 'BR-38']);
    expect(f.calls[0].headers['idempotency-key']).toBe('key-1');
    expect(await adapter.create({ ...body, confirm: true }, 'key-1')).toEqual({ ok: true, data: { message: ['Routing change waiting for approval by another Tenant Admin', 'Perubahan routing menunggu persetujuan Tenant Admin lain'], approvalStatus: 'pending_approval', changed: [] } });
    expect(f.calls[1].body).toEqual({ ...body, confirm: true });
    expect(await adapter.update(RULE_VIEW.id, { priority: 5 })).toMatchObject({ ok: true, data: { approvalStatus: 'active', changed: ['isms'] } });
    expect(await adapter.approve(RULE_VIEW.id)).toMatchObject({ ok: true, data: { approvalStatus: 'active' } });
    expect(await adapter.reject(RULE_VIEW.id)).toMatchObject({ ok: false, error: { status: 422, messageKey: 'storage.routing.same_person' } });
    const page = await adapter.objects({ page: 2, pageSize: 50, repository: 'sp', status: 'missing' });
    expect(page).toMatchObject({ ok: true, data: { page: 2, total: 51, items: [{ displayName: 'Log.xlsx', linkStatus: 'missing' }] } });
    expect(f.calls.at(-1)!.url).toContain('/api/v1/admin/storage/objects?page=2&pageSize=50&repository=sp&status=missing');
    expect(outcomeOf({ ok: true, changed: [] })).toEqual({ message: null, approvalStatus: null, changed: [] });
  });
});

describe('routing sample adapter', () => {
  it('lists the sample default rules and two pending changes', () => {
    const rules = sampleRules(D);
    expect(rules.filter((r) => r.approvalStatus === 'active').map((r) => [r.ms, r.repository, r.mode])).toEqual([['isms', 'sp', 'link'], ['qms', 'vault', 'stored'], ['bcms', 'gd', 'zero_transit'], ['abms', 'vault', 'stored']]);
    expect(rules.filter((r) => r.approvalStatus === 'pending_approval').map((r) => r.requestedBy)).toEqual(['tono', 'rina']);
  });

  it('asks for the BR-38 confirmation, keeps the change pending, and lets another person approve it', async () => {
    let me = 'rina';
    const adapter = createSampleAdapter(() => D, () => me);
    const body = { ms: 'qms', classification: 'restricted' as const, repository: 'vault', mode: 'stored' as const, priority: 20 };
    expect(await adapter.create(body, 'k')).toMatchObject({ ok: false, error: { status: 409, slug: 'confirmation-required', rule: 'BR-38' } });
    expect(await adapter.create({ ...body, confirm: true }, 'k')).toMatchObject({ ok: true, data: { approvalStatus: 'pending_approval' } });
    const load = await adapter.load();
    if (!load.ok) throw new Error('load failed');
    const added = load.data.rules.find((r) => r.ms === 'qms' && r.classification === 'restricted')!;
    expect(added).toMatchObject({ approvalStatus: 'pending_approval', requestedBy: 'rina' });
    expect(await adapter.approve(added.id)).toMatchObject({ ok: false, error: { status: 422 } });
    me = 'sari';
    expect(await adapter.approve(added.id)).toMatchObject({ ok: true, data: { approvalStatus: 'active', changed: ['qms'] } });
    expect(await adapter.reject(added.id)).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await adapter.create({ ms: 'isms', repository: 'sp', mode: 'stored', priority: 1 }, 'k')).toMatchObject({ ok: false, error: { status: 422 } });
    expect(await adapter.create({ ms: 'isms', classification: 'internal', repository: 'sp', mode: 'pass_through', priority: 1 }, 'k')).toMatchObject({ ok: true, data: { approvalStatus: 'active', changed: ['isms'] } });
    const page = await adapter.objects({ page: 1, pageSize: 5, repository: 'sp' });
    expect(page).toMatchObject({ ok: true, data: { page: 1, pageSize: 5 } });
    if (page.ok) expect(page.data.items.every((o) => o.repository === 'sp')).toBe(true);
  });

  it('keeps the rules and the changes of the session per organisation when the organisation switcher changes the snapshot', async () => {
    const source = createSampleDataSource();
    const snapshotOf = async (org: string) => ({ ...makeDates(SAMPLE.TODAY_S), ...(await source.load(org)), TODAY_S: SAMPLE.TODAY_S }) as unknown as ControllerData;
    const [ndt, rmn] = [await snapshotOf('ndt'), await snapshotOf('rmn')];
    let current = ndt;
    let me = 'rina';
    const adapter = createSampleAdapter(() => current, () => me);
    const rows = async () => {
      const res = await adapter.load();
      return res.ok ? res.data.rules.map((r) => [r.ms, r.repository, r.approvalStatus]) : null;
    };
    expect(await rows()).toEqual([
      ['isms', 'sp', 'active'], ['qms', 'vault', 'active'], ['bcms', 'gd', 'active'], ['abms', 'vault', 'active'],
      ['bcms', 'vault', 'pending_approval'], ['isms', 'sp', 'pending_approval'],
    ]);
    expect(await adapter.approve('sample-rule-pending-bcms')).toMatchObject({ ok: true, data: { approvalStatus: 'active' } });
    current = rmn;
    expect(await rows()).toEqual([['isms', 'sp', 'active'], ['isms', 'sp', 'pending_approval']]);
    const rmnData = await adapter.load();
    expect(rmnData.ok ? [rmnData.data.repos.map((r) => r.slug), rmnData.data.systems.map((s) => s.code)] : null).toEqual([['sp', 'od'], ['ISMS']]);
    // The rule waiting in ndt is not there to decide on, and a decision in rmn stays in rmn.
    me = 'sari';
    expect(await adapter.reject('sample-rule-pending-bcms')).toMatchObject({ ok: false, error: { status: 404 } });
    expect(await adapter.reject('sample-rule-pending-isms')).toMatchObject({ ok: true, data: { approvalStatus: 'rejected' } });
    current = ndt;
    expect(await rows()).toEqual([
      ['isms', 'sp', 'active'], ['qms', 'vault', 'active'], ['bcms', 'gd', 'active'], ['abms', 'vault', 'active'],
      ['bcms', 'vault', 'active'], ['isms', 'sp', 'pending_approval'],
    ]);
    current = rmn;
    expect(await rows()).toEqual([['isms', 'sp', 'active'], ['isms', 'sp', 'rejected']]);
  });

  it('the build chooses the adapter, and a deferred adapter retries a failed module load', async () => {
    expect(await adapterFor(() => ctxOf('en')).load()).toMatchObject({ ok: true, data: { sample: true } });
    const load = vi.fn<() => Promise<RoutingAdapter>>().mockRejectedValueOnce(new Error('chunk')).mockResolvedValue(createSampleAdapter(() => D, () => 'rina'));
    const adapter = deferredAdapter(load);
    await expect(adapter.load()).rejects.toThrow('chunk');
    expect(await adapter.load()).toMatchObject({ ok: true });
  });
});

describe('routing views', () => {
  const data: RoutingData = { rules: sampleRules(D), repos: sampleRepos(D), systems: D.MS.map((m) => ({ slug: m.id, code: m.short })), sample: true };

  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the rules table and the rule form in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf(lang);
        const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
        const html = render(<RulesTable ctx={ctx} data={data} rules={visibleRules(data.rules, false)} busy={null} onEdit={() => undefined} onApprove={() => undefined} onReject={() => undefined} />, ctx, theme);
        for (const p of [TEXT.colSystem, TEXT.colAppliesTo, TEXT.anyClassification, TEXT.anyKind, TEXT.colRepository, TEXT.colMode, TEXT.colState, TEXT.approve, TEXT.reject, TEXT.edit, TEXT.statePending, TEXT.stateActive, TEXT.ownRequest]) {
          expect(html, p[0]).toContain(t(p));
        }
        expect(html).toContain('Zero-transit');
        expect(html).toContain(lang === 'id' ? 'Diminta oleh Tono Hartono' : 'Requested by Tono Hartono');
        const form = render(<RuleDrawer ctx={ctx} adapter={createSampleAdapter(() => D, () => 'rina')} data={data} rule={null} open onClose={() => undefined} onSaved={() => undefined} />, ctx, theme);
        for (const p of [TEXT.formAdd, TEXT.system, TEXT.classification, TEXT.kind, TEXT.repository, TEXT.mode, TEXT.priority, TEXT.note, TEXT.wholeOrg]) expect(form, p[0]).toContain(t(p));
        expect(form).toMatch(/role="dialog"/);
        const edit = render(<RuleDrawer ctx={ctx} adapter={createSampleAdapter(() => D, () => 'rina')} data={data} rule={data.rules[0]} open onClose={() => undefined} onSaved={() => undefined} />, ctx, theme);
        expect(edit).toContain(t(TEXT.formEdit));
        expect(edit).toContain(t(TEXT.systemFixed));
        const files = render(<StoredFiles ctx={ctx} adapter={createSampleAdapter(() => D, () => 'rina')} data={data} />, ctx, theme);
        expect(files).toContain(t(TEXT.filesSub));
        expect(html + form + files).not.toMatch(/[\u2014\u00b7]/);
      });
    }
  }

  it('one reason for a pending rule of the session person; the system label of an organisation-wide rule', () => {
    const ctx = ctxOf('en');
    const own: RuleModel = { ...data.rules.find((r) => r.requestedBy === 'rina' && r.approvalStatus === 'pending_approval')! };
    const html = render(<RulesTable ctx={ctx} data={data} rules={[own]} busy={null} onEdit={() => undefined} onApprove={() => undefined} onReject={() => undefined} />, ctx);
    expect(html.split(TEXT.ownRequest[0]).length).toBe(2);
    expect(html).toMatch(/role="group" aria-describedby="routing-reason-sample-rule-pending-isms"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve/);
    expect(systemLabel(ctx, data, null)).toBe('Whole organisation');
    expect(systemLabel(ctx, data, 'zzz')).toBe('ZZZ');
    expect(STATE_LABELS.superseded.label).toEqual(TEXT.stateSuperseded);
    const reader = render(<RulesTable ctx={ctxOf('en', { orgCan: () => false })} data={data} rules={[own]} busy={null} onEdit={() => undefined} onApprove={() => undefined} onReject={() => undefined} />, ctx);
    expect(reader).not.toContain('Approve');
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries(TEXT)) {
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(/[\u2014\u00b7]/);
    }
  });

  it('is in the Administration group with storage.repository.read and offers Add rule with storage.routing.manage', () => {
    expect(screen).toMatchObject({ id: 'routing', path: '/admin/storage/routing', group: 'admin', scope: 'org', perm: 'storage.repository.read' });
    const ctx = ctxOf('id');
    const actions = screen.pageActions!(ctx);
    expect(actions.map((a) => a.label[1])).toEqual(['Tambah aturan']);
    actions[0].run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('routing', { params: { add: expect.any(Number) } });
    expect(screen.pageActions!(ctxOf('en', { orgCan: () => false }))).toEqual([]);
  });
});
