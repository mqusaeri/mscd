// Sample adapter of the Registers screen (MILESTONE-2 M2-13, C.6): the registers of the selected sample organisation,
// built once per organisation from the sample snapshot (the open chain records of `X`, the trace chains and their
// titles) and a few sample rows of the registers the snapshot does not hold (interested parties, assets, competence).
// Changes stay for the browser session, per organisation. The rules of the api that the screen shows are applied here
// too: BR-17 (a risk needs an owner), BR-22 (a shared record is changed after a confirmation), C.13 moves of treatments,
// BR-04 (closing waits for the residual acceptance, which the risk owner gives and the implementer never does) and the
// H.5 visibility of competence records. New risks, metrics and treatments are added to the snapshot's chain records,
// so Chain stages shows them too. Loaded only by the sample build (adapter.ts), so the api build holds none of it.
import type { RegisterKind, TreatmentStatus } from '@mscd/shared';
import type { ApiError } from '../../data/api/ApiClient';
import type { ControllerData, DataSource, MsId, UiRole } from '../../data/types';
import type { PickedFile } from '../types';
import { COMPETENCE_REMINDER_DAYS, KINDS, KIND_DEFS, competenceCode, proofHoldersOf } from './model';
import type {
  MoveTarget, Outcome, ProofHolder, RegistersAdapter, Result, RowModel, RowPage, TargetOption, TreatmentModel,
} from './model';

export interface SampleScope {
  getD(): ControllerData | null;
  me(): string;
  role(): UiRole | null;
  ds(): DataSource | null;
}

interface SampleTreatment extends TreatmentModel {
  ms: MsId;
  risk: string;
  status: TreatmentStatus;
}

interface SampleValue {
  metric: string;
  periodStart: string;
  periodEnd: string;
  value: number;
  note: string | null;
}

interface OrgState {
  rows: Record<RegisterKind, RowModel[]>;
  treatments: SampleTreatment[];
  values: SampleValue[];
  /** The stage keys of risks and treatments per system (`risk`, `drisk`, `brisk`; `treatment`, `action`). */
  stages: Record<MsId, { risk: string | null; treatment: string | null }>;
}

const STATES = new Map<string, OrgState>();
let sequence = 0;

/** Forgets every organisation's changes (tests). */
export function resetSampleRegisters(): void {
  STATES.clear();
  sequence = 0;
}

/** The sample snapshot lists the systems of the selected organisation; their ids name it. */
export function sampleOrgKey(D: ControllerData | null): string {
  return (D?.MS ?? []).map((m) => m.id).sort().join(',');
}

// ---------------------------------------------------------------------------------------------------------------
// Seed rows
// ---------------------------------------------------------------------------------------------------------------

/** A stable pseudo uuid of a text (sample ids; the competence code is taken from it). */
export function sampleId(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i += 1) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i), 0x5bd1e995) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  const a = hex(h1);
  const b = hex(h2);
  const c = hex(Math.imul(h1 ^ h2, 0x27d4eb2d) >>> 0);
  const d = hex((h1 + h2) >>> 0);
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4)}${d}`;
}

function newId(): string {
  sequence += 1;
  return sampleId(`new-${Date.now()}-${sequence}-${Math.random()}`);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A number from 1 to 5 that depends only on the text. */
function level(seed: string, salt: number): number {
  let h = salt;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return (h % 5) + 1;
}

const PROFILE_OF: Readonly<Record<string, string>> = { isms: 'information_security', qms: 'quality', bcms: 'disruption', abms: 'bribery' };

interface StaticRow {
  ms: MsId[];
  kind: RegisterKind;
  code: string;
  title: string;
  owner: string;
  fields: Record<string, unknown>;
}

/** Sample rows of the registers the snapshot does not hold (systems that are not in the organisation are left out). */
function staticRows(today: string): StaticRow[] {
  return [
    { ms: ['isms', 'qms'], kind: 'interested-parties', code: 'IP-01', title: 'Customers in regulated sectors', owner: 'rina', fields: { requirements: 'Security clauses in contracts, breach notice within 24 hours, yearly assurance report', lastReviewedAt: addDays(today, -40) } },
    { ms: ['isms'], kind: 'interested-parties', code: 'IP-02', title: 'Financial services regulator', owner: 'lina', fields: { requirements: 'Incident reports, approval before moving regulated workloads to a cloud provider', lastReviewedAt: addDays(today, -120) } },
    { ms: ['isms', 'bcms'], kind: 'interested-parties', code: 'IP-03', title: 'Cloud and colocation providers', owner: 'andi', fields: { requirements: 'Clear service levels, notice of planned maintenance, access rules for the data centre', lastReviewedAt: null } },
    { ms: ['qms'], kind: 'interested-parties', code: 'IP-Q01', title: 'Enterprise customers', owner: 'sari', fields: { requirements: 'On-time releases, defect fixes within the agreed time, ISO 9001:2026 certificate by 2027', lastReviewedAt: addDays(today, -15) } },
    { ms: ['abms'], kind: 'interested-parties', code: 'IP-A01', title: 'Procurement partners', owner: 'lina', fields: { requirements: 'Anti-bribery clauses and due diligence before contract award', lastReviewedAt: null } },
    { ms: ['isms'], kind: 'assets', code: 'AS-01', title: 'Customer database cluster', owner: 'bagus', fields: { assetType: 'information', classification: 'restricted' } },
    { ms: ['isms', 'bcms'], kind: 'assets', code: 'AS-02', title: 'Hypervisor cluster Surabaya', owner: 'bagus', fields: { assetType: 'hardware', classification: 'confidential' } },
    { ms: ['isms'], kind: 'assets', code: 'AS-03', title: 'Source code repositories', owner: 'yusuf', fields: { assetType: 'software', classification: 'confidential' } },
    { ms: ['isms'], kind: 'assets', code: 'AS-04', title: 'Staff laptops', owner: 'fajar', fields: { assetType: 'hardware', classification: 'internal' } },
    { ms: ['qms'], kind: 'assets', code: 'AS-Q01', title: 'Release pipeline', owner: 'yusuf', fields: { assetType: 'software', classification: 'internal' } },
    {
      ms: ['isms', 'qms'], kind: 'competence', code: 'maya-auditor', title: 'Internal auditor', owner: 'rina',
      fields: { personHandle: 'maya', competenceRequired: 'ISO/IEC 27001 and ISO 9001 lead auditor training', proofType: 'certificate', achievedAt: '2025-03-14', validUntil: '2028-03-14', verifiedByHandle: 'rina', proofObjectId: sampleId('proof-maya'), proofName: 'Lead-Auditor-Certificate-Maya.pdf' },
    },
    {
      ms: ['isms'], kind: 'competence', code: 'bagus-pam', title: 'IT infrastructure lead', owner: 'rina',
      fields: { personHandle: 'bagus', competenceRequired: 'Administration of privileged access management', proofType: 'training', achievedAt: addDays(today, -700), validUntil: addDays(today, 21), verifiedByHandle: 'rina', proofObjectId: null },
    },
    {
      ms: ['isms'], kind: 'competence', code: 'dewi-screening', title: 'HR manager', owner: 'dewi',
      fields: { personHandle: 'dewi', competenceRequired: 'Security screening of new staff', proofType: 'experience', achievedAt: '2023-01-02', validUntil: null, verifiedByHandle: null, proofObjectId: null },
    },
    {
      ms: ['qms'], kind: 'competence', code: 'sari-audit', title: 'Head of quality', owner: 'sari',
      fields: { personHandle: 'sari', competenceRequired: 'ISO 9001 internal audit', proofType: 'certificate', achievedAt: '2024-05-02', validUntil: '2027-05-01', verifiedByHandle: 'rina', proofObjectId: null },
    },
    {
      ms: ['bcms'], kind: 'competence', code: 'tono-bcm', title: 'BCM coordinator', owner: 'tono',
      fields: { personHandle: 'tono', competenceRequired: 'Business continuity exercise planning', proofType: 'assessment', achievedAt: '2025-08-20', validUntil: addDays(today, -3), verifiedByHandle: null, proofObjectId: null },
    },
    {
      ms: ['qms'], kind: 'objectives', code: 'QO-02', title: 'Fewer escaped defects', owner: 'sari',
      fields: { statement: 'Keep defects found by customers below 5 per release', targetText: 'At most 5 per release', metricCode: 'MQ-02', dueAt: addDays(today, 90), resources: 'QA team, test automation budget', evaluationMethod: 'Release report reviewed at the monthly quality meeting', objectiveStatus: 'at_risk', result: null, achievedAt: null },
    },
    {
      ms: ['isms'], kind: 'objectives', code: 'QO-11', title: 'Patch critical vulnerabilities fast', owner: 'bagus',
      fields: { statement: 'Patch every critical vulnerability within 14 days of the vendor release', targetText: '95% within 14 days', metricCode: 'M-07', dueAt: addDays(today, 60), resources: 'Infrastructure team, patch management tool', evaluationMethod: 'Patch SLA metric reviewed every month', objectiveStatus: 'on_track', result: null, achievedAt: null },
    },
  ];
}

/** Text of an issue that comes from outside the organisation. */
const EXTERNAL = /regulat|customer|provider|cloud|competit|utility|law|market|enterprise/i;

function buildState(D: ControllerData): OrgState {
  const today = D.today || D.TODAY_S;
  const rows: Record<RegisterKind, RowModel[]> = Object.fromEntries(KINDS.map((k) => [k, []])) as unknown as Record<RegisterKind, RowModel[]>;
  const treatments: SampleTreatment[] = [];
  const stages: OrgState['stages'] = {};
  const systems = (D.MS ?? []).map((m) => m.id);
  const titleOf = (code: string) => D.TITLES?.[code] ?? code;
  const managerOf = (ms: MsId) => D.MS.find((m) => m.id === ms)?.mgr ?? 'rina';
  const upsert = (kind: RegisterKind, ms: MsId, code: string, base: () => RowModel) => {
    const found = rows[kind].find((r) => r.code === code);
    if (found) {
      if (!found.ms.includes(ms)) found.ms.push(ms);
      found.shared = found.ms.length > 1;
      return found;
    }
    const row = base();
    rows[kind].push(row);
    return row;
  };
  const row = (kind: RegisterKind, ms: MsId, code: string, title: string, owner: string, open: boolean, fields: Record<string, unknown>): RowModel => ({
    id: sampleId(`${kind}:${code}`), etag: null, code, title, owner: owner || 'none', updatedAt: `${today}T03:00:00Z`, shared: false, ms: [ms],
    ...(kind === 'interested-parties' || kind === 'assets' ? {} : { status: open ? 'open' : 'ready' }),
    ...fields,
  } as RowModel);

  for (const ms of systems) {
    const X = (D.X?.[ms] ?? {}) as Record<string, { id: string; t: string; act: string; h: string; due: string | null; up?: string[]; down?: string[] }[]>;
    const stageKeys = (D.STAGES?.[ms] ?? []).map((s) => s.id);
    const riskStage = ['risk', 'drisk', 'brisk'].find((s) => stageKeys.includes(s)) ?? null;
    const treatmentStage = ['treatment', 'action'].find((s) => stageKeys.includes(s)) ?? null;
    stages[ms] = { risk: riskStage, treatment: treatmentStage };
    const chainCodes = (stage: string | null): string[] => (stage ? (D.CHAINS?.[ms] ?? []).flatMap((c) => c.nodes.filter(([s, code]) => s === stage && code).map(([, code]) => code as string)) : []);
    const records = (stage: string | null) => (stage ? X[stage] ?? [] : []);

    // Context issues
    for (const x of records('context')) {
      upsert('context-issues', ms, x.id, () => row('context-issues', ms, x.id, x.t, x.h, true, { issueType: EXTERNAL.test(x.t) ? 'external' : 'internal', description: x.act, lastReviewedAt: addDays(today, -level(x.id, 3) * 30) }));
    }
    for (const code of chainCodes('context')) {
      upsert('context-issues', ms, code, () => row('context-issues', ms, code, titleOf(code), managerOf(ms), false, { issueType: EXTERNAL.test(titleOf(code)) ? 'external' : 'internal', description: null, lastReviewedAt: addDays(today, -level(code, 5) * 20) }));
    }
    // Risks
    const riskFields = (code: string, title: string, due: string | null, hasTreatment: boolean) => ({
      riskProfileCode: PROFILE_OF[ms] ?? 'information_security',
      isOpportunity: /opportunit/i.test(title),
      description: null,
      likelihood: level(code, 7),
      consequence: level(code, 11),
      residualLikelihood: hasTreatment ? Math.max(1, level(code, 7) - 2) : null,
      residualConsequence: hasTreatment ? Math.max(1, level(code, 11) - 1) : null,
      treatmentOption: hasTreatment ? 'modify' : null,
      assessedAt: addDays(today, -level(code, 13) * 25),
      nextReviewAt: due ?? addDays(today, 200),
      residualAcceptedAt: null,
    });
    const treatmentCodes = new Set([...records(treatmentStage).flatMap((t) => t.up ?? []), ...(D.CHAINS?.[ms] ?? []).filter((c) => treatmentStage && c.nodes.some(([s]) => s === treatmentStage)).map((c) => c.nodes.find(([s]) => s === riskStage)?.[1] ?? '')]);
    for (const x of records(riskStage)) {
      upsert('risks', ms, x.id, () => row('risks', ms, x.id, x.t, x.h, true, riskFields(x.id, x.t, x.due, treatmentCodes.has(x.id) || (x.down ?? []).length > 0)));
    }
    for (const code of chainCodes(riskStage)) {
      upsert('risks', ms, code, () => row('risks', ms, code, titleOf(code), managerOf(ms), false, riskFields(code, titleOf(code), null, true)));
    }
    // Treatments of the risks
    for (const x of records(treatmentStage)) {
      const proposed = x.h === 'none' || /assign owner|plan treatment/i.test(x.act);
      treatments.push({
        id: sampleId(`treatment:${x.id}`), ms, risk: x.up?.[0] ?? '', code: x.id, title: x.t, owner: x.h || 'none', due: x.due, target: x.down?.[0] ?? null,
        status: proposed ? 'proposed' : 'in_progress', etag: null, implementedBy: null,
      });
    }
    for (const chain of D.CHAINS?.[ms] ?? []) {
      const node = chain.nodes.find(([s]) => s === treatmentStage);
      const risk = chain.nodes.find(([s]) => s === riskStage)?.[1];
      if (!node || !node[1] || !risk || treatments.some((t) => t.code === node[1])) continue;
      const target = chain.nodes[chain.nodes.indexOf(node) + 1]?.[1] ?? null;
      const owner = ms === 'isms' ? 'bagus' : managerOf(ms);
      treatments.push({
        id: sampleId(`treatment:${node[1]}`), ms, risk, code: node[1], title: titleOf(node[1]), owner, due: null, target,
        status: 'implemented', etag: null, implementedBy: owner,
      });
    }
    // Metrics
    const metricFields = (title: string, open: boolean, code: string) => ({
      unit: /%|rate|completion|compliance/i.test(title) ? '%' : /time/i.test(title) ? 'hours' : null,
      targetValue: /time/i.test(title) ? 4 : 95,
      frequencyCode: level(code, 17) > 3 ? 'quarterly' : 'monthly',
      lastMeasuredAt: open ? null : addDays(today, -level(code, 19) * 9),
    });
    for (const x of records('metric')) upsert('metrics', ms, x.id, () => row('metrics', ms, x.id, x.t, x.h, true, metricFields(x.t, true, x.id)));
    for (const code of chainCodes('metric')) upsert('metrics', ms, code, () => row('metrics', ms, code, titleOf(code), managerOf(ms), false, metricFields(titleOf(code), false, code)));
    // Objectives of the chain
    const objectiveFields = (title: string, due: string | null, metric: string | null, status: string) => ({
      statement: title, targetText: (/[≥≤]\s*[\d.,]+\s*%?(\s*\/\s*\d+)?/.exec(title)?.[0] ?? null), metricCode: metric, dueAt: due ?? addDays(today, 120),
      resources: null, evaluationMethod: null, objectiveStatus: status, result: null, achievedAt: null,
    });
    for (const x of records('objective')) {
      upsert('objectives', ms, x.id, () => row('objectives', ms, x.id, x.t, x.h, true, objectiveFields(x.t, x.due, null, 'on_track')));
    }
    for (const chain of D.CHAINS?.[ms] ?? []) {
      const node = chain.nodes.find(([s]) => s === 'objective');
      if (!node || !node[1]) continue;
      const metric = chain.nodes.find(([s]) => s === 'metric')?.[1] ?? null;
      upsert('objectives', ms, node[1], () => row('objectives', ms, node[1]!, titleOf(node[1]!), managerOf(ms), false, objectiveFields(titleOf(node[1]!), null, metric, 'achieved')));
    }
  }
  // The registers the snapshot does not hold.
  for (const s of staticRows(today)) {
    const linked = s.ms.filter((ms) => systems.includes(ms));
    if (!linked.length) continue;
    const id = sampleId(`${s.kind}:${s.code}`);
    const code = s.kind === 'competence' ? competenceCode(id) : s.code;
    const open = s.kind === 'competence' ? Boolean(s.fields.validUntil && String(s.fields.validUntil) <= addDays(today, COMPETENCE_REMINDER_DAYS)) : false;
    const r = row(s.kind, linked[0], code, s.title, s.owner, open, s.fields);
    rows[s.kind].push({ ...r, id, ms: linked, shared: linked.length > 1 });
  }
  return { rows, treatments, values: [], stages };
}

// ---------------------------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------------------------

const fail = <T,>(status: number, message: [string, string], extra: Partial<ApiError> = {}): Result<T> => ({ ok: false, error: { status, message, ...extra } });
const done = (changed: MsId[], message: [string, string] | null = null, ref: { id: string; code: string } | null = null, data: Record<string, unknown> | null = null): Result<Outcome> => ({
  ok: true, data: { message, warnings: [], changed, ref, data },
});

/** The C.13 table of `risk_treatment.status` (rework to proposed included). */
const ALLOWED: Readonly<Record<TreatmentStatus, readonly TreatmentStatus[]>> = {
  proposed: ['approved'],
  approved: ['in_progress', 'proposed'],
  in_progress: ['delayed', 'implemented', 'proposed'],
  delayed: ['in_progress', 'implemented', 'proposed'],
  implemented: [],
  residual_accepted: ['closed'],
  closed: [],
};

const STATUS_ACTION: Readonly<Record<TreatmentStatus, string | null>> = {
  proposed: 'Approve the treatment',
  approved: 'Start the implementation',
  in_progress: 'Report implementation progress',
  delayed: 'Report implementation progress: the target date has passed',
  implemented: null,
  residual_accepted: null,
  closed: null,
};

export function createSampleAdapter(scope: SampleScope): RegistersAdapter {
  const state = (): OrgState => {
    const D = scope.getD();
    const key = sampleOrgKey(D);
    let s = STATES.get(key);
    if (!s) {
      s = D ? buildState(D) : { rows: Object.fromEntries(KINDS.map((k) => [k, []])) as unknown as OrgState['rows'], treatments: [], values: [], stages: {} };
      STATES.set(key, s);
    }
    return s;
  };
  const today = () => {
    const D = scope.getD();
    return D?.today || D?.TODAY_S || new Date().toISOString().slice(0, 10);
  };
  const shortOf = (ms: MsId) => scope.getD()?.MS.find((m) => m.id === ms)?.short ?? ms.toUpperCase();
  const touch = (row: RowModel) => {
    row.updatedAt = new Date().toISOString();
  };
  /** Adds an open chain record to the sample snapshot, so the built-in screens show it; the systems to reload. */
  const chain = async (ms: MsId, stage: string | null, record: Record<string, unknown>, mode: 'insert' | 'mutate' = 'insert'): Promise<MsId[]> => {
    const ds = scope.ds();
    if (!ds || !stage) return [];
    try {
      const res = mode === 'insert' ? await ds.insert?.(ms, `x:${stage}`, record) : await ds.mutate?.(ms, `x:${stage}`, String(record.id), { act: record.act });
      return res && res.ok ? [...res.changed] : [];
    } catch {
      return [];
    }
  };
  const visible = (kind: RegisterKind, row: RowModel): RowModel | null => {
    const role = scope.role();
    const me = scope.me();
    const person = (row as { personHandle?: string }).personHandle;
    const own = row.owner === me || person === me;
    if (kind === 'competence' && role !== 'manager' && role !== 'auditor') return own ? row : null;
    if (role === 'owner') return own ? row : null;
    if (role === 'top' && !own) {
      const hidden: RowModel = { ...row, owner: 'none' };
      if ('nextReviewAt' in hidden) hidden.nextReviewAt = null;
      if ('dueAt' in hidden) hidden.dueAt = null;
      return hidden;
    }
    return row;
  };
  /** BR-22: a row shared by several systems changes everywhere; the caller confirms first (409 confirmation-required). */
  const sharedRefusal = (row: RowModel): Result<Outcome> | null => {
    if (row.ms.length < 2) return null;
    const names = row.ms.map(shortOf).join(', ');
    return fail(409, [`${row.code} is shared with ${names}. The change applies to every linked system.`, `${row.code} dibagi dengan ${names}. Perubahan berlaku di setiap sistem tertaut.`], { slug: 'confirmation-required', rule: 'BR-22' });
  };

  return {
    sample: true,
    async list(ms, kind, query): Promise<Result<RowPage>> {
      const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const D = scope.getD();
      const all = state().rows[kind]
        .filter((r) => r.ms.includes(ms))
        .map((r) => visible(kind, r))
        .filter((r): r is RowModel => Boolean(r))
        .filter((r) => {
          if (!words.length) return true;
          const owner = r.owner === 'none' ? '' : `${r.owner} ${D?.PEOPLE?.[r.owner]?.[0] ?? ''}`;
          const hay = `${r.code} ${r.title} ${owner}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });
      const start = (query.page - 1) * query.pageSize;
      return { ok: true, data: { items: all.slice(start, start + query.pageSize).map((r) => ({ ...r, ms: [...r.ms] })), page: query.page, pageSize: query.pageSize, total: all.length } };
    },
    async create(ms, kind, body) {
      const s = state();
      const def = KIND_DEFS[kind];
      const owner = body.ownerHandle ?? (kind === 'risks' ? 'none' : scope.me());
      if (kind === 'risks' && owner === 'none') {
        return fail(422, ['Every risk needs an owner (BR-17).', 'Setiap risiko memerlukan pemilik (BR-17).'], { slug: 'business-rule', rule: 'BR-17' });
      }
      if (def.ownerRequired && owner === 'none') return fail(422, ['This register needs an owner for every row', 'Register ini memerlukan pemilik untuk setiap baris'], { slug: 'business-rule', messageKey: 'register.owner_required' });
      if (def.prefix && s.rows[kind].some((r) => r.code === body.code && (def.shared || r.ms.includes(ms)))) {
        return fail(409, [`${body.code} already exists`, `${body.code} sudah ada`], { slug: 'conflict', messageKey: 'register.duplicate_code' });
      }
      const id = newId();
      const code = def.prefix ? String(body.code) : competenceCode(id);
      const { code: _c, title, ownerHandle: _o, linkedMs, confirm: _x, ...fields } = body as Record<string, unknown> & { title: string; linkedMs?: MsId[] };
      const pending = kind === 'risks' || kind === 'metrics';
      const row = {
        ...fields, id, etag: null, code, title, owner, updatedAt: new Date().toISOString(), ms: linkedMs ?? [ms], shared: (linkedMs ?? [ms]).length > 1,
        ...(['interested-parties', 'assets'].includes(kind) ? {} : { status: pending ? 'open' : 'ready' }),
        ...(kind === 'risks' ? { riskProfileCode: PROFILE_OF[ms] ?? 'information_security', residualAcceptedAt: null } : {}),
        ...(kind === 'metrics' ? { lastMeasuredAt: null } : {}),
      } as unknown as RowModel;
      if (kind === 'competence' && body.proofObjectId) row.proofName = PROOF_NAMES.get(body.proofObjectId) ?? null;
      s.rows[kind].push(row);
      let changed: MsId[] = [];
      if (kind === 'risks') changed = await chain(ms, s.stages[ms]?.risk ?? 'risk', { id: code, t: title, act: 'Select a treatment: no treatment linked', h: owner, due: null });
      if (kind === 'metrics') changed = await chain(ms, 'metric', { id: code, t: title, act: 'Enter the first value', h: owner, due: null });
      return done(changed, null, { id, code });
    },
    async update(ms, kind, row, patch) {
      const s = state();
      const current = s.rows[kind].find((r) => r.id === row.id);
      if (!current) return fail(404, ['Not found', 'Tidak ditemukan'], { slug: 'not-found' });
      const p = patch as Record<string, unknown> & { linkedMs?: MsId[]; confirm?: boolean; ownerHandle?: string };
      if (!p.confirm) {
        const refusal = sharedRefusal(current);
        if (refusal) return refusal;
      }
      if (kind === 'risks' && p.ownerHandle === 'none') return fail(422, ['Every risk needs an owner (BR-17).', 'Setiap risiko memerlukan pemilik (BR-17).'], { slug: 'business-rule', rule: 'BR-17' });
      if (p.code !== undefined && s.rows[kind].some((r) => r.id !== current.id && r.code === p.code)) {
        return fail(409, [`${String(p.code)} already exists`, `${String(p.code)} sudah ada`], { slug: 'conflict', messageKey: 'register.duplicate_code' });
      }
      if (p.linkedMs) {
        if (!p.linkedMs.includes(ms)) return fail(422, [`linkedMs must include ${ms}, the system of the request`, `linkedMs harus mencakup ${ms}, sistem dari permintaan ini`], { slug: 'business-rule' });
        current.ms = [...p.linkedMs];
        current.shared = current.ms.length > 1;
      }
      const { linkedMs: _l, confirm: _c, ownerHandle, ...fields } = p;
      Object.assign(current, fields);
      if (ownerHandle !== undefined) current.owner = ownerHandle;
      if (kind === 'competence' && typeof p.proofObjectId === 'string') current.proofName = PROOF_NAMES.get(p.proofObjectId) ?? current.proofName ?? null;
      if (kind === 'competence' && p.validUntil !== undefined) {
        const valid = p.validUntil as string | null;
        current.status = valid && valid <= addDays(today(), COMPETENCE_REMINDER_DAYS) ? 'open' : 'ready';
      }
      touch(current);
      return done([], null, { id: current.id, code: current.code });
    },
    async recordValue(ms, row, body) {
      const s = state();
      const metric = s.rows.metrics.find((r) => r.id === row.id);
      if (!metric) return fail(404, ['Not found', 'Tidak ditemukan'], { slug: 'not-found' });
      const overlap = s.values.find((v) => v.metric === metric.id && v.periodStart <= body.periodEnd && v.periodEnd >= body.periodStart);
      if (overlap) {
        return fail(422, [`The period overlaps the value recorded for ${overlap.periodStart} to ${overlap.periodEnd}`, `Periode tumpang tindih dengan nilai yang tercatat untuk ${overlap.periodStart} sampai ${overlap.periodEnd}`], { slug: 'business-rule', messageKey: 'metric.period_overlap' });
      }
      s.values.push({ metric: metric.id, periodStart: body.periodStart, periodEnd: body.periodEnd, value: body.value, note: body.note ?? null });
      metric.lastMeasuredAt = metric.lastMeasuredAt && metric.lastMeasuredAt > body.periodEnd ? metric.lastMeasuredAt : body.periodEnd;
      metric.status = 'ready';
      touch(metric);
      return done([], null, { id: metric.id, code: metric.code });
    },
    async treatments(ms, risk) {
      const list = state().treatments.filter((t) => t.ms === ms && t.risk === risk.code).map((t) => ({ ...t }));
      return { ok: true, data: list };
    },
    async addTreatment(ms, risk, body) {
      const s = state();
      if (s.treatments.some((t) => t.ms === ms && t.code === body.code)) return fail(409, [`${body.code} already exists in this system`, `${body.code} sudah ada di sistem ini`], { slug: 'conflict', messageKey: 'register.duplicate_code' });
      const t: SampleTreatment = {
        id: newId(), ms, risk: risk.code, code: body.code, title: body.title, owner: body.ownerHandle, due: body.targetDate, target: body.targetCode,
        status: 'proposed', etag: null, implementedBy: null,
      };
      s.treatments.push(t);
      const row = s.rows.risks.find((r) => r.id === risk.id);
      if (row && row.status === 'open' && !s.treatments.some((x) => x.risk === row.code && x.status === 'implemented')) row.status = 'ready';
      const changed = await chain(ms, s.stages[ms]?.treatment ?? null, { id: t.code, t: t.title, act: STATUS_ACTION.proposed, h: t.owner, due: t.due, up: [risk.code], down: [body.targetCode] });
      return done(changed, null, { id: t.id, code: t.code });
    },
    async moveTreatment(ms, risk, treatment, to: MoveTarget) {
      const s = state();
      const t = s.treatments.find((x) => x.id === treatment.id);
      if (!t) return fail(404, ['Not found', 'Tidak ditemukan'], { slug: 'not-found' });
      if (to === 'closed' && t.status !== 'residual_accepted') {
        return fail(422, ['The treatment closes only after the risk owner accepted the residual risk (BR-04).', 'Perlakuan ditutup hanya setelah pemilik risiko menerima risiko residual (BR-04).'], { slug: 'business-rule', rule: 'BR-04' });
      }
      if (!ALLOWED[t.status].includes(to)) {
        return fail(409, [`A treatment cannot move from ${t.status} to ${to}`, `Perlakuan tidak dapat berpindah dari ${t.status} ke ${to}`], { slug: 'transition-not-allowed' });
      }
      t.status = to;
      if (to === 'implemented') {
        t.implementedBy = scope.me();
        const row = s.rows.risks.find((r) => r.id === risk.id);
        if (row) row.status = 'open';
      }
      const changed = STATUS_ACTION[to] ? await chain(ms, s.stages[ms]?.treatment ?? null, { id: t.code, act: STATUS_ACTION[to] }, 'mutate') : [];
      return done(changed, null, { id: t.id, code: t.code });
    },
    async acceptResidual(ms, risk, body) {
      const s = state();
      const row = s.rows.risks.find((r) => r.id === risk.id);
      if (!row) return fail(404, ['Not found', 'Tidak ditemukan'], { slug: 'not-found' });
      if (row.owner !== scope.me()) return fail(403, ["Only the risk's owner accepts its residual risk", 'Hanya pemilik risiko yang menerima risiko residualnya'], { slug: 'forbidden' });
      const implemented = s.treatments.filter((t) => t.ms === ms && t.risk === row.code && t.status === 'implemented');
      const t = body.treatmentId ? implemented.find((x) => x.id === body.treatmentId) : implemented.length === 1 ? implemented[0] : null;
      if (!t) {
        return fail(422, ['Residual acceptance needs an implemented treatment of this risk (BR-04).', 'Penerimaan risiko residual memerlukan perlakuan risiko ini yang sudah diterapkan (BR-04).'], { slug: 'business-rule', rule: 'BR-04' });
      }
      if (t.implementedBy === scope.me()) {
        return fail(422, ['The implementer of the treatment cannot accept the residual risk (BR-04).', 'Pelaksana perlakuan tidak dapat menerima risiko residual (BR-04).'], { slug: 'business-rule', rule: 'BR-04' });
      }
      t.status = 'residual_accepted';
      Object.assign(row, { residualLikelihood: body.residualLikelihood, residualConsequence: body.residualConsequence, residualAcceptedAt: today(), status: 'ready' });
      touch(row);
      return done([], null, { id: row.id, code: row.code });
    },
    async link(ms, kind, row, target) {
      const s = state();
      const current = s.rows[kind].find((r) => r.id === row.id);
      if (!current) return fail(404, ['Not found', 'Tidak ditemukan'], { slug: 'not-found' });
      if (current.ms.includes(target)) return fail(409, [`${current.code} is already linked to ${target}`, `${current.code} sudah ditautkan ke ${target}`], { slug: 'conflict' });
      current.ms.push(target);
      current.shared = true;
      touch(current);
      return done([], null, { id: current.id, code: current.code });
    },
    async targets(ms) {
      const reqs = scope.getD()?.bundles?.[ms]?.reqs ?? [];
      const list: TargetOption[] = reqs.map((r) => ({ kind: /^(Cl\.|cl-)/.test(r.id) || !/^A\./.test(r.id) ? 'requirement' : 'catalogue_item', code: r.id, title: r.title }));
      return { ok: true, data: list };
    },
    async treatmentCodes(ms) {
      return { ok: true, data: state().treatments.filter((t) => t.ms === ms).map((t) => t.code) };
    },
    proofHolders(ms): ProofHolder[] {
      return proofHoldersOf(scope.getD()?.bundles?.[ms]?.evs ?? [], (code) => code);
    },
    async attachProof(_ms, _holder, file: PickedFile) {
      const id = newId();
      PROOF_NAMES.set(id, file.fileName);
      return { ok: true, data: { storageObjectId: id, fileName: file.fileName } };
    },
    async openProof() {
      return { ok: true, data: null };
    },
  };
}

/** File names of the proofs picked in this session, by their sample object id. */
const PROOF_NAMES = new Map<string, string>();
