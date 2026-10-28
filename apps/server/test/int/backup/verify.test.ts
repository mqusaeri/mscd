// `mscd-server backup verify` (Milestone 2 M2-S07): the checks of a restored installation against a real database,
// a storage gateway on SeaweedFS and two organisations made by `tenant create`, with probes, signed anchors and the
// failures a broken restore shows (another storage.key or platform.key, a missing vault object, an anchor that does
// not match, an unreachable database or gateway). The summary names organisations by id only.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupVerify, DEFAULT_SAMPLE, MAX_SAMPLE, parseVerifyOptions, PROBE_MARK, type BackupVerifySummary } from '../../../src/cli/backup';
import { tenantCreate } from '../../../src/cli/tenant';
import type { MscdConfig } from '../../../src/config/mscd-config';
import { anchorKeyId, signAnchor } from '../../../src/modules/audit/anchors';
import { buildProgram } from '../../../src/program';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { gatewayConfig, startGateway, startSeaweed, vaultEnv, type RunningGateway, type Seaweed } from '../gateway/helpers';

const ORGS = [
  { slug: 'bkalpha', name: 'Backup Alpha Organisation' },
  { slug: 'bkbeta', name: 'Backup Beta Organisation' },
] as const;

/** A throwaway anchor key pair the tests trust in place of the compiled keys. */
const anchor = generateKeyPairSync('ed25519');
const anchorKeys = [{ keyId: anchorKeyId(anchor.publicKey), publicKeyPem: anchor.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];

describe('backup verify options', () => {
  it('takes a sample from 0 to 1000 and refuses --write-probe unless MSCD_SAAS_TEST=1', () => {
    expect(parseVerifyOptions({}, {})).toEqual({ sample: DEFAULT_SAMPLE, writeProbe: false });
    expect(parseVerifyOptions({ sample: '0' }, {})).toEqual({ sample: 0, writeProbe: false });
    expect(parseVerifyOptions({ sample: String(MAX_SAMPLE), writeProbe: true }, { MSCD_SAAS_TEST: '1' })).toEqual({ sample: MAX_SAMPLE, writeProbe: true });
    for (const sample of ['-1', '1.5', 'x', '', '1001', '99999']) {
      expect(() => parseVerifyOptions({ sample }, {})).toThrow(/--sample must be a whole number/);
    }
    expect(() => parseVerifyOptions({ writeProbe: true }, {})).toThrow(/refused unless MSCD_SAAS_TEST=1/);
    expect(() => parseVerifyOptions({ writeProbe: true }, { MSCD_SAAS_TEST: 'true' })).toThrow(/refused unless MSCD_SAAS_TEST=1/);
  });

  it('is registered as "backup verify" with --sample and --write-probe', () => {
    const backup = buildProgram().commands.find((c) => c.name() === 'backup');
    const verify = backup?.commands.find((c) => c.name() === 'verify');
    expect(verify).toBeDefined();
    const help = verify!.helpInformation();
    expect(help).toContain('--sample <n>');
    expect(help).toContain('--write-probe');
  });
});

describe('backup verify', () => {
  const db = useTestDatabase('empty');
  let seaweed: Seaweed;
  let gateway: RunningGateway;
  let config: MscdConfig;
  const orgIds: string[] = [];
  const work = mkdtempSync(path.join(tmpdir(), 'mscd-m2-s07-'));

  /** A config of run mode cli on the test database and the test gateway, with overrides. */
  const cliConfig = (env: Record<string, string> = {}) => db.config({ MSCD__STORAGE__GATEWAY__URL: gateway.url, ...env }, 'cli');
  const verify = (options: { sample?: number; writeProbe?: boolean } = {}, overrides?: MscdConfig) =>
    backupVerify(overrides ?? config, { sample: options.sample ?? DEFAULT_SAMPLE, writeProbe: options.writeProbe ?? false }, { anchorKeys });

  /** Signs the head of a chain (platform: `platform.audit_log`, else an organisation's `audit_trail`) and stores the anchor. */
  async function anchorHead(chain: string, head: { seq: number; rowHash: string }, rowHash = head.rowHash): Promise<void> {
    const installation = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow(),
    );
    const anchoredAt = new Date().toISOString();
    const signed = signAnchor({ chain, seq: head.seq, rowHash, anchoredAt, installationId: installation.id }, anchor.privateKey, anchor.publicKey);
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx
        .insertInto('platform.audit_anchor')
        .values({
          chain,
          seq: String(head.seq),
          row_hash: Buffer.from(rowHash, 'hex'),
          anchored_at: new Date(anchoredAt),
          payload: JSON.stringify({ chain, seq: head.seq, rowHash, anchoredAt, installationId: installation.id }),
          signature: signed.signature,
          key_id: signed.keyId,
          exported_to: ['database'],
        })
        .execute(),
    );
  }

  async function platformHead(): Promise<{ seq: number; rowHash: string }> {
    const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.audit_log').select(['seq', 'row_hash']).orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow(),
    );
    return { seq: Number(row.seq), rowHash: row.row_hash.toString('hex') };
  }

  /** One system entry in an organisation's audit trail; returns the new head. */
  async function addTenantEntry(orgId: string, schema: string): Promise<{ seq: number; rowHash: string }> {
    return inScope(db.app, { orgId, schema }, async (trx) => {
      await trx.insertInto('audit_trail').values({ actor_kind: 'system', action: 'backup.test' }).execute();
      const row = await trx.selectFrom('audit_trail').select(['seq', 'row_hash']).orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
      return { seq: Number(row.seq), rowHash: row.row_hash.toString('hex') };
    });
  }

  async function schemaOf(orgId: string): Promise<string> {
    const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.organization').select('schema_name').where('id', '=', orgId).executeTakeFirstOrThrow(),
    );
    return row.schema_name;
  }

  const organisation = (summary: BackupVerifySummary, id: string) => summary.organisations.find((o) => o.id === id)!;

  beforeAll(async () => {
    seaweed = await startSeaweed();
    gateway = await startGateway(gatewayConfig(vaultEnv(seaweed)));
    config = cliConfig();
    for (const org of ORGS) {
      const created = await tenantCreate(config, { slug: org.slug, name: org.name });
      orgIds.push(created.id);
    }
  });

  afterAll(async () => {
    await gateway?.close().catch(() => undefined);
    await seaweed?.stop().catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  });

  it('passes on a complete installation: probes written and opened, data keys, sealed values and anchored chains', async () => {
    const alpha = orgIds[0]!;
    await anchorHead('platform.audit_log', await platformHead());
    const alphaSchema = await schemaOf(alpha);
    await anchorHead(`${alphaSchema}.audit_trail`, await addTenantEntry(alpha, alphaSchema));
    // A newer row than the anchor: the head is still covered by the anchor through the intact chain.
    await addTenantEntry(alpha, alphaSchema);

    const summary = await verify({ sample: 2, writeProbe: true });
    expect(summary.failures).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(summary.database).toMatchObject({ ok: true, organisations: 2, skipped: 0 });
    expect(summary.database.serverVersion).toMatch(/^16\./);
    expect(summary.gateway.ok).toBe(true);
    expect(summary.gateway.storageKeyId).toMatch(/^[0-9a-f]{8}$/);
    expect(summary.platformKey).toMatchObject({ ok: true, sealedValues: 1, opened: 1 });
    expect(summary.probes).toEqual({ written: 2 });
    expect(summary.sample).toBe(2);
    for (const id of orgIds) {
      const org = organisation(summary, id);
      expect(org).toMatchObject({ ok: true, status: 'active', dataKey: 'ok', probeWritten: true, objects: { sampled: 1, opened: 1, failed: 0 } });
      expect(org.storageKeyId).toBe(summary.gateway.storageKeyId);
    }
    expect(organisation(summary, alpha).auditChain).toMatchObject({ ok: true, scope: 'organisation', orgId: alpha, rows: 2, anchoredSeq: 1, anchorOk: true });
    expect(organisation(summary, orgIds[1]!).auditChain).toMatchObject({ ok: true, rows: 0, anchoredSeq: null });
    expect(summary.auditChains).toMatchObject({ ok: true, chains: 3, anchored: 2 });

    // The probes are real rows and objects: a second run without --write-probe opens them again.
    const again = await verify({ sample: 5 });
    expect(again.ok).toBe(true);
    expect(again.probes).toBeNull();
    for (const id of orgIds) expect(organisation(again, id).objects).toEqual({ sampled: 1, opened: 1, failed: 0 });
    const probeRows = await inScope(db.migrator, { orgId: alpha, schema: alphaSchema }, (trx) =>
      trx.selectFrom('storage_object').select(['display_name', 'hash_source']).execute(),
    );
    expect(probeRows).toEqual([{ display_name: expect.stringMatching(new RegExp(`^${PROBE_MARK}-\\d{14}\\.txt$`)), hash_source: 'computed' }]);
  });

  it('names organisations by id only (no slug, name or schema in the summary)', async () => {
    const text = JSON.stringify(await verify({ sample: 1 }));
    for (const org of ORGS) {
      expect(text).not.toContain(org.slug);
      expect(text).not.toContain(org.name);
    }
    expect(text).not.toMatch(/org_[a-z]/);
    for (const id of orgIds) expect(text).toContain(id);
  });

  it('fails when platform.key is not the key the values were sealed with', async () => {
    const file = path.join(work, 'other-platform.key');
    writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    const summary = await verify({ sample: 1 }, cliConfig({ MSCD__KMS__FILE__PATH: file }));
    expect(summary.ok).toBe(false);
    expect(summary.platformKey).toMatchObject({ ok: false, sealedValues: 1, opened: 0 });
    expect(summary.failures).toEqual([expect.stringMatching(/^platform\.key: 1 of 1 sealed values do not open with platform\.key [0-9a-f]{8}$/)]);
    expect(summary.gateway.ok).toBe(true);
    for (const id of orgIds) expect(organisation(summary, id).ok).toBe(true);
  });

  it('fails when the gateway holds another storage.key: no tenant data key opens', async () => {
    const file = path.join(work, 'other-storage.key');
    writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    const other = await startGateway(gatewayConfig({ ...vaultEnv(seaweed), MSCD__GATEWAY__KMS__FILE__PATH: file }));
    try {
      const summary = await verify({ sample: 1 }, db.config({ MSCD__STORAGE__GATEWAY__URL: other.url }, 'cli'));
      expect(summary.ok).toBe(false);
      // The gateway itself works: it wraps and opens a throwaway key with the key it holds.
      expect(summary.gateway.ok).toBe(true);
      expect(summary.gateway.storageKeyId).not.toBe(organisation(summary, orgIds[0]!).storageKeyId);
      for (const id of orgIds) {
        expect(organisation(summary, id)).toMatchObject({ ok: false, dataKey: 'failed', objects: { sampled: 0 } });
        expect(summary.failures).toContainEqual(expect.stringMatching(new RegExp(`^organisation ${id}: its tenant data key or Managed Vault did not open in the gateway`)));
      }
    } finally {
      await other.close();
    }
  });

  it('fails when the gateway cannot be reached, and when the database cannot be reached', async () => {
    const noGateway = await verify({ sample: 1 }, cliConfig({ MSCD__STORAGE__GATEWAY__URL: 'http://127.0.0.1:1' }));
    expect(noGateway.ok).toBe(false);
    expect(noGateway.database.ok).toBe(true);
    expect(noGateway.gateway.ok).toBe(false);
    expect(noGateway.failures[0]).toMatch(/^gateway: /);
    for (const id of orgIds) expect(organisation(noGateway, id).dataKey).toBe('failed');

    const noDatabase = await verify({ sample: 1 }, cliConfig({ MSCD_DATABASE_URL: 'postgres://mscd_app:wrong@127.0.0.1:1/none' }));
    expect(noDatabase.ok).toBe(false);
    expect(noDatabase.database).toMatchObject({ ok: false, organisations: 0 });
    expect(noDatabase.failures[0]).toMatch(/^database: /);
    expect(noDatabase.gateway.ok).toBe(true);
  });

  it('fails when a sampled vault object is missing from the bucket', async () => {
    const alpha = orgIds[0]!;
    const schema = await schemaOf(alpha);
    const row = await inScope(db.migrator, { orgId: alpha, schema }, (trx) =>
      trx.selectFrom('storage_object').select('external_item_id').executeTakeFirstOrThrow(),
    );
    await seaweed.s3.send(new DeleteObjectCommand({ Bucket: 'mscd-vault', Key: row.external_item_id }));
    const summary = await verify({ sample: 3 });
    expect(summary.ok).toBe(false);
    expect(organisation(summary, alpha)).toMatchObject({ ok: false, dataKey: 'ok', objects: { sampled: 1, opened: 0, failed: 1 } });
    expect(organisation(summary, orgIds[1]!).ok).toBe(true);
    expect(summary.failures).toEqual([`organisation ${alpha}: 1 of 1 vault objects did not open or did not match their SHA-256`]);
    // --sample 0 opens no object.
    expect((await verify({ sample: 0 })).ok).toBe(true);
  });

  it('fails when an audit chain does not match its newest signed anchor', async () => {
    const beta = orgIds[1]!;
    const schema = await schemaOf(beta);
    const head = await addTenantEntry(beta, schema);
    await anchorHead(`${schema}.audit_trail`, head, 'ab'.repeat(32));
    const summary = await verify({ sample: 0 });
    expect(summary.ok).toBe(false);
    expect(organisation(summary, beta).auditChain).toMatchObject({ ok: false, anchorOk: false, anchoredSeq: head.seq, rows: 1 });
    expect(summary.auditChains.ok).toBe(false);
    expect(summary.failures).toEqual([`organisation ${beta}: its audit chain does not match its newest signed anchor (row ${head.seq})`]);
  });

  it('fails when an anchor names a row the restored chain does not hold', async () => {
    const alpha = orgIds[0]!;
    const schema = await schemaOf(alpha);
    // A database restored from before the newest anchor: the anchored row is not in the restored chain.
    const head = await addTenantEntry(alpha, schema);
    await anchorHead(`${schema}.audit_trail`, { seq: head.seq + 5, rowHash: head.rowHash });
    const summary = await verify({ sample: 0 });
    expect(organisation(summary, alpha).auditChain).toMatchObject({ ok: false, anchoredSeq: head.seq + 5 });
    expect(summary.failures).toContainEqual(`organisation ${alpha}: its audit chain does not match its newest signed anchor (row ${head.seq + 5})`);
  });
});
