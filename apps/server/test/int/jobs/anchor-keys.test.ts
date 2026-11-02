// The anchor keys of an on-premise installation (Milestone 3 M3-12, D-16, D-33): an installation signs its anchors with
// a key pair it made itself, which no release compiles in. The nightly `audit.verify-chain` job trusts the public half of
// its own signing key, so a second run does not report the chain broken; a process without the private key (the api)
// trusts the installation's keys through `audit-anchor.pub` beside `audit.anchor_key_file`; after the key is replaced,
// the earlier public key listed in that file keeps the older anchors verifying, and without it they are refused. A
// private key in the public file, a key that is not Ed25519 and an empty file are refused and left out. A process that
// reads neither the private key nor the public file logs a warning that names the file it needs.
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_WRITER, SYSTEM_USER_ID, type AuditWriter } from '../../../src/common/tokens';
import { anchorKeyId, compiledAnchorKeys, verifyAnchorRow, type AnchorRow } from '../../../src/modules/audit/anchors';
import { anchorPublicKeyFile, anchorPublicKeysOf, trustedAnchorKeys } from '../../../src/modules/audit/anchor-keys';
import { AUDIT_ANCHOR_KEYS, AuditChainVerifier, type AnchorKeys } from '../../../src/modules/audit/chain-verifier';
import { AuditVerifyChainJob } from '../../../src/modules/jobs/audit-verify-chain.job';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { adminClient, createJobsApp, type AdminClient, type JobsApp } from './helpers';

interface KeyPair {
  privatePem: string;
  publicPem: string;
  keyId: string;
}

function keyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: (publicKey as KeyObject).export({ type: 'spki', format: 'pem' }).toString(),
    keyId: anchorKeyId(publicKey),
  };
}

/** A folder like `secrets/` of an installation: the private key and the public key file, each only when given. */
async function secretsFolder(root: string, name: string, files: { key?: string; pub?: string }): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  if (files.key !== undefined) await writeFile(path.join(dir, 'audit-anchor.key'), files.key, { mode: 0o600 });
  if (files.pub !== undefined) await writeFile(path.join(dir, 'audit-anchor.pub'), files.pub);
  return path.join(dir, 'audit-anchor.key');
}

/** A logger that keeps what it was told. */
function recordingLogger() {
  const lines: { level: string; text: string }[] = [];
  return {
    lines,
    log: (text: string) => lines.push({ level: 'log', text }),
    warn: (text: string) => lines.push({ level: 'warn', text }),
    debug: (text: string) => lines.push({ level: 'debug', text }),
  };
}

const configFor = (anchorKeyFile: string | null) => ({ profile: { audit: { anchor_key_file: anchorKeyFile } } }) as Parameters<typeof trustedAnchorKeys>[0];

describe('anchor keys of an on-premise installation (M3-12)', () => {
  const db = useTestDatabase('empty');
  const first = keyPair();
  const second = keyPair();
  let root: string;
  let admin: AdminClient;
  let tenant: { id: string; schemaName: string };
  let app: JobsApp | null = null;

  const writeEntries = async (jobs: JobsApp, count: number) => {
    const audit = jobs.moduleRef.get<AuditWriter>(AUDIT_WRITER);
    await jobs.moduleRef.get(TenantScope).withTenant({ orgId: tenant.id, schema: tenant.schemaName, userId: SYSTEM_USER_ID }, async (trx) => {
      for (let i = 0; i < count; i += 1) {
        await audit.record(trx, { action: 'register.updated', actor: { userId: SYSTEM_USER_ID, kind: 'system' }, entityType: 'risk', entityCode: `R-K${i}`, after: { n: i } });
      }
    });
  };
  const newestAnchor = async (chain: string) =>
    (await admin.query<AnchorRow>(`SELECT chain, seq, row_hash, payload, signature, key_id FROM platform.audit_anchor WHERE chain = $1 ORDER BY anchored_at DESC, seq DESC LIMIT 1`, [chain])).rows[0]!;
  /** The tenant chain verified with the keys a process with this `audit.anchor_key_file` trusts. */
  const verifyWith = (jobs: JobsApp, keys: AnchorKeys) => new AuditChainVerifier(jobs.moduleRef.get(TenantScope), keys).verifyTenant({ orgId: tenant.id, schema: tenant.schemaName });

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'm3-12-anchor-keys-'));
    const created = await createTenant(db, 'anchor_onprem');
    tenant = { id: created.id, schemaName: created.schemaName };
    admin = await adminClient(db);
  });
  afterAll(async () => {
    await app?.close();
    await admin?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('reads the public keys of a PEM file in order and refuses private keys, other kinds and empty files', () => {
    expect(anchorPublicKeysOf(`${second.publicPem}\n${first.publicPem}`, 'audit-anchor.pub').map((k) => k.keyId)).toEqual([second.keyId, first.keyId]);
    expect(() => anchorPublicKeysOf(`${first.publicPem}${first.privatePem}`, 'audit-anchor.pub')).toThrow('holds a private key');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => anchorPublicKeysOf(rsa, 'audit-anchor.pub')).toThrow('anchor keys are Ed25519');
    expect(() => anchorPublicKeysOf('not a key\n', 'audit-anchor.pub')).toThrow('holds no public key');
    expect(anchorPublicKeyFile('/run/secrets/audit-anchor.key')).toBe('/run/secrets/audit-anchor.pub');
    expect(anchorPublicKeyFile('/srv/keys/anchor')).toBe('/srv/keys/anchor.pub');
  });

  it('trusts the compiled keys, the public half of a readable signing key and every key of audit-anchor.pub, each once', async () => {
    const compiled = compiledAnchorKeys().map((k) => k.keyId);
    expect(trustedAnchorKeys(configFor(null), recordingLogger()).map((k) => k.keyId)).toEqual(compiled);

    const worker = await secretsFolder(root, 'worker', { key: first.privatePem, pub: first.publicPem });
    expect(trustedAnchorKeys(configFor(worker), recordingLogger()).map((k) => [k.keyId, k.source])).toEqual([
      ...compiled.map((id) => [id, 'build']),
      [first.keyId, 'signing-key'],
    ]);

    // The api: no private key, the public file only.
    const api = await secretsFolder(root, 'api', { pub: first.publicPem });
    expect(trustedAnchorKeys(configFor(api), recordingLogger()).map((k) => [k.keyId, k.source])).toEqual([
      ...compiled.map((id) => [id, 'build']),
      [first.keyId, 'public-key-file'],
    ]);

    // A public file that cannot be used is logged and left out; a public file without the signing key is pointed out.
    const leaked = await secretsFolder(root, 'leaked', { pub: first.privatePem });
    const leakedLog = recordingLogger();
    expect(trustedAnchorKeys(configFor(leaked), leakedLog).map((k) => k.keyId)).toEqual(compiled);
    expect(leakedLog.lines.filter((l) => l.level === 'warn').map((l) => l.text).join('\n')).toContain('holds a private key');
    const mismatch = await secretsFolder(root, 'mismatch', { key: second.privatePem, pub: first.publicPem });
    const mismatchLog = recordingLogger();
    expect(trustedAnchorKeys(configFor(mismatch), mismatchLog).map((k) => k.keyId)).toEqual([...compiled, second.keyId, first.keyId]);
    expect(mismatchLog.lines.some((l) => l.level === 'warn' && l.text.includes(`does not hold the public half of audit.anchor_key_file (${second.keyId})`))).toBe(true);
  });

  it('keeps anchoring the chains of an installation key that no release compiles in (the second run is not "broken")', async () => {
    expect(compiledAnchorKeys().map((k) => k.keyId)).not.toContain(first.keyId);
    // The worker of the installation, with its own private key only.
    const keyFile = await secretsFolder(root, 'onprem-worker', { key: first.privatePem });
    app = await createJobsApp(db, { env: { MSCD__AUDIT__ANCHOR_KEY_FILE: keyFile } });
    expect(app.moduleRef.get<AnchorKeys>(AUDIT_ANCHOR_KEYS).map((k) => k.keyId)).toContain(first.keyId);
    await writeEntries(app, 3);
    const job = app.moduleRef.get(AuditVerifyChainJob);
    const firstRun = await job.run();
    expect(firstRun.map((o) => [o.chain, o.broken, o.anchored?.keyId ?? o.skipped])).toEqual([
      ['platform.audit_log', false, first.keyId],
      [`${tenant.schemaName}.audit_trail`, false, first.keyId],
    ]);
    // The compiled keys alone refuse that anchor: before M3-12 the next run reported the chain broken and never anchored again.
    expect(verifyAnchorRow(await newestAnchor(`${tenant.schemaName}.audit_trail`), compiledAnchorKeys())).toBe(false);

    await writeEntries(app, 2);
    const secondRun = await job.run();
    expect(secondRun.map((o) => [o.chain, o.broken, o.anchorOk, o.anchored ? 'anchored' : o.skipped])).toEqual([
      ['platform.audit_log', false, true, 'unchanged'],
      [`${tenant.schemaName}.audit_trail`, false, true, 'anchored'],
    ]);
    expect(await app.moduleRef.get(AuditChainVerifier).verifyTenant({ orgId: tenant.id, schema: tenant.schemaName })).toMatchObject({ firstBrokenSeq: null, anchorOk: true });
  });

  it("verifies the installation's anchors in a process without the private key through audit-anchor.pub, and refuses them without it", async () => {
    const withPubLog = recordingLogger();
    const withPub = trustedAnchorKeys(configFor(await secretsFolder(root, 'onprem-api', { pub: first.publicPem })), withPubLog);
    expect(await verifyWith(app!, withPub)).toMatchObject({ firstBrokenSeq: null, anchorOk: true });
    expect(withPubLog.lines.filter((l) => l.level === 'warn')).toEqual([]);
    // Without the file (a deployment that gives the api no audit-anchor.pub), the process says so when it starts.
    const bareLog = recordingLogger();
    const bareKeyFile = await secretsFolder(root, 'onprem-api-bare', {});
    const withoutPub = trustedAnchorKeys(configFor(bareKeyFile), bareLog);
    expect(await verifyWith(app!, withoutPub)).toMatchObject({ firstBrokenSeq: null, anchorOk: false });
    expect(bareLog.lines.filter((l) => l.level === 'warn').map((l) => l.text)).toEqual([
      expect.stringContaining(`can use neither audit.anchor_key_file (${bareKeyFile}) nor ${anchorPublicKeyFile(bareKeyFile)}`),
    ]);
    // The worker, which reads its private key, needs no warning even without the public file.
    const workerLog = recordingLogger();
    trustedAnchorKeys(configFor(await secretsFolder(root, 'onprem-worker-bare', { key: first.privatePem })), workerLog);
    expect(workerLog.lines.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('keeps the anchors of a replaced key verifying while audit-anchor.pub lists it, and the new key signs the next anchor', async () => {
    // The key was replaced: the newest anchors are still signed with the first key.
    const forgotten = trustedAnchorKeys(configFor(await secretsFolder(root, 'rotated-forgotten', { key: second.privatePem, pub: second.publicPem })), recordingLogger());
    expect(await verifyWith(app!, forgotten)).toMatchObject({ anchorOk: false });
    const keyFile = await secretsFolder(root, 'rotated', { key: second.privatePem, pub: `${second.publicPem}${first.publicPem}` });
    const kept = trustedAnchorKeys(configFor(keyFile), recordingLogger());
    expect(kept.filter((k) => k.source !== 'build').map((k) => [k.keyId, k.source])).toEqual([
      [second.keyId, 'signing-key'],
      [first.keyId, 'public-key-file'],
    ]);
    expect(await verifyWith(app!, kept)).toMatchObject({ firstBrokenSeq: null, anchorOk: true });

    // The worker restarts with the new key and the file listing both: the next anchor is signed with the new key.
    await app!.close();
    app = await createJobsApp(db, { env: { MSCD__AUDIT__ANCHOR_KEY_FILE: keyFile } });
    await writeEntries(app, 1);
    const run = await app.moduleRef.get(AuditVerifyChainJob).run();
    expect(run.map((o) => [o.chain, o.broken, o.anchored?.keyId ?? o.skipped])).toEqual([
      ['platform.audit_log', false, 'unchanged'],
      [`${tenant.schemaName}.audit_trail`, false, second.keyId],
    ]);
    // The api with the new public file verifies the new anchor too.
    const api = trustedAnchorKeys(configFor(await secretsFolder(root, 'rotated-api', { pub: `${second.publicPem}${first.publicPem}` })), recordingLogger());
    expect(await verifyWith(app, api)).toMatchObject({ firstBrokenSeq: null, anchorOk: true });
  });
});
