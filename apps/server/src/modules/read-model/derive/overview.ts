// Implementation overview of a system (build plan A.4 5.14, UI 2.6): open items per clause, the four maturity
// values over the stored clause readiness and the live open counts, the maturity level, blockers and the next gate.
// The TS 9.2 overview endpoint (WP-32) serves these; `/ui/*` lets the controller compute them from the bundle.
// Milestone 2 (D.6, M2-05): a clause row computed by `readiness.recompute` stores its four dimensions (documented,
// implemented, evidenced, measured), and the overview shows them as stored (null where the group has no rows of that
// kind); a row without stored dimensions (seeded or manual, as in the demo) keeps the Milestone 1 offset formula of
// `maturityValues`; a row whose readiness is null (not computed yet) has no maturity values.
import type { ChainItem, ClauseMaturity, GateItem, Pair, Phase } from '@mscd/shared';

/** Clause groups of the overview (4 to 10). */
export const OVERVIEW_CLAUSES = [4, 5, 6, 7, 8, 9, 10] as const;

/**
 * Open chain items per clause group (UI 2.6): each stage counts toward its pack overview clause
 * (`traceability_chain_def.overview_clause`); clause 10 gets the open findings when there are any.
 */
export function openPerClause(items: readonly Pick<ChainItem, 'stage'>[], overviewClauseOf: (stage: string) => number, openFindings: number): Record<number, number> {
  const out: Record<number, number> = Object.fromEntries(OVERVIEW_CLAUSES.map((c) => [c, 0]));
  for (const item of items) {
    const clause = overviewClauseOf(item.stage);
    out[clause] = (out[clause] ?? 0) + 1;
  }
  if (openFindings > 0) out[10] = (out[10] ?? 0) + openFindings;
  return out;
}

/** Maturity values of a clause (UI 2.6): Documented, Implemented, Evidenced, Measured, from readiness `p` and open count `o`. */
export function maturityValues(p: number, o: number): [number, number, number, number] {
  return [Math.min(100, p + 14), p, Math.max(0, p - 10 - (o ? 8 : 0)), Math.max(0, p - 22)];
}

/** Maturity level 0 to 4 of a value (UI 2.6 `q(x)`). */
export function maturityLevel(x: number): number {
  return Math.max(0, Math.min(4, Math.round(x / 25)));
}

/** A clause readiness row as stored (`clause_readiness`, Milestone 2 D.3, D.6); the loader passes nulls through. */
export interface StoredReadiness {
  readiness: number | null;
  documented: number | null;
  implemented: number | null;
  evidenced: number | null;
  measured: number | null;
  /** When `readiness.recompute` wrote the row; null for seeded and manual rows. */
  computedAt?: Date | string | null;
}

/** A stored readiness value of one clause group: a bare percentage (Milestone 1 loader) or the full row (D.6). */
export type ReadinessValue = number | null | StoredReadiness;

/** The stored row of a readiness value (a bare percentage has no dimensions). */
export function storedReadiness(value: ReadinessValue | undefined): StoredReadiness {
  if (value === undefined || value === null) return { readiness: null, documented: null, implemented: null, evidenced: null, measured: null, computedAt: null };
  if (typeof value === 'number') return { readiness: value, documented: null, implemented: null, evidenced: null, measured: null, computedAt: null };
  return value;
}

/** True when a row holds dimensions of `readiness.recompute` (D.6): it was computed, or names a dimension. */
export function hasStoredDimensions(row: StoredReadiness): boolean {
  return (row.computedAt !== undefined && row.computedAt !== null)
    || [row.documented, row.implemented, row.evidenced, row.measured].some((d) => d !== null && d !== undefined);
}

/**
 * The four maturity values of a clause (D.6): the stored dimensions of a computed row, else the Milestone 1 offset
 * formula of `maturityValues` over the stored readiness and the open count; all null while the readiness is null.
 */
export function clauseDimensions(value: ReadinessValue | undefined, open: number): [number | null, number | null, number | null, number | null] {
  const row = storedReadiness(value);
  if (hasStoredDimensions(row)) return [row.documented, row.implemented, row.evidenced, row.measured];
  if (row.readiness === null) return [null, null, null, null];
  return maturityValues(clampPct(row.readiness), open);
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * One `ClauseMaturity` of the implementation summary (A.4 5.14, D.6): the stored readiness (null until computed),
 * the maturity level of each dimension (null where the dimension is null) and, for a computed row, `computedAt`.
 */
export function clauseMaturity(clause: number, value: ReadinessValue | undefined, open: number): ClauseMaturity {
  const row = storedReadiness(value);
  const dims = clauseDimensions(value, open);
  const levels = dims.map((d) => (d === null ? null : maturityLevel(d))) as ClauseMaturity['dimensions'];
  const computedAt = row.computedAt === undefined || row.computedAt === null ? null : new Date(row.computedAt).toISOString();
  return {
    clause,
    readiness: row.readiness === null ? null : clampPct(row.readiness),
    dimensions: levels,
    ...(hasStoredDimensions(row) ? { computedAt } : {}),
  } as ClauseMaturity;
}

export const MATURITY_LABELS: readonly Pair[] = [
  ['Initial', 'Awal'],
  ['Basic', 'Dasar'],
  ['Defined', 'Terdefinisi'],
  ['Managed', 'Terkelola'],
  ['Optimised', 'Teroptimasi'],
];

/** Level of a clause: `q` of the mean of its four maturity values. */
export function clauseLevel(p: number, o: number): number {
  const values = maturityValues(p, o);
  return maturityLevel(values.reduce((a, b) => a + b, 0) / values.length);
}

export interface Blocker {
  id: string;
  /** Title of the record, else the gate item's reason. */
  title: Pair;
  h: string;
  due: string | null;
  gate: boolean;
}

/**
 * UI 2.6 blockers: the gate items (titled by `titleOf` or their reason), then the overdue chain items that are not
 * gate items, sorted by due date; the first five.
 */
export function overviewBlockers(gates: readonly GateItem[], items: readonly ChainItem[], titleOf: (id: string) => string | null): Blocker[] {
  const gateIds = new Set(gates.map((g) => g.id));
  const fromGates: Blocker[] = gates.map((g) => {
    const title = titleOf(g.id);
    return { id: g.id, title: title ? [title, title] : g.why, h: g.h, due: g.due, gate: true };
  });
  const overdue = items
    .filter((i) => i.st === 'overdue' && !i.gate && !gateIds.has(i.id))
    .sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9'))
    .map((i): Blocker => ({ id: i.id, title: i.title, h: i.h, due: i.due, gate: false }));
  return [...fromGates, ...overdue].slice(0, 5);
}

/** UI 2.6 next gate: the first gate phase not fully verified with the open gate item count, else null (all passed). */
export function nextGate(phases: readonly Pick<Phase, 'no' | 'n' | 'gate' | 'total' | 'c'>[], gateItems: number): { no: number; name: string; items: number } | null {
  const phase = phases.find((p) => p.gate && p.c.verified < p.total);
  return phase ? { no: phase.no, name: phase.n, items: gateItems } : null;
}
