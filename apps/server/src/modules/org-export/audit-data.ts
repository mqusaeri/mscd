// The audit folder of the organisation export (Milestone 3 D.4, build plan F.11):
// - `audit/audit_trail.jsonl` and `.csv`: the tenant chain with `seq`, `prev_hash`, `row_hash`, `redacted_at`, every
//   hashed column, and each row's canonical text as the database computes it (`platform.audit_canonical_text`), so
//   `export verify` and the customer's own tools recompute every hash (SHA-256 of the previous hash bytes followed by
//   the UTF-8 canonical text) without rebuilding PostgreSQL's JSON text;
// - `audit/anchors.jsonl`: the signed anchors of the chain, one per line as `GET /admin/audit-trail/anchors` writes them;
// - `audit/audit-anchor.pub` (PEM) and `audit/anchor-keys.json`: the public anchor keys that signed them. The builder
//   knows the installation's own key (the public half of `audit.anchor_key_file`, which signs the anchors; on-premise
//   each installation makes its own) and the keys compiled into the build. A key it does not know is listed with a
//   null PEM, and `audit-anchor.pub` is then empty: the export never names a key that did not sign.
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';
import { signedAnchorOf, type AnchorRow } from '../audit/anchors';
import type { AnchorKeys } from '../audit/chain-verifier';
import type { Spool } from './spool';
import { writeDataset } from './datasets';

export const AUDIT_TRAIL_COLUMNS = [
  'seq', 'id', 'occurred_at', 'organization_id', 'management_system_id', 'actor_user_id', 'actor_kind', 'action', 'entity_type', 'entity_id', 'entity_code',
  'before_data', 'after_data', 'edition', 'request_id', 'source_ip', 'user_agent', 'prev_hash', 'row_hash', 'redacted_at', 'redaction_id', 'canonical_text',
] as const;

/** Writes the tenant chain of the transaction's schema into its spools; returns the number of rows. */
export function dumpAuditTrail(trx: Trx, csv: Spool, jsonl: Spool): Promise<number> {
  const query = sql`select row_to_json(x)::text as j from (
      select seq, id, occurred_at, organization_id, management_system_id, actor_user_id, actor_kind, action, entity_type, entity_id, entity_code,
             before_data, after_data, edition, request_id, host(source_ip) as source_ip, user_agent,
             encode(prev_hash, 'hex') as prev_hash, encode(row_hash, 'hex') as row_hash, redacted_at, redaction_id,
             platform.audit_canonical_text(seq, id, occurred_at, organization_id, management_system_id, actor_user_id, actor_kind, action,
               entity_type, entity_id, entity_code, before_data, after_data, edition, request_id, source_ip, user_agent) as canonical_text
      from audit_trail order by seq) x`;
  return writeDataset(trx, query, AUDIT_TRAIL_COLUMNS, csv, jsonl);
}

export interface AnchorFiles {
  /** `audit/anchors.jsonl`. */
  anchors: Buffer;
  /**
   * `audit/audit-anchor.pub`: the PEM of the key of the newest anchor (without an anchor, the installation's key that
   * will sign them); empty when the builder does not know that key.
   */
  publicKey: Buffer;
  /**
   * `audit/anchor-keys.json`: every key id the anchors name with its PEM, or null when the builder does not know it;
   * without an anchor, the installation's key (or an empty list when it is unknown).
   */
  keys: Buffer;
  /** The key ids of `keys`. */
  keyIds: string[];
  /** Key ids of `keys` without a PEM. */
  unknownKeyIds: string[];
  count: number;
  /** Anchor rows whose payload does not match their columns (listed with `consistent: false`). */
  inconsistent: number;
}

/**
 * The anchor files of a tenant chain (`org_<slug>.audit_trail`). `knownKeys` are the public keys the builder can name
 * (the installation's own key first, then the compiled keys); `installationKeyId` is the key id of the installation's
 * signing key, when known.
 */
export async function anchorFiles(trx: Trx, chain: string, knownKeys: AnchorKeys, installationKeyId: string | null = null): Promise<AnchorFiles> {
  const rows = await trx
    .selectFrom('platform.audit_anchor')
    .select(['chain', 'seq', 'row_hash', 'payload', 'signature', 'key_id', 'anchored_at'])
    .where('chain', '=', chain)
    .orderBy('seq')
    .orderBy('anchored_at')
    .execute();
  let lines = '';
  let inconsistent = 0;
  const keyIds: string[] = [];
  for (const row of rows) {
    const signed = signedAnchorOf(row as AnchorRow);
    if (!keyIds.includes(row.key_id)) keyIds.push(row.key_id);
    if (signed) {
      lines += `${JSON.stringify(signed)}\n`;
    } else {
      inconsistent += 1;
      lines += `${JSON.stringify({ chain: row.chain, seq: Number(row.seq), rowHash: row.row_hash.toString('hex'), keyId: row.key_id, signature: row.signature, payload: row.payload, consistent: false })}\n`;
    }
  }
  const pemOf = (keyId: string) => knownKeys.find((k) => k.keyId === keyId)?.publicKeyPem ?? null;
  const listed = keyIds.length > 0 ? keyIds : installationKeyId ? [installationKeyId] : [];
  const known = listed.map((keyId) => ({ keyId, publicKeyPem: pemOf(keyId) }));
  const mainId = rows.at(-1)?.key_id ?? installationKeyId;
  const mainPem = mainId ? pemOf(mainId) : null;
  return {
    anchors: Buffer.from(lines, 'utf8'),
    publicKey: Buffer.from(mainPem ? `${mainPem.trim()}\n` : '', 'utf8'),
    keys: Buffer.from(`${JSON.stringify(known, null, 2)}\n`, 'utf8'),
    keyIds: listed,
    unknownKeyIds: known.filter((k) => k.publicKeyPem === null).map((k) => k.keyId),
    count: rows.length,
    inconsistent,
  };
}
