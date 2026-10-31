// `export verify` and its anchor keys (Milestone 3 D.4), without a database: an export folder written with the archive
// writer holds audit rows and signed anchors. Verify passes when the anchor is signed by the anchor key compiled into
// this build. It fails when someone rewrites the audit trail, signs a new anchor with a key of their own and labels
// that key with the trusted key id (the manifest, the parts and anchor-keys.json are not signed, so they can all be
// rewritten too), and it fails when an anchor is signed by a key this build does not trust, even under that key's real
// id. On-premise, each installation signs with its own key (`keys generate` at install): the builder names that key
// in the export, and verify trusts it only when the operator names its public key file with `--anchor-key`. The report
// says up to which row the anchors prove the trail, also when the newest anchors were removed.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportVerify, verifyLines } from '../../../src/cli/export';
import type { Trx } from '../../../src/common/tokens';
import type { MscdConfig } from '../../../src/config/mscd-config';
import { anchorKeyId, compiledAnchorKeys, signAnchor, type SignedAnchor } from '../../../src/modules/audit/anchors';
import { ArchiveWriter } from '../../../src/modules/org-export/archive/archive-writer';
import { anchorFiles } from '../../../src/modules/org-export/audit-data';
import { OrgExportBuilder, type BuildRequest } from '../../../src/modules/org-export/builder';
import { manifestBytes, manifestEntry, type ExportManifest, type ManifestEntry } from '../../../src/modules/org-export/manifest';
import { verifyExportFolder } from '../../../src/modules/org-export/verify';

const ANCHOR_KEY_FILE = path.resolve(__dirname, '../../fixtures/secrets/audit-anchor.key');
const CHAIN = 'org_tst.audit_trail';
const OCCURRED = '2026-10-31T00:00:00+00:00';
const BASE = 'mscd-export-tst-2026-10-31';

interface Folder {
  /** The anchor line as written (its `keyId` may be a forged label). */
  anchor: { keyId: string; signature: string };
  /** `audit/anchor-keys.json`. */
  keys: { keyId: string; publicKeyPem: string | null }[];
  /** `audit/audit-anchor.pub`. */
  pub: string;
}

const INSTALLATION = '22222222-2222-4222-8222-222222222222';

/** Audit rows of the chain (seq 1, 2, ...): their JSON lines and hashes. */
function auditRows(actions: string[]): { lines: string; hashes: string[] } {
  let lines = '';
  let prev = '';
  const hashes: string[] = [];
  for (const [index, action] of actions.entries()) {
    const seq = index + 1;
    const id = `11111111-1111-4111-8111-${String(seq).padStart(12, '0')}`;
    const values = [seq, id, OCCURRED, null, null, null, 'system', action, 'x', null, 'X-1', null, { note: action }, null, null, null, null];
    const canonical = JSON.stringify(values);
    const rowHash = createHash('sha256').update(Buffer.from(prev, 'hex')).update(canonical, 'utf8').digest('hex');
    const row = {
      seq, id, occurred_at: OCCURRED, organization_id: null, management_system_id: null, actor_user_id: null, actor_kind: 'system', action,
      entity_type: 'x', entity_id: null, entity_code: 'X-1', before_data: null, after_data: { note: action }, edition: null, request_id: null, source_ip: null,
      user_agent: null, prev_hash: prev, row_hash: rowHash, redacted_at: null, redaction_id: null, canonical_text: canonical,
    };
    lines += `${JSON.stringify(row)}\n`;
    hashes.push(rowHash);
    prev = rowHash;
  }
  return { lines, hashes };
}

const pemOf = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }).toString();

/** The audit files of an export folder. */
interface AuditFiles {
  /** `audit/anchors.jsonl`. */
  anchors: string;
  /** `audit/audit-anchor.pub`. */
  pub: string;
  /** `audit/anchor-keys.json`. */
  keys: string;
}

/** Writes an export folder (parts and the separate manifest) with these audit rows and audit files. */
async function writeExport(dir: string, actions: string[], files: (hashes: string[]) => AuditFiles): Promise<void> {
  const rows = auditRows(actions);
  const audit = files(rows.hashes);
  const anchorCount = audit.anchors.split('\n').filter((l) => l.trim() !== '').length;
  const writer = new ArchiveWriter({ dir, baseName: BASE, partBytes: 1024 * 1024, mtime: new Date(OCCURRED), onPart: async () => undefined });
  const entries: ManifestEntry[] = [
    manifestEntry(await writer.addBuffer('audit/audit_trail.jsonl', Buffer.from(rows.lines)), 'audit', { rows: actions.length }),
    manifestEntry(await writer.addBuffer('audit/anchors.jsonl', Buffer.from(audit.anchors)), 'anchors', { rows: anchorCount }),
    manifestEntry(await writer.addBuffer('audit/audit-anchor.pub', Buffer.from(audit.pub)), 'key'),
    manifestEntry(await writer.addBuffer('audit/anchor-keys.json', Buffer.from(audit.keys)), 'key'),
  ];
  const keyIds = (JSON.parse(audit.keys) as { keyId: string }[]).map((k) => k.keyId);
  const manifest = (copy: ExportManifest['copy'], parts: ExportManifest['parts']): ExportManifest => ({
    format: 'mscd-organization-export', formatVersion: 1, copy, exportId: '33333333-3333-4333-8333-333333333333', organization: { id: 'x', slug: 'tst', name: 'Test' },
    createdAt: OCCURRED, requestedVia: 'cli', requestedBy: null, approvedBy: null, isFinal: false, mscd: { version: 'test', revision: 'test' }, tenantMigrations: [],
    tenantMigrationsSource: 'build', frameworkPacks: [], parts, entries, filesWithoutContent: [],
    audit: { chain: CHAIN, rows: actions.length, anchors: anchorCount, anchorKeyIds: keyIds }, excluded: [],
    counts: { tables: 0, rows: 0, files: 0, filesWithoutContent: 0, externalFiles: 0, fileBytes: 0, entries: entries.length, parts: 1 },
  });
  await writer.finish('manifest.json', (last) => manifestBytes(manifest('last-part', [{ part: last, name: writer.partName(last), sizeBytes: null, sha256: null }])));
  const parts = writer.parts.map((p) => ({ part: p.part, name: p.name, sizeBytes: p.sizeBytes, sha256: p.sha256 }));
  await writeFile(path.join(dir, `${BASE}-manifest.json`), manifestBytes(manifest('download', parts)));
}

/** Writes an export folder whose audit trail is one row signed as `sign` says. */
async function writeFolder(dir: string, action: string, sign: (rowHash: string) => Folder): Promise<void> {
  await writeExport(dir, [action], ([rowHash]) => {
    const signed = sign(rowHash!);
    const anchor = { chain: CHAIN, seq: 1, rowHash: rowHash!, anchoredAt: OCCURRED, installationId: INSTALLATION, ...signed.anchor };
    return { anchors: `${JSON.stringify(anchor)}\n`, pub: signed.pub, keys: JSON.stringify(signed.keys) };
  });
}

/** A `platform.audit_anchor` row as the anchor job writes it. */
function anchorRow(anchor: SignedAnchor) {
  const { keyId, signature, ...payload } = anchor;
  return { chain: anchor.chain, seq: String(anchor.seq), row_hash: Buffer.from(anchor.rowHash, 'hex'), payload, signature, key_id: keyId, anchored_at: new Date(anchor.anchoredAt) };
}

/** A transaction that answers the anchor query of `anchorFiles` with these rows. */
function anchorTrx(rows: ReturnType<typeof anchorRow>[]): Trx {
  const query = { select: () => query, where: () => query, orderBy: () => query, execute: async () => rows };
  return { selectFrom: () => query } as unknown as Trx;
}

/** A configuration whose `audit.anchor_key_file` is `file` (null: none). */
function configWith(file: string | null): MscdConfig {
  return {
    profile: { audit: { anchor_key_file: file } },
    readSecretFile: (name: string) => readFileSync(name, 'utf8').replace(/\r?\n$/, ''),
  } as unknown as MscdConfig;
}

/** The anchor keys a builder with this configuration names (the key of `audit.anchor_key_file`, the given key, the compiled keys). */
function builderKeys(config: MscdConfig, anchorPublicKeyPem?: string) {
  const builder = new OrgExportBuilder(undefined as never, config, undefined as never, undefined as never, compiledAnchorKeys());
  return builder['exportAnchorKeys']({ ...(anchorPublicKeyPem ? { anchorPublicKeyPem } : {}) } as BuildRequest);
}

describe('export verify trusts only the anchor keys of this build (D.4)', () => {
  let work: string;
  let trustedPrivate: KeyObject;
  let trustedPem: string;
  let trustedId: string;

  beforeAll(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'mscd-m3-02-verify-'));
    trustedPrivate = createPrivateKey(await readFile(ANCHOR_KEY_FILE));
    trustedPem = pemOf(createPublicKey(trustedPrivate));
    trustedId = anchorKeyId(trustedPem);
    // The test key is the anchor key compiled into the development build.
    expect(compiledAnchorKeys().map((k) => k.keyId)).toContain(trustedId);
  });
  afterAll(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('passes an anchor signed by the trusted key', async () => {
    const dir = await mkdtemp(path.join(work, 'good-'));
    await writeFolder(dir, 'risk.updated', (rowHash) => {
      const anchor = signAnchor({ chain: CHAIN, seq: 1, rowHash, anchoredAt: OCCURRED, installationId: '22222222-2222-4222-8222-222222222222' }, trustedPrivate, createPublicKey(trustedPrivate));
      return { anchor, keys: [{ keyId: trustedId, publicKeyPem: trustedPem }], pub: trustedPem };
    });
    const report = await verifyExportFolder(dir);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ ok: true, anchors: 1, anchorKeysTrusted: true, anchorKeyIds: [trustedId], auditRows: 1, lastAnchoredSeq: 1, rowsAfterLastAnchor: 0 });
  });

  it('fails a rewritten audit trail signed with a forged key that carries the trusted key id', async () => {
    const dir = await mkdtemp(path.join(work, 'forged-'));
    const attacker = generateKeyPairSync('ed25519');
    const attackerPem = pemOf(attacker.publicKey);
    const attackerId = anchorKeyId(attackerPem);
    expect(attackerId).not.toBe(trustedId);
    await writeFolder(dir, 'forged.action', (rowHash) => {
      const real = signAnchor({ chain: CHAIN, seq: 1, rowHash, anchoredAt: OCCURRED, installationId: '22222222-2222-4222-8222-222222222222' }, attacker.privateKey, attacker.publicKey);
      // The forged anchor, anchor-keys.json and the public key file all name the trusted key id with the attacker's key.
      return { anchor: { keyId: trustedId, signature: real.signature }, keys: [{ keyId: trustedId, publicKeyPem: attackerPem }], pub: attackerPem };
    });
    const report = await verifyExportFolder(dir, { trustedKeys: compiledAnchorKeys() });
    expect(report.ok).toBe(false);
    expect(report.anchorKeysTrusted).toBe(false);
    expect(report.anchorKeyIds).toEqual([]);
    expect(report.problems).toEqual(
      expect.arrayContaining([
        `audit/anchor-keys.json: the key labelled ${trustedId} has the key id ${attackerId}`,
        `audit/audit-anchor.pub holds the key ${attackerId}, which is not among the trusted anchor keys`,
        `The anchor of seq 1 has no valid signature by the trusted anchor key ${trustedId}`,
      ]),
    );
    // Every part and entry still matches its manifest: only the anchor check finds the forgery.
    expect(report.problems).toHaveLength(3);
  });

  it('fails an anchor signed by a key this build does not trust, under its real id', async () => {
    const dir = await mkdtemp(path.join(work, 'untrusted-'));
    const other = generateKeyPairSync('ed25519');
    const otherPem = pemOf(other.publicKey);
    const otherId = anchorKeyId(otherPem);
    await writeFolder(dir, 'risk.updated', (rowHash) => {
      const anchor = signAnchor({ chain: CHAIN, seq: 1, rowHash, anchoredAt: OCCURRED, installationId: '22222222-2222-4222-8222-222222222222' }, other.privateKey, other.publicKey);
      return { anchor, keys: [{ keyId: otherId, publicKeyPem: otherPem }], pub: otherPem };
    });
    const report = await verifyExportFolder(dir);
    expect(report.ok).toBe(false);
    expect(report.anchorKeysTrusted).toBe(false);
    expect(report.anchorKeyIds).toEqual([]);
    expect(report.untrustedKeyIds).toEqual([otherId]);
    expect(report.lastAnchoredSeq).toBeNull();
    expect(report.problems).toEqual([
      `audit/audit-anchor.pub holds the key ${otherId}, which is not among the trusted anchor keys`,
      `The anchor of seq 1 is signed with the key ${otherId}, which is not among the trusted anchor keys`,
    ]);
  });
});

describe('an on-premise installation signs with its own anchor key (D.4)', () => {
  let work: string;
  let keyFile: string;
  let pubFile: string;
  let pair: { privateKey: KeyObject; publicKey: KeyObject };
  let ownPem: string;
  let ownId: string;

  /** A signed anchor of `seq` with the installation's own key. */
  const ownAnchor = (seq: number, rowHash: string) => signAnchor({ chain: CHAIN, seq, rowHash, anchoredAt: OCCURRED, installationId: INSTALLATION }, pair.privateKey, pair.publicKey);

  beforeAll(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'mscd-m3-02-onprem-'));
    // As `mscd-server keys generate` makes it at install (deploy/scripts/lib/common.sh ensure_anchor_key).
    pair = generateKeyPairSync('ed25519');
    ownPem = pemOf(pair.publicKey);
    ownId = anchorKeyId(ownPem);
    expect(compiledAnchorKeys().map((k) => k.keyId)).not.toContain(ownId);
    keyFile = path.join(work, 'audit-anchor.key');
    pubFile = path.join(work, 'audit-anchor.pub');
    await writeFile(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
    await writeFile(pubFile, ownPem);
  });
  afterAll(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('names the public half of audit.anchor_key_file in audit-anchor.pub and anchor-keys.json', async () => {
    const known = builderKeys(configWith(keyFile));
    expect(known.installationKeyId).toBe(ownId);
    expect(known.keys[0]).toEqual({ keyId: ownId, publicKeyPem: ownPem });
    const rows = auditRows(['risk.updated']);
    const files = await anchorFiles(anchorTrx([anchorRow(ownAnchor(1, rows.hashes[0]!))]), CHAIN, known.keys, known.installationKeyId);
    expect(files.publicKey.toString('utf8')).toBe(ownPem);
    expect(JSON.parse(files.keys.toString('utf8'))).toEqual([{ keyId: ownId, publicKeyPem: ownPem }]);
    expect(files.unknownKeyIds).toEqual([]);
    // Without an anchor yet, the files name the key that will sign them.
    const empty = await anchorFiles(anchorTrx([]), CHAIN, known.keys, known.installationKeyId);
    expect(empty.publicKey.toString('utf8')).toBe(ownPem);
    expect(JSON.parse(empty.keys.toString('utf8'))).toEqual([{ keyId: ownId, publicKeyPem: ownPem }]);
  });

  it('takes the public key of --anchor-key when the command cannot read the private key, and never names a key that did not sign', async () => {
    // The cli service has no private anchor key: the file of its profile is missing.
    const fromCli = builderKeys(configWith(path.join(work, 'missing.key')), ownPem);
    expect(fromCli.installationKeyId).toBe(ownId);
    const rows = auditRows(['risk.updated']);
    const named = await anchorFiles(anchorTrx([anchorRow(ownAnchor(1, rows.hashes[0]!))]), CHAIN, fromCli.keys, fromCli.installationKeyId);
    expect(named.publicKey.toString('utf8')).toBe(ownPem);
    // Without that key, the anchor's key is listed without a PEM and audit-anchor.pub stays empty.
    const unknown = builderKeys(configWith(null));
    expect(unknown.installationKeyId).toBeNull();
    const files = await anchorFiles(anchorTrx([anchorRow(ownAnchor(1, rows.hashes[0]!))]), CHAIN, unknown.keys, unknown.installationKeyId);
    expect(files.publicKey.toString('utf8')).toBe('');
    expect(JSON.parse(files.keys.toString('utf8'))).toEqual([{ keyId: ownId, publicKeyPem: null }]);
    expect(files.unknownKeyIds).toEqual([ownId]);
    const none = await anchorFiles(anchorTrx([]), CHAIN, unknown.keys, unknown.installationKeyId);
    expect(none.publicKey.toString('utf8')).toBe('');
    expect(JSON.parse(none.keys.toString('utf8'))).toEqual([]);
  });

  it('fails such an export with the compiled keys alone, names the remedy, and passes it with --anchor-key', async () => {
    // The audit files as the builder writes them for this installation.
    const dir = await mkdtemp(path.join(work, 'export-'));
    const actions = ['risk.updated', 'risk.reviewed'];
    const known = builderKeys(configWith(keyFile));
    const files = await anchorFiles(anchorTrx([anchorRow(ownAnchor(2, auditRows(actions).hashes[1]!))]), CHAIN, known.keys, known.installationKeyId);
    await writeExport(dir, actions, () => ({ anchors: files.anchors.toString('utf8'), pub: files.publicKey.toString('utf8'), keys: files.keys.toString('utf8') }));

    const compiledOnly = await exportVerify(dir);
    expect(compiledOnly.ok).toBe(false);
    expect(compiledOnly.untrustedKeyIds).toEqual([ownId]);
    expect(compiledOnly.problems).toEqual([
      `audit/audit-anchor.pub holds the key ${ownId}, which is not among the trusted anchor keys`,
      `The anchor of seq 2 is signed with the key ${ownId}, which is not among the trusted anchor keys`,
    ]);
    expect(verifyLines(compiledOnly).err.join('\n')).toContain('--anchor-key');

    const withKey = await exportVerify(dir, { anchorKeys: [pubFile] });
    expect(withKey.problems).toEqual([]);
    expect(withKey).toMatchObject({ ok: true, anchorKeysTrusted: true, anchorKeyIds: [ownId], operatorKeys: [{ file: pubFile, keyId: ownId }], lastAnchoredSeq: 2, rowsAfterLastAnchor: 0 });
    const lines = verifyLines(withKey);
    expect(lines.out[0]).toContain(`${ownId} from ${pubFile}`);
    expect(lines.out[1]).toMatch(/^OK: /);
    expect(lines.out[2]).toContain('up to seq 2, the newest one');

    // A private key is refused, so it is never copied around for a check.
    await expect(exportVerify(dir, { anchorKeys: [keyFile] })).rejects.toThrow(/private key/);
  });
});

describe('the report says up to which row the anchors prove the audit trail (D.4)', () => {
  let work: string;
  let trusted: KeyObject;
  let trustedPem: string;
  let trustedId: string;

  beforeAll(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'mscd-m3-02-coverage-'));
    trusted = createPrivateKey(await readFile(ANCHOR_KEY_FILE));
    trustedPem = pemOf(createPublicKey(trusted));
    trustedId = anchorKeyId(trustedPem);
  });
  afterAll(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('counts the rows after the newest anchor', async () => {
    const dir = await mkdtemp(path.join(work, 'older-'));
    await writeExport(dir, ['a.one', 'a.two', 'a.three'], (hashes) => {
      const anchor = signAnchor({ chain: CHAIN, seq: 1, rowHash: hashes[0]!, anchoredAt: OCCURRED, installationId: INSTALLATION }, trusted, createPublicKey(trusted));
      return { anchors: `${JSON.stringify(anchor)}\n`, pub: trustedPem, keys: JSON.stringify([{ keyId: trustedId, publicKeyPem: trustedPem }]) };
    });
    const report = await exportVerify(dir);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ ok: true, auditRows: 3, lastAnchoredSeq: 1, rowsAfterLastAnchor: 2 });
    expect(verifyLines(report).out[2]).toContain('up to seq 1; no signature covers the 2 newer row(s)');
  });

  it('says no signature proves a trail whose anchors were all removed', async () => {
    // A rewritten trail with an empty anchors file and a manifest that names no anchor: every hash matches.
    const dir = await mkdtemp(path.join(work, 'stripped-'));
    await writeExport(dir, ['forged.one', 'forged.two'], () => ({ anchors: '', pub: trustedPem, keys: JSON.stringify([{ keyId: trustedId, publicKeyPem: trustedPem }]) }));
    const report = await exportVerify(dir);
    expect(report).toMatchObject({ ok: true, anchors: 0, anchorKeysTrusted: null, lastAnchoredSeq: null, rowsAfterLastAnchor: 2 });
    const lines = verifyLines(report);
    expect(lines.out[2]).toContain('No anchor: no signature proves any of the 2 audit row(s)');
    expect(lines.out[2]).toContain('anchors kept outside MSCD');
  });
});
