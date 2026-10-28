// Organisation (MILESTONE-2 M2-16): routes against the shared table, the API adapter over a fake fetch (GET, then
// PATCH with If-Match and the CSRF token, then GET again; a 412 kept), the form checks, the IANA list, the installation
// id panel, the sample adapter and the screen parts in both languages and themes.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routeById } from '@mscd/shared';
import type { OrganizationSettings } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/organization/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/organization/routes';
import { createApiAdapter, fromWire } from '../../src/screens/organization/api';
import { adapterFor, settle } from '../../src/screens/organization/adapter';
import { changesSnapshot, formErrors, formOf, patchOf, timeZones } from '../../src/screens/organization/model';
import { SAMPLE_INSTALLATION_ID, createSampleAdapter, resetSampleOrganization } from '../../src/screens/organization/sample';
import { AboutCard, SettingsForm } from '../../src/screens/organization/Screen';
import { InstallationPanel, copyText } from '../../src/screens/organization/InstallationPanel';
import { TEXT } from '../../src/screens/organization/text';
import { HOST_SCREENS } from '../../src/screens/registry';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, t, textProblems } from './ctx-m2-16';

const WIRE: OrganizationSettings = {
  slug: 'ndt', name: 'PT Nusantara Digital Teknologi', timeZone: 'Asia/Jakarta', siteCount: 2, localLogin: 'allowed',
  installationId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', tenancyMode: 'single', activeAdminCount: 1, etag: 'W/"1790380800000"',
};
const SETTINGS = fromWire(WIRE);

beforeAll(async () => {
  await loadSampleD();
});
beforeEach(() => resetSampleOrganization());

describe('Organisation routes and definition', () => {
  it('match the shared route table, the permission and If-Match', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
      expect(route.permission, name).toBe('org.settings.manage');
    }
    expect(routeById(ROUTE_IDS.update).ifMatch).toBe(true);
  });

  it('sits in the Administration group before Licence, with org.settings.manage', () => {
    expect(screen).toMatchObject({ id: 'organization', path: '/admin/organization', group: 'admin', scope: 'org', perm: 'org.settings.manage' });
    expect(screen.order).toBeLessThan(HOST_SCREENS.find((d) => d.id === 'license')!.order);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    expect(textProblems(TEXT, ['slug'])).toEqual([]);
  });
});

describe('Organisation API adapter', () => {
  it('reads the settings, saves a change with If-Match and reads them again', async () => {
    const next = { ...WIRE, name: 'PT NDT', etag: 'W/"1790380900000"' };
    const f = fakeFetch({ 'GET /api/v1/admin/organization': [json(WIRE), json(next)], 'PATCH /api/v1/admin/organization': { status: 204 } });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789');
    const adapter = createApiAdapter(client);
    expect(await adapter.load()).toEqual({ ok: true, settings: SETTINGS });
    const saved = await adapter.save({ name: 'PT NDT' }, SETTINGS.etag);
    expect(saved).toEqual({ ok: true, settings: fromWire(next) });
    const patch = f.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ name: 'PT NDT' });
    expect(patch.headers['if-match']).toBe('W/"1790380800000"');
    expect(patch.headers['x-csrf-token']).toBe('csrf-token-0123456789');
  });

  it('keeps a 412 and the field errors of a refused save', async () => {
    const f = fakeFetch({
      'PATCH /api/v1/admin/organization': [
        problem(412, 'precondition-failed'),
        problem(400, 'validation', { errors: [{ path: 'body.timeZone', message: 'Unknown time zone' }] }),
      ],
    });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    const stale = await adapter.save({ siteCount: 3 }, SETTINGS.etag);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.status).toBe(412);
    const bad = await adapter.save({ timeZone: 'Mars/Base' }, SETTINGS.etag);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.errors).toEqual([{ path: 'body.timeZone', message: 'Unknown time zone' }]);
    expect(f.calls.filter((c) => c.method === 'GET')).toHaveLength(0);
  });
});

describe('Organisation form', () => {
  it('checks the name and the number of sites before anything is sent', () => {
    expect(formErrors(formOf(SETTINGS))).toEqual({});
    expect(formErrors({ name: ' ', timeZone: 'UTC', siteCount: '1' })).toEqual({ name: TEXT.nameRequired });
    expect(formErrors({ name: 'x'.repeat(201), timeZone: 'UTC', siteCount: '1' })).toEqual({ name: TEXT.nameTooLong });
    expect(formErrors({ name: 'A', timeZone: 'UTC', siteCount: '-1' })).toEqual({ siteCount: TEXT.sitesInvalid });
    expect(formErrors({ name: 'A', timeZone: 'UTC', siteCount: '10001' })).toEqual({ siteCount: TEXT.sitesInvalid });
    expect(formErrors({ name: 'A', timeZone: 'UTC', siteCount: '2.5' })).toEqual({ siteCount: TEXT.sitesInvalid });
  });

  it('sends only what changed', () => {
    expect(patchOf(formOf(SETTINGS), SETTINGS)).toEqual({});
    expect(patchOf({ name: ' PT NDT ', timeZone: 'Asia/Makassar', siteCount: '3' }, SETTINGS)).toEqual({ name: 'PT NDT', timeZone: 'Asia/Makassar', siteCount: 3 });
  });

  it('reads the snapshot again after a save that changed the name or the number of sites (the sidebar shows both)', () => {
    expect(changesSnapshot(SETTINGS, { ...SETTINGS, etag: 'W/"2"' })).toBe(false);
    expect(changesSnapshot(SETTINGS, { ...SETTINGS, timeZone: 'Asia/Makassar' })).toBe(false);
    expect(changesSnapshot(SETTINGS, { ...SETTINGS, name: 'PT NDT' })).toBe(true);
    expect(changesSnapshot(SETTINGS, { ...SETTINGS, siteCount: SETTINGS.siteCount + 2 })).toBe(true);
  });

  it('offers the IANA time zones with UTC and the current value, sorted', () => {
    const zones = timeZones('Etc/Unknown_Zone');
    expect(zones).toContain('Asia/Jakarta');
    expect(zones).toContain('UTC');
    expect(zones).toContain('Etc/Unknown_Zone');
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones);
    expect(new Set(zones).size).toBe(zones.length);
  });
});

describe('Organisation screen parts', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`shows the settings, the permanent slug and the installation id in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme });
        const adapter = createSampleAdapter(() => ctx.org);
        const html = render(
          <>
            <SettingsForm ctx={ctx} adapter={adapter} settings={SETTINGS} onSaved={() => undefined} onReload={() => undefined} />
            <InstallationPanel ctx={ctx} installationId={SETTINGS.installationId} tenancyMode="single" />
            <AboutCard ctx={ctx} settings={SETTINGS} />
          </>,
          ctx,
          theme,
        );
        expect(html).toContain(`value="${esc(SETTINGS.name)}"`);
        expect(html).toContain('<option value="Asia/Jakarta" selected="">Asia/Jakarta</option>');
        expect(html).toContain(`value="${esc(ctx.fill(TEXT.slugValue, { slug: 'ndt' }))}"`);
        expect(html).toContain(SETTINGS.installationId);
        expect(html).toContain(esc(t(TEXT.copy, lang)));
        expect(html).toContain(esc(t(TEXT.installationSub, lang)));
        expect(html).toContain(esc(t(TEXT.oneAdmin, lang)));
        expect(html).toContain(esc(t(TEXT.localAllowed, lang)));
        expect(html).not.toMatch(/[—·]/);
      });
    }
  }

  it('with multi tenancy the panel sends the reader to the service provider', () => {
    const ctx = ctxOf();
    expect(render(<InstallationPanel ctx={ctx} installationId="x" tenancyMode="multi" />, ctx)).toContain(esc(t(TEXT.installationMulti)));
  });

  it('copyText answers false without a clipboard', async () => {
    expect(await copyText('abc')).toBe(false);
  });
});

describe('Organisation sample adapter', () => {
  it('keeps a saved change and refuses a stale ETag with 412', async () => {
    const ctx = ctxOf();
    const adapter = createSampleAdapter(() => ctx.org);
    const loaded = await adapter.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.settings).toMatchObject({ slug: 'ndt', name: 'PT Nusantara Digital Teknologi', installationId: SAMPLE_INSTALLATION_ID });
    const saved = await adapter.save({ siteCount: 7 }, loaded.settings.etag);
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.settings.siteCount).toBe(7);
    const stale = await adapter.save({ siteCount: 8 }, loaded.settings.etag);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.status).toBe(412);
    const again = await settle(adapterFor(null, () => ctx.org).load());
    expect(again.ok && again.settings.siteCount).toBe(7);
  });
});
