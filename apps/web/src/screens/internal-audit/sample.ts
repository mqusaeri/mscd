// Sample adapter of the Internal audit screen (MILESTONE-2 M2-14, C.6): the cycles, internal audits, activities and
// report records of the selected sample organisation (findings/sample-store.ts, shared with the findings screen, so a
// finding raised from an audit shows there too), with the programme coverage computed as the api does it, the
// activity templates of the sample, and the AUD-INDEP warning when the auditor owns work of the clause or control.
// Loaded only by the sample build (adapter.ts), so the api build holds none of it.
import type { ControllerData, MsId } from '../../data/types';
import type { Outcome, Result } from '../findings/shared';
import { refusal } from '../findings/shared';
import type { SampleActivity } from '../findings/sample-store';
import {
  ISMS_CLAUSES, applicableControls, findingsOf, internalAuditTemplates, nextSampleId, orgState, sampleTargets,
} from '../findings/sample-store';
import type { ActivityModel, CycleModel, InternalAuditAdapter, Programme, ProgrammeRow } from './model';
import { covers } from './model';

export { resetSampleAudit } from '../findings/sample-store';

export interface SampleScope {
  getD(): ControllerData | null;
  org(): string | null;
  me(): string;
  lang(): 'en' | 'id';
}

const notFound = () => refusal(404, ['Record not found', 'Rekaman tidak ditemukan'], { slug: 'not-found' });
const done = (ms: MsId, extra: Partial<Outcome> = {}): Result<Outcome> => ({ ok: true, data: { changed: [ms], warnings: [], ...extra } });

function present(a: SampleActivity): ActivityModel {
  return {
    id: a.id, code: a.templateCode ?? a.title, templateCode: a.templateCode, title: a.title, clauseRef: a.clauseRef, keyQuestions: a.keyQuestions,
    evidenceToRequest: a.evidenceToRequest, auditee: a.auditee, auditor: a.auditor, targetCode: a.targetCode, scheduledAt: a.scheduledAt, status: a.status, note: a.note,
  };
}

/** The AUD-INDEP warning (apps/server/src/modules/rules/messages.ts) with the auditor's name and the target. */
export function audIndep(auditor: string, target: string): Outcome['warnings'][number] {
  return {
    rule: 'AUD-INDEP',
    message: [
      `${auditor} owns an entry, document or evidence of ${target}. An auditor should not audit their own work.`,
      `${auditor} memiliki entri, dokumen, atau bukti dari ${target}. Auditor sebaiknya tidak mengaudit pekerjaannya sendiri.`,
    ],
  };
}

/** True when the person owns the entry of the target (or of its sub-clauses), a document that implements it, or its evidence. */
export function ownsWorkOf(D: ControllerData | null, ms: MsId, person: string, target: string): boolean {
  const bundle = D?.bundles?.[ms];
  if (!bundle) return false;
  const code = (id: string) => id.replace(/^Cl\.\s*/, '');
  const entries = bundle.reqs.filter((r) => code(r.id) === target || code(r.id).startsWith(`${target}.`));
  if (entries.some((r) => r.owner === person)) return true;
  if (entries.some((r) => bundle.docs.some((d) => d.id === r.doc && d.owner === person))) return true;
  return bundle.evs.some((e) => entries.some((r) => r.id === e.ctrl) && e.owner === person);
}

export function createSampleAdapter(scope: SampleScope): InternalAuditAdapter {
  const state = () => orgState(scope.getD(), scope.org());
  const event = (ms: MsId, id: string) => state().events.find((e) => e.ms === ms && e.id === id);
  return {
    sample: true,
    async cycles(ms) {
      const s = state();
      const cycles: CycleModel[] = s.cycles.filter((c) => c.ms === ms).map((c) => ({
        id: c.id,
        status: c.status,
        cycleStart: c.cycleStart,
        cycleEnd: c.cycleEnd,
        audits: s.events
          .filter((e) => e.ms === ms && e.eventType === 'internal_audit' && e.cycleId === c.id)
          .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
          .map((e) => ({ id: e.id, shortLabel: e.shortLabel, scheduledAt: e.scheduledAt, scopeText: e.scopeText, reportDocumentId: e.reportDocumentId })),
      }));
      return { ok: true, data: cycles };
    },
    async programme(ms, cycleId) {
      const s = state();
      const D = scope.getD();
      const cycle = s.cycles.find((c) => c.ms === ms && (cycleId ? c.id === cycleId : true)) ?? null;
      if (cycleId && !cycle) return notFound();
      const clauses = ms === 'isms'
        ? ISMS_CLAUSES.map(([code, title]) => ({ code, title }))
        : sampleTargets(D, ms).filter((t) => t.kind === 'requirement').map((t) => ({ code: t.code, title: t.title }));
      const audits = cycle ? s.events.filter((e) => e.ms === ms && e.eventType === 'internal_audit' && e.cycleId === cycle.id) : [];
      const active = s.activities.filter((a) => a.ms === ms && a.status !== 'cancelled' && audits.some((e) => e.id === a.eventId));
      const row = (code: string, title: string, kind: 'clause' | 'control'): ProgrammeRow => {
        const hits = audits
          .map((e) => ({ e, n: active.filter((a) => a.eventId === e.id && covers(a.targetCode ?? a.clauseRef ?? '', code, kind)).length }))
          .filter((x) => x.n > 0)
          .map(({ e, n }) => ({ eventId: e.id, shortLabel: e.shortLabel, scheduledAt: e.scheduledAt, activities: n }));
        return { code, title, kind, clauseGroup: kind === 'clause' ? code.split('.')[0] : null, covered: hits.length > 0, audits: hits };
      };
      const data: Programme = {
        cycle: cycle ? { id: cycle.id, cycleStart: cycle.cycleStart, cycleEnd: cycle.cycleEnd } : null,
        rows: [...clauses.map((c) => row(c.code, c.title, 'clause')), ...applicableControls(D, ms).map((c) => row(c.code, c.title, 'control'))],
      };
      return { ok: true, data };
    },
    async plan(ms, body) {
      const s = state();
      const cycle = s.cycles.find((c) => c.ms === ms && (c.status === 'active' || c.status === 'planned' || c.status === 'certified')) ?? null;
      const id = nextSampleId('audit');
      s.events.push({
        id, ms, cycleId: cycle?.id ?? null, eventType: 'internal_audit', nameEn: body.nameEn, nameId: body.nameId, shortLabel: body.shortLabel,
        scheduledAt: body.scheduledAt, auditDays: body.auditDays ?? null, leadAuditor: body.leadAuditorName ?? null, scopeText: body.scopeText ?? null,
        reportDocumentId: null, outcomeSummary: null,
      });
      return done(ms, { ref: { id, code: body.shortLabel } });
    },
    async detail(ms, eventId) {
      const e = event(ms, eventId);
      if (!e) return notFound();
      const findings = findingsOf(state(), ms).filter((f) => f.auditEvent?.id === e.id);
      return {
        ok: true,
        data: {
          id: e.id, name: scope.lang() === 'id' ? e.nameId : e.nameEn, shortLabel: e.shortLabel, scheduledAt: e.scheduledAt, auditDays: e.auditDays,
          leadAuditor: e.leadAuditor, outcomeSummary: e.outcomeSummary,
          findings: findings.map((f) => ({ id: f.id, code: f.code, classification: f.classification, clause: f.clauseRef, title: f.title, status: f.status })),
        },
      };
    },
    async activities(ms, eventId) {
      if (!event(ms, eventId)) return notFound();
      return { ok: true, data: state().activities.filter((a) => a.ms === ms && a.eventId === eventId).map(present) };
    },
    async generate(ms, eventId) {
      const s = state();
      const e = event(ms, eventId);
      if (!e) return notFound();
      const have = new Set(s.activities.filter((a) => a.eventId === eventId).map((a) => a.templateCode));
      const created = internalAuditTemplates(ms).filter((t) => !have.has(t.code));
      for (const t of created) {
        s.activities.push({
          id: nextSampleId('activity'), ms, eventId, templateCode: t.code, title: t.title, clauseRef: t.clauseRef, keyQuestions: t.keyQuestions,
          evidenceToRequest: t.evidenceToRequest, auditee: null, auditor: null, targetCode: null, scheduledAt: e.scheduledAt, status: 'planned', note: null,
        });
      }
      return done(ms, {
        count: created.length,
        message: created.length
          ? [`${created.length} audit activities created from the templates`, `${created.length} aktivitas audit dibuat dari templat`]
          : ['Every template activity of this event already exists', 'Semua aktivitas templat untuk audit ini sudah ada'],
      });
    },
    async updateActivity(ms, activity, patch) {
      const D = scope.getD();
      const row = state().activities.find((a) => a.ms === ms && a.id === activity.id);
      if (!row) return notFound();
      if (patch.targetCode && !sampleTargets(D, ms).some((t) => t.code === patch.targetCode)) {
        return refusal(422, [`${patch.targetCode} is not a clause or control of the edition in use`, `${patch.targetCode} bukan klausul atau kontrol dari edisi yang digunakan`]);
      }
      const before = { auditor: row.auditor, targetCode: row.targetCode };
      if (patch.auditorHandle !== undefined) row.auditor = patch.auditorHandle === 'none' ? null : patch.auditorHandle;
      if (patch.targetCode !== undefined) row.targetCode = patch.targetCode;
      if (patch.scheduledAt !== undefined) row.scheduledAt = patch.scheduledAt;
      if (patch.auditeeHandle !== undefined) row.auditee = patch.auditeeHandle === 'none' ? null : patch.auditeeHandle;
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.note !== undefined) row.note = patch.note;
      const changed = before.auditor !== row.auditor || before.targetCode !== row.targetCode;
      const warnings = changed && row.auditor && row.targetCode && ownsWorkOf(D, ms, row.auditor, row.targetCode)
        ? [audIndep(D?.PEOPLE?.[row.auditor]?.[0] ?? row.auditor, row.targetCode)]
        : [];
      return done(ms, { warnings, ref: { id: row.id, code: row.templateCode ?? row.title } });
    },
    async updateEvent(ms, eventId, patch) {
      const s = state();
      const e = event(ms, eventId);
      if (!e) return notFound();
      if (patch.reportDocumentId) {
        if (!s.records.some((r) => r.ms === ms && r.id === patch.reportDocumentId)) return notFound();
        e.reportDocumentId = patch.reportDocumentId;
      } else if (patch.reportDocumentId === null) e.reportDocumentId = null;
      if (patch.outcomeSummary !== undefined) e.outcomeSummary = patch.outcomeSummary;
      return done(ms, { ref: { id: e.id, code: e.shortLabel } });
    },
    async records(ms) {
      return { ok: true, data: state().records.filter((r) => r.ms === ms).map((r) => ({ id: r.id, code: r.code, title: r.title })) };
    },
    async registerRecord(ms, body) {
      const s = state();
      const taken = s.records.some((r) => r.ms === ms && r.code === body.code) || (scope.getD()?.bundles?.[ms]?.docs ?? []).some((d) => d.id === body.code);
      if (taken) return refusal(409, [`${body.code} already exists`, `${body.code} sudah ada`], { slug: 'conflict' });
      const record = { id: nextSampleId('record'), ms, code: body.code, title: body.title };
      s.records.push(record);
      return { ok: true, data: { id: record.id, code: record.code, title: record.title } };
    },
    async addFile(ms) {
      return done(ms, { message: ['File added; the record waits for review', 'Berkas ditambahkan; rekaman menunggu tinjauan'] });
    },
    async targets(ms) {
      return { ok: true, data: sampleTargets(scope.getD(), ms) };
    },
  };
}
