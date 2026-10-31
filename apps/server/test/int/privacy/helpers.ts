// Helpers of the tests of requests from one person (Milestone 3 D.6, M3-04): an api application with the privacy,
// export, admin-user, audit and `ui` modules and the jobs module (for `cleanup.expired`), clients signed in as demo
// users with their CSRF token (in any organisation, so a shared account can be followed into its other organisation),
// an invented member with no other organisation (R-19), and fixture queries run as the migrator.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { InjectOptions } from 'fastify';
import { sql, type RawBuilder } from 'kysely';
import { Logger } from 'nestjs-pino';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { AdminUsersModule } from '../../../src/modules/admin-users/admin-users.module';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { ExportsModule } from '../../../src/modules/exports/exports.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { SessionService } from '../../../src/modules/identity/session.service';
import { JobsModule } from '../../../src/modules/jobs/jobs.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { PrivacyModule } from '../../../src/modules/privacy/privacy.module';
import { RiskRegistersModule } from '../../../src/modules/risk-registers/risk-registers.module';
import { RulesModule } from '../../../src/modules/rules/rules.module';
import { StorageModule } from '../../../src/modules/storage/storage.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { UiModule } from '../../../src/modules/ui/ui.module';
import type { TestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { inOrg, ORG_IDS, userId, type DemoOrg } from '../commands-implementation/helpers';

export { inOrg, ORG_IDS, userId, type DemoOrg } from '../commands-implementation/helpers';
export { startStorageStack, type StorageStack } from '../files/helpers';

export const COOKIE = 'mscd_session';
export const APP_ORIGIN = 'http://localhost:4174';

export interface PrivacyApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  queue: InMemoryJobQueue;
  close(): Promise<void>;
}

/**
 * The api modules the routes of D.6 need, on the test profile, with the storage gateway at `gatewayUrl` when given; the
 * registers too, for a competence record about a person (D.6.5).
 */
export async function createPrivacyApp(db: TestDatabase, gatewayUrl?: string, env: Record<string, string> = {}): Promise<PrivacyApp> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9', ...(gatewayUrl ? { MSCD__STORAGE__GATEWAY__URL: gatewayUrl } : {}), ...env };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      {
        imports: [
          TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, RulesModule, StorageModule, NotificationsModule,
          JobsModule, AdminUsersModule, ExportsModule, PrivacyModule, UiModule, RiskRegistersModule,
        ],
      },
      settings,
    )
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, moduleRef, queue: moduleRef.get(JOB_QUEUE) as InMemoryJobQueue, close: () => app.close() };
}

/** A JSON answer as the tests read it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface Answer<T = Json> {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: T;
  text: string;
  raw: Buffer;
}

/** A client with one session cookie and its CSRF token. */
export class Client {
  constructor(
    private readonly app: NestFastifyApplication,
    readonly cookie: string,
    private readonly csrf: string,
    readonly handle: string,
    readonly userId: string,
  ) {}

  async call<T = Json>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Answer<T>> {
    const all: Record<string, string> = { cookie: `${COOKIE}=${this.cookie}`, ...headers };
    if (method !== 'GET') {
      all.origin = APP_ORIGIN;
      all['x-csrf-token'] = this.csrf;
    }
    const init: InjectOptions = { method, url, headers: all };
    if (payload !== undefined) init.payload = payload as InjectOptions['payload'];
    const response = await this.app.inject(init);
    const text = response.body;
    const type = String(response.headers['content-type'] ?? '');
    const body = (type.includes('json') && text ? JSON.parse(text) : undefined) as T;
    return { status: response.statusCode, headers: response.headers, body, text, raw: response.rawPayload };
  }

  get<T = Json>(url: string): Promise<Answer<T>> {
    return this.call<T>('GET', url);
  }

  post<T = Json>(url: string, payload?: unknown, headers?: Record<string, string>): Promise<Answer<T>> {
    return this.call<T>('POST', url, payload ?? {}, headers);
  }

  patch<T = Json>(url: string, payload: unknown, headers?: Record<string, string>): Promise<Answer<T>> {
    return this.call<T>('PATCH', url, payload, headers);
  }
}

/** A client signed in as a user (by handle) in an organisation (session written through `SessionService`). */
export async function signIn(ctx: PrivacyApp, db: TestDatabase, handle: string, org: DemoOrg): Promise<Client> {
  const id = await userId(db, handle);
  const sessions = ctx.moduleRef.get(SessionService);
  const scope = ctx.moduleRef.get(TenantScope);
  const orgId = ORG_IDS[org];
  const issued = await scope.withTenant({ orgId, schema: `org_${org}`, userId: id }, (trx) => {
    const now = new Date();
    return sessions.create(trx, {
      userId: id,
      organizationId: orgId,
      authOrgId: orgId,
      state: 'active',
      authMethod: 'local',
      identityProviderId: null,
      authGrantId: null,
      passwordAt: now,
      mfaAt: now,
    });
  });
  return new Client(ctx.app, issued.cookieValue, issued.csrfToken, handle, id);
}

/** Rows of a query run as the migrator inside an organisation's schema. */
export function rowsOf<T>(db: TestDatabase, org: DemoOrg, query: RawBuilder<T>): Promise<T[]> {
  return inOrg(db, org, async (trx) => (await query.execute(trx)).rows);
}

/** Rows of a query run as the migrator with platform scope. */
export function platformRows<T>(db: TestDatabase, query: RawBuilder<T>): Promise<T[]> {
  return inScope(db.migrator, { platformScope: true }, async (trx) => (await query.execute(trx)).rows);
}

/**
 * An invented member (R-19) of one organisation only, with a business role there: an account that the erasure
 * anonymises because no other membership keeps it.
 */
export async function inventedMember(db: TestDatabase, org: DemoOrg, person: { handle: string; displayName: string; email: string; jobTitle: string; role?: string; ms?: string }): Promise<string> {
  const [user] = await platformRows<{ id: string }>(db, sql`
    insert into platform.app_user (handle, email, display_name, job_title, kind, status)
    values (${person.handle}, ${person.email}, ${person.displayName}, ${person.jobTitle}, 'person', 'active') returning id`);
  await platformRows(db, sql`
    insert into platform.org_membership (organization_id, user_id, status, admin_roles)
    values (${ORG_IDS[org]}::uuid, ${user!.id}::uuid, 'active', '{}') returning user_id`);
  if (person.role) {
    await rowsOf(db, org, sql`
      insert into user_ms_role (management_system_id, user_id, role, is_primary, approval_status)
      select m.id, ${user!.id}::uuid, ${person.role}, false, 'active' from management_system m where m.slug = ${person.ms ?? 'isms'} returning id`);
  }
  return user!.id;
}

/** The primary Management System Manager of each system of an organisation, by slug. */
export async function primaryManagers(db: TestDatabase, org: DemoOrg): Promise<Map<string, string | null>> {
  const rows = await rowsOf<{ slug: string; handle: string | null }>(db, org, sql`
    select m.slug, (select u.handle from user_ms_role r join platform.app_user u on u.id = r.user_id
                     where r.management_system_id = m.id and r.role = 'ms_manager' and r.is_primary and r.deleted_at is null
                       and r.approval_status = 'active' order by r.created_at limit 1) as handle
      from management_system m where m.deleted_at is null order by m.position, m.slug`);
  return new Map(rows.map((r) => [r.slug, r.handle]));
}
