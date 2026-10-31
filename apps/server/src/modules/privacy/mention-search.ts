// The mention search of a personal data check (Milestone 3 D.6.4): the records of one management system whose text
// names the person, by name, email and handle, case-insensitive and at word bounds (as `platform.audit_redact_text`
// matches), at most `MENTION_LIMIT` results with record kind, code, field and a short excerpt. The searched columns and
// how each table's rows are tied to a system are listed in `mention-columns.ts`; one query per table, never one per
// record.
import type { PrivacyMention } from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import type { Trx } from '../../common/tokens';
import { competenceCode } from '../risk-registers/competence';
import { MENTION_TABLES, type MentionScope, type MentionTable } from './mention-columns';

/** Most mentions one search returns (`PrivacyMentions.items`). */
export const MENTION_LIMIT = 500;

/** Characters of the excerpt on each side of the match. */
const EXCERPT_SIDE = 60;

/** The values a search looks for: each of at least 3 characters, trimmed, without duplicates (case-insensitive). */
export function searchValues(values: readonly (string | null | undefined)[]): string[] {
  const out = new Map<string, string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 3 && !out.has(trimmed.toLowerCase())) out.set(trimmed.toLowerCase(), trimmed);
  }
  return [...out.values()];
}

/** A POSIX regular expression that finds `value` at word bounds (no letter, digit or underscore on either side). */
export function wordPattern(value: string): string {
  const escaped = value.replace(/[\\^$.|?*+()[\]{}]/g, (c) => `\\${c}`);
  return `(^|[^[:alnum:]_])${escaped}([^[:alnum:]_]|$)`;
}

/** The first place in `text` where one of the values stands at word bounds, case-insensitive; null when none does. */
export function firstMatch(text: string, values: readonly string[]): { index: number; length: number } | null {
  const folded = text.toLowerCase();
  let best: { index: number; length: number } | null = null;
  for (const value of values) {
    const key = value.toLowerCase();
    let from = 0;
    for (;;) {
      const hit = folded.indexOf(key, from);
      if (hit < 0) break;
      const before = hit === 0 || !/[\p{L}\p{N}_]/u.test(text[hit - 1]!);
      const afterIndex = hit + key.length;
      const after = afterIndex >= text.length || !/[\p{L}\p{N}_]/u.test(text[afterIndex]!);
      if (before && after) {
        if (!best || hit < best.index) best = { index: hit, length: key.length };
        break;
      }
      from = hit + 1;
    }
  }
  return best;
}

/** A short excerpt around a match (at most 300 characters), with "..." where the text is cut. */
export function excerptOf(text: string, match: { index: number; length: number }): string {
  const start = Math.max(0, match.index - EXCERPT_SIDE);
  const end = Math.min(text.length, match.index + match.length + EXCERPT_SIDE);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '... ' : ''}${body}${end < text.length ? ' ...' : ''}`.slice(0, 300);
}

/** The SQL condition that ties a row of `table` (alias `t`) to the system `msId`. */
function scopeSql(table: string, scope: MentionScope, msId: string): RawBuilder<boolean> {
  const linked = (entityType: string, idColumn: string) => sql<boolean>`exists (select 1 from entity_ms_link l
    where l.entity_type = ${entityType} and l.entity_id = ${sql.ref(idColumn)} and l.management_system_id = ${msId}::uuid and l.deleted_at is null)`;
  switch (scope.kind) {
    case 'ms':
      return sql<boolean>`t.management_system_id = ${msId}::uuid`;
    case 'link':
      if (table === 'document') return sql<boolean>`(${linked('document', 't.id')} or t.is_org_wide)`;
      return linked(table, 't.id');
    case 'evidence':
      return sql<boolean>`(${linked('evidence', 't.id')} or exists (select 1 from evidence_target et
        where et.evidence_id = t.id and et.management_system_id = ${msId}::uuid and et.deleted_at is null))`;
    case 'parent':
      if (scope.parentScope === 'ms') {
        return sql<boolean>`exists (select 1 from ${sql.table(scope.parent)} p
          where p.id = ${sql.ref(`t.${scope.column}`)} and p.management_system_id = ${msId}::uuid and p.deleted_at is null)`;
      }
      if (scope.parent === 'document') {
        return sql<boolean>`(${linked('document', `t.${scope.column}`)}
          or exists (select 1 from document d where d.id = ${sql.ref(`t.${scope.column}`)} and d.is_org_wide and d.deleted_at is null))`;
      }
      return linked(scope.parent, `t.${scope.column}`);
    case 'object':
      return sql<boolean>`(exists (select 1 from evidence e
          where e.storage_object_id = t.id and e.deleted_at is null
            and (exists (select 1 from entity_ms_link l where l.entity_type = 'evidence' and l.entity_id = e.id and l.management_system_id = ${msId}::uuid and l.deleted_at is null)
                 or exists (select 1 from evidence_target et where et.evidence_id = e.id and et.management_system_id = ${msId}::uuid and et.deleted_at is null)))
        or exists (select 1 from document_version v join document d on d.id = v.document_id and d.deleted_at is null
          where v.storage_object_id = t.id and v.deleted_at is null
            and (d.is_org_wide or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id
                                            and l.management_system_id = ${msId}::uuid and l.deleted_at is null))))`;
  }
}

interface MentionRow {
  kind: string;
  record_id: string;
  code: string | null;
  [column: string]: string | null;
}

/** The query of one table: its rows of the system whose searched columns match one of the patterns. */
function tableQuery(table: string, def: MentionTable, msId: string, patterns: readonly string[], limit: number): RawBuilder<MentionRow> {
  const kind = def.kindSql ? sql.raw(def.kindSql) : sql`${def.kind ?? table}::text`;
  const recordId = sql.raw(def.recordId ?? 't.id');
  const code = def.code ? sql.raw(`(${def.code})::text`) : sql`null::text`;
  const columns = def.columns.map((c, i) => sql`${sql.ref(`t.${c}`)}::text as ${sql.ref(`c${i}`)}`);
  const matches = def.columns.map((c) => sql`${sql.ref(`t.${c}`)}::text ~* any(${[...patterns]}::text[])`);
  const alive = def.softDelete === false ? sql`true` : sql`t.deleted_at is null`;
  return sql<MentionRow>`
    select ${kind} as kind, ${recordId}::text as record_id, ${code} as code, ${sql.join(columns)}
      from ${sql.table(table)} t ${sql.raw(def.joins ?? '')}
     where ${alive} and ${scopeSql(table, def.scope, msId)} and (${sql.join(matches, sql` or `)})
     order by 3 nulls last, 2
     limit ${limit}`;
}

/** The records of the system `msId` whose text names one of the values; `truncated` when there were more than the limit. */
export async function searchMentions(trx: Trx, msId: string, values: readonly (string | null | undefined)[], limit = MENTION_LIMIT): Promise<{ items: PrivacyMention[]; truncated: boolean }> {
  const wanted = searchValues(values);
  if (wanted.length === 0) return { items: [], truncated: false };
  const patterns = wanted.map(wordPattern);
  const items: PrivacyMention[] = [];
  let truncated = false;
  for (const [table, def] of Object.entries(MENTION_TABLES)) {
    if (items.length > limit) break;
    const { rows } = await tableQuery(table, def, msId, patterns, limit + 1).execute(trx);
    for (const row of rows) {
      def.columns.forEach((column, i) => {
        const text = row[`c${i}`];
        if (!text) return;
        const match = firstMatch(text, wanted);
        if (!match) return;
        items.push({
          recordKind: row.kind,
          recordId: row.record_id,
          code: row.code ?? (row.kind === 'competence_record' ? competenceCode(row.record_id) : null),
          field: column,
          excerpt: excerptOf(text, match),
        });
      });
    }
  }
  if (items.length > limit) {
    truncated = true;
    items.length = limit;
  }
  return { items, truncated };
}
