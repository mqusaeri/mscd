// The write tracker of the test reset (Milestone 2 M2-21, src/modules/test-support/write-tracker.ts) against a real
// database: the first reset after start recreates the database; later, a reset with no write since the one before
// only deletes the sessions `POST /test/session` minted, and a write through the api (a request other than GET, HEAD
// or OPTIONS, or an audit entry) makes the next reset recreate the database again. Rows changed directly in the
// database, not through the api, are not seen: that is the rule the API suite's tests follow.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockProviders, type RunningMockProviders } from '@mscd/mock-providers';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_WRITER, type AuditWriter } from '../../../src/common/tokens';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TestSupportModule } from '../../../src/modules/test-support/test-support.module';
import { TestWriteTracker } from '../../../src/modules/test-support/write-tracker';
import { UiModule } from '../../../src/modules/ui/ui.module';
import { serverUrl, templateName } from '../../setup/test-db-server';
import { useTestDatabase, type TestDatabase } from '../../setup/test-db';
import { Browser } from '../identity/helpers';

const RESET = '/api/v1/test/reset';
const SESSION = '/api/v1/test/session';
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const DEMO_FIXTURES = path.join(REPO_ROOT, 'tools/mock-providers/fixtures/demo.json');

async function query<T extends pg.QueryResultRow>(db: TestDatabase, text: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: db.urls.admin });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const displayName = async (db: TestDatabase) =>
  (await query<{ display_name: string }>(db, `select display_name from platform.app_user where handle = 'rina'`))[0]!.display_name;
const testSessions = async (db: TestDatabase) => (await query(db, `select 1 from platform.session where auth_method = 'test'`)).length;

describe('the test reset recreates the database only after a write (M2-21)', () => {
  const db = useTestDatabase('demo');
  let app: NestFastifyApplication;
  let mock: RunningMockProviders;
  let secrets: string;
  let seeded: string;

  beforeAll(async () => {
    mock = await startMockProviders({ port: 0, fixtures: JSON.parse(readFileSync(DEMO_FIXTURES, 'utf8')) as unknown });
    secrets = mkdtempSync(path.join(tmpdir(), 'mscd-reset-tracking-'));
    const adminFile = path.join(secrets, 'db-admin.url');
    writeFileSync(adminFile, serverUrl(db.server, db.server.adminDatabase), { mode: 0o600 });
    const settings = {
      MSCD__MAIL__SMTP__PORT: '9',
      MSCD__TEST__ENDPOINTS_ENABLED: 'true',
      MSCD__TEST__TEMPLATE_DATABASE: templateName('demo'),
      MSCD__TEST__ADMIN_DATABASE_URL_FILE: adminFile,
      MSCD__GATEWAY__PROVIDERS__M365__GRAPH_BASE_URL: `${mock.url}/v1.0`,
      MSCD__GATEWAY__PROVIDERS__M365__LOGIN_BASE_URL: mock.url,
    };
    const config = db.config(settings);
    const moduleRef = await db
      .createTestingModule({ imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, UiModule, TestSupportModule] }, settings)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
    app.useLogger(app.get(Logger));
    await configureHttpApplication(app, config);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    seeded = await displayName(db);
  });
  afterAll(async () => {
    await app?.close();
    await mock?.close();
    if (secrets) rmSync(secrets, { recursive: true, force: true });
  });

  it('the first reset after start recreates the database', async () => {
    expect(app.get(TestWriteTracker).changedBy).toBe('api start');
    await query(db, `update platform.app_user set display_name = 'Changed before the first reset' where handle = 'rina'`);
    expect((await new Browser(app).post(RESET, undefined)).statusCode).toBe(200);
    expect(await displayName(db)).toBe(seeded);
    expect(app.get(TestWriteTracker).changed).toBe(false);
  });

  it('a reset without a write deletes the minted sessions and recreates nothing', async () => {
    const browser = new Browser(app);
    expect((await browser.post(SESSION, { handle: 'rina' })).statusCode).toBe(200);
    expect((await browser.get('/api/v1/me')).statusCode).toBe(200);
    expect((await browser.get('/api/v1/ui/org')).statusCode).toBe(200);
    expect(await testSessions(db)).toBe(1);
    // Not through the api: the tracker does not see it, so the reset leaves it.
    await query(db, `update platform.app_user set display_name = 'Changed in the database' where handle = 'rina'`);
    expect(app.get(TestWriteTracker).changed).toBe(false);

    expect((await new Browser(app).post(RESET, undefined)).statusCode).toBe(200);
    expect(await testSessions(db)).toBe(0);
    expect((await browser.get('/api/v1/me')).statusCode).toBe(401);
    expect(await displayName(db)).toBe('Changed in the database');
  });

  it('a write through the api makes the next reset recreate the database', async () => {
    const browser = new Browser(app);
    // Any request other than GET, HEAD or OPTIONS counts, whatever its answer.
    const login = await browser.post('/api/v1/auth/login', { email: 'rina.kusuma@nusantaradigital.co.id', password: 'not the password' });
    expect(login.statusCode).toBeGreaterThanOrEqual(400);
    expect(app.get(TestWriteTracker).changedBy).toBe('POST /api/v1/auth/login');

    expect((await new Browser(app).post(RESET, undefined)).statusCode).toBe(200);
    expect(await displayName(db)).toBe(seeded);
  });

  it('an audit entry written by the api counts as a write', async () => {
    expect(app.get(TestWriteTracker).changed).toBe(false);
    await query(db, `update platform.app_user set display_name = 'Changed again' where handle = 'rina'`);
    const audit = app.get<AuditWriter>(AUDIT_WRITER, { strict: false });
    await audit.recordDetached({ action: 'platform.test.reset_tracking', targetType: 'system', targetId: 'reset-tracking' } as never, null).catch(() => undefined);
    expect(app.get(TestWriteTracker).changedBy).toBe('audit platform.test.reset_tracking');

    expect((await new Browser(app).post(RESET, undefined)).statusCode).toBe(200);
    expect(await displayName(db)).toBe(seeded);
  });
});
