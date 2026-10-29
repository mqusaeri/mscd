// Sample adapter of the controls and requirements forms (MILESTONE-2 M2-11, C.6): the sample build keeps its entries in
// the sample snapshot and changes them through `mutate` and `insert` of the sample data source, so the Controls screen
// shows the result. It answers the rules the forms meet on a live installation with the server's wording (BR-02,
// BR-03, APPL-ASSESS). Loaded with a dynamic import in the sample branch only (adapter.ts), so an API build holds none
// of it (R-13).
import type { CommandResult, ControllerData, DataSource, MsId, Requirement } from '../../data/types';
import { entryIdOf, filled, refusal, targetOfEntry } from './common';
import type { Outcome, Result, Warn } from './common';
import type { ControlsAdapter, DocChoice, RiskChoice, TargetItem } from './model';
import { TEXT } from './text';

/**
 * Leaf clause rows 4.1 to 10.2 of ISO/IEC 27001:2022 with the documented information flag of the pack
 * (packs/content/ISO27001-2022/requirements.csv): the clause entries a catalogue system can add (D2-09).
 */
const ISMS_CLAUSES: readonly [code: string, title: string, documented: boolean][] = [
  ['4.1', 'Understanding the organization and its context', false],
  ['4.2', 'Needs and expectations of interested parties', false],
  ['4.3', 'Scope of the management system', true],
  ['4.4', 'Management system and its processes', false],
  ['5.1', 'Leadership and commitment', false],
  ['5.2', 'Policy', true],
  ['5.3', 'Roles, responsibilities and authorities', false],
  ['6.1.1', 'Actions to address risks and opportunities: general', false],
  ['6.1.2', 'Information security risk assessment', true],
  ['6.1.3', 'Information security risk treatment', true],
  ['6.2', 'Objectives and planning to achieve them', true],
  ['6.3', 'Planning of changes', false],
  ['7.1', 'Resources', false],
  ['7.2', 'Competence', true],
  ['7.3', 'Awareness', false],
  ['7.4', 'Communication', false],
  ['7.5.1', 'Documented information: general', false],
  ['7.5.2', 'Creating and updating documented information', false],
  ['7.5.3', 'Control of documented information', false],
  ['8.1', 'Operational planning and control', true],
  ['8.2', 'Information security risk assessment', true],
  ['8.3', 'Information security risk treatment', true],
  ['9.1', 'Monitoring, measurement, analysis and evaluation', true],
  ['9.2.1', 'Internal audit: general', false],
  ['9.2.2', 'Internal audit programme', true],
  ['9.3.1', 'Management review: general', false],
  ['9.3.2', 'Management review inputs', false],
  ['9.3.3', 'Management review results', true],
  ['10.1', 'Continual improvement', false],
  ['10.2', 'Nonconformity and corrective action', true],
];

/** Clause rows of the requirement standards that ask for documented information (the high level structure). */
const DOCUMENTED_CLAUSES = new Set(['4.3', '5.2', '6.1', '6.2', '7.2', '7.5', '8.1', '9.1', '9.2', '9.3', '10.2']);

/** Exclusion justifications that say nothing (BR-03 phrase list of the sample). */
const EMPTY_PHRASES = new Set(['-', 'n/a', 'na', 'none', 'not applicable', 'not relevant', 'tidak berlaku', 'tidak ada', 'tidak relevan']);

const BR02: [string, string] = [
  'Link this applicable entry to at least one risk. Until it is, the entry cannot be verified and blocks the checkpoint.',
  'Tautkan entri yang berlaku ini ke setidaknya satu risiko. Sampai ditautkan, entri tidak dapat diverifikasi dan memblokir checkpoint.',
];
const BR03: [string, string] = [
  'The exclusion justification does not look meaningful. Explain why this does not apply.',
  'Justifikasi pengecualian tampaknya tidak bermakna. Jelaskan mengapa ini tidak berlaku.',
];

/** BR-03 of the sample: a short justification or one from the phrase list. */
export function emptyJustification(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  return t.length < 15 || EMPTY_PHRASES.has(t);
}

type Sample = Pick<DataSource, 'mutate' | 'insert'>;

function reqsOf(D: ControllerData | null, ms: MsId): Requirement[] {
  return (D?.bundles?.[ms]?.reqs ?? []) as Requirement[];
}

function unitOf(D: ControllerData | null, ms: MsId): 'ctrl' | 'req' {
  return D?.MS?.find((m) => m.id === ms)?.unit === 'ctrl' ? 'ctrl' : 'req';
}

/** The targets of a sample system: its entries, plus the ISO/IEC 27001 clause rows a catalogue system has not added. */
export function sampleTargets(D: ControllerData | null, ms: MsId): TargetItem[] {
  const reqs = reqsOf(D, ms);
  const catalogue = unitOf(D, ms) === 'ctrl';
  const out: TargetItem[] = reqs.map((c) => {
    const { targetType, code } = targetOfEntry(c);
    const group = code.replace(/^A\./, '').split('.')[0] ?? null;
    return {
      kind: targetType,
      code,
      title: c.title,
      clauseGroup: targetType === 'requirement' ? group : null,
      hasEntry: true,
      retired: Boolean((c as Requirement & { retired?: boolean }).retired),
      // Clause rows always apply in a catalogue system (D2-09); in a requirement standard the operation rows of clause 8
      // may be excluded.
      assessable: targetType === 'catalogue_item' || (!catalogue && group === '8'),
      documentedInfo: targetType === 'requirement' && DOCUMENTED_CLAUSES.has(code.split('.').slice(0, 2).join('.')),
    };
  });
  if (catalogue) {
    for (const [code, title, documented] of ISMS_CLAUSES) {
      if (out.some((t) => t.kind === 'requirement' && t.code === code)) continue;
      out.push({ kind: 'requirement', code, title, clauseGroup: code.split('.')[0], hasEntry: false, retired: false, assessable: false, documentedInfo: documented });
    }
  }
  return out;
}

const done = (res: CommandResult | undefined, warnings: Warn[] = []): Result<Outcome> => {
  if (!res) return refusal(0, TEXT.notFound);
  if (!res.ok) return { ok: false, error: { status: res.error?.status ?? 422, message: res.error?.message ?? [TEXT.notFound[0], TEXT.notFound[1]] } };
  return { ok: true, data: { changed: res.changed, warnings } };
};

export function createSampleAdapter(getD: () => ControllerData | null, ds: Sample | null): ControlsAdapter {
  const mutate = async (ms: MsId, id: string, patch: Record<string, unknown>, warnings: Warn[] = []) => {
    if (!ds?.mutate) return refusal(0, TEXT.notFound);
    return done(await ds.mutate(ms, 'req', id, patch), warnings);
  };
  const find = (ms: MsId, id: string) => reqsOf(getD(), ms).find((c) => c.id === id) ?? null;

  return {
    async targets(ms) {
      return { ok: true, data: sampleTargets(getD(), ms) };
    },
    async create(ms, body) {
      const D = getD();
      const target = sampleTargets(D, ms).find((t) => t.kind === body.targetType && t.code === body.code);
      if (!target || target.hasEntry) return refusal(409, TEXT.sampleNoTarget);
      if (!body.isApplicable && !target.assessable) return refusal(422, TEXT.alwaysApplicableReason, 'APPL-ASSESS');
      const catalogue = unitOf(D, ms) === 'ctrl';
      const system = D?.MS?.find((m) => m.id === ms);
      const theme = body.targetType === 'catalogue_item'
        ? `A.${body.code.replace(/^A\./, '').split('.')[0]} ${system?.theme?.[Number(body.code.replace(/^A\./, '').split('.')[0])] ?? ''}`.trim()
        : `Clause ${body.code.split('.')[0]}`;
      // BR-02: a new applicable entry of a catalogue system without a risk holds the gate, with a warning.
      const holds = catalogue && body.isApplicable;
      const row: Requirement = {
        id: entryIdOf(body.targetType, body.code),
        key: body.targetType === 'catalogue_item' ? body.code.replace(/^A\./, '') : catalogue ? `cl-${body.code}` : body.code,
        title: target.title,
        theme,
        st: body.isApplicable ? (holds ? 'blocked' : 'ns') : 'na',
        owner: body.ownerHandle,
        doc: '',
        freq: body.frequencyCode as Requirement['freq'],
        note: holds ? BR02[0] : '',
        gate: holds,
        just: (body.isApplicable ? body.inclusionJustification : body.exclusionJustification) ?? '',
        risks: [],
      };
      if (!ds?.insert) return refusal(0, TEXT.notFound);
      const warnings: Warn[] = holds ? [{ rule: 'BR-02', message: BR02 }] : [];
      if (!body.isApplicable && emptyJustification(row.just)) warnings.push({ rule: 'BR-03', message: BR03 });
      return done(await ds.insert(ms, 'req', row as unknown as Record<string, unknown>), warnings);
    },
    async update(entry, patch) {
      const current = find(entry.ms, entry.id);
      if (!current) return refusal(404, TEXT.notFound);
      const next: Record<string, unknown> = {};
      const applies = patch.isApplicable ?? current.st !== 'na';
      if (patch.isApplicable === false) {
        const assessable = sampleTargets(getD(), entry.ms).find((t) => entryIdOf(t.kind, t.code) === entry.id)?.assessable ?? true;
        if (!assessable) return refusal(422, TEXT.alwaysApplicableReason, 'APPL-ASSESS');
        next.st = 'na';
      } else if (patch.isApplicable === true && current.st === 'na') next.st = 'ns';
      if (applies && patch.inclusionJustification !== undefined) next.just = patch.inclusionJustification ?? '';
      if (!applies && patch.exclusionJustification !== undefined) next.just = patch.exclusionJustification ?? '';
      if (patch.ownerHandle !== undefined) next.owner = patch.ownerHandle;
      if (patch.holdsGate !== undefined) next.gate = patch.holdsGate;
      if (patch.statusNote !== undefined) next.note = patch.statusNote ?? '';
      if (patch.riskCodes !== undefined) next.risks = [...patch.riskCodes];
      if (patch.documentCodes !== undefined) next.doc = patch.documentCodes[0] ?? '';
      const risks = (next.risks as string[] | undefined) ?? current.risks ?? [];
      if ((patch.isApplicable !== undefined || patch.riskCodes !== undefined) && unitOf(getD(), entry.ms) === 'ctrl' && applies && !risks.length) {
        return refusal(422, BR02, 'BR-02');
      }
      const warnings: Warn[] = patch.exclusionJustification && emptyJustification(patch.exclusionJustification) ? [{ rule: 'BR-03', message: BR03 }] : [];
      return mutate(entry.ms, entry.id, next, warnings);
    },
    async criteria(entry, body) {
      if (!find(entry.ms, entry.id)) return refusal(404, TEXT.notFound);
      return mutate(entry.ms, entry.id, { freq: body.frequencyCode });
    },
    async transition(entry, body) {
      const current = find(entry.ms, entry.id);
      if (!current) return refusal(404, TEXT.notFound);
      if (body.to === 'not_applicable') {
        const assessable = sampleTargets(getD(), entry.ms).find((t) => entryIdOf(t.kind, t.code) === entry.id)?.assessable ?? true;
        if (!assessable) return refusal(422, TEXT.alwaysApplicableReason, 'APPL-ASSESS');
        const just = body.exclusionJustification ?? '';
        const warnings: Warn[] = emptyJustification(just) ? [{ rule: 'BR-03', message: BR03 }] : [];
        return mutate(entry.ms, entry.id, { st: 'na', just }, warnings);
      }
      if (body.to === 'partially_implemented') {
        if (current.st !== 'complete') return refusal(409, TEXT.rejectOnlyComplete);
        return mutate(entry.ms, entry.id, { st: 'partial', by: null, ...(filled(body.reason) ? { note: body.reason } : {}) });
      }
      return refusal(422, TEXT.notFound);
    },
    async remove() {
      return refusal(422, TEXT.sampleNoDelete);
    },
    async risks(ms) {
      const D = getD();
      const listed = ((D?.X?.[ms]?.risk ?? []) as { id: string; t: string }[]).map((r): RiskChoice => ({ code: r.id, title: r.t }));
      const titles = (D?.TITLES ?? {}) as Record<string, string>;
      for (const c of reqsOf(D, ms)) {
        for (const code of c.risks ?? []) if (!listed.some((r) => r.code === code)) listed.push({ code, title: titles[code] ?? '' });
      }
      return { ok: true, data: listed.sort((a, b) => a.code.localeCompare(b.code)) };
    },
    async documents(ms) {
      const D = getD();
      const reqs = reqsOf(D, ms);
      const docs = (D?.bundles?.[ms]?.docs ?? []).map((d): DocChoice => ({ code: d.id, title: d.title, implements: reqs.filter((c) => c.doc === d.id).map((c) => c.id) }));
      return { ok: true, data: docs };
    },
  };
}
