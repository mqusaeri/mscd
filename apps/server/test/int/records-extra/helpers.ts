// Helpers of the Milestone 2 M2-07 tests: an api application on a copy of the demo template with the real session
// resolver, authorisation, licence service, rule engine, the implementation, register, risk register and audit
// register commands (with their Milestone 2 sub-modules), the jobs of `tasks.overdue` and the `ui` and per-screen
// reads; sessions, clients and fixture queries come from the WP-20 helpers.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql, type RawBuilder } from 'kysely';
import { Logger } from 'nestjs-pino';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { AuditRegistersModule } from '../../../src/modules/audit-registers/audit-registers.module';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { ImplementationModule } from '../../../src/modules/implementation/implementation.module';
import { JobsModule } from '../../../src/modules/jobs/jobs.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { ReadModelApiModule } from '../../../src/modules/read-model-api/read-model-api.module';
import { RegistersModule } from '../../../src/modules/registers/registers.module';
import { RiskRegistersModule } from '../../../src/modules/risk-registers/risk-registers.module';
import { RulesModule } from '../../../src/modules/rules/rules.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { UiModule } from '../../../src/modules/ui/ui.module';
import type { TestDatabase } from '../../setup/test-db';
import { inOrg, type CommandsApp, type DemoOrg } from '../commands-implementation/helpers';

export {
  APP_ORIGIN, Client, ORG_IDS, auditOf, inOrg, sessionFor, userId, verifyChain, type CommandsApp, type DemoOrg, type Reply,
} from '../commands-implementation/helpers';

/** `demo.fixed_today` of the test profile. */
export const TODAY = '2026-09-29';

/** The api modules the M2-07 routes need, on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createExtraApp(db: TestDatabase, env: Record<string, string> = {}): Promise<CommandsApp> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9', ...env };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      {
        imports: [
          TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, RulesModule, JobsModule, ImplementationModule,
          RegistersModule, RiskRegistersModule, AuditRegistersModule, UiModule, ReadModelApiModule,
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

/** Rows of a query run as the migrator inside an organisation's schema. */
export function rowsOf<T>(db: TestDatabase, org: DemoOrg, query: RawBuilder<T>): Promise<T[]> {
  return inOrg(db, org, async (trx) => (await query.execute(trx)).rows);
}

/** `management_system.id` and `framework_version_id` of a system by slug. */
export async function systemOf(db: TestDatabase, org: DemoOrg, slug: string): Promise<{ id: string; version: string }> {
  const [row] = await rowsOf<{ id: string; version: string }>(db, org, sql`
    select id, framework_version_id as version from management_system where slug = ${slug} and deleted_at is null`);
  if (!row) throw new Error(`No system ${slug} in ${org}`);
  return row;
}

/** A user id by handle. */
export async function idOf(db: TestDatabase, org: DemoOrg, handle: string): Promise<string> {
  const [row] = await rowsOf<{ id: string }>(db, org, sql`select id from platform.app_user where handle = ${handle}`);
  if (!row) throw new Error(`No user ${handle}`);
  return row.id;
}

/** The ETag header value of a record version (`W/"<ms>"`, D.1). */
export function etagOf(updatedAt: Date | string): string {
  return `W/"${new Date(updatedAt).getTime()}"`;
}

/** Notifications of a user of one kind, newest first. */
export function notificationsOf(db: TestDatabase, org: DemoOrg, handle: string, kind: string) {
  return rowsOf<{ id: string; title_en: string; body_en: string; entity_id: string | null }>(db, org, sql`
    select n.id, n.title_en, n.body_en, n.entity_ref->>'id' as entity_id from notification n join platform.app_user u on u.id = n.recipient_user_id
     where u.handle = ${handle} and n.kind = ${kind} order by n.created_at desc, n.id`);
}

/** Audit entries of an action, oldest first, with the actor's handle and the stored before and after values. */
export function auditByAction(db: TestDatabase, org: DemoOrg, action: string) {
  return rowsOf<{ entity_type: string | null; entity_id: string | null; entity_code: string | null; actor: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
    db,
    org,
    sql`select a.entity_type, a.entity_id, a.entity_code, u.handle as actor, a.before_data as before, a.after_data as after
          from audit_trail a left join platform.app_user u on u.id = a.actor_user_id
         where a.action = ${action} order by a.seq`,
  );
}
