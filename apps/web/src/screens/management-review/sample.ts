// Sample adapter of the Management review screen (MILESTONE-2 M2-14, C.6): the management reviews of the selected
// sample organisation with the mandatory inputs of each system's standard, built once per organisation, with the rules
// the api applies: a unique code, the path system always linked, no change of a closed review, held before closed,
// BR-13 (every mandatory input of every linked system has content) and BR-14 (decisions recorded). Changes stay for
// the browser session, per organisation. Loaded only by the sample build (adapter.ts), so the api build holds none of it.
import type { ControllerData, MsId } from '../../data/types';
import type { Outcome, Result } from '../findings/shared';
import { filled, refusal } from '../findings/shared';
import type { TextPair } from '../types';
import type { ReviewAdapter, ReviewInput, ReviewModel } from './model';

export interface SampleScope {
  getD(): ControllerData | null;
  org(): string | null;
}

/** The mandatory review inputs of each sample system's standard (the review_inputs of its framework pack). */
export const INPUT_DEFS: Readonly<Record<string, readonly [string, string][]>> = {
  isms: [
    ['MR-01', 'Status of actions from previous management reviews'], ['MR-02', 'Changes in external and internal issues'],
    ['MR-03', 'Changes in needs and expectations of interested parties'], ['MR-04', 'Trends in nonconformities and corrective actions'],
    ['MR-05', 'Trends in monitoring and measurement results'], ['MR-06', 'Trends in audit results'], ['MR-07', 'Fulfilment of information security objectives'],
    ['MR-08', 'Feedback from interested parties'], ['MR-09', 'Results of risk assessment and status of the risk treatment plan'], ['MR-10', 'Opportunities for continual improvement'],
  ],
  qms: [
    ['MR-01', 'Status of actions from previous management reviews'], ['MR-02', 'Changes in external and internal issues'],
    ['MR-03', 'Customer satisfaction and feedback from interested parties'], ['MR-04', 'Extent to which quality objectives have been met'],
    ['MR-05', 'Process performance and conformity of products and services'], ['MR-06', 'Nonconformities and corrective actions'],
    ['MR-07', 'Monitoring and measurement results'], ['MR-08', 'Audit results'], ['MR-09', 'Performance of external providers'], ['MR-10', 'Adequacy of resources'],
    ['MR-11', 'Effectiveness of actions taken on risks and opportunities'], ['MR-12', 'Opportunities for improvement'],
  ],
  bcms: [
    ['MR-01', 'Status of actions from previous management reviews'], ['MR-02', 'Changes in external and internal issues'],
    ['MR-03', 'Trends in nonconformities and corrective actions'], ['MR-04', 'Trends in monitoring and measurement evaluation results'], ['MR-05', 'Trends in audit results'],
    ['MR-06', 'Feedback from interested parties'], ['MR-07', 'Need for changes to the BCMS, including the policy and objectives'],
    ['MR-08', 'Procedures and resources that could improve BCMS performance'], ['MR-09', 'Information from the business impact analysis and risk assessment'],
    ['MR-10', 'Output from the evaluation of business continuity documentation and capabilities'], ['MR-11', 'Risks or issues not adequately addressed in a previous risk assessment'],
    ['MR-12', 'Lessons learned and actions from near-misses and disruptions'], ['MR-13', 'Opportunities for continual improvement'],
  ],
  abms: [
    ['MR-01', 'Status of actions from previous management reviews'], ['MR-02', 'Changes in external and internal issues'],
    ['MR-03', 'Changes in needs and expectations of interested parties'], ['MR-04', 'Trends in nonconformities and corrective actions'],
    ['MR-05', 'Trends in monitoring and measurement results'], ['MR-06', 'Trends in audit results'], ['MR-07', 'Reports of bribery'], ['MR-08', 'Investigations'],
    ['MR-09', 'Nature and extent of the bribery risks faced'], ['MR-10', 'Effectiveness of actions taken on bribery risks'], ['MR-11', 'Opportunities for continual improvement'],
    ['GB-01', 'Results of the top management review and reports of the compliance function'],
  ],
};

interface SampleReview extends ReviewModel {
  contents: Record<string, string>;
}

const STATES = new Map<string, SampleReview[]>();
let sequence = 0;

/** Forgets every organisation's changes (tests). */
export function resetSampleReviews(): void {
  STATES.clear();
  sequence = 0;
}

const SEEDS: readonly { code: string; title: string; ms: MsId; plannedAt: string; heldAt: string | null; status: ReviewModel['status']; missing: string[] | 'all'; decisions: string | null }[] = [
  {
    code: 'MR-2025', title: 'Management review 2025', ms: 'isms', plannedAt: '2025-10-20', heldAt: '2025-10-21', status: 'closed', missing: [],
    decisions: 'Budget approved for privileged access management; supplier review moved to every quarter; risk appetite unchanged.',
  },
  { code: 'MR-2026', title: 'Management review 2026', ms: 'isms', plannedAt: '2026-10-28', heldAt: null, status: 'planned', missing: ['MR-04', 'MR-09'], decisions: null },
  { code: 'MR-2026-Q', title: 'Management review including the 2026 transition', ms: 'qms', plannedAt: '2026-11-20', heldAt: null, status: 'planned', missing: 'all', decisions: null },
  { code: 'MR-2027-B', title: 'First BCMS management review', ms: 'bcms', plannedAt: '2027-01-30', heldAt: null, status: 'planned', missing: 'all', decisions: null },
];

function seed(D: ControllerData | null): SampleReview[] {
  const systems = new Set((D?.MS ?? []).map((m) => m.id));
  return SEEDS.filter((s) => systems.has(s.ms)).map((s) => {
    const contents: Record<string, string> = {};
    for (const [code, title] of INPUT_DEFS[s.ms] ?? []) {
      if (s.missing === 'all' || s.missing.includes(code)) continue;
      contents[`${s.ms}:${code}`] = `${title}: summary prepared by the MS Manager for ${s.code}.`;
    }
    return {
      id: `review-${s.code}`, code: s.code, title: s.title, owner: 'hendra', plannedAt: s.plannedAt, heldAt: s.heldAt, status: s.status,
      decisionsRecorded: s.status === 'closed', decisionsText: s.decisions, linkedMs: [s.ms], inputs: [], etag: null, contents,
    };
  });
}

function stateOf(D: ControllerData | null, org: string | null): SampleReview[] {
  const key = org || (D?.MS ?? []).map((m) => m.id).sort().join(',');
  let state = STATES.get(key);
  if (!state) {
    state = seed(D);
    STATES.set(key, state);
  }
  return state;
}

function inputsOf(review: SampleReview): ReviewInput[] {
  return review.linkedMs.flatMap((ms) => (INPUT_DEFS[ms] ?? []).map(([defCode, title]) => {
    const content = review.contents[`${ms}:${defCode}`] ?? null;
    return { defCode, title, mandatory: true, ms, complete: filled(content), content };
  }));
}

function present(review: SampleReview): ReviewModel {
  const { contents: _c, ...rest } = review;
  return { ...rest, linkedMs: [...rest.linkedMs], inputs: inputsOf(review) };
}

const notFound = () => refusal(404, ['Record not found', 'Rekaman tidak ditemukan'], { slug: 'not-found' });
const closedReview = (code: string) => refusal(409, [`${code} is closed and no longer changes`, `${code} telah ditutup dan tidak lagi berubah`], { slug: 'conflict' });
const done = (changed: MsId[], extra: Partial<Outcome> = {}): Result<Outcome> => ({ ok: true, data: { changed, warnings: [], ...extra } });

export const RULE_TEXT: Readonly<Record<'BR-13' | 'BR-14', TextPair>> = {
  'BR-13': ['The management review cannot be closed while mandatory inputs are empty for a linked system.', 'Tinjauan manajemen tidak dapat ditutup selama masukan wajib untuk sistem terkait masih kosong.'],
  'BR-14': ['The management review cannot be closed without recorded decisions.', 'Tinjauan manajemen tidak dapat ditutup tanpa keputusan yang dicatat.'],
};

export function createSampleAdapter(scope: SampleScope): ReviewAdapter {
  const state = () => stateOf(scope.getD(), scope.org());
  const today = () => scope.getD()?.TODAY_S ?? new Date().toISOString().slice(0, 10);
  const find = (ms: MsId, id: string) => state().find((r) => r.id === id && r.linkedMs.includes(ms));
  return {
    sample: true,
    async list(ms) {
      const rows = state().filter((r) => r.linkedMs.includes(ms)).sort((a, b) => (b.plannedAt ?? '').localeCompare(a.plannedAt ?? '') || a.code.localeCompare(b.code));
      return { ok: true, data: rows.map(present) };
    },
    async create(ms, body) {
      const s = state();
      if (s.some((r) => r.code === body.code)) return refusal(409, [`${body.code} already exists`, `${body.code} sudah ada`], { slug: 'conflict' });
      if (!body.linkedMs.includes(ms)) return refusal(422, [`The review must be linked to ${ms}, the system it is created in`, `Tinjauan harus ditautkan ke ${ms}, sistem tempat tinjauan dibuat`]);
      sequence += 1;
      const row: SampleReview = {
        id: `sample-review-${sequence}`, code: body.code, title: body.title, owner: body.ownerHandle, plannedAt: body.plannedAt, heldAt: null, status: 'planned',
        decisionsRecorded: false, decisionsText: null, linkedMs: [...new Set(body.linkedMs)], inputs: [], etag: null, contents: {},
      };
      s.push(row);
      return done(row.linkedMs, { ref: { id: row.id, code: row.code }, count: inputsOf(row).length });
    },
    async update(ms, review, patch) {
      const row = find(ms, review.id);
      if (!row) return notFound();
      if (row.status === 'closed') return closedReview(row.code);
      if (patch.linkedMs && !patch.linkedMs.includes(ms)) return refusal(422, [`The review must stay linked to ${ms}, the system of the request`, `Tinjauan harus tetap ditautkan ke ${ms}, sistem permintaan`]);
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.plannedAt !== undefined) row.plannedAt = patch.plannedAt;
      if (patch.ownerHandle !== undefined) row.owner = patch.ownerHandle;
      const before = [...row.linkedMs];
      if (patch.linkedMs) row.linkedMs = [...new Set(patch.linkedMs)];
      return done([...new Set([...before, ...row.linkedMs])], { ref: { id: row.id, code: row.code } });
    },
    async putInput(ms, review, defCode, content) {
      const row = find(ms, review.id);
      if (!row) return notFound();
      if (row.status === 'closed') return closedReview(row.code);
      if (!(INPUT_DEFS[ms] ?? []).some(([code]) => code === defCode)) return refusal(404, [`${defCode} is not a review input of the edition in use`, `${defCode} bukan masukan tinjauan dari edisi yang digunakan`], { slug: 'not-found' });
      row.contents[`${ms}:${defCode}`] = content.trim();
      return done([ms], { ref: { id: row.id, code: row.code } });
    },
    async move(ms, review, body) {
      const row = find(ms, review.id);
      if (!row) return notFound();
      const notAllowed = () => refusal(409, [`${row.status} to ${body.to} is not allowed`, `${row.status} ke ${body.to} tidak diizinkan`], { slug: 'transition-not-allowed' });
      if (body.to === 'held') {
        if (row.status !== 'planned') return notAllowed();
        Object.assign(row, { status: 'held', heldAt: body.heldAt ?? today() });
        return done(row.linkedMs, { ref: { id: row.id, code: row.code } });
      }
      if (row.status !== 'held') return notAllowed();
      if (inputsOf(row).some((i) => i.mandatory && !i.complete)) return refusal(422, RULE_TEXT['BR-13'], { rule: 'BR-13', slug: 'business-rule' });
      const decisions = filled(body.decisionsText) ? body.decisionsText!.trim() : row.decisionsText;
      if (!filled(decisions)) return refusal(422, RULE_TEXT['BR-14'], { rule: 'BR-14', slug: 'business-rule' });
      Object.assign(row, { status: 'closed', decisionsRecorded: true, decisionsText: decisions });
      return done(row.linkedMs, { ref: { id: row.id, code: row.code } });
    },
  };
}
