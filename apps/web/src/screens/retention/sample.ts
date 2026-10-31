// Sample adapter of Retention and disposal (MILESTONE-3 M3-06, C.6): the retention rules, disposal reviews, holds and
// register of each sample organisation and system, kept for the browser session. Each system starts with the default
// period of 36 months, a few records due for review (earlier versions of its documents and earlier files of its
// evidence, and a closed finding where the system has one), two disposals awaiting approval (one proposed by another
// manager, one by the persona, which the persona cannot approve), one hold in force and one released, and a register
// with a kept record and two disposals (one whose owner still has to remove the file in the customer repository).
// Every name and code is sample material (R-19). Loaded only through the dynamic import of adapter.ts.
import type { ControllerData, MsId } from '../../data/types';
import { textFile } from '../auditor-access/shared';
import type {
  DecideBody, HoldModel, Outcome, PageOf, RecordClass, RegisterModel, Result, RetentionAdapter, ReviewModel, RuleModel,
} from './model';
import { DEFAULT_MONTHS, RECORD_CLASSES, SAMPLE_DOC_TYPES, addMonths, itemLabel } from './model';
import { TEXT } from './text';

interface Stored {
  review: ReviewModel;
  /** The period of the record's class when it was decided (the register's column). */
  retainMonths: number;
}

interface SystemState {
  rules: Map<string, { months: number; basis: string }>;
  reviews: Stored[];
  holds: HoldModel[];
}

const STATES = new Map<string, Map<MsId, SystemState>>();
let sequence = 0;

/** Forgets every organisation's changes (tests). */
export function resetSampleRetention(): void {
  STATES.clear();
  sequence = 0;
}

const key = (recordClass: RecordClass, docType: string | null) => (recordClass === 'document_version' ? `${recordClass}:${docType ?? ''}` : recordClass);

const fill = (pair: readonly [string, string], values: Record<string, string>): [string, string] =>
  [pair[0], pair[1]].map((t) => t.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? '')) as [string, string];

const refusal = <T,>(status: number, message: [string, string], rule?: string): Result<T> => ({ ok: false, error: { status, message, ...(rule ? { rule } : {}) } });

/** The label of the version before `v3.0` (`v2.0`), or `v1.0`. */
function previousVersion(ver: string): string {
  const m = /^v?(\d+)(?:\.(\d+))?$/.exec(ver.trim());
  if (!m) return 'v1.0';
  const major = Number(m[1]);
  return major > 1 ? `v${major - 1}.0` : 'v0.9';
}

/** The label of the file before `v3` (`v2`), or `v1`. */
function previousFile(ver: string): string {
  const m = /(\d+)/.exec(ver);
  const n = m ? Number(m[1]) : 2;
  return n > 1 ? `v${n - 1}` : 'v1';
}

export function createSampleAdapter(getD: () => ControllerData | null, getOrg: () => string | null, getMe: () => string): RetentionAdapter {
  const D = () => getD();
  const today = () => D()?.TODAY_S ?? new Date().toISOString().slice(0, 10);
  const nowIso = () => `${today()}T${new Date().toISOString().slice(11, 19)}Z`;
  const days = (n: number) => {
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const at = (n: number, time = '03:00:00') => `${days(n)}T${time}Z`;
  const person = (handle: string) => ({ handle, displayName: D()?.PEOPLE?.[handle]?.[0] ?? handle });
  /** Another manager of the sample (the persona is the manager of the open system). */
  const other = () => (getMe() === 'sari' ? 'tono' : 'sari');

  const review = (id: string, over: Partial<ReviewModel> & Pick<ReviewModel, 'recordClass' | 'itemCode' | 'itemTitle' | 'retentionEndsOn'>): ReviewModel => ({
    id, itemId: `${id}-item`, status: 'open', decision: null, decidedBy: null, decidedAt: null, reason: null, keepUntil: null, approvedBy: null, approvedAt: null,
    rejectedNote: null, disposedAt: null, fileAction: null, fileRemovedAt: null, onHold: false, ...over,
  });

  function seed(ms: MsId): SystemState {
    const bundle = D()?.bundles?.[ms];
    const docs = bundle?.docs ?? [];
    const evs = bundle?.evs ?? [];
    const closed = (D()?.PAST?.[ms] ?? []).filter((f) => f[4] === 'closed');
    const me = getMe();
    const p = `sample-rv-${ms}`;
    const reviews: Stored[] = [];
    const add = (r: ReviewModel) => reviews.push({ review: r, retainMonths: DEFAULT_MONTHS });
    const doc = (i: number) => docs[i % Math.max(1, docs.length)];
    const ev = (i: number) => evs[i % Math.max(1, evs.length)];
    if (docs.length) {
      add(review(`${p}-1`, { recordClass: 'document_version', itemCode: `${doc(0)!.id} ${previousVersion(doc(0)!.ver)}`, itemTitle: doc(0)!.title, retentionEndsOn: days(-14) }));
    }
    if (docs.length > 1) {
      add(review(`${p}-2`, { recordClass: 'document_version', itemCode: `${doc(1)!.id} ${previousVersion(doc(1)!.ver)}`, itemTitle: doc(1)!.title, retentionEndsOn: days(-41) }));
    }
    if (evs.length) {
      add(review(`${p}-3`, { recordClass: 'evidence_file', itemCode: `${ev(0)!.code} ${previousFile(ev(0)!.ver)}`, itemTitle: ev(0)!.title, retentionEndsOn: days(-5) }));
    }
    if (evs.length > 1) {
      add(review(`${p}-4`, {
        recordClass: 'evidence_file', itemCode: `${ev(1)!.code} ${previousFile(ev(1)!.ver)}`, itemTitle: ev(1)!.title, retentionEndsOn: days(-63),
        decidedBy: person(other()), decidedAt: at(-9), reason: 'Replaced by the quarterly export', rejectedNote: 'The auditor asked to keep it until the surveillance audit',
      }));
    }
    if (closed.length) {
      add(review(`${p}-5`, { recordClass: 'finding', itemCode: closed[0]![0], itemTitle: closed[0]![3], retentionEndsOn: days(-30) }));
    }
    add(review(`${p}-6`, { recordClass: 'evidence_pack', itemCode: 'PACK-3C9E21A7', itemTitle: `/Compliance/_packs/${ms.toUpperCase()}/2023-09-12/`, retentionEndsOn: days(-17) }));
    // Two disposals wait for a second person: one proposed by another manager, one by the persona.
    if (evs.length > 2) {
      add(review(`${p}-7`, {
        recordClass: 'evidence_file', itemCode: `${ev(2)!.code} ${previousFile(ev(2)!.ver)}`, itemTitle: ev(2)!.title, retentionEndsOn: days(-21), status: 'awaiting_approval',
        decision: 'dispose', decidedBy: person(other()), decidedAt: at(-2), reason: 'Superseded by later logs; period over',
      }));
    }
    add(review(`${p}-8`, {
      recordClass: 'audit_event', itemCode: 'Surveillance 2023', itemTitle: 'Surveillance audit 2023', retentionEndsOn: days(-48), status: 'awaiting_approval',
      decision: 'dispose', decidedBy: person(me), decidedAt: at(-1), reason: 'Result recorded and closed; one certification cycle passed',
    }));
    // The register: a record kept, a disposal of vault content and one whose owner must remove the file.
    if (docs.length > 2) {
      add(review(`${p}-9`, {
        recordClass: 'document_version', itemCode: `${doc(2)!.id} ${previousVersion(doc(2)!.ver)}`, itemTitle: doc(2)!.title, retentionEndsOn: days(-90), status: 'kept',
        decision: 'keep', decidedBy: person(me), decidedAt: at(-60), reason: 'Needed for the recertification audit', keepUntil: days(120),
      }));
    }
    add(review(`${p}-10`, {
      recordClass: 'evidence_file', itemCode: evs.length > 3 ? `${ev(3)!.code} v1` : 'EV-0101 v1', itemTitle: evs.length > 3 ? ev(3)!.title : 'Earlier evidence file', retentionEndsOn: days(-120),
      status: 'disposed', decision: 'dispose', decidedBy: person(other()), decidedAt: at(-25), reason: 'Replaced; period over', approvedBy: person(me), approvedAt: at(-24),
      disposedAt: at(-24), fileAction: 'vault_content_deleted',
    }));
    add(review(`${p}-11`, {
      recordClass: 'document_version', itemCode: docs.length > 3 ? `${doc(3)!.id} v1.0` : 'DOC-001 v1.0', itemTitle: docs.length > 3 ? doc(3)!.title : 'Earlier document version',
      retentionEndsOn: days(-75), status: 'disposed', decision: 'dispose', decidedBy: person(me), decidedAt: at(-12), reason: 'Superseded more than three years ago',
      approvedBy: person(other()), approvedAt: at(-11), disposedAt: at(-11), fileAction: 'owner_asked',
    }));
    const holds: HoldModel[] = [
      {
        id: `sample-hold-${ms}-1`, recordClass: 'competence_record', itemId: `sample-hold-${ms}-1-item`, itemCode: 'CMP-4F2A9C1D', reason: 'Dispute with a former employee about training records',
        setBy: person(me), setAt: at(-34), releasedBy: null, releasedAt: null, releaseReason: null,
      },
      {
        id: `sample-hold-${ms}-0`, recordClass: 'finding', itemId: `sample-hold-${ms}-0-item`, itemCode: 'NC-2024-07', reason: 'Customer claim about late deliveries',
        setBy: person(other()), setAt: at(-200), releasedBy: person(me), releasedAt: at(-80), releaseReason: 'Claim settled',
      },
    ];
    return { rules: new Map(), reviews, holds };
  }

  const stateOf = (ms: MsId): SystemState => {
    const org = getOrg() ?? (D()?.MS ?? []).map((m) => m.id).sort().join(',');
    let systems = STATES.get(org);
    if (!systems) {
      systems = new Map();
      STATES.set(org, systems);
    }
    let s = systems.get(ms);
    if (!s) {
      s = seed(ms);
      systems.set(ms, s);
    }
    return s;
  };

  const heldCodes = (s: SystemState) => new Set(s.holds.filter((h) => !h.releasedAt).map((h) => `${h.recordClass}:${h.itemCode}`));
  const withHold = (s: SystemState, r: ReviewModel): ReviewModel => ({ ...r, onHold: heldCodes(s).has(`${r.recordClass}:${r.itemCode}`) });
  const done = (message: [string, string] | null = null): Result<Outcome> => ({ ok: true, data: { message } });

  const rulesOf = (s: SystemState): RuleModel[] => {
    const out: RuleModel[] = [];
    for (const recordClass of RECORD_CLASSES) {
      const types = recordClass === 'document_version' ? SAMPLE_DOC_TYPES : [{ code: null, label: null }];
      for (const t of types) {
        const own = s.rules.get(key(recordClass, t.code));
        out.push({
          recordClass, docType: t.code, docTypeLabel: t.label ? [t.label[0], t.label[1]] : null, retainMonths: own?.months ?? DEFAULT_MONTHS,
          source: own ? 'set' : 'default', basis: own?.basis ?? null,
        });
      }
    }
    return out;
  };

  const adapter: RetentionAdapter = {
    sample: true,
    async rules(ms) {
      return { ok: true, data: rulesOf(stateOf(ms)) };
    },
    async putRule(ms, recordClass, body) {
      const s = stateOf(ms);
      const k = key(recordClass, body.docType ?? null);
      if (body.retainMonths === null) s.rules.delete(k);
      else s.rules.set(k, { months: body.retainMonths, basis: body.basis });
      return done();
    },
    async reviews(ms, q) {
      const s = stateOf(ms);
      const held = heldCodes(s);
      const all = s.reviews
        .map((x) => x.review)
        .filter((r) => !q.status || r.status === q.status)
        .filter((r) => !q.recordClass || r.recordClass === q.recordClass)
        .filter((r) => !q.code || r.itemCode === q.code || (r.itemCode ?? '').startsWith(`${q.code} `))
        .filter((r) => !(r.status === 'open' && held.has(`${r.recordClass}:${r.itemCode}`)))
        .sort((a, b) => a.retentionEndsOn.localeCompare(b.retentionEndsOn) || itemLabel(a).localeCompare(itemLabel(b)))
        .map((r) => withHold(s, r));
      const page: PageOf<ReviewModel> = { items: all.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: all.length };
      return { ok: true, data: page };
    },
    async decide(ms, body: DecideBody) {
      const s = stateOf(ms);
      const held = heldCodes(s);
      const chosen = body.ids.map((id) => s.reviews.find((x) => x.review.id === id));
      for (const x of chosen) {
        if (!x) return refusal(404, ['Review not found', 'Tinjauan tidak ditemukan']);
        const label = itemLabel(x.review);
        if (x.review.status !== 'open') return refusal(409, fill(TEXT.smpNotOpen, { item: label }));
        if (body.decision === 'dispose' && held.has(`${x.review.recordClass}:${x.review.itemCode}`)) return refusal(422, fill(TEXT.smpHold, { item: label }), 'RET-HOLD');
        if (body.decision === 'dispose' && x.review.retentionEndsOn > today()) return refusal(422, fill(TEXT.smpNotDue, { item: label, date: x.review.retentionEndsOn }), 'RET-NOT-DUE');
      }
      for (const x of chosen as Stored[]) {
        const r = x.review;
        r.decision = body.decision;
        r.reason = body.reason;
        r.decidedBy = person(getMe());
        r.decidedAt = nowIso();
        r.rejectedNote = null;
        if (body.decision === 'keep') {
          r.status = 'kept';
          r.keepUntil = body.keepUntil ?? null;
        } else if (body.decision === 'extend') {
          r.status = 'extended';
          r.retentionEndsOn = addMonths(r.retentionEndsOn, body.extendMonths ?? 12);
        } else {
          r.status = 'awaiting_approval';
        }
        x.retainMonths = rulesOf(s).find((rule) => rule.recordClass === r.recordClass)?.retainMonths ?? DEFAULT_MONTHS;
      }
      return done();
    },
    async approve(ms, target) {
      const s = stateOf(ms);
      const x = s.reviews.find((y) => y.review.id === target.id);
      if (!x || x.review.status !== 'awaiting_approval') return refusal(409, ['This disposal does not wait for approval', 'Pemusnahan ini tidak menunggu persetujuan']);
      if (x.review.decidedBy?.handle === getMe()) return refusal(422, [TEXT.smpSelf[0], TEXT.smpSelf[1]], 'SOD-SELF-APPROVE');
      if (heldCodes(s).has(`${x.review.recordClass}:${x.review.itemCode}`)) return refusal(422, fill(TEXT.smpHold, { item: itemLabel(x.review) }), 'RET-HOLD');
      const r = x.review;
      r.status = 'disposed';
      r.approvedBy = person(getMe());
      r.approvedAt = nowIso();
      r.disposedAt = r.approvedAt;
      r.fileAction = r.recordClass === 'document_version' || r.recordClass === 'evidence_file' || r.recordClass === 'evidence_pack' ? 'vault_content_deleted' : 'none';
      return done();
    },
    async reject(ms, target, note) {
      const x = stateOf(ms).reviews.find((y) => y.review.id === target.id);
      if (!x || x.review.status !== 'awaiting_approval') return refusal(409, ['This disposal does not wait for approval', 'Pemusnahan ini tidak menunggu persetujuan']);
      x.review.status = 'open';
      x.review.decision = null;
      x.review.rejectedNote = note;
      return done();
    },
    async fileRemoved(ms, target) {
      const x = stateOf(ms).reviews.find((y) => y.review.id === target.id);
      if (!x || x.review.fileAction !== 'owner_asked' || x.review.fileRemovedAt) return refusal(409, ['No file waits to be removed', 'Tidak ada berkas yang menunggu dihapus']);
      x.review.fileRemovedAt = nowIso();
      return done();
    },
    async register(ms, page, pageSize) {
      const all = stateOf(ms).reviews
        .filter((x) => ['kept', 'extended', 'disposed'].includes(x.review.status))
        .sort((a, b) => (b.review.disposedAt ?? b.review.decidedAt ?? '').localeCompare(a.review.disposedAt ?? a.review.decidedAt ?? ''))
        .map((x): RegisterModel => {
          const { onHold: _onHold, ...rest } = x.review;
          return { ...rest, retainMonths: x.retainMonths };
        });
      return { ok: true, data: { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length } };
    },
    async exportCsv(ms) {
      const res = await adapter.register(ms, 1, 10_000);
      const cell = (v: unknown) => {
        const text = String(v ?? '');
        const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
        return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      const header = ['item_code', 'item_title', 'record_class', 'retention_months', 'retention_ends_on', 'status', 'decision', 'reason', 'keep_until', 'decided_by', 'decided_at', 'approved_by', 'approved_at', 'disposed_at', 'file_action', 'file_removed_at'];
      const rows = res.ok ? res.data.items.map((r) => [
        r.itemCode, r.itemTitle, r.recordClass, r.retainMonths, r.retentionEndsOn, r.status, r.decision, r.reason, r.keepUntil, r.decidedBy?.displayName, r.decidedAt,
        r.approvedBy?.displayName, r.approvedAt, r.disposedAt, r.fileAction, r.fileRemovedAt,
      ]) : [];
      const text = [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
      return { ok: true, data: textFile(`${text}\r\n`, `disposal-register-${ms}-${today()}.csv`, 'text/csv;charset=utf-8') };
    },
    async holds(ms) {
      const list = [...stateOf(ms).holds].sort((a, b) => Number(Boolean(a.releasedAt)) - Number(Boolean(b.releasedAt)) || (b.releasedAt ?? b.setAt).localeCompare(a.releasedAt ?? a.setAt));
      return { ok: true, data: list };
    },
    async createHold(ms, body) {
      const s = stateOf(ms);
      const byId = body.itemId ? s.reviews.find((x) => x.review.itemId === body.itemId)?.review : null;
      if (body.itemId && !byId) return refusal(404, [TEXT.smpNotFound[0], TEXT.smpNotFound[1]]);
      const code = byId ? itemLabel(byId) : (body.itemCode ?? '').trim();
      if (heldCodes(s).has(`${body.recordClass}:${code}`)) return refusal(409, fill(TEXT.smpHeldAlready, { item: code }));
      sequence += 1;
      s.holds.unshift({
        id: `sample-hold-${ms}-new-${sequence}`, recordClass: body.recordClass, itemId: byId?.itemId ?? `sample-hold-${ms}-new-${sequence}-item`, itemCode: code,
        reason: body.reason, setBy: person(getMe()), setAt: nowIso(), releasedBy: null, releasedAt: null, releaseReason: null,
      });
      return done();
    },
    async releaseHold(ms, target, reason) {
      const h = stateOf(ms).holds.find((x) => x.id === target.id);
      if (!h || h.releasedAt) return refusal(409, ['This hold is already released', 'Penahanan ini sudah dilepas']);
      h.releasedAt = nowIso();
      h.releasedBy = person(getMe());
      h.releaseReason = reason;
      return done();
    },
  };
  return adapter;
}
