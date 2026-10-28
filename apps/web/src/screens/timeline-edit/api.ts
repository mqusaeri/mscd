// API adapter of the certification timeline forms (MILESTONE-2 M2-15) through the host's client (R-17): the cycles
// with their certificate and audit events (`ms.cycles.list`), the event detail in both languages
// (`readmodel.surveillance.event`, read once with `Accept-Language: en` and once with `id` for the two names), the
// event writes (`audit-events.create`, `audit-events.update` with the BR-42 count), the audit activities, the cycle
// commands of M2-05 (`ms.cycles.create`, `ms.certification`, `ms.cycles.transition` with the cycle's ETag as
// `If-Match`) and the preparation and cycle item updates (`prep-tasks.update`, `cycle-items.update`, with the ETag of
// the snapshot refs).
import type {
  AuditActivityItem, CertificationCycleItem, CommandResult as WireResult, RecordRef, SurveillanceEvent,
} from '@mscd/shared';
import type { ApiClient, ApiResult } from '../../data/api/ApiClient';
import type { ControllerData, MsId } from '../../data/types';
import { call } from '../api';
import type { RouteRef } from '../api';
import { TEXT } from './text';
import type {
  ActivityModel, CycleModel, EventDetail, EventType, ItemModel, Outcome, Result, TimelineAdapter,
} from './model';
import { refusal } from './model';
import { ROUTES } from './routes';

/** The outcome of a successful command answer (`CommandResult` of D.2). */
export function outcomeOf(res: ApiResult<WireResult>): Result<Outcome> {
  if (!res.ok) return { ok: false, error: res.error };
  const body = (res.data ?? { ok: true, changed: [] }) as Partial<WireResult>;
  const out: Outcome = {
    changed: Array.isArray(body.changed) ? [...body.changed] : [],
    warnings: (body.warnings ?? []).map((w) => ({ rule: w.rule, message: [w.messages.en, w.messages.id] })),
  };
  if (body.message) out.message = [body.message[0], body.message[1]];
  if (body.ref?.etag) out.etag = body.ref.etag;
  if (body.ref?.id) out.id = body.ref.id;
  if (typeof body.count === 'number') out.count = body.count;
  return { ok: true, data: out };
}

export function fromCycle(item: CertificationCycleItem): CycleModel {
  return {
    id: item.id,
    status: item.status,
    cycleStart: item.cycleStart,
    cycleEnd: item.cycleEnd,
    certificateNo: item.certificateNo,
    certifiedAt: item.certifiedAt,
    certificateExpiresAt: item.certificateExpiresAt,
    certificationBody: item.certificationBody,
    certifiedScope: item.certifiedScope,
    events: item.events
      .map((e) => ({ id: e.id, eventType: e.eventType, shortLabel: e.shortLabel, scheduledAt: e.scheduledAt, outcome: e.outcome }))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.shortLabel.localeCompare(b.shortLabel)),
    items: { total: item.items.total, done: item.items.done },
    etag: item.etag ?? null,
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

/** The detail of an event from its two language readings. */
export function fromEventDetail(en: SurveillanceEvent, id: SurveillanceEvent, fallbackType: EventType): EventDetail {
  return {
    eventType: (en.type ?? fallbackType) as EventType,
    nameEn: en.name,
    nameId: id.name || en.name,
    shortLabel: en.shortLabel,
    scheduledAt: en.scheduledAt,
    auditDays: en.auditDays,
    leadAuditor: en.leadAuditor,
    expectedFocus: en.expectedFocus,
    prepWindowDays: null,
    outcome: en.outcome,
    outcomeSummary: en.outcomeSummary,
  };
}

/**
 * The record reference of a preparation task or cycle item in the snapshot refs: the refs carry the uuid as the
 * business id and the title or requirement code as `code` (G.5).
 */
export function itemRef(D: ControllerData | null, item: Pick<ItemModel, 'kind' | 'ms' | 'code'>): RecordRef | null {
  const refs = (D as unknown as { refs?: Record<string, RecordRef> } | null)?.refs ?? {};
  const direct = refs[`${item.ms}:${item.kind}:${item.code}`];
  if (direct) return direct;
  const prefix = `${item.ms}:${item.kind}:`;
  for (const [key, ref] of Object.entries(refs)) if (key.startsWith(prefix) && ref.code === item.code) return ref;
  return null;
}

async function readIn<T>(client: ApiClient | null, route: RouteRef, params: Record<string, string>, lang: 'en' | 'id'): Promise<ApiResult<T>> {
  if (!client) return call<T>(client, route, { params });
  return client.request<T>(route[0], route[1], { params, headers: { 'Accept-Language': lang } });
}

export function createApiAdapter(client: ApiClient | null, getD: () => ControllerData | null): TimelineAdapter {
  // ETags of the events this session changed (an event's ETag comes only with a command result).
  const eventTags = new Map<string, string>();
  const remember = (id: string, res: Result<Outcome>) => {
    if (res.ok && res.data.etag) eventTags.set(id, res.data.etag);
    return res;
  };
  const patchItem = async (ms: MsId, item: ItemModel, body: Record<string, unknown>, etag: string | null | undefined, id: string) =>
    outcomeOf(await call<WireResult>(client, item.kind === 'prep' ? ROUTES.prepUpdate : ROUTES.cycleItemUpdate, { params: { ms, id }, body, ifMatch: etag ?? null }));
  return {
    sample: false,
    async cycles(ms) {
      const res = await call<CertificationCycleItem[]>(client, ROUTES.cycles, { params: { ms } });
      return res.ok ? { ok: true, data: res.data.map(fromCycle) } : { ok: false, error: res.error };
    },
    async eventDetail(ms, event) {
      const [en, id] = await Promise.all([
        readIn<SurveillanceEvent>(client, ROUTES.eventDetail, { ms, id: event.id }, 'en'),
        readIn<SurveillanceEvent>(client, ROUTES.eventDetail, { ms, id: event.id }, 'id'),
      ]);
      if (!en.ok) return { ok: false, error: en.error };
      if (!id.ok) return { ok: false, error: id.error };
      return { ok: true, data: fromEventDetail(en.data, id.data, event.eventType) };
    },
    async createEvent(ms, body, idempotencyKey) {
      return outcomeOf(await call<WireResult>(client, ROUTES.eventCreate, { params: { ms }, body, idempotencyKey }));
    },
    async updateEvent(ms, event, patch) {
      const res = outcomeOf(await call<WireResult>(client, ROUTES.eventUpdate, { params: { ms, id: event.id }, body: patch, ifMatch: eventTags.get(event.id) ?? null }));
      if (!res.ok && res.error.status === 412) eventTags.delete(event.id);
      return remember(event.id, res);
    },
    async activities(ms, event) {
      const res = await call<AuditActivityItem[]>(client, ROUTES.activities, { params: { ms, id: event.id } });
      return res.ok ? { ok: true, data: res.data.map(fromActivity) } : { ok: false, error: res.error };
    },
    async generate(ms, event) {
      return outcomeOf(await call<WireResult>(client, ROUTES.activitiesGenerate, { params: { ms, id: event.id } }));
    },
    async updateActivity(ms, activity, patch) {
      return outcomeOf(await call<WireResult>(client, ROUTES.activityUpdate, { params: { ms, id: activity.id }, body: patch }));
    },
    async startCycle(ms, body, idempotencyKey) {
      return outcomeOf(await call<WireResult>(client, ROUTES.cycleCreate, { params: { ms }, body, idempotencyKey }));
    },
    async recordCertificate(ms, body) {
      return outcomeOf(await call<WireResult>(client, ROUTES.certification, { params: { ms }, body }));
    },
    async transition(ms, cycle, to, reason) {
      return outcomeOf(await call<WireResult>(client, ROUTES.cycleTransition, { params: { ms, id: cycle.id }, body: { to, reason: reason.trim() }, ifMatch: cycle.etag }));
    },
    async markDone(ms, item) {
      const ref = itemRef(getD(), item);
      if (!ref) return refusal(404, TEXT.noRef);
      // C.13: a task not started, blocked or overdue moves through in progress first; one in progress is done at once.
      if (item.status === 'open') {
        const first = await patchItem(ms, item, { status: 'in_progress' }, ref.etag, ref.id);
        if (!first.ok) return first;
        const second = await patchItem(ms, item, { status: 'done' }, first.data.etag, ref.id);
        return second.ok ? { ok: true, data: { ...second.data, changed: [...new Set([...first.data.changed, ...second.data.changed])] } } : second;
      }
      return patchItem(ms, item, { status: 'done' }, ref.etag, ref.id);
    },
    async updateItem(ms, item, patch) {
      const ref = itemRef(getD(), item);
      if (!ref) return refusal(404, TEXT.noRef);
      return patchItem(ms, item, { ...patch }, ref.etag, ref.id);
    },
  };
}
