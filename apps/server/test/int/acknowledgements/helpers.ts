// Helpers of the read confirmation tests (Milestone 3 D.7, M3-05): the storage stack of the file tests (SeaweedFS, the
// mock providers with the demo fixture and a storage gateway), an api application with the register, file and
// acknowledgement modules and the `ui` reads, clients signed in as demo users with their CSRF token, and fixture
// queries run as the migrator inside an organisation's schema.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { InjectOptions } from 'fastify';
import { sql, type RawBuilder } from 'kysely';
import { Logger } from 'nestjs-pino';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { AcknowledgementsModule } from '../../../src/modules/acknowledgements/acknowledgements.module';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { FilesModule } from '../../../src/modules/files/files.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { SessionService } from '../../../src/modules/identity/session.service';
import { ImplementationModule } from '../../../src/modules/implementation/implementation.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { ReadModelApiModule } from '../../../src/modules/read-model-api/read-model-api.module';
import { RegistersModule } from '../../../src/modules/registers/registers.module';
import { RulesModule } from '../../../src/modules/rules/rules.module';
import { StorageModule } from '../../../src/modules/storage/storage.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { UiModule } from '../../../src/modules/ui/ui.module';
import type { TestDatabase } from '../../setup/test-db';
import { inOrg, ORG_IDS, userId, type DemoOrg } from '../commands-implementation/helpers';

export { auditOf, inOrg, ORG_IDS, userId, verifyChain, type DemoOrg } from '../commands-implementation/helpers';
export { startStorageStack, type StorageStack } from '../files/helpers';

export const COOKIE = 'mscd_session';
export const APP_ORIGIN = 'http://localhost:4174';
/** `demo.fixed_today` of the test profile. */
export const TODAY = '2026-09-29';

export interface AckApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  queue: InMemoryJobQueue;
  close(): Promise<void>;
}

/** The api modules the read confirmation routes need, on the test profile, with the storage gateway at `gatewayUrl`. */
export async function createAckApp(db: TestDatabase, gatewayUrl: string, env: Record<string, string> = {}): Promise<AckApp> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9', MSCD__STORAGE__GATEWAY__URL: gatewayUrl, ...env };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      {
        imports: [
          TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, RulesModule, ImplementationModule, StorageModule,
          FilesModule, RegistersModule, AcknowledgementsModule, UiModule, ReadModelApiModule,
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

/** A JSON answer as the tests read it: command results, problems and items, checked member by member. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface Answer<T = Json> {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: T;
  text: string;
}

/** A client with one session cookie and its CSRF token. */
export class AckClient {
  constructor(
    private readonly app: NestFastifyApplication,
    private readonly cookie: string,
    private readonly csrf: string,
    readonly handle: string,
    readonly userId: string,
  ) {}

  async call<T = Json>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Answer<T>> {
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
    return { status: response.statusCode, headers: response.headers, body, text };
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

/** A client signed in as a demo user in an organisation (session written through `SessionService`). */
export async function signIn(ctx: AckApp, db: TestDatabase, handle: string, org: DemoOrg): Promise<AckClient> {
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
  return new AckClient(ctx.app, issued.cookieValue, issued.csrfToken, handle, id);
}

/** Rows of a query run as the migrator inside an organisation's schema. */
export function rowsOf<T>(db: TestDatabase, org: DemoOrg, query: RawBuilder<T>): Promise<T[]> {
  return inOrg(db, org, async (trx) => (await query.execute(trx)).rows);
}

/** A document of a system by code: its id, current version and its stored file. */
export async function documentOf(db: TestDatabase, org: DemoOrg, code: string): Promise<{ id: string; versionId: string | null; objectId: string | null; status: string }> {
  const [row] = await rowsOf<{ id: string; current_version_id: string | null; storage_object_id: string | null; status: string }>(db, org, sql`
    select d.id, d.current_version_id, v.storage_object_id, d.status from document d left join document_version v on v.id = d.current_version_id
     where d.doc_code = ${code} and d.deleted_at is null`);
  if (!row) throw new Error(`No document ${code} in ${org}`);
  return { id: row.id, versionId: row.current_version_id, objectId: row.storage_object_id, status: row.status };
}

/**
 * Puts a new version of a document in review, submitted by `submitter`, with the file of its current version, or of
 * the current version of `fileOf` for a document without one (as `POST .../versions` leaves it, A.4 5.7). Returns the
 * version id.
 */
export async function versionInReview(db: TestDatabase, org: DemoOrg, code: string, label: string, submitter: string, fileOf?: string): Promise<string> {
  const doc = await documentOf(db, org, code);
  const objectId = fileOf ? (await documentOf(db, org, fileOf)).objectId : doc.objectId;
  const submitterId = await userId(db, submitter);
  const [version] = await rowsOf<{ id: string }>(db, org, sql`
    insert into document_version (document_id, version_label, storage_object_id, status, submitted_by, submitted_at)
    values (${doc.id}, ${label}, ${objectId}, 'in_review', ${submitterId}, now()) returning id`);
  await rowsOf(db, org, sql`update document set status = 'in_review', review_started_at = ${TODAY} where id = ${doc.id} returning id`);
  return version!.id;
}

/** The people a request asks (handle and status), by handle. */
export async function peopleOfRequest(db: TestDatabase, org: DemoOrg, requestId: string): Promise<{ handle: string; status: string; reminder_count: number; excused_reason: string | null; opened_at: Date | null }[]> {
  return rowsOf(db, org, sql`
    select u.handle, a.status, a.reminder_count, a.excused_reason, a.opened_at from acknowledgement a join platform.app_user u on u.id = a.user_id
     where a.acknowledgement_request_id = ${requestId} order by u.handle`);
}

/**
 * The expected audience of a document in `systems` (D.7): active members of kind person with an active business role
 * other than the external auditor in one of the systems, optionally only the given roles.
 */
export async function expectedAudience(db: TestDatabase, org: DemoOrg, systems: readonly string[], roles?: readonly string[]): Promise<string[]> {
  const rows = await rowsOf<{ handle: string }>(db, org, sql`
    select distinct u.handle from user_ms_role r
      join management_system m on m.id = r.management_system_id and m.deleted_at is null
      join platform.app_user u on u.id = r.user_id and u.status = 'active' and u.deleted_at is null and u.kind = 'person'
      join platform.org_membership om on om.user_id = r.user_id and om.organization_id = ${ORG_IDS[org]}::uuid and om.status = 'active'
       and om.deleted_at is null
     where m.slug = any(${[...systems]}::text[]) and r.deleted_at is null and r.approval_status = 'active'
       and (r.valid_until is null or r.valid_until > now()) and r.role <> 'external_auditor'
       and (${roles ? [...roles] : null}::text[] is null or r.role = any(${roles ? [...roles] : null}::text[]))
     order by u.handle`);
  return rows.map((r) => r.handle);
}
