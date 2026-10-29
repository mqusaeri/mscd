// Vitest global setup of the integration tests (build plan J.2).
//
// First runs tools/scripts/ensure-built.mjs (G.1), which builds the development packs (packs/dist) the demo seed
// installs when they are missing or stale. Uses the PostgreSQL server of MSCD_TEST_DATABASE_URL (an administrator
// URL) when set; otherwise starts postgres:16.15-alpine (or MSCD_TEST_PG_IMAGE) with Testcontainers, labelled
// mscd.test=true. Then builds two template databases:
//   mscd_tpl_empty  the C.2 bootstrap (roles, schema ext, pg_trgm) and the platform and ref migrations (C.3 steps 1
//                   and 2), no tenants;
//   mscd_tpl_demo   the same plus `seed demo` (WP-14): the six packs, the four demo organisations with the sample
//                   data, users, licences and repositories (data keys and credentials sealed in process with the
//                   test storage key, so a test gateway opens them).
// Test files copy a template through useTestDatabase('empty' | 'demo') in test/setup/test-db.ts and add
// organisations with createTenant() below. Teardown stops the container.
//
// MSCD_TEST_CONTAINER_PREFIX names the container <prefix>postgres-<random> (useful when several runs share a host).
// The demo template takes about half a minute (four tenant schemas), so it is built only when a test file of the run
// uses it (useTestDatabase('demo'), createTestDatabase('demo') or mscd_tpl_demo in its source); MSCD_TEST_DEMO_TEMPLATE
// set to on or off forces the choice. A demo template that cannot be built is reported and left out, so suites on
// the empty template still run; useTestDatabase('demo') then fails with the template missing.
//
// The SaaS run (`npm run test:int:saas`, vitest.int-saas.config.ts, MSCD_TEST_TENANCY=multi) builds the demo template
// as the multi-tenancy template: `seed demo` runs with tenancy mode multi and schema isolation (tenancy.ts), and the
// template must hold at least two active organisations, each in its own schema, because the security and rbac
// suites prove that one organisation cannot reach another. A SaaS run whose multi-tenancy template cannot be built
// stops here instead of leaving it out.
import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { MscdConfig } from '../../src/config/mscd-config';
import { runBootstrap } from '../../src/db/bootstrap';
import { migrateFolder, openDedicatedDatabase } from '../../src/db/migrator';
import { TenantProvisioner, type CreatedTenant, type CreateTenantInput, type DataKeyIssuer, type WrappedDataKey } from '../../src/db/tenant-provisioner';
import { LocalKeyService } from '../../src/seed/key-service';
import { seedDemo } from '../../src/seed/seed-demo';
import type { TestDatabase } from './test-db';
import { serverUrl, templateName, TEST_ROLE_PASSWORDS, type TemplateKind, type TestDbServer } from './test-db-server';
import { MULTI_TENANCY_ENV, isSaasRun } from './tenancy';

const DEFAULT_IMAGE = 'postgres:16.15-alpine';
/** Containers of crashed runs are removed by later runs once this old (R-06). */
const CONTAINER_LIFETIME_MS = 3 * 60 * 60 * 1000;
const run = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ENSURE_BUILT = path.join(REPO_ROOT, 'tools', 'scripts', 'ensure-built.mjs');
const TEST_PROFILE = path.resolve(__dirname, '../../profiles/test.yaml');
/** Organisations the multi-tenancy template must hold at least: the cross-organisation sweeps need two. */
export const SAAS_TEMPLATE_MIN_ORGANISATIONS = 2;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  const saas = isSaasRun();
  const demoWanted = saas || (await demoTemplateWanted(project));
  const built = demoWanted ? await ensureBuilt() : false;
  if (saas && !built) throw new Error('global-db: the SaaS run needs the multi-tenancy template, and ensure-built failed (see above)');
  await removeExpiredTestContainers();

  let stopContainer: (() => Promise<void>) | undefined;
  let server: TestDbServer;
  const external = process.env.MSCD_TEST_DATABASE_URL;
  if (external) {
    const url = new URL(external);
    server = {
      host: url.hostname,
      port: Number(url.port || 5432),
      adminUser: decodeURIComponent(url.username),
      adminPassword: decodeURIComponent(url.password),
      adminDatabase: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
      templates: [],
    };
  } else {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const image = process.env.MSCD_TEST_PG_IMAGE || DEFAULT_IMAGE;
    let container = new PostgreSqlContainer(image)
      .withDatabase('postgres')
      .withUsername('postgres')
      .withPassword(randomBytes(12).toString('hex'))
      // Test files that provision organisation schemas at the same moment need more than the default lock table
      // (64 per connection gives about 6,400 entries; a full run peaked near 11,900 and failed with code 53200).
      .withCommand(['postgres', '-c', 'max_locks_per_transaction=256'])
      .withLabels({ 'mscd.test': 'true', 'mscd.test.expires': String(Date.now() + CONTAINER_LIFETIME_MS) });
    const prefix = process.env.MSCD_TEST_CONTAINER_PREFIX;
    if (prefix) container = container.withName(`${prefix}postgres-${randomBytes(4).toString('hex')}`);
    const started = await container.start();
    stopContainer = async () => {
      await started.stop();
    };
    server = {
      host: started.getHost(),
      port: started.getPort(),
      adminUser: started.getUsername(),
      adminPassword: started.getPassword(),
      adminDatabase: 'postgres',
      templates: [],
    };
  }

  try {
    await buildTemplate(server, 'empty', async (adminUrlOfTemplate) => {
      await runBootstrap({ adminUrl: adminUrlOfTemplate, passwords: { ...TEST_ROLE_PASSWORDS } });
      await migratePlatformAndRef(serverUrl(server, templateName('empty'), 'mscd_migrator', TEST_ROLE_PASSWORDS.migrator));
    });
    if (built) {
      try {
        const started = Date.now();
        let organisations = 0;
        await buildTemplate(server, 'demo', async (adminUrlOfTemplate) => {
          await fillDemoTemplate(server, adminUrlOfTemplate, saas ? MULTI_TENANCY_ENV : {});
          if (saas) organisations = await checkMultiTenancyTemplate(adminUrlOfTemplate);
        });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        process.stdout.write(
          saas
            ? `global-db: multi-tenancy template ${templateName('demo')} built in ${seconds} s (tenancy multi, schema isolation, ${organisations} organisations)\n`
            : `global-db: demo template ${templateName('demo')} built in ${seconds} s\n`,
        );
      } catch (error) {
        if (saas) throw error;
        process.stderr.write(`global-db: the demo template ${templateName('demo')} was not built: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      }
    }
  } catch (error) {
    await stopContainer?.();
    throw error;
  }

  project.provide('mscdTestDb', server);
  return async () => {
    await stopContainer?.();
    await removeExpiredTestContainers();
  };
}

/** Vitest options that take a value as the next argument (so the value is not mistaken for a file filter). */
const VALUE_OPTIONS = new Set([
  '-c', '--config', '--dir', '-r', '--root', '--project', '-t', '--testNamePattern', '--reporter', '--outputFile', '--pool',
  '--maxWorkers', '--minWorkers', '--shard', '--environment', '--mode', '--exclude', '--retry', '--bail', '--testTimeout',
  '--hookTimeout', '--teardownTimeout', '--maxConcurrency',
]);
const DEMO_TEMPLATE_USE = /(?:useTestDatabase|createTestDatabase)\(\s*['"]demo['"]|mscd_tpl_demo/;

/**
 * True when a test file of this run uses the demo template. The run's files are the configured ones narrowed by the
 * file filters of the command line (the positional arguments after `run`), as Vitest selects them.
 */
async function demoTemplateWanted(project: TestProject): Promise<boolean> {
  const forced = process.env.MSCD_TEST_DEMO_TEMPLATE;
  if (forced === 'on') return true;
  if (forced === 'off') return false;
  const args = process.argv.slice(2);
  const filters: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      if (VALUE_OPTIONS.has(arg)) i += 1;
      continue;
    }
    if (filters.length === 0 && ['run', 'watch', 'dev', 'related'].includes(arg)) continue;
    filters.push(arg);
  }
  const { testFiles } = await project.globTestFiles(filters.length > 0 ? filters : undefined);
  return testFiles.some((file) => DEMO_TEMPLATE_USE.test(readFileSync(file, 'utf8')));
}

/** Runs tools/scripts/ensure-built.mjs (G.1); false (reported) when the outputs cannot be built. */
async function ensureBuilt(): Promise<boolean> {
  try {
    const { stdout } = await run(process.execPath, [ENSURE_BUILT, '--quiet'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
    if (stdout.trim()) process.stdout.write(stdout);
    return true;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    process.stderr.write(`global-db: ensure-built failed, so no demo template is built: ${failure.stderr || failure.stdout || failure.message}\n`);
    return false;
  }
}

/**
 * The demo template (J.2, G.1): bootstrap, platform and ref migrations, then `seed demo` with the test profile on
 * this database. Data keys and credentials are made in process with the test storage key (`gateway.kms.file`).
 * `overrides` are profile overrides of the seed (the multi-tenancy settings in the SaaS run).
 */
async function fillDemoTemplate(server: TestDbServer, adminUrlOfTemplate: string, overrides: Readonly<Record<string, string>> = {}): Promise<void> {
  const name = templateName('demo');
  const urls = {
    migrator: serverUrl(server, name, 'mscd_migrator', TEST_ROLE_PASSWORDS.migrator),
    app: serverUrl(server, name, 'mscd_app', TEST_ROLE_PASSWORDS.app),
    packInstaller: serverUrl(server, name, 'mscd_pack_installer', TEST_ROLE_PASSWORDS.packInstaller),
  };
  await runBootstrap({ adminUrl: adminUrlOfTemplate, passwords: { ...TEST_ROLE_PASSWORDS } });
  await migratePlatformAndRef(urls.migrator);
  const env: Record<string, string | undefined> = { ...process.env };
  for (const variable of ['MSCD_DATABASE_URL', 'MSCD_DATABASE_MIGRATOR_URL', 'MSCD_DATABASE_PACK_URL', 'MSCD_DATABASE_ADMIN_URL']) {
    delete env[`${variable}_FILE`];
  }
  const config = MscdConfig.load({
    runMode: 'cli',
    env: {
      ...env,
      MSCD_PROFILE_FILE: TEST_PROFILE,
      MSCD_DATABASE_URL: urls.app,
      MSCD_DATABASE_MIGRATOR_URL: urls.migrator,
      MSCD_DATABASE_PACK_URL: urls.packInstaller,
      MSCD_DATABASE_ADMIN_URL: adminUrlOfTemplate,
      MSCD__OBSERVABILITY__METRICS_PORT: 'null',
      ...overrides,
    },
  });
  const keys = LocalKeyService.fromConfig(config);
  try {
    await seedDemo(config, { keys });
  } finally {
    await keys.close();
  }
}

/**
 * The checks of the multi-tenancy template (SaaS run): at least SAAS_TEMPLATE_MIN_ORGANISATIONS active organisations,
 * each with a schema of its own that exists in the database. Returns the number of organisations.
 */
async function checkMultiTenancyTemplate(adminUrlOfTemplate: string): Promise<number> {
  const client = new pg.Client({ connectionString: adminUrlOfTemplate });
  client.on('notice', () => undefined);
  await client.connect();
  try {
    const { rows } = await client.query<{ slug: string; schema_name: string; present: boolean }>(
      `SELECT o.slug, o.schema_name, EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = o.schema_name) AS present
         FROM platform.organization o WHERE o.status = 'active' AND o.deleted_at IS NULL ORDER BY o.slug`,
    );
    const schemas = new Set(rows.map((r) => r.schema_name));
    const missing = rows.filter((r) => !r.present).map((r) => `${r.slug} (${r.schema_name})`);
    if (rows.length < SAAS_TEMPLATE_MIN_ORGANISATIONS || schemas.size !== rows.length || missing.length > 0) {
      throw new Error(
        `global-db: the multi-tenancy template needs at least ${SAAS_TEMPLATE_MIN_ORGANISATIONS} active organisations, each in its own schema; ` +
          `it holds ${rows.length} (${rows.map((r) => r.slug).join(', ') || 'none'})${missing.length ? `, schemas missing: ${missing.join(', ')}` : ''}`,
      );
    }
    return rows.length;
  } finally {
    await client.end();
  }
}

/** C.3 steps 1 and 2 as `migrate` runs them: each folder on a dedicated migrator connection with platform scope. */
export async function migratePlatformAndRef(migratorUrl: string): Promise<void> {
  for (const folder of ['platform', 'ref'] as const) {
    const migrator = openDedicatedDatabase(migratorUrl, { platformScope: true, applicationName: 'mscd-test-template' });
    try {
      await migrateFolder(migrator, folder, { migrationTableSchema: folder });
    } finally {
      await migrator.destroy();
    }
  }
}

/** Development storage KEK of the test profile (`gateway.kms.file.path`), R-11. */
export const TEST_STORAGE_KEY_FILE = path.resolve(__dirname, '../fixtures/secrets/storage.key');

/**
 * Test implementation of `DataKeyIssuer`: wraps a random 32-byte data key the way the storage gateway does
 * (F.11 SecretBox `v1.<kekId>.<iv>.<ciphertext and tag>`, AES-256-GCM, additional data `dek:<orgId>`) with the
 * development storage KEK, so the gateway of later work packages can unwrap keys of test tenants.
 */
export class TestDataKeyIssuer implements DataKeyIssuer {
  readonly kekId: string;
  readonly issued: string[] = [];
  private readonly kek: Buffer;

  constructor(kek: Buffer = Buffer.from(readFileSync(TEST_STORAGE_KEY_FILE, 'utf8').trim(), 'base64')) {
    if (kek.length !== 32) throw new Error('The storage KEK must be 32 bytes');
    this.kek = kek;
    this.kekId = createHash('sha256').update(kek).digest('hex').slice(0, 8);
  }

  async issue(orgId: string): Promise<WrappedDataKey> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    cipher.setAAD(Buffer.from(`dek:${orgId}`, 'utf8'));
    const sealed = Buffer.concat([cipher.update(randomBytes(32)), cipher.final(), cipher.getAuthTag()]);
    this.issued.push(orgId);
    return { wrappedDek: `v1.${this.kekId}.${iv.toString('base64url')}.${sealed.toString('base64url')}`, kekId: this.kekId };
  }
}

/**
 * Creates an organisation in a test database with `TenantProvisioner` (C.8): row, schema `org_<slug>`, tenant
 * migrations, data key from `TestDataKeyIssuer`, Managed Vault repository and audit entry.
 */
export async function createTenant(
  db: Pick<TestDatabase, 'urls'>,
  slug: string,
  options: Partial<Omit<CreateTenantInput, 'slug'>> & { dataKeys?: DataKeyIssuer } = {},
): Promise<CreatedTenant> {
  const { dataKeys, ...input } = options;
  return new TenantProvisioner({ connectionString: db.urls.migrator, dataKeys: dataKeys ?? new TestDataKeyIssuer() }).create({
    name: `Test organisation ${slug}`,
    timeZone: 'Asia/Jakarta',
    siteCount: 1,
    ...input,
    slug,
  });
}

/**
 * (Re)creates `mscd_tpl_<kind>`, fills it, then marks it as a template that accepts no connections, so a copy
 * (`CREATE DATABASE ... TEMPLATE`, about 100 ms) never fails because a session is open on it.
 */
export async function buildTemplate(
  server: TestDbServer,
  kind: TemplateKind,
  fill: (adminUrlOfTemplate: string) => Promise<void>,
): Promise<void> {
  const name = templateName(kind);
  await withAdmin(server, async (admin) => {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount) {
      await admin.query(`ALTER DATABASE ${name} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`);
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    }
    await admin.query(`CREATE DATABASE ${name}`);
  });
  await fill(serverUrl(server, name));
  await withAdmin(server, async (admin) => {
    await admin.query(`ALTER DATABASE ${name} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  });
  server.templates.push(kind);
}

async function withAdmin<T>(server: TestDbServer, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: serverUrl(server, server.adminDatabase) });
  client.on('notice', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Removes test containers (label mscd.test=true) whose expiry label has passed: leftovers of crashed runs. */
async function removeExpiredTestContainers(): Promise<void> {
  let listing: string;
  try {
    ({ stdout: listing } = await run('docker', [
      'ps',
      '-a',
      '--filter',
      'label=mscd.test=true',
      '--format',
      '{{.ID}} {{.Label "mscd.test.expires"}}',
    ]));
  } catch {
    return; // No docker CLI: nothing to clean.
  }
  const expired = listing
    .split('\n')
    .map((line) => line.trim().split(' '))
    .filter(([id, expires]) => id && expires && Number(expires) < Date.now())
    .map(([id]) => id!);
  if (expired.length > 0) await run('docker', ['rm', '-f', ...expired]).catch(() => undefined);
}
