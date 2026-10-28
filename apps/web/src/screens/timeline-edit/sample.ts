// Sample adapter of the certification timeline forms (MILESTONE-2 M2-15, C.6). The audit events, preparation tasks and
// cycle items live in the sample snapshot, which this adapter changes through `mutate` and `insert` of the sample data
// source, so the built-in timeline shows every change. What the snapshot does not hold (the certification cycles with
// their certificate, an event's type, result, lead auditor and preparation window, and the audit activities) is kept
// here for the browser session, per organisation. The cycles start as the demo seed writes them: a certified cycle
// for a system whose label says "Certified <date>, cycle <year> to <year>", else a planned cycle for 2026 to 2029.
// The sample applies the rules of M2-05 the screens rely on: one active cycle, the certificate after a recommended
// Stage 2 or recertification result, the manual moves of J.8 with a reason and the cycle's ETag, BR-42 and BR-43.
// Loaded only through the dynamic import of adapter.ts, so the api build holds none of it (R-13).
import type { AuditEvent, ControllerData, DataSource, MsId } from '../../data/types';
import type { TextPair } from '../types';
import { TEXT } from './text';
import type {
  ActivityModel, AuditOutcome, CycleModel, CycleMove, EventDetail, EventType, ItemModel, Outcome, Result, TimelineAdapter,
} from './model';
import { addDays, addYears, movesOf, ok, reasonError, recommendation, refusal } from './model';

type SampleCycle = Omit<CycleModel, 'events' | 'items' | 'etag'> & { ms: MsId; version: number };

interface EventMeta {
  eventType?: EventType;
  leadAuditor?: string | null;
  expectedFocus?: string | null;
  prepWindowDays?: number;
  outcome?: AuditOutcome | null;
}

interface OrgState {
  cycles: Map<MsId, SampleCycle[]>;
  meta: Map<string, EventMeta>;
  activities: Map<string, ActivityModel[]>;
}

const STATES = new Map<string, OrgState>();
let sequence = 0;

/** Forgets every organisation's changes (tests). */
export function resetSampleTimeline(): void {
  STATES.clear();
  sequence = 0;
}

/** Audit activity templates of the sample packs: ISO/IEC 27001 has three for Stage 1 and three for Stage 2 (E.2). */
const TEMPLATES: Readonly<Record<string, readonly [string, EventType, string, string, string, string][]>> = {
  isms: [
    ['AA-S1-01', 'stage1', '4.3', 'Review ISMS scope and context', 'Are the scope, boundaries and interfaces documented and consistent with the context and interested parties?', 'Scope statement; register of context issues and interested parties'],
    ['AA-S1-02', 'stage1', '6.1', 'Review risk method and Statement of Applicability', 'Is the risk method repeatable, and does every control decision trace to a risk or a stated reason?', 'Risk assessment method; risk register; Statement of Applicability'],
    ['AA-S1-03', 'stage1', '9.2', 'Confirm audit programme and management review plan', 'Are an internal audit and a management review planned or held before Stage 2?', 'Internal audit programme; management review plan or minutes'],
    ['AA-S2-01', 'stage2', '5.1', 'Interview top management on leadership', 'How does top management set the policy and objectives, provide resources and review results?', 'Approved policy; objectives; management review decisions'],
    ['AA-S2-02', 'stage2', '8.1', 'Sample controls in operation', 'Does evidence from the current cycle show each sampled control operating as the Statement of Applicability says?', 'Operating records of the sampled controls; linked procedures'],
    ['AA-S2-03', 'stage2', '10.2', 'Follow up nonconformities and corrective actions', 'Were causes analysed and were corrective actions verified as effective before closure?', 'Nonconformity register; root cause analyses; effectiveness checks'],
  ],
};

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const en = (t: unknown): string => (Array.isArray(t) ? String(t[0] ?? '') : String(t ?? ''));
const idOf = (t: unknown): string => (Array.isArray(t) ? String(t[1] ?? t[0] ?? '') : String(t ?? ''));

/** The event type of a sample label, as the demo seed derives it. */
export function sampleEventType(label: string): EventType {
  if (/^Stage 1\b/.test(label)) return 'stage1';
  if (/^Stage 2\b/.test(label)) return 'stage2';
  if (/^Surveillance\b/.test(label)) return 'surveillance';
  if (/^Recert/.test(label)) return 'recertification';
  if (/^Internal audit\b/i.test(label)) return 'internal_audit';
  return 'special';
}

/** The certificate expiry the demo seed writes (`demoCertificateExpiry`): a date at least 90 days after the demo date. */
export function sampleExpiry(cycleEnd: string, today: string): string {
  const limit = addDays(today, 90);
  const dayBefore = addDays(cycleEnd, -1);
  if (dayBefore > limit) return dayBefore;
  const yearEnd = `${cycleEnd.slice(0, 4)}-12-31`;
  if (yearEnd > limit) return yearEnd;
  return addDays(today, 365);
}

/** The messages of `ms.cycles.transition` (M2-05). */
const MOVE_MESSAGES: Readonly<Record<CycleMove, TextPair>> = {
  suspended: ['Certificate suspended', 'Sertifikat dibekukan'],
  certified: ['Certificate reinstated', 'Sertifikat dipulihkan'],
  withdrawn: ['Certificate withdrawn', 'Sertifikat dicabut'],
  closed: ['Certification cycle closed', 'Siklus sertifikasi ditutup'],
};

const etagOf = (c: SampleCycle): string => `W/"sample-${c.id}-${c.version}"`;

export interface SampleEnv {
  getD(): ControllerData | null;
  getDs(): DataSource | null;
  getOrg(): string | null;
}

export function createSampleAdapter(env: SampleEnv): TimelineAdapter {
  const D = () => env.getD();
  const today = () => D()?.TODAY_S ?? new Date().toISOString().slice(0, 10);
  const orgKey = () => env.getOrg() ?? (D()?.MS ?? []).map((m) => m.id).sort().join(',');
  const state = (): OrgState => {
    const key = orgKey();
    let s = STATES.get(key);
    if (!s) {
      s = { cycles: new Map(), meta: new Map(), activities: new Map() };
      STATES.set(key, s);
    }
    return s;
  };
  const rowsOf = (ms: MsId): AuditEvent[] => (D()?.EVENTS?.[ms] ?? []) as AuditEvent[];
  const metaOf = (ms: MsId, index: number): EventMeta => state().meta.get(`${ms}:${index}`) ?? {};
  const setMeta = (ms: MsId, index: number, patch: EventMeta) => state().meta.set(`${ms}:${index}`, { ...metaOf(ms, index), ...patch });
  const typeOf = (ms: MsId, index: number, row: AuditEvent): EventType => metaOf(ms, index).eventType ?? sampleEventType(en(row.t));
  const shortOf = (row: AuditEvent): string => en(row.short) || en(row.t);

  const cyclesOf = (ms: MsId): SampleCycle[] => {
    const s = state();
    let list = s.cycles.get(ms);
    if (!list) {
      const system = D()?.MS?.find((m) => m.id === ms);
      const match = system ? /^Certified (\d{2}) ([A-Z][a-z]{2}) (\d{4}), cycle (\d{4})\D(\d{4})/.exec(en(system.cert)) : null;
      sequence += 1;
      if (match && MONTHS[match[2]]) {
        const certifiedAt = `${match[3]}-${MONTHS[match[2]]}-${match[1]}`;
        const cycleEnd = `${match[5]}${certifiedAt.slice(4)}`;
        list = [{
          id: `sample-cycle-${ms}-${sequence}`, ms, status: 'certified', cycleStart: certifiedAt, cycleEnd, certificateNo: null, certifiedAt,
          certificateExpiresAt: sampleExpiry(cycleEnd, today()), certificationBody: system?.certifier || null, certifiedScope: system?.scope || null, version: 1,
        }];
      } else {
        list = [{
          id: `sample-cycle-${ms}-${sequence}`, ms, status: 'planned', cycleStart: '2026-01-01', cycleEnd: '2029-12-31', certificateNo: null, certifiedAt: null,
          certificateExpiresAt: null, certificationBody: null, certifiedScope: null, version: 1,
        }];
      }
      s.cycles.set(ms, list);
    }
    return list;
  };

  /** The cycle of an event date: the newest cycle that started on or before it, else the oldest one. */
  const cycleForDate = (list: readonly SampleCycle[], date: string): SampleCycle | null => {
    const byStart = [...list].sort((a, b) => a.cycleStart.localeCompare(b.cycleStart));
    return [...byStart].reverse().find((c) => c.cycleStart <= date) ?? byStart[0] ?? null;
  };

  const modelOf = (ms: MsId): CycleModel[] => {
    const list = cyclesOf(ms);
    const prep = (D()?.CYCLE_ITEMS?.[ms] ?? []) as [string, string, string, string, string, string][];
    const events = rowsOf(ms).map((row, index) => ({ row, index, cycle: cycleForDate(list, row.d) }));
    const newest = [...list].sort((a, b) => b.cycleStart.localeCompare(a.cycleStart));
    return newest.map((c) => ({
      id: c.id, status: c.status, cycleStart: c.cycleStart, cycleEnd: c.cycleEnd, certificateNo: c.certificateNo, certifiedAt: c.certifiedAt,
      certificateExpiresAt: c.certificateExpiresAt, certificationBody: c.certificationBody, certifiedScope: c.certifiedScope,
      events: events
        .filter((e) => e.cycle?.id === c.id)
        .map(({ row, index }) => ({ id: `sample-event-${ms}-${index}`, eventType: typeOf(ms, index, row), shortLabel: shortOf(row), scheduledAt: row.d, outcome: metaOf(ms, index).outcome ?? null }))
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)),
      // The snapshot's cycle items belong to the newest cycle (G.5 CYCLE_ITEMS of the latest cycle).
      items: c.id === newest[0]?.id ? { total: prep.length, done: prep.filter((p) => p[4] === 'done').length } : { total: 0, done: 0 },
      etag: etagOf(c),
    }));
  };

  const ds = (): DataSource | null => env.getDs();
  const changed = (ms: MsId, extra: Partial<Outcome> = {}): Result<Outcome> => ok({ changed: [ms], warnings: [], ...extra });
  const mutate = async (ms: MsId, kind: 'event' | 'prep' | 'cycle', id: string | number, patch: Record<string, unknown>): Promise<Result<Outcome> | null> => {
    const source = ds();
    if (!source?.mutate) return refusal(0, TEXT.noRef);
    const res = await source.mutate(ms, kind, String(id), patch);
    if (!res.ok) return refusal(res.error?.status ?? 422, (res.error?.message ?? TEXT.noRef) as TextPair);
    return null;
  };

  /** D.4: a Stage 1 or recertification event starts the cycle when none is open; a Stage 1 event activates a planned one. */
  const opensCycle = (ms: MsId, type: EventType, date: string): TextPair | null => {
    if (type !== 'stage1' && type !== 'recertification') return null;
    const list = cyclesOf(ms);
    const active = list.find((c) => c.status === 'active');
    if (active) return null;
    const planned = list.find((c) => c.status === 'planned');
    if (planned) {
      if (type !== 'stage1') return null;
      planned.status = 'active';
      planned.version += 1;
      return TEXT.started;
    }
    const start = date < today() ? date : today();
    sequence += 1;
    list.push({
      id: `sample-cycle-${ms}-${sequence}`, ms, status: 'active', cycleStart: start, cycleEnd: addYears(start, 3), certificateNo: null, certifiedAt: null,
      certificateExpiresAt: null, certificationBody: null, certifiedScope: null, version: 1,
    });
    return TEXT.started;
  };

  return {
    sample: true,
    async cycles(ms) {
      return ok(modelOf(ms));
    },
    async eventDetail(ms, event) {
      const row = rowsOf(ms)[event.index];
      if (!row) return refusal(404, TEXT.noRef);
      const meta = metaOf(ms, event.index);
      const system = D()?.MS?.find((m) => m.id === ms);
      const lead = system && en(system.lead) && en(system.lead) !== '-' && !/^To be assigned/.test(en(system.lead)) ? en(system.lead) : null;
      const focus = (D()?.FOCUS?.[ms] ?? '-') as string;
      return ok<EventDetail>({
        eventType: typeOf(ms, event.index, row),
        nameEn: en(row.t),
        nameId: idOf(row.t),
        shortLabel: shortOf(row),
        scheduledAt: row.d,
        auditDays: typeof row.days === 'number' ? row.days : null,
        leadAuditor: meta.leadAuditor !== undefined ? meta.leadAuditor : row.next ? lead : null,
        expectedFocus: meta.expectedFocus !== undefined ? meta.expectedFocus : row.next && focus !== '-' ? focus : null,
        prepWindowDays: meta.prepWindowDays ?? (row.next ? system?.audit?.prepWindowDays ?? 60 : 60),
        outcome: meta.outcome ?? null,
        outcomeSummary: row.result ? en(row.result) : null,
      });
    },
    async createEvent(ms, body) {
      const source = ds();
      if (!source?.insert) return refusal(0, TEXT.noRef);
      const index = rowsOf(ms).length;
      const res = await source.insert(ms, 'event', {
        t: [body.nameEn, body.nameId], short: [body.shortLabel, body.shortLabel], d: body.scheduledAt, days: body.auditDays ?? null,
      });
      if (!res.ok) return refusal(res.error?.status ?? 422, (res.error?.message ?? TEXT.noRef) as TextPair);
      setMeta(ms, index, {
        eventType: body.eventType, leadAuditor: body.leadAuditorName ?? null, expectedFocus: body.expectedFocus ?? null, prepWindowDays: body.prepWindowDays ?? 60,
      });
      const started = opensCycle(ms, body.eventType, body.scheduledAt);
      return changed(ms, { id: `sample-event-${ms}-${index}`, ...(started ? { message: started } : {}) });
    },
    async updateEvent(ms, event, patch) {
      const row = rowsOf(ms)[event.index];
      if (!row) return refusal(404, TEXT.noRef);
      const rowPatch: Record<string, unknown> = {};
      if (patch.nameEn !== undefined || patch.nameId !== undefined) rowPatch.t = [patch.nameEn ?? en(row.t), patch.nameId ?? idOf(row.t)];
      if (patch.shortLabel !== undefined) rowPatch.short = [patch.shortLabel, patch.shortLabel];
      if (patch.scheduledAt !== undefined) rowPatch.d = patch.scheduledAt;
      if (patch.auditDays !== undefined) rowPatch.days = patch.auditDays;
      if (patch.outcomeSummary !== undefined) rowPatch.result = patch.outcomeSummary ? [patch.outcomeSummary, patch.outcomeSummary] : undefined;
      // BR-42: moving the next audit earlier notifies the holders of preparation tasks now due on or after it.
      let count = 0;
      if (patch.scheduledAt !== undefined && row.next) {
        const prep = (D()?.PREP?.[ms] ?? []) as [string, string, string, string][];
        count = new Set(prep.filter((p) => p[3] !== 'done' && p[2] >= patch.scheduledAt! && !(p[2] >= row.d)).map((p) => p[1]).filter((h) => h && h !== 'none')).size;
      }
      if (Object.keys(rowPatch).length) {
        const failed = await mutate(ms, 'event', event.index, rowPatch);
        if (failed) return failed;
      }
      const meta: EventMeta = {};
      if (patch.eventType !== undefined) meta.eventType = patch.eventType;
      if (patch.leadAuditorName !== undefined) meta.leadAuditor = patch.leadAuditorName;
      if (patch.expectedFocus !== undefined) meta.expectedFocus = patch.expectedFocus;
      if (patch.prepWindowDays !== undefined) meta.prepWindowDays = patch.prepWindowDays;
      if (patch.outcome !== undefined) meta.outcome = patch.outcome;
      setMeta(ms, event.index, meta);
      const started = patch.eventType ? opensCycle(ms, patch.eventType, patch.scheduledAt ?? row.d) : null;
      return changed(ms, { count, ...(started ? { message: started } : {}) });
    },
    async activities(_ms, event) {
      return ok((state().activities.get(event.id) ?? []).map((a) => ({ ...a })));
    },
    async generate(ms, event) {
      const s = state();
      const have = s.activities.get(event.id) ?? [];
      const templates = (TEMPLATES[ms] ?? []).filter((t) => t[1] === event.eventType && !have.some((a) => a.templateCode === t[0]));
      const added = templates.map(([code, , clauseRef, title, keyQuestions, evidenceToRequest]): ActivityModel => {
        sequence += 1;
        return {
          id: `sample-activity-${sequence}`, code, templateCode: code, title, clauseRef, keyQuestions, evidenceToRequest, auditee: null, auditor: null,
          targetCode: null, scheduledAt: null, status: 'planned', note: null,
        };
      });
      s.activities.set(event.id, [...have, ...added]);
      return ok({
        changed: [ms], warnings: [], count: added.length,
        message: added.length ? [`${added.length} audit activities created from the templates`, `${added.length} aktivitas audit dibuat dari templat`] : TEXT.allExist,
      });
    },
    async updateActivity(ms, activity, patch) {
      const s = state();
      for (const [eventId, list] of s.activities) {
        const i = list.findIndex((a) => a.id === activity.id);
        if (i < 0) continue;
        const a = { ...list[i] };
        if (patch.auditeeHandle !== undefined) a.auditee = patch.auditeeHandle === 'none' ? null : patch.auditeeHandle;
        if (patch.auditorHandle !== undefined) a.auditor = patch.auditorHandle === 'none' ? null : patch.auditorHandle;
        if (patch.targetCode !== undefined) a.targetCode = patch.targetCode;
        if (patch.scheduledAt !== undefined) a.scheduledAt = patch.scheduledAt;
        if (patch.status !== undefined) a.status = patch.status;
        if (patch.note !== undefined) a.note = patch.note;
        s.activities.set(eventId, list.map((x, k) => (k === i ? a : x)));
        return changed(ms);
      }
      return refusal(404, TEXT.noRef);
    },
    async startCycle(ms, body) {
      const list = cyclesOf(ms);
      const active = list.find((c) => c.status === 'active');
      if (active) return refusal(409, [`${TEXT.activeExists[0].replace('{from}', active.cycleStart).replace('{to}', active.cycleEnd)}`, `${TEXT.activeExists[1].replace('{from}', active.cycleStart).replace('{to}', active.cycleEnd)}`]);
      const end = body.cycleEnd ?? addYears(body.cycleStart, 3);
      const planned = list.find((c) => c.status === 'planned');
      if (planned) {
        Object.assign(planned, { status: 'active', cycleStart: body.cycleStart, cycleEnd: end, version: planned.version + 1 });
      } else {
        sequence += 1;
        list.push({
          id: `sample-cycle-${ms}-${sequence}`, ms, status: 'active', cycleStart: body.cycleStart, cycleEnd: end, certificateNo: null, certifiedAt: null,
          certificateExpiresAt: null, certificationBody: null, certifiedScope: null, version: 1,
        });
      }
      return changed(ms, { message: TEXT.started });
    },
    async recordCertificate(ms, body) {
      const list = cyclesOf(ms);
      const active = list.find((c) => c.status === 'active');
      if (!active) return refusal(409, TEXT.certNeedsActive);
      const model = modelOf(ms).find((c) => c.id === active.id) ?? null;
      if (!recommendation(model)) return refusal(422, TEXT.certNeedsResult);
      for (const c of list) {
        if (c.status === 'certified') {
          c.status = 'closed';
          c.version += 1;
        }
      }
      Object.assign(active, {
        status: 'certified', certificateNo: body.certificateNo, certifiedAt: body.issuedAt, certificateExpiresAt: body.expiresAt,
        certificationBody: body.certificationBody, certifiedScope: body.certifiedScope ?? D()?.MS?.find((m) => m.id === ms)?.scope ?? null, version: active.version + 1,
      });
      return changed(ms);
    },
    async transition(ms, cycle, to: CycleMove, reason) {
      const c = cyclesOf(ms).find((x) => x.id === cycle.id);
      if (!c) return refusal(404, TEXT.noRef);
      if (cycle.etag && cycle.etag !== etagOf(c)) return { ok: false, error: { status: 412, slug: 'precondition-failed', message: [TEXT.conflict[0], TEXT.conflict[1]] } };
      const problem = reasonError(reason);
      if (problem) return { ok: false, error: { status: 400, slug: 'validation', message: [problem[0], problem[1]], errors: [{ path: 'body.reason', message: problem[0] }] } };
      if (!movesOf(c.status).includes(to)) return refusal(409, ['This move is not allowed for the cycle now.', 'Perpindahan ini tidak diizinkan untuk siklus saat ini.']);
      c.status = to;
      c.version += 1;
      return changed(ms, { message: MOVE_MESSAGES[to] });
    },
    async markDone(ms, item) {
      const failed = await mutate(ms, item.kind, item.code, { [item.kind === 'prep' ? 3 : 4]: 'done' });
      return failed ?? changed(ms);
    },
    async updateItem(ms, item: ItemModel, patch) {
      if (item.kind === 'prep' && patch.dueAt && item.auditDate && patch.dueAt >= item.auditDate) {
        return refusal(422, [
          `BR-43: preparation task due ${patch.dueAt} is not before the audit on ${item.auditDate}`,
          `BR-43: tenggat tugas persiapan ${patch.dueAt} tidak sebelum audit tanggal ${item.auditDate}`,
        ], 'BR-43');
      }
      const at = item.kind === 'prep' ? { owner: 1, due: 2 } : { owner: 2, due: 3 };
      const tuple: Record<string, unknown> = {};
      if (patch.ownerHandle !== undefined) tuple[at.owner] = patch.ownerHandle;
      if (patch.dueAt !== undefined) tuple[at.due] = patch.dueAt;
      const failed = await mutate(ms, item.kind, item.code, tuple);
      return failed ?? changed(ms);
    },
  };
}

