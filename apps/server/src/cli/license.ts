import type { INestApplicationContext } from '@nestjs/common';
import type { Command } from 'commander';
import { sql } from 'kysely';
import { DEFAULT_RATE_LIMITS, EntitlementSet, type Entitlement, type Warning } from '@mscd/shared';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { ProblemError, ValidationError } from '../common/problems';
import { createKysely } from '../db/kysely';
import type { DB } from '../db/types';
import type { EntitlementRecord } from '../modules/license/entitlement-row';
import { EntitlementService, type EntitlementRead, type EntitlementWrite } from '../modules/license/entitlement.service';
import { createAdminContext } from './admin';

/**
 * `license` commands (Milestone 2 D.3):
 * - `license show-id` prints the installation id that a licence of kind `installation` binds to (M2-06), so the
 *   operator can ask for a licence before the web app is used.
 * - `license entitlements show --org <slug>` prints the entitlement of an organisation in multi tenancy (its
 *   `platform.entitlement` row) with the current use (M2-S10).
 * - `license entitlements set --org <slug> (--preset <name> | limits)` sets it from a plan preset of `license.plans`
 *   or from explicit limits, through the same service as `PUT /ops/organizations/{org}/entitlements` without its
 *   `If-Match` check (the command acts on the current row). Audited `ops.entitlements_changed` with actor kind
 *   `operator`; limits below the current use are accepted with a warning.
 */
export function register(program: Command): void {
  const license = program.command('license').description('Licence of the installation and entitlements of organisations');
  license
    .command('show-id')
    .description('Print the installation id that a licence binds to')
    .action(async () => {
      const config = loadConfigOrExit('cli');
      try {
        process.stdout.write(`${await licenseShowId(config)}\n`);
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`license show-id failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });

  const entitlements = license
    .command('entitlements')
    .description('Entitlements of organisations in multi tenancy: the plan preset or limits each organisation may use');
  entitlements
    .command('show')
    .description('Print the entitlement of an organisation with its current use')
    .requiredOption('--org <slug>', 'organisation slug')
    .option('--json', 'print the entitlement as JSON, as GET /api/v1/ops/organizations/{org}/entitlements answers it')
    .action(async (options: { org: string; json?: boolean }) => {
      const config = loadConfigOrExit('cli');
      try {
        const read = await licenseEntitlementsShow(config, options);
        if (!read) {
          process.stderr.write(
            `Organisation ${options.org} has no entitlement yet. Set one with "mscd-server license entitlements set --org ${options.org} --preset <name>".\n`,
          );
          process.exit(1);
        }
        process.stdout.write(options.json ? `${JSON.stringify(read.entitlement, null, 2)}\n` : `${formatEntitlement(read.entitlement).join('\n')}\n`);
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`license entitlements show failed: ${describeError(error)}\n`);
        process.exit(1);
      }
    });
  entitlements
    .command('set')
    .description('Set the entitlement of an organisation from a plan preset of license.plans (--preset) or from explicit limits')
    .requiredOption('--org <slug>', 'organisation slug')
    .option('--preset <name>', 'plan preset of license.plans, for example trial or standard')
    .option('--valid-from <date>', 'first valid day YYYY-MM-DD (default: today for a preset, else the current first day or today)')
    .option('--max-users <n>', 'active members without guests')
    .option('--max-systems <n>', 'management systems that are not archived')
    .option('--valid-until <date>', 'last valid day YYYY-MM-DD, or "none" for no end date')
    .option('--grace-days <n>', 'days the organisation keeps working after the last valid day (default: current value, else 30)')
    .option('--frameworks <codes>', 'comma-separated framework codes such as ISO27001,ISO9001, or "all" (default: current value, else all)')
    .option('--storage-adapters <names>', 'comma-separated storage adapters (default: current value, else managed_vault)')
    .option('--features <names>', 'comma-separated licence features, or "none" (default: current value, else none)')
    .option('--rate-user <n>', 'requests per user and minute, or "default" (default: current value)')
    .option('--rate-org <n>', 'requests per organisation and minute, or "default" (default: current value)')
    .option('--plan <name>', 'a name shown as the plan of explicit limits (default: none)')
    .option('--json', 'print the result as JSON, as PUT /api/v1/ops/organizations/{org}/entitlements answers it')
    .addHelpText(
      'after',
      [
        '',
        'Give either --preset (with --valid-from at most) or limits. With limits, options left out keep the current',
        'values; an organisation without an entitlement needs --max-users, --max-systems and --valid-until.',
        'A limit below the current use is accepted with a warning: nobody loses access, but nobody can be added.',
      ].join('\n'),
    )
    .action(async (options: EntitlementsSetOptions & { json?: boolean }) => {
      const config = loadConfigOrExit('cli');
      try {
        const written = await licenseEntitlementsSet(config, options);
        const entitlement = written.result.data;
        if (options.json) {
          process.stdout.write(`${JSON.stringify(written.result, null, 2)}\n`);
          return;
        }
        const head = written.changed
          ? `license entitlements set: organisation ${entitlement.organization} now has ${describePlan(entitlement)} (version ${entitlement.version})`
          : `license entitlements set: organisation ${entitlement.organization} already has these values; nothing changed`;
        const lines = [head, ...formatEntitlement(entitlement), ...warningLines(written.result.warnings ?? [])];
        process.stdout.write(`${lines.join('\n')}\n`);
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`license entitlements set failed: ${describeError(error)}\n`);
        process.exit(1);
      }
    });
}

/**
 * The installation id (`platform.installation.id`, written once by the first platform migration). Read with the
 * application role, which may read the table; the migrator role when only it is configured.
 */
export async function licenseShowId(config: MscdConfig): Promise<string> {
  let url: string;
  try {
    url = config.databaseUrl('app');
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    url = config.databaseUrl('migrator');
  }
  // A short-lived connection of this command (no injected pool exists in a CLI process); the table is not tenant data.
  const connection = createKysely<DB>({ connectionString: url, max: 1, applicationName: 'mscd-license-show-id' });
  try {
    const { rows } = await sql<{ id: string }>`select id from platform.installation limit 1`.execute(connection);
    const id = rows[0]?.id;
    if (!id) throw new Error('The platform tables have no installation row; run "mscd-server migrate" first');
    return id;
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') throw new Error('The platform tables do not exist yet; run "mscd-server migrate" first', { cause: error });
    throw error;
  } finally {
    await connection.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// license entitlements (Milestone 2 M2-S10)
// ---------------------------------------------------------------------------------------------------------------

export interface EntitlementsSetOptions {
  org: string;
  preset?: string;
  validFrom?: string;
  maxUsers?: string;
  maxSystems?: string;
  validUntil?: string;
  graceDays?: string;
  frameworks?: string;
  storageAdapters?: string;
  features?: string;
  rateUser?: string;
  rateOrg?: string;
  plan?: string;
}

/** The options of explicit limits (any of them selects that mode). */
const LIMIT_OPTIONS = ['maxUsers', 'maxSystems', 'validUntil', 'graceDays', 'frameworks', 'storageAdapters', 'features', 'rateUser', 'rateOrg', 'plan'] as const;

/** Option names as typed on the command line, for messages. */
const FLAG: Readonly<Record<(typeof LIMIT_OPTIONS)[number] | 'validFrom' | 'preset', string>> = {
  preset: '--preset',
  validFrom: '--valid-from',
  maxUsers: '--max-users',
  maxSystems: '--max-systems',
  validUntil: '--valid-until',
  graceDays: '--grace-days',
  frameworks: '--frameworks',
  storageAdapters: '--storage-adapters',
  features: '--features',
  rateUser: '--rate-user',
  rateOrg: '--rate-org',
  plan: '--plan',
};

/**
 * `license entitlements show`: the entitlement of an organisation with its current use, or null when it has none. An
 * organisation with a signed licence installed before M2-S10 gets its row from that licence here (once, audited).
 * `context` replaces the application context the command builds (tests).
 */
export async function licenseEntitlementsShow(config: MscdConfig, options: { org: string }, context?: INestApplicationContext): Promise<EntitlementRead | null> {
  return withEntitlements(config, context, (service) => service.show(options.org));
}

/**
 * `license entitlements set`: a preset of `license.plans` or explicit limits, written in one transaction in platform
 * scope with the change notice, the audit entry (actor kind `operator`) and `license.check`. Options left out of
 * explicit limits keep the current values (an organisation without a row needs the user and system limits and the
 * last valid day); explicit limits get source `manual` and the plan `--plan` (none when left out). The values are
 * checked with the schema of the operator route.
 */
export async function licenseEntitlementsSet(config: MscdConfig, options: EntitlementsSetOptions, context?: INestApplicationContext): Promise<EntitlementWrite> {
  const limits = LIMIT_OPTIONS.filter((key) => options[key] !== undefined);
  if (options.preset !== undefined && limits.length > 0) {
    throw new Error(`--preset cannot be combined with limits (${limits.map((key) => FLAG[key]).join(', ')})`);
  }
  if (options.preset === undefined && limits.length === 0) {
    throw new Error('Give --preset <name>, or limits such as --max-users, --max-systems and --valid-until');
  }
  return withEntitlements(config, context, async (service) => {
    const org = await service.organisation(options.org);
    const actor = { userId: null, kind: 'operator' as const };
    if (options.preset !== undefined) {
      const body = checked({ preset: options.preset, ...(options.validFrom !== undefined ? { validFrom: options.validFrom } : {}) });
      return service.change(org, service.valuesOfBody(body), actor, null);
    }
    return service.change(org, (current, today) => service.valuesOfBody(checked(explicitBody(options, current, today)))(current, today), actor, null);
  });
}

/** The explicit limits of the options over the current row (or the defaults of a new row). */
export function explicitBody(options: EntitlementsSetOptions, current: EntitlementRecord | null, today: string): Record<string, unknown> {
  if (!current) {
    const missing = (['maxUsers', 'maxSystems', 'validUntil'] as const).filter((key) => options[key] === undefined);
    if (missing.length > 0) {
      throw new Error(`Organisation ${options.org} has no entitlement yet, so ${missing.map((key) => FLAG[key]).join(', ')} ${missing.length === 1 ? 'is' : 'are'} needed (or use --preset)`);
    }
  }
  const list = (value: string | undefined, none: string, fallback: readonly string[]) =>
    value === undefined ? [...fallback] : value.trim().toLowerCase() === none ? [] : value.split(',').map((x) => x.trim()).filter((x) => x !== '');
  return {
    plan: options.plan ?? null,
    maxUsers: integer(options.maxUsers, 'maxUsers') ?? current?.maxUsers,
    maxManagementSystems: integer(options.maxSystems, 'maxSystems') ?? current?.maxManagementSystems,
    frameworks: list(options.frameworks, 'all', current?.frameworks ?? []),
    storageAdapters: list(options.storageAdapters, '', current?.storageAdapters ?? ['managed_vault']),
    features: list(options.features, 'none', current?.features ?? []),
    rateUserPerMinute: rate(options.rateUser, 'rateUser', current?.rateUserPerMinute ?? null),
    rateOrgPerMinute: rate(options.rateOrg, 'rateOrg', current?.rateOrgPerMinute ?? null),
    graceDays: integer(options.graceDays, 'graceDays') ?? current?.graceDays ?? 30,
    validFrom: options.validFrom ?? current?.validFrom ?? today,
    validUntil: options.validUntil === undefined ? (current?.validUntil ?? null) : options.validUntil.trim().toLowerCase() === 'none' ? null : options.validUntil,
  };
}

/** A whole number of an option (undefined when the option is left out). */
function integer(value: string | undefined, key: keyof typeof FLAG): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,9}$/.test(value.trim())) throw new Error(`${FLAG[key]} must be a whole number, got ${JSON.stringify(value)}`);
  return Number(value.trim());
}

/** A rate limit option: a number, or "default" (null, the defaults of every api request). */
function rate(value: string | undefined, key: 'rateUser' | 'rateOrg', fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value.trim().toLowerCase() === 'default') return null;
  return integer(value, key)!;
}

/**
 * The body checked with the schema of `PUT /ops/organizations/{org}/entitlements`: the branch of a preset or the one of
 * explicit limits, so the messages name the options that are wrong.
 */
function checked(body: Record<string, unknown>): EntitlementSet {
  const [presetBranch, limitsBranch] = EntitlementSet.options;
  const parsed = ('preset' in body ? presetBranch : limitsBranch).safeParse(body);
  if (parsed.success) return parsed.data;
  throw new ValidationError(
    parsed.error.issues.map((issue) => ({ path: optionOf(issue.path), message: issue.message })),
    'The entitlement values are not valid',
  );
}

/** The command line option of a body member, for messages. */
function optionOf(path: readonly PropertyKey[]): string {
  const member = String(path[0] ?? '');
  const flags: Record<string, string> = {
    maxManagementSystems: '--max-systems',
    rateUserPerMinute: '--rate-user',
    rateOrgPerMinute: '--rate-org',
  };
  const flag = flags[member] ?? `--${member.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  return path.length > 1 ? `${flag} (${path.slice(1).join('.')})` : flag;
}

/** Runs `fn` with the entitlement service of a command context (closed afterwards unless the caller gave one). */
async function withEntitlements<T>(config: MscdConfig, context: INestApplicationContext | undefined, fn: (service: EntitlementService) => Promise<T>): Promise<T> {
  const app = context ?? (await createAdminContext(config));
  try {
    return await fn(app.get(EntitlementService, { strict: false }));
  } finally {
    if (!context) await app.close();
  }
}

/** The plan of an entitlement in words. */
function describePlan(e: Entitlement): string {
  switch (e.source) {
    case 'preset':
      return `the ${e.plan ?? 'unnamed'} plan (preset)`;
    case 'manual':
      return e.plan ? `the ${e.plan} plan (limits set by the operator)` : 'limits set by the operator';
    case 'signed_licence':
      return 'the limits of a signed licence';
  }
}

/** Requests per minute of a default rate limit (`DEFAULT_RATE_LIMITS`). */
function defaultPerMinute(key: 'user' | 'org'): number {
  const limit = DEFAULT_RATE_LIMITS.find((l) => l.key === key)!;
  return Math.round((limit.max * 60) / limit.windowSeconds);
}

/** The lines of `license entitlements show` (and of `set` after the change). */
export function formatEntitlement(e: Entitlement): string[] {
  const listOr = (values: readonly string[], empty: string) => (values.length > 0 ? values.join(', ') : empty);
  const perMinute = (value: number | null, key: 'user' | 'org') => (value === null ? `${defaultPerMinute(key)} (default)` : String(value));
  const frameworks = e.frameworks.length > 0 ? e.frameworks.join(', ') : e.source === 'signed_licence' ? 'none' : 'every installed framework';
  return [
    `Organisation:        ${e.organization}`,
    `Plan:                ${describePlan(e)}`,
    `Users:               ${e.usage.users} of ${e.maxUsers} (active members without guests)`,
    `Management systems:  ${e.usage.managementSystems} of ${e.maxManagementSystems} (not archived)`,
    `Valid:               ${e.validFrom} to ${e.validUntil ?? 'no end date'}${e.validUntil ? `, then ${e.graceDays} days of grace` : ''}`,
    `Frameworks:          ${frameworks}`,
    `Storage adapters:    ${listOr(e.storageAdapters, 'none')}`,
    `Features:            ${listOr(e.features, 'none')}`,
    `Requests a minute:   ${perMinute(e.rateUserPerMinute, 'user')} per user, ${perMinute(e.rateOrgPerMinute, 'org')} per organisation`,
    `Version:             ${e.version} (changed ${e.updatedAt})`,
  ];
}

function warningLines(warnings: readonly Warning[]): string[] {
  return warnings.map((w) => `Warning (${w.rule}): ${w.messages.en}`);
}

/** The message of a refusal: problem details carry the reason in their messages or detail. */
function describeError(error: unknown): string {
  if (error instanceof ProblemError) {
    const reason = error.extras.messages?.en ?? error.extras.detail ?? error.message;
    const fields = error.extras.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
    return `${error.extras.rule ? `${error.extras.rule}: ` : ''}${reason}${fields ? ` (${fields})` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}
