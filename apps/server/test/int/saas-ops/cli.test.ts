// The operator commands of the organisation lifecycle (Milestone 2 K.6, M2-S09): `tenant list`, `tenant show`,
// `tenant set-status` and `tenant onboard` through the services of the operator routes in a command context (actor kind
// `operator`, no user), with their output and their refusals, and `diagnostics --out`, the redacted archive of
// `POST /ops/diagnostics` written without the api, also when the database cannot be reached.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import type { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeDiagnostics } from '../../../src/cli/diagnostics';
import {
  createOpsCliContext, formatDetail, formatList, formatOnboard, formatStatusChange, summaryOfList, tenantList, tenantOnboard, tenantSetStatus, tenantShow,
} from '../../../src/cli/tenant';
import type { MscdConfig } from '../../../src/config/mscd-config';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { TenantDataKeys } from '../../../src/modules/ops/tenant-data-keys';
import { buildProgram } from '../../../src/program';
import { createTenant, TestDataKeyIssuer } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { startMailpit, type Mailpit } from '../identity/helpers';
import { addPerson, inPlatform, platformAudit, type Person } from '../onboarding/helpers';
import { MULTI, PLANS, eventsOf, statusOf } from './helpers';

/** A command context whose organisations get their data key from a local issuer instead of the storage gateway. */
async function cliContext(config: MscdConfig): Promise<INestApplicationContext> {
  const context = await createOpsCliContext(config);
  context.get(TenantDataKeys, { strict: false }).open = () => ({ issuer: new TestDataKeyIssuer(), close: async () => undefined });
  return context;
}

describe('operator commands of the organisation lifecycle (Milestone 2 K.6, M2-S09)', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let config: MscdConfig;
  let context: INestApplicationContext;
  let kappa: CreatedTenant;
  let kappaAdmin: Person;

  beforeAll(async () => {
    mail = await startMailpit();
    config = db.config({ ...MULTI, ...PLANS, MSCD__TENANCY__DEFAULT_REGION: 'id-jkt', MSCD__MAIL__SMTP__HOST: mail.host, MSCD__MAIL__SMTP__PORT: String(mail.smtpPort) }, 'cli');
    context = await cliContext(config);
    kappa = await createTenant(db, 'kappa', { name: 'PT Kappa' });
    kappaAdmin = await addPerson(db, 'kappa.admin', [{ org: kappa, adminRoles: ['tenant_admin'] }], { password: true });
  });
  afterAll(async () => {
    await context?.close();
    await mail?.stop();
  });

  it('registers list, show, set-status and onboard under tenant, and diagnostics with --out', () => {
    const program = buildProgram();
    const tenant = program.commands.find((c) => c.name() === 'tenant') as Command;
    expect(tenant.commands.map((c) => c.name())).toEqual(['create', 'verify-domain', 'list', 'show', 'set-status', 'onboard', 'deletion', 'purge', 'verify-certificate']);
    const flags = (name: string) => tenant.commands.find((c) => c.name() === name)!.options.map((o) => o.long);
    expect(flags('set-status')).toEqual(['--org', '--status', '--reason', '--confirm', '--json']);
    expect(flags('onboard')).toEqual(['--slug', '--name', '--time-zone', '--site-count', '--admin-email', '--admin-name', '--preset', '--json']);
    expect(flags('list')).toEqual(['--status', '--summary', '--json']);
    expect(flags('show')).toEqual(['--org', '--summary', '--json']);
    const diagnostics = program.commands.find((c) => c.name() === 'diagnostics')!;
    expect(diagnostics.options.map((o) => o.long)).toEqual(['--out', '--force']);
  });

  describe('tenant onboard', () => {
    it('creates the organisation in the region of the profile with its plan preset and emails the invitation', async () => {
      const result = await tenantOnboard(
        config,
        { slug: 'lambda', name: 'PT Lambda', timeZone: 'asia/jakarta', siteCount: '2', adminEmail: 'first@lambda.test', adminName: 'First Admin', preset: 'standard' },
        context,
      );
      expect(result.data).toMatchObject({ slug: 'lambda', invitationSent: true, plan: { name: 'standard' } });
      expect(result.data.invitationUrl).toBeUndefined();
      const lines = formatOnboard(result, { adminEmail: 'first@lambda.test' });
      expect(lines[0]).toBe(`tenant onboard: organisation lambda (${result.data.id}) created; the slug cannot be changed`);
      expect(lines).toContain('Invitation sent to first@lambda.test');
      expect(lines.join('\n')).not.toContain('/invite');
      expect(lines.find((l) => l.startsWith('Plan: standard from '))).toBeDefined();

      const row = await inPlatform(db, (trx) =>
        trx.selectFrom('platform.organization').select(['region', 'local_login', 'time_zone', 'site_count']).where('slug', '=', 'lambda').executeTakeFirstOrThrow(),
      );
      expect(row).toEqual({ region: 'id-jkt', local_login: 'allowed', time_zone: 'Asia/Jakarta', site_count: 2 });
      const entitlement = await inPlatform(db, (trx) => trx.selectFrom('platform.entitlement').select(['plan', 'source', 'max_users']).where('organization_id', '=', result.data.id).executeTakeFirst());
      expect(entitlement).toEqual({ plan: 'standard', source: 'preset', max_users: 50 });
      await mail.waitFor('first@lambda.test', (m) => m.mailKind === 'account:invitation');
      // The audit entries of a command: actor kind operator without a user.
      const created = (await platformAudit(db, 'ops.organization_created')).find((e) => e.entity_code === 'lambda');
      expect(created).toMatchObject({ actor_kind: 'operator', actor_user_id: null, after_data: expect.objectContaining({ region: 'id-jkt', preset: 'standard' }) });
      const changed = (await platformAudit(db, 'ops.entitlements_changed')).find((e) => e.entity_code === 'lambda');
      expect(changed).toMatchObject({ actor_kind: 'operator', actor_user_id: null });
      expect((await platformAudit(db, 'tenant.created')).find((e) => e.entity_code === 'lambda')).toMatchObject({ actor_kind: 'operator', actor_user_id: null });
    });

    it('refuses before anything is created: values, an unknown preset, a taken slug, and mail required but not working', async () => {
      const base = { slug: 'mu', name: 'PT Mu', timeZone: 'Asia/Jakarta', siteCount: '1', adminEmail: 'admin@mu.test', adminName: 'Admin Mu' };
      await expect(tenantOnboard(config, { ...base, siteCount: 'two' }, context)).rejects.toThrow(/--site-count must be a whole number/);
      await expect(tenantOnboard(config, { ...base, slug: 'Mu' }, context)).rejects.toMatchObject({ extras: { errors: [expect.objectContaining({ path: '--slug' })] } });
      await expect(tenantOnboard(config, { ...base, adminEmail: 'not-mail' }, context)).rejects.toMatchObject({
        extras: { errors: [expect.objectContaining({ path: '--admin-email' })] },
      });
      await expect(tenantOnboard(config, { ...base, preset: 'enterprise' }, context)).rejects.toMatchObject({ extras: { messageKey: 'unknown_preset' } });
      await expect(tenantOnboard(config, { ...base, slug: 'kappa' }, context)).rejects.toMatchObject({ extras: { messageKey: 'org_exists' } });

      const strictConfig = db.config({ ...MULTI, ...PLANS, MSCD__MAIL__REQUIRED: 'true', MSCD__MAIL__SMTP__PORT: '9' }, 'cli');
      const strict = await cliContext(strictConfig);
      try {
        await expect(tenantOnboard(strictConfig, base, strict)).rejects.toMatchObject({ extras: { messageKey: 'mail_required' } });
      } finally {
        await strict.close();
      }
      const row = await inPlatform(db, (trx) => trx.selectFrom('platform.organization').select('id').where('slug', '=', 'mu').executeTakeFirst());
      expect(row).toBeUndefined();
    });

    it('prints the one-time link only when mail is neither required nor working', async () => {
      const offConfig = db.config({ ...MULTI, ...PLANS, MSCD__MAIL__SMTP__PORT: '9' }, 'cli');
      const off = await cliContext(offConfig);
      try {
        const result = await tenantOnboard(offConfig, { slug: 'nu', name: 'PT Nu', timeZone: 'Asia/Jakarta', siteCount: '1', adminEmail: 'admin@nu.test', adminName: 'Admin Nu' }, off);
        expect(result.data.invitationSent).toBe(false);
        const lines = formatOnboard(result, { adminEmail: 'admin@nu.test' });
        expect(lines[1]).toContain('Mail is not configured');
        expect(lines[2]).toMatch(/^http.*\/invite#token=/);
      } finally {
        await off.close();
      }
    });

    it('is refused in single tenancy', async () => {
      const singleConfig = db.config({ MSCD__MAIL__SMTP__PORT: '9' }, 'cli');
      await expect(
        tenantOnboard(singleConfig, { slug: 'xi', name: 'PT Xi', timeZone: 'Asia/Jakarta', siteCount: '1', adminEmail: 'admin@xi.test', adminName: 'Admin Xi' }),
      ).rejects.toMatchObject({ extras: { messageKey: 'single_tenancy' } });
    });
  });

  describe('tenant set-status', () => {
    it('moves the organisation with the event, the audit entry and the email, as the route does', async () => {
      const result = await tenantSetStatus(config, { org: 'kappa', status: 'suspended', reason: 'Invoice overdue by 60 days' }, context);
      expect(result.data).toEqual({ slug: 'kappa', from: 'active', to: 'suspended', sessionsRevoked: 0, tenantAdmins: 1, tenantAdminsEmailed: 1 });
      expect(formatStatusChange(result)).toEqual([
        'tenant set-status: organisation kappa moved from active to suspended',
        'Sessions ended:      0',
        'Tenant Admins told:  1 of 1 by email',
      ]);
      expect(await statusOf(db, kappa.id)).toBe('suspended');
      expect(await eventsOf(db, kappa.id)).toEqual([expect.objectContaining({ from_status: 'active', to_status: 'suspended', reason: 'Invoice overdue by 60 days', actor_user_id: null })]);
      expect((await platformAudit(db, 'ops.organization_status_changed')).filter((e) => e.organization_id === kappa.id)).toEqual([
        expect.objectContaining({ actor_kind: 'operator', actor_user_id: null, entity_code: 'kappa' }),
      ]);
      await mail.waitFor(kappaAdmin.email, (m) => m.mailKind === 'account:organization_status_changed');
    });

    it('refuses moves outside the machine, a missing confirmation and bad values with the route messages', async () => {
      await expect(tenantSetStatus(config, { org: 'kappa', status: 'archived', reason: 'Too early' }, context)).rejects.toMatchObject({
        extras: { messageKey: 'invalid_status_transition' },
      });
      await expect(tenantSetStatus(config, { org: 'kappa', status: 'offboarding', reason: 'Contract ended', confirm: 'other' }, context)).rejects.toMatchObject({
        extras: { messageKey: 'confirmation_mismatch' },
      });
      await expect(tenantSetStatus(config, { org: 'kappa', status: 'paused', reason: 'Bad status' }, context)).rejects.toMatchObject({
        extras: { errors: [expect.objectContaining({ path: '--status' })] },
      });
      await expect(tenantSetStatus(config, { org: 'kappa', status: 'active', reason: 'x' }, context)).rejects.toMatchObject({
        extras: { errors: [expect.objectContaining({ path: '--reason' })] },
      });
      await expect(tenantSetStatus(config, { org: 'kappa', status: 'offboarding', reason: 'Contract ended', confirm: 'Bad Slug' }, context)).rejects.toMatchObject({
        extras: { errors: [expect.objectContaining({ path: '--confirm' })] },
      });
      await expect(tenantSetStatus(config, { org: 'nobody', status: 'active', reason: 'Unknown' }, context)).rejects.toThrow(/Unknown organisation nobody/);
      expect(await statusOf(db, kappa.id)).toBe('suspended');
      // A context of its own (no context given): the command builds and closes it.
      const result = await tenantSetStatus(config, { org: 'kappa', status: 'offboarding', reason: 'Contract ended', confirm: 'kappa' });
      expect(result.data).toMatchObject({ from: 'suspended', to: 'offboarding' });
    });

    it('is refused in single tenancy', async () => {
      const org = await createTenant(db, 'single_one', { name: 'Single One' });
      const singleConfig = db.config({ MSCD__MAIL__SMTP__PORT: '9' }, 'cli');
      await expect(tenantSetStatus(singleConfig, { org: 'single_one', status: 'suspended', reason: 'Single tenancy' })).rejects.toMatchObject({
        extras: { messageKey: 'single_tenancy' },
      });
      expect(await statusOf(db, org.id)).toBe('active');
    });
  });

  describe('tenant list and tenant show', () => {
    it('lists slug, id, status, plan, valid until and members, and counts per status with --summary', async () => {
      const items = await tenantList(config, {}, context);
      const lambda = items.find((o) => o.slug === 'lambda')!;
      expect(lambda).toMatchObject({ status: 'active', plan: 'standard', memberCount: 0 });
      expect(items.find((o) => o.slug === 'kappa')).toMatchObject({ status: 'offboarding', plan: null, memberCount: 1 });
      const lines = formatList(items);
      expect(lines[0]).toMatch(/^SLUG +ID +STATUS +PLAN +VALID UNTIL +MEMBERS$/);
      expect(lines.find((l) => l.startsWith('lambda '))).toMatch(new RegExp(`^lambda +${lambda.id} +active +standard +${lambda.validUntil} +0$`));
      expect(summaryOfList(items)).toEqual([`${items.length} organisations: ${items.filter((o) => o.status === 'active').length} active, 1 offboarding`]);
      expect(summaryOfList(items).join('\n')).not.toContain('lambda');
      const offboarding = await tenantList(config, { status: 'offboarding' }, context);
      expect(offboarding.map((o) => o.slug)).toEqual(['kappa']);
      await expect(tenantList(config, { status: 'paused' }, context)).rejects.toThrow(/--status must be one of/);
      expect(formatList([])).toEqual(['No organisation exists yet. Create one with "mscd-server tenant onboard" (or "tenant create").']);
    });

    it('shows one organisation with its status history, and only states and counts with --summary', async () => {
      await inPlatform(db, (trx) => trx.insertInto('platform.verified_domain').values({ organization_id: kappa.id, domain: 'kappa.co.id', verified_by: 'test', verified_at: new Date() }).execute());
      const shown = await tenantShow(config, { org: 'kappa' }, context);
      expect(shown.organization).toMatchObject({ slug: 'kappa', name: 'PT Kappa', status: 'offboarding', memberCount: 1, entitlement: null, domains: [{ domain: 'kappa.co.id', status: 'verified' }] });
      expect(shown.eventCount).toBe(2);
      expect(shown.events.map((e) => `${e.from}>${e.to}`)).toEqual(['suspended>offboarding', 'active>suspended']);
      const full = formatDetail(shown).join('\n');
      expect(full).toContain('Organisation:        PT Kappa (kappa)');
      expect(full).toContain('Email domains:       kappa.co.id (verified)');
      expect(full).toContain('suspended to offboarding  by the operator command line: Contract ended');
      const summary = formatDetail(shown, true).join('\n');
      expect(summary).toContain('Status:              offboarding');
      expect(summary).toContain('Email domains:       1 verified');
      for (const hidden of ['PT Kappa', 'kappa.co.id', 'Contract ended', 'Invoice overdue']) expect(summary).not.toContain(hidden);
      await expect(tenantShow(config, { org: 'nobody' }, context)).rejects.toThrow(/Unknown organisation nobody/);
    });

    it('reads in single tenancy as well', async () => {
      const singleConfig = db.config({ MSCD__MAIL__SMTP__PORT: '9' }, 'cli');
      const items = await tenantList(singleConfig);
      expect(items.map((o) => o.slug)).toContain('kappa');
      const shown = await tenantShow(singleConfig, { org: 'kappa' });
      expect(shown.organization.slug).toBe('kappa');
    });
  });

  describe('diagnostics', () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'm2-s09-diagnostics-'));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const listArchive = (file: string) => execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
    const readArchive = (file: string, name: string) => execFileSync('tar', ['-xzOf', file, '--wildcards', `*/${name}`], { encoding: 'utf8' });

    it('writes the redacted archive of POST /ops/diagnostics with mode 0600 and audits it', async () => {
      const file = path.join(dir, 'archive.tar.gz');
      const written = await writeDiagnostics(config, { out: file });
      expect(written).toMatchObject({ file, audited: true, auditError: null });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const names = listArchive(file).map((n) => n.replace(/^[^/]+\//, ''));
      expect(names).toEqual(['', 'README.txt', 'profile.json', 'versions.json', 'migrations.json', 'queues.json', 'health.json', 'logs.ndjson', 'metrics.txt']);
      expect(readArchive(file, 'README.txt')).toContain('by run mode cli');
      const health = JSON.parse(readArchive(file, 'health.json')) as { components: { name: string; status: string }[] };
      expect(health.components.find((c) => c.name === 'database')).toMatchObject({ status: 'ok' });
      // No secret value: the database URLs carry passwords, which the scrubber and the URL rule remove.
      const all = execFileSync('tar', ['-xzOf', file], { encoding: 'utf8' });
      expect(all).not.toContain('app-dev');
      expect(all).not.toContain('migrator-dev');
      const audit = (await platformAudit(db, 'ops.diagnostics_exported')).at(-1);
      expect(audit).toMatchObject({ actor_kind: 'operator', actor_user_id: null, after_data: expect.objectContaining({ sha256: written.archive.sha256, via: 'cli' }) });

      // An existing file is kept unless --force.
      await expect(writeDiagnostics(config, { out: file })).rejects.toThrow(/exists; choose another name or add --force/);
      await expect(writeDiagnostics(config, { out: dir })).rejects.toThrow(/is a folder/);
      await expect(writeDiagnostics(config, { out: path.join(dir, 'missing', 'a.tar.gz') })).rejects.toThrow(/does not exist/);
      const forced = await writeDiagnostics(config, { out: file, force: true });
      expect(createHash('sha256').update(await readFile(file)).digest('hex')).toBe(forced.archive.sha256);
    });

    it('writes to standard output with --out -, and still writes when the database cannot be reached', async () => {
      const chunks: Buffer[] = [];
      const piped = await writeDiagnostics(config, { out: '-' }, undefined, async (data) => {
        chunks.push(data);
      });
      expect(piped.file).toBeNull();
      expect(Buffer.concat(chunks).equals(piped.archive.data)).toBe(true);

      const down = db.config({ ...MULTI, MSCD_DATABASE_URL: 'postgres://mscd_app:wrong-secret@127.0.0.1:9/mscd' }, 'cli');
      const file = path.join(dir, 'offline.tar.gz');
      const offline = await writeDiagnostics(down, { out: file });
      expect(offline.audited).toBe(false);
      expect(offline.auditError).toBeTruthy();
      const health = JSON.parse(readArchive(file, 'health.json')) as { components: { name: string; status: string }[] };
      expect(health.components.find((c) => c.name === 'database')).toMatchObject({ status: 'down' });
      expect(execFileSync('tar', ['-xzOf', file], { encoding: 'utf8' })).not.toContain('wrong-secret');
    });
  });
});
