// `mscd-server backup verify` (Milestone 2 M2-S07): checks that an installation, typically one restored from the
// off-site backup, is complete and readable. It runs in the `cli` service (or any process with the api's secrets:
// db-app.url, platform.key, gateway.token and the gateway client certificate) and prints one JSON summary:
//
//   database      the app role connects; installation, organisations and their schemas
//   gateway       an authenticated call reaches the storage gateway, which wraps a throwaway data key with
//                 storage.key and opens it again (test-connection of a vault prefix that holds nothing)
//   platformKey   values sealed with platform.key (TOTP secrets, IdP client secrets, PKCE verifiers) open
//   organisations per organisation: its tenant data key opens in the gateway (storage.key, D-09: data keys are
//                 wrapped by the gateway's storage.key, which never leaves the gateway), the newest n vault
//                 objects open and match their stored SHA-256 (gateway re-hash), and its audit chain is intact
//                 and its head is covered by the newest signed anchor
//   auditChains   the platform chain and every tenant chain (F.11), with the anchor keys compiled into the build
//
// Exit code 0 when every check passed, 1 on any failure, 2 for refused options. The summary names organisations by
// id only (never slug, name or schema), so it can appear in a public workflow log (M2-S04, GL-50).
//
// `--write-probe` (test stacks only, MSCD_SAAS_TEST=1) first writes a small probe object into each organisation's
// Managed Vault with its storage_object row, and one probe value sealed with platform.key, so a backup taken
// afterwards holds data that a later `backup verify` must find again.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  AuditChainVerifyResult,
  DataKeyResponse,
  GatewayObjectRef,
  GatewayRepository,
  GatewayTenant,
  PutResult,
  RehashResult,
  TestConnectionResponse,
} from '@mscd/shared';
import type { Command } from 'commander';
import { sql } from 'kysely';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { createKysely } from '../db/kysely';
import type { DB } from '../db/types';
import { VERSION } from '../generated/build-info';
import { compiledAnchorKeys } from '../modules/audit/anchors';
import { AuditChainVerifier, PLATFORM_CHAIN, tenantChainName, type AnchorKeys } from '../modules/audit/chain-verifier';
import { FileKeyProvider } from '../modules/keys/file-key-provider';
import { GatewayProblemError, HttpGatewayClient } from '../modules/storage/gateway-client';
import { SYSTEM_USER_ID } from '../common/tokens';
import { TENANT_SCHEMA, TenantScope } from '../modules/tenancy/tenant-scope';

/** Vault objects opened per organisation when `--sample` is not given. */
export const DEFAULT_SAMPLE = 3;
/** Largest `--sample`. */
export const MAX_SAMPLE = 1000;
/** Sealed platform values opened per kind (newest first). */
const SEALED_SAMPLE = 50;
/** Text of the probes `--write-probe` writes (and the nonce of the sealed probe). */
export const PROBE_MARK = 'mscd-backup-probe';
/** How long a sealed probe value stays (the expiry clean-up removes it afterwards). */
const PROBE_SEALED_DAYS = 30;

/** The storage gateway calls `backup verify` makes (HttpGatewayClient; a stand-in in tests). */
export interface BackupGateway {
  post<T>(path: string, body: unknown): Promise<T>;
  putObject<T>(header: unknown, body: Readable): Promise<T>;
  onApplicationShutdown?(): Promise<void>;
}

export interface BackupVerifyOptions {
  /** Vault objects opened per organisation (newest first). */
  sample: number;
  /** Write probe objects first (refused unless MSCD_SAAS_TEST=1, checked by `parseVerifyOptions`). */
  writeProbe: boolean;
}

export interface BackupVerifyDeps {
  gateway?: BackupGateway;
  /** Anchor public keys to trust (default: the keys compiled into this build, D-16). */
  anchorKeys?: AnchorKeys;
  now?: () => Date;
}

export interface ChainSummary {
  /** `platform`, or `organisation` with its id. */
  scope: 'platform' | 'organisation';
  orgId?: string;
  ok: boolean;
  rows: number;
  firstBrokenSeq: number | null;
  /** The newest signed anchor is valid and the anchored row still has its hash (true when there is none yet). */
  anchorOk: boolean;
  /** `seq` of the newest anchor, null when the chain has none yet. */
  anchoredSeq: number | null;
}

export interface OrganisationSummary {
  id: string;
  status: string;
  ok: boolean;
  /** The tenant data key opened in the gateway (`ok`), did not open (`failed`), or is missing (`missing`). */
  dataKey: 'ok' | 'failed' | 'missing' | 'not-checked';
  /** Key id of the storage.key that wrapped the data key (from platform.tenant_key). */
  storageKeyId: string | null;
  objects: { sampled: number; opened: number; failed: number };
  probeWritten: boolean;
  auditChain: ChainSummary | null;
}

export interface BackupVerifySummary {
  ok: boolean;
  version: string;
  checkedAt: string;
  durationMs: number;
  sample: number;
  database: { ok: boolean; serverVersion: string | null; organisations: number; skipped: number };
  gateway: { ok: boolean; storageKeyId: string | null };
  platformKey: { ok: boolean; keyId: string | null; sealedValues: number; opened: number };
  auditChains: { ok: boolean; chains: number; rows: number; anchored: number };
  organisations: OrganisationSummary[];
  probes: { written: number } | null;
  failures: string[];
}

/** A failure as one line without names: the organisation id at most. */
function message(error: unknown): string {
  if (error instanceof GatewayProblemError) return `${error.gatewaySlug}${error.gatewayDetail ? `: ${error.gatewayDetail}` : ''}`;
  const text = error instanceof Error ? error.message : String(error);
  // Database errors may quote a schema name (org_<slug>); a summary names organisations by id only.
  return text.replace(/org_[a-z0-9_]+/g, 'org_[schema]').split('\n')[0]!.slice(0, 300);
}

/** The Managed Vault descriptor of an organisation prefix (no repository row is needed by the gateway). */
function vaultDescriptor(orgId: string, id: string = randomUUID()): GatewayRepository {
  return { id, slug: 'vault', adapter: 'managed_vault', modes: ['stored'], config: { prefix: `tenants/${orgId}/` } };
}

interface OrganisationRow {
  id: string;
  status: string;
  schema_name: string;
  schema_present: boolean;
}

/**
 * Runs every check and returns the summary; never throws for a failed check (each lands in `failures`). Throws
 * only for a configuration error (`ConfigError`), such as a missing secret file.
 */
export async function backupVerify(config: MscdConfig, options: BackupVerifyOptions, deps: BackupVerifyDeps = {}): Promise<BackupVerifySummary> {
  const now = deps.now ?? (() => new Date());
  const started = Date.now();
  const failures: string[] = [];
  const summary: BackupVerifySummary = {
    ok: false,
    version: VERSION,
    checkedAt: now().toISOString(),
    durationMs: 0,
    sample: options.sample,
    database: { ok: false, serverVersion: null, organisations: 0, skipped: 0 },
    gateway: { ok: false, storageKeyId: null },
    platformKey: { ok: false, keyId: null, sealedValues: 0, opened: 0 },
    auditChains: { ok: false, chains: 0, rows: 0, anchored: 0 },
    organisations: [],
    probes: options.writeProbe ? { written: 0 } : null,
    failures,
  };

  // Secrets are read first, so a missing file is a configuration error before anything connects.
  const databaseUrl = config.databaseUrl('app');
  const kms = config.profile.kms.file;
  const platformKeys = FileKeyProvider.fromFiles(kms.path, kms.previous_paths);
  summary.platformKey.keyId = platformKeys.kekId;

  const connection = createKysely<DB>({ connectionString: databaseUrl, max: 2, applicationName: 'mscd-backup-verify' });
  const gateway = deps.gateway ?? new HttpGatewayClient(config);
  const scope = new TenantScope(connection);
  const verifier = new AuditChainVerifier(scope, deps.anchorKeys ?? compiledAnchorKeys());
  try {
    // 1. Database.
    let organisations: OrganisationRow[] = [];
    const tenantKeys = new Map<string, { wrappedDek: string; kekId: string }>();
    try {
      const version = await sql<{ server_version: string }>`show server_version`.execute(connection);
      summary.database.serverVersion = version.rows[0]?.server_version.split(' ')[0] ?? null;
      await scope.withPlatform(
        async (trx) => {
          await trx.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow();
          organisations = await trx
            .selectFrom('platform.organization')
            .select(['id', 'status', 'schema_name', sql<boolean>`to_regnamespace(schema_name) IS NOT NULL`.as('schema_present')])
            .where('deleted_at', 'is', null)
            .orderBy('created_at')
            .orderBy('id')
            .execute();
          for (const key of await trx.selectFrom('platform.tenant_key').select(['organization_id', 'wrapped_dek', 'kek_id']).execute()) {
            tenantKeys.set(key.organization_id, { wrappedDek: key.wrapped_dek, kekId: key.kek_id });
          }
        },
        { scope: 'cli' },
      );
      summary.database.ok = true;
    } catch (error) {
      failures.push(`database: ${message(error)}`);
    }

    // 2. Gateway: a throwaway data key, wrapped and opened again by storage.key, and the vault bucket.
    try {
      const probeOrg = randomUUID();
      const key = await gateway.post<DataKeyResponse>('/v1/keys/data-key', { orgId: probeOrg });
      summary.gateway.storageKeyId = key.kekId;
      const test = await gateway.post<TestConnectionResponse>('/v1/test-connection', {
        tenant: { orgId: probeOrg, wrappedDek: key.wrappedDek },
        repository: vaultDescriptor(probeOrg),
      });
      if (test.status === 'ok') summary.gateway.ok = true;
      else failures.push(`gateway: the Managed Vault bucket is not reachable (${test.status})`);
    } catch (error) {
      failures.push(`gateway: ${message(error)}`);
    }

    // 3. Probes (test stacks): written before the checks, so the checks below find them.
    if (options.writeProbe && summary.database.ok) {
      try {
        await writeSealedProbe(scope, platformKeys, now());
      } catch (error) {
        failures.push(`probe: the sealed probe value was not written: ${message(error)}`);
      }
    }

    // 4. platform.key: sealed values open.
    if (summary.database.ok) {
      try {
        const sealed = await sealedPlatformValues(scope, now());
        summary.platformKey.sealedValues = sealed.length;
        for (const value of sealed) {
          try {
            const plain = await platformKeys.unwrap(value.sealed, value.aad);
            plain.fill(0);
            summary.platformKey.opened += 1;
          } catch {
            // Counted below; the value itself is never printed.
          }
        }
        const failed = summary.platformKey.sealedValues - summary.platformKey.opened;
        if (failed > 0) failures.push(`platform.key: ${failed} of ${sealed.length} sealed values do not open with platform.key ${platformKeys.kekId}`);
        else summary.platformKey.ok = true;
      } catch (error) {
        failures.push(`platform.key: ${message(error)}`);
      }
    }

    // 5. Organisations.
    for (const org of organisations) {
      if (!org.schema_present) {
        if (org.status === 'archived') {
          summary.database.skipped += 1;
          continue;
        }
        failures.push(`organisation ${org.id}: its schema is missing`);
        summary.organisations.push(emptyOrganisation(org));
        continue;
      }
      if (!TENANT_SCHEMA.test(org.schema_name)) {
        failures.push(`organisation ${org.id}: its schema name is not valid`);
        summary.organisations.push(emptyOrganisation(org));
        continue;
      }
      summary.organisations.push(await verifyOrganisation(org, tenantKeys.get(org.id) ?? null, { scope, verifier, gateway, options, failures, summary, now }));
    }
    summary.database.organisations = organisations.length;

    // 6. The platform chain.
    if (summary.database.ok) {
      try {
        const result = await verifier.verifyPlatform();
        const chain = await chainSummary(scope, result, PLATFORM_CHAIN, 'platform');
        if (!chain.ok) failures.push(chainFailure(chain));
        summary.auditChains.chains += 1;
        summary.auditChains.rows += chain.rows;
        if (chain.anchoredSeq !== null) summary.auditChains.anchored += 1;
        summary.auditChains.ok = chain.ok && summary.organisations.every((o) => o.auditChain === null || o.auditChain.ok);
      } catch (error) {
        failures.push(`audit chain platform: ${message(error)}`);
      }
    }
  } finally {
    await gateway.onApplicationShutdown?.().catch(() => undefined);
    await connection.destroy().catch(() => undefined);
  }
  summary.ok = failures.length === 0;
  summary.durationMs = Date.now() - started;
  return summary;
}

function emptyOrganisation(org: OrganisationRow): OrganisationSummary {
  return {
    id: org.id,
    status: org.status,
    ok: false,
    dataKey: 'not-checked',
    storageKeyId: null,
    objects: { sampled: 0, opened: 0, failed: 0 },
    probeWritten: false,
    auditChain: null,
  };
}

interface OrganisationContext {
  scope: TenantScope;
  verifier: AuditChainVerifier;
  gateway: BackupGateway;
  options: BackupVerifyOptions;
  failures: string[];
  summary: BackupVerifySummary;
  now: () => Date;
}

interface VaultObjectRow {
  repository_id: string;
  repository_slug: string;
  repository_modes: string[];
  repository_config: unknown;
  external_item_id: string;
  external_version_id: string | null;
  hash_algorithm: GatewayObjectRef['hashAlgorithm'];
  hash_value: string | null;
  hash_source: GatewayObjectRef['hashSource'];
  folder_path: string | null;
}

async function verifyOrganisation(
  org: OrganisationRow,
  key: { wrappedDek: string; kekId: string } | null,
  ctx: OrganisationContext,
): Promise<OrganisationSummary> {
  const result = emptyOrganisation(org);
  const fail = (text: string) => ctx.failures.push(`organisation ${org.id}: ${text}`);
  const tenantCtx = { orgId: org.id, schema: org.schema_name, userId: SYSTEM_USER_ID };
  const before = ctx.failures.length;

  // Tenant data key: the gateway opens it (test-connection of the organisation's Managed Vault).
  let tenant: GatewayTenant | null = null;
  let vault: GatewayRepository | null = null;
  if (!key) {
    result.dataKey = 'missing';
    fail('it has no tenant data key');
  } else {
    result.storageKeyId = key.kekId;
    tenant = { orgId: org.id, wrappedDek: key.wrappedDek };
    try {
      const row = await ctx.scope.withTenant(tenantCtx, (trx) =>
        trx
          .selectFrom('storage_repository')
          .select(['id', 'slug', 'modes', 'config'])
          .where('adapter', '=', 'managed_vault')
          .where('deleted_at', 'is', null)
          .orderBy('position')
          .orderBy('created_at')
          .limit(1)
          .executeTakeFirst(),
      );
      vault = row
        ? { id: row.id, slug: row.slug, adapter: 'managed_vault', modes: [...row.modes], config: { ...((row.config ?? {}) as Record<string, unknown>) } }
        : vaultDescriptor(org.id);
      // The gateway opens the data key before it touches the bucket: a key that does not open is a 400 problem.
      const test = await ctx.gateway.post<TestConnectionResponse>('/v1/test-connection', { tenant, repository: vault });
      result.dataKey = 'ok';
      if (test.status !== 'ok') fail(`its Managed Vault is not reachable (${test.status})`);
    } catch (error) {
      result.dataKey = 'failed';
      fail(`its tenant data key or Managed Vault did not open in the gateway: ${message(error)}`);
    }
  }

  // Probe object (test stacks), written before the sample so the sample opens it.
  if (ctx.options.writeProbe && tenant && vault && result.dataKey === 'ok') {
    try {
      await writeProbeObject(ctx, tenantCtx, tenant, vault);
      result.probeWritten = true;
      if (ctx.summary.probes) ctx.summary.probes.written += 1;
    } catch (error) {
      fail(`the probe object was not written: ${message(error)}`);
    }
  }

  // The newest n vault objects open and match their stored SHA-256.
  if (ctx.options.sample > 0 && tenant && result.dataKey === 'ok') {
    try {
      const objects = await ctx.scope.withTenant(tenantCtx, (trx) =>
        trx
          .selectFrom('storage_object as o')
          .innerJoin('storage_repository as r', 'r.id', 'o.storage_repository_id')
          .select([
            'r.id as repository_id',
            'r.slug as repository_slug',
            'r.modes as repository_modes',
            'r.config as repository_config',
            'o.external_item_id',
            'o.external_version_id',
            'o.hash_algorithm',
            'o.hash_value',
            'o.hash_source',
            'o.folder_path',
          ])
          .where('r.adapter', '=', 'managed_vault')
          .where('o.deleted_at', 'is', null)
          .where('o.hash_algorithm', '=', 'sha256')
          .orderBy('o.created_at', 'desc')
          .orderBy('o.id', 'desc')
          .limit(ctx.options.sample)
          .execute(),
      );
      for (const object of objects as VaultObjectRow[]) {
        result.objects.sampled += 1;
        try {
          const rehash = await ctx.gateway.post<RehashResult>('/v1/rehash', {
            tenant,
            repository: {
              id: object.repository_id,
              slug: object.repository_slug,
              adapter: 'managed_vault',
              modes: [...object.repository_modes],
              config: { ...((object.repository_config ?? {}) as Record<string, unknown>) },
            },
            object: {
              externalItemId: object.external_item_id,
              externalVersionId: object.external_version_id,
              hashAlgorithm: object.hash_algorithm,
              hashValue: object.hash_value,
              hashSource: object.hash_source,
              folderPath: object.folder_path,
            },
          });
          if (rehash.matches) result.objects.opened += 1;
          else result.objects.failed += 1;
        } catch {
          result.objects.failed += 1;
        }
      }
      if (result.objects.failed > 0) fail(`${result.objects.failed} of ${result.objects.sampled} vault objects did not open or did not match their SHA-256`);
    } catch (error) {
      fail(`the vault objects could not be listed: ${message(error)}`);
    }
  }

  // Audit chain of the organisation.
  try {
    const verified = await ctx.verifier.verifyTenant({ orgId: org.id, schema: org.schema_name });
    result.auditChain = await chainSummary(ctx.scope, verified, tenantChainName(org.schema_name), 'organisation', org.id);
    if (!result.auditChain.ok) ctx.failures.push(chainFailure(result.auditChain));
    ctx.summary.auditChains.chains += 1;
    ctx.summary.auditChains.rows += result.auditChain.rows;
    if (result.auditChain.anchoredSeq !== null) ctx.summary.auditChains.anchored += 1;
  } catch (error) {
    fail(`its audit chain could not be verified: ${message(error)}`);
  }

  result.ok = ctx.failures.length === before;
  return result;
}

/** The chain summary with the `seq` of its newest anchor. */
async function chainSummary(
  scope: TenantScope,
  verified: AuditChainVerifyResult,
  chain: string,
  kind: 'platform' | 'organisation',
  orgId?: string,
): Promise<ChainSummary> {
  const anchor = await scope.withPlatform(
    (trx) =>
      trx
        .selectFrom('platform.audit_anchor')
        .select('seq')
        .where('chain', '=', chain)
        .orderBy('anchored_at', 'desc')
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst(),
    { scope: 'cli' },
  );
  const firstBrokenSeq = verified.firstBrokenSeq ?? null;
  const anchoredSeq = anchor ? Number(anchor.seq) : null;
  return {
    scope: kind,
    ...(orgId ? { orgId } : {}),
    // The anchored row must still be part of the verified chain (seq 1 to `checked`, contiguous when intact).
    ok: firstBrokenSeq === null && verified.anchorOk && (anchoredSeq === null || anchoredSeq <= verified.checked),
    rows: verified.checked,
    firstBrokenSeq,
    anchorOk: verified.anchorOk,
    anchoredSeq,
  };
}

function chainFailure(chain: ChainSummary): string {
  const name = chain.scope === 'platform' ? 'audit chain platform' : `organisation ${chain.orgId}: its audit chain`;
  if (chain.firstBrokenSeq !== null) return `${name} is broken from row ${chain.firstBrokenSeq}`;
  if (!chain.anchorOk) return `${name} does not match its newest signed anchor (row ${chain.anchoredSeq})`;
  return `${name} ends at row ${chain.rows}, before its newest anchor (row ${chain.anchoredSeq})`;
}

/** Values sealed with platform.key that are still in use (F.11 bindings), newest first, at most 50 per kind. */
async function sealedPlatformValues(scope: TenantScope, now: Date): Promise<{ sealed: string; aad: string }[]> {
  return scope.withPlatform(
    async (trx) => {
      const values: { sealed: string; aad: string }[] = [];
      const factors = await trx
        .selectFrom('platform.mfa_factor')
        .select(['user_id', 'secret_sealed'])
        .where('deleted_at', 'is', null)
        .orderBy('created_at', 'desc')
        .limit(SEALED_SAMPLE)
        .execute();
      for (const f of factors) values.push({ sealed: f.secret_sealed, aad: `mfa:${f.user_id}` });
      const providers = await trx
        .selectFrom('platform.identity_provider')
        .select(['id', 'oidc_client_secret_sealed'])
        .where('oidc_client_secret_sealed', 'is not', null)
        .orderBy('created_at', 'desc')
        .limit(SEALED_SAMPLE)
        .execute();
      for (const p of providers) values.push({ sealed: p.oidc_client_secret_sealed!, aad: `idp:${p.id}` });
      const transactions = await trx
        .selectFrom('platform.auth_transaction')
        .select(['id', 'code_verifier_sealed'])
        .where('code_verifier_sealed', 'is not', null)
        .where('expires_at', '>', now)
        .orderBy('created_at', 'desc')
        .limit(SEALED_SAMPLE)
        .execute();
      for (const t of transactions) values.push({ sealed: t.code_verifier_sealed!, aad: `pkce:${t.id}` });
      return values;
    },
    { scope: 'cli' },
  );
}

/**
 * The sealed probe of `--write-probe`: a PKCE verifier sealed with platform.key in a sign-in transaction that no
 * browser can use (random state and binding hashes, no provider, no organisation, no user). The expiry clean-up
 * removes it after 30 days.
 */
async function writeSealedProbe(scope: TenantScope, platformKeys: FileKeyProvider, now: Date): Promise<void> {
  const id = randomUUID();
  const sealed = await platformKeys.wrap(Buffer.from(`${PROBE_MARK} ${now.toISOString()}`, 'utf8'), `pkce:${id}`);
  await scope.withPlatform(
    (trx) =>
      trx
        .insertInto('platform.auth_transaction')
        .values({
          id,
          kind: 'guest_otp',
          state_hash: createHash('sha256').update(randomBytes(32)).digest(),
          browser_binding_hash: createHash('sha256').update(randomBytes(32)).digest(),
          nonce: PROBE_MARK,
          code_verifier_sealed: sealed,
          return_to: null,
          expires_at: new Date(now.getTime() + PROBE_SEALED_DAYS * 86_400_000),
        })
        .execute(),
    { scope: 'cli' },
  );
}

/** A small probe object in the organisation's Managed Vault, recorded as a storage_object row. */
async function writeProbeObject(
  ctx: OrganisationContext,
  tenantCtx: { orgId: string; schema: string; userId: string },
  tenant: GatewayTenant,
  vault: GatewayRepository,
): Promise<void> {
  const at = ctx.now().toISOString();
  const content = Buffer.from(`${PROBE_MARK}\n${at}\n${randomBytes(16).toString('hex')}\n`, 'utf8');
  const fileName = `${PROBE_MARK}-${at.replace(/[^0-9]/g, '').slice(0, 14)}.txt`;
  const put = await ctx.gateway.putObject<PutResult>(
    {
      tenant,
      repository: vault,
      scopeRoot: { folderId: null, path: PROBE_MARK },
      folderPath: '',
      fileName,
      maxBytes: 65_536,
      metadataMinimization: false,
    },
    Readable.from([content]),
  );
  await ctx.scope.withTenant(tenantCtx, (trx) =>
    trx
      .insertInto('storage_object')
      .values({
        storage_repository_id: vault.id,
        external_item_id: put.externalItemId,
        external_version_id: put.externalVersionId,
        version_label: put.versionLabel.slice(0, 30),
        display_name: fileName,
        mime_type: put.detectedMimeType.slice(0, 100),
        size_bytes: String(put.sizeBytes),
        hash_algorithm: 'sha256',
        hash_value: put.hashValue,
        hash_source: 'computed',
        provider_created_at: put.providerCreatedAt ? new Date(put.providerCreatedAt) : null,
        folder_path: put.folderPath,
        encryption: put.encryption ? JSON.stringify(put.encryption) : null,
        last_verified_at: new Date(at),
        last_good_check_at: new Date(at),
      })
      .execute(),
  );
}

/** `--sample` and `--write-probe` checked; a refusal is a `ConfigError` (exit code 2). */
export function parseVerifyOptions(raw: { sample?: string; writeProbe?: boolean }, env: NodeJS.ProcessEnv = process.env): BackupVerifyOptions {
  let sample = DEFAULT_SAMPLE;
  if (raw.sample !== undefined) {
    if (!/^\d{1,4}$/.test(raw.sample) || Number(raw.sample) > MAX_SAMPLE) {
      throw new ConfigError(`--sample must be a whole number from 0 to ${MAX_SAMPLE}, got '${raw.sample}'`);
    }
    sample = Number(raw.sample);
  }
  const writeProbe = raw.writeProbe === true;
  if (writeProbe && env.MSCD_SAAS_TEST !== '1') {
    throw new ConfigError('--write-probe writes test objects and is refused unless MSCD_SAAS_TEST=1 (test stacks only)');
  }
  return { sample, writeProbe };
}

/** `backup verify`. Fills the stub that M2-02 registered in `program.ts` (D.3). */
export function register(program: Command): void {
  const backup = program.command('backup').description('Backup checks of the SaaS track (Milestone 2 M2-S07)');
  backup
    .command('verify')
    .description('Check that a restored installation is complete and readable; prints a JSON summary, exit 1 on any failure')
    .option('--sample <n>', `vault objects to open per organisation, newest first (default ${DEFAULT_SAMPLE})`)
    .option('--write-probe', 'write small probe objects first (only with MSCD_SAAS_TEST=1)')
    .action(async (raw: { sample?: string; writeProbe?: boolean }) => {
      let options: BackupVerifyOptions;
      try {
        options = parseVerifyOptions(raw);
      } catch (error) {
        process.stderr.write(`backup verify: ${(error as Error).message}\n`);
        process.exit(2);
      }
      const config = loadConfigOrExit('cli');
      let summary: BackupVerifySummary;
      try {
        summary = await backupVerify(config, options);
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`backup verify failed: ${message(error)}\n`);
        process.exit(1);
      }
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.ok) {
        process.stderr.write(`backup verify: ${summary.failures.length} check(s) failed\n`);
        process.exit(1);
      }
    });
}
