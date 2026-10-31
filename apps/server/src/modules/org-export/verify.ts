// `mscd-server export verify --dir <dir>` (Milestone 3 D.4): checks an organisation export in a folder.
//
// 1. The manifest: `manifest.json` (or `*-manifest.json`, the separate download) in the folder, else the copy in the
//    last part.
// 2. Every part named by the manifest is in the folder with the size and SHA-256 the manifest gives (the copy in the
//    last part cannot give its own part's values).
// 3. Every part is unpacked as a stream: each entry, and each piece of an entry cut into pieces, has the part, size and
//    SHA-256 of the manifest; nothing is missing and nothing is added.
// 4. The audit chain (`audit/audit_trail.jsonl`): every row links to the previous one, its canonical text describes the
//    row's own values, and SHA-256 of the previous hash bytes and the UTF-8 canonical text equals its `row_hash`; a
//    redacted row is accepted when a later attestation entry (`tenant.audit_redacted`, `user.audit_redacted`,
//    `privacy.audit_redacted`) lists it with its stored hash and the hash of the row as it is now (D.5.4). The
//    attestation entry is an ordinary chained row; when it was itself redacted later, its own attestation explains it.
// 5. The anchors, with the anchor keys the caller trusts, never with a key the export brings: the manifest, the parts
//    and the audit files are not signed, so whoever changes the audit trail can also change them. The command trusts
//    the anchor keys compiled into this build (`compiledAnchorKeys`, D-16) and the public keys the operator names with
//    `--anchor-key <file>` (on-premise, each installation signs with its own key: `secrets/audit-anchor.pub`). Every
//    anchor of `audit/anchors.jsonl` must be signed by a trusted key (the key of its `keyId`, with the trusted PEM),
//    belong to the export's chain, and name the `rowHash` of the row with its `seq`. An anchor signed by a key the
//    caller does not trust is a problem. The keys of `audit/anchor-keys.json` must carry their real key id (SHA-256 of
//    the SPKI, `anchorKeyId`), and the key of `audit/audit-anchor.pub` must be trusted, so the files a customer checks
//    by hand cannot name another key than the one that signed.
// 6. Coverage: an anchor proves its row and every row before it (each row's hash covers the previous one). The report
//    gives the seq of the newest row a valid anchor proves and the number of rows after it, which no signature covers:
//    rows written since the last nightly anchor, or rows of a trail whose newest anchors were removed. Only the anchors
//    kept outside MSCD (worker log, vault objects, downloaded files) show whether newer anchors existed.
//    A redacted row keeps its stored hash, so the anchor proves where it sits in the chain but not its content: only the
//    attestation entry explains that, and D.5.4 wants that entry covered by an anchor. A redacted row whose attestation
//    lies after the newest valid anchor is counted apart (`redactedUnanchored`), and the coverage ends before the first
//    such row, so the report never says the anchors prove a row whose content only an unsigned attestation explains
//    (someone who rewrites an anchored row, keeps its hash, marks it redacted and appends an attestation after the
//    newest anchor gets every hash to match, and the report then says no anchor proves that row).
import { createHash, createPublicKey, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
import { createGunzip } from 'node:zlib';
import { anchorKeyId, compiledAnchorKeys, verifyAnchorSignature, type SignedAnchor } from '../audit/anchors';
import type { AnchorKeys } from '../audit/chain-verifier';
import { readTar } from './archive/tar-reader';
import { MANIFEST_FORMAT, MANIFEST_NAME, type ExportManifest, type ManifestEntry } from './manifest';

/** The attestation actions of attested redaction (Milestone 3 D.5.4). */
const ATTESTATION_ACTIONS = new Set(['tenant.audit_redacted', 'user.audit_redacted', 'privacy.audit_redacted']);
const AUDIT_TRAIL = 'audit/audit_trail.jsonl';
const ANCHORS = 'audit/anchors.jsonl';
const ANCHOR_KEYS = 'audit/anchor-keys.json';
const ANCHOR_PUB = 'audit/audit-anchor.pub';
const PART_FILE = /-part-(\d+)\.tar\.gz$/;

export interface VerifyReport {
  ok: boolean;
  problems: string[];
  manifestSource: 'download' | 'last-part';
  parts: number;
  entries: number;
  files: number;
  auditRows: number;
  /** Redacted rows whose content a valid anchor proves: their attestation entry lies at or below the newest valid anchor. */
  redactedRows: number;
  /** Redacted rows listed by an attestation entry that no valid anchor covers: no signature proves their content. */
  redactedUnanchored: number;
  /** The seqs of those rows, in order. */
  redactedUnanchoredSeqs: number[];
  anchors: number;
  /** True when every anchor has a valid signature by a trusted key; false when one has not (a problem); null without anchors. */
  anchorKeysTrusted: boolean | null;
  /** Ids of the trusted keys whose signatures were checked. */
  anchorKeyIds: string[];
  /** Key ids of anchors signed by a key the caller does not trust. */
  untrustedKeyIds: string[];
  /** Seq of the newest audit row a valid trusted anchor signs; null without such an anchor. */
  newestAnchoredSeq: number | null;
  /**
   * Seq of the newest audit row the anchors prove with every row before it: `newestAnchoredSeq`, or the row before the
   * first redacted row whose attestation no valid anchor covers when that row lies below it; null when no row is proven.
   */
  lastAnchoredSeq: number | null;
  /** Audit rows after `lastAnchoredSeq` (every row when it is null): the anchors do not prove them. */
  rowsAfterLastAnchor: number;
}

export interface VerifyOptions {
  /**
   * The anchor keys to trust (default: the anchor keys compiled into this build). The command adds the keys of
   * `--anchor-key`. Never the keys of the export.
   */
  trustedKeys?: AnchorKeys;
}

/**
 * The public anchor key of a file the operator names (`--anchor-key`): a PEM public Ed25519 key, such as
 * `secrets/audit-anchor.pub` of an on-premise installation. A private key is refused, so it is never copied around.
 */
export async function readAnchorKeyFile(file: string): Promise<{ keyId: string; publicKeyPem: string }> {
  const text = await readFile(file, 'utf8');
  if (/PRIVATE KEY/.test(text)) throw new Error(`${file} holds a private key; give the public anchor key (audit-anchor.pub)`);
  let publicKeyPem: string;
  try {
    const key = createPublicKey(text);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
    publicKeyPem = key.export({ type: 'spki', format: 'pem' }).toString();
  } catch (error) {
    throw new Error(`${file} is no public Ed25519 anchor key: ${(error as Error).message}`);
  }
  return { keyId: anchorKeyId(publicKeyPem), publicKeyPem };
}

/** The real key id of a PEM public key (`anchorKeyId`), or null when it is no public key. */
function keyIdOf(pem: string): string | null {
  try {
    return anchorKeyId(pem);
  } catch {
    return null;
  }
}

/** One row listed by an attestation entry: the entry's seq and redaction id, and the row's seq and hashes. */
interface Attestation {
  attestationSeq: number;
  redactionId: string;
  seq: number;
  rowHash: string;
  redactedHash: string;
}

/** Hashes and line-parses the audit trail while its entry (or pieces) streams by. */
class AuditChecker {
  rows = 0;
  /**
   * The redacted rows an attestation accepts, each with the seq of the row whose signature would prove its content:
   * the attestation entry that lists it, or, when that entry was itself redacted later, the entry that accepts it.
   */
  readonly accepted: { seq: number; proofSeq: number }[] = [];
  private previousHash = '';
  private previousSeq = 0;
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private readonly redactedRows: { seq: number; redactionId: string; rowHash: string; currentHash: string }[] = [];
  private readonly attestations: Attestation[] = [];
  /** Attestation entries whose content does not hash to their stored hash and is not marked redacted: they prove nothing. */
  private readonly brokenAttestations = new Set<number>();
  readonly hashes = new Map<number, string>();

  constructor(private readonly problems: string[]) {}

  feed(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    let newline = this.pending.indexOf('\n');
    while (newline !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (line.trim() !== '') this.row(line);
      newline = this.pending.indexOf('\n');
    }
  }

  private broken(seq: unknown, why: string): void {
    if (this.problems.length < 200) this.problems.push(`Audit chain broken at seq ${String(seq)}: ${why}`);
  }

  private row(line: string): void {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.broken(this.previousSeq + 1, 'a line of audit_trail.jsonl is not JSON');
      return;
    }
    this.rows += 1;
    const seq = Number(row.seq);
    const prevHash = String(row.prev_hash ?? '');
    const rowHash = String(row.row_hash ?? '');
    const canonical = typeof row.canonical_text === 'string' ? row.canonical_text : '';
    if (seq !== this.previousSeq + 1) this.broken(seq, `expected seq ${this.previousSeq + 1}`);
    if (prevHash !== this.previousHash) this.broken(seq, 'prev_hash is not the row_hash of the previous row');
    const describes = this.describes(row, canonical);
    if (describes) this.broken(seq, describes);
    const computed = createHash('sha256').update(Buffer.from(prevHash, 'hex')).update(canonical, 'utf8').digest('hex');
    const isAttestation = ATTESTATION_ACTIONS.has(String(row.action));
    if (typeof row.redaction_id === 'string' && row.redaction_id !== '') {
      this.redactedRows.push({ seq, redactionId: row.redaction_id, rowHash, currentHash: computed });
    } else if (computed !== rowHash) {
      this.broken(seq, 'row_hash does not match the hash of the canonical text');
      if (isAttestation) this.brokenAttestations.add(seq);
    }
    if (isAttestation) {
      const after = (row.after_data ?? {}) as { redactionId?: unknown; rows?: unknown };
      if (Array.isArray(after.rows)) {
        for (const e of after.rows as Record<string, unknown>[]) {
          this.attestations.push({
            attestationSeq: seq,
            redactionId: String(after.redactionId ?? ''),
            seq: Number(e.seq),
            rowHash: String(e.rowHash ?? ''),
            redactedHash: String(e.redactedHash ?? ''),
          });
        }
      }
    }
    this.hashes.set(seq, rowHash);
    this.previousHash = rowHash;
    this.previousSeq = seq;
  }

  /** Null when the canonical text holds the row's own values, else what differs. */
  private describes(row: Record<string, unknown>, canonical: string): string | null {
    let values: unknown[];
    try {
      values = JSON.parse(canonical) as unknown[];
    } catch {
      return 'canonical_text is not a JSON array';
    }
    if (!Array.isArray(values) || values.length !== 17) return 'canonical_text does not have the 17 hashed values';
    const keys = [
      'seq', 'id', 'occurred_at', 'organization_id', 'management_system_id', 'actor_user_id', 'actor_kind', 'action', 'entity_type', 'entity_id',
      'entity_code', 'before_data', 'after_data', 'edition', 'request_id', 'source_ip', 'user_agent',
    ];
    for (const [index, key] of keys.entries()) {
      const fromText = values[index] ?? null;
      const fromRow = row[key] ?? null;
      if (key === 'occurred_at') {
        if (Date.parse(String(fromText)) !== Date.parse(String(fromRow))) return 'occurred_at differs from the canonical text';
      } else if (!isDeepStrictEqual(fromText, fromRow)) {
        return `${key} differs from the canonical text`;
      }
    }
    return null;
  }

  finish(): void {
    const rest = this.pending + this.decoder.end();
    this.pending = '';
    if (rest.trim() !== '') this.row(rest);
    // Newest first, so a redacted attestation entry is settled before the rows it lists.
    const proofOf = new Map<number, number>();
    const redactedSeqs = new Set(this.redactedRows.map((r) => r.seq));
    const listing = new Map<number, Attestation[]>();
    for (const a of this.attestations) {
      const list = listing.get(a.seq);
      if (list) list.push(a);
      else listing.set(a.seq, [a]);
    }
    for (const r of [...this.redactedRows].sort((a, b) => b.seq - a.seq)) {
      let proofSeq: number | null = null;
      for (const a of listing.get(r.seq) ?? []) {
        if (a.attestationSeq <= r.seq || a.redactionId !== r.redactionId || a.rowHash !== r.rowHash || a.redactedHash !== r.currentHash) continue;
        if (this.brokenAttestations.has(a.attestationSeq)) continue;
        // A redacted attestation entry proves its list only through the attestation that accepts it.
        const through = redactedSeqs.has(a.attestationSeq) ? proofOf.get(a.attestationSeq) : a.attestationSeq;
        if (through !== undefined && (proofSeq === null || through < proofSeq)) proofSeq = through;
      }
      if (proofSeq === null) {
        this.broken(r.seq, 'a redacted row has no attestation that lists its stored and current hash');
        continue;
      }
      proofOf.set(r.seq, proofSeq);
      this.accepted.push({ seq: r.seq, proofSeq });
    }
    this.accepted.sort((a, b) => a.seq - b.seq);
  }
}

/** The part files of the folder by number. */
async function partFiles(dir: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const name of await readdir(dir)) {
    const match = PART_FILE.exec(name);
    if (match) out.set(Number(match[1]), path.join(dir, name));
  }
  return out;
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The copy of the manifest in a part (the last entry of the last part). */
async function manifestInPart(file: string): Promise<Buffer | null> {
  let found: Buffer | null = null;
  await readTar(createReadStream(file).pipe(createGunzip()), async (header, body) => {
    if (header.name !== MANIFEST_NAME) return;
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk);
    found = Buffer.concat(chunks);
  });
  return found;
}

/** Checks the export in `dir`; never throws for a problem of the export itself (the report lists it). */
export async function verifyExportFolder(dir: string, options: VerifyOptions = {}): Promise<VerifyReport> {
  const problems: string[] = [];
  const parts = await partFiles(dir);
  const report: VerifyReport = {
    ok: false, problems, manifestSource: 'download', parts: parts.size, entries: 0, files: 0, auditRows: 0, redactedRows: 0, redactedUnanchored: 0,
    redactedUnanchoredSeqs: [], anchors: 0, anchorKeysTrusted: null, anchorKeyIds: [], untrustedKeyIds: [], newestAnchoredSeq: null, lastAnchoredSeq: null,
    rowsAfterLastAnchor: 0,
  };
  if (parts.size === 0) {
    problems.push(`No part (*-part-<n>.tar.gz) in ${dir}`);
    return report;
  }

  // 1. The manifest.
  const downloaded = (await readdir(dir)).find((n) => n === MANIFEST_NAME || n.endsWith('-manifest.json'));
  let manifestText: Buffer | null = downloaded ? await readFile(path.join(dir, downloaded)) : null;
  if (!manifestText) {
    report.manifestSource = 'last-part';
    manifestText = await manifestInPart(parts.get(Math.max(...parts.keys()))!);
  }
  if (!manifestText) {
    problems.push('No manifest: neither manifest.json in the folder nor in the last part');
    return report;
  }
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(manifestText.toString('utf8')) as ExportManifest;
  } catch {
    problems.push('The manifest is not JSON');
    return report;
  }
  if (manifest.format !== MANIFEST_FORMAT || manifest.formatVersion !== 1) {
    problems.push(`The manifest has format ${String(manifest.format)} ${String(manifest.formatVersion)}, not ${MANIFEST_FORMAT} 1`);
    return report;
  }
  report.manifestSource = manifest.copy === 'last-part' ? 'last-part' : 'download';

  // 2. The parts.
  for (const part of manifest.parts) {
    const file = parts.get(part.part);
    if (!file) {
      problems.push(`Part ${part.part} (${part.name}) is missing`);
      continue;
    }
    if (path.basename(file) !== part.name) problems.push(`Part ${part.part} is named ${path.basename(file)}, not ${part.name}`);
    if (part.sizeBytes !== null && (await stat(file)).size !== part.sizeBytes) problems.push(`Part ${part.part} has another size than the manifest gives`);
    if (part.sha256 !== null && (await fileSha256(file)) !== part.sha256) problems.push(`Part ${part.part} has another SHA-256 than the manifest gives`);
  }
  for (const number of parts.keys()) if (!manifest.parts.some((p) => p.part === number)) problems.push(`Part ${number} is not in the manifest`);

  // 3. The entries.
  const expected = new Map<string, { part: number; sizeBytes: number; sha256: string }>();
  const whole = new Map<string, ManifestEntry>();
  for (const entry of manifest.entries) {
    if (entry.pieces) {
      whole.set(entry.path, entry);
      for (const piece of entry.pieces) expected.set(piece.path, piece);
    } else if (entry.part !== null) {
      expected.set(entry.path, { part: entry.part, sizeBytes: entry.sizeBytes, sha256: entry.sha256 });
    }
  }
  const pieceOwner = new Map<string, string>();
  for (const entry of whole.values()) for (const piece of entry.pieces ?? []) pieceOwner.set(piece.path, entry.path);
  const wholeHashes = new Map<string, Hash>();
  const seen = new Set<string>();
  const audit = new AuditChecker(problems);
  let anchorsText = '';
  let keysText = '';
  let pubText = '';
  for (const number of [...parts.keys()].sort((a, b) => a - b)) {
    try {
      await readTar(createReadStream(parts.get(number)!).pipe(createGunzip()), async (header, body) => {
        const isManifest = header.name === MANIFEST_NAME;
        const want = expected.get(header.name);
        const owner = pieceOwner.get(header.name) ?? null;
        const logical = owner ?? header.name;
        const hash = createHash('sha256');
        let ownerHash: Hash | undefined;
        if (owner) {
          ownerHash = wholeHashes.get(owner) ?? createHash('sha256');
          wholeHashes.set(owner, ownerHash);
        }
        let size = 0;
        const text: Buffer[] = [];
        for await (const chunk of body) {
          size += chunk.length;
          hash.update(chunk);
          ownerHash?.update(chunk);
          if (logical === AUDIT_TRAIL) audit.feed(chunk);
          else if (logical === ANCHORS || logical === ANCHOR_KEYS || logical === ANCHOR_PUB) text.push(chunk);
        }
        if (logical === ANCHORS) anchorsText += Buffer.concat(text).toString('utf8');
        if (logical === ANCHOR_KEYS) keysText += Buffer.concat(text).toString('utf8');
        if (logical === ANCHOR_PUB) pubText += Buffer.concat(text).toString('utf8');
        if (isManifest) return;
        if (!want) {
          problems.push(`${header.name} in part ${number} is not in the manifest`);
          return;
        }
        seen.add(header.name);
        if (want.part !== number) problems.push(`${header.name} is in part ${number}, not in part ${want.part}`);
        if (size !== want.sizeBytes) problems.push(`${header.name} has ${size} bytes, not ${want.sizeBytes}`);
        if (hash.digest('hex') !== want.sha256) problems.push(`${header.name} has another SHA-256 than the manifest gives`);
      });
    } catch (error) {
      problems.push(`Part ${number} cannot be read: ${(error as Error).message}`);
    }
  }
  for (const name of expected.keys()) if (!seen.has(name)) problems.push(`${name} is missing from the parts`);
  for (const [name, entry] of whole) {
    const hash = wholeHashes.get(name);
    if (hash && hash.digest('hex') !== entry.sha256) problems.push(`${name} (joined from its pieces) has another SHA-256 than the manifest gives`);
  }
  report.entries = manifest.entries.length;
  report.files = manifest.entries.filter((e) => e.kind === 'file').length;

  // 4. The audit chain.
  audit.finish();
  report.auditRows = audit.rows;
  if (manifest.audit && audit.rows !== manifest.audit.rows) problems.push(`The audit trail has ${audit.rows} rows, the manifest names ${manifest.audit.rows}`);

  // 5. The anchors, with the trusted keys only (a key the export brings proves nothing: the export is not signed).
  const trusted = (options.trustedKeys ?? compiledAnchorKeys()).filter((k) => keyIdOf(k.publicKeyPem) === k.keyId);
  let keys: unknown = [];
  try {
    keys = keysText.trim() === '' ? [] : JSON.parse(keysText);
  } catch {
    problems.push('audit/anchor-keys.json is not JSON');
  }
  if (!Array.isArray(keys)) {
    problems.push('audit/anchor-keys.json is not a list');
    keys = [];
  }
  for (const key of keys as unknown[]) {
    const entry = (key ?? {}) as { keyId?: unknown; publicKeyPem?: unknown };
    // A null PEM names a key the exporting server did not know; its anchors fail below unless this build trusts it.
    if (typeof entry.publicKeyPem !== 'string') continue;
    const label = String(entry.keyId);
    const actual = keyIdOf(entry.publicKeyPem);
    if (actual === null) problems.push(`audit/anchor-keys.json: the key labelled ${label} is no valid public key`);
    else if (actual !== label) problems.push(`audit/anchor-keys.json: the key labelled ${label} has the key id ${actual}`);
  }
  if (pubText.trim() !== '') {
    const actual = keyIdOf(pubText);
    if (actual === null) problems.push('audit/audit-anchor.pub is no valid public key');
    else if (!trusted.some((k) => k.keyId === actual)) problems.push(`audit/audit-anchor.pub holds the key ${actual}, which is not among the trusted anchor keys`);
  }
  let unverified = 0;
  const checkedKeys = new Set<string>();
  const untrusted = new Set<string>();
  for (const line of anchorsText.split('\n')) {
    if (line.trim() === '') continue;
    report.anchors += 1;
    let anchor: SignedAnchor & { consistent?: boolean };
    try {
      anchor = JSON.parse(line) as SignedAnchor & { consistent?: boolean };
    } catch {
      unverified += 1;
      problems.push('A line of audit/anchors.jsonl is not JSON');
      continue;
    }
    const seq = String(anchor.seq);
    if (anchor.consistent === false) {
      unverified += 1;
      problems.push(`The anchor of seq ${seq} does not match its stored payload`);
      continue;
    }
    if (manifest.audit && anchor.chain !== manifest.audit.chain) problems.push(`The anchor of seq ${seq} belongs to the chain ${String(anchor.chain)}, not ${manifest.audit.chain}`);
    const key = trusted.find((k) => k.keyId === anchor.keyId);
    if (!key) {
      unverified += 1;
      untrusted.add(String(anchor.keyId));
      problems.push(`The anchor of seq ${seq} is signed with the key ${String(anchor.keyId)}, which is not among the trusted anchor keys`);
      continue;
    }
    if (!verifyAnchorSignature(anchor, [key])) {
      unverified += 1;
      problems.push(`The anchor of seq ${seq} has no valid signature by the trusted anchor key ${key.keyId}`);
      continue;
    }
    checkedKeys.add(key.keyId);
    const stored = audit.hashes.get(anchor.seq);
    if (stored !== anchor.rowHash) problems.push(`The anchor of seq ${seq} names another row hash than the audit trail holds`);
    else if (!manifest.audit || anchor.chain === manifest.audit.chain) {
      report.newestAnchoredSeq = Math.max(report.newestAnchoredSeq ?? 0, anchor.seq);
    }
  }

  // 6. Coverage. A redacted row's content is proven only when a valid anchor covers its attestation entry (D.5.4).
  const coveredThrough = report.newestAnchoredSeq ?? 0;
  const unanchored = audit.accepted.filter((r) => r.proofSeq > coveredThrough).map((r) => r.seq);
  report.redactedRows = audit.accepted.length - unanchored.length;
  report.redactedUnanchored = unanchored.length;
  report.redactedUnanchoredSeqs = unanchored;
  let proven = coveredThrough;
  if (unanchored.length > 0 && unanchored[0]! <= proven) proven = unanchored[0]! - 1;
  report.lastAnchoredSeq = proven > 0 ? proven : null;
  report.rowsAfterLastAnchor = Math.max(0, audit.rows - proven);
  if (manifest.audit && report.anchors !== manifest.audit.anchors) problems.push(`audit/anchors.jsonl has ${report.anchors} anchors, the manifest names ${manifest.audit.anchors}`);
  report.anchorKeysTrusted = report.anchors === 0 ? null : unverified === 0;
  report.anchorKeyIds = [...checkedKeys];
  report.untrustedKeyIds = [...untrusted];
  report.ok = problems.length === 0;
  return report;
}
