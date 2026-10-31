// The end of a contract (Milestone 3 D.2, D.5.1, J.8; M3-03) in multi tenancy, with a clock the test moves: the move to
// offboarding sets the end of the read-only period and queues the final export; `org.lifecycle` reminds the Tenant
// Admins 7 days and 1 day before the end (once each), archives the organisation at the end and schedules its deletion,
// reminds again before the deletion and starts the purge on the date; the operator moves the date (never before
// archiving plus the minimum grace), cancels it and reopens the organisation for an export (the deletion is
// cancelled); every deletion route answers 409 `single_tenancy` in single tenancy; and a lifecycle value below 7 days
// stops a server without MSCD_SAAS_TEST=1.
import path from 'node:path';
import { OrganizationDeletionResult, OrganizationDeletionView, type OpsOrganizationDetail, type OpsOrganizationItem, type OrganizationStatus, type Page } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatDetail, formatList } from '../../../src/cli/tenant';
import { Clock } from '../../../src/common/clock';
import { ProfileError } from '../../../src/config/load-profile';
import { MscdConfig } from '../../../src/config/mscd-config';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { OrgLifecycleJob } from '../../../src/modules/ops/deletion/org-lifecycle.job';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, type Client, type FullApp } from '../contract/harness';
import { addPerson, createOnboardingApp, inPlatform, inTenant, platformAudit, sessionIn, type Person } from '../onboarding/helpers';
import {
  DAY, DELETION_CANCEL, DELETION_CERTIFICATE, DELETION_GET, DELETION_RETRY, DELETION_SCHEDULE, STATUS, createDeletionApp, deletionsOf, orgRow,
  startDeletionStack, waiting, type DeletionStack,
} from './helpers';

const T0 = Date.parse('2026-11-02T03:00:00.000Z');

describe('end of contract (Milestone 3 D.5.1, J.8; M3-03)', () => {
  const db = useTestDatabase('empty');
  let stack: DeletionStack;
  let full: FullApp;
  let operator: Person;
  let now = T0;
  let lifecycle: OrgLifecycleJob;

  /** A signed-in operator, made at the current time of the clock (sessions expire when the clock moves on). */
  const op = () => sessionIn(full, operator.id, null);
  const setStatus = async (org: string, status: OrganizationStatus, reason: string, confirm = true) =>
    callRoute<{ data: { from: string; to: string }; messageKey?: string; message?: [string, string] }>(await op(), STATUS, {
      params: { org },
      body: { status, reason, ...(confirm ? { confirmSlug: org } : {}) },
    });

  beforeAll(async () => {
    stack = await startDeletionStack();
    operator = await addPerson(db, 'ops.deletion', [], { platformOperator: true, password: true });
    full = await createDeletionApp(db, stack);
    full.get<Clock>(Clock).now = () => new Date(now);
    lifecycle = full.get<OrgLifecycleJob>(OrgLifecycleJob);
  });
  afterAll(async () => {
    await full?.close();
    await stack?.close();
  });

  describe('offboarding, reminders, archiving and the deletion date', () => {
    let alpha: CreatedTenant;
    let admins: Person[];

    beforeAll(async () => {
      alpha = await createTenant(db, 'alpha', { name: 'PT Alpha Sejahtera' });
      admins = [
        await addPerson(db, 'alpha.admin1', [{ org: alpha, adminRoles: ['tenant_admin'] }], { password: true }),
        await addPerson(db, 'alpha.admin2', [{ org: alpha, adminRoles: ['tenant_admin'] }], { password: true }),
      ];
    });

    it('offboarding sets the end of the read-only period and queues the final export', async () => {
      now = T0;
      const call = await setStatus('alpha', 'offboarding', 'Contract ended on 31 Oct 2026');
      expect(call.violations).toEqual([]);
      expect(call.status, call.text).toBe(200);
      expect(call.body.message?.[0]).toContain('The read-only period ends on 2026-12-02 and the final export was queued.');
      const row = await orgRow(db, alpha.id);
      expect(row.status).toBe('offboarding');
      expect(row.offboarding_ends_at?.getTime()).toBe(T0 + 30 * DAY);

      const exports = await inPlatform(db, (trx) => trx.selectFrom('platform.organization_export').selectAll().where('organization_id', '=', alpha.id).execute());
      expect(exports).toHaveLength(1);
      expect(exports[0]).toMatchObject({ status: 'queued', requested_via: 'offboarding', requested_by: null, is_final: true });
      expect(waiting(full, 'org-export.build')).toContainEqual({ exportId: exports[0]!.id });

      // The operator sees the end and the export; the Tenant Admin sees the end and the planned deletion date.
      const detail = await (await op()).request<OpsOrganizationDetail>('GET', '/api/v1/ops/organizations/alpha');
      expect(detail.body).toMatchObject({ offboardingEndsAt: new Date(T0 + 30 * DAY).toISOString(), deletion: null, lastExport: { status: 'queued', readyAt: null } });
      // So do "tenant show" and "tenant list" (D.2), "tenant show --summary" with states only.
      const shown = formatDetail({ organization: detail.body, events: [], eventCount: 0 });
      expect(shown).toContain(`Read-only until:     ${new Date(T0 + 30 * DAY).toISOString()}`);
      expect(shown).toContain('Deletion:            none');
      expect(shown).toContain('Last export:         queued');
      expect(formatDetail({ organization: detail.body, events: [], eventCount: 0 }, true)).toContain('Last export:         queued');
      const listed = await (await op()).request<Page<OpsOrganizationItem>>('GET', '/api/v1/ops/organizations?q=alpha');
      expect(formatList(listed.body.items)).toContain(`  alpha: read-only until ${new Date(T0 + 30 * DAY).toISOString()}; last export queued`);
      const admin = await sessionIn(full, admins[0]!.id, alpha);
      const settings = await admin.request<{ offboardingEndsAt: string; deletionScheduledFor: string }>('GET', '/api/v1/admin/organization');
      expect(settings.status, settings.text).toBe(200);
      expect(settings.body).toMatchObject({
        offboardingEndsAt: new Date(T0 + 30 * DAY).toISOString(),
        deletionScheduledFor: new Date(T0 + 60 * DAY).toISOString(),
      });

      // The status email names the end of the read-only period.
      const mail = await stack.mail.waitFor(admins[0]!.email, (m) => m.subject.includes('is read-only on MSCD'));
      expect(mail.text).toContain('The read-only period ends on 02 Dec 2026');
    });

    it('org.lifecycle reminds 7 days and 1 day before the end, once each, then archives and schedules the deletion', async () => {
      now = T0 + 23 * DAY + 3_600_000;
      expect(await lifecycle.run()).toMatchObject({ archived: 0, remindersSent: 2 });
      expect(await lifecycle.run()).toMatchObject({ archived: 0, remindersSent: 0 });
      await stack.mail.waitFor(admins[1]!.email, (m) => m.subject === '[MSCD] PT Alpha Sejahtera: the read-only period ends in 7 days');

      now = T0 + 29 * DAY + 2 * 3_600_000;
      expect(await lifecycle.run()).toMatchObject({ remindersSent: 2 });
      expect(await lifecycle.run()).toMatchObject({ remindersSent: 0 });
      await stack.mail.waitFor(admins[1]!.email, (m) => m.subject === '[MSCD] PT Alpha Sejahtera: the read-only period ends in 1 day');
      const reminders = await inTenant(db, alpha, (trx) =>
        trx.selectFrom('notification').select(['recipient_user_id', 'entity_ref']).where('kind', '=', 'organization_lifecycle').execute(),
      );
      expect(reminders.map((r) => (r.entity_ref as { stage: string }).stage).sort()).toEqual(['offboarding_1d', 'offboarding_1d', 'offboarding_7d', 'offboarding_7d']);

      // At the end of the period the system archives the organisation and schedules the deletion.
      now = T0 + 30 * DAY + 60_000;
      expect(await lifecycle.run()).toMatchObject({ archived: 1 });
      expect(await lifecycle.run()).toMatchObject({ archived: 0, purgesQueued: 0 });
      expect((await orgRow(db, alpha.id)).status).toBe('archived');
      const [deletion] = await deletionsOf(db, alpha.id);
      expect(deletion).toMatchObject({ status: 'scheduled', scheduled_by: null });
      expect(deletion!.scheduled_for.getTime()).toBe(now + 30 * DAY);
      expect(deletion!.notify_emails_sealed).not.toBeNull();
      const archivedDetail = await (await op()).request<OpsOrganizationDetail>('GET', '/api/v1/ops/organizations/alpha');
      expect(archivedDetail.body).toMatchObject({ offboardingEndsAt: null, deletion: { status: 'scheduled', scheduledFor: deletion!.scheduled_for.toISOString() } });
      expect(formatDetail({ organization: archivedDetail.body, events: [], eventCount: 0 })).toContain(`Deletion:            scheduled, date ${deletion!.scheduled_for.toISOString()}`);
      expect(formatDetail({ organization: archivedDetail.body, events: [], eventCount: 0 }, true)).toContain('Deletion:            scheduled');
      const events = await inPlatform(db, (trx) =>
        trx.selectFrom('platform.organization_status_event').select(['from_status', 'to_status', 'actor_user_id']).where('organization_id', '=', alpha.id).orderBy('created_at').execute(),
      );
      expect(events.at(-1)).toEqual({ from_status: 'offboarding', to_status: 'archived', actor_user_id: null });
      const ended = await platformAudit(db, 'tenant.offboarding_ended');
      expect(ended).toEqual([expect.objectContaining({ organization_id: alpha.id, actor_kind: 'system', entity_code: 'alpha' })]);
      const closed = await stack.mail.waitFor(admins[0]!.email, (m) => m.subject.includes('is closed on MSCD'));
      expect(closed.text).toContain('MSCD deletes the data of PT Alpha Sejahtera for good on');

      // Reminders before the deletion, once each.
      const due = deletion!.scheduled_for.getTime();
      now = due - 7 * DAY + 3_600_000;
      expect(await lifecycle.run()).toMatchObject({ remindersSent: 2, purgesQueued: 0 });
      expect(await lifecycle.run()).toMatchObject({ remindersSent: 0 });
      now = due - DAY + 3_600_000;
      expect(await lifecycle.run()).toMatchObject({ remindersSent: 2 });
      expect(await lifecycle.run()).toMatchObject({ remindersSent: 0 });
      await stack.mail.waitFor(admins[0]!.email, (m) => m.subject === '[MSCD] PT Alpha Sejahtera: MSCD deletes the data in 1 day');

      // On the date the deletion runs: org.purge is queued once.
      now = due + 60_000;
      expect(await lifecycle.run()).toMatchObject({ purgesQueued: 1 });
      expect(await lifecycle.run()).toMatchObject({ purgesQueued: 0 });
      expect((await deletionsOf(db, alpha.id))[0]!.status).toBe('running');
      expect(waiting(full, 'org.purge')).toEqual([{ deletionId: deletion!.id }]);
    });
  });

  describe('the operator moves, cancels and reopens', () => {
    let beta: CreatedTenant;
    let archivedAt: number;

    beforeAll(async () => {
      beta = await createTenant(db, 'beta', { name: 'PT Beta' });
      await addPerson(db, 'beta.admin', [{ org: beta, adminRoles: ['tenant_admin'] }], { password: true });
      now = T0 + 100 * DAY;
      expect((await setStatus('beta', 'offboarding', 'Contract ended')).status).toBe(200);
      archivedAt = now = T0 + 101 * DAY;
      expect((await setStatus('beta', 'archived', 'Customer asked to close early')).status).toBe(200);
    });

    it('schedules the deletion at archiving plus the grace period and refuses a date before the minimum', async () => {
      const [deletion] = await deletionsOf(db, beta.id);
      expect(deletion).toMatchObject({ status: 'scheduled', scheduled_by: null });
      expect(deletion!.scheduled_for.getTime()).toBe(archivedAt + 30 * DAY);

      const view = await callRoute<OrganizationDeletionView>(await op(), DELETION_GET, { params: { org: 'beta' } });
      expect(view.violations).toEqual([]);
      expect(OrganizationDeletionView.safeParse(view.body).success).toBe(true);
      expect(view.body).toMatchObject({
        status: 'scheduled', scheduledBy: null, archivedAt: new Date(archivedAt).toISOString(), earliestAllowed: new Date(archivedAt + 7 * DAY).toISOString(), steps: [],
      });

      const early = await callRoute<{ messageKey: string }>(await op(), DELETION_SCHEDULE, {
        params: { org: 'beta' },
        body: { scheduledFor: new Date(archivedAt + 3 * DAY).toISOString(), reason: 'The customer asked in writing for an earlier deletion', confirmSlug: 'beta' },
      });
      expect(early.violations).toEqual([]);
      expect(early.status).toBe(409);
      expect(early.body.messageKey).toBe('deletion_too_soon');
      const wrongSlug = await callRoute<{ messageKey: string }>(await op(), DELETION_SCHEDULE, {
        params: { org: 'beta' },
        body: { scheduledFor: new Date(archivedAt + 8 * DAY).toISOString(), reason: 'The customer asked in writing for an earlier deletion', confirmSlug: 'alpha' },
      });
      expect(wrongSlug.status).toBe(422);
      expect(wrongSlug.body.messageKey).toBe('confirmation_mismatch');

      const moved = await callRoute<OrganizationDeletionResult>(await op(), DELETION_SCHEDULE, {
        params: { org: 'beta' },
        body: { scheduledFor: new Date(archivedAt + 8 * DAY).toISOString(), reason: 'The customer asked in writing for an earlier deletion', confirmSlug: 'beta' },
      });
      expect(moved.violations).toEqual([]);
      expect(moved.status, moved.text).toBe(200);
      expect(moved.body.data).toEqual({ id: deletion!.id, status: 'scheduled', scheduledFor: new Date(archivedAt + 8 * DAY).toISOString() });
      const after = await callRoute<OrganizationDeletionView>(await op(), DELETION_GET, { params: { org: 'beta' } });
      expect(after.body.scheduledBy).toEqual({ handle: 'ops.deletion', displayName: 'Person ops.deletion' });
      expect(await platformAudit(db, 'ops.deletion_scheduled')).toEqual([
        expect.objectContaining({ organization_id: beta.id, actor_kind: 'operator', actor_user_id: operator.id, entity_id: deletion!.id }),
      ]);
    });

    it('cancels, refuses to reopen without a scheduled deletion, and reopens for 7 days once one is scheduled again', async () => {
      const cancelled = await callRoute<OrganizationDeletionResult>(await op(), DELETION_CANCEL, { params: { org: 'beta' }, body: { reason: 'Customer still negotiating' } });
      expect(cancelled.violations).toEqual([]);
      expect(cancelled.status, cancelled.text).toBe(200);
      expect(cancelled.body.data.status).toBe('cancelled');
      expect((await callRoute(await op(), DELETION_CANCEL, { params: { org: 'beta' }, body: { reason: 'Customer still negotiating' } })).status).toBe(409);
      const refused = await setStatus('beta', 'offboarding', 'Customer forgot an export');
      expect(refused.status).toBe(409);
      expect(refused.body.messageKey).toBe('invalid_status_transition');
      // The certificate and the retry exist only for a completed or failed deletion.
      expect((await callRoute(await op(), DELETION_CERTIFICATE, { params: { org: 'beta' } })).status).toBe(409);
      expect((await callRoute(await op(), DELETION_RETRY, { params: { org: 'beta' }, body: { reason: 'Run the failed purge again' } })).status).toBe(409);

      const again = await callRoute<OrganizationDeletionResult>(await op(), DELETION_SCHEDULE, {
        params: { org: 'beta' },
        body: { scheduledFor: new Date(now + 10 * DAY).toISOString(), reason: 'Deletion agreed with the customer again', confirmSlug: 'beta' },
      });
      expect(again.status, again.text).toBe(200);
      const reopened = await setStatus('beta', 'offboarding', 'Customer forgot an export');
      expect(reopened.status, reopened.text).toBe(200);
      expect(reopened.body.message?.[0]).toContain('The scheduled deletion was cancelled.');
      expect((await orgRow(db, beta.id)).offboarding_ends_at?.getTime()).toBe(now + 7 * DAY);
      const deletions = await deletionsOf(db, beta.id);
      expect(deletions.map((d) => d.status)).toEqual(['cancelled', 'cancelled']);
      const exports = await inPlatform(db, (trx) => trx.selectFrom('platform.organization_export').select(['status', 'is_final']).where('organization_id', '=', beta.id).execute());
      expect(exports.every((e) => e.is_final && e.status === 'queued')).toBe(true);
    });

    it('refuses to schedule the deletion of an organisation that is not archived', async () => {
      const call = await callRoute<{ messageKey: string }>(await op(), DELETION_SCHEDULE, {
        params: { org: 'beta' },
        body: { scheduledFor: new Date(now + 40 * DAY).toISOString(), reason: 'Deletion of an organisation in offboarding', confirmSlug: 'beta' },
      });
      expect(call.violations).toEqual([]);
      expect(call.status).toBe(409);
      expect(call.body.messageKey).toBe('deletion_not_archived');
    });
  });

  it('answers 409 single_tenancy on every deletion route in single tenancy', async () => {
    const single = await createOnboardingApp(db, {});
    try {
      single.get<Clock>(Clock).now = () => new Date(now);
      const client: Client = await sessionIn(single, operator.id, null);
      const body = { scheduledFor: new Date(now + 40 * DAY).toISOString(), reason: 'Deletion in single tenancy', confirmSlug: 'alpha' };
      for (const [def, input] of [
        [DELETION_GET, { params: { org: 'alpha' } }],
        [DELETION_SCHEDULE, { params: { org: 'alpha' }, body }],
        [DELETION_CANCEL, { params: { org: 'alpha' }, body: { reason: 'Single tenancy refuses' } }],
        [DELETION_RETRY, { params: { org: 'alpha' }, body: { reason: 'Single tenancy refuses' } }],
        [DELETION_CERTIFICATE, { params: { org: 'alpha' } }],
      ] as const) {
        const call = await callRoute<{ messageKey: string }>(client, def, input);
        expect(call.violations, def.id).toEqual([]);
        expect(call.status, def.id).toBe(409);
        expect(call.body.messageKey, def.id).toBe('single_tenancy');
      }
      // The lifecycle job does nothing there.
      expect(await single.get<OrgLifecycleJob>(OrgLifecycleJob).run()).toEqual({ archived: 0, remindersSent: 0, purgesQueued: 0, purgesRequeued: 0, endsSet: 0 });
    } finally {
      await single.close();
    }
  });

  it('stops a server whose lifecycle values are below 7 days unless MSCD_SAAS_TEST=1', () => {
    const saas = path.resolve(__dirname, '../../../profiles/saas.yaml');
    const env = { MSCD_PROFILE_FILE: saas, MSCD__LIFECYCLE__DELETION_GRACE_DAYS: '0', MSCD__LIFECYCLE__DELETION_MIN_GRACE_DAYS: '3' };
    let refused: unknown;
    try {
      MscdConfig.load({ runMode: 'worker', env });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ProfileError);
    expect((refused as ProfileError).issues.map((i) => i.path).sort()).toEqual(['lifecycle.deletion_grace_days', 'lifecycle.deletion_min_grace_days']);
    expect(MscdConfig.load({ runMode: 'worker', env: { ...env, MSCD_SAAS_TEST: '1' } }).profile.lifecycle.deletion_grace_days).toBe(0);
  });
});
