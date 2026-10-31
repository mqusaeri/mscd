// Helpers of the retention and disposal tests (Milestone 3 D.8, M3-06): an api application on the demo template with
// the storage, files, jobs and retention modules against a real storage gateway on SeaweedFS (vault deletes, R-20: the
// bucket is the test's own), the `retention.review` job called in process, a settable "today" (the clock's fixed date),
// and SQL fixtures of items of every record class in an organisation's system.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { RawBuilder } from 'kysely';
import { Logger } from 'nestjs-pino';
import { Clock } from '../../../src/common/clock';
import { GATEWAY_CLIENT, JOB_QUEUE, type GatewayClient, type JobQueue, type Trx } from '../../../src/common/tokens';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { FilesModule } from '../../../src/modules/files/files.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { JobsModule } from '../../../src/modules/jobs/jobs.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { RetentionModule } from '../../../src/modules/retention/retention.module';
import { RetentionReviewJob } from '../../../src/modules/retention/retention-review.job';
import type { RetentionReviewResult } from '../../../src/modules/retention/retention-review.service';
import { StorageGatewayContext } from '../../../src/modules/storage';
import { StorageModule } from '../../../src/modules/storage/storage.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import type { TestDatabase } from '../../setup/test-db';
import { JOB_TEST_ENV } from '../jobs/helpers';
import { ORG_IDS, inOrg, type DemoOrg } from '../files/helpers';

export interface RetentionApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  jobs: JobQueue;
  gateway: GatewayClient;
  /** Sets the organisation's "today" (`demo.fixed_today`), or back to the profile's date with null. */
  setToday(day: string | null): void;
  /** Runs `retention.review` for a demo organisation on today's date. */
  review(org: DemoOrg): Promise<RetentionReviewResult>;
  close(): Promise<void>;
}

/** The api modules of the retention routes and job on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createRetentionApp(db: TestDatabase, gatewayUrl: string): Promise<RetentionApp> {
  const settings = { ...JOB_TEST_ENV, MSCD__MAIL__SMTP__PORT: '9', MSCD__STORAGE__GATEWAY__URL: gatewayUrl };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      { imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, StorageModule, FilesModule, JobsModule, RetentionModule] },
      settings,
    )
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const clock = moduleRef.get(Clock);
  const profileToday = clock.fixedToday;
  let today: string | null = null;
  Object.defineProperty(clock, 'fixedToday', { configurable: true, get: () => today ?? profileToday });
  return {
    app,
    moduleRef,
    jobs: moduleRef.get<JobQueue>(JOB_QUEUE),
    gateway: moduleRef.get<GatewayClient>(GATEWAY_CLIENT),
    setToday: (day) => {
      today = day;
    },
    review: async (org) => (await moduleRef.get(RetentionReviewJob).run(ORG_IDS[org]))!,
    close: () => app.close(),
  };
}

/** The id of a system of a demo organisation. */
export async function msIdOf(db: TestDatabase, org: DemoOrg, slug: string): Promise<string> {
  return inOrg(db, org, async (trx) => (await trx.selectFrom('management_system').select('id').where('slug', '=', slug).executeTakeFirstOrThrow()).id);
}

/** The id of a storage repository of a demo organisation by slug. */
export async function repositoryIdOf(db: TestDatabase, org: DemoOrg, slug: string): Promise<string> {
  return inOrg(db, org, async (trx) => (await trx.selectFrom('storage_repository').select('id').where('slug', '=', slug).where('deleted_at', 'is', null).executeTakeFirstOrThrow()).id);
}

/** A storage object row without bytes (items whose content the test does not read). */
export async function insertObject(trx: Trx, repositoryId: string, name: string, userId: string): Promise<string> {
  const row = await trx
    .insertInto('storage_object')
    .values({
      storage_repository_id: repositoryId,
      external_item_id: `retention-test-${name}-${Math.random().toString(36).slice(2, 10)}`,
      version_label: 'v1',
      display_name: name,
      mime_type: 'application/pdf',
      size_bytes: '10',
      hash_algorithm: 'sha256',
      hash_value: 'b'.repeat(64),
      hash_source: 'computed',
      created_by: userId,
      updated_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A document of a system with a superseded version and a current approved one (replaced on `replacedOn`). */
export async function insertDocumentWithVersions(
  trx: Trx,
  input: { msId: string; code: string; docType: string; ownerId: string; oldObjectId: string; currentObjectId: string; oldApprovedOn: string; replacedOn: string },
): Promise<{ documentId: string; oldVersionId: string; currentVersionId: string }> {
  const doc = await trx
    .insertInto('document')
    .values({ doc_code: input.code, title: `Retention test ${input.code}`, doc_type: input.docType, status: 'approved', owner_user_id: input.ownerId, approved_at: input.replacedOn, next_review_at: '2027-09-01' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.insertInto('entity_ms_link').values({ entity_type: 'document', entity_id: doc.id, management_system_id: input.msId, is_primary: true }).execute();
  const old = await trx
    .insertInto('document_version')
    .values({ document_id: doc.id, version_label: '1.0', storage_object_id: input.oldObjectId, status: 'superseded', approved_at: input.oldApprovedOn, created_at: new Date(`${input.oldApprovedOn}T01:00:00Z`) })
    .returning('id')
    .executeTakeFirstOrThrow();
  const current = await trx
    .insertInto('document_version')
    .values({ document_id: doc.id, version_label: '2.0', storage_object_id: input.currentObjectId, status: 'approved', approved_at: input.replacedOn, created_at: new Date(`${input.replacedOn}T01:00:00Z`) })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.updateTable('document').set({ current_version_id: current.id }).where('id', '=', doc.id).execute();
  return { documentId: doc.id, oldVersionId: old.id, currentVersionId: current.id };
}

/** The reviews of an item. */
export async function reviewsOf(db: TestDatabase, org: DemoOrg, itemId: string) {
  return inOrg(db, org, (trx) => trx.selectFrom('retention_review').selectAll().where('item_id', '=', itemId).orderBy('created_at').orderBy('id').execute());
}

/** The audit entries of an entity, oldest first. */
export async function auditOf(db: TestDatabase, org: DemoOrg, entityId: string) {
  return inOrg(db, org, (trx) =>
    trx.selectFrom('audit_trail').select(['action', 'entity_type', 'entity_code', 'before_data', 'after_data', 'actor_user_id']).where('entity_id', '=', entityId).orderBy('seq').execute(),
  );
}

/** Stat of a vault object at the gateway: `found` while its bytes are stored. */
export async function vaultStat(ctx: RetentionApp, db: TestDatabase, org: DemoOrg, objectId: string): Promise<string> {
  const storage = ctx.moduleRef.get(StorageGatewayContext);
  return inOrg(db, org, async (trx) => {
    const object = await trx.selectFrom('storage_object').selectAll().where('id', '=', objectId).executeTakeFirstOrThrow();
    const repository = await trx.selectFrom('storage_repository').selectAll().where('id', '=', object.storage_repository_id).executeTakeFirstOrThrow();
    const answer = await ctx.gateway.post<{ outcome: string }>('/v1/stat', {
      tenant: await storage.tenant(trx, ORG_IDS[org]),
      repository: await storage.repository(trx, repository, { withCredential: false }),
      object: {
        externalItemId: object.external_item_id,
        externalVersionId: object.external_version_id,
        hashAlgorithm: object.hash_algorithm,
        hashValue: object.hash_value,
        hashSource: object.hash_source,
        folderPath: object.folder_path,
      },
    });
    return answer.outcome;
  });
}

/** Rows of a raw query in a demo organisation. */
export async function rowsOf<T>(db: TestDatabase, org: DemoOrg, query: RawBuilder<T>): Promise<T[]> {
  return inOrg(db, org, async (trx) => (await query.execute(trx)).rows);
}
