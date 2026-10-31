// Operator console, end of a contract (MILESTONE-3 M3-09, D.4, D.5): the export and deletion routes against
// @mscd/shared with their permissions, the state lists against the shared enums and machines, the rules of the
// deletion forms (earliest day, the instant of a day, reason, slug), the labels of the purge steps and checks, the API
// adapter over a fake fetch (exports, "Start export" with its idempotency key, the deletion with 404 as none, schedule,
// cancel, retry and the certificate link; every body checked with the shared schema), the parts of the Export and
// Deletion tabs in both languages and themes with and without the operator's rights, and the sample adapter (the build
// of a queued export, the refusals of D.4 and D.5, the retried purge, the certificate) with its SHA-256.
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MACHINES, ORGANIZATION_DELETION_STATUSES, ORGANIZATION_EXPORT_STATUSES, EXPORT_REQUEST_SOURCES, OpsOrganizationExportItem, OpsOrganizationExportQueued,
  OpsReasonBody, OrganizationDeletionResult, OrganizationDeletionSchedule, OrganizationDeletionView, routeById,
} from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import { certificateHref, createApiAdapter, fromDeletion, fromOpsExport } from '../../src/screens/ops/api';
import { DeletionFacts, ReasonDialog, ScheduleDialog, StepsTable, nowOf } from '../../src/screens/ops/DeletionTab';
import { ExportList, ExportTab, StartExportDialog } from '../../src/screens/ops/ExportTab';
import {
  DELETION_STATUSES, EMPTY_SCHEDULE, PURGE_STEPS, STEP_STATUSES, exportInFlight, isCheck, minScheduleDay, reasonError, scheduleAction, scheduleBody, scheduleErrors,
  scheduleForm, scheduleInstant, stepLabel, instantDay,
} from '../../src/screens/ops/lifecycle-model';
import type { DeletionView } from '../../src/screens/ops/lifecycle-model';
import { LIFE_TEXT } from '../../src/screens/ops/lifecycle-text';
import { fromDetail } from '../../src/screens/ops/api';
import { ArchivedNote } from '../../src/screens/ops/StatusTab';
import { ROUTES, ROUTE_IDS } from '../../src/screens/ops/routes';
import { createSampleAdapter, resetSampleOps } from '../../src/screens/ops/sample';
import { manifestText, partText, sha256Hex } from '../../src/screens/ops/sample-lifecycle';
import { EXPORT_SOURCES, EXPORT_STATUSES } from '../../src/screens/org-export/model';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, sampleD, t, textProblems } from './ctx-m2-16';

const MULTI = ['ops.read', 'ops.jobs.run', 'ops.users.manage', 'ops.tenants.manage', 'ops.entitlements.manage', 'license.manage', 'pack.install'];
const READER = ['ops.read', 'license.manage'];

const EXPORT = OpsOrganizationExportItem.parse({
  id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', status: 'ready', requestedVia: 'operator', requestedAt: '2026-10-31T02:00:00Z', completedAt: '2026-10-31T03:10:00Z',
  expiresAt: '2026-11-07T03:10:00Z', isFinal: false, partCount: 2, sizeBytes: 1203765248, downloadCount: 1,
});
const FINAL = { ...EXPORT, id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8e', requestedVia: 'offboarding' as const, isFinal: true, expiresAt: null };
const VIEW = OrganizationDeletionView.parse({
  id: '1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b', status: 'failed', scheduledFor: '2026-12-30T00:00:00Z', scheduledBy: null, reason: 'The read-only period ended on 2026-11-30',
  archivedAt: '2026-11-30T03:00:00Z', earliestAllowed: '2026-12-07T03:00:00Z', finalExportId: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', startedAt: '2026-12-30T00:00:00Z',
  completedAt: null, failedStep: 'vault', error: 'The storage gateway did not answer', vaultObjectsDeleted: null, certificateId: null,
  steps: [
    { step: 'check', status: 'done', at: '2026-12-30T00:01:00Z', detail: 'The deletion is due' },
    { step: 'vault', status: 'failed', at: '2026-12-30T00:03:00Z', detail: 'The storage gateway did not answer' },
    { step: 'check: audit chain', status: 'done', at: null, detail: 'The platform chain verifies' },
  ],
});
const RESULT = (status: 'scheduled' | 'cancelled' | 'running', message?: [string, string]) => OrganizationDeletionResult.parse({
  ok: true, changed: [], ...(message ? { message } : {}), data: { id: VIEW.id, status, scheduledFor: '2026-12-10T03:00:00.000Z' },
});

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes);
  const c = new ApiClient({ fetch: f.fetch });
  c.setCsrfToken('csrf-token-0123456789');
  return { ...f, client: c };
}

beforeAll(async () => {
  await loadSampleD();
});
beforeEach(() => resetSampleOps());

describe('End of a contract: contract', () => {
  it('the export and deletion routes match the shared table and its permissions', () => {
    const names = ['exportsList', 'exportsCreate', 'deletionGet', 'deletionSchedule', 'deletionCancel', 'deletionRetry', 'deletionCertificate'] as const;
    for (const name of names) {
      const route = routeById(ROUTE_IDS[name]);
      expect([route.method, route.path], name).toEqual([...ROUTES[name]]);
      expect(route.scope, name).toBe('platform');
    }
    expect(['exportsList', 'deletionGet', 'deletionCertificate'].map((n) => routeById(ROUTE_IDS[n as keyof typeof ROUTES]).permission)).toEqual(Array(3).fill('ops.read'));
    expect(['exportsCreate', 'deletionSchedule', 'deletionCancel', 'deletionRetry'].map((n) => routeById(ROUTE_IDS[n as keyof typeof ROUTES]).permission)).toEqual(Array(4).fill('ops.tenants.manage'));
    // The operator never downloads an export: the console has no route of the Tenant Admins.
    expect(Object.values(ROUTE_IDS).filter((id) => id.startsWith('exports.'))).toEqual([]);
    expect(certificateHref('ndt')).toBe('/api/v1/ops/organizations/ndt/deletion/certificate');
  });

  it('the states are the shared enum values and machines', () => {
    expect([...EXPORT_STATUSES]).toEqual([...ORGANIZATION_EXPORT_STATUSES]);
    expect([...EXPORT_SOURCES]).toEqual([...EXPORT_REQUEST_SOURCES]);
    expect([...DELETION_STATUSES]).toEqual([...ORGANIZATION_DELETION_STATUSES]);
    expect([...MACHINES['organization_export.status'].states]).toEqual([...EXPORT_STATUSES]);
    expect([...MACHINES['organization_deletion.status'].states]).toEqual([...DELETION_STATUSES]);
    expect([...STEP_STATUSES]).toEqual(['pending', 'running', 'done', 'failed']);
    // The operator's deletion moves are the routes the tab calls (Milestone 3 J.8).
    const vias = MACHINES['organization_deletion.status'].transitions.filter((r) => r.permission === 'ops.tenants.manage').map((r) => `${r.from ?? 'new'}>${r.to}:${r.via}`);
    expect(vias.sort()).toEqual(['failed>running:ops.deletion.retry', 'new>scheduled:ops.deletion.schedule', 'scheduled>cancelled:ops.deletion.cancel']);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    expect(textProblems(LIFE_TEXT, ['colExportStatus', 'factStatus', 'deletionOn', 'scheduleTitle'])).toEqual([]);
  });
});

describe('End of a contract: rules', () => {
  it('labels every purge step and check, and keeps an unknown name', () => {
    for (const step of PURGE_STEPS) expect(stepLabel(step)[0], step).not.toBe(step);
    expect(stepLabel('vault')).toBe(LIFE_TEXT.stepVault);
    expect(isCheck('check: data key')).toBe(true);
    expect(isCheck('checks')).toBe(false);
    expect(stepLabel('check: data key')).toBe(LIFE_TEXT.checkKey);
    expect(stepLabel('check: sky')).toEqual(['Check: sky', 'Pemeriksaan: sky']);
    expect(stepLabel('later')).toEqual(['later', 'later']);
  });

  it('an export is in flight while requested, queued or building', () => {
    expect(exportInFlight([{ status: 'ready' }, { status: 'expired' }])).toBe(false);
    for (const status of ['requested', 'queued', 'building'] as const) expect(exportInFlight([{ status }])).toBe(true);
  });

  it('the schedule form: the earliest day, the instant of a day, the reason and the slug', () => {
    const view = fromDeletion({ ...VIEW, status: 'scheduled' });
    expect(minScheduleDay(view, '2026-12-01')).toBe('2026-12-07');
    expect(minScheduleDay(view, '2026-12-20')).toBe('2026-12-20');
    expect(minScheduleDay(null, '2026-12-20')).toBe('2026-12-20');
    expect(scheduleForm(view)).toEqual({ ...EMPTY_SCHEDULE, day: '2026-12-30' });
    expect(scheduleForm(null).day).toBe('');
    expect(scheduleErrors('ndt', { day: '', reason: 'x', confirm: '' }, '2026-12-07')).toEqual({ day: LIFE_TEXT.dayMissing, reason: LIFE_TEXT.reasonShort, confirmSlug: LIFE_TEXT.slugMissing });
    expect(scheduleErrors('ndt', { day: '2026-12-06', reason: 'Customer asked', confirm: 'NDT' }, '2026-12-07')).toEqual({ day: LIFE_TEXT.dayTooSoon, confirmSlug: LIFE_TEXT.slugMismatch });
    expect(scheduleErrors('ndt', { day: '2026-12-07', reason: 'Customer asked', confirm: ' ndt ' }, '2026-12-07')).toEqual({});
    const now = new Date('2026-12-01T10:00:00Z');
    // The time of day of the current date; never before the earliest allowed instant or now.
    expect(scheduleInstant('2026-12-12', view, now)).toBe('2026-12-12T00:00:00.000Z');
    expect(scheduleInstant('2026-12-07', { ...view, scheduledFor: '2026-12-30T00:00:00Z' }, now)).toBe('2026-12-07T03:00:00.000Z');
    expect(scheduleInstant('2026-12-01', null, now)).toBe('2026-12-01T10:01:00.000Z');
    const body = scheduleBody({ day: '2026-12-12', reason: ' Customer asked in writing ', confirm: ' ndt ' }, view, now);
    expect(body).toEqual({ scheduledFor: '2026-12-12T00:00:00.000Z', reason: 'Customer asked in writing', confirmSlug: 'ndt' });
    expect(OrganizationDeletionSchedule.parse(body)).toEqual(body);
    expect(reasonError('no')).toBe(LIFE_TEXT.reasonShort);
    expect(reasonError('Customer asked')).toBeNull();
    expect(instantDay('2026-12-30T23:30:00-05:00')).toBe('2026-12-31');
    expect(instantDay('not a date')).toBe('not a date');
    expect(nowOf(ctxOf()).toISOString().slice(0, 10)).toBe(new Date(`${sampleD().TODAY_S}T12:00:00`).toISOString().slice(0, 10));
  });

  it('offers Change date while scheduled and Schedule deletion for an archived organisation without one', () => {
    expect(scheduleAction('archived', { status: 'scheduled' })).toBe('change');
    expect(scheduleAction('archived', { status: 'cancelled' })).toBe('schedule');
    expect(scheduleAction('archived', null)).toBe('schedule');
    expect(scheduleAction('archived', { status: 'failed' })).toBeNull();
    expect(scheduleAction('offboarding', null)).toBeNull();
    expect(scheduleAction('deleted', { status: 'completed' })).toBeNull();
  });
});

describe('End of a contract: API adapter', () => {
  it('reads the exports and starts one with the reason and an idempotency key', async () => {
    const queued = OpsOrganizationExportQueued.parse({ ok: true, changed: [], message: ['The export of ndt was queued', 'Ekspor ndt diantrekan'], data: { id: EXPORT.id, status: 'queued' } });
    const busy = { messageKey: 'export_in_progress', messages: { en: 'Another export of this organisation is waiting for approval or being built.', id: 'Ekspor lain sedang dibuat.' } };
    const f = client({
      'GET /api/v1/ops/organizations/ndt/exports': json([EXPORT, FINAL]),
      'POST /api/v1/ops/organizations/ndt/exports': [json(queued, 202), problem(409, 'conflict', busy)],
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.exports('ndt')).toEqual({ ok: true, data: [fromOpsExport(EXPORT), fromOpsExport(FINAL)] });
    expect(await adapter.startExport('ndt', 'Asked by the Tenant Admin in ticket 4411', 'key-1')).toEqual({ ok: true, data: { id: EXPORT.id, message: queued.message } });
    const refused = await adapter.startExport('ndt', 'Again', 'key-2');
    expect(!refused.ok && [refused.error.messageKey, refused.error.message[0]]).toEqual(['export_in_progress', busy.messages.en]);
    const posts = f.calls.filter((c) => c.method === 'POST');
    for (const p of posts) expect(OpsReasonBody.parse(p.body)).toEqual(p.body);
    expect(posts.map((p) => p.headers['idempotency-key'])).toEqual(['key-1', 'key-2']);
    expect(posts.every((p) => p.headers['x-csrf-token'] === 'csrf-token-0123456789')).toBe(true);
  });

  it('reads the deletion (404 is none), schedules, cancels and retries with the shared bodies', async () => {
    const tooSoon = { messageKey: 'deletion_too_soon', messages: { en: 'The deletion of ndt cannot be earlier than 2026-12-07T03:00:00.000Z', id: 'Penghapusan ndt tidak boleh lebih awal.' } };
    const f = client({
      'GET /api/v1/ops/organizations/ndt/deletion': json(VIEW),
      'GET /api/v1/ops/organizations/rmn/deletion': problem(404, 'not-found'),
      'GET /api/v1/ops/organizations/bsd/deletion': problem(409, 'conflict', { messageKey: 'single_tenancy' }),
      'POST /api/v1/ops/organizations/ndt/deletion': [json(RESULT('scheduled', ['The deletion of ndt is scheduled for 2026-12-10.', 'Penghapusan ndt dijadwalkan.'])), problem(409, 'conflict', tooSoon)],
      'POST /api/v1/ops/organizations/ndt/deletion/cancel': json(RESULT('cancelled')),
      'POST /api/v1/ops/organizations/ndt/deletion/retry': json(RESULT('running')),
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.deletion('ndt')).toEqual({ ok: true, data: fromDeletion(VIEW) });
    expect(await adapter.deletion('rmn')).toEqual({ ok: true, data: null });
    const single = await adapter.deletion('bsd');
    expect(!single.ok && single.error.messageKey).toBe('single_tenancy');
    const body = { scheduledFor: '2026-12-10T03:00:00.000Z', reason: 'Customer asked in writing', confirmSlug: 'ndt' };
    const scheduled = await adapter.scheduleDeletion('ndt', body);
    expect(scheduled.ok && scheduled.data).toMatchObject({ status: 'scheduled', message: ['The deletion of ndt is scheduled for 2026-12-10.', 'Penghapusan ndt dijadwalkan.'] });
    const soon = await adapter.scheduleDeletion('ndt', body);
    expect(!soon.ok && soon.error.messageKey).toBe('deletion_too_soon');
    expect((await adapter.cancelDeletion('ndt', 'Customer asked to wait')).ok).toBe(true);
    expect((await adapter.retryDeletion('ndt', 'Gateway is back')).ok).toBe(true);
    const posts = f.calls.filter((c) => c.method === 'POST');
    expect(OrganizationDeletionSchedule.parse(posts[0].body)).toEqual(body);
    for (const p of posts.slice(2)) expect(OpsReasonBody.parse(p.body)).toEqual(p.body);
    expect(await adapter.certificate('ndt')).toEqual({ ok: true, data: { href: '/api/v1/ops/organizations/ndt/deletion/certificate', fileName: '' } });
  });
});

describe('End of a contract: parts', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`render in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme, mode: 'api', org: MULTI });
        const adapter = createSampleAdapter(() => sampleD());
        const detail = { ...fromDetail({ ...DETAIL_BASE, status: 'archived' }), deletion: { status: 'failed' as const, scheduledFor: VIEW.scheduledFor } };
        const view: DeletionView = fromDeletion(VIEW);
        const html = render(
          <>
            <ExportList ctx={ctx} exports={[fromOpsExport(EXPORT), fromOpsExport(FINAL)]} />
            <StartExportDialog ctx={ctx} adapter={adapter} detail={detail} open onClose={() => undefined} onStarted={() => undefined} />
            <DeletionFacts ctx={ctx} view={view} />
            <StepsTable ctx={ctx} steps={view.steps} />
            <ScheduleDialog ctx={ctx} adapter={adapter} detail={detail} view={{ ...view, status: 'scheduled' }} mode="change" onClose={() => undefined} onDone={() => undefined} />
            <ReasonDialog ctx={ctx} adapter={adapter} detail={detail} view={view} kind="retry" onClose={() => undefined} onDone={() => undefined} />
            <ArchivedNote ctx={ctx} detail={detail} />
          </>,
          ctx,
          theme,
        );
        const texts = [
          LIFE_TEXT.colRequested, LIFE_TEXT.final, LIFE_TEXT.keptUntilClose, LIFE_TEXT.start1, LIFE_TEXT.startExport, LIFE_TEXT.statusFailed, LIFE_TEXT.bySystem,
          LIFE_TEXT.stepCheck, LIFE_TEXT.stepVault, LIFE_TEXT.checkChain, LIFE_TEXT.stepFailed, LIFE_TEXT.schedule1, LIFE_TEXT.day, LIFE_TEXT.retry2, LIFE_TEXT.finalTaken,
        ];
        for (const text of texts) expect(html, text[0]).toContain(esc(t(text, lang)));
        expect(html).toContain(esc(ctx.fill(LIFE_TEXT.dayHint, { date: ctx.D!.fmt(minScheduleDay(view, sampleD().TODAY_S), lang) })));
        expect(html).toContain(esc(ctx.fill(LIFE_TEXT.retry1, { step: t(LIFE_TEXT.stepVault, lang) })));
        expect(html).toContain(esc(ctx.fill(LIFE_TEXT.confirmSlug, { slug: 'ndt' })));
        // Sizes in the language of the interface; the operator sees no download.
        expect(html).toContain(lang === 'id' ? '1,1 GB' : '1.1 GB');
        expect(html).not.toMatch(/>(Download|Unduh)</);
        expect(html).not.toMatch(/[—·]/);
      });
    }
  }

  it('an operator who may only read sees the exports without Start export', () => {
    const ctx = ctxOf({ mode: 'api', org: READER });
    const adapter = createSampleAdapter(() => sampleD());
    const detail = fromDetail(DETAIL_BASE);
    const reader = render(<ExportTab ctx={ctx} adapter={adapter} detail={detail} onChanged={() => undefined} />, ctx);
    expect(reader).toContain(esc(t(LIFE_TEXT.noRightExport)));
    expect(reader).not.toContain(esc(t(LIFE_TEXT.startExport)));
    const manager = ctxOf({ mode: 'api', org: MULTI });
    expect(render(<ExportTab ctx={manager} adapter={adapter} detail={detail} onChanged={() => undefined} />, manager)).toContain(esc(t(LIFE_TEXT.startExport)));
    const archived = render(<ExportTab ctx={manager} adapter={adapter} detail={{ ...detail, status: 'archived' }} onChanged={() => undefined} />, manager);
    expect(archived).toContain(esc(t(LIFE_TEXT.exportNotHere)));
  });
});

const DETAIL_BASE = {
  id: '00000000-0000-4000-8000-00000000a001', slug: 'ndt', name: 'PT Nusantara Digital Teknologi', status: 'active' as const, region: 'id',
  createdAt: '2026-01-15T03:00:00Z', memberCount: 86, systemCount: 4, entitlement: null, domains: [], lastSignInAt: null,
  offboardingEndsAt: null, deletion: null, lastExport: null,
};

describe('End of a contract: sample adapter', () => {
  it('builds a queued export one step per read and refuses a second one while it runs', async () => {
    const adapter = createSampleAdapter(() => sampleD());
    const before = await adapter.exports('ndt');
    expect(before.ok && before.data.map((e) => e.status)).toEqual(['requested', 'ready', 'rejected', 'expired']);
    // Tono's request of 28 Sep still waits for a decision: no second export.
    const busy = await adapter.startExport('ndt', 'Asked by the customer');
    expect(!busy.ok && busy.error.messageKey).toBe('export_in_progress');
    const started = await adapter.startExport('rmn', 'Asked by the customer');
    expect(started.ok).toBe(true);
    const steps = [];
    for (let i = 0; i < 3; i++) {
      const read = await adapter.exports('rmn');
      steps.push(read.ok ? read.data[0].status : 'error');
    }
    expect(steps).toEqual(['building', 'ready', 'ready']);
    const ready = await adapter.exports('rmn');
    expect(ready.ok && ready.data[0]).toMatchObject({ requestedVia: 'operator', partCount: 2, isFinal: false });
    expect((await adapter.startExport('cahaya_retail', 'Too late')).ok).toBe(false);
    const short = await adapter.startExport('bsd', 'no');
    expect(!short.ok && short.error.status).toBe(400);
  });

  it('schedules, refuses before the earliest day, cancels, retries a failed purge and gives the certificate', async () => {
    const adapter = createSampleAdapter(() => sampleD());
    const scheduled = await adapter.deletion('cahaya_retail');
    expect(scheduled.ok && scheduled.data).toMatchObject({ status: 'scheduled', earliestAllowed: '2026-09-27T03:00:00Z', steps: [] });
    const early = await adapter.scheduleDeletion('cahaya_retail', { scheduledFor: '2026-09-25T03:00:00.000Z', reason: 'Customer asked', confirmSlug: 'cahaya_retail' });
    expect(!early.ok && early.error.messageKey).toBe('deletion_too_soon');
    const wrong = await adapter.scheduleDeletion('cahaya_retail', { scheduledFor: '2026-10-10T03:00:00.000Z', reason: 'Customer asked', confirmSlug: 'cahaya' });
    expect(!wrong.ok && wrong.error.messageKey).toBe('confirmation_mismatch');
    const notArchived = await adapter.scheduleDeletion('ndt', { scheduledFor: '2026-10-10T03:00:00.000Z', reason: 'Customer asked', confirmSlug: 'ndt' });
    expect(!notArchived.ok && notArchived.error.messageKey).toBe('deletion_not_archived');
    const moved = await adapter.scheduleDeletion('cahaya_retail', { scheduledFor: '2026-10-10T03:00:00.000Z', reason: 'Customer asked in writing', confirmSlug: 'cahaya_retail' });
    expect(moved.ok && moved.data).toMatchObject({ status: 'scheduled', scheduledFor: '2026-10-10T03:00:00.000Z' });
    const list = await adapter.organizations({ page: 1, pageSize: 25, q: 'cahaya' });
    expect(list.ok && list.data.items[0].deletion).toEqual({ status: 'scheduled', scheduledFor: '2026-10-10T03:00:00.000Z' });
    expect((await adapter.cancelDeletion('cahaya_retail', 'Customer asked to wait')).ok).toBe(true);
    expect((await adapter.cancelDeletion('cahaya_retail', 'Again')).ok).toBe(false);
    const after = await adapter.organization('cahaya_retail');
    expect(after.ok && after.data.deletion).toBeNull();
    expect((await adapter.retryDeletion('cahaya_retail', 'Nothing failed')).ok).toBe(false);
    // The failed purge runs again from the vault step and finishes on the next read.
    const retried = await adapter.retryDeletion('delta_konstruksi', 'Gateway is back');
    expect(retried.ok && retried.data.message?.[0]).toBe('The purge of delta_konstruksi runs again from the step vault.');
    const finished = await adapter.deletion('delta_konstruksi');
    expect(finished.ok && finished.data).toMatchObject({ status: 'completed', failedStep: null });
    expect(finished.ok && finished.data!.steps.filter((s) => s.step.startsWith('check: ')).every((s) => s.status === 'done')).toBe(true);
    const deleted = await adapter.organization('delta_konstruksi');
    expect(deleted.ok && deleted.data.status).toBe('deleted');
    const certificate = await adapter.certificate('karya_tekstil');
    expect(certificate.ok && certificate.data.fileName).toBe('deletion-certificate-karya_tekstil-2026-08-14.json');
    expect((await adapter.certificate('cahaya_retail')).ok).toBe(false);
    expect((await adapter.deletion('ndt')).ok && (await adapter.deletion('ndt'))).toEqual({ ok: true, data: null });
  });

  it('computes the SHA-256 of the sample files as the system tools do', () => {
    for (const text of ['', 'abc', 'MSCD sample build\n'.repeat(40), partText({ name: 'PT Nusantara Digital Teknologi', slug: 'ndt' }, 'x', 1, 2), 'Kebijakan keamanan informasi: ✓']) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
    const manifest = manifestText({ name: 'PT Nusantara Digital Teknologi', slug: 'ndt' }, { id: 'x', completedAt: null, parts: [] });
    expect(JSON.parse(manifest)).toMatchObject({ format: 'mscd-organization-export', sample: true });
  });
});
