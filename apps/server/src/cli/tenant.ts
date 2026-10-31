import { Global, Module, type DynamicModule, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  OpsOrganizationCreate,
  OrganizationDeletionSchedule,
  OrganizationStatusChange,
  ORGANIZATION_STATUSES,
  MAX_PAGE_SIZE,
  type OrganizationDeletionResult,
  type OrganizationDeletionView,
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
import { compiledAnchorKeys } from '../modules/audit/anchors';
import { certificateProblemText, verifyCertificateText, type CertificateCheck } from '../modules/ops/deletion/certificate';
import { DeletionService } from '../modules/ops/deletion/deletion.service';
import { OrganizationTransitions } from '../modules/ops/deletion/organization-transitions';
import { DiagnosticsService } from '../modules/ops/diagnostics.service';
import { DnsTxtChecker } from '../modules/ops/domains/dns-txt';
import { DomainsService } from '../modules/ops/domains/domains.service';
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
 *
 * End of contract and verified deletion (Milestone 3 D.5, D.5.6; M3-03), multi tenancy only:
 * - `tenant deletion show|schedule|cancel --org <slug>` are the operator console's actions (`ops.deletion.get`,
 *   `.schedule`, `.cancel`); `show --certificate <file>` writes the signed certificate of a completed deletion;
 * - `tenant deletion run --org <slug>` queues `org.purge` for a deletion that is due now and waits for the worker
 *   (never before the deletion date, A.2);
 * - `tenant purge --reapply <certificate> --confirm <slug>` re-applies a certified deletion after a restore from an older
 *   backup (D.5.6): it checks the signature against the trusted anchor keys and that the certificate names this
 *   organisation, moves the organisation to archived and its deletion to running as the system, queues `org.purge` for
 *   the worker (which holds the gateway certificate the purge needs) and waits;
 * - `tenant verify-certificate <file>` checks a deletion certificate offline against the trusted anchor keys of the
 *   release (any tenancy).
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
    .description(
      'Record an email domain as verified for an organisation (needed for JIT provisioning, D-25). In multi tenancy (SaaS) ' +
        'domains are verified by their DNS record from the operator console; this command verifies one by hand and needs --manual-reason',
    )
    .requiredOption('--org <slug>', 'organisation slug')
    .requiredOption('--domain <domain>', 'email domain')
    .requiredOption('--by <name>', 'who verified it')
    .option('--manual-reason <text>', 'multi tenancy: why the domain is verified without its DNS record (3 to 500 characters, audited with method manual)')
    .action(async (options: TenantVerifyDomainOptions) => {
      await runCommand('tenant verify-domain', async (config) => {
        const result = await tenantVerifyDomain(config, options);
        const method = result.method === 'manual' ? ' (method manual)' : '';
        process.stdout.write(
          result.created
            ? `tenant verify-domain: ${result.domain} is now verified for organisation ${options.org}${method}\n`
            : `tenant verify-domain: ${result.domain} was already verified for organisation ${options.org}; nothing changed\n`,
        );
      });
    });
  registerLifecycle(tenant);
  registerDeletion(tenant);
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
    .description('Move an organisation to another status (active, suspended, offboarding, archived) with a reason; deleted is reached by the purge only')
    .requiredOption('--org <slug>', 'organisation slug')
    .requiredOption('--status <status>', `new status: ${ORGANIZATION_STATUSES.filter((st) => st !== 'deleted').join(', ')}`)
    .requiredOption('--reason <text>', 'why (3 to 500 characters); the Tenant Admins of the organisation get it by email, so name no person')
    .option('--confirm <slug>', 'the slug again: needed for offboarding and archived')
    .option('--json', 'print the result as JSON, as POST /api/v1/ops/organizations/{org}/status answers it')
    .addHelpText(
      'after',
      [
        '',
        'Allowed moves: active to suspended or offboarding; suspended to active or offboarding; offboarding to active',
        'or archived; archived to offboarding while its deletion is scheduled (which cancels it; read-only for 7 days).',
        'offboarding starts the read-only period and queues the final export; archived schedules the deletion.',
        'suspended and archived end every session in the organisation; its people keep their other memberships.',
        'The Tenant Admins get an email with the new status, the dates and the reason.',
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
  /** Multi tenancy: why the domain is verified by hand instead of by its DNS record (Milestone 2 K.6, M2-S11). */
  manualReason?: string;
}

/** The answer of `tenant verify-domain`; `method` is `manual` for the multi-tenancy path. */
export type TenantVerifiedDomain = VerifiedDomain & { method?: 'manual' };

/**
 * `tenant verify-domain` with a loaded configuration. Single tenancy (on-premise) records the domain as before,
 * through `verifyTenantDomain` as the database owner. Multi tenancy (Milestone 2 K.6, M2-S11) verifies domains by their
 * DNS TXT record from the operator console; the command verifies one by hand through `DomainsService.verifyManually`
 * of the operator routes: it needs `--manual-reason`, refuses free mail domains and a domain another organisation holds
 * verified (`domain_taken`), turns a pending or failed DNS claim of the organisation into the verification, and is
 * audited `ops.domain_verified` with method `manual`, the reason and actor kind `operator`.
 */
export async function tenantVerifyDomain(config: MscdConfig, options: TenantVerifyDomainOptions, context?: INestApplicationContext): Promise<TenantVerifiedDomain> {
  const multi = (config as Partial<MscdConfig>).profile?.tenancy.mode === 'multi';
  if (!multi) {
    if (options.manualReason !== undefined) {
      process.stderr.write('tenant verify-domain: --manual-reason is used in multi tenancy only; it was not recorded\n');
    }
    return verifyTenantDomain(config.databaseUrl('migrator'), {
      orgSlug: options.org,
      domain: options.domain,
      verifiedBy: options.by,
      actor: { kind: 'operator' },
    });
  }
  if (options.manualReason === undefined || options.manualReason.trim() === '') {
    throw new Error(
      'In multi tenancy domains are verified by their DNS record from the operator console; to verify one by hand, give --manual-reason <text> ' +
        '(for example the ticket where the customer proved the domain)',
    );
  }
  const reason = options.manualReason;
  return withContext(config, context, async (app) => {
    const verified = await app.get(DomainsService, { strict: false }).verifyManually(CLI_OPERATOR, options.org, options.domain, { verifiedBy: options.by, reason });
    return { ...verified, method: 'manual' as const };
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
      // DnsTxtChecker and DomainsService: `tenant verify-domain` in multi tenancy (Milestone 2 M2-S11).
      // OrganizationTransitions and DeletionService: the status moves and the deletion commands (Milestone 3 M3-03).
      providers: [
        OpsOrganizationsService, OrganizationStatusService, OrganizationTransitions, DeletionService, TenantDataKeys, OpsMetricsCollector, OpsService,
        DiagnosticsService, DnsTxtChecker, DomainsService,
      ],
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
  const notes = items.map(lifecycleNote).filter((n): n is string => n !== null);
  return [line(head), ...rows.map(line), ...(notes.length > 0 ? ['', 'Read-only period, deletion and last export:', ...notes] : []), '', ...summaryOfList(items)];
}

/** One note line of `tenant list` for an organisation with a read-only end, a deletion or an export (D.2), else null. */
function lifecycleNote(o: OpsOrganizationItem): string | null {
  const parts = [
    ...(o.offboardingEndsAt ? [`read-only until ${o.offboardingEndsAt}`] : []),
    ...(o.deletion ? [`deletion ${o.deletion.status} (date ${o.deletion.scheduledFor})`] : []),
    ...(o.lastExport ? [`last export ${o.lastExport.status}${o.lastExport.readyAt ? ` (ready ${o.lastExport.readyAt})` : ''}`] : []),
  ];
  return parts.length > 0 ? `  ${o.slug}: ${parts.join('; ')}` : null;
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
    `Read-only until:     ${o.offboardingEndsAt ?? 'not in a read-only period'}`,
    summary || !o.deletion
      ? `Deletion:            ${o.deletion ? o.deletion.status : 'none'}`
      : `Deletion:            ${o.deletion.status}, date ${o.deletion.scheduledFor}`,
    summary || !o.lastExport
      ? `Last export:         ${o.lastExport ? o.lastExport.status : 'none'}`
      : `Last export:         ${o.lastExport.status}${o.lastExport.readyAt ? `, ready ${o.lastExport.readyAt}` : ''}`,
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

// ---------------------------------------------------------------------------------------------------------------
// End of contract and verified deletion (Milestone 3 D.5, D.5.6; M3-03)
// ---------------------------------------------------------------------------------------------------------------

/** Default wait of `deletion run` and `purge --reapply` for the worker, in seconds. */
const PURGE_WAIT_SECONDS = 900;

/** `tenant deletion show|schedule|cancel|run`, `tenant purge --reapply` and `tenant verify-certificate`. */
function registerDeletion(tenant: Command): void {
  const deletion = tenant.command('deletion').description('The verified deletion of an archived organisation (multi tenancy)');
  deletion
    .command('show')
    .description('Show the deletion of an organisation: status, dates, steps, checks and certificate id')
    .requiredOption('--org <slug>', 'organisation slug')
    .option('--certificate <file>', 'also write the signed certificate of a completed deletion to this file (mode 0600)')
    .option('--json', 'print the deletion as JSON, as GET /api/v1/ops/organizations/{org}/deletion answers it')
    .action(async (options: TenantDeletionShowOptions) => {
      await runCommand('tenant deletion show', async (config) => {
        const shown = await tenantDeletionShow(config, options);
        if (options.json) process.stdout.write(`${JSON.stringify(shown.deletion, null, 2)}\n`);
        else process.stdout.write(`${formatDeletion(options.org, shown.deletion).join('\n')}\n`);
        if (shown.certificateFile) process.stderr.write(`tenant deletion show: certificate written to ${shown.certificateFile}\n`);
      });
    });
  deletion
    .command('schedule')
    .description('Schedule or move the deletion date of an archived organisation (not earlier than archiving plus lifecycle.deletion_min_grace_days)')
    .requiredOption('--org <slug>', 'organisation slug')
    .requiredOption('--date <instant>', 'the deletion date and time, ISO 8601 with Z, for example 2026-12-10T00:00:00Z')
    .requiredOption('--reason <text>', 'why (10 to 500 characters), for example the customer asked in writing')
    .requiredOption('--confirm <slug>', 'the slug again')
    .option('--json', 'print the result as JSON, as POST /api/v1/ops/organizations/{org}/deletion answers it')
    .action(async (options: TenantDeletionScheduleOptions) => {
      await runCommand('tenant deletion schedule', async (config) => {
        const result = await tenantDeletionSchedule(config, options);
        if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else process.stdout.write(`tenant deletion schedule: ${result.message?.[0] ?? `deletion of ${options.org} scheduled for ${result.data.scheduledFor}`}\n`);
      });
    });
  deletion
    .command('cancel')
    .description('Cancel the scheduled deletion of an organisation (it stays archived)')
    .requiredOption('--org <slug>', 'organisation slug')
    .requiredOption('--reason <text>', 'why (10 to 500 characters)')
    .option('--json', 'print the result as JSON, as POST /api/v1/ops/organizations/{org}/deletion/cancel answers it')
    .action(async (options: TenantDeletionCancelOptions) => {
      await runCommand('tenant deletion cancel', async (config) => {
        const result = await tenantDeletionCancel(config, options);
        if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else process.stdout.write(`tenant deletion cancel: ${result.message?.[0] ?? `deletion of ${options.org} cancelled`}\n`);
      });
    });
  deletion
    .command('run')
    .description('Queue the purge of a deletion that is due now and wait for the worker (never before the deletion date)')
    .requiredOption('--org <slug>', 'organisation slug')
    .option('--timeout <seconds>', 'how long to wait for the worker', String(PURGE_WAIT_SECONDS))
    .option('--no-wait', 'queue the purge and return at once')
    .action(async (options: TenantDeletionRunOptions) => {
      await runCommand('tenant deletion run', async (config) => {
        const outcome = await tenantDeletionRun(config, options);
        process.stdout.write(`${formatPurgeOutcome('tenant deletion run', options.org, outcome).join('\n')}\n`);
        if (outcome.status === 'failed' || outcome.status === 'timeout') process.exitCode = 1;
      });
    });
  tenant
    .command('purge')
    .description('Re-apply a certified deletion after a restore from a backup older than the deletion (docs/saas/backup-restore.md)')
    .requiredOption('--reapply <certificate>', 'the deletion certificate file (from the certificate email or the operator console)')
    .requiredOption('--confirm <slug>', 'the slug of the organisation the certificate names')
    .option('--timeout <seconds>', 'how long to wait for the worker', String(PURGE_WAIT_SECONDS))
    .option('--no-wait', 'queue the purge and return at once')
    .addHelpText(
      'after',
      [
        '',
        'The certificate must verify against the trusted anchor keys of this release and name this organisation id.',
        'The organisation moves to archived (from any status a backup may hold) and its deletion to running as the',
        'system; the worker then runs every step of the purge again and issues a new certificate.',
      ].join('\n'),
    )
    .action(async (options: TenantPurgeOptions) => {
      await runCommand('tenant purge', async (config) => {
        const outcome = await tenantPurgeReapply(config, options);
        process.stdout.write(`${formatPurgeOutcome('tenant purge --reapply', options.confirm, outcome).join('\n')}\n`);
        if (outcome.status === 'failed' || outcome.status === 'timeout') process.exitCode = 1;
      });
    });
  tenant
    .command('verify-certificate')
    .description('Check a deletion certificate against the trusted anchor keys of this release')
    .argument('<file>', 'the certificate file')
    .option('--json', 'print the result as JSON')
    .action(async (file: string, options: { json?: boolean }) => {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (error) {
        process.stderr.write(`tenant verify-certificate failed: ${describeError(error)}\n`);
        process.exit(1);
      }
      const check = tenantVerifyCertificate(text);
      if (options.json) process.stdout.write(`${JSON.stringify({ ok: check.ok, problem: check.problem, keyId: check.keyId, certificateId: check.certificate?.certificateId ?? null, organization: check.certificate?.organization ?? null }, null, 2)}\n`);
      else process.stdout.write(`${formatCertificateCheck(check).join('\n')}\n`);
      if (!check.ok) process.exitCode = 1;
    });
}

export interface TenantDeletionShowOptions {
  org: string;
  certificate?: string;
  json?: boolean;
}

/** `tenant deletion show`: `GET /ops/organizations/{org}/deletion`, and the certificate file when asked. */
export async function tenantDeletionShow(
  config: MscdConfig,
  options: TenantDeletionShowOptions,
  context?: INestApplicationContext,
): Promise<{ deletion: OrganizationDeletionView; certificateFile: string | null }> {
  return withContext(config, context, async (app) => {
    const service = app.get(DeletionService, { strict: false });
    const deletion = await service.get(options.org);
    let certificateFile: string | null = null;
    if (options.certificate) {
      const file = await service.certificate(options.org);
      writeFileSync(options.certificate, file.text, { mode: 0o600 });
      certificateFile = options.certificate;
    }
    return { deletion, certificateFile };
  });
}

/** The lines of `tenant deletion show`. */
export function formatDeletion(slug: string, d: OrganizationDeletionView): string[] {
  const lines = [
    `Organisation:        ${slug}`,
    `Deletion:            ${d.id} (${d.status})`,
    `Scheduled for:       ${d.scheduledFor}${d.scheduledBy ? ` by ${d.scheduledBy.handle}` : ' by the system'}`,
    `Archived:            ${d.archivedAt ?? 'not archived'}`,
    `Earliest allowed:    ${d.earliestAllowed ?? '-'}`,
    `Final export:        ${d.finalExportId ?? 'none'}`,
    `Started:             ${d.startedAt ?? '-'}`,
    `Completed:           ${d.completedAt ?? '-'}`,
  ];
  if (d.failedStep) lines.push(`Failed at:           ${d.failedStep}: ${d.error ?? ''}`);
  if (d.vaultObjectsDeleted !== null) lines.push(`Vault objects:       ${d.vaultObjectsDeleted} removed`);
  if (d.certificateId) lines.push(`Certificate:         ${d.certificateId}`);
  for (const step of d.steps) lines.push(`  ${step.status.padEnd(8)} ${step.step}${step.detail ? `: ${step.detail}` : ''}`);
  return lines;
}

export interface TenantDeletionScheduleOptions {
  org: string;
  date: string;
  reason: string;
  confirm: string;
  json?: boolean;
}

/** `tenant deletion schedule`: `POST /ops/organizations/{org}/deletion` with `CLI_OPERATOR`. */
export async function tenantDeletionSchedule(config: MscdConfig, options: TenantDeletionScheduleOptions, context?: INestApplicationContext): Promise<OrganizationDeletionResult> {
  const body = parsed(
    OrganizationDeletionSchedule,
    { scheduledFor: options.date, reason: options.reason, confirmSlug: options.confirm },
    { scheduledFor: '--date', confirmSlug: '--confirm' },
    'deletion',
  );
  return withContext(config, context, (app) => app.get(DeletionService, { strict: false }).schedule(CLI_OPERATOR, options.org, body));
}

export interface TenantDeletionCancelOptions {
  org: string;
  reason: string;
  json?: boolean;
}

/** `tenant deletion cancel`: `POST /ops/organizations/{org}/deletion/cancel` with `CLI_OPERATOR`. */
export async function tenantDeletionCancel(config: MscdConfig, options: TenantDeletionCancelOptions, context?: INestApplicationContext): Promise<OrganizationDeletionResult> {
  const reason = options.reason.trim();
  if (reason.length < 10 || reason.length > 500) throw new ValidationError([{ path: '--reason', message: 'The reason needs 10 to 500 characters' }]);
  return withContext(config, context, (app) => app.get(DeletionService, { strict: false }).cancel(CLI_OPERATOR, options.org, reason));
}

export interface TenantDeletionRunOptions {
  org: string;
  timeout?: string;
  /** commander sets false for --no-wait. */
  wait?: boolean;
}

/** How a purge the command queued ended. */
export interface PurgeOutcome {
  deletionId: string;
  status: 'queued' | 'completed' | 'failed' | 'timeout';
  failedStep: string | null;
  error: string | null;
}

/** `tenant deletion run`: queues `org.purge` for a deletion that is due and waits for the worker. */
export async function tenantDeletionRun(config: MscdConfig, options: TenantDeletionRunOptions, context?: INestApplicationContext): Promise<PurgeOutcome> {
  return withContext(config, context, async (app) => {
    const service = app.get(DeletionService, { strict: false });
    const { deletionId } = await service.runDue(options.org);
    return options.wait === false ? { deletionId, status: 'queued', failedStep: null, error: null } : waitForPurge(service, deletionId, seconds(options.timeout));
  });
}

export interface TenantPurgeOptions {
  reapply: string;
  confirm: string;
  timeout?: string;
  wait?: boolean;
}

/**
 * `tenant purge --reapply <certificate> --confirm <slug>` (D.5.6): the certificate must verify against the trusted
 * anchor keys and name the organisation of the slug; then the re-apply moves of J.8 and `org.purge` for the worker.
 * `trustedKeys` replaces the compiled anchor keys in tests.
 */
export async function tenantPurgeReapply(
  config: MscdConfig,
  options: TenantPurgeOptions,
  context?: INestApplicationContext,
  trustedKeys = compiledAnchorKeys(),
): Promise<PurgeOutcome> {
  const text = readFileSync(options.reapply, 'utf8');
  const check = verifyCertificateText(text, trustedKeys);
  if (!check.ok || !check.certificate) throw new Error(`The certificate ${options.reapply} does not verify: ${certificateProblemText(check.problem ?? 'not-a-certificate')}`);
  const certificate = check.certificate;
  return withContext(config, context, async (app) => {
    const transitions = app.get(OrganizationTransitions, { strict: false });
    const service = app.get(DeletionService, { strict: false });
    const org = await findOrganisationForReapply(config, options.confirm);
    if (!org) throw new Error(`No organisation with slug ${options.confirm}`);
    if (org.id !== certificate.organization.id) {
      throw new Error(`The certificate names organisation ${certificate.organization.id} (${certificate.organization.slug}), and --confirm names ${org.slug} (${org.id}); nothing was changed`);
    }
    const done = await transitions.reapplyDeletion(org.id, { certificateId: certificate.certificateId, deletionId: certificate.deletionId });
    if (!done) return { deletionId: certificate.deletionId, status: 'completed', failedStep: null, error: 'already deleted' };
    return options.wait === false ? { deletionId: done.deletionId, status: 'queued', failedStep: null, error: null } : waitForPurge(service, done.deletionId, seconds(options.timeout));
  });
}

/** The organisation of a slug, whatever its status (the re-apply also finds one restored as active). */
async function findOrganisationForReapply(config: MscdConfig, slug: string): Promise<{ id: string; slug: string } | null> {
  const found = await findOrganisation(config, slug);
  return found ? { id: found.id, slug: found.slug } : null;
}

/** `tenant verify-certificate`: the offline check of a certificate file. */
export function tenantVerifyCertificate(text: string, trustedKeys = compiledAnchorKeys()): CertificateCheck {
  return verifyCertificateText(text, trustedKeys);
}

/** The lines of `tenant verify-certificate`. */
export function formatCertificateCheck(check: CertificateCheck): string[] {
  if (!check.ok) return [`tenant verify-certificate: the certificate does not verify: ${certificateProblemText(check.problem ?? 'not-a-certificate')}`];
  const c = check.certificate!;
  return [
    `tenant verify-certificate: the certificate ${c.certificateId} verifies with the trusted anchor key ${check.keyId}`,
    `Organisation:        ${c.organization.slug} (${c.organization.id})`,
    `Deleted on:          ${c.dates.deletionCompletedAt}`,
    `Checks:              ${c.checks.filter((k) => k.passed).length} of ${c.checks.length} passed`,
    `Backups hold copies until at the latest: ${c.backups.copiesEndBy}`,
  ];
}

/** The lines of `deletion run` and `purge --reapply`. */
export function formatPurgeOutcome(command: string, slug: string, outcome: PurgeOutcome): string[] {
  switch (outcome.status) {
    case 'queued':
      return [`${command}: the purge of ${slug} is queued (deletion ${outcome.deletionId}); follow it with "mscd-server tenant deletion show --org ${slug}"`];
    case 'completed':
      return [
        outcome.error === 'already deleted'
          ? `${command}: organisation ${slug} is deleted already; nothing to do`
          : `${command}: organisation ${slug} is deleted (deletion ${outcome.deletionId}); "tenant deletion show --org ${slug} --certificate <file>" writes the certificate`,
      ];
    case 'failed':
      return [`${command}: the purge of ${slug} failed at step ${outcome.failedStep ?? '?'}: ${outcome.error ?? ''}`];
    case 'timeout':
      return [`${command}: the purge of ${slug} did not end in time (deletion ${outcome.deletionId}); is the worker running? Follow it with "tenant deletion show --org ${slug}"`];
  }
}

function seconds(value: string | undefined): number {
  const n = Number(value ?? PURGE_WAIT_SECONDS);
  if (!Number.isInteger(n) || n < 1 || n > 86_400) throw new Error(`--timeout must be a whole number of seconds from 1 to 86400, got ${JSON.stringify(value)}`);
  return n;
}

/** Waits until the worker ends the purge (completed or failed) or the time is up. */
async function waitForPurge(service: DeletionService, deletionId: string, timeoutSeconds: number): Promise<PurgeOutcome> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const state = await service.status(deletionId);
    if (state?.status === 'completed') return { deletionId, status: 'completed', failedStep: null, error: null };
    if (state?.status === 'failed') return { deletionId, status: 'failed', failedStep: state.failedStep, error: state.error };
    if (Date.now() >= deadline) return { deletionId, status: 'timeout', failedStep: null, error: null };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
