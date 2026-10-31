// Helpers of the verified deletion tests (Milestone 3 D.5, M3-03): a storage gateway on a SeaweedFS container and a
// Mailpit container (R-20: purges run only against these throwaway services and the test database), the multi-tenancy
// api application with the gateway and the mail server, organisations whose data key the gateway issued (so the purge
// can drop it), vault objects of an organisation, and readers of the rows the purge changes.
import { randomBytes } from 'node:crypto';
import { ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { API_ROUTES } from '@mscd/shared';
import { sql } from 'kysely';
import type { JobName } from '../../../src/common/jobs/job-queue';
import { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { JOB_QUEUE } from '../../../src/common/tokens';
import { GatewayDataKeyIssuer, type CreatedTenant } from '../../../src/db/tenant-provisioner';
import { createTenant } from '../../setup/global-db';
import type { TestDatabase } from '../../setup/test-db';
import type { FullApp } from '../contract/harness';
import { GATEWAY_TOKEN, VAULT_BUCKET, gatewayConfig, putObject, startGateway, startSeaweed, vaultEnv, type RunningGateway, type Seaweed } from '../gateway/helpers';
import { startMailpit, type Mailpit } from '../identity/helpers';
import { createOnboardingApp, inPlatform, inTenant } from '../onboarding/helpers';

export { MULTI } from '../entitlements/helpers';

export const route = (id: string) => API_ROUTES.find((r) => r.id === id)!;
export const DELETION_GET = route('ops.deletion.get');
export const DELETION_SCHEDULE = route('ops.deletion.schedule');
export const DELETION_CANCEL = route('ops.deletion.cancel');
export const DELETION_RETRY = route('ops.deletion.retry');
export const DELETION_CERTIFICATE = route('ops.deletion.certificate');
export const STATUS = route('ops.organizations.status');

export const DAY = 86_400_000;

/** The throwaway storage and mail services of a test file. */
export interface DeletionStack {
  seaweed: Seaweed;
  gateway: RunningGateway;
  mail: Mailpit;
  close(): Promise<void>;
}

export async function startDeletionStack(): Promise<DeletionStack> {
  const seaweed = await startSeaweed();
  const gateway = await startGateway(gatewayConfig(vaultEnv(seaweed)));
  const mail = await startMailpit();
  return {
    seaweed,
    gateway,
    mail,
    close: async () => {
      await gateway.close().catch(() => undefined);
      await seaweed.stop().catch(() => undefined);
      await mail.stop().catch(() => undefined);
    },
  };
}

/** The api application in multi tenancy with the gateway and the mail server of the stack. */
export async function createDeletionApp(db: TestDatabase, stack: DeletionStack, env: Record<string, string> = {}): Promise<FullApp> {
  return createOnboardingApp(db, {
    mail: stack.mail,
    env: { MSCD__TENANCY__MODE: 'multi', MSCD__TENANCY__ISOLATION: 'schema', MSCD__STORAGE__GATEWAY__URL: stack.gateway.url, ...env },
  });
}

/** An organisation whose data key the stack's gateway issued (so the purge can drop it and its vault objects open). */
export async function createVaultTenant(db: TestDatabase, stack: DeletionStack, slug: string, options: { id?: string; name?: string } = {}): Promise<CreatedTenant> {
  const dataKeys = new GatewayDataKeyIssuer({ url: stack.gateway.url, token: GATEWAY_TOKEN });
  return createTenant(db, slug, { dataKeys, ...(options.id ? { id: options.id } : {}), name: options.name ?? `PT ${slug}` });
}

/** Stores one object in the organisation's Managed Vault through the gateway; returns its object key. */
export async function putVaultObject(db: TestDatabase, stack: DeletionStack, tenant: CreatedTenant, fileName = 'Register.csv'): Promise<string> {
  const key = await inPlatform(db, (trx) => trx.selectFrom('platform.tenant_key').select('wrapped_dek').where('organization_id', '=', tenant.id).executeTakeFirstOrThrow());
  const repository = await inTenant(db, tenant, (trx) =>
    trx.selectFrom('storage_repository').select(['id', 'slug', 'adapter', 'modes', 'config']).where('id', '=', tenant.vaultRepositoryId).executeTakeFirstOrThrow(),
  );
  const reply = await putObject(
    stack.gateway.url,
    {
      tenant: { orgId: tenant.id, wrappedDek: key.wrapped_dek },
      repository: { id: repository.id, slug: repository.slug, adapter: repository.adapter, modes: repository.modes, config: repository.config },
      scopeRoot: { folderId: null, path: 'ISMS' },
      folderPath: 'A.5.1',
      fileName,
      maxBytes: 1024 * 1024,
      metadataMinimization: false,
    },
    Buffer.concat([Buffer.from('code,name\n'), randomBytes(256)]),
  );
  if (reply.status !== 200) throw new Error(`put failed: ${reply.status} ${reply.body.toString('utf8')}`);
  return reply.json<{ externalItemId: string }>().externalItemId;
}

/** Every object version and delete marker below a prefix of the vault bucket. */
export async function vaultVersions(stack: DeletionStack, prefix: string): Promise<string[]> {
  const listed = await stack.seaweed.s3.send(new ListObjectVersionsCommand({ Bucket: VAULT_BUCKET, Prefix: prefix }));
  return [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].map((v) => v.Key!).filter(Boolean);
}

/** The in-memory job queue of the test application. */
export function jobsOf(full: FullApp): InMemoryJobQueue {
  return full.get<InMemoryJobQueue>(JOB_QUEUE);
}

/** Payloads of the waiting jobs of one name. */
export function waiting(full: FullApp, name: JobName): unknown[] {
  return jobsOf(full).waitingJobs(name).map((j) => j.env.payload);
}

/** The deletion rows of an organisation, oldest first. */
export async function deletionsOf(db: TestDatabase, orgId: string) {
  return inPlatform(db, (trx) =>
    trx
      .selectFrom('platform.organization_deletion')
      .selectAll()
      .where('organization_id', '=', orgId)
      .orderBy('created_at')
      .orderBy('id')
      .execute(),
  );
}

/** The organisation row (status and lifecycle columns). */
export async function orgRow(db: TestDatabase, orgId: string) {
  return inPlatform(db, (trx) => trx.selectFrom('platform.organization').select(['status', 'offboarding_ends_at', 'slug', 'name']).where('id', '=', orgId).executeTakeFirstOrThrow());
}

/** True when the schema exists. */
export async function schemaExists(db: TestDatabase, schema: string): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`select to_regnamespace(${schema}) is not null as found`.execute(db.migrator);
  return rows[0]!.found;
}

/** Moves the deletion of an organisation to a past date (as the database owner; fixtures only). */
export async function makeDue(db: TestDatabase, orgId: string): Promise<void> {
  await db.migrator.transaction().execute(async (trx) => {
    await sql`select set_config('app.platform_scope', 'on', true)`.execute(trx);
    await sql`update platform.organization_deletion set scheduled_for = now() - interval '1 minute' where organization_id = ${orgId} and status in ('scheduled', 'running')`.execute(trx);
  });
}

/** The platform audit entries of an organisation, oldest first. */
export async function platformEntries(db: TestDatabase, orgId: string) {
  return inPlatform(db, (trx) =>
    trx
      .selectFrom('platform.audit_log')
      .select(['seq', 'action', 'actor_user_id', 'entity_code', 'before_data', 'after_data', 'source_ip', 'user_agent', 'redacted_at', 'redaction_id'])
      .where('organization_id', '=', orgId)
      .orderBy('seq')
      .execute(),
  );
}
