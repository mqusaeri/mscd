// Operator console, organisation lifecycle (MILESTONE-2 M2-S12): the status machine and enum values against
// @mscd/shared, the route permissions, the pure rules (status form and body, effects, days left, the entitlement ETag,
// form and body, domain checks and refusal texts), the API adapter over a fake fetch (detail, status with confirmSlug
// and the 409 and 422 messages, paged history, domains with add, verify, 503 and remove, entitlements with If-Match,
// `*` for no row, 412 and the warnings, plan presets; every request body checked with the shared schema), the parts of
// the drawer in both languages and themes with the operator's rights, and the sample adapter with every tab's data.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DOMAIN_STATUSES as SHARED_DOMAIN_STATUSES, EntitlementSet, Entitlement as EntitlementSchema, LICENCE_FEATURES, MACHINES, ORGANIZATION_STATUSES,
  OpsOrganizationDetail, OrgDomain, OrgDomainAdd, OrgDomainAdded, OrgDomainCheck, OrganizationStatusChange, OrganizationStatusChangeResult,
  OrganizationStatusEventItem, PlanPreset as PlanPresetSchema, STORAGE_ADAPTERS, routeById,
} from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import { createApiAdapter, fromDetail, fromDomain, fromEntitlement, fromEvent, fromPreset } from '../../src/screens/ops/api';
import { createSampleAdapter, normaliseDomain, resetSampleOps } from '../../src/screens/ops/sample';
import {
  DOMAIN_STATUSES, EMPTY_STATUS_FORM, FEATURE_NAMES, ORG_STATUSES, STATUS_MOVES, STORAGE_ADAPTER_NAMES, addDays, checkOutcome, daysBetween, daysLeftOf,
  domainInputError, entitlementBody, entitlementErrors, entitlementEtag, entitlementForm, isOpenEnded, mapLimited, moveEffects, needsSlug,
  offboardingStart, planPicked, presetUntil, refusalText, statusBody, statusErrors, todayOf, toggled,
} from '../../src/screens/ops/org-model';
import type { DomainCheck, Entitlement, PlanPreset } from '../../src/screens/ops/org-model';
import { ROUTES, ROUTE_IDS } from '../../src/screens/ops/routes';
import { ORG_TEXT } from '../../src/screens/ops/org-text';
import { HistoryTable, ORG_TABS, OverviewView } from '../../src/screens/ops/OrgDrawer';
import { MovedAlert, OffboardingNote, StatusDialog, StatusTab } from '../../src/screens/ops/StatusTab';
import { AddDomainDialog, DomainsTab, DomainList } from '../../src/screens/ops/DomainsTab';
import { EntitlementFields, EntitlementSummary } from '../../src/screens/ops/EntitlementsTab';
import { CreateDialog, OrganizationsTab } from '../../src/screens/ops/Organizations';
import { TEXT } from '../../src/screens/ops/text';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, sampleD, t, textProblems } from './ctx-m2-16';

/** An operator of a multi tenancy service with every operator right. */
const MULTI = ['ops.read', 'ops.jobs.run', 'ops.users.manage', 'ops.tenants.manage', 'ops.entitlements.manage', 'license.manage', 'pack.install'];
/** An operator who may only read. */
const READER = ['ops.read', 'license.manage'];

const DETAIL = OpsOrganizationDetail.parse({
  id: '00000000-0000-4000-8000-00000000a001', slug: 'ndt', name: 'PT Nusantara Digital Teknologi', status: 'offboarding', region: 'id',
  createdAt: '2026-01-15T03:00:00Z', memberCount: 86, systemCount: 4,
  entitlement: { plan: 'enterprise', source: 'manual', maxUsers: 100, maxManagementSystems: 5, validUntil: '2027-03-31' },
  domains: [{ domain: 'nusantaradigital.co.id', status: 'verified' }, { domain: 'ndt.co.id', status: 'pending' }], lastSignInAt: '2026-09-29T01:12:00Z',
});
const EVENT = OrganizationStatusEventItem.parse({
  id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a', from: 'active', to: 'offboarding', reason: 'Contract ends on 30 September 2026',
  actor: { handle: 'ops.owner', displayName: 'Platform owner' }, at: '2026-09-19T03:00:00Z',
});
const DOMAIN = OrgDomain.parse({
  domain: 'ndt.co.id', status: 'pending', method: 'dns', requestedAt: '2026-09-27T02:00:00Z', verifiedAt: null, lastCheckedAt: null,
  pendingUntil: '2026-10-04T02:00:00Z', txtName: '_mscd-verify.ndt.co.id',
});
const ENTITLEMENT = EntitlementSchema.parse({
  organization: 'ndt', plan: 'standard', source: 'preset', maxUsers: 50, maxManagementSystems: 3, frameworks: [], storageAdapters: ['managed_vault', 'm365', 'google_drive'],
  features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'], rateUserPerMinute: null, rateOrgPerMinute: null, graceDays: 30,
  validFrom: '2026-10-01', validUntil: '2027-09-30', version: 3, updatedAt: '2026-10-01T03:00:00.123Z', usage: { users: 41, managementSystems: 2 },
});
const PRESETS: PlanPreset[] = [
  PlanPresetSchema.parse({ name: 'trial', maxUsers: 10, maxManagementSystems: 1, frameworks: [], storageAdapters: ['managed_vault'], features: [], rateUserPerMinute: null, rateOrgPerMinute: null, graceDays: 7, validDays: 30 }),
  PlanPresetSchema.parse({ name: 'standard', maxUsers: 50, maxManagementSystems: 3, frameworks: [], storageAdapters: ['managed_vault'], features: [], rateUserPerMinute: null, rateOrgPerMinute: null, graceDays: 30, validDays: 365 }),
].map(fromPreset);

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

describe('Organisation lifecycle contract', () => {
  it('the routes match the shared table and its permissions', () => {
    for (const name of ['orgGet', 'orgStatus', 'orgEvents', 'domainsList', 'domainsAdd', 'domainsVerify', 'domainsRemove', 'entitlementGet', 'entitlementSet', 'plans'] as const) {
      const route = routeById(ROUTE_IDS[name]);
      expect([route.method, route.path], name).toEqual([...ROUTES[name]]);
    }
    expect(['orgStatus', 'domainsAdd', 'domainsVerify', 'domainsRemove'].map((n) => routeById(ROUTE_IDS[n as keyof typeof ROUTES]).permission)).toEqual(Array(4).fill('ops.tenants.manage'));
    expect(routeById(ROUTE_IDS.entitlementSet).permission).toBe('ops.entitlements.manage');
    expect(routeById(ROUTE_IDS.entitlementSet).ifMatch).toBe(true);
    expect(['orgGet', 'orgEvents', 'domainsList', 'entitlementGet', 'plans'].map((n) => routeById(ROUTE_IDS[n as keyof typeof ROUTES]).permission)).toEqual(Array(5).fill('ops.read'));
  });

  it('the status machine is the one of J.8 in @mscd/shared, with the slug for offboarding and archived', () => {
    expect([...ORG_STATUSES]).toEqual([...ORGANIZATION_STATUSES]);
    const rows = MACHINES['organization.status'].transitions.filter((r) => r.via === 'ops.organizations.status');
    const moves = Object.fromEntries(ORG_STATUSES.map((s) => [s, rows.filter((r) => r.from === s).map((r) => r.to).sort()]));
    expect(moves).toEqual(Object.fromEntries(ORG_STATUSES.map((s) => [s, [...STATUS_MOVES[s]].sort()])));
    for (const r of rows) expect(needsSlug(r.to as (typeof ORG_STATUSES)[number]), `${r.from} to ${r.to}`).toBe(Boolean(r.requires?.includes('confirmSlug')));
    for (const r of rows) expect(r.permission).toBe('ops.tenants.manage');
  });

  it('domain statuses, storage adapters and features are the shared enum values', () => {
    expect([...DOMAIN_STATUSES]).toEqual([...SHARED_DOMAIN_STATUSES]);
    expect([...STORAGE_ADAPTER_NAMES]).toEqual([...STORAGE_ADAPTERS]);
    expect([...FEATURE_NAMES]).toEqual([...LICENCE_FEATURES]);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    const same = [
      'statusFilter', 'colStatus', 'tabStatus', 'factSlug', 'factStatus', 'moveTitle', 'colDomain', 'domain', 'adapterManagedVault', 'adapterM365',
      'adapterGoogleDrive', 'adapterWebdav',
    ];
    expect(textProblems(ORG_TEXT, same)).toEqual([]);
    // No "gate" in new text (CLAUDE.md decision 10, M2-17 renames).
    expect(Object.values(ORG_TEXT).flat().filter((x) => /\bgate\b/i.test(x))).toEqual([]);
  });
});

describe('Organisation lifecycle rules', () => {
  it('a move needs a reason of 3 characters, and the slug typed again for offboarding and archived', () => {
    expect(statusErrors('ndt', 'suspended', EMPTY_STATUS_FORM)).toEqual({ reason: ORG_TEXT.reasonShort });
    expect(statusErrors('ndt', 'suspended', { reason: 'Invoice overdue', confirm: '' })).toEqual({});
    expect(statusErrors('ndt', 'offboarding', { reason: 'Contract ended', confirm: '' })).toEqual({ confirmSlug: ORG_TEXT.slugMissing });
    expect(statusErrors('ndt', 'archived', { reason: 'Contract ended', confirm: 'NDT' })).toEqual({ confirmSlug: ORG_TEXT.slugMismatch });
    expect(statusErrors('ndt', 'archived', { reason: 'Contract ended', confirm: ' ndt ' })).toEqual({});
    expect(statusBody('suspended', { reason: '  Invoice overdue ', confirm: 'ndt' })).toEqual({ status: 'suspended', reason: 'Invoice overdue' });
    const body = statusBody('offboarding', { reason: 'Contract ended', confirm: ' ndt ' });
    expect(body).toEqual({ status: 'offboarding', reason: 'Contract ended', confirmSlug: 'ndt' });
    expect(OrganizationStatusChange.parse(body)).toEqual(body);
  });

  it('lists the effects of each move with the email to the Tenant Admins, and the plan after a renewal', () => {
    expect(moveEffects('active', 'suspended')).toContain(ORG_TEXT.effectSuspended2);
    expect(moveEffects('active', 'offboarding')).toContain(ORG_TEXT.effectOffboarding4);
    expect(moveEffects('offboarding', 'archived')).toContain(ORG_TEXT.effectArchived3);
    expect(moveEffects('offboarding', 'active')).toContain(ORG_TEXT.effectRenewPlan);
    expect(moveEffects('suspended', 'active')).not.toContain(ORG_TEXT.effectRenewPlan);
    for (const to of ['active', 'suspended', 'offboarding', 'archived'] as const) expect(moveEffects('active', to).at(-1)).toBe(ORG_TEXT.effectEmail);
    expect(offboardingStart('offboarding', [fromEvent(EVENT)])).toBe('2026-09-19T03:00:00Z');
    expect(offboardingStart('active', [fromEvent(EVENT)])).toBeNull();
  });

  it('days left of a plan, with the end and the past', () => {
    expect(daysBetween('2026-09-29', '2026-10-11')).toBe(12);
    expect(addDays('2026-10-28', 29)).toBe('2026-11-26');
    expect(daysLeftOf('2026-10-11', '2026-09-29')).toEqual({ text: ORG_TEXT.daysLeft, n: 12, tone: 'warn' });
    expect(daysLeftOf('2027-03-31', '2026-09-29').tone).toBe('mute');
    expect(daysLeftOf('2026-09-30', '2026-09-29')).toEqual({ text: ORG_TEXT.dayLeft, n: 1, tone: 'warn' });
    expect(daysLeftOf('2026-09-29', '2026-09-29').text).toBe(ORG_TEXT.endsToday);
    expect(daysLeftOf('2026-09-28', '2026-09-29')).toEqual({ text: ORG_TEXT.endedYesterday, n: 1, tone: 'bad' });
    expect(daysLeftOf('2026-09-15', '2026-09-29')).toEqual({ text: ORG_TEXT.endedDaysAgo, n: 14, tone: 'bad' });
    expect(isOpenEnded(null)).toBe(true);
    expect(isOpenEnded('9999-12-31')).toBe(true);
    expect(isOpenEnded('2027-03-31')).toBe(false);
    expect(todayOf(ctxOf())).toBe(sampleD().TODAY_S);
    expect(todayOf(ctxOf({ D: null }))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the ETag of an entitlement is the server\'s: W/"<version>-<updated at in ms>"', () => {
    expect(entitlementEtag(fromEntitlement(ENTITLEMENT))).toBe(`W/"3-${Date.UTC(2026, 9, 1, 3, 0, 0, 123)}"`);
  });

  it('the entitlement form: current values as custom limits, the first preset without a row, and the bodies of both', () => {
    const e = fromEntitlement(ENTITLEMENT);
    const form = entitlementForm(e, '2026-09-29', PRESETS);
    expect(form).toMatchObject({ preset: '', maxUsers: '50', maxSystems: '3', graceDays: '30', rateUser: '', validFrom: '2026-10-01', validUntil: '2027-09-30', noEnd: false });
    expect(entitlementForm({ ...e, validUntil: null }, '2026-09-29')).toMatchObject({ validUntil: '', noEnd: true });
    expect(entitlementForm({ ...e, validUntil: '9999-12-31' }, '2026-09-29')).toMatchObject({ validUntil: '', noEnd: true });
    const fresh = entitlementForm(null, '2026-09-29', PRESETS);
    expect(fresh).toMatchObject({ preset: 'trial', validFrom: '2026-09-29' });
    expect(entitlementForm(null, '2026-09-29').preset).toBe('');
    // A preset needs only its first day.
    expect(entitlementErrors(fresh)).toEqual({});
    const presetBody = entitlementBody(fresh);
    expect(presetBody).toEqual({ preset: 'trial', validFrom: '2026-09-29' });
    expect(EntitlementSet.parse(presetBody)).toEqual(presetBody);
    expect(presetUntil(PRESETS[0], '2026-10-28')).toBe('2026-11-26');
    // Custom limits: whole numbers, rates of 1 or more or empty, grace up to 365, the last day after the first.
    const bad = { ...form, maxUsers: '-1', maxSystems: 'x', graceDays: '400', rateUser: '0', rateOrg: 'abc', validUntil: '2026-09-01' };
    expect(entitlementErrors(bad)).toEqual({
      maxUsers: ORG_TEXT.wholeNumber, maxManagementSystems: ORG_TEXT.wholeNumber, graceDays: ORG_TEXT.graceNumber,
      rateUserPerMinute: ORG_TEXT.rateNumber, rateOrgPerMinute: ORG_TEXT.rateNumber, validUntil: ORG_TEXT.untilBeforeFrom,
    });
    expect(entitlementErrors({ ...form, validUntil: '' })).toEqual({ validUntil: ORG_TEXT.dateRequired });
    expect(entitlementErrors({ ...form, validUntil: '', noEnd: true })).toEqual({});
    const custom = entitlementBody({ ...form, plan: ' Contract 2026 ', maxUsers: '30', rateOrg: '3000', noEnd: true, frameworks: ['ISO27001'] });
    expect(custom).toEqual({
      plan: 'Contract 2026', maxUsers: 30, maxManagementSystems: 3, frameworks: ['ISO27001'], storageAdapters: ['managed_vault', 'm365', 'google_drive'],
      features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'], rateUserPerMinute: null, rateOrgPerMinute: 3000,
      graceDays: 30, validFrom: '2026-10-01', validUntil: null,
    });
    expect(EntitlementSet.parse(custom)).toEqual(custom);
    expect((entitlementBody({ ...form, plan: '' }) as { plan: string | null }).plan).toBeNull();
    expect(toggled(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggled(['a', 'b'], 'a', false)).toEqual(['b']);
  });

  it('a preset picked for an organisation whose plan has ended starts today, not on the first day of that plan', () => {
    const ended = { ...fromEntitlement(ENTITLEMENT), plan: null, source: 'signed_licence' as const, validFrom: '2025-09-16', validUntil: '2026-09-15' };
    const today = '2026-09-29';
    const form = entitlementForm(ended, today, PRESETS);
    expect(form).toMatchObject({ preset: '', validFrom: '2025-09-16' });
    const picked = { ...form, ...planPicked(form, 'standard', today, form.validFrom) };
    expect(picked).toMatchObject({ preset: 'standard', validFrom: today });
    expect(presetUntil(PRESETS[1], picked.validFrom)).toBe('2027-09-28');
    expect(entitlementBody(picked)).toEqual({ preset: 'standard', validFrom: today });
    // A move between presets keeps the day the operator sees; back to custom limits, the row's first day returns.
    const typed = { ...picked, validFrom: '2026-10-01' };
    expect(planPicked(typed, 'trial', today, form.validFrom)).toEqual({ preset: 'trial' });
    expect(planPicked(typed, '', today, form.validFrom)).toEqual({ preset: '', validFrom: '2025-09-16' });
    expect(planPicked(form, '', today, form.validFrom)).toEqual({ preset: '' });
  });

  it('domains: the typed value, the outcome of a check and the refusal texts', () => {
    expect(domainInputError('ndt.co.id')).toBeNull();
    expect(domainInputError('ndt')).toBe(ORG_TEXT.domainInvalid);
    expect(domainInputError('a b.id')).toBe(ORG_TEXT.domainInvalid);
    const check = (status: DomainCheck['status'], recordFound: boolean): DomainCheck => ({ ...fromDomain(DOMAIN), status, recordFound });
    expect(checkOutcome('pending', check('verified', true))).toEqual({ tone: 'ok', text: ORG_TEXT.foundNow });
    expect(checkOutcome('verified', check('verified', true))).toEqual({ tone: 'ok', text: ORG_TEXT.foundAgain });
    expect(checkOutcome('verified', check('verified', false))).toEqual({ tone: 'warn', text: ORG_TEXT.recordGone });
    expect(checkOutcome('pending', check('pending', false))).toEqual({ tone: 'info', text: ORG_TEXT.notFoundPending });
    expect(checkOutcome('pending', check('failed', false))).toEqual({ tone: 'bad', text: ORG_TEXT.notFoundFailed });
    const taken: [string, string] = ['The domain x is already verified for another organisation.', 'Domain x sudah diverifikasi untuk organisasi lain.'];
    expect(refusalText({ status: 409, message: taken, messageKey: 'domain_taken' })).toBe(taken);
    expect(refusalText({ status: 409, message: ['Conflict', 'Conflict'], messageKey: 'organization_archived' })).toBe(ORG_TEXT.refusedArchived);
    // The client shows the server's English detail where there is no message pair (M2-19); the console's text wins.
    const detailed: [string, string] = ['The organisation is archived', 'Pesan dari server: The organisation is archived'];
    expect(refusalText({ status: 409, message: detailed, messageKey: 'organization_archived' })).toBe(ORG_TEXT.refusedArchived);
    expect(refusalText({ status: 412, message: ['Precondition failed', 'Precondition failed'] })).toBe(ORG_TEXT.conflict);
    expect(refusalText({ status: 503, message: ['Unavailable', 'Unavailable'] }, { dns: true })).toBe(ORG_TEXT.dnsUnavailable);
    expect(refusalText({ status: 503, message: ['Unavailable', 'Unavailable'] })).toEqual(['Unavailable', 'Unavailable']);
  });

  it('runs the detail reads of the list at most a few at a time, in order', async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 2));
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(most).toBe(3);
    expect(await mapLimited([], 3, async (n: number) => n)).toEqual([]);
  });
});

describe('Organisation lifecycle API adapter', () => {
  it('reads the detail and the paged history, newest first', async () => {
    const f = client({
      'GET /api/v1/ops/organizations/ndt': json(DETAIL),
      'GET /api/v1/ops/organizations/ndt/events': json({ items: [EVENT], page: 2, pageSize: 20, total: 21 }),
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.organization('ndt')).toEqual({ ok: true, data: fromDetail(DETAIL) });
    expect(fromDetail(DETAIL)).toMatchObject({ status: 'offboarding', entitlement: { maxUsers: 100 }, domains: [{ domain: 'nusantaradigital.co.id', status: 'verified' }, { domain: 'ndt.co.id', status: 'pending' }] });
    expect(await adapter.events('ndt', 2, 20)).toEqual({ ok: true, data: { items: [fromEvent(EVENT)], page: 2, pageSize: 20, total: 21 } });
    expect(f.calls[1].url).toBe('/api/v1/ops/organizations/ndt/events?page=2&pageSize=20');
  });

  it('moves the status with the reason and the slug, and keeps the messages of 409 and 422', async () => {
    const result = OrganizationStatusChangeResult.parse({
      ok: true, changed: [], message: ['Organisation ndt moved from active to suspended. 12 sessions were ended. 1 of 2 Tenant Admins were emailed.', 'Organisasi ndt dipindahkan.'],
      data: { slug: 'ndt', from: 'active', to: 'suspended', sessionsRevoked: 12, tenantAdmins: 2, tenantAdminsEmailed: 1 },
    });
    const conflict = { messageKey: 'invalid_status_transition', messages: { en: 'Organisation ndt is archived and cannot move to active. archived is final.', id: 'Organisasi ndt berstatus archived.' } };
    const mismatch = { messageKey: 'confirmation_mismatch', messages: { en: 'Moving organisation ndt to archived needs confirmSlug equal to the slug ndt.', id: 'Memindahkan organisasi ndt ke archived memerlukan confirmSlug.' } };
    const f = client({
      'POST /api/v1/ops/organizations/ndt/status': [json(result), problem(409, 'transition-not-allowed', conflict), problem(422, 'business-rule', mismatch)],
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.changeStatus('ndt', { status: 'suspended', reason: 'Invoice overdue' })).toEqual({
      ok: true, data: { from: 'active', to: 'suspended', sessionsRevoked: 12, tenantAdmins: 2, tenantAdminsEmailed: 1, message: result.message },
    });
    const refused = await adapter.changeStatus('ndt', { status: 'active', reason: 'Renewed' });
    expect(!refused.ok && refused.error.messageKey).toBe('invalid_status_transition');
    expect(!refused.ok && refusalText(refused.error)).toEqual([conflict.messages.en, conflict.messages.id]);
    const wrong = await adapter.changeStatus('ndt', { status: 'archived', reason: 'Contract ended', confirmSlug: 'ndx' });
    expect(!wrong.ok && refusalText(wrong.error)).toEqual([mismatch.messages.en, mismatch.messages.id]);
    for (const call of f.calls) {
      expect(OrganizationStatusChange.safeParse(call.body).success).toBe(true);
      expect(call.headers['x-csrf-token']).toBe('csrf-token-0123456789');
    }
    expect(f.calls[2].body).toEqual({ status: 'archived', reason: 'Contract ended', confirmSlug: 'ndx' });
  });

  it('lists, adds, verifies and removes domains; 503 says DNS did not answer', async () => {
    const added = OrgDomainAdded.parse({ domain: 'ndt.co.id', txtName: '_mscd-verify.ndt.co.id', txtValue: 'mscd-verify=3q2-7wEVxk0bU9fBvYkTfQbgWm8nC4cN6r1dJQ_zLhA', status: 'pending' });
    const verified = OrgDomainCheck.parse({ ...DOMAIN, status: 'verified', verifiedAt: '2026-09-29T04:00:00Z', lastCheckedAt: '2026-09-29T04:00:00Z', pendingUntil: null, recordFound: true });
    const notAllowed = { messageKey: 'domain_not_allowed', messages: { en: 'gmail.com is a free mail domain that anyone can use.', id: 'gmail.com adalah domain email gratis.' } };
    const f = client({
      'GET /api/v1/ops/organizations/ndt/domains': json([DOMAIN]),
      'POST /api/v1/ops/organizations/ndt/domains': [json(added, 201), problem(422, 'business-rule', notAllowed)],
      'POST /api/v1/ops/organizations/ndt/domains/ndt.co.id/verify': [json(verified), problem(503, 'dependency-unavailable')],
      'DELETE /api/v1/ops/organizations/ndt/domains/ndt.co.id': { status: 204 },
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.domains('ndt')).toEqual({ ok: true, data: [fromDomain(DOMAIN)] });
    expect(await adapter.addDomain('ndt', 'NDT.co.id')).toEqual({ ok: true, data: { domain: 'ndt.co.id', txtName: added.txtName, txtValue: added.txtValue, status: 'pending' } });
    const free = await adapter.addDomain('ndt', 'gmail.com');
    expect(!free.ok && refusalText(free.error)).toEqual([notAllowed.messages.en, notAllowed.messages.id]);
    expect(await adapter.verifyDomain('ndt', 'ndt.co.id')).toEqual({ ok: true, data: { ...fromDomain(verified), recordFound: true } });
    const down = await adapter.verifyDomain('ndt', 'ndt.co.id');
    expect(!down.ok && refusalText(down.error, { dns: true })).toBe(ORG_TEXT.dnsUnavailable);
    expect(await adapter.removeDomain('ndt', 'ndt.co.id')).toEqual({ ok: true, data: null });
    const posts = f.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/domains'));
    for (const p of posts) expect(OrgDomainAdd.parse(p.body)).toEqual(p.body);
    expect(posts.map((p) => p.body)).toEqual([{ domain: 'NDT.co.id' }, { domain: 'gmail.com' }]);
    expect(f.calls.at(-1)!.method).toBe('DELETE');
  });

  it('reads an entitlement with its ETag, answers * for an organisation without one, and saves with If-Match', async () => {
    const saved = { ...ENTITLEMENT, maxUsers: 30, version: 4, updatedAt: '2026-10-02T03:00:00.456Z' };
    const warning = { rule: 'LIC-USERS', messages: { en: 'The organisation has 41 active members and the new limit is 30.', id: 'Organisasi ini memiliki 41 anggota aktif dan batas barunya 30.' } };
    const f = client({
      'GET /api/v1/ops/organizations/ndt/entitlements': json(ENTITLEMENT),
      'GET /api/v1/ops/organizations/klinik/entitlements': problem(404, 'not-found', { messageKey: 'no_entitlement', messages: { en: 'This organisation has no plan yet.', id: 'Organisasi ini belum memiliki paket.' } }),
      'GET /api/v1/ops/organizations/nobody/entitlements': problem(404, 'not-found'),
      'PUT /api/v1/ops/organizations/ndt/entitlements': [json({ ok: true, changed: [], data: saved, warnings: [warning] }), problem(412, 'precondition-failed')],
      'GET /api/v1/ops/plans': json(PRESETS),
    });
    const adapter = createApiAdapter(f.client);
    const read = await adapter.entitlement('ndt');
    expect(read).toEqual({ ok: true, data: { entitlement: fromEntitlement(ENTITLEMENT), etag: entitlementEtag(fromEntitlement(ENTITLEMENT)) } });
    expect(await adapter.entitlement('klinik')).toEqual({ ok: true, data: { entitlement: null, etag: '*' } });
    expect((await adapter.entitlement('nobody')).ok).toBe(false);
    const body = entitlementBody({ ...entitlementForm(fromEntitlement(ENTITLEMENT), '2026-09-29'), maxUsers: '30' });
    const res = await adapter.setEntitlement('ndt', body, read.ok ? read.data.etag : '');
    expect(res).toEqual({
      ok: true,
      data: { entitlement: fromEntitlement(saved), etag: `W/"4-${Date.parse(saved.updatedAt)}"`, warnings: [[warning.messages.en, warning.messages.id]] },
    });
    const put = f.calls.find((c) => c.method === 'PUT')!;
    expect(put.headers['if-match']).toBe(`W/"3-${Date.parse(ENTITLEMENT.updatedAt)}"`);
    expect(EntitlementSet.parse(put.body)).toEqual(put.body);
    const stale = await adapter.setEntitlement('ndt', { preset: 'standard', validFrom: '2026-10-01' }, '*');
    expect(!stale.ok && stale.error.status).toBe(412);
    expect(f.calls.filter((c) => c.method === 'PUT').map((c) => c.headers['if-match'])).toEqual([put.headers['if-match'], '*']);
    expect(await adapter.plans()).toEqual({ ok: true, data: PRESETS });
  });
});

describe('Organisation lifecycle parts', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`render in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme, mode: 'api', org: MULTI });
        const adapter = createSampleAdapter(() => sampleD());
        const detail = fromDetail(DETAIL);
        const e: Entitlement = fromEntitlement(ENTITLEMENT);
        const html = render(
          <>
            <OverviewView ctx={ctx} detail={detail} />
            <HistoryTable ctx={ctx} events={[fromEvent(EVENT), { ...fromEvent(EVENT), id: 'x', from: 'suspended', to: 'active', actor: null }]} />
            <StatusTab ctx={ctx} adapter={adapter} detail={detail} tick={0} onChanged={() => undefined} />
            <StatusDialog ctx={ctx} adapter={adapter} detail={detail} to="archived" onClose={() => undefined} onMoved={() => undefined} />
            <MovedAlert ctx={ctx} name={detail.name} moved={{ from: 'active', to: 'suspended', sessionsRevoked: 12, tenantAdmins: 2, tenantAdminsEmailed: 1, message: null }} />
            <OffboardingNote ctx={ctx} detail={detail} events={{ items: [fromEvent(EVENT)], page: 1, pageSize: 20, total: 1 }} />
            <DomainList ctx={ctx} domains={[fromDomain(DOMAIN), { ...fromDomain(DOMAIN), domain: 'bsd.co.id', status: 'verified', method: 'manual', pendingUntil: null }]} canManage archived={false} checking={null} onVerify={() => undefined} onRemove={() => undefined} />
            <AddDomainDialog ctx={ctx} adapter={adapter} detail={detail} open onClose={() => undefined} onAdded={() => undefined} />
            <EntitlementSummary ctx={ctx} e={e} />
            <EntitlementFields ctx={ctx} form={entitlementForm(e, '2026-09-29')} presets={PRESETS} errors={{}} onChange={() => undefined} />
            <EntitlementFields ctx={ctx} form={entitlementForm(null, '2026-09-29', PRESETS)} presets={PRESETS} errors={{}} onChange={() => undefined} />
          </>,
          ctx,
          theme,
        );
        const texts = [
          ORG_TEXT.statusOffboarding, ORG_TEXT.sourceManual, ORG_TEXT.domainVerified, ORG_TEXT.domainPending, ORG_TEXT.commandLine, ORG_TEXT.meaningOffboarding,
          ORG_TEXT.moveReactivate, ORG_TEXT.moveArchive, ORG_TEXT.effectsTitle, ORG_TEXT.effectArchived3, ORG_TEXT.reasonHint, ORG_TEXT.methodDns,
          ORG_TEXT.methodManual, ORG_TEXT.verifyNow, ORG_TEXT.remove, ORG_TEXT.domainHint, ORG_TEXT.customLimits, ORG_TEXT.noEndDate, ORG_TEXT.frameworksHint,
          ORG_TEXT.featureGuest, ORG_TEXT.everyStandard, ORG_TEXT.defaultRate,
        ];
        for (const text of texts) expect(html, text[0]).toContain(esc(t(text, lang)));
        expect(html).toContain(esc(ctx.fill(ORG_TEXT.confirmSlug, { slug: 'ndt' })));
        expect(html).toContain(esc(ctx.fill(ORG_TEXT.movedEmails, { sent: 1, total: 2 })));
        expect(html).toContain(esc(t(ORG_TEXT.movedEmailsShort, lang)));
        expect(html).toContain(esc(ctx.fill(ORG_TEXT.usersOf, { used: 41, limit: 50 })));
        expect(html).toContain(esc(ctx.fill(ORG_TEXT.presetUntil, { date: ctx.D!.fmt('2026-10-28', lang) })));
        expect(html).toContain(esc(ctx.fill(ORG_TEXT.offboardingSince, { date: ctx.D!.fmt('2026-09-19', lang), days: 30, end: ctx.D!.fmt('2026-10-19', lang) })));
        // "Verify now" only for a DNS domain.
        expect(html.split(esc(t(ORG_TEXT.verifyNow, lang))).length - 1).toBe(1);
        expect(html).not.toMatch(/[—·]/);
      });
    }
  }

  it('a reader sees the status and the domains without any action', () => {
    const ctx = ctxOf({ mode: 'api', org: READER });
    const adapter = createSampleAdapter(() => sampleD());
    const detail = { ...fromDetail(DETAIL), status: 'active' as const };
    const status = render(<StatusTab ctx={ctx} adapter={adapter} detail={detail} tick={0} onChanged={() => undefined} />, ctx);
    expect(status).toContain(esc(t(ORG_TEXT.readOnlyRights)));
    expect(status).not.toContain(esc(t(ORG_TEXT.moveSuspend)));
    const manager = ctxOf({ mode: 'api', org: MULTI });
    const managed = render(<StatusTab ctx={manager} adapter={adapter} detail={detail} tick={0} onChanged={() => undefined} />, manager);
    expect(managed).toContain(esc(t(ORG_TEXT.moveSuspend)));
    expect(managed).toContain(esc(t(ORG_TEXT.moveOffboard)));
    expect(managed).not.toContain(esc(t(ORG_TEXT.moveArchive)));
    const archived = render(<StatusTab ctx={manager} adapter={adapter} detail={{ ...detail, status: 'archived' }} tick={0} onChanged={() => undefined} />, manager);
    expect(archived).toContain(esc(t(ORG_TEXT.finalStatus)));
    expect(render(<DomainsTab ctx={ctx} adapter={adapter} detail={detail} onChanged={() => undefined} />, ctx)).not.toContain(esc(t(ORG_TEXT.addDomain)));
    expect(render(<DomainsTab ctx={manager} adapter={adapter} detail={detail} onChanged={() => undefined} />, manager)).toContain(esc(t(ORG_TEXT.addDomain)));
    expect(render(<DomainsTab ctx={manager} adapter={adapter} detail={{ ...detail, status: 'archived' }} onChanged={() => undefined} />, manager)).toContain(esc(t(ORG_TEXT.archivedDomains)));
    const table = render(<DomainList ctx={ctx} domains={[fromDomain(DOMAIN)]} canManage={false} archived={false} checking={null} onVerify={() => undefined} onRemove={() => undefined} />, ctx);
    expect(table).not.toContain(esc(t(ORG_TEXT.verifyNow)));
  });

  it('the drawer has the five tabs of the brief, and the list its filter and Manage', () => {
    expect(ORG_TABS.map((x) => x.label[0])).toEqual(['Overview', 'Status', 'Domains', 'Entitlements', 'History']);
    const ctx = ctxOf({ mode: 'api', org: MULTI });
    const html = render(<OrganizationsTab ctx={ctx} adapter={createSampleAdapter(() => sampleD())} creating={false} setCreating={() => undefined} />, ctx);
    expect(html).toContain(esc(t(ORG_TEXT.statusFilter)));
    expect(html).toContain(esc(t(ORG_TEXT.allStatuses)));
    for (const s of [ORG_TEXT.statusActive, ORG_TEXT.statusSuspended, ORG_TEXT.statusOffboarding, ORG_TEXT.statusArchived]) expect(html).toContain(esc(t(s)));
    const create = render(<CreateDialog ctx={ctx} adapter={createSampleAdapter(() => sampleD())} open onClose={() => undefined} onCreated={() => undefined} />, ctx);
    expect(create).toContain(esc(t(ORG_TEXT.plan)));
    expect(create).toContain(esc(t(ORG_TEXT.noPlanYet)));
    expect(create).not.toContain(esc(t(TEXT.copyLink)));
  });
});

describe('Organisation lifecycle sample adapter', () => {
  it('holds an organisation in every status but archived, with plans, domains and history for every tab', async () => {
    const adapter = createSampleAdapter(() => sampleD());
    const list = await adapter.organizations({ page: 1, pageSize: 25 });
    expect(list.ok && list.data.items.map((o) => [o.slug, o.status])).toEqual([
      ['ndt', 'active'], ['bsd', 'active'], ['rmn', 'active'], ['mitra_logistik', 'suspended'], ['sinar_farma', 'offboarding'],
    ]);
    expect(list.ok && list.data.items[0]).toMatchObject({ plan: 'enterprise', maxUsers: 100, verifiedDomains: ['nusantaradigital.co.id'], validUntil: '2027-03-31' });
    expect(list.ok && list.data.items[1].licence).toEqual({ state: 'grace', validUntil: '2026-09-15' });
    const suspended = await adapter.organizations({ page: 1, pageSize: 25, status: 'suspended' });
    expect(suspended.ok && suspended.data.items.map((o) => o.slug)).toEqual(['mitra_logistik']);
    const found = await adapter.organizations({ page: 1, pageSize: 25, q: 'farma' });
    expect(found.ok && found.data.items.map((o) => o.slug)).toEqual(['sinar_farma']);
    const detail = await adapter.organization('ndt');
    expect(detail.ok && detail.data.domains.map((d) => d.status)).toEqual(['pending', 'verified']);
    const events = await adapter.events('ndt', 1, 1);
    expect(events.ok && [events.data.total, events.data.items[0].to]).toEqual([2, 'active']);
    expect((await adapter.organization('nobody')).ok).toBe(false);
  });

  it('moves the status along J.8 with the slug for the final moves, and writes the history', async () => {
    const adapter = createSampleAdapter(() => sampleD());
    const refused = await adapter.changeStatus('ndt', { status: 'archived', reason: 'Contract ended', confirmSlug: 'ndt' });
    expect(!refused.ok && refused.error.messageKey).toBe('invalid_status_transition');
    const mismatch = await adapter.changeStatus('ndt', { status: 'offboarding', reason: 'Contract ended', confirmSlug: 'ndx' });
    expect(!mismatch.ok && mismatch.error.messageKey).toBe('confirmation_mismatch');
    const moved = await adapter.changeStatus('ndt', { status: 'suspended', reason: 'Invoice overdue' });
    expect(moved.ok && moved.data).toMatchObject({ from: 'active', to: 'suspended', sessionsRevoked: 29, tenantAdmins: 2, tenantAdminsEmailed: 2 });
    const offboarding = await adapter.changeStatus('ndt', { status: 'offboarding', reason: 'Contract ended', confirmSlug: 'ndt' });
    expect(offboarding.ok && offboarding.data.sessionsRevoked).toBe(0);
    const history = await adapter.events('ndt', 1, 20);
    expect(history.ok && history.data.items.slice(0, 2).map((e) => `${e.from}>${e.to}`)).toEqual(['suspended>offboarding', 'active>suspended']);
    expect((await adapter.changeStatus('ndt', { status: 'archived', reason: 'Read-only period over', confirmSlug: 'ndt' })).ok).toBe(true);
    const final = await adapter.changeStatus('ndt', { status: 'active', reason: 'Renewed' });
    expect(!final.ok && final.error.message[0]).toContain('archived is final');
    const archivedAdd = await adapter.addDomain('ndt', 'new.co.id');
    expect(!archivedAdd.ok && refusalText(archivedAdd.error)).toBe(ORG_TEXT.refusedArchived);
  });

  it('adds a domain with a token shown once, checks it, and refuses free mail and a domain of another organisation', async () => {
    const adapter = createSampleAdapter(() => sampleD());
    const added = await adapter.addDomain('rmn', ' RS@Medika.co.id ');
    expect(added.ok && added.data).toMatchObject({ domain: 'medika.co.id', txtName: '_mscd-verify.medika.co.id', status: 'pending' });
    expect(added.ok && OrgDomainAdded.safeParse(added.data).success).toBe(true);
    const listed = await adapter.domains('rmn');
    expect(listed.ok && listed.data).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(added.ok ? added.data.txtValue.slice(12) : 'x');
    const first = await adapter.verifyDomain('rmn', 'medika.co.id');
    expect(first.ok && [first.data.status, first.data.recordFound]).toEqual(['pending', false]);
    const second = await adapter.verifyDomain('rmn', 'medika.co.id');
    expect(second.ok && [second.data.status, second.data.recordFound]).toEqual(['verified', true]);
    expect((await adapter.organizations({ page: 1, pageSize: 25, q: 'rmn' })).ok).toBe(true);
    const again = await adapter.addDomain('rmn', 'medika.co.id');
    expect(!again.ok && again.error.messageKey).toBe('domain_already_verified');
    const taken = await adapter.addDomain('rmn', 'nusantaradigital.co.id');
    expect(!taken.ok && taken.error.messageKey).toBe('domain_taken');
    const free = await adapter.addDomain('rmn', 'gmail.com');
    expect(!free.ok && free.error.messageKey).toBe('domain_not_allowed');
    const manual = await adapter.verifyDomain('bsd', 'banksentosa.co.id');
    expect(!manual.ok && manual.error.messageKey).toBe('domain_not_dns');
    const failed = await adapter.verifyDomain('mitra_logistik', 'mitralogistik.co.id');
    expect(failed.ok && [failed.data.status, failed.data.recordFound]).toEqual(['failed', false]);
    expect((await adapter.removeDomain('rmn', 'medika.co.id')).ok).toBe(true);
    expect((await adapter.removeDomain('rmn', 'medika.co.id')).ok).toBe(false);
    expect(normaliseDomain('Bücher.example')).toBe('xn--bcher-kva.example');
    expect(normaliseDomain('localhost')).toBeNull();
  });

  it('sets an entitlement with If-Match: * for a new one, 412 for a stale ETag, warnings below the current use', async () => {
    const adapter = createSampleAdapter(() => sampleD());
    expect((await adapter.createOrganization({ slug: 'klinik', name: 'Klinik', timeZone: 'Asia/Jakarta', siteCount: 1, firstAdmin: { email: 'a@klinik.id', displayName: 'A' } }, 'k')).ok).toBe(true);
    const none = await adapter.entitlement('klinik');
    expect(none).toEqual({ ok: true, data: { entitlement: null, etag: '*' } });
    const first = await adapter.setEntitlement('klinik', { preset: 'trial', validFrom: '2026-10-28' }, '*');
    expect(first.ok && first.data.entitlement).toMatchObject({ plan: 'trial', source: 'preset', maxUsers: 10, validUntil: '2026-11-26', version: 1 });
    const read = await adapter.entitlement('ndt');
    expect(read.ok && read.data.entitlement?.usage).toEqual({ users: 86, managementSystems: 4 });
    const etag = read.ok ? read.data.etag : '';
    const lowered = await adapter.setEntitlement('ndt', entitlementBody({ ...entitlementForm(read.ok ? read.data.entitlement : null, '2026-09-29'), maxUsers: '50', maxSystems: '3' }), etag);
    expect(lowered.ok && lowered.data.warnings).toHaveLength(2);
    expect(lowered.ok && lowered.data.warnings[0][0]).toContain('86 active members and the new limit is 50');
    const stale = await adapter.setEntitlement('ndt', { preset: 'standard' }, etag);
    expect(!stale.ok && refusalText(stale.error)).toBe(ORG_TEXT.conflict);
    expect((await adapter.setEntitlement('ndt', { preset: 'gold' }, '*')).ok).toBe(false);
    const created = await adapter.createOrganization({ slug: 'klinik_dua', name: 'Klinik Dua', timeZone: 'Asia/Jakarta', siteCount: 1, firstAdmin: { email: 'a@k2.id', displayName: 'A' }, preset: 'standard' }, 'k2');
    expect(created.ok && created.data.message?.[0]).toContain('The standard plan applies from 2026-09-29 to 2027-09-28.');
    const plans = await adapter.plans();
    expect(plans.ok && plans.data.map((p) => [p.name, p.maxUsers, p.maxManagementSystems, p.validDays])).toEqual([['trial', 10, 1, 30], ['standard', 50, 3, 365]]);
  });
});
