// Helpers of the certification, internal audit and readiness tests (Milestone 2 M2-05): an api application on a copy of
// the demo template with the real session resolver, authorisation, licence service, rule engine, the audit event
// commands, the certification routes, the audit-side registers with the internal audit programme, the implementation
// commands with the readiness job, and the `ui` reads; a way to move the organisation's date (`demo.fixed_today` of the
// test profile); the three jobs of the package run on demand; fixture queries run as the migrator inside an
// organisation's schema. Sessions and requests reuse the client of the WP-20 command tests.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { CommandResult, Problem } from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import { Logger } from 'nestjs-pino';
import { Clock } from '../../../src/common/clock';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuditRegistersModule } from '../../../src/modules/audit-registers/audit-registers.module';
import { CycleDeriveJob } from '../../../src/modules/audit-registers/cycle-derive.job';
import type { CycleDeriveResult } from '../../../src/modules/audit-registers/cycle-derive.service';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { ImplementationModule } from '../../../src/modules/implementation/implementation.module';
import { ReadinessRecomputeJob } from '../../../src/modules/implementation/readiness/readiness-recompute.job';
import type { SystemReadiness } from '../../../src/modules/implementation/readiness/readiness.service';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import type { CertificateExpiryResult } from '../../../src/modules/management-systems/certification.expiry';
import { ManagementSystemsModule } from '../../../src/modules/management-systems/management-systems.module';
import { CertificateExpiryJob } from '../../../src/modules/notifications/certificate-expiry.job';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { RegistersModule } from '../../../src/modules/registers/registers.module';
import { RulesModule } from '../../../src/modules/rules/rules.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { UiModule } from '../../../src/modules/ui/ui.module';
import type { TestDatabase } from '../../setup/test-db';
import { inOrg, ORG_IDS, type DemoOrg } from '../commands-implementation/helpers';

export { auditOf, entriesWithStatus, entryOf, grantRole, inOrg, ORG_IDS, sessionFor, userId, verifyChain, type Client, type DemoOrg } from '../commands-implementation/helpers';

/** `demo.fixed_today` of the test profile. */
export const TODAY = '2026-09-29';

export type Reply = CommandResult & Problem;

export interface CertApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  queue: InMemoryJobQueue;
  /** Moves the date every command and job sees (null: back to `demo.fixed_today`). */
  setToday(day: string | null): void;
  /** Runs `certificate.expiry` for an organisation now. */
  expiry(org: DemoOrg): Promise<CertificateExpiryResult | null>;
  /** Runs `readiness.recompute` for an organisation now (one system, or every system when `msId` is null). */
  readiness(org: DemoOrg, msId?: string | null): Promise<SystemReadiness[]>;
  /** Runs `cycle.derive` for an organisation now. */
  derive(org: DemoOrg, msId?: string | null): Promise<CycleDeriveResult>;
  close(): Promise<void>;
}

/** The api modules of this package's routes and jobs, on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createCertApp(db: TestDatabase, env: Record<string, string> = {}): Promise<CertApp> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9', ...env };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      {
        imports: [
          TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, RulesModule, ManagementSystemsModule, ImplementationModule,
          RegistersModule, AuditRegistersModule, UiModule,
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
  const clock = moduleRef.get(Clock);
  let day: string | null = null;
  const fixed = Object.getOwnPropertyDescriptor(Clock.prototype, 'fixedToday')!.get!;
  Object.defineProperty(clock, 'fixedToday', { configurable: true, get: () => day ?? fixed.call(clock) });
  return {
    app,
    moduleRef,
    queue: moduleRef.get(JOB_QUEUE) as InMemoryJobQueue,
    setToday(next) {
      day = next;
    },
    expiry: (org) => moduleRef.get(CertificateExpiryJob).run(ORG_IDS[org]),
    readiness: (org, msId = null) => moduleRef.get(ReadinessRecomputeJob).run(ORG_IDS[org], msId),
    derive: (org, msId = null) => moduleRef.get(CycleDeriveJob).run(ORG_IDS[org], msId),
    close: () => app.close(),
  };
}

/** Rows of a query run as the migrator inside an organisation's schema. */
export function rowsOf<T>(db: TestDatabase, org: DemoOrg, query: RawBuilder<T>): Promise<T[]> {
  return inOrg(db, org, async (trx) => (await query.execute(trx)).rows);
}

/** Id, status and edition of a system by slug. */
export async function systemOf(db: TestDatabase, org: DemoOrg, ms: string): Promise<{ id: string; status: string; editionId: string; display: Record<string, unknown> }> {
  const [row] = await rowsOf<{ id: string; status: string; framework_version_id: string; display: Record<string, unknown> }>(
    db,
    org,
    sql`select id, status, framework_version_id, display from management_system where slug = ${ms} and deleted_at is null`,
  );
  if (!row) throw new Error(`No system ${ms} in ${org}`);
  return { id: row.id, status: row.status, editionId: row.framework_version_id, display: row.display };
}

export interface CycleFixture {
  id: string;
  status: string;
  cycle_start: string;
  cycle_end: string;
  certified_at: string | null;
  certificate_no: string | null;
  certificate_expires_at: string | null;
  certification_body: string | null;
  certified_scope: string | null;
  deleted_at: Date | null;
}

/** The live cycles of a system, newest first. */
export function cyclesOf(db: TestDatabase, org: DemoOrg, ms: string): Promise<CycleFixture[]> {
  return rowsOf<CycleFixture>(
    db,
    org,
    sql`select c.id, c.status, c.cycle_start, c.cycle_end, c.certified_at, c.certificate_no, c.certificate_expires_at::text, c.certification_body,
               c.certified_scope, c.deleted_at
          from certification_cycle c join management_system m on m.id = c.management_system_id and m.slug = ${ms}
         where c.deleted_at is null order by c.cycle_start desc, c.created_at desc`,
  );
}

/** Cycle items of one cycle with their definition code and status. */
export function cycleItemsIn(db: TestDatabase, org: DemoOrg, cycleId: string) {
  return rowsOf<{ id: string; def_code: string | null; status: string; due_at: string; owner: string | null }>(
    db,
    org,
    sql`select s.id, d.code as def_code, s.status, s.due_at, u.handle as owner from cycle_requirement_status s
          left join ref.cycle_requirement_def d on d.id = s.cycle_requirement_def_id
          left join platform.app_user u on u.id = s.owner_user_id
         where s.certification_cycle_id = ${cycleId} and s.deleted_at is null order by s.position`,
  );
}

/** Codes of the cycle requirement definitions of an edition. */
export async function defCodesOf(db: TestDatabase, editionId: string): Promise<string[]> {
  const { rows } = await sql<{ code: string }>`select code from ref.cycle_requirement_def where framework_version_id = ${editionId} order by sort_order, code`.execute(db.migrator);
  return rows.map((r) => r.code);
}

/** Notifications of a kind in an organisation, with the recipient's handle. */
export function notificationsOf(db: TestDatabase, org: DemoOrg, kind: string) {
  return rowsOf<{ handle: string; title_en: string; title_id: string; body_en: string; ms_id: string | null; ref_id: string | null }>(
    db,
    org,
    sql`select u.handle, n.title_en, n.title_id, n.body_en, n.management_system_id as ms_id, n.entity_ref ->> 'id' as ref_id
          from notification n join platform.app_user u on u.id = n.recipient_user_id
         where n.kind = ${kind} order by n.created_at, u.handle`,
  );
}

/** A document of a system, written as a fixture (status approved unless given). */
export async function addDocument(
  db: TestDatabase,
  org: DemoOrg,
  ms: string,
  doc: { code: string; type: string; status?: string; owner?: string; nextReviewAt?: string | null; orgWide?: boolean },
): Promise<string> {
  const { id: msId } = await systemOf(db, org, ms);
  return inOrg(db, org, async (trx) => {
    const { rows } = await sql<{ id: string }>`
      insert into document (doc_code, title, doc_type, status, owner_user_id, approved_at, next_review_at, is_org_wide)
      values (${doc.code}, ${`Fixture ${doc.code}`}, ${doc.type}, ${doc.status ?? 'approved'},
              (select id from platform.app_user where handle = ${doc.owner ?? 'rina'}),
              ${doc.status === undefined || doc.status === 'approved' ? sql`date '2026-01-10'` : sql`null`}, ${doc.nextReviewAt ?? null}, ${doc.orgWide ?? false})
      returning id`.execute(trx);
    const id = rows[0]!.id;
    await sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary) values ('document', ${id}, ${msId}, true)`.execute(trx);
    return id;
  });
}
