// Organisation export (MILESTONE-3 M3-09, D.4): the routes against @mscd/shared with their permission, the screen
// definition, the rules of the view model (requester and approval texts, the requester rule of H.2, sizes, notes,
// the read-only period), the API adapter over a fake fetch (settings, list, detail, the request with its idempotency
// key, the decision, the download links; every body checked with the shared schema), the parts in both languages and
// themes ("You requested this export", the request for one and for two Tenant Admins, the files with their SHA-256,
// "How to check", the note and the banner of the read-only period), and the sample adapter over the store the operator
// console shares (approval, refusals, the build, the downloads with their real SHA-256, the read-only period after the
// operator's move).
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OrganizationExportCreate, OrganizationExportCreated, OrganizationExportDecided, OrganizationExportDecision, OrganizationExportDetail, OrganizationExportItem,
  OrganizationSettings, routeById,
} from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import { createSampleAdapter as createOpsSample, resetSampleOps } from '../../src/screens/ops/sample';
import { layerItems } from '../../src/screens/org-export/actions';
import { createApiAdapter, fromDetail, fromExport, fromSettings, manifestHref, partHref } from '../../src/screens/org-export/api';
import { ReadOnlyBanner } from '../../src/screens/org-export/Banner';
import screen from '../../src/screens/org-export/index';
import {
  EXPORT_STATUSES, EXPORT_STATUS_TEXT, anyBuilding, approvalText, inReadOnlyPeriod, isMine, manifestName, noteError, partsText, rejectError, requesterText, selfHandle,
  sizeText,
} from '../../src/screens/org-export/model';
import type { OrgExport, OrgExportDetail } from '../../src/screens/org-export/model';
import { ExportTable, FilesTable, HowToCheck, ReadOnlyNote, RejectDialog, RequestDialog } from '../../src/screens/org-export/parts';
import { ROUTES, ROUTE_IDS } from '../../src/screens/org-export/routes';
import { createSampleAdapter } from '../../src/screens/org-export/sample';
import { noteLifecycle, resetLifecycle } from '../../src/screens/org-export/store';
import { TEXT } from '../../src/screens/org-export/text';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, sampleD, t, textProblems } from './ctx-m2-16';

const TA = ['org.export.manage', 'org.settings.manage'];
const ITEM = OrganizationExportItem.parse({
  id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', status: 'ready', requestedVia: 'tenant_admin', requestedBy: { handle: 'tenant.admin', displayName: 'Tenant Admin' },
  requestedAt: '2026-10-31T02:00:00Z', decidedBy: { handle: 'rina', displayName: 'Rina Kusuma' }, decidedAt: '2026-10-31T02:20:00Z', decisionNote: null, isFinal: false,
  partCount: 2, fileCount: 412, sizeBytes: 1203765248, expiresAt: '2026-11-07T03:10:00Z', completedAt: '2026-10-31T03:10:00Z', downloadCount: 1, error: null,
});
const REQUESTED = OrganizationExportItem.parse({
  ...ITEM, id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8e', status: 'requested', decidedBy: null, decidedAt: null, partCount: null, fileCount: null, sizeBytes: null,
  expiresAt: null, completedAt: null, downloadCount: 0,
});
const DETAIL = OrganizationExportDetail.parse({
  ...ITEM,
  parts: [
    { part: 1, name: 'mscd-export-tst-2026-10-31-part-1.tar.gz', sizeBytes: 734003200, sha256: 'ab'.repeat(32) },
    { part: 2, name: 'mscd-export-tst-2026-10-31-part-2.tar.gz', sizeBytes: 469762048, sha256: 'cd'.repeat(32) },
  ],
  manifestSha256: 'ef'.repeat(32),
});
const SETTINGS = OrganizationSettings.parse({
  slug: 'tst', name: 'Test Organisation', timeZone: 'Asia/Jakarta', siteCount: 1, localLogin: 'allowed', installationId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
  tenancyMode: 'single', activeAdminCount: 2, etag: 'W/"1790380800000"', offboardingEndsAt: '2026-11-30T03:00:00Z', deletionScheduledFor: '2026-12-30T03:00:00Z',
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
beforeEach(() => {
  resetSampleOps();
  resetLifecycle();
});

describe('Organisation export contract', () => {
  it('the routes match the shared table; every export route needs org.export.manage', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    for (const name of ['list', 'create', 'get', 'decide', 'manifest', 'download'] as const) {
      expect(routeById(ROUTE_IDS[name]).permission, name).toBe('org.export.manage');
      expect(routeById(ROUTE_IDS[name]).id.startsWith('exports.'), name).toBe(true);
    }
    expect(routeById(ROUTE_IDS.organization).permission).toBe('org.settings.manage');
    expect(partHref(ITEM.id, 2)).toBe(`/api/v1/admin/organization/exports/${ITEM.id}/parts/2`);
    expect(manifestHref(ITEM.id)).toBe(`/api/v1/admin/organization/exports/${ITEM.id}/manifest`);
  });

  it('is the organisation screen of the Administration group with the page action Export all data', () => {
    expect(screen).toMatchObject({ id: 'org-export', path: '/admin/org-export', group: 'admin', scope: 'org', perm: 'org.export.manage', roles: ['manager'] });
    const labels = (org: string[]) => (screen.pageActions?.(ctxOf({ mode: 'api', org })) ?? []).map((a) => a.label[0]);
    expect(labels(TA)).toEqual(['Export all data']);
    expect(labels(['org.settings.manage'])).toEqual([]);
    const ctx = ctxOf();
    screen.pageActions!(ctx)[0].run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('org-export', { params: { request: expect.any(Number) } });
    expect(layerItems?.map((i) => i.id)).toEqual(['org-export.read-only']);
    expect(layerItems?.[0].visible?.(ctxOf({ mode: 'api', org: TA }))).toBe(true);
    expect(layerItems?.[0].visible?.(ctxOf({ mode: 'api', org: ['ms.read'] }))).toBe(false);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    const same = ['colStatus', 'factStatus', 'colSha', 'viaTenantAdmin', 'checkLinux', 'checkMac', 'checkWindows'];
    expect(textProblems(TEXT, same)).toEqual([]);
    expect(Object.keys(EXPORT_STATUS_TEXT)).toEqual([...EXPORT_STATUSES]);
  });
});

describe('Organisation export rules', () => {
  const ctx = () => ctxOf();
  it('names who asked and who approved, or why no approval was needed', () => {
    const e = fromExport(ITEM);
    expect(requesterText(ctx(), e)).toBe('Tenant Admin');
    expect(requesterText(ctx(), { requestedBy: null, requestedVia: 'operator' })).toBe('MSCD operator');
    expect(requesterText(ctx(), { requestedBy: null, requestedVia: 'offboarding' })).toBe('End of contract');
    expect(approvalText(ctx(), e)).toBe('Approved by Rina Kusuma');
    expect(approvalText(ctx(), { ...e, status: 'rejected' })).toBe('Rejected by Rina Kusuma');
    expect(approvalText(ctx(), fromExport(REQUESTED))).toBe(t(TEXT.awaiting));
    expect(approvalText(ctx(), { ...e, decidedBy: null })).toBe(t(TEXT.notNeededSingle));
    expect(approvalText(ctx(), { ...e, decidedBy: null, requestedVia: 'operator' })).toBe(t(TEXT.notNeededOperator));
    expect(approvalText(ctx(), { ...e, decidedBy: null, requestedVia: 'offboarding' })).toBe(t(TEXT.notNeededFinal));
    expect(approvalText(ctx(), { ...fromExport(REQUESTED), status: 'expired' })).toBe(t(TEXT.expiredWithout));
  });

  it('the requester is never offered the approval; sizes, parts, notes and the read-only period', () => {
    expect(isMine(fromExport(REQUESTED), 'tenant.admin')).toBe(true);
    expect(isMine(fromExport(REQUESTED), 'rina')).toBe(false);
    expect(isMine({ requestedBy: null }, 'rina')).toBe(false);
    expect(selfHandle(ctxOf({ me: { user: { handle: 'tenant.admin' } } as never }))).toBe('tenant.admin');
    expect(selfHandle(ctxOf())).toBe('rina');
    expect(anyBuilding([{ status: 'ready' }, { status: 'queued' }])).toBe(true);
    expect(anyBuilding([{ status: 'requested' }])).toBe(false);
    expect(sizeText(0, 'en')).toBe('0 B');
    expect(sizeText(734, 'en')).toBe('734 B');
    expect(sizeText(1536, 'en')).toBe('1.5 KB');
    expect(sizeText(1203765248, 'en')).toBe('1.1 GB');
    expect(sizeText(1203765248, 'id')).toBe('1,1 GB');
    expect(sizeText(200 * 1024 * 1024, 'en')).toBe('200 MB');
    expect(sizeText(null, 'en')).toBe('-');
    expect(partsText(ctx(), 1)).toBe('1 part');
    expect(partsText(ctx(), 3)).toBe('3 parts');
    expect(partsText(ctx(), null)).toBe('');
    expect(noteError('x'.repeat(500))).toBeNull();
    expect(noteError('x'.repeat(501))).toBe(TEXT.noteLong);
    expect(rejectError(' ')).toBe(TEXT.rejectNoteMissing);
    expect(rejectError('Not agreed')).toBeNull();
    expect(manifestName(fromDetail(DETAIL))).toBe('mscd-export-tst-2026-10-31-manifest.json');
    expect(manifestName({ id: '5a6b7c8d-xx', parts: [] })).toBe('mscd-export-5a6b7c8d-manifest.json');
    expect(inReadOnlyPeriod(fromSettings(SETTINGS))).toBe(true);
    expect(inReadOnlyPeriod({ ...fromSettings(SETTINGS), offboardingEndsAt: null })).toBe(false);
    expect(inReadOnlyPeriod(null)).toBe(false);
  });
});

describe('Organisation export API adapter', () => {
  it('reads the settings, the list and one export', async () => {
    const f = client({
      'GET /api/v1/admin/organization': json(SETTINGS),
      'GET /api/v1/admin/organization/exports': json([REQUESTED, ITEM]),
      [`GET /api/v1/admin/organization/exports/${ITEM.id}`]: json(DETAIL),
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.lifecycle()).toEqual({ ok: true, data: { activeAdminCount: 2, offboardingEndsAt: '2026-11-30T03:00:00Z', deletionScheduledFor: '2026-12-30T03:00:00Z' } });
    expect(await adapter.list()).toEqual({ ok: true, data: [fromExport(REQUESTED), fromExport(ITEM)] });
    expect(await adapter.get(ITEM.id)).toEqual({ ok: true, data: fromDetail(DETAIL) });
    const files = await adapter.partFile(fromDetail(DETAIL), fromDetail(DETAIL).parts[1]);
    expect(files).toEqual({ ok: true, data: { href: partHref(ITEM.id, 2), fileName: 'mscd-export-tst-2026-10-31-part-2.tar.gz' } });
    // The manifest and the certificate take the server's file name (Content-Disposition); a part keeps its own name.
    expect(await adapter.manifestFile(fromDetail(DETAIL))).toEqual({ ok: true, data: { href: manifestHref(ITEM.id), fileName: '' } });
  });

  it('requests with an idempotency key, keeps the refusals of D.4, and decides with the shared bodies', async () => {
    const created = OrganizationExportCreated.parse({ ok: true, changed: [], message: ['The export waits for another Tenant Admin to approve it.', 'Ekspor menunggu persetujuan Tenant Admin lain.'], data: { id: REQUESTED.id, status: 'requested', approvalNeeded: true } });
    const busy = { messageKey: 'export_in_progress', messages: { en: 'Another export of this organisation is waiting for approval or being built.', id: 'Ekspor lain sedang menunggu.' } };
    const sod = { rule: 'SOD-SELF-APPROVE', messages: { en: 'You cannot approve what you asked for yourself.', id: 'Anda tidak dapat menyetujui apa yang Anda minta sendiri.' } };
    const f = client({
      'POST /api/v1/admin/organization/exports': [json(created, 202), problem(409, 'conflict', busy)],
      [`POST /api/v1/admin/organization/exports/${REQUESTED.id}/decision`]: [
        problem(422, 'business-rule', sod),
        json(OrganizationExportDecided.parse({ ok: true, changed: [], data: { id: REQUESTED.id, status: 'queued' } })),
        json(OrganizationExportDecided.parse({ ok: true, changed: [], data: { id: REQUESTED.id, status: 'rejected' } })),
      ],
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.create('For the archive', 'key-1')).toEqual({ ok: true, data: { id: REQUESTED.id, status: 'requested', approvalNeeded: true, message: created.message } });
    const refused = await adapter.create(null, 'key-2');
    expect(!refused.ok && [refused.error.messageKey, refused.error.message[0]]).toEqual(['export_in_progress', busy.messages.en]);
    const own = await adapter.decide(REQUESTED.id, true, null);
    expect(!own.ok && [own.error.rule, own.error.message[0]]).toEqual(['SOD-SELF-APPROVE', sod.messages.en]);
    expect(await adapter.decide(REQUESTED.id, true, null)).toEqual({ ok: true, data: { id: REQUESTED.id, status: 'queued', message: null } });
    expect((await adapter.decide(REQUESTED.id, false, 'Not agreed with the board')).ok).toBe(true);
    const posts = f.calls.filter((c) => c.method === 'POST');
    expect(posts.slice(0, 2).map((p) => [OrganizationExportCreate.parse(p.body), p.headers['idempotency-key']])).toEqual([[{ note: 'For the archive' }, 'key-1'], [{}, 'key-2']]);
    for (const p of posts.slice(2)) expect(OrganizationExportDecision.parse(p.body)).toEqual(p.body);
    expect(posts.slice(2).map((p) => p.body)).toEqual([{ approve: true }, { approve: true }, { approve: false, note: 'Not agreed with the board' }]);
    expect(posts.every((p) => p.headers['x-csrf-token'] === 'csrf-token-0123456789')).toBe(true);
  });
});

describe('Organisation export parts', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`render in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme, mode: 'api', org: TA, me: { user: { handle: 'tenant.admin', email: 'tenant.admin@mscd.test', displayName: 'Tenant Admin', id: 'x', jobTitle: null } } as never });
        const adapter = createSampleAdapter(() => sampleD(), () => 'ndt', () => ({ handle: 'rina', name: 'Rina Kusuma' }));
        const settings = fromSettings(SETTINGS);
        const rows: OrgExport[] = [fromExport(REQUESTED), { ...fromExport(REQUESTED), id: 'other', requestedBy: { handle: 'rina', displayName: 'Rina Kusuma' } }, fromExport(ITEM)];
        const detail: OrgExportDetail = fromDetail(DETAIL);
        const html = render(
          <>
            <ReadOnlyNote ctx={ctx} lifecycle={settings} />
            <ExportTable ctx={ctx} exports={rows} self="tenant.admin" onOpen={() => undefined} onApprove={() => undefined} onReject={() => undefined} />
            <RequestDialog ctx={ctx} adapter={adapter} lifecycle={settings} open onClose={() => undefined} onCreated={() => undefined} />
            <RequestDialog ctx={ctx} adapter={adapter} lifecycle={{ ...settings, activeAdminCount: 1 }} open onClose={() => undefined} onCreated={() => undefined} />
            <RejectDialog ctx={ctx} adapter={adapter} target={rows[1]} onClose={() => undefined} onDecided={() => undefined} />
            <FilesTable ctx={ctx} detail={detail} onPart={() => undefined} onManifest={() => undefined} />
            <HowToCheck ctx={ctx} sample={detail.parts[0].name} />
          </>,
          ctx,
          theme,
        );
        const texts = [
          TEXT.statusRequested, TEXT.statusReady, TEXT.awaiting, TEXT.youRequested, TEXT.approve, TEXT.reject, TEXT.what1, TEXT.what3, TEXT.approvalOther, TEXT.approvalSingle,
          TEXT.told, TEXT.keep, TEXT.rejectHint, TEXT.manifestFile, TEXT.check1, TEXT.check2, TEXT.bannerText,
        ];
        for (const text of texts) expect(html, text[0]).toContain(esc(t(text, lang)));
        expect(html).toContain(esc(ctx.fill(TEXT.bannerTitle, { date: ctx.D!.fmt('2026-11-30', lang) })));
        expect(html).toContain(esc(ctx.fill(TEXT.bannerDeletion, { date: ctx.D!.fmt('2026-12-30', lang) })));
        expect(html).toContain(esc(ctx.fill(TEXT.approvedBy, { name: 'Rina Kusuma' })));
        // The SHA-256 of each part and of the manifest, and the commands with the first part's name.
        for (const sha of ['ab'.repeat(32), 'cd'.repeat(32), 'ef'.repeat(32)]) expect(html).toContain(`data-sha256="${sha}"`);
        expect(html).toContain('sha256sum mscd-export-tst-2026-10-31-part-1.tar.gz');
        expect(html).toContain('Get-FileHash mscd-export-tst-2026-10-31-part-1.tar.gz -Algorithm SHA256');
        // The own request offers no live Approve; the other request does.
        expect(html.match(/data-own-request=/g)).toHaveLength(1);
        // Approve and Reject of the own request both point at the one reason "You requested this export".
        const own = html.slice(html.indexOf('data-own-request='));
        const described = [...own.slice(0, own.indexOf('</span>')).matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
        expect(described).toHaveLength(2);
        expect(described[1]).toBe(described[0]);
        expect(own).toContain(`id="${described[0]}" class="mx-reason">${esc(t(TEXT.youRequested, lang))}</span>`);
        expect(html).not.toMatch(/[—·]/);
      });
    }
  }

  it('the banner shows the read-only period for a Tenant Admin, and nothing on the screen itself or after Later', () => {
    const ctx = ctxOf({ mode: 'api', org: TA, over: { screen: 'portfolio' } });
    expect(render(<ReadOnlyBanner ctx={ctx} />, ctx)).toBe('<div class="mscd" data-theme="light"></div>');
    noteLifecycle(ctx, fromSettings(SETTINGS));
    const html = render(<ReadOnlyBanner ctx={ctx} />, ctx);
    expect(html).toContain('data-read-only-banner="2026-11-30T03:00:00Z"');
    expect(html).toContain(esc(t(TEXT.bannerOpen)));
    const onScreen = ctxOf({ mode: 'api', org: TA, over: { screen: 'org-export' } });
    expect(render(<ReadOnlyBanner ctx={onScreen} />, onScreen)).not.toContain('data-read-only-banner');
    noteLifecycle(ctx, { ...fromSettings(SETTINGS), offboardingEndsAt: null });
    expect(render(<ReadOnlyBanner ctx={ctx} />, ctx)).not.toContain('data-read-only-banner');
  });
});

describe('Organisation export sample adapter', () => {
  const person = { current: { handle: 'rina', name: 'Rina Kusuma' } };
  const sample = (org = 'ndt') => createSampleAdapter(() => sampleD(), () => org, () => person.current);
  beforeEach(() => {
    person.current = { handle: 'rina', name: 'Rina Kusuma' };
  });

  it('holds the exports of the store, refuses a second request, approves Tono\'s and builds it', async () => {
    const adapter = sample();
    const list = await adapter.list();
    expect(list.ok && list.data.map((e) => [e.status, e.requestedBy?.handle ?? e.requestedVia])).toEqual([
      ['requested', 'tono'], ['ready', 'rina'], ['rejected', 'rina'], ['expired', 'operator'],
    ]);
    const lifecycle = await adapter.lifecycle();
    expect(lifecycle).toEqual({ ok: true, data: { activeAdminCount: 2, offboardingEndsAt: null, deletionScheduledFor: null } });
    const busy = await adapter.create(null, 'k');
    expect(!busy.ok && busy.error.messageKey).toBe('export_in_progress');
    const tono = list.ok ? list.data[0].id : '';
    // Tono cannot approve his own request.
    person.current = { handle: 'tono', name: 'Tono Hartono' };
    const own = await adapter.decide(tono, true, null);
    expect(!own.ok && own.error.rule).toBe('SOD-SELF-APPROVE');
    person.current = { handle: 'rina', name: 'Rina Kusuma' };
    expect((await adapter.decide(tono, false, null)).ok).toBe(false);
    expect(await adapter.decide(tono, true, null)).toEqual({ ok: true, data: { id: tono, status: 'queued', message: null } });
    const again = await adapter.decide(tono, true, null);
    expect(!again.ok && again.error.messageKey).toBe('export_not_requested');
    const statuses = [];
    for (let i = 0; i < 2; i++) {
      const read = await adapter.list();
      statuses.push(read.ok ? read.data[0].status : 'error');
    }
    expect(statuses).toEqual(['building', 'ready']);
    const detail = await adapter.get(tono);
    expect(detail.ok && detail.data).toMatchObject({ status: 'ready', partCount: 2, decidedBy: { handle: 'rina' } });
    // A new request of Rina waits for the other Tenant Admin.
    const mine = await adapter.create('For the annual archive', 'k2');
    expect(mine.ok && mine.data).toMatchObject({ status: 'requested', approvalNeeded: true });
  });

  it('downloads parts and the manifest whose SHA-256 is the one shown; an expired export has none', async () => {
    const adapter = sample();
    const list = await adapter.list();
    const ready = list.ok ? list.data.find((e) => e.status === 'ready')! : null;
    const detail = await adapter.get(ready!.id);
    if (!detail.ok) throw new Error('no detail');
    expect(detail.data.parts).toHaveLength(2);
    const contentOf = async (href: string) => (await fetch(href)).text();
    for (const part of detail.data.parts) {
      const file = await adapter.partFile(detail.data, part);
      if (!file.ok) throw new Error('no file');
      expect(file.data.fileName).toBe(part.name);
      const text = await contentOf(file.data.href);
      expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(part.sha256);
      expect(new TextEncoder().encode(text).length).toBe(part.sizeBytes);
      file.data.release?.();
    }
    const manifest = await adapter.manifestFile(detail.data);
    if (!manifest.ok) throw new Error('no manifest');
    const manifestText = await contentOf(manifest.data.href);
    expect(createHash('sha256').update(manifestText, 'utf8').digest('hex')).toBe(detail.data.manifestSha256);
    expect(JSON.parse(manifestText).parts.map((p: { sha256: string }) => p.sha256)).toEqual(detail.data.parts.map((p) => p.sha256));
    const after = await adapter.get(ready!.id);
    expect(after.ok && after.data.downloadCount).toBe(4);
    const expired = list.ok ? list.data.find((e) => e.status === 'expired')! : null;
    const expiredDetail = await adapter.get(expired!.id);
    const refused = expiredDetail.ok ? await adapter.partFile(expiredDetail.data, expiredDetail.data.parts[0]) : null;
    expect(refused && !refused.ok && refused.error.messageKey).toBe('export_not_ready');
  });

  it('shows the read-only period and the final export after the operator moves the organisation to offboarding', async () => {
    const ops = createOpsSample(() => sampleD());
    const adapter = sample();
    expect((await ops.changeStatus('ndt', { status: 'offboarding', reason: 'Contract ended', confirmSlug: 'ndt' })).ok).toBe(true);
    const lifecycle = await adapter.lifecycle();
    expect(lifecycle.ok && inReadOnlyPeriod(lifecycle.data)).toBe(true);
    if (!lifecycle.ok) throw new Error('no lifecycle');
    const end = Date.parse(lifecycle.data.offboardingEndsAt!);
    expect(Math.round((Date.parse(lifecycle.data.deletionScheduledFor!) - end) / 864e5)).toBe(30);
    const list = await adapter.list();
    expect(list.ok && list.data[0]).toMatchObject({ requestedVia: 'offboarding', isFinal: true });
    // An organisation the sample service does not hold has no export.
    expect(await sample('nobody').list()).toEqual({ ok: true, data: [] });
    expect((await sample('nobody').lifecycle()).ok).toBe(false);
  });
});
