import { Global, Module, type DynamicModule, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  OpsOrganizationCreate,
  OrganizationStatusChange,
  ORGANIZATION_STATUSES,
  MAX_PAGE_SIZE,
  type OpsOrganizationCreateResult,
  type OpsOrganizationDetail,
  type OpsOrganizationItem,
  type OrganizationStatus,
  type OrganizationStatusChangeResult,
  type OrganizationStatusEventItem,
} from '@mscd/shared';
import type { Command } from 'commander';
import { sql } from 'kysely';
import type { ZodType } from 'zod';
import { ProblemError, ValidationError } from '../common/problems';
import { ConfigModule } from '../config/config.module';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { DatabaseModule } from '../db/database.module';
import { createKysely } from '../db/kysely';
import { AuditModule } from '../modules/audit/audit.module';
import { AuthzModule } from '../modules/authz/authz.module';
import { IdentityModule } from '../modules/identity/identity.module';
import { KeysModule } from '../modules/keys/keys.module';
import { LicenseModule } from '../modules/license/license.module';
import { DiagnosticsService } from '../modules/ops/diagnostics.service';
import { OpsMetricsCollector } from '../modules/ops/ops-metrics.collector';
import { OpsService } from '../modules/ops/ops.service';
import { OrganizationStatusService } from '../modules/ops/organization-status.service';
import { CLI_OPERATOR, OpsOrganizationsService } from '../modules/ops/organizations.service';
import { TenantDataKeys } from '../modules/ops/tenant-data-keys';
import { MetricsService } from '../modules/platform/metrics';
import { ReadinessService } from '../modules/platform/readiness.service';
import { TenancyModule } from '../modules/tenancy/tenancy.module';
import {
  GatewayDataKeyIssuer,
  gatewayDataKeyIssuer,
  TenantProvisioner,
  TenantProvisioningError,
  verifyTenantDomain,
  type CreatedTenant,
  type DataKeyIssuer,
  type VerifiedDomain,
} from '../db/tenant-provisioner';

/**
 * `tenant create` and `tenant verify-domain` (D-01, C.8, D-25). Both run as mscd_migrator with platform scope.
 * `tenant create --if-missing` succeeds without changes when the slug exists (Milestone 2 M2-06, Helm admin Job).
 *
 * The organisation lifecycle of the platform operator (Milestone 2 K.6, M2-S09), through the services of the operator
 * routes, with actor kind `operator` and no user:
 * - `tenant list` (slug, id, status, plan, valid until, members) and `tenant show --org <slug>` read like
 *   `GET /ops/organizations` and `GET /ops/organizations/{org}` (also in single tenancy, where the routes answer 409);
 *   `--summary` prints counts only, for logs that others can read (saas-ops.sh, ops-cli.yml).
 * - `tenant set-status --org <slug> --status <status> --reason <text> [--confirm <slug>]` is
 *   `POST /ops/organizations/{org}/status`: the machine of J.8, the status event, the audit entry, the sessions of a
 *   suspended or archived organisation, the change notice and the email to the Tenant Admins. Multi tenancy only.
 * - `tenant onboard --slug --name --time-zone --site-count --admin-email --admin-name [--preset <name>]` is
 *   `POST /ops/organizations`: `tenant create` in the region of `tenancy.default_region`, the plan preset and the
 *   invitation of the first administrator in one step, with the mail rule of `admin create-operator` (with
 *   `mail.required` nothing is created while SMTP does not work, and no invitation link is printed). Multi tenancy only.
 * Every command exits 1 with one line on stderr when it is refused; `--json` prints the answer of the matching route.
 */
export function register(program: Command): void {
  const tenant = program.command('tenant').description('Organisation (tenant) administration');
  tenant
    .command('create')
    .description(
      'Create an organisation with its schema, tenant migrations, data key (from the storage gateway) and Managed Vault repository',
    )
    .requiredOption('--slug <slug>', 'organisation slug (schema org_<slug>), permanent: a lower-case letter, then letters, digits or _')
    .requiredOption('--name <name>', 'display name')
    .option('--id <uuid>', 'fixed organisation id (for licences bound to it)')
    .option('--time-zone <zone>', 'IANA time zone of the organisation local dates', 'Asia/Jakarta')
    .option('--site-count <n>', 'number of sites', '1')
    .option('--demo-deploy-label <label>', 'demo installs only: show the organisation as saas or onprem (D-20)')
    .option('--if-missing', 'succeed without changes when an organisation with this slug exists (for jobs that may run again)')
    .action(async (options: TenantCreateOptions & { ifMissing?: boolean }) => {
      await runCommand('tenant create', async (config) => {
        const outcome = options.ifMissing ? await tenantCreateIfMissing(config, options) : { created: await tenantCreate(config, options) };
        if (outcome.existing) {
          const found = outcome.existing;
          process.stdout.write(
            `tenant create: organisation ${found.slug} (${found.id}) already exists with the name "${found.name}" ` +
              `and the status ${found.status}; nothing changed (--if-missing)\n`,
          );
          return;
        }
        const created = outcome.created;
        process.stdout.write(
          `tenant create: organisation ${created.slug} (${created.id}) created: schema ${created.schemaName}, ` +
            `${created.migrations.length} tenant migrations, data key ${created.kekId}, ` +
            `Managed Vault repository ${created.vaultRepositoryId}\n`,
        );
      });
    });
  tenant
    .command('verify-domain')
    .description('Record an email domain as verified for an organisation (needed for JIT provisioning, D-25)')
    .requiredOption('--org <slug>', 'organisation slug')
    .requiredOption('--domain <domain>', 'email domain')
    .requiredOption('--by <name>', 'who verified it')
    .action(async (options: TenantVerifyDomainOptions) => {
      await runCommand('tenant verify-domain', async (config) => {
        const result = await tenantVerifyDomain(config, options);
        process.stdout.write(
          result.created
            ? `tenant verify-domain: ${result.domain} is now verified for organisation ${options.org}\n`
            : `tenant verify-domain: ${result.domain} was already verified for organisation ${options.org}; nothing changed\n`,
        );
      });
    });
  registerLifecycle(tenant);
}

/** `tenant list`, `show`, `set-status` and `onboard` (Milestone 2 K.6, M2-S09). */
function registerLifecycle(tenant: Command): void {
  tenant
    .command('list')
    .description('List the organisations: slug, id, status, plan, valid until and active members')
    .option('--status <status>', `only organisations with this status (${ORGANIZATION_STATUSES.join(', ')})`)
    .option('--summary', 'print only the number of organisations per status (no slugs or names)')
    .option('--json', 'print the organisations as JSON, as GET /api/v1/ops/organizations lists them')
    .action(async (options: TenantListOptions) => {
      await runCommand('tenant list', async (config) => {
        const items = await tenantList(config, options);
        if (options.json) process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
        else process.stdout.write(`${(options.summary ? summaryOfList(items) : formatList(items)).join('\n')}\n`);
      });
    });
  tenant
    .command('show')
    .description('Show one organisation: status, region, members, systems, plan, email domains, last sign-in and status history')
    .requiredOption('--org <slug>', 'organisation slug')
    .option('--summary', 'print counts and states only (no name, domains, reasons or people)')
    .option('--json', 'print the organisation and its status history as JSON, as the operator routes answer them')
    .action(async (options: TenantShowOptions) => {
      await runCommand('tenant show', async (config) => {
        const shown = await tenantShow(config, options);
        if (options.json) process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
        else process.stdout.write(`${formatDetail(shown, options.summary === true).join('\n')}\n`);
      });
    });
  tenant
    .command('set-status')
    .description('Move an organisation to another status (active, suspended, offboarding, archived) with a reason')
    .requiredOption('--org <slug>', 'organisation slug')
    .requiredOption('--status <status>', `new status: ${ORGANIZATION_STATUSES.join(', ')}`)
    .requiredOption('--reason <text>', 'why (3 to 500 characters); the Tenant Admins of the organisation get it by email, so name no person')
    .option('--confirm <slug>', 'the slug again: needed for offboarding and archived')
    .option('--json', 'print the result as JSON, as POST /api/v1/ops/organizations/{org}/status answers it')
    .addHelpText(
      'after',
      [
        '',
        'Allowed moves: active to suspended or offboarding; suspended to active or offboarding; offboarding to active',
        'or archived. archived is final. suspended and archived end every session in the organisation; its people keep',
        'their other memberships. The Tenant Admins get an email with the new status and the reason.',
      ].join('\n'),
    )
    .action(async (options: TenantSetStatusOptions) => {
      await runCommand('tenant set-status', async (config) => {
        const result = await tenantSetStatus(config, options);
        if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else process.stdout.write(`${formatStatusChange(result).join('\n')}\n`);
      });
    });
  tenant
    .command('onboard')
    .description('Create an organisation with its plan preset and invite its first administrator by email, in one step')
    .requiredOption('--slug <slug>', 'organisation slug (schema org_<slug>), permanent: a lower-case letter, then letters, digits or _')
    .requiredOption('--name <name>', 'display name of the organisation')
    .requiredOption('--time-zone <zone>', 'IANA time zone of the organisation local dates, for example Asia/Jakarta')
    .requiredOption('--site-count <n>', 'number of sites')
    .requiredOption('--admin-email <email>', 'email address of the first administrator (Tenant Admin)')
    .requiredOption('--admin-name <name>', 'display name of the first administrator')
    .option('--preset <name>', 'plan preset of license.plans, for example trial or standard')
    .option('--json', 'print the result as JSON, as POST /api/v1/ops/organizations answers it')
    .action(async (options: TenantOnboardOptions) => {
      await runCommand('tenant onboard', async (config) => {
        const result = await tenantOnboard(config, options);
        if (options.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(`${formatOnboard(result, options).join('\n')}\n`);
        }
        if (!result.data.invitationSent && config.profile.mail.required) process.exitCode = 1;
      });
    });
}

export interface TenantCreateOptions {
  slug: string;
  name: string;
  id?: string;
  timeZone?: string;
  siteCount?: string;
  demoDeployLabel?: string;
}

/**
 * `tenant create` with a loaded configuration. The data key comes from the storage gateway of the profile
 * (`storage.gateway`); `dataKeys` replaces it in tests. Throws `TenantProvisioningError` for refused input.
 */
export async function tenantCreate(config: MscdConfig, options: TenantCreateOptions, dataKeys?: DataKeyIssuer): Promise<CreatedTenant> {
  if (!/^\d{1,5}$/.test(options.siteCount ?? '1')) throw new TenantProvisioningError('--site-count must be a whole number');
  const siteCount = Number(options.siteCount ?? '1');
  const label = options.demoDeployLabel;
  if (label !== undefined) {
    if (!config.demoEnabled) throw new TenantProvisioningError('--demo-deploy-label needs demo mode (demo.enabled: true, D-20)');
    if (label !== 'saas' && label !== 'onprem') throw new TenantProvisioningError('--demo-deploy-label must be saas or onprem');
  }
  const issuer = dataKeys ?? gatewayDataKeyIssuer(config);
  try {
    return await new TenantProvisioner({ connectionString: config.databaseUrl('migrator'), dataKeys: issuer }).create({
      id: options.id,
      slug: options.slug,
      name: options.name,
      timeZone: options.timeZone ?? 'Asia/Jakarta',
      siteCount,
      demoDeployLabel: label as 'saas' | 'onprem' | undefined,
      // Milestone 2 (M2-S09): new organisations get the region of the profile (tenancy.default_region).
      region: config.profile.tenancy.default_region,
      actor: { kind: 'operator' },
    });
  } finally {
    if (issuer instanceof GatewayDataKeyIssuer && issuer !== dataKeys) await issuer.close();
  }
}

/** An organisation that `tenant create --if-missing` found. */
export interface ExistingOrganisation {
  id: string;
  slug: string;
  name: string;
  status: string;
}

/** What `tenant create --if-missing` did: created the organisation, or found one with the slug. */
export type TenantCreateOutcome = { created: CreatedTenant; existing?: undefined } | { existing: ExistingOrganisation; created?: undefined };

/**
 * `tenant create --if-missing`: the organisation with the slug when one exists (not deleted), else `tenant create`.
 * A retried Helm admin Job (its steps run in order in one pod) then passes this step after a partial run. An
 * organisation created between the lookup and the provisioner's own check also counts as found.
 */
export async function tenantCreateIfMissing(config: MscdConfig, options: TenantCreateOptions, dataKeys?: DataKeyIssuer): Promise<TenantCreateOutcome> {
  const existing = await findOrganisation(config, options.slug);
  if (existing) return { existing };
  try {
    return { created: await tenantCreate(config, options, dataKeys) };
  } catch (error) {
    if (error instanceof TenantProvisioningError) {
      const raced = await findOrganisation(config, options.slug);
      if (raced) return { existing: raced };
    }
    throw error;
  }
}

/** The organisation with this slug that is not deleted, read as mscd_migrator with platform scope. */
async function findOrganisation(config: MscdConfig, slug: string): Promise<ExistingOrganisation | null> {
  const migrator = createKysely({ connectionString: config.databaseUrl('migrator'), max: 1, applicationName: 'mscd-tenant-create' });
  try {
    const row = await migrator.transaction().execute(async (trx) => {
      await sql`select set_config('app.platform_scope', 'on', true)`.execute(trx);
      return trx
        .selectFrom('platform.organization')
        .select(['id', 'slug', 'name', 'status'])
        .where('slug', '=', slug)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
    });
    return row ?? null;
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') {
      throw new TenantProvisioningError('The platform tables do not exist yet: run "mscd-server migrate" first', { cause: error });
    }
    throw error;
  } finally {
    await migrator.destroy();
  }
}

export interface TenantVerifyDomainOptions {
  org: string;
  domain: string;
  by: string;
}

/** `tenant verify-domain` with a loaded configuration. */
export async function tenantVerifyDomain(config: MscdConfig, options: TenantVerifyDomainOptions): Promise<VerifiedDomain> {
  return verifyTenantDomain(config.databaseUrl('migrator'), {
    orgSlug: options.org,
    domain: options.domain,
    verifiedBy: options.by,
    actor: { kind: 'operator' },
  });
}

/** Loads the configuration, runs the command and turns errors into one stderr line and exit code 1. */
async function runCommand(name: string, fn: (config: MscdConfig) => Promise<void>): Promise<void> {
  const config = loadConfigOrExit('cli');
  try {
    await fn(config);
  } catch (error) {
    if (error instanceof ConfigError) exitOnConfigError(error);
    process.stderr.write(`${name} failed: ${describeError(error)}\n`);
    process.exit(1);
  }
}

/** The message of a refusal: problem details carry the reason in their messages or detail. */
export function describeError(error: unknown): string {
  if (error instanceof ProblemError) {
    const reason = error.extras.messages?.en ?? error.extras.detail ?? error.message;
    const fields = error.extras.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
    return `${error.extras.rule ? `${error.extras.rule}: ` : ''}${reason}${fields ? ` (${fields})` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------------------------
// Organisation lifecycle of the operator (Milestone 2 K.6, M2-S09)
// ---------------------------------------------------------------------------------------------------------------

/** Readiness and metrics services the database and ops modules expect, without the HTTP and metrics listeners. */
@Global()
@Module({ providers: [ReadinessService, MetricsService], exports: [ReadinessService, MetricsService] })
class OpsCliPlatformModule {}

/**
 * The modules of the operator commands: those of the user administration commands (database, tenancy with the common
 * services, audit, keys, authz, identity with the session revocation, licence with the entitlements) and the
 * operator services of `modules/ops` that the routes use. No HTTP listener, no job worker, no change listener (run mode
 * `cli`): the change notices of a command still reach the api and worker processes, because they are sent by the
 * database when the command's transaction commits.
 */
@Module({})
class OpsCliModule {
  static forRoot(config: MscdConfig): DynamicModule {
    return {
      module: OpsCliModule,
      imports: [
        ConfigModule.forRoot(config),
        OpsCliPlatformModule,
        DatabaseModule,
        TenancyModule,
        AuditModule,
        KeysModule,
        AuthzModule,
        IdentityModule,
        LicenseModule,
      ],
      providers: [OpsOrganizationsService, OrganizationStatusService, TenantDataKeys, OpsMetricsCollector, OpsService, DiagnosticsService],
    };
  }
}

/** A Nest application context for the operator commands (`tenant` lifecycle, `diagnostics`). */
export async function createOpsCliContext(config: MscdConfig): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(OpsCliModule.forRoot(config), { logger: ['error'], abortOnError: false });
}

/** Runs `fn` with a context (closed afterwards unless the caller gave one). */
async function withContext<T>(config: MscdConfig, context: INestApplicationContext | undefined, fn: (app: INestApplicationContext) => Promise<T>): Promise<T> {
  const app = context ?? (await createOpsCliContext(config));
  try {
    return await fn(app);
  } finally {
    if (!context) await app.close();
  }
}

/**
 * The value of a schema, or 400 `validation` naming the command line options that are wrong. `flags` maps a member
 * path (`timeZone`, `firstAdmin.email`) to its option; other members are written as options of the same name.
 */
function parsed<T>(schema: ZodType<T>, value: unknown, flags: Readonly<Record<string, string>>, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ValidationError(
    result.error.issues.map((issue) => {
      const member = String(issue.path[0] ?? '');
      const flag = flags[issue.path.join('.')] ?? flags[member] ?? `--${member.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      return { path: flag, message: issue.message };
    }),
    `The ${what} values are not valid`,
  );
}

export interface TenantListOptions {
  status?: string;
  summary?: boolean;
  json?: boolean;
}

/** `tenant list`: every organisation that is not deleted, as `GET /ops/organizations` lists them (all pages). */
export async function tenantList(config: MscdConfig, options: TenantListOptions = {}, context?: INestApplicationContext): Promise<OpsOrganizationItem[]> {
  if (options.status !== undefined && !(ORGANIZATION_STATUSES as readonly string[]).includes(options.status)) {
    throw new Error(`--status must be one of ${ORGANIZATION_STATUSES.join(', ')}, got ${JSON.stringify(options.status)}`);
  }
  return withContext(config, context, async (app) => {
    const service = app.get(OpsOrganizationsService, { strict: false });
    const items: OpsOrganizationItem[] = [];
    for (let page = 1; ; page += 1) {
      const query = { page, pageSize: MAX_PAGE_SIZE, ...(options.status ? { status: options.status as OrganizationStatus } : {}) };
      const result = await service.list(query, { anyTenancy: true });
      items.push(...result.items);
      if (items.length >= result.total || result.items.length === 0) return items;
    }
  });
}

/** The lines of `tenant list`. */
export function formatList(items: readonly OpsOrganizationItem[]): string[] {
  if (items.length === 0) return ['No organisation exists yet. Create one with "mscd-server tenant onboard" (or "tenant create").'];
  const rows = items.map((o) => [o.slug, o.id, o.status, o.plan ?? '-', o.validUntil ?? o.licence?.validUntil ?? '-', String(o.memberCount)]);
  const head = ['SLUG', 'ID', 'STATUS', 'PLAN', 'VALID UNTIL', 'MEMBERS'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: readonly string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ');
  return [line(head), ...rows.map(line), '', ...summaryOfList(items)];
}

/** The counts of `tenant list --summary`: the number of organisations per status, no slug or name. */
export function summaryOfList(items: readonly OpsOrganizationItem[]): string[] {
  const parts = ORGANIZATION_STATUSES.map((status) => [status, items.filter((o) => o.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`);
  return [`${items.length} ${items.length === 1 ? 'organisation' : 'organisations'}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`];
}

export interface TenantShowOptions {
  org: string;
  summary?: boolean;
  json?: boolean;
}

/** What `tenant show` prints: the detail and the newest status changes. */
export interface TenantShown {
  organization: OpsOrganizationDetail;
  /** The newest status changes, newest first (at most `SHOWN_EVENTS`). */
  events: OrganizationStatusEventItem[];
  /** Every status change of the organisation. */
  eventCount: number;
}

const SHOWN_EVENTS = 10;

/** `tenant show`: the detail of `GET /ops/organizations/{org}` with the newest status changes. */
export async function tenantShow(config: MscdConfig, options: TenantShowOptions, context?: INestApplicationContext): Promise<TenantShown> {
  return withContext(config, context, async (app) => {
    const service = app.get(OpsOrganizationsService, { strict: false });
    const organization = await service.detail(options.org, { anyTenancy: true });
    const events = await service.events(options.org, { page: 1, pageSize: SHOWN_EVENTS }, { anyTenancy: true });
    return { organization, events: events.items, eventCount: events.total };
  });
}

/** The lines of `tenant show` (with `summary`: states and counts only, no name, domains, reasons or people). */
export function formatDetail(shown: TenantShown, summary = false): string[] {
  const o = shown.organization;
  const e = o.entitlement;
  const plan = e
    ? `${e.plan ?? (e.source === 'signed_licence' ? 'signed licence' : 'limits set by the operator')} (${e.source}): ${e.maxUsers} users, ` +
      `${e.maxManagementSystems} management systems, valid until ${e.validUntil ?? 'no end date'}`
    : 'none';
  const byStatus = (['verified', 'pending', 'failed'] as const)
    .map((status) => [status, o.domains.filter((d) => d.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`);
  const lines = summary
    ? [`Organisation:        ${o.slug}`]
    : [`Organisation:        ${o.name} (${o.slug})`, `Id:                  ${o.id}`];
  lines.push(
    `Status:              ${o.status}`,
    `Region:              ${o.region ?? 'not set'}`,
    `Created:             ${o.createdAt}`,
    `Members:             ${o.memberCount} active (guests not counted)`,
    `Management systems:  ${o.systemCount} (not archived)`,
    `Plan:                ${plan}`,
    summary
      ? `Email domains:       ${byStatus.length > 0 ? byStatus.join(', ') : 'none'}`
      : `Email domains:       ${o.domains.length > 0 ? o.domains.map((d) => `${d.domain} (${d.status})`).join(', ') : 'none'}`,
    `Last sign-in:        ${o.lastSignInAt ?? 'none'}`,
    `Status changes:      ${shown.eventCount}`,
  );
  for (const event of shown.events) {
    const move = `${event.at}  ${event.from} to ${event.to}`;
    lines.push(summary ? `  ${move}` : `  ${move}  by ${event.actor ? event.actor.handle : 'the operator command line'}: ${event.reason}`);
  }
  return lines;
}

export interface TenantSetStatusOptions {
  org: string;
  status: string;
  reason: string;
  confirm?: string;
  json?: boolean;
}

/**
 * `tenant set-status`: `POST /ops/organizations/{org}/status` with actor kind `operator` and no user. The values are
 * checked with the route's schema; refusals are the route's problems (409 `invalid_status_transition`, 422
 * `confirmation_mismatch`, 409 `single_tenancy`, 404 for an unknown slug).
 */
export async function tenantSetStatus(config: MscdConfig, options: TenantSetStatusOptions, context?: INestApplicationContext): Promise<OrganizationStatusChangeResult> {
  const body = parsed(
    OrganizationStatusChange,
    { status: options.status, reason: options.reason, ...(options.confirm !== undefined ? { confirmSlug: options.confirm } : {}) },
    { confirmSlug: '--confirm' },
    'status change',
  );
  return withContext(config, context, async (app) => (await app.get(OrganizationStatusService, { strict: false }).change(CLI_OPERATOR, options.org, body)).result);
}

/** The lines of `tenant set-status`. */
export function formatStatusChange(result: OrganizationStatusChangeResult): string[] {
  const d = result.data;
  return [
    `tenant set-status: organisation ${d.slug} moved from ${d.from} to ${d.to}`,
    `Sessions ended:      ${d.sessionsRevoked}`,
    `Tenant Admins told:  ${d.tenantAdminsEmailed} of ${d.tenantAdmins} by email`,
  ];
}

export interface TenantOnboardOptions {
  slug: string;
  name: string;
  timeZone: string;
  siteCount: string;
  adminEmail: string;
  adminName: string;
  preset?: string;
  json?: boolean;
}

/**
 * `tenant onboard`: `POST /ops/organizations` from the command line (Milestone 2 K.6): the organisation (as
 * `tenant create`, in the region of `tenancy.default_region`, local sign-in allowed), the plan preset and the
 * invitation of the first administrator, through the same service. With `mail.required` it refuses before anything is
 * created while SMTP does not work, and it never returns the invitation link; without it and with mail off, the result
 * carries the one-time link.
 */
export async function tenantOnboard(config: MscdConfig, options: TenantOnboardOptions, context?: INestApplicationContext): Promise<OpsOrganizationCreateResult> {
  if (!/^\d{1,5}$/.test(options.siteCount.trim())) throw new Error(`--site-count must be a whole number, got ${JSON.stringify(options.siteCount)}`);
  const body = parsed(
    OpsOrganizationCreate,
    {
      slug: options.slug,
      name: options.name,
      timeZone: options.timeZone,
      siteCount: Number(options.siteCount.trim()),
      firstAdmin: { email: options.adminEmail, displayName: options.adminName },
      ...(options.preset !== undefined ? { preset: options.preset } : {}),
    },
    { timeZone: '--time-zone', siteCount: '--site-count', 'firstAdmin.email': '--admin-email', 'firstAdmin.displayName': '--admin-name' },
    'organisation',
  );
  return withContext(config, context, (app) => app.get(OpsOrganizationsService, { strict: false }).create(CLI_OPERATOR, body));
}

/** The lines of `tenant onboard`. */
export function formatOnboard(result: OpsOrganizationCreateResult, options: Pick<TenantOnboardOptions, 'adminEmail'>): string[] {
  const d = result.data;
  const lines = [`tenant onboard: organisation ${d.slug} (${d.id}) created; the slug cannot be changed`];
  if (d.plan) lines.push(`Plan: ${d.plan.name ?? 'preset'} from ${d.plan.validFrom} to ${d.plan.validUntil ?? 'no end date'}`);
  if (d.invitationSent) {
    lines.push(`Invitation sent to ${options.adminEmail}`);
  } else if (d.invitationUrl) {
    lines.push('Mail is not configured, so give this one-time invitation link to the first administrator (single use, valid 72 hours):', d.invitationUrl);
  } else {
    lines.push(`The invitation email to ${options.adminEmail} could not be sent; invite the first administrator again with "mscd-server admin create-user --org ${d.slug} --tenant-admin"`);
  }
  return lines;
}
