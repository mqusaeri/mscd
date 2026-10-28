// API adapter of "Findings and actions" (MILESTONE-2 M2-14): the finding register, corrective actions, the
// self-assessment, the clause and control targets and the audit events of the cycles, through the host's client
// (R-17). Writes send the record's ETag as `If-Match` where the route takes one (findings and corrective actions).
//
// `FindingItem` does not carry the root cause and systemic check texts of a finding, so the web app keeps the texts
// this browser session saved (module level, per organisation and finding, shared by every adapter: the screen builds a
// new one each time it opens, and the Internal audit screen has its own) and shows them with the finding; texts the
// item carries (a later contract) win. A reload of the page forgets them.
import type {
  CertificationCycleItem, CommandResult, CorrectiveActionItem, FindingItem, Page, SelfAssessmentItem, ApplicabilityTargetItem,
} from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import { call } from '../api';
import type { ActionModel, EventOption, FindingModel, FindingsAdapter, SelfRow, TargetOption } from './model';
import { ROUTES } from './routes';
import { allPages, outcomeOf } from './shared';

type FindingTexts = { rcaText?: string | null; systemicCheckText?: string | null; statusNote?: string | null };

/** The texts saved in this browser session, by `<organisation>:<finding id>`. */
const SAVED_TEXTS = new Map<string, FindingTexts>();

export function fromFindingItem(item: FindingItem & FindingTexts): FindingModel {
  return {
    id: item.ref.id,
    code: item.code,
    title: item.title,
    classification: item.classification,
    source: item.source,
    clauseRef: item.clauseRef,
    targetCode: item.targetCode ?? null,
    status: item.status,
    owner: item.owner,
    raisedAt: item.raisedAt,
    dueAt: item.dueAt,
    auditEvent: item.auditEvent ? { id: item.auditEvent.id, shortLabel: item.auditEvent.shortLabel } : null,
    actions: item.correctiveActions.map((a) => ({ id: a.ref.id, code: a.code, status: a.status })),
    etag: item.ref.etag ?? null,
    ...('rcaText' in item ? { rcaText: item.rcaText ?? null } : {}),
    ...('systemicCheckText' in item ? { systemicCheckText: item.systemicCheckText ?? null } : {}),
    ...('statusNote' in item ? { statusNote: item.statusNote ?? null } : {}),
  };
}

export function fromActionItem(item: CorrectiveActionItem): ActionModel {
  return {
    id: item.ref.id,
    code: item.code,
    title: item.title,
    status: item.status,
    owner: item.owner,
    dueAt: item.dueAt,
    correctionText: item.correctionText,
    rcaText: item.rcaText,
    systemicCheckText: item.systemicCheckText,
    actionText: item.actionText,
    implementedAt: item.implementedAt,
    implementedBy: item.implementedBy,
    verifiedAt: item.verifiedAt,
    verifiedBy: item.verifiedBy,
    effective: item.effective,
    findings: item.findings.map((f) => ({ id: f.ref.id, code: f.code })),
    etag: item.ref.etag ?? null,
  };
}

export function fromSelfItem(item: SelfAssessmentItem): SelfRow {
  return {
    id: item.ref?.id ?? null,
    conditionCode: item.conditionCode,
    classification: item.classification,
    requirementCode: item.requirementCode,
    text: item.text,
    status: item.status,
    owner: item.owner,
    targetFixAt: item.targetFixAt,
    note: item.note,
    assessedAt: item.assessedAt,
    evidence: [...item.evidence],
    findingCode: item.findingCode,
  };
}

export function fromTarget(item: ApplicabilityTargetItem): TargetOption {
  return { code: item.code, title: item.title, kind: item.kind };
}

/** The audit events of the certification cycles, newest first, without repeats. */
export function eventsOfCycles(cycles: readonly CertificationCycleItem[]): EventOption[] {
  const seen = new Map<string, EventOption>();
  for (const cycle of cycles) {
    for (const e of cycle.events) seen.set(e.id, { id: e.id, shortLabel: e.shortLabel, scheduledAt: e.scheduledAt, eventType: e.eventType });
  }
  return [...seen.values()].sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt) || a.shortLabel.localeCompare(b.shortLabel));
}

/** `org` gives the organisation of the session, so the saved texts of one organisation never show in another. */
export function createApiAdapter(client: ApiClient | null, org: () => string | null = () => null): FindingsAdapter {
  const keyOf = (id: string) => `${org() ?? ''}:${id}`;
  const withTexts = (f: FindingModel): FindingModel => {
    const kept = SAVED_TEXTS.get(keyOf(f.id));
    if (!kept) return f;
    return {
      ...f,
      rcaText: f.rcaText !== undefined ? f.rcaText : kept.rcaText ?? null,
      systemicCheckText: f.systemicCheckText !== undefined ? f.systemicCheckText : kept.systemicCheckText ?? null,
    };
  };
  return {
    sample: false,
    async findings(ms: MsId, query = {}) {
      const res = await allPages<FindingItem>((page) => call<Page<FindingItem>>(client, ROUTES.findingsList, {
        params: { ms }, query: { page, pageSize: 200, ...(query.targetCode ? { targetCode: query.targetCode } : {}) },
      }));
      return res.ok ? { ok: true, data: res.data.map((item) => withTexts(fromFindingItem(item))) } : res;
    },
    async raise(ms, body, idempotencyKey) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.findingsCreate, { params: { ms }, body, idempotencyKey }));
    },
    async update(ms, finding, patch) {
      const res = outcomeOf(await call<CommandResult>(client, ROUTES.findingsUpdate, { params: { ms, id: finding.id }, body: patch, ifMatch: finding.etag }));
      if (res.ok && (patch.rcaText !== undefined || patch.systemicCheckText !== undefined)) {
        const key = keyOf(finding.id);
        const kept = { ...(SAVED_TEXTS.get(key) ?? {}) };
        if (patch.rcaText !== undefined) kept.rcaText = patch.rcaText;
        if (patch.systemicCheckText !== undefined) kept.systemicCheckText = patch.systemicCheckText;
        SAVED_TEXTS.set(key, kept);
      }
      return res;
    },
    async move(ms, finding, body) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.findingsTransition, { params: { ms, id: finding.id }, body, ifMatch: finding.etag }));
    },
    async actions(ms) {
      const res = await allPages<CorrectiveActionItem>((page) => call<Page<CorrectiveActionItem>>(client, ROUTES.actionsList, { params: { ms }, query: { page, pageSize: 200 } }));
      return res.ok ? { ok: true, data: res.data.map(fromActionItem) } : res;
    },
    async createAction(ms, body, idempotencyKey) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.actionsCreate, { params: { ms }, body, idempotencyKey }));
    },
    async updateAction(ms, action, patch) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.actionsUpdate, { params: { ms, id: action.id }, body: patch, ifMatch: action.etag }));
    },
    async moveAction(ms, action, body) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.actionsTransition, { params: { ms, id: action.id }, body, ifMatch: action.etag }));
    },
    async selfAssessment(ms) {
      const res = await allPages<SelfAssessmentItem>((page) => call<Page<SelfAssessmentItem>>(client, ROUTES.selfList, { params: { ms }, query: { page, pageSize: 200 } }));
      return res.ok ? { ok: true, data: res.data.map(fromSelfItem) } : res;
    },
    async assess(ms, row, body) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.selfUpdate, { params: { ms, conditionCode: row.conditionCode }, body }));
    },
    async raiseFromGap(ms, row, body, idempotencyKey) {
      if (!row.id) return { ok: false, error: { status: 422, message: ['Assess this condition as a gap first.', 'Nilai kondisi ini sebagai kesenjangan terlebih dahulu.'] } };
      return outcomeOf(await call<CommandResult>(client, ROUTES.selfRaise, { params: { ms, id: row.id }, body, idempotencyKey }));
    },
    async targets(ms) {
      const res = await call<ApplicabilityTargetItem[]>(client, ROUTES.targets, { params: { ms } });
      return res.ok ? { ok: true, data: res.data.filter((t) => !t.retired).map(fromTarget) } : { ok: false, error: res.error };
    },
    async events(ms) {
      const res = await call<CertificationCycleItem[]>(client, ROUTES.cycles, { params: { ms } });
      return res.ok ? { ok: true, data: eventsOfCycles(res.data) } : { ok: false, error: res.error };
    },
  };
}
