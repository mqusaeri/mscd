import type { Command } from 'commander';
import { sql } from 'kysely';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { createKysely } from '../db/kysely';
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
            `Managed Vault repository ${created.vaultRepositoryId}\n` +
            `The slug ${created.slug} cannot be changed: it names the organisation's schema. Local sign-in is allowed.\n`,
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
    process.stderr.write(`${name} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
