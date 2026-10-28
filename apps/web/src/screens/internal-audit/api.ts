// API adapter of the Internal audit screen (MILESTONE-2 M2-14): the cycles with their internal audits
// (`ms.cycles.list`, which carries the scope text and report of each audit, M2-05 follow-up 8), the programme coverage,
// planning (`audit-events.create` with type internal_audit), the audit detail (`readmodel.surveillance.event`), its
// activities, the report and outcome (`audit-events.update`), and a new record document from a file
// (`documents.create`, then `documents.versions`), through the host's client (R-17). The report's code and title come
// from the documents of the snapshot, which the scope policy filters.
import type {
  AuditActivityItem, CertificationCycleItem, CommandResult, InternalAuditProgramme, SurveillanceEvent, ApplicabilityTargetItem,
} from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import type { ControllerData, MsId } from '../../data/types';
import { call } from '../api';
import { fromTarget } from '../findings/api';
import { outcomeOf } from '../findings/shared';
import type { ActivityModel, AuditDetail, CycleModel, InternalAuditAdapter, Programme, RecordOption } from './model';
import { ROUTES } from './routes';

export function fromCycle(item: CertificationCycleItem): CycleModel {
  return {
    id: item.id,
    status: item.status,
    cycleStart: item.cycleStart,
    cycleEnd: item.cycleEnd,
    audits: item.events
      .filter((e) => e.eventType === 'internal_audit')
      .map((e) => ({ id: e.id, shortLabel: e.shortLabel, scheduledAt: e.scheduledAt, scopeText: e.scopeText, reportDocumentId: e.reportDocumentId }))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.shortLabel.localeCompare(b.shortLabel)),
  };
}

export function fromProgramme(p: InternalAuditProgramme): Programme {
  return {
    cycle: p.cycle ? { ...p.cycle } : null,
    rows: p.rows.map((r) => ({ code: r.code, title: r.title, kind: r.kind, clauseGroup: r.clauseGroup, covered: r.covered, audits: r.audits.map((a) => ({ ...a })) })),
  };
}

export function fromEvent(e: SurveillanceEvent): AuditDetail {
  return {
    id: e.id,
    name: e.name,
    shortLabel: e.shortLabel,
    scheduledAt: e.scheduledAt,
    auditDays: e.auditDays,
    leadAuditor: e.leadAuditor,
    outcomeSummary: e.outcomeSummary,
    findings: e.findings.map((f) => ({ id: f.ref.id, code: f.code, classification: f.classification, clause: f.clause, title: f.title, status: f.status })),
  };
}

export function fromActivity(a: AuditActivityItem): ActivityModel {
  return {
    id: a.ref.id,
    code: a.templateCode ?? a.ref.code,
    templateCode: a.templateCode,
    title: a.title,
    clauseRef: a.clauseRef,
    keyQuestions: a.keyQuestions,
    evidenceToRequest: a.evidenceToRequest,
    auditee: a.auditee,
    auditor: a.auditor ?? null,
    targetCode: a.targetCode ?? null,
    scheduledAt: a.scheduledAt,
    status: a.status,
    note: a.note,
  };
}

/** True for a document of type record: the snapshot gives the English label of the doc type as its tier. */
export const isRecordTier = (tier: string | null | undefined): boolean => /^record/i.test(String(tier ?? '').trim());

/** The documents of type record of a system in the snapshot, with their uuid from the snapshot's refs. */
export function snapshotRecords(D: ControllerData | null, ms: MsId): RecordOption[] {
  const refs = (D as unknown as { refs?: Record<string, { id: string }> } | null)?.refs ?? {};
  return (D?.bundles?.[ms]?.docs ?? [])
    .filter((d) => isRecordTier(d.tier))
    .map((d) => ({ id: refs[`${ms}:doc:${d.id}`]?.id ?? '', code: d.id, title: d.title }))
    .filter((r) => r.id);
}

export function createApiAdapter(client: ApiClient | null, getD: () => ControllerData | null): InternalAuditAdapter {
  return {
    sample: false,
    async cycles(ms) {
      const res = await call<CertificationCycleItem[]>(client, ROUTES.cycles, { params: { ms } });
      return res.ok ? { ok: true, data: res.data.map(fromCycle) } : { ok: false, error: res.error };
    },
    async programme(ms, cycleId) {
      const res = await call<InternalAuditProgramme>(client, ROUTES.programme, { params: { ms }, query: cycleId ? { cycle: cycleId } : {} });
      return res.ok ? { ok: true, data: fromProgramme(res.data) } : { ok: false, error: res.error };
    },
    async plan(ms, body, idempotencyKey) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.eventCreate, { params: { ms }, body, idempotencyKey }));
    },
    async detail(ms, eventId) {
      const res = await call<SurveillanceEvent>(client, ROUTES.eventDetail, { params: { ms, id: eventId } });
      return res.ok ? { ok: true, data: fromEvent(res.data) } : { ok: false, error: res.error };
    },
    async activities(ms, eventId) {
      const res = await call<AuditActivityItem[]>(client, ROUTES.activities, { params: { ms, id: eventId } });
      return res.ok ? { ok: true, data: res.data.map(fromActivity) } : { ok: false, error: res.error };
    },
    async generate(ms, eventId) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.activitiesGenerate, { params: { ms, id: eventId } }));
    },
    async updateActivity(ms, activity, patch) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.activityUpdate, { params: { ms, id: activity.id }, body: patch }));
    },
    async updateEvent(ms, eventId, patch) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.eventUpdate, { params: { ms, id: eventId }, body: patch }));
    },
    async records(ms) {
      return { ok: true, data: snapshotRecords(getD(), ms) };
    },
    async registerRecord(ms, body, idempotencyKey) {
      const res = outcomeOf(await call<CommandResult>(client, ROUTES.documentCreate, {
        params: { ms },
        body: { docCode: body.code, title: body.title, docType: 'record', ownerHandle: body.owner, classification: 'internal', orgWide: false, linkedMs: [ms] },
        idempotencyKey,
      }));
      if (!res.ok) return res;
      const id = res.data.ref?.id;
      if (!id) return { ok: false, error: { status: 0, message: ['The record was registered without an id.', 'Rekaman didaftarkan tanpa id.'] } };
      return { ok: true, data: { id, code: body.code, title: body.title } };
    },
    async addFile(ms, record, file) {
      const body = file.source === 'link'
        ? { source: 'link', repository: file.repository, externalItemId: file.externalItemId }
        : { source: 'upload', uploadIntentId: file.uploadIntentId };
      return outcomeOf(await call<CommandResult>(client, ROUTES.documentVersion, { params: { ms, id: record.id }, body }));
    },
    async targets(ms) {
      const res = await call<ApplicabilityTargetItem[]>(client, ROUTES.targets, { params: { ms } });
      return res.ok ? { ok: true, data: res.data.filter((t) => !t.retired).map(fromTarget) } : { ok: false, error: res.error };
    },
  };
}
