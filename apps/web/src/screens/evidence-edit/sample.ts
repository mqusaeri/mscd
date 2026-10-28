// Sample adapter of the evidence forms (MILESTONE-2 M2-11, C.6): new evidence goes into the sample snapshot through
// `insert` of the sample data source and changes through `mutate`, so Evidence freshness shows it. A record of the
// sample serves one control per system; further targets and the freshness limits set on screen are kept in memory for
// the session (the sample's freshness bands keep the built-in limits). Loaded with a dynamic import in the sample
// branch only (adapter.ts), so an API build holds none of it (R-13).
import type { CommandResult, ControllerData, DataSource, Evidence, MsId, Requirement } from '../../data/types';
import { periodOf, recordKey, refusal } from '../controls-edit/common';
import type { Outcome, Result, Warn } from '../controls-edit/common';
import { DEFAULT_LIMITS, idOfTarget } from './model';
import type { EvidenceAdapter, EvidenceRef, EvidenceTarget, Threshold } from './model';
import { TEXT } from './text';

type Sample = Pick<DataSource, 'mutate' | 'insert' | 'uploadFile'>;

const KEEPS_FIRST: [string, string] = [
  'The sample data keeps the first control of each system. On a live installation this target is removed.',
  'Data contoh mempertahankan kontrol pertama tiap sistem. Pada instalasi sungguhan target ini dihapus.',
];

/** Targets added in the sample session, by evidence code, and the freshness limits set, by `<ms>:<frequency>`. */
const extra = new Map<string, EvidenceTarget[]>();
const limits = new Map<string, Threshold>();
let counter = 0;

/** Forgets what the sample session added (unit tests). */
export function resetSampleEvidence(): void {
  extra.clear();
  limits.clear();
  counter = 0;
}

const evsOf = (D: ControllerData | null, ms: MsId): Evidence[] => (D?.bundles?.[ms]?.evs ?? []) as Evidence[];
const reqsOf = (D: ControllerData | null, ms: MsId): Requirement[] => (D?.bundles?.[ms]?.reqs ?? []) as Requirement[];
const shortOf = (D: ControllerData | null, ms: MsId) => D?.MS?.find((m) => m.id === ms)?.short ?? ms;
const snapshotId = (ms: MsId, id: string) => `sample:${ms}:${id}`;

/** The band of E.3 with the default limits (the sample keeps them). */
function bandOf(D: ControllerData | null, prod: string, p: number): Evidence['fresh'] {
  if (!p) return 'fresh';
  if (!prod || !D) return 'critical';
  const age = -D.dd(prod);
  if (age <= p + DEFAULT_LIMITS.graceDays) return 'fresh';
  if (age <= p * DEFAULT_LIMITS.agingFactor + DEFAULT_LIMITS.graceDays) return 'aging';
  if (age <= p * DEFAULT_LIMITS.expiredFactor) return 'expired';
  return 'critical';
}

/** Every target of a sample evidence record: its control in each system whose bundle holds it, then the added ones. */
export function sampleTargetsOf(D: ControllerData | null, code: string): EvidenceTarget[] {
  const out: EvidenceTarget[] = [];
  for (const ms of Object.keys(D?.bundles ?? {})) {
    const e = evsOf(D, ms).find((x) => x.code === code);
    if (!e || !e.ctrl) continue;
    const t = /^Cl\.\s/.test(e.ctrl) ? { targetType: 'requirement' as const, code: e.ctrl.replace(/^Cl\.\s+/, '') } : { targetType: 'catalogue_item' as const, code: e.ctrl };
    out.push({ id: snapshotId(ms, e.ctrl), ms, ...t });
  }
  for (const t of extra.get(code) ?? []) if (!out.some((o) => o.ms === t.ms && o.code === t.code && o.targetType === t.targetType)) out.push(t);
  return out;
}

const done = (res: CommandResult | undefined, extraOut: Partial<Outcome> = {}): Result<Outcome> => {
  if (!res) return refusal(0, TEXT.notFound);
  if (!res.ok) return { ok: false, error: { status: res.error?.status ?? 422, message: res.error?.message ?? [TEXT.notFound[0], TEXT.notFound[1]] } };
  return { ok: true, data: { changed: res.changed, warnings: [], ...extraOut } };
};

export function createSampleAdapter(getD: () => ControllerData | null, ds: Sample | null): EvidenceAdapter {
  const find = (ev: EvidenceRef) => evsOf(getD(), ev.ms).find((e) => e.code === ev.code) ?? null;
  return {
    async create(ms, body) {
      const D = getD();
      const taken = Object.keys(D?.bundles ?? {}).some((m) => evsOf(D, m).some((e) => e.code.toLowerCase() === body.code.toLowerCase()));
      if (taken) return refusal(409, [TEXT.codeTaken[0].replace('{code}', body.code), TEXT.codeTaken[1].replace('{code}', body.code)]);
      const reqs = reqsOf(D, ms);
      const picked = body.targets.map((t) => reqs.find((c) => c.id === idOfTarget(t))).filter((c): c is Requirement => Boolean(c));
      if (!picked.length || picked.length !== body.targets.length) return refusal(422, TEXT.targetRequired);
      const p = periodOf(D, body.frequencyCode);
      const system = D?.MS?.find((m) => m.id === ms);
      const row: Evidence = {
        code: body.code, ctrl: picked[0].id, ctrlKey: picked[0].key, title: body.title, freq: body.frequencyCode as Evidence['freq'], p,
        prod: '', next: null, fresh: bandOf(D, '', p), integ: 'ok', loc: system?.loc ?? 'vault', owner: body.ownerHandle, ver: '-', hashAlg: 'none', path: '',
      };
      if (!ds?.insert) return refusal(0, TEXT.notFound);
      const res = await ds.insert(ms, 'ev', row as unknown as Record<string, unknown>);
      if (res.ok && picked.length > 1) {
        extra.set(body.code, picked.slice(1).map((c) => ({ id: `sample-target-${++counter}`, ms, ...(/^Cl\.\s/.test(c.id) ? { targetType: 'requirement' as const, code: c.id.replace(/^Cl\.\s+/, '') } : { targetType: 'catalogue_item' as const, code: c.id }) })));
      }
      return done(res, { data: { code: body.code } });
    },
    async update(ev, patch) {
      const D = getD();
      const current = find(ev);
      if (!current) return refusal(404, TEXT.notFound);
      const next: Record<string, unknown> = {};
      if (patch.title !== undefined) next.title = patch.title;
      if (patch.ownerHandle !== undefined) next.owner = patch.ownerHandle;
      if (patch.frequencyCode !== undefined) {
        const p = periodOf(D, patch.frequencyCode);
        Object.assign(next, { freq: patch.frequencyCode, p, next: current.prod && p ? D!.addD(current.prod, p) : null, fresh: bandOf(D, current.prod, p) });
      }
      if (!Object.keys(next).length) return { ok: true, data: { changed: [], warnings: [], message: TEXT.nothingChanged } };
      if (!ds?.mutate) return refusal(0, TEXT.notFound);
      return done(await ds.mutate(ev.ms, 'ev', ev.code, next));
    },
    async addTarget(ev, body) {
      const D = getD();
      if (!find(ev)) return refusal(404, TEXT.notFound);
      const id = idOfTarget(body);
      if (!reqsOf(D, body.ms).some((c) => c.id === id)) {
        return refusal(422, [`${body.code} has no applicability entry in ${shortOf(D, body.ms)}`, `${body.code} tidak memiliki entri penerapan di ${shortOf(D, body.ms)}`]);
      }
      if (sampleTargetsOf(D, ev.code).some((t) => t.ms === body.ms && idOfTarget(t) === id)) {
        return refusal(409, [TEXT.sampleDuplicate[0].replace('{code}', body.code).replace('{system}', shortOf(D, body.ms)), TEXT.sampleDuplicate[1].replace('{code}', body.code).replace('{system}', shortOf(D, body.ms))]);
      }
      const targetId = `sample-target-${++counter}`;
      extra.set(ev.code, [...(extra.get(ev.code) ?? []), { id: targetId, ms: body.ms, targetType: body.targetType, code: body.code }]);
      // BR-23 is a warning: the sample gives it for a target in another system, as a non-reusable mapping would.
      const warnings: Warn[] = body.ms !== ev.ms ? [{ rule: 'BR-23', message: [TEXT.sampleBr23[0], TEXT.sampleBr23[1]] }] : [];
      return { ok: true, data: { changed: [...new Set([ev.ms, body.ms])], warnings, data: { targetId } } };
    },
    async removeTarget(ev, target) {
      const D = getD();
      const all = sampleTargetsOf(D, ev.code);
      if (all.length <= 1) return refusal(422, TEXT.sampleLastTarget);
      const added = extra.get(ev.code) ?? [];
      if (!added.some((t) => t.id === target.id)) return refusal(422, KEEPS_FIRST);
      extra.set(ev.code, added.filter((t) => t.id !== target.id));
      return { ok: true, data: { changed: [...new Set([ev.ms, target.ms])], warnings: [] } };
    },
    async targets(ev) {
      return { ok: true, data: { targets: sampleTargetsOf(getD(), ev.code), complete: true } };
    },
    async attach(ev) {
      if (!ds?.uploadFile) return refusal(0, TEXT.notFound);
      return done(await ds.uploadFile(recordKey(ev.ms, 'ev', ev.code), null));
    },
    async thresholds(ms) {
      const D = getD();
      const order = (D?.FREQ_ORDER ?? []) as string[];
      return {
        ok: true,
        data: order.map((f): Threshold => limits.get(`${ms}:${f}`) ?? { frequencyCode: f, ...DEFAULT_LIMITS, source: 'default' }),
      };
    },
    async setThreshold(ms, frequencyCode, body) {
      if (body.graceDays === null) limits.delete(`${ms}:${frequencyCode}`);
      else limits.set(`${ms}:${frequencyCode}`, { frequencyCode, graceDays: body.graceDays, agingFactor: body.agingFactor!, expiredFactor: body.expiredFactor!, source: 'set' });
      return { ok: true, data: { changed: [], warnings: [] } };
    },
  };
}
