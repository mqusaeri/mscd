// Sample adapter of "Findings and actions" (MILESTONE-2 M2-14, C.6): the findings, corrective actions and
// self-assessment of the selected sample organisation (sample-store.ts), with the rules the api applies: a unique code
// per system, BR-06 and BR-07 (a major finding closes with its root cause and systemic check), BR-08 (a nonconformity
// closes with a closed and effective corrective action, checked on another day than the implementation), BR-09 (the
// implementer and the owner never check their own action), the close note of OFI, signals and "not a finding", the
// reason of a reopen, one step at a time with its text, and a gap with an owner and a target date. Loaded only by the
// sample build (adapter.ts), so the api build holds none of it.
import type { ControllerData, MsId } from '../../data/types';
import type { TextPair } from '../types';
import type { ActionModel, FindingModel, FindingsAdapter, SelfRow } from './model';
import { CA_STEPS, NEEDS_ACTION } from './model';
import type { OrgState, SampleAction, SampleFinding } from './sample-store';
import { findingsOf, nextSampleId, orgState, sampleTargets } from './sample-store';
import type { Outcome, Result } from './shared';
import { filled, nextCode, refusal } from './shared';

export { resetSampleAudit } from './sample-store';

export interface SampleScope {
  getD(): ControllerData | null;
  org(): string | null;
  me(): string;
}

/** Rule texts of the api (apps/server/src/modules/rules/messages.ts), so the sample shows the same messages. */
export const RULE_TEXT: Readonly<Record<string, TextPair>> = {
  'BR-06': ['A major finding cannot be closed without a root cause analysis.', 'Temuan mayor tidak dapat ditutup tanpa analisis akar masalah.'],
  'BR-07': ['A major finding cannot be closed without a systemic check.', 'Temuan mayor tidak dapat ditutup tanpa pemeriksaan sistemik.'],
  'BR-08': [
    'The finding needs a closed and effective corrective action, and the effectiveness verification must be dated differently from the implementation.',
    'Temuan memerlukan tindakan korektif yang sudah ditutup dan efektif, dan verifikasi efektivitas harus bertanggal berbeda dari tanggal penerapan.',
  ],
  'BR-09': ['A corrective action cannot be verified by its implementer or its owner.', 'Tindakan korektif tidak dapat diverifikasi oleh pelaksana atau pemiliknya.'],
};

export const ruleRefusal = (rule: string) => refusal(422, RULE_TEXT[rule], { rule, slug: 'business-rule' });
const duplicate = (code: string) => refusal(409, [`${code} already exists`, `${code} sudah ada`], { slug: 'conflict' });
const notFound = () => refusal(404, ['Record not found', 'Rekaman tidak ditemukan'], { slug: 'not-found' });
const fieldError = (path: string, message: TextPair) => refusal(400, ['The request is not valid', 'Permintaan tidak valid'], { slug: 'validation', errors: [{ path: `body.${path}`, message: message[0] }] });

const done = (ms: MsId, extra: Partial<Outcome> = {}): Result<Outcome> => ({ ok: true, data: { changed: [ms], warnings: [], ...extra } });

function present(f: SampleFinding): FindingModel {
  const { ms: _ms, closeNote: _note, ...rest } = f;
  return { ...rest, actions: rest.actions.map((a) => ({ ...a })) };
}

function presentAction(a: SampleAction): ActionModel {
  const { ms: _ms, ...rest } = a;
  return { ...rest, findings: rest.findings.map((f) => ({ ...f })) };
}

/** True when a live corrective action of the finding is closed, effective and checked on another day (BR-08). */
function hasEffectiveAction(state: OrgState, findingId: string): boolean {
  return state.actions.some((a) => a.findings.some((f) => f.id === findingId) && a.status === 'closed' && a.effective === true && a.verifiedAt !== null && a.verifiedAt !== a.implementedAt);
}

export function createSampleAdapter(scope: SampleScope): FindingsAdapter {
  const state = () => orgState(scope.getD(), scope.org());
  const today = () => scope.getD()?.TODAY_S ?? new Date().toISOString().slice(0, 10);
  const finding = (ms: MsId, id: string) => state().findings.find((f) => f.ms === ms && f.id === id);
  const action = (ms: MsId, id: string) => state().actions.find((a) => a.ms === ms && a.id === id);
  return {
    sample: true,
    async findings(ms, query = {}) {
      const rows = findingsOf(state(), ms).filter((f) => !query.targetCode || f.targetCode === query.targetCode);
      return { ok: true, data: rows.map(present) };
    },
    async raise(ms, body) {
      const s = state();
      if (s.findings.some((f) => f.ms === ms && f.code === body.code)) return duplicate(body.code);
      const event = body.auditEventId ? s.events.find((e) => e.ms === ms && e.id === body.auditEventId) : null;
      if (body.auditEventId && !event) return notFound();
      const row: SampleFinding = {
        id: nextSampleId('finding'), ms, code: body.code, title: body.title, classification: body.classification, source: body.source,
        clauseRef: body.clauseRef ?? null, targetCode: body.targetCode ?? null, status: 'open', owner: body.ownerHandle, raisedAt: today(), dueAt: body.dueAt ?? null,
        auditEvent: event ? { id: event.id, shortLabel: event.shortLabel } : null, actions: [], etag: null, rcaText: null, systemicCheckText: null, statusNote: null, closeNote: null,
      };
      s.findings.push(row);
      return done(ms, { ref: { id: row.id, code: row.code } });
    },
    async update(ms, f, patch) {
      const row = finding(ms, f.id);
      if (!row) return notFound();
      const next = { ...row };
      if (patch.title !== undefined) next.title = patch.title;
      if (patch.classification !== undefined) next.classification = patch.classification;
      if (patch.clauseRef !== undefined) next.clauseRef = patch.clauseRef;
      if (patch.targetCode !== undefined) next.targetCode = patch.targetCode;
      if (patch.ownerHandle !== undefined) next.owner = patch.ownerHandle;
      if (patch.dueAt !== undefined) next.dueAt = patch.dueAt;
      if (patch.rcaText !== undefined) next.rcaText = patch.rcaText;
      if (patch.systemicCheckText !== undefined) next.systemicCheckText = patch.systemicCheckText;
      if (next.status === 'closed' && next.classification === 'major') {
        if (!filled(next.rcaText)) return ruleRefusal('BR-06');
        if (!filled(next.systemicCheckText)) return ruleRefusal('BR-07');
      }
      Object.assign(row, next);
      return done(ms, { ref: { id: row.id, code: row.code } });
    },
    async move(ms, f, body) {
      const s = state();
      const row = finding(ms, f.id);
      if (!row) return notFound();
      if (body.to === 'closed') {
        if (row.status === 'closed') return refusal(409, ['This finding is already closed', 'Temuan ini sudah ditutup'], { slug: 'transition-not-allowed' });
        if (row.classification === 'major' && !filled(row.rcaText)) return ruleRefusal('BR-06');
        if (row.classification === 'major' && !filled(row.systemicCheckText)) return ruleRefusal('BR-07');
        if (NEEDS_ACTION.has(row.classification) && !hasEffectiveAction(s, row.id)) return ruleRefusal('BR-08');
        if (!NEEDS_ACTION.has(row.classification) && !filled(body.note)) {
          return fieldError('note', [`A ${row.classification} finding closes with a close note`, `Temuan ${row.classification} ditutup dengan catatan penutupan`]);
        }
        Object.assign(row, { status: 'closed', closeNote: body.note ?? null });
      } else if (row.status === 'closed') {
        if (!filled(body.note)) return fieldError('note', ['Required for closed to in_progress', 'Wajib untuk membuka kembali']);
        Object.assign(row, { status: 'in_progress', closeNote: null, statusNote: body.note });
      } else {
        if (row.status !== 'open') return refusal(409, ['This move is not allowed', 'Perpindahan ini tidak diizinkan'], { slug: 'transition-not-allowed' });
        Object.assign(row, { status: 'in_progress', ...(body.note ? { statusNote: body.note } : {}) });
      }
      return done(ms, { ref: { id: row.id, code: row.code } });
    },
    async actions(ms) {
      return { ok: true, data: state().actions.filter((a) => a.ms === ms).map(presentAction) };
    },
    async createAction(ms, body) {
      const s = state();
      if (s.actions.some((a) => a.ms === ms && a.code === body.code)) return duplicate(body.code);
      const linked = body.findingIds.map((id) => finding(ms, id));
      if (linked.some((f) => !f)) return notFound();
      const row: SampleAction = {
        id: nextSampleId('action'), ms, code: body.code, title: body.title, status: 'correction', owner: body.ownerHandle, dueAt: body.dueAt ?? null,
        correctionText: null, rcaText: null, systemicCheckText: null, actionText: null, implementedAt: null, implementedBy: null, verifiedAt: null,
        verifiedBy: null, effective: null, findings: linked.map((f) => ({ id: f!.id, code: f!.code })), etag: null,
      };
      s.actions.push(row);
      return done(ms, { ref: { id: row.id, code: row.code } });
    },
    async updateAction(ms, a, patch) {
      const row = action(ms, a.id);
      if (!row) return notFound();
      if (patch.ownerHandle !== undefined && row.verifiedBy && patch.ownerHandle === row.verifiedBy) return ruleRefusal('BR-09');
      if (patch.findingIds !== undefined) {
        if (row.status === 'closed' || row.status === 'cancelled') {
          return refusal(422, [`The findings of a ${row.status} corrective action cannot change`, `Temuan dari tindakan korektif berstatus ${row.status} tidak dapat diubah`]);
        }
        const linked = patch.findingIds.map((id) => finding(ms, id));
        if (linked.some((f) => !f)) return notFound();
        row.findings = linked.map((f) => ({ id: f!.id, code: f!.code }));
      }
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.ownerHandle !== undefined) row.owner = patch.ownerHandle;
      if (patch.dueAt !== undefined) row.dueAt = patch.dueAt;
      return done(ms, { ref: { id: row.id, code: row.code } });
    },
    async moveAction(ms, a, body) {
      const row = action(ms, a.id);
      if (!row) return notFound();
      const me = scope.me();
      if (body.to === 'cancelled') {
        if (row.status === 'closed' || row.status === 'cancelled') return refusal(409, ['This move is not allowed', 'Perpindahan ini tidak diizinkan'], { slug: 'transition-not-allowed' });
        if (!filled(body.note)) return fieldError('note', ['Required to cancel', 'Wajib untuk membatalkan']);
        row.status = 'cancelled';
        return done(ms, { ref: { id: row.id, code: row.code } });
      }
      if (row.status === 'effectiveness_verification') {
        if (body.effective === undefined) return fieldError('effective', ['Required for the effectiveness check', 'Wajib untuk pemeriksaan efektivitas']);
        if (me === row.implementedBy || me === row.owner) return ruleRefusal('BR-09');
        if (body.effective) {
          if (row.implementedAt === today()) return ruleRefusal('BR-08');
          Object.assign(row, { status: 'closed', verifiedBy: me, verifiedAt: today(), effective: true });
          return done(ms, { ref: { id: row.id, code: row.code } });
        }
        Object.assign(row, { status: 'action', effective: false });
        return done(ms, {
          ref: { id: row.id, code: row.code },
          message: ['Not effective: the corrective action returns to the action step', 'Tidak efektif: tindakan korektif kembali ke langkah tindakan'],
        });
      }
      const step = CA_STEPS.find((s) => s.status === row.status);
      if (!step || step.next !== body.to) return refusal(409, ['This move is not allowed', 'Perpindahan ini tidak diizinkan'], { slug: 'transition-not-allowed' });
      if (!filled(body.text)) return fieldError('text', [`Required for ${row.status} to ${body.to}`, `Wajib untuk ${row.status} ke ${body.to}`]);
      row[step.field] = body.text!.trim();
      row.status = step.next;
      if (step.next === 'effectiveness_verification') Object.assign(row, { implementedBy: me, implementedAt: today() });
      return done(ms, { ref: { id: row.id, code: row.code } });
    },
    async selfAssessment(ms) {
      const s = state();
      return {
        ok: true,
        data: s.self.filter((r) => r.ms === ms).map(({ ms: _ms, ...row }): SelfRow => ({ ...row, evidence: [...row.evidence] })),
      };
    },
    async assess(ms, r, body) {
      const row = state().self.find((x) => x.ms === ms && x.conditionCode === r.conditionCode);
      if (!row) return notFound();
      if (body.status === 'gap' && (!body.ownerHandle || !body.targetFixAt)) {
        return refusal(422, ['A gap needs an owner and a target date', 'Kesenjangan memerlukan pemilik dan tanggal target']);
      }
      const evs = new Set((scope.getD()?.bundles?.[ms]?.evs ?? []).map((e) => e.code));
      const unknown = body.evidenceCodes.filter((c) => !evs.has(c));
      if (unknown.length) return refusal(422, [`Unknown evidence of this system: ${unknown.join(', ')}`, `Bukti tidak dikenal pada sistem ini: ${unknown.join(', ')}`]);
      Object.assign(row, {
        id: row.id ?? nextSampleId('self'), status: body.status, owner: body.ownerHandle ?? null, targetFixAt: body.status === 'gap' ? body.targetFixAt ?? null : null,
        note: body.note ?? null, assessedAt: today(), evidence: [...body.evidenceCodes],
      });
      return done(ms);
    },
    async raiseFromGap(ms, r, body) {
      const s = state();
      const row = s.self.find((x) => x.ms === ms && x.conditionCode === r.conditionCode);
      if (!row || !row.id) return notFound();
      if (row.findingCode) return refusal(409, [`Finding ${row.findingCode} was already raised from ${row.conditionCode}`, `Temuan ${row.findingCode} sudah dicatat dari ${row.conditionCode}`]);
      if (row.status !== 'gap') return refusal(422, ['A finding is raised from a gap only', 'Temuan hanya dapat diajukan dari kesenjangan']);
      const year = today().slice(0, 4);
      const code = nextCode('SA', year, s.findings.filter((f) => f.ms === ms).map((f) => f.code));
      s.findings.push({
        id: nextSampleId('finding'), ms, code, title: body.title?.trim() || row.text, classification: body.classification, source: 'self_assessment',
        clauseRef: row.requirementCode, targetCode: row.requirementCode && sampleTargets(scope.getD(), ms).some((t) => t.code === row.requirementCode) ? row.requirementCode : null,
        status: 'open', owner: row.owner ?? 'none', raisedAt: today(), dueAt: row.targetFixAt, auditEvent: null, actions: [], etag: null,
        rcaText: null, systemicCheckText: null, statusNote: null, closeNote: null,
      });
      row.findingCode = code;
      return done(ms, { ref: { id: code, code } });
    },
    async targets(ms) {
      return { ok: true, data: sampleTargets(scope.getD(), ms) };
    },
    async events(ms) {
      const rows = state().events.filter((e) => e.ms === ms).sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
      return { ok: true, data: rows.map((e) => ({ id: e.id, shortLabel: e.shortLabel, scheduledAt: e.scheduledAt, eventType: e.eventType })) };
    },
  };
}
