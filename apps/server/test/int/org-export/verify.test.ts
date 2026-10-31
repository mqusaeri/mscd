// `export verify` and its anchor keys (Milestone 3 D.4), without a database: an export folder written with the archive
// writer holds audit rows and signed anchors. Verify passes when the anchor is signed by the anchor key compiled into
// this build. It fails when someone rewrites the audit trail, signs a new anchor with a key of their own and labels
// that key with the trusted key id (the manifest, the parts and anchor-keys.json are not signed, so they can all be
// rewritten too), and it fails when an anchor is signed by a key this build does not trust, even under that key's real
// id. On-premise, each installation signs with its own key (`keys generate` at install): the builder names that key
// in the export, and verify trusts it only when the operator names its public key file with `--anchor-key`. The report
// says up to which row the anchors prove the trail, also when the newest anchors were removed. A redacted row keeps its
// stored hash, so only its attestation entry explains its content: the anchors prove that content only when a valid
// anchor covers the attestation (D.5.4), so a rewritten anchored row with a forged attestation after the newest anchor
// is reported without anchor proof.
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

/** The audit trail of an export: its JSON lines and the row hash of each row. */
interface Trail {
  lines: string;
  hashes: string[];
}

/** Writes an export folder (parts and the separate manifest) with these audit rows (actions, or a trail) and audit files. */
async function writeExport(dir: string, trail: string[] | Trail, files: (hashes: string[]) => AuditFiles): Promise<void> {
  const rows = Array.isArray(trail) ? auditRows(trail) : trail;
  const rowCount = rows.hashes.length;
  const audit = files(rows.hashes);
  const anchorCount = audit.anchors.split('\n').filter((l) => l.trim() !== '').length;
  const writer = new ArchiveWriter({ dir, baseName: BASE, partBytes: 1024 * 1024, mtime: new Date(OCCURRED), onPart: async () => undefined });
  const entries: ManifestEntry[] = [
    manifestEntry(await writer.addBuffer('audit/audit_trail.jsonl', Buffer.from(rows.lines)), 'audit', { rows: rowCount }),
    manifestEntry(await writer.addBuffer('audit/anchors.jsonl', Buffer.from(audit.anchors)), 'anchors', { rows: anchorCount }),
    manifestEntry(await writer.addBuffer('audit/audit-anchor.pub', Buffer.from(audit.pub)), 'key'),
    manifestEntry(await writer.addBuffer('audit/anchor-keys.json', Buffer.from(audit.keys)), 'key'),
  ];
  const keyIds = (JSON.parse(audit.keys) as { keyId: string }[]).map((k) => k.keyId);
  const manifest = (copy: ExportManifest['copy'], parts: ExportManifest['parts']): ExportManifest => ({
    format: 'mscd-organization-export', formatVersion: 1, copy, exportId: '33333333-3333-4333-8333-333333333333', organization: { id: 'x', slug: 'tst', name: 'Test' },
    createdAt: OCCURRED, requestedVia: 'cli', requestedBy: null, approvedBy: null, isFinal: false, mscd: { version: 'test', revision: 'test' }, tenantMigrations: [],
    tenantMigrationsSource: 'build', frameworkPacks: [], parts, entries, filesWithoutContent: [],
    audit: { chain: CHAIN, rows: rowCount, anchors: anchorCount, anchorKeyIds: keyIds }, excluded: [],
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

/** The hashed columns of an audit row, in the order of `platform.audit_canonical_text`. */
const HASHED = [
  'seq', 'id', 'occurred_at', 'organization_id', 'management_system_id', 'actor_user_id', 'actor_kind', 'action', 'entity_type', 'entity_id', 'entity_code',
  'before_data', 'after_data', 'edition', 'request_id', 'source_ip', 'user_agent',
] as const;
type AuditRow = Record<string, unknown>;

const hashOf = (prev: string, canonical: string) => createHash('sha256').update(Buffer.from(prev, 'hex')).update(canonical, 'utf8').digest('hex');
const canonicalOf = (row: AuditRow) => JSON.stringify(HASHED.map((key) => row[key] ?? null));

/** A chained audit row of `seq` after the row whose hash is `prev`. */
function chainRow(seq: number, prev: string, fields: AuditRow = {}): AuditRow {
  const row: AuditRow = {
    seq, id: `11111111-1111-4111-8111-${String(seq).padStart(12, '0')}`, occurred_at: OCCURRED, organization_id: null, management_system_id: null,
    actor_user_id: null, actor_kind: 'user', action: 'risk.updated', entity_type: 'risk', entity_id: null, entity_code: 'R-001', before_data: null,
    after_data: { status: 'treated', owner: 'rina' }, edition: null, request_id: null, source_ip: '203.0.113.7', user_agent: 'Browser/1', ...fields,
  };
  const canonical = canonicalOf(row);
  return { ...row, prev_hash: prev, row_hash: hashOf(prev, canonical), redacted_at: null, redaction_id: null, canonical_text: canonical };
}

/** `row` with these values changed and marked redacted: it keeps its stored hashes, and its canonical text holds the new values. */
function redacted(row: AuditRow, fields: AuditRow, redactionId: string): { row: AuditRow; listed: { seq: number; rowHash: string; redactedHash: string } } {
  const changed: AuditRow = { ...row, source_ip: null, user_agent: null, ...fields };
  const canonical = canonicalOf(changed);
  return {
    row: { ...changed, canonical_text: canonical, redacted_at: OCCURRED, redaction_id: redactionId },
    listed: { seq: Number(row.seq), rowHash: String(row.row_hash), redactedHash: hashOf(String(row.prev_hash), canonical) },
  };
}

/** The attestation entry of a redaction, as `platform.redact_audit_rows` writes it. */
function attestation(seq: number, prev: string, redactionId: string, rows: { seq: number; rowHash: string; redactedHash: string }[]): AuditRow {
  return chainRow(seq, prev, {
    actor_kind: 'system', action: 'privacy.audit_redacted', entity_type: 'audit_trail', entity_code: 'redaction', after_data: { redactionId, count: rows.length, rows },
    source_ip: null, user_agent: null,
  });
}

const trailOf = (rows: AuditRow[]): Trail => ({ lines: rows.map((r) => `${JSON.stringify(r)}\n`).join(''), hashes: rows.map((r) => String(r.row_hash)) });

describe('a redacted row is proven only through an attestation that an anchor covers (D.5.4)', () => {
  let work: string;
  let trusted: KeyObject;
  let trustedPem: string;
  let trustedId: string;

  /** The audit files with one anchor of `seq` signed by the trusted key. */
  const anchoredAt = (seq: number) => (hashes: string[]): AuditFiles => {
    const anchor = signAnchor({ chain: CHAIN, seq, rowHash: hashes[seq - 1]!, anchoredAt: OCCURRED, installationId: INSTALLATION }, trusted, createPublicKey(trusted));
    return { anchors: `${JSON.stringify(anchor)}\n`, pub: trustedPem, keys: JSON.stringify([{ keyId: trustedId, publicKeyPem: trustedPem }]) };
  };

  beforeAll(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'mscd-m3-02-redaction-'));
    trusted = createPrivateKey(await readFile(ANCHOR_KEY_FILE));
    trustedPem = pemOf(createPublicKey(trusted));
    trustedId = anchorKeyId(trustedPem);
  });
  afterAll(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('proves a redacted row whose attestation lies at or below the newest anchor', async () => {
    const dir = await mkdtemp(path.join(work, 'above-'));
    const r1 = chainRow(1, '');
    const redactionId = '44444444-4444-4444-8444-000000000001';
    const red = redacted(r1, { after_data: { status: 'treated', owner: 'P-0001' } }, redactionId);
    const r2 = attestation(2, String(r1.row_hash), redactionId, [red.listed]);
    const r3 = chainRow(3, String(r2.row_hash), { action: 'risk.closed' });
    // The anchor signs seq 3, above the attestation of seq 2.
    await writeExport(dir, trailOf([red.row, r2, r3]), anchoredAt(3));
    const report = await exportVerify(dir);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({
      ok: true, auditRows: 3, redactedRows: 1, redactedUnanchored: 0, redactedUnanchoredSeqs: [], newestAnchoredSeq: 3, lastAnchoredSeq: 3, rowsAfterLastAnchor: 0,
    });
    const lines = verifyLines(report);
    expect(lines.out[0]).toContain('3 audit rows (1 redacted)');
    expect(lines.out[2]).toContain('up to seq 3, the newest one');
    expect(lines.out).toHaveLength(3);
  });

  it('gives no anchor proof to a rewritten anchored row whose forged attestation follows the newest anchor', async () => {
    // The genuine export: rows 1 and 2, anchored at seq 2.
    const r1 = chainRow(1, '');
    const r2 = chainRow(2, String(r1.row_hash), { action: 'risk.closed' });
    const genuine = await mkdtemp(path.join(work, 'genuine-'));
    await writeExport(genuine, trailOf([r1, r2]), anchoredAt(2));
    expect(await exportVerify(genuine)).toMatchObject({ ok: true, redactedRows: 0, lastAnchoredSeq: 2, rowsAfterLastAnchor: 0 });

    // The forgery: row 1 rewritten (another action and content), its stored hash kept, marked redacted, and an
    // attestation appended as row 3 after the anchor. Every hash matches, and the anchor of seq 2 still verifies.
    const forged = await mkdtemp(path.join(work, 'forged-redaction-'));
    const redactionId = '44444444-4444-4444-8444-000000000002';
    const fake = redacted(r1, { action: 'risk.accepted', after_data: { status: 'accepted', approvedBy: 'top.management' } }, redactionId);
    const r3 = attestation(3, String(r2.row_hash), redactionId, [fake.listed]);
    await writeExport(forged, trailOf([fake.row, r2, r3]), anchoredAt(2));
    const report = await exportVerify(forged);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({
      auditRows: 3, anchors: 1, anchorKeysTrusted: true, redactedRows: 0, redactedUnanchored: 1, redactedUnanchoredSeqs: [1], newestAnchoredSeq: 2,
      lastAnchoredSeq: null, rowsAfterLastAnchor: 3,
    });
    // The output never says the anchor proves row 1: no row is proven, and the redacted row is named.
    const lines = verifyLines(report);
    expect(lines.out[0]).toContain('3 audit rows (1 redacted, 1 of them without an anchor over their attestation)');
    expect(lines.out[2]).toContain('No anchor proves the audit trail: the newest valid anchor signs seq 2, but the content of the redacted row 1');
    expect(lines.out[2]).not.toMatch(/prove (every audit row|the audit rows) up to/);
    expect(lines.out[3]).toContain('Redacted rows without an anchor: 1 row(s) (seq 1)');
  });

  it('ends the coverage before the first rewritten row when older rows are untouched', async () => {
    const r1 = chainRow(1, '');
    const r2 = chainRow(2, String(r1.row_hash), { action: 'risk.reviewed' });
    const r3 = chainRow(3, String(r2.row_hash), { action: 'risk.closed' });
    const dir = await mkdtemp(path.join(work, 'forged-middle-'));
    const redactionId = '44444444-4444-4444-8444-000000000003';
    const fake = redacted(r2, { after_data: { status: 'accepted' } }, redactionId);
    const r4 = attestation(4, String(r3.row_hash), redactionId, [fake.listed]);
    await writeExport(dir, trailOf([r1, fake.row, r3, r4]), anchoredAt(3));
    const report = await exportVerify(dir);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ redactedRows: 0, redactedUnanchored: 1, redactedUnanchoredSeqs: [2], newestAnchoredSeq: 3, lastAnchoredSeq: 1, rowsAfterLastAnchor: 3 });
    const lines = verifyLines(report);
    expect(lines.out[2]).toContain('The anchors prove the audit rows up to seq 1: the newest valid anchor signs seq 3, but the content of the redacted row 2');
  });

  it('counts a redaction made after the newest anchor apart without lowering the coverage below it', async () => {
    const r1 = chainRow(1, '');
    const r2 = chainRow(2, String(r1.row_hash), { action: 'risk.reviewed' });
    const r3 = chainRow(3, String(r2.row_hash), { action: 'risk.closed' });
    const dir = await mkdtemp(path.join(work, 'after-anchor-'));
    const redactionId = '44444444-4444-4444-8444-000000000004';
    const red = redacted(r3, { entity_code: 'P-0001' }, redactionId);
    const r4 = attestation(4, String(r3.row_hash), redactionId, [red.listed]);
    await writeExport(dir, trailOf([r1, r2, red.row, r4]), anchoredAt(2));
    const report = await exportVerify(dir);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ ok: true, redactedRows: 0, redactedUnanchored: 1, redactedUnanchoredSeqs: [3], newestAnchoredSeq: 2, lastAnchoredSeq: 2, rowsAfterLastAnchor: 2 });
    expect(verifyLines(report).out[2]).toContain('up to seq 2; no signature covers the 2 newer row(s)');
  });

  it('follows an attestation entry that was itself redacted to the attestation that accepts it', async () => {
    const r1 = chainRow(1, '');
    const first = '44444444-4444-4444-8444-000000000005';
    const red1 = redacted(r1, { entity_code: 'P-0001' }, first);
    const att2 = attestation(2, String(r1.row_hash), first, [red1.listed]);
    const r3 = chainRow(3, String(att2.row_hash), { action: 'risk.closed' });
    // A later redaction changes the attestation entry of seq 2 too; its own attestation is seq 4.
    const second = '44444444-4444-4444-8444-000000000006';
    const red2 = redacted(att2, { entity_code: 'P-0002' }, second);
    const att4 = attestation(4, String(r3.row_hash), second, [red2.listed]);
    const rows = [red1.row, red2.row, r3, att4];

    const covered = await mkdtemp(path.join(work, 'nested-covered-'));
    await writeExport(covered, trailOf(rows), anchoredAt(4));
    const ok = await exportVerify(covered);
    expect(ok.problems).toEqual([]);
    expect(ok).toMatchObject({ redactedRows: 2, redactedUnanchored: 0, lastAnchoredSeq: 4 });

    // Anchored at seq 3 only: the entry of seq 2 is explained by seq 4, so neither redacted row is proven.
    const open = await mkdtemp(path.join(work, 'nested-open-'));
    await writeExport(open, trailOf(rows), anchoredAt(3));
    const report = await exportVerify(open);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ redactedRows: 0, redactedUnanchored: 2, redactedUnanchoredSeqs: [1, 2], newestAnchoredSeq: 3, lastAnchoredSeq: null, rowsAfterLastAnchor: 4 });
  });

  it('still fails a redacted row that no attestation lists', async () => {
    const r1 = chainRow(1, '');
    const r2 = chainRow(2, String(r1.row_hash), { action: 'risk.closed' });
    const dir = await mkdtemp(path.join(work, 'unlisted-'));
    const fake = redacted(r1, { action: 'risk.accepted' }, '44444444-4444-4444-8444-000000000007');
    await writeExport(dir, trailOf([fake.row, r2]), anchoredAt(2));
    const report = await exportVerify(dir);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(['Audit chain broken at seq 1: a redacted row has no attestation that lists its stored and current hash']);
  });
});
