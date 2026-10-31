// Audit chain verification (build plan F.11): the verification query over `platform.audit_log` and a tenant
// `audit_trail`, and the comparison of each chain with its newest signed anchor (detects the removal of the newest
// rows and a rewrite by the database owner, who cannot forge an anchor signature). Used by
// `GET /admin/audit-trail/verify` and the `audit.verify-chain` job (WP-22).
import { Inject, Injectable } from '@nestjs/common';
import type { AuditChainVerifyResult } from '@mscd/shared';
import { sql } from 'kysely';
import { SYSTEM_USER_ID, type Trx } from '../../common/tokens';
import type { TrustedKey } from '../../generated/build-info';
import { TenantScope } from '../tenancy/tenant-scope';
import { verifyAnchorRow, type AnchorRow } from './anchors';

/** Injection token of the anchor public keys the verifier trusts (default: the compiled `anchor` keys, D-16). */
export const AUDIT_ANCHOR_KEYS = Symbol.for('mscd.auditAnchorKeys');
export type AnchorKeys = readonly Pick<TrustedKey, 'keyId' | 'publicKeyPem'>[];

export const PLATFORM_CHAIN = 'platform.audit_log';

/**
 * How long `GET /admin/audit-trail/verify` reuses a verification of the platform chain. The query reads every row of
 * the installation (all organisations), so callers of every organisation share one run per period.
 */
export const PLATFORM_VERIFY_REUSE_MS = 5 * 60_000;
/** How long the route reuses a verification of one organisation's chain. */
export const TENANT_VERIFY_REUSE_MS = 60_000;
/** Entries of the reuse cache before old ones are dropped. */
const REUSE_CACHE_MAX = 1000;

/** Chain name of a tenant schema's trail (`org_ndt.audit_trail`). */
export function tenantChainName(schema: string): string {
  return `${schema}.audit_trail`;
}

export interface ChainCheck {
  chain: string;
  checked: number;
  firstBrokenSeq: number | null;
  /** Newest row of the chain. */
  head: { seq: number; rowHash: string } | null;
}

/**
 * A verification with what the route does not show (Milestone 3 D.5.4): `redactedUnanchored` counts the attested
 * redactions whose attestation entry no valid anchor covers yet (the newest valid anchor has a lower `seq`, or the
 * chain has no anchor); `redactionHeadSeq` is the newest attestation entry that accepts a redacted row (null when the
 * chain holds none). The next anchor run covers them: the anchor job signs the head of every chain that verifies.
 */
export interface ChainVerification extends AuditChainVerifyResult {
  redactedUnanchored: number;
  redactionHeadSeq: number | null;
}

/** The members of a verification that `GET /admin/audit-trail/verify` returns. */
export function publicVerifyResult(v: ChainVerification): AuditChainVerifyResult {
  return { chain: v.chain, checked: v.checked, firstBrokenSeq: v.firstBrokenSeq, anchorOk: v.anchorOk, redacted: v.redacted };
}

/** What the verification query finds in one chain. */
interface QueryCheck extends Omit<ChainCheck, 'chain'> {
  redacted: number;
  /** The attestation entries that accept redacted rows, with the number of rows each accepts. */
  attestations: { seq: number; rows: number }[];
}

/** The attestation actions of attested redaction (Milestone 3 D.5.4, written by `platform.redact_audit_rows`). */
export const REDACTION_ATTESTATION_ACTIONS = ['tenant.audit_redacted', 'user.audit_redacted', 'privacy.audit_redacted'] as const;

/**
 * The F.11 verification query over one chain table, in the transaction's scope, with the rule of attested redaction
 * (Milestone 3 D.5.4). Every row must link to the previous one (`prev_hash` equals the previous `row_hash`, `seq` has no
 * gap). A row that was never redacted must hash to its stored `row_hash`. A redacted row (`redaction_id` set) cannot be
 * recomputed from its changed columns, so it must instead be listed by an attestation entry later in the same chain
 * whose `redactionId` is the row's `redaction_id`, with the row's stored hash (`rowHash`) and the hash of the row as it
 * is now (`redactedHash`). The attestation entry is an ordinary chained row, so a changed list breaks the chain at
 * that entry. A row changed after its redaction, or marked redacted without an attestation, breaks the chain at that
 * row. `redacted` counts the rows accepted through an attestation, and `attestations` names the attestation entries
 * that accept them, so `withAnchor` can tell whether an anchor covers each one.
 */
async function runVerification(trx: Trx, table: 'tenant' | 'platform'): Promise<QueryCheck> {
  const from = table === 'tenant' ? sql`audit_trail` : sql`platform.audit_log`;
  const actions = sql.join(REDACTION_ATTESTATION_ACTIONS.map((a) => sql.lit(a)));
  const { rows } = await sql<{
    checked: string;
    first_broken_seq: string | null;
    head_seq: string | null;
    head_hash: Buffer | null;
    redacted: string;
    attestations: [string | number, string | number][];
  }>`
    WITH att AS (
      SELECT a.seq AS attestation_seq, a.after_data ->> 'redactionId' AS redaction_id, (e ->> 'seq')::bigint AS seq,
             e ->> 'rowHash' AS row_hash, e ->> 'redactedHash' AS redacted_hash
      FROM ${from} a, jsonb_array_elements(CASE WHEN jsonb_typeof(a.after_data -> 'rows') = 'array' THEN a.after_data -> 'rows' ELSE '[]'::jsonb END) e
      WHERE a.action IN (${actions})),
    c AS (
      SELECT seq, prev_hash, row_hash, redaction_id,
             lag(row_hash) OVER (ORDER BY seq) AS expected_prev,
             lag(seq) OVER (ORDER BY seq) AS prev_seq,
             sha256(prev_hash || convert_to(platform.audit_canonical_text(seq, id, occurred_at, organization_id,
               management_system_id, actor_user_id, actor_kind, action, entity_type, entity_id, entity_code,
               before_data, after_data, edition, request_id, source_ip, user_agent), 'UTF8')) AS expected_hash
      FROM ${from}),
    a AS (
      SELECT c.*,
             CASE WHEN c.redaction_id IS NULL THEN NULL
                  ELSE (SELECT min(att.attestation_seq) FROM att
                         WHERE att.seq = c.seq AND att.attestation_seq > c.seq AND att.redaction_id = c.redaction_id::text
                           AND att.row_hash = encode(c.row_hash, 'hex') AND att.redacted_hash = encode(c.expected_hash, 'hex'))
             END AS accepted_by
      FROM c),
    v AS (
      SELECT a.*, CASE WHEN a.redaction_id IS NULL THEN a.row_hash = a.expected_hash ELSE a.accepted_by IS NOT NULL END AS content_ok
      FROM a)
    SELECT count(*) AS checked,
           min(seq) FILTER (WHERE NOT content_ok
                               OR prev_hash <> coalesce(expected_prev, '\\x'::bytea)
                               OR seq <> coalesce(prev_seq, 0) + 1) AS first_broken_seq,
           max(seq) AS head_seq,
           (SELECT row_hash FROM c ORDER BY seq DESC LIMIT 1) AS head_hash,
           count(*) FILTER (WHERE redaction_id IS NOT NULL AND content_ok) AS redacted,
           (SELECT coalesce(jsonb_agg(jsonb_build_array(g.accepted_by, g.n) ORDER BY g.accepted_by), '[]'::jsonb)
              FROM (SELECT accepted_by, count(*) AS n FROM v WHERE accepted_by IS NOT NULL GROUP BY accepted_by) g) AS attestations
    FROM v`.execute(trx);
  const row = rows[0]!;
  return {
    checked: Number(row.checked),
    firstBrokenSeq: row.first_broken_seq === null ? null : Number(row.first_broken_seq),
    head: row.head_seq === null || !row.head_hash ? null : { seq: Number(row.head_seq), rowHash: row.head_hash.toString('hex') },
    redacted: Number(row.redacted),
    attestations: (row.attestations ?? []).map(([seq, n]) => ({ seq: Number(seq), rows: Number(n) })),
  };
}

@Injectable()
export class AuditChainVerifier {
  /** Recent and running verifications of the route, by chain name. */
  private readonly recent = new Map<string, { startedAt: number; result: Promise<ChainVerification> }>();

  constructor(
    private readonly scope: TenantScope,
    @Inject(AUDIT_ANCHOR_KEYS) private readonly anchorKeys: AnchorKeys,
  ) {}

  /** Verifies the platform chain (with platform scope: every row of `platform.audit_log`). */
  async verifyPlatform(): Promise<ChainVerification> {
    return this.scope.withPlatform(async (trx) => {
      const check = await runVerification(trx, 'platform');
      return this.withAnchor(trx, PLATFORM_CHAIN, check, (seq) =>
        trx.selectFrom('platform.audit_log').select('row_hash').where('seq', '=', String(seq)).executeTakeFirst(),
      );
    }, { scope: 'job' });
  }

  /** Verifies the tenant chain of an organisation. */
  async verifyTenant(org: { orgId: string; schema: string }): Promise<ChainVerification> {
    return this.scope.withTenant({ orgId: org.orgId, schema: org.schema, userId: SYSTEM_USER_ID }, async (trx) => {
      const check = await runVerification(trx, 'tenant');
      return this.withAnchor(trx, tenantChainName(org.schema), check, (seq) =>
        trx.selectFrom('audit_trail').select('row_hash').where('seq', '=', String(seq)).executeTakeFirst(),
      );
    });
  }

  /**
   * Both chains an organisation's administrators can verify: the tenant chain and the platform chain (whose
   * `checked` counts the rows of the whole installation, as F.11 verifies the chain as one). Serves the route: a
   * verification started less than `TENANT_VERIFY_REUSE_MS` (tenant) or `PLATFORM_VERIFY_REUSE_MS` (platform) ago,
   * or still running, is reused, so repeated calls cost one scan per period. `verifyTenant` and `verifyPlatform`
   * (the `audit.verify-chain` job) always verify afresh.
   */
  async verifyForOrganisation(org: { orgId: string; schema: string }): Promise<AuditChainVerifyResult[]> {
    const results = await Promise.all([
      this.reuse(tenantChainName(org.schema), TENANT_VERIFY_REUSE_MS, () => this.verifyTenant(org)),
      this.reuse(PLATFORM_CHAIN, PLATFORM_VERIFY_REUSE_MS, () => this.verifyPlatform()),
    ]);
    return results.map(publicVerifyResult);
  }

  /** A verification of `chain` started less than `maxAgeMs` ago (running or done), else a new one. Failures are not kept. */
  private reuse(chain: string, maxAgeMs: number, run: () => Promise<ChainVerification>): Promise<ChainVerification> {
    const now = Date.now();
    const recent = this.recent.get(chain);
    if (recent && now - recent.startedAt < maxAgeMs) return recent.result;
    if (this.recent.size >= REUSE_CACHE_MAX) {
      for (const [key, entry] of this.recent) if (now - entry.startedAt >= PLATFORM_VERIFY_REUSE_MS) this.recent.delete(key);
      if (this.recent.size >= REUSE_CACHE_MAX) this.recent.clear();
    }
    const result = run();
    this.recent.set(chain, { startedAt: now, result });
    result.catch(() => {
      if (this.recent.get(chain)?.result === result) this.recent.delete(chain);
    });
    return result;
  }

  /**
   * `anchorOk`: true when the chain has no anchor yet, or when its newest anchor has a valid signature by a trusted
   * key and the stored row of that `seq` still has the anchored hash (F.11). D.5.4 also wants each attestation entry
   * that accepts a redacted row covered by an anchor: the rows whose attestation lies above the newest valid anchor
   * are counted apart (`redactedUnanchored`) and do not break the chain, because the anchor job signs only a chain that
   * verifies, and that run is what covers them. The purge (D.5.3) anchors at once and checks the coverage.
   */
  private async withAnchor(
    trx: Trx,
    chain: string,
    check: QueryCheck,
    rowAt: (seq: number) => Promise<{ row_hash: Buffer } | undefined>,
  ): Promise<ChainVerification> {
    const anchor = await trx
      .selectFrom('platform.audit_anchor')
      .select(['chain', 'seq', 'row_hash', 'payload', 'signature', 'key_id'])
      .where('chain', '=', chain)
      .orderBy('anchored_at', 'desc')
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    let anchorOk = true;
    let coveredThrough = 0;
    if (anchor) {
      const row = await rowAt(Number(anchor.seq));
      anchorOk =
        verifyAnchorRow(anchor as AnchorRow, this.anchorKeys) && row !== undefined && Buffer.compare(row.row_hash, anchor.row_hash) === 0;
      if (anchorOk) coveredThrough = Number(anchor.seq);
    }
    const redactedUnanchored = check.attestations.reduce((n, a) => n + (a.seq > coveredThrough ? a.rows : 0), 0);
    const redactionHeadSeq = check.attestations.length > 0 ? Math.max(...check.attestations.map((a) => a.seq)) : null;
    return { chain, checked: check.checked, firstBrokenSeq: check.firstBrokenSeq, anchorOk, redacted: check.redacted, redactedUnanchored, redactionHeadSeq };
  }
}
