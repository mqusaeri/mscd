// `entitlement.expiry` (Milestone 2 J.3, K.6 M2-S10): daily per organisation through `scheduler.tick` and its run
// ledger, on the date of its run. Every active platform operator gets one email per organisation 30, 7 and 1 days
// before `valid_until`; the organisation's Tenant Admins get the `licence_expiring` notice, emailed by
// `notifications.dispatch`, 30 and 7 days before. An entitlement without an end date sends nothing. When no operator
// email could be sent, the job hands the run back to the tick, which runs it again at the next hour. Single tenancy
// has no handler, so the tick schedules nothing.
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { AccountMailer, type AccountMail } from '../../../src/modules/identity/account-mailer';
import { SchedulerTickJob } from '../../../src/modules/jobs/scheduler-tick.job';
import { EntitlementExpiryJob } from '../../../src/modules/license/entitlement-expiry.job';
import type { EntitlementValues } from '../../../src/modules/license/entitlement-row';
import { EntitlementStore } from '../../../src/modules/license/entitlement-store';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { startMailpit, type Mailpit, type MailMessage } from '../identity/helpers';
import { createJobsApp, type JobsApp } from '../jobs/helpers';
import { addPerson, inPlatform, inTenant, type Person } from '../onboarding/helpers';
import { MULTI } from './helpers';

const values = (extra: Partial<EntitlementValues> = {}): EntitlementValues => ({
  plan: 'standard',
  source: 'preset',
  maxUsers: 50,
  maxManagementSystems: 3,
  frameworks: [],
  storageAdapters: ['managed_vault'],
  features: [],
  rateUserPerMinute: null,
  rateOrgPerMinute: null,
  validFrom: '2029-02-15',
  validUntil: '2030-02-14',
  graceDays: 30,
  ...extra,
});

describe('entitlement.expiry through scheduler.tick and the run ledger (Milestone 2 M2-S10)', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let jobs: JobsApp;
  let ending: CreatedTenant;
  let open: CreatedTenant;
  let admin: Person;
  let member: Person;
  let operators: Person[];
  let revoked: Person;
  let disabled: Person;

  /** One tick at `at` and every job it queued for the handled queues; the runs of `entitlement.expiry` it enqueued. */
  const tickAt = async (at: string) => {
    jobs.setNow(at);
    const result = await jobs.moduleRef.get(SchedulerTickJob).tick();
    await jobs.drain();
    return result.enqueued.filter((e) => e.name === 'entitlement.expiry').map((e) => ({ org: e.orgId, localDate: e.localDate, key: e.singletonKey, path: e.path }));
  };
  const expiryMails = async (to: string): Promise<MailMessage[]> => (await mail.messages(to)).filter((m) => m.mailKind === 'account:entitlement_expiring');
  const noticeMails = async (to: string): Promise<MailMessage[]> => (await mail.messages(to)).filter((m) => m.mailKind === 'notification:licence_expiring');
  const notices = (userId: string) =>
    inTenant(db, ending, (trx) => trx.selectFrom('notification').select(['kind', 'title_en', 'body_en']).where('recipient_user_id', '=', userId).orderBy('created_at').execute());
  /** Waits until `count` emails of a kind reached `to` (the dispatch sends after the job's commit). */
  const waitForMails = async (read: (to: string) => Promise<MailMessage[]>, to: string, count: number) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = await read(to);
      if (found.length >= count) return found;
      if (Date.now() > deadline) throw new Error(`${to} got ${found.length} emails, expected ${count}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  beforeAll(async () => {
    mail = await startMailpit();
    ending = await createTenant(db, 'exp_ending', { name: 'PT Ending', timeZone: 'Asia/Jakarta' });
    open = await createTenant(db, 'exp_open', { name: 'PT Open', timeZone: 'Asia/Jakarta' });
    admin = await addPerson(db, 'ending.admin', [{ org: ending, adminRoles: ['tenant_admin'] }], { domain: 'ending.test' });
    member = await addPerson(db, 'ending.member', [{ org: ending }], { domain: 'ending.test' });
    await addPerson(db, 'open.admin', [{ org: open, adminRoles: ['tenant_admin'] }], { domain: 'open.test' });
    operators = [
      await addPerson(db, 'ops.first', [], { platformOperator: true, domain: 'operator.test' }),
      await addPerson(db, 'ops.second', [], { platformOperator: true, domain: 'operator.test' }),
    ];
    revoked = await addPerson(db, 'ops.revoked', [], { platformOperator: true, domain: 'operator.test' });
    disabled = await addPerson(db, 'ops.disabled', [], { platformOperator: true, domain: 'operator.test', status: 'disabled' });
    await inPlatform(db, (trx) => trx.updateTable('platform.platform_role').set({ revoked_at: new Date('2029-01-01T00:00:00Z') }).where('user_id', '=', revoked.id).execute());

    // Only the tick, the expiry job and the email dispatch have workers; the other daily jobs stay queued. The test
    // profile fixes today (`demo.fixed_today`), which would replace the date of every run; these tests run without it.
    jobs = await createJobsApp(db, {
      queues: ['scheduler.tick', 'entitlement.expiry', 'notifications.dispatch'],
      imports: [NotificationsModule],
      env: { ...MULTI, MSCD__DEMO__FIXED_TODAY: 'null', MSCD__MAIL__SMTP__HOST: mail.host, MSCD__MAIL__SMTP__PORT: String(mail.smtpPort) },
    });
    const store = jobs.moduleRef.get(EntitlementStore);
    await jobs.moduleRef.get(TenantScope).withPlatform(
      async (trx) => {
        await store.write(trx, ending.id, values(), { reason: 'preset', actor: { userId: null, kind: 'operator' }, slug: 'exp_ending' });
        await store.write(trx, open.id, values({ plan: null, source: 'manual', validUntil: null }), { reason: 'limits', actor: { userId: null, kind: 'operator' }, slug: 'exp_open' });
      },
      { scope: 'operator' },
    );
  });
  afterAll(async () => {
    await jobs?.close();
    await mail?.stop();
  });

  it('runs at 06:15 local time once per organisation and date, and emails the operators and the Tenant Admins 30 days ahead', async () => {
    // 23:05 UTC on 14 January is 06:05 on 15 January in Jakarta: 30 days before 14 February.
    const runs = await tickAt('2030-01-14T23:05:00Z');
    const byOrg = (a: { org: string }, b: { org: string }) => a.org.localeCompare(b.org);
    expect([...runs].sort(byOrg)).toEqual(
      [
        { org: ending.id, localDate: '2030-01-15', key: `ee:${ending.id}:2030-01-15`, path: 'due' },
        { org: open.id, localDate: '2030-01-15', key: `ee:${open.id}:2030-01-15`, path: 'due' },
      ].sort(byOrg),
    );
    const ledger = await inPlatform(db, (trx) =>
      trx.selectFrom('platform.daily_job_run').select(['organization_id', 'local_date', 'scheduled_for']).where('job', '=', 'entitlement.expiry').orderBy('organization_id').execute(),
    );
    expect(ledger.map((r) => [r.local_date, r.scheduled_for.toISOString()])).toEqual([
      ['2030-01-15', '2030-01-14T23:15:00.000Z'],
      ['2030-01-15', '2030-01-14T23:15:00.000Z'],
    ]);
    expect(jobs.queue.completed('entitlement.expiry').map((j) => j.env.payload)).toEqual([{ localDate: '2030-01-15' }, { localDate: '2030-01-15' }]);
    expect(jobs.queue.failed()).toEqual([]);

    // One email to each active operator; none to a revoked or disabled one.
    for (const operator of operators) {
      const [message, ...more] = await waitForMails(expiryMails, operator.email, 1);
      expect(more).toEqual([]);
      expect(message!.subject).toBe('[MSCD] PT Ending: the standard plan ends in 30 days');
      expect(message!.text).toContain('(organisation exp_ending) is valid until 14 Feb 2030');
      expect(message!.text).toContain('grace period of 30 days');
      expect(message!.text).toContain('http://localhost:4174/ops');
    }
    expect(await expiryMails(revoked.email)).toEqual([]);
    expect(await expiryMails(disabled.email)).toEqual([]);

    // The Tenant Admin gets the notice and its email; a member gets nothing.
    expect(await notices(admin.id)).toEqual([
      { kind: 'licence_expiring', title_en: 'Licence expires in 30 days', body_en: 'The standard plan of this organisation is valid until 14 Feb 2030. Ask your MSCD service provider to renew it before then.' },
    ]);
    expect(await notices(member.id)).toEqual([]);
    const [adminMail] = await waitForMails(noticeMails, admin.email, 1);
    expect(adminMail!.subject).toContain('Licence expires in 30 days');
    // The organisation without an end date: nothing.
    expect((await mail.messages()).filter((m) => m.text.includes('PT Open'))).toEqual([]);

    // A second tick in the hour adds no run.
    expect(await tickAt('2030-01-14T23:20:00Z')).toEqual([]);
    for (const operator of operators) expect(await expiryMails(operator.email)).toHaveLength(1);
  });

  it('sends nothing on other days and works on the date of its run', async () => {
    // 16 January: 29 days.
    expect((await tickAt('2030-01-15T23:05:00Z')).filter((r) => r.org === ending.id).map((r) => r.localDate)).toEqual(['2030-01-16']);
    for (const operator of operators) expect(await expiryMails(operator.email)).toHaveLength(1);
    // A run with the date of its payload, whatever the clock says.
    const result = await jobs.moduleRef.get(EntitlementExpiryJob).run(ending.id, undefined, '2030-01-20');
    expect(result).toEqual({ today: '2030-01-20', days: 25, adminNotices: 0, operatorEmails: 0, operatorEmailsFailed: 0, handedBack: false });
    expect(await jobs.moduleRef.get(EntitlementExpiryJob).run(open.id, undefined, '2030-01-20')).toEqual({
      today: '2030-01-20',
      days: null,
      adminNotices: 0,
      operatorEmails: 0,
      operatorEmailsFailed: 0,
      handedBack: false,
    });
  });

  it('emails the operators and the Tenant Admins 7 days ahead, and only the operators 1 day ahead', async () => {
    // 7 February at 06:05 in Jakarta: 7 days. The tick deleted the ledger rows older than 14 days, so the runs of the
    // days before are not caught up.
    const seventh = (await tickAt('2030-02-06T23:05:00Z')).filter((r) => r.org === ending.id);
    expect(seventh.map((r) => [r.localDate, r.path])).toEqual([['2030-02-07', 'due']]);
    for (const operator of operators) {
      const mails = await waitForMails(expiryMails, operator.email, 2);
      expect(mails.map((m) => m.subject)).toEqual(['[MSCD] PT Ending: the standard plan ends in 30 days', '[MSCD] PT Ending: the standard plan ends in 7 days']);
    }
    expect((await notices(admin.id)).map((n) => n.title_en)).toEqual(['Licence expires in 30 days', 'Licence expires in 7 days']);
    await waitForMails(noticeMails, admin.email, 2);

    // 13 February at 06:05: the run of 12 February (2 days) is caught up first; the run of the day (1 day) at the
    // next tick. The operators get their third email; the Tenant Admin no new notice.
    expect((await tickAt('2030-02-12T23:05:00Z')).filter((r) => r.org === ending.id).map((r) => [r.localDate, r.path])).toEqual([['2030-02-12', 'catch-up']]);
    for (const operator of operators) expect(await expiryMails(operator.email)).toHaveLength(2);
    expect((await tickAt('2030-02-13T00:05:00Z')).filter((r) => r.org === ending.id).map((r) => [r.localDate, r.path])).toEqual([['2030-02-13', 'catch-up']]);
    for (const operator of operators) {
      const mails = await waitForMails(expiryMails, operator.email, 3);
      expect(mails.at(-1)!.subject).toBe('[MSCD] PT Ending: the standard plan ends in 1 day');
    }
    expect(await notices(admin.id)).toHaveLength(2);
    expect(await noticeMails(admin.email)).toHaveLength(2);
    expect(jobs.queue.failed()).toEqual([]);
  });

  it('sends nothing once the entitlement is past its last day', async () => {
    // 14 February (the last day, 0 days) and 15 February (in grace).
    await tickAt('2030-02-13T23:05:00Z');
    await tickAt('2030-02-14T23:05:00Z');
    await tickAt('2030-02-15T00:05:00Z');
    const ran = jobs.queue.completed('entitlement.expiry').filter((j) => j.env.orgId === ending.id).map((j) => (j.env.payload as { localDate: string }).localDate);
    expect(ran).toEqual(expect.arrayContaining(['2030-02-14', '2030-02-15']));
    for (const operator of operators) expect(await expiryMails(operator.email)).toHaveLength(3);
    expect(await notices(admin.id)).toHaveLength(2);
  });
});

describe('entitlement.expiry when the mail server fails (Milestone 2 M2-S10)', () => {
  const db = useTestDatabase('empty');
  let jobs: JobsApp;
  let org: CreatedTenant;
  let admin: Person;
  let operators: Person[];
  let send: MockInstance<(mail: AccountMail) => Promise<boolean>>;

  const tickAt = async (at: string) => {
    jobs.setNow(at);
    const result = await jobs.moduleRef.get(SchedulerTickJob).tick();
    await jobs.drain();
    return result.enqueued.filter((e) => e.name === 'entitlement.expiry').map((e) => ({ localDate: e.localDate, path: e.path }));
  };
  /** The operator emails the job tried to send for `days`, as [address, days]. */
  const attempts = (days: number) =>
    send.mock.calls
      .map(([mail]) => mail)
      .filter((mail) => mail.template.name === 'entitlement_expiring' && mail.template.days === days)
      .map((mail) => mail.to.email);
  const ledgerDates = async () =>
    (
      await inPlatform(db, (trx) =>
        trx.selectFrom('platform.daily_job_run').select('local_date').where('organization_id', '=', org.id).where('job', '=', 'entitlement.expiry').orderBy('local_date').execute(),
      )
    ).map((r) => r.local_date);
  const notices = () => inTenant(db, org, (trx) => trx.selectFrom('notification').select('title_en').where('recipient_user_id', '=', admin.id).orderBy('created_at').execute());

  beforeAll(async () => {
    org = await createTenant(db, 'exp_mailfail', { name: 'PT Mail Fail', timeZone: 'Asia/Jakarta' });
    admin = await addPerson(db, 'mailfail.admin', [{ org, adminRoles: ['tenant_admin'] }], { domain: 'mailfail.test' });
    operators = [
      await addPerson(db, 'ops.one', [], { platformOperator: true, domain: 'operator.test' }),
      await addPerson(db, 'ops.two', [], { platformOperator: true, domain: 'operator.test' }),
    ];
    jobs = await createJobsApp(db, { queues: ['scheduler.tick', 'entitlement.expiry'], env: { ...MULTI, MSCD__DEMO__FIXED_TODAY: 'null' } });
    // The job's mailer: every send is recorded and answers what the test sets (false: the server could not be reached).
    send = vi.spyOn(jobs.moduleRef.get(AccountMailer, { strict: false }), 'send');
    await jobs.moduleRef
      .get(TenantScope)
      .withPlatform((trx) => jobs.moduleRef.get(EntitlementStore).write(trx, org.id, values(), { reason: 'preset', actor: { userId: null, kind: 'operator' }, slug: 'exp_mailfail' }), {
        scope: 'operator',
      });
  });
  afterAll(async () => {
    send?.mockRestore();
    await jobs?.close();
  });

  it('hands the run back to the tick when no operator email could be sent, and the next tick sends each email once', async () => {
    send.mockResolvedValue(false);
    // The run of the day before (31 days, no email) gives the ledger an earlier row of the organisation, which the
    // planner needs before it catches a run up. In a full worker the daily jobs before 06:15 (`license.check` at
    // 00:05) write such rows every day; this application handles only the expiry job.
    expect(await tickAt('2030-01-13T23:05:00Z')).toEqual([{ localDate: '2030-01-14', path: 'due' }]);
    expect(send).not.toHaveBeenCalled();
    // 06:05 on 15 January in Jakarta: 30 days ahead. Both sends fail, so the run's ledger row is deleted.
    expect(await tickAt('2030-01-14T23:05:00Z')).toEqual([{ localDate: '2030-01-15', path: 'due' }]);
    expect(attempts(30).sort()).toEqual(operators.map((o) => o.email).sort());
    expect(await ledgerDates()).toEqual(['2030-01-14']);
    expect(jobs.queue.failed()).toEqual([]);
    expect(await notices()).toEqual([{ title_en: 'Licence expires in 30 days' }]);

    // The mail server is back. The tick of the next hour catches the run up on the same date; each operator gets the
    // email once, and the Tenant Admin gets no second notice.
    send.mockResolvedValue(true);
    expect(await tickAt('2030-01-15T00:05:00Z')).toEqual([{ localDate: '2030-01-15', path: 'catch-up' }]);
    expect(attempts(30)).toHaveLength(4);
    expect(attempts(30).slice(2).sort()).toEqual(operators.map((o) => o.email).sort());
    expect(await ledgerDates()).toEqual(['2030-01-14', '2030-01-15']);
    expect(await notices()).toHaveLength(1);

    // The run is done: the following tick adds nothing.
    expect(await tickAt('2030-01-15T01:05:00Z')).toEqual([]);
    expect(attempts(30)).toHaveLength(4);
  });

  it('keeps the run when some operator emails were sent, so nobody gets one twice', async () => {
    const [first] = operators;
    send.mockImplementation(async (mail) => mail.to.email !== first!.email);
    // 06:05 on 7 February: 7 days ahead. One send fails, one is sent.
    expect(await tickAt('2030-02-06T23:05:00Z')).toEqual([{ localDate: '2030-02-07', path: 'due' }]);
    expect(attempts(7).sort()).toEqual(operators.map((o) => o.email).sort());
    expect(await ledgerDates()).toEqual(['2030-02-07']);
    expect(await tickAt('2030-02-07T00:05:00Z')).toEqual([]);
    expect(attempts(7)).toHaveLength(2);
    expect(jobs.queue.failed()).toEqual([]);
  });

  it('reports the failed sends in the result of a run', async () => {
    send.mockResolvedValue(false);
    expect(await jobs.moduleRef.get(EntitlementExpiryJob).run(org.id, undefined, '2030-02-13')).toEqual({
      today: '2030-02-13',
      days: 1,
      adminNotices: 0,
      operatorEmails: 0,
      operatorEmailsFailed: 2,
      handedBack: true,
    });
    send.mockImplementation(async (mail) => mail.to.email !== operators[0]!.email);
    expect(await jobs.moduleRef.get(EntitlementExpiryJob).run(org.id, undefined, '2030-02-13')).toEqual({
      today: '2030-02-13',
      days: 1,
      adminNotices: 0,
      operatorEmails: 1,
      operatorEmailsFailed: 1,
      handedBack: false,
    });
  });
});

describe('entitlement.expiry in single tenancy', () => {
  const db = useTestDatabase('empty');
  let jobs: JobsApp;

  beforeAll(async () => {
    await createTenant(db, 'exp_single', { timeZone: 'Asia/Jakarta' });
    jobs = await createJobsApp(db, { queues: ['scheduler.tick'], env: { MSCD__DEMO__FIXED_TODAY: 'null' } });
  });
  afterAll(async () => {
    await jobs?.close();
  });

  it('has no handler, so the tick schedules no run', async () => {
    expect(jobs.moduleRef.get(EntitlementExpiryJob, { strict: false })).toBeNull();
    jobs.setNow('2030-01-14T23:05:00Z');
    const result = await jobs.moduleRef.get(SchedulerTickJob).tick();
    expect(result.enqueued.filter((e) => e.name === 'entitlement.expiry')).toEqual([]);
    const rows = await inPlatform(db, (trx) => trx.selectFrom('platform.daily_job_run').select('job').where('job', '=', 'entitlement.expiry').execute());
    expect(rows).toEqual([]);
  });
});
