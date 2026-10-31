// Attested redaction of audit rows (Milestone 3 D.5.4), built by M3-03 for the purge of an organisation (step 6 of
// D.5.2) and for the erasure of one person (M3-04, D.6.5), which reuses it. The redaction itself runs in the database
// function `platform.redact_audit_rows` of platform/0008 (SECURITY DEFINER, owned by mscd_migrator), because mscd_app
// has no UPDATE right on any audit table and keeps that limit: the function removes the network address and the browser
// of each row, replaces the listed personal values inside `entity_code`, `before_data` and `after_data` with pseudonyms,
// marks the row (`redacted_at`, `redaction_id`) and appends one attestation entry to the same chain that lists every
// redacted row with its stored hash and the hash of its redacted content. The stored hashes never change, so the chain
// still links from row to row and the signed anchors still verify; the verifier (chain-verifier.ts) accepts a redacted
// row only through its attestation.
//
// This service runs the function in the caller's transaction, so the redaction commits with the rest of the work.
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';
import { PLATFORM_CHAIN, tenantChainName } from './chain-verifier';

/**
 * The two forms a pseudonym may take (D.5.2, D.6.5); `platform.redact_audit_rows` refuses any other replacement, so a
 * redaction can only replace personal values and never rewrite other text of a row: `erased-<8 hex>` (the handle of an
 * anonymised account, or the pseudonym of an account that is kept) and `Former user <4 to 8 hex>` (a person erased in
 * one organisation).
 */
export const REDACTION_PSEUDONYM = /^(erased-[0-9a-f]{8}|Former user [0-9A-Fa-f]{4,8})$/;

/** The attestation actions: the platform chain takes `tenant.*` or `user.*`, a tenant chain `privacy.*` (J.5). */
export type RedactionAttestationAction = 'tenant.audit_redacted' | 'user.audit_redacted' | 'privacy.audit_redacted';

/** What the attestation entry records besides the list of redacted rows. */
export interface RedactionAttestation {
  action: RedactionAttestationAction;
  /** Why (stored in the attestation's after_data, at most 500 characters). */
  reason: string;
  /** Platform chain: the organisation of the attestation entry (and of every redacted row). A tenant chain takes its own. */
  organizationId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  entityCode?: string | null;
  /** Default: the system. */
  actor?: { userId: string | null; kind: 'user' | 'system' | 'operator' };
}

export interface RedactionRequest {
  /** `platform` for `platform.audit_log`, or the tenant schema (`org_<slug>`) of the organisation's `audit_trail`. */
  chain: 'platform' | { schema: string };
  /** The rows to redact; rows with nothing to remove stay as they are. */
  seqs: readonly (string | number | bigint)[];
  /**
   * Personal value to pseudonym (emails, handles, names). Values shorter than 3 characters are ignored; every pseudonym
   * must match `REDACTION_PSEUDONYM`.
   */
  replacements: Readonly<Record<string, string>>;
  attestation: RedactionAttestation;
  /** Default: a new id. */
  redactionId?: string;
}

export interface RedactionResult {
  chain: string;
  redactionId: string;
  /** Rows changed. */
  redacted: number;
  /** Rows listed that held nothing to remove. */
  unchanged: number;
  /** `seq` of the attestation entry. */
  attestationSeq: number;
}

/** The chain name of a request, as the anchors and the database function name it. */
export function redactionChainName(chain: RedactionRequest['chain']): string {
  return chain === 'platform' ? PLATFORM_CHAIN : tenantChainName(chain.schema);
}

@Injectable()
export class AuditRedactor {
  /**
   * Redacts the rows of one chain in `trx` (any scope: the function sets the scope it needs and restores it). Throws the
   * database error when a row no longer matches its stored hash (or its earlier attestation), when the redaction id is
   * used already, when the chain or the attestation action is not valid, or when a replacement is no pseudonym; nothing
   * is changed then.
   */
  async redact(trx: Trx, request: RedactionRequest): Promise<RedactionResult> {
    const redactionId = request.redactionId ?? randomUUID();
    const attestation = request.attestation;
    const payload = {
      values: Object.fromEntries(Object.entries(request.replacements).filter(([value, pseudonym]) => value.trim().length >= 3 && pseudonym !== '')),
      attestation: {
        action: attestation.action,
        reason: attestation.reason.slice(0, 500),
        organizationId: attestation.organizationId ?? null,
        entityType: attestation.entityType ?? null,
        entityId: attestation.entityId ?? null,
        entityCode: attestation.entityCode ?? null,
        actorUserId: attestation.actor?.userId ?? null,
        actorKind: attestation.actor?.kind ?? 'system',
      },
    };
    const seqs = request.seqs.map((seq) => String(seq));
    const { rows } = await sql<{ result: { chain: string; redactionId: string; redacted: number; unchanged: number; attestationSeq: string | number } }>`
      select platform.redact_audit_rows(${redactionChainName(request.chain)}, ${seqs}::bigint[], ${redactionId}::uuid, ${JSON.stringify(payload)}::jsonb) as result`.execute(trx);
    const result = rows[0]!.result;
    return {
      chain: result.chain,
      redactionId: result.redactionId,
      redacted: Number(result.redacted),
      unchanged: Number(result.unchanged),
      attestationSeq: Number(result.attestationSeq),
    };
  }

  /**
   * The `seq` of every entry of the platform chain about one organisation (`organization_id`), oldest first. Reads with
   * platform scope switched on for the statement and back to what it was.
   */
  async platformSeqsOf(trx: Trx, orgId: string): Promise<string[]> {
    const { rows: scope } = await sql<{ prev: string }>`select coalesce(current_setting('app.platform_scope', true), '') as prev`.execute(trx);
    const previous = scope[0]?.prev ?? '';
    if (previous !== 'on') await sql`select set_config('app.platform_scope', 'on', true)`.execute(trx);
    const { rows } = await sql<{ seq: string }>`select seq from platform.audit_log where organization_id = ${orgId} order by seq`.execute(trx);
    if (previous !== 'on') await sql`select set_config('app.platform_scope', ${previous}, true)`.execute(trx);
    return rows.map((row) => String(row.seq));
  }
}
