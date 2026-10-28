// Operator console (MILESTONE-2 M2-16): routes against the shared table and the job allow-list, the API adapter over a
// fake fetch (health, queues, Run job, diagnostics archive, organisations with the single tenancy answer, Create with
// its idempotency key and one-time link, Install licence with {org, licence}, packs and the multipart import, factor
// reset), the following of a pack installation, the multi tenancy rule, the page action, the console parts in both
// languages and themes, and the sample adapter.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_RUNNABLE_JOBS, routeById } from '@mscd/shared';
import type { OpsHealth, OpsOrganizationItem, PackSummary } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/ops/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/ops/routes';
import { createApiAdapter, fileNameOf, fromHealth, fromOrg, fromPack } from '../../src/screens/ops/api';
import { adapterFor } from '../../src/screens/ops/adapter';
import { EMPTY_CREATE, OPS_JOBS, ageText, createBody, createErrors, isSingleTenancy, multiTenancy, packRow, packRows, validJobOrg } from '../../src/screens/ops/model';
import type { OpsAdapter, PackItem, Result } from '../../src/screens/ops/model';
import { createSampleAdapter, resetSampleOps } from '../../src/screens/ops/sample';
import { HealthView, QueuesTable, RunJobCard } from '../../src/screens/ops/Health';
import { CreateDialog, LicenceDialog, OrganizationsTab } from '../../src/screens/ops/Organizations';
import { PacksTable, followInstall, listBefore, progressText } from '../../src/screens/ops/Packs';
import { ResetMfaCard } from '../../src/screens/ops/Accounts';
import { tabsOf } from '../../src/screens/ops/Screen';
import { TEXT } from '../../src/screens/ops/text';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, sampleD, t, textProblems } from './ctx-m2-16';

const HEALTH: OpsHealth = {
  components: [{ name: 'database', status: 'ok', detail: 'SELECT 1 in 2 ms' }, { name: 'telemetry', status: 'degraded', detail: 'off' }],
  migrations: [{ schema: 'platform', latest: '0006_daily_job_run', expected: '0006_daily_job_run' }, { schema: 'tenant', latest: '0007', expected: '0008_milestone2' }],
  queues: [],
  licences: [{ org: 'ndt', state: 'valid', validUntil: '2027-03-31' }, { org: 'bsd', state: 'grace', validUntil: '9999-12-31' }],
};
const ORG: OpsOrganizationItem = {
  id: '00000000-0000-4000-8000-00000000a001', slug: 'ndt', name: 'PT Nusantara Digital Teknologi', status: 'active',
  licence: { state: 'valid', validUntil: '2027-03-31' }, memberCount: 86, systemCount: 4, plan: 'standard', validUntil: '2027-03-31',
  verifiedDomains: [], createdAt: '2026-02-01T03:00:00Z',
};
const PACK: PackSummary = { packId: 'ISO27001-2022', version: '1.3.0', frameworkCode: 'ISO27001', edition: '2022', status: 'installed', preRelease: false, installedAt: '2026-10-01T03:00:00Z', checksum: 'ab'.repeat(32), signatureKeyId: 'k' };
/** An operator session of a multi tenancy service. */
const MULTI = ['ops.read', 'ops.jobs.run', 'ops.users.manage', 'ops.tenants.manage', 'license.manage', 'pack.install'];
/** An operator session of an installation with one organisation. */
const SINGLE = ['ops.read', 'ops.jobs.run', 'ops.users.manage', 'ops.tenants.manage'];

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

describe('Operator console routes and definition', () => {
  it('match the shared route table', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.orgCreate).permission).toBe('ops.tenants.manage');
    expect(routeById(ROUTE_IDS.resetMfa).permission).toBe('ops.users.manage');
  });

  it('offers exactly the jobs of the allow-list', () => {
    expect([...OPS_JOBS]).toEqual([...OPS_RUNNABLE_JOBS]);
  });

  it('is the platform screen of the Operations group; Create organisation only on a multi tenancy service', () => {
    expect(screen).toMatchObject({ id: 'ops', path: '/ops', group: 'ops', scope: 'platform', perm: 'ops.read' });
    const labels = (org: string[]) => (screen.pageActions?.(ctxOf({ mode: 'api', org })) ?? []).map((a) => a.label[0]);
    expect(labels(MULTI)).toEqual(['Create organisation']);
    expect(labels(SINGLE)).toEqual([]);
    expect(labels(['ops.read', 'license.manage'])).toEqual([]);
    const ctx = ctxOf();
    screen.pageActions!(ctx)[0].run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('ops', { params: { create: expect.any(Number) } });
  });

  it('multi tenancy follows the platform rights of licences and packs (F.6 D-17, D-32)', () => {
    expect(multiTenancy(ctxOf({ mode: 'api', org: MULTI }))).toBe(true);
    expect(multiTenancy(ctxOf({ mode: 'api', org: SINGLE }))).toBe(false);
    expect(tabsOf(true).map((x) => x.id)).toEqual(['health', 'jobs', 'orgs', 'packs', 'accounts']);
    expect(tabsOf(false).map((x) => x.id)).toEqual(['health', 'jobs', 'orgs', 'packs']);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    expect(textProblems(TEXT, ['colStatus', 'slug'])).toEqual([]);
  });
});

describe('Operator console API adapter', () => {
  it('reads the health and the queues, and runs a job of the allow-list', async () => {
    const f = client({
      'GET /api/v1/ops/health': json(HEALTH),
      'GET /api/v1/ops/queues': json([{ name: 'freshness.recompute', waiting: 2, active: 1, failed: 0, oldestAgeSeconds: 4.2 }]),
      'POST /api/v1/ops/jobs/drift.evaluate/run': [json({ jobId: 'ob-42' }, 202), problem(404, 'not-found')],
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.health()).toEqual({ ok: true, data: fromHealth(HEALTH) });
    expect((await adapter.queues()).ok).toBe(true);
    expect(await adapter.runJob('drift.evaluate', 'ndt')).toEqual({ ok: true, data: 'ob-42' });
    expect((await adapter.runJob('drift.evaluate', null)).ok).toBe(false);
    expect(f.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ org: 'ndt' }, {}]);
  });

  it('downloads the diagnostics archive with the CSRF token and its file name', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([0x1f, 0x8b, 8, 0]), { status: 200, headers: { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="mscd-diagnostics-20261028.tar.gz"' } });
    }) as unknown as typeof fetch;
    const c = new ApiClient({ fetch: fetchImpl });
    c.setCsrfToken('csrf-token-0123456789');
    const res = await createApiAdapter(c, fetchImpl).diagnostics();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.fileName).toBe('mscd-diagnostics-20261028.tar.gz');
      expect(new Uint8Array(await res.data.blob.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
    }
    expect(calls[0].url).toBe('/api/v1/ops/diagnostics');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-token-0123456789');
    const refused = await createApiAdapter(c, (async () => new Response(JSON.stringify({ type: 'https://mscd.cyberlentera.com/problems/forbidden', title: 'Forbidden', status: 403 }), { status: 403, headers: { 'content-type': 'application/problem+json' } })) as unknown as typeof fetch).diagnostics();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.status).toBe(403);
    expect(fileNameOf("attachment; filename*=UTF-8''diag%20x.tar.gz")).toBe('diag x.tar.gz');
    expect(fileNameOf(null)).toBeUndefined();
  });

  it('a 401 of the diagnostics archive ends the session through the client, as every other request does', async () => {
    const unauth = { type: 'https://mscd.cyberlentera.com/problems/unauthenticated', title: 'Sign in again', status: 401 };
    const answer = () => new Response(JSON.stringify(unauth), { status: 401, headers: { 'content-type': 'application/problem+json' } });
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return answer();
    }) as unknown as typeof fetch;
    const c = new ApiClient({ fetch: fetchImpl });
    const ended = vi.fn();
    c.onUnauthenticated(ended);
    const res = await createApiAdapter(c, fetchImpl).diagnostics();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.status).toBe(401);
    expect(urls).toEqual(['/api/v1/ops/diagnostics', '/api/v1/ops/health']);
    expect(ended).toHaveBeenCalledTimes(1);
    // A refusal other than 401 sends nothing more and leaves the session alone.
    const sent: string[] = [];
    const forbidden = (async (url: string) => {
      sent.push(String(url));
      return new Response(JSON.stringify({ ...unauth, status: 403 }), { status: 403, headers: { 'content-type': 'application/problem+json' } });
    }) as unknown as typeof fetch;
    const other = new ApiClient({ fetch: forbidden });
    const stays = vi.fn();
    other.onUnauthenticated(stays);
    expect((await createApiAdapter(other, forbidden).diagnostics()).ok).toBe(false);
    expect(sent).toEqual(['/api/v1/ops/diagnostics']);
    expect(stays).not.toHaveBeenCalled();
  });

  it('lists organisations; single tenancy answers 409 single_tenancy', async () => {
    const f = client({ 'GET /api/v1/ops/organizations': [json({ items: [ORG], page: 1, pageSize: 25, total: 1 }), problem(409, 'conflict', { messageKey: 'single_tenancy' })] });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.organizations({ page: 1, pageSize: 25, q: 'nusa' })).toEqual({ ok: true, data: { items: [fromOrg(ORG)], page: 1, pageSize: 25, total: 1 } });
    expect(f.calls[0].url).toBe('/api/v1/ops/organizations?page=1&pageSize=25&q=nusa');
    const single = await adapter.organizations({ page: 1, pageSize: 25 });
    expect(single.ok).toBe(false);
    if (!single.ok) expect(isSingleTenancy(single.error)).toBe(true);
  });

  it('creates an organisation with an idempotency key; the one-time link only when the answer carries one', async () => {
    const created = { ok: true, changed: [], message: ['Organisation created. The slug bank_sentosa cannot be changed.', 'Organisasi dibuat. Slug bank_sentosa tidak dapat diubah.'], data: { id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', slug: 'bank_sentosa', invitationSent: true } };
    const withLink = { ...created, data: { ...created.data, invitationSent: false, invitationUrl: 'http://localhost/invite#token=abc' } };
    const f = client({ 'POST /api/v1/ops/organizations': [json(created, 201), json(withLink, 201)] });
    const adapter = createApiAdapter(f.client);
    const body = createBody({ ...EMPTY_CREATE, slug: 'bank_sentosa', name: 'PT Bank Sentosa', email: 'it.admin@banksentosa.co.id', displayName: 'Andi Wijaya' });
    expect(await adapter.createOrganization(body, 'key-1')).toEqual({ ok: true, data: { slug: 'bank_sentosa', invitationSent: true, invitationUrl: null, message: created.message } });
    expect(await adapter.createOrganization(body, 'key-2')).toEqual({ ok: true, data: { slug: 'bank_sentosa', invitationSent: false, invitationUrl: 'http://localhost/invite#token=abc', message: created.message } });
    expect(f.calls[0].body).toEqual({ slug: 'bank_sentosa', name: 'PT Bank Sentosa', timeZone: 'Asia/Jakarta', siteCount: 1, firstAdmin: { email: 'it.admin@banksentosa.co.id', displayName: 'Andi Wijaya' } });
    expect(f.calls.map((c) => c.headers['idempotency-key'])).toEqual(['key-1', 'key-2']);
  });

  it('installs a licence for an organisation as {org, licence}', async () => {
    const f = client({ 'PUT /api/v1/admin/license': json({}) });
    expect(await createApiAdapter(f.client).installLicence('ndt', { license_id: 'LIC-1' })).toEqual({ ok: true, data: null });
    expect(f.calls[0].body).toEqual({ org: 'ndt', licence: { license_id: 'LIC-1' } });
  });

  it('lists packs and imports a bundle as multipart field bundle with an idempotency key', async () => {
    const f = client({
      'GET /api/v1/admin/packs': json([PACK]),
      'POST /api/v1/admin/packs/import': [
        json({ ok: true, changed: [], taskId: 'b1', message: ['ISO27001-2022 1.4.0 was verified and is being installed', 'ISO27001-2022 1.4.0 telah diverifikasi dan sedang dipasang'], data: { installId: 'b1', packId: 'ISO27001-2022', version: '1.4.0', status: 'queued' } }, 202),
        problem(422, 'business-rule', { messageKey: 'pack.engine_version', messages: { en: 'This pack needs a newer server version.', id: 'Paket ini membutuhkan versi server yang lebih baru.' } }),
      ],
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.packs()).toEqual({ ok: true, data: [fromPack(PACK)] });
    const file = new Blob([new Uint8Array([1, 2, 3])]);
    expect(await adapter.importPack(file, 'ISO27001-2022-1.4.0.bundle', 'key-9')).toMatchObject({ ok: true, data: { packId: 'ISO27001-2022', version: '1.4.0', status: 'queued' } });
    const post = f.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toBeInstanceOf(FormData);
    expect(((post.body as FormData).get('bundle') as File).name).toBe('ISO27001-2022-1.4.0.bundle');
    expect(post.headers['idempotency-key']).toBe('key-9');
    const refused = await adapter.importPack(file, 'x.bundle', 'key-10');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message[0]).toBe('This pack needs a newer server version.');
  });

  it('resets the factor of an account with the reason', async () => {
    const f = client({ 'POST /api/v1/ops/users/reset-mfa': [{ status: 204 }, problem(404, 'not-found')] });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.resetMfa('rina@x.id', 'Lost phone, identity checked by video call')).toEqual({ ok: true, data: null });
    expect((await adapter.resetMfa('nobody@x.id', 'Lost phone, identity checked')).ok).toBe(false);
    expect(f.calls[0].body).toEqual({ email: 'rina@x.id', reason: 'Lost phone, identity checked by video call' });
  });
});

describe('Operator console model', () => {
  it('checks the create form before sending, with the paths of the server', () => {
    expect(createErrors(EMPTY_CREATE)).toEqual({ slug: TEXT.slugInvalid, name: TEXT.nameRequired, 'firstAdmin.email': TEXT.emailInvalid, 'firstAdmin.displayName': TEXT.nameRequired });
    expect(createErrors({ ...EMPTY_CREATE, slug: 'Bank-1' }).slug).toBe(TEXT.slugInvalid);
    expect(createErrors({ slug: 'bank_sentosa', name: 'A', timeZone: 'UTC', siteCount: '3', email: 'a@b.co', displayName: 'A' })).toEqual({});
    expect(validJobOrg('')).toBe(true);
    expect(validJobOrg('NDT')).toBe(false);
  });

  it('ages of the oldest job, and the newest row of a pack version', () => {
    expect(ageText(4.2)).toEqual({ text: TEXT.seconds, n: 4 });
    expect(ageText(900)).toEqual({ text: TEXT.minutes, n: 15 });
    expect(ageText(10_800)).toEqual({ text: TEXT.hours, n: 3 });
    const list = [fromPack({ ...PACK, status: 'failed' }), fromPack(PACK)];
    expect(packRow(list, 'ISO27001-2022', '1.3.0')!.status).toBe('failed');
    expect(packRow(list, 'ISO27001-2022', '9.9.9')).toBeNull();
  });

  it('follows an installation until installed or failed, or says it still runs', async () => {
    const reads = (statuses: PackItem['status'][]): OpsAdapter => {
      const queue = [...statuses];
      return { packs: async (): Promise<Result<PackItem[]>> => ({ ok: true, data: [{ ...fromPack(PACK), status: queue.shift() ?? 'validating' }] }) } as unknown as OpsAdapter;
    };
    const sleep = async () => undefined;
    const seen: number[] = [];
    expect(await followInstall(reads(['validating', 'installed']), { packId: 'ISO27001-2022', version: '1.3.0' }, { sleep, onRead: (l) => seen.push(l.length) })).toBe('done');
    expect(seen).toEqual([1, 1]);
    expect(await followInstall(reads(['failed']), { packId: 'ISO27001-2022', version: '1.3.0' }, { sleep })).toBe('failed');
    expect(await followInstall(reads([]), { packId: 'ISO27001-2022', version: '1.3.0' }, { sleep, polls: 3 })).toBe('slow');
    expect(progressText({ state: 'queued', packId: 'P', version: '1', message: null }).tone).toBe('info');
    expect(progressText({ state: 'failed', packId: 'P', version: '1', message: null }).text).toBe(TEXT.progressFailed);
  });

  it('an earlier failed installation of the same version is not the result of a new import', async () => {
    // As the server answers: no row while the installation runs, then one row when it ends, newest first.
    const old = fromPack({ ...PACK, status: 'failed', installedAt: null });
    const lists = (seq: PackItem[][]): OpsAdapter => {
      const queue = [...seq];
      return { packs: async (): Promise<Result<PackItem[]>> => ({ ok: true, data: queue.shift() ?? seq[seq.length - 1] }) } as unknown as OpsAdapter;
    };
    const sleep = async () => undefined;
    const pack = { packId: 'ISO27001-2022', version: '1.3.0' };
    const installed = fromPack(PACK);
    const failedAgain = fromPack({ ...PACK, status: 'failed', installedAt: null });
    let reads = 0;
    expect(await followInstall(lists([[old], [old], [installed, old]]), pack, { sleep, before: 1, onRead: () => { reads += 1; } })).toBe('done');
    expect(reads).toBe(3);
    expect(await followInstall(lists([[old], [failedAgain, old]]), pack, { sleep, before: 1 })).toBe('failed');
    expect(await followInstall(lists([[old]]), pack, { sleep, before: 1, polls: 4 })).toBe('slow');
    // Without the rows before the import, the old row would answer at the first read.
    expect(await followInstall(lists([[old], [installed, old]]), pack, { sleep })).toBe('failed');
    expect(packRows([installed, old, fromPack({ ...PACK, version: '1.4.0' })], 'ISO27001-2022', '1.3.0')).toEqual([installed, old]);
  });

  it('reads the installed list before the import, or keeps the shown list when that read fails', async () => {
    const shown = [fromPack(PACK)];
    const fresh = [fromPack({ ...PACK, status: 'failed', installedAt: null }), fromPack(PACK)];
    const ok = { packs: async () => ({ ok: true, data: fresh }) } as unknown as OpsAdapter;
    const refused = { packs: async () => ({ ok: false, error: { status: 503, message: ['Down', 'Mati'] } }) } as unknown as OpsAdapter;
    const broken = { packs: () => Promise.reject(new Error('chunk')) } as unknown as OpsAdapter;
    expect(await listBefore(ok, shown)).toBe(fresh);
    expect(await listBefore(refused, shown)).toBe(shown);
    expect(await listBefore(broken, null)).toBeNull();
  });
});

describe('Operator console parts', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`render in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme, mode: 'api', org: MULTI });
        const adapter = createSampleAdapter(() => sampleD());
        const html = render(
          <>
            <HealthView ctx={ctx} health={fromHealth(HEALTH)} />
            <QueuesTable ctx={ctx} queues={[{ name: 'freshness.recompute', waiting: 2, active: 1, failed: 1, oldestAgeSeconds: 4.2 }]} />
            <RunJobCard ctx={ctx} adapter={adapter} onRun={() => undefined} />
            <PacksTable ctx={ctx} packs={[fromPack(PACK), fromPack({ ...PACK, version: '1.4.0', status: 'validating', preRelease: true, installedAt: null })]} />
            <ResetMfaCard ctx={ctx} adapter={adapter} />
            <CreateDialog ctx={ctx} adapter={adapter} open onClose={() => undefined} onCreated={() => undefined} />
          </>,
          ctx,
          theme,
        );
        for (const text of [TEXT.statusOk, TEXT.statusDegraded, TEXT.upToDate, TEXT.behind, TEXT.stateGrace, TEXT.noEndDate, TEXT.packValidating, TEXT.preRelease, TEXT.slugWarning, TEXT.resetMfaSub, TEXT.run]) {
          expect(html, text[0]).toContain(esc(t(text, lang)));
        }
        expect(html).toContain('<option value="cycle.derive">cycle.derive</option>');
        expect(html).toContain(esc(ctx.fill(TEXT.seconds, { n: 4 })));
        expect(html).not.toMatch(/[—·]/);
      });
    }
  }

  it('Create organisation shows only with multi tenancy, also while the list still loads', () => {
    const adapter = createSampleAdapter(() => sampleD());
    const tab = (perms: string[]) => {
      const ctx = ctxOf({ mode: 'api', org: perms });
      return render(<OrganizationsTab ctx={ctx} adapter={adapter} creating={false} setCreating={() => undefined} />, ctx);
    };
    // The first render has no list yet (the read runs in an effect), so `single_tenancy` is not known.
    expect(tab(MULTI)).toContain(esc(t(TEXT.createOrg)));
    expect(tab(SINGLE)).not.toContain(esc(t(TEXT.createOrg)));
  });

  it('the licence dialog names the organisation', () => {
    const ctx = ctxOf({ mode: 'api', org: MULTI });
    const html = render(<LicenceDialog ctx={ctx} adapter={createSampleAdapter(() => sampleD())} org={fromOrg(ORG)} onClose={() => undefined} onInstalled={() => undefined} />, ctx);
    expect(html).toContain(esc(ctx.fill(TEXT.installTitle, { org: ORG.name })));
  });
});

describe('Operator console sample adapter', () => {
  it('creates an organisation once, installs its licence, imports a pack and resets a factor', async () => {
    const adapter = createSampleAdapter(() => sampleD());
    const before = await adapter.organizations({ page: 1, pageSize: 25 });
    expect(before.ok && before.data.items.map((o) => o.slug)).toEqual(sampleD().orgs.map((o) => o.id));
    const body = createBody({ ...EMPTY_CREATE, slug: 'klinik_sehat', name: 'Klinik Sehat', email: 'admin@kliniksehat.id', displayName: 'Sari Dewi' });
    expect((await adapter.createOrganization(body, 'k')).ok).toBe(true);
    const again = await adapter.createOrganization(body, 'k2');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.messageKey).toBe('org_exists');
    expect((await adapter.installLicence('klinik_sehat', { license_id: 'LIC-KS', signature: 'ed25519:x', valid_until: '2027-10-31' })).ok).toBe(true);
    const found = await adapter.organizations({ page: 1, pageSize: 25, q: 'klinik' });
    expect(found.ok && found.data.items[0].licence).toEqual({ state: 'valid', validUntil: '2027-10-31' });
    expect((await adapter.installLicence('klinik_sehat', { hello: 'x' })).ok).toBe(false);
    expect((await adapter.importPack(new Blob([]), 'notes.txt', 'k')).ok).toBe(false);
    const imported = await adapter.importPack(new Blob([]), 'ISO27001-2022-1.3.0.bundle', 'k');
    expect(imported.ok && imported.data.status).toBe('queued');
    const state = await followInstall(adapter, { packId: 'ISO27001-2022', version: '1.3.0' }, { sleep: async () => undefined });
    expect(state).toBe('done');
    const unchanged = await adapter.importPack(new Blob([]), 'ISO27001-2022-1.3.0.bundle', 'k');
    expect(unchanged.ok && unchanged.data.status).toBe('unchanged');
    expect((await adapter.resetMfa('rina.kusuma@nusantaradigital.co.id', 'Lost phone, identity checked')).ok).toBe(true);
    expect((await adapter.resetMfa('nobody@example.id', 'Lost phone, identity checked')).ok).toBe(false);
    expect((await adapter.diagnostics()).ok).toBe(false);
  });

  it('the build chooses the sample adapter outside the api build', async () => {
    expect((await adapterFor(null, () => sampleD()).health()).ok).toBe(true);
  });
});
