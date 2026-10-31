// Sample adapter of the periodic access review (MILESTONE-3 M3-07, D.9): the sample organisation's people and role
// grants (`sampleMembers` of People and roles: rina and tono are its Tenant Admins, each system's manager is its
// primary Management System Manager and rina manages every system), one company sign-in linked for bagus, and a guest
// auditor in the ISMS. The sample holds an open review opened by the schedule five days ago, in which tono decided
// rina's organisation items already, and a completed review of the last quarter. Changes stay for the browser session
// and follow the server's rules: nobody decides on their own access (REVIEW-OWN-ACCESS), an item only its own subject
// could decide needs a second reviewer, decisions lock once a part is signed off or applied, and the review completes
// only when nothing waits.
import type { ControllerData, MsId } from '../../data/types';
import { textFile } from '../auditor-access/shared';
import type { TextPair } from '../types';
import { sampleMembers } from '../users/sample';
import type { Member } from '../users/model';
import type {
  AccessReviewsAdapter, ApplyBody, DecideBody, EvidenceOption, ItemKind, ItemRow, Outcome, PartDetail, PartRow, PersonRef, Progress, Result, ReviewDetail, ReviewRow,
  Settings, SettingsBody, WarningRow,
} from './model';
import { completionBlocks, signOffBlock } from './model';
import { TEXT } from './text';

interface SampleItem extends Omit<ItemRow, 'ownAccess' | 'needsSecondReviewer'> {
  partId: string;
  subjectId: string;
}

interface SamplePart {
  id: string;
  reviewId: string;
  ms: MsId | null;
  status: 'open' | 'signed_off';
  signedOffBy: PersonRef | null;
  signedOffAt: string | null;
  evidenceId: string | null;
  evidenceFiledAt: string | null;
}

interface SampleReview extends Omit<ReviewRow, 'progress'> {
  warnings: WarningRow[];
}

interface SampleState {
  settings: Settings;
  reviews: SampleReview[];
  parts: SamplePart[];
  items: SampleItem[];
  seq: number;
}

let state: SampleState | null = null;
let stateKey: string | null = null;

/** Clears the session's changes (unit tests). */
export function resetSampleAccessReviews(): void {
  state = null;
  stateKey = null;
}

const GUEST: PersonRef = { handle: 'ext.auditor', displayName: 'Eko Santoso' };
const ACCESS_RIGHTS = 'A.5.18';

function refuse<T>(status: number, message: readonly [string, string], extra: { rule?: string; errors?: { path: string; message: string }[] } = {}): Result<T> {
  return { ok: false, error: { status, message: [message[0], message[1]], ...extra } };
}

const ok = (message: TextPair | null, extra: Partial<Outcome> = {}): Result<Outcome> => ({ ok: true, data: { message, warnings: [], changed: [], data: null, ...extra } });

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

const at = (day: string, time = '03:00:00') => `${day}T${time}Z`;

export function createSampleAdapter(getD: () => ControllerData | null, getOrg: () => string | null, getPerson: () => string): AccessReviewsAdapter {
  const D = () => getD();
  const today = () => D()?.TODAY_S ?? '2026-09-28';
  const people = () => sampleMembers(D()).members;
  const personOf = (handle: string): PersonRef => {
    const m = people().find((p) => p.handle === handle);
    return { handle, displayName: m?.displayName ?? D()?.PEOPLE?.[handle]?.[0] ?? handle };
  };
  const me = () => personOf(getPerson());
  const systems = () => (D()?.MS ?? []).map((m) => ({ id: m.id, code: m.short }));
  const evidenceOf = (ms: MsId): EvidenceOption[] =>
    (D()?.bundles?.[ms]?.evs ?? []).map((e) => ({ id: e.code, code: e.code, title: e.title })).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const suggested = (ms: MsId): { id: string; code: string } | null => {
    const ev = (D()?.bundles?.[ms]?.evs ?? []).find((e) => e.ctrl === ACCESS_RIGHTS);
    return ev ? { id: ev.code, code: ev.code } : null;
  };

  /** The people who may decide the items of a part now: the Tenant Admins, or the system's managers and Programme Owners. */
  const reviewersOf = (ms: MsId | null): Set<string> => {
    const members = people().filter((m) => m.membershipStatus === 'active' && m.accountStatus === 'active');
    if (ms === null) return new Set(members.filter((m) => m.adminRoles.includes('tenant_admin')).map((m) => m.handle));
    return new Set(members.filter((m) => m.roles.some((r) => r.ms === ms && r.approvalStatus === 'active' && (r.role === 'ms_manager' || r.role === 'programme_owner'))).map((m) => m.handle));
  };

  /** A snapshot of every right in force for a new review. */
  const snapshot = (s: SampleState, reviewId: string, opened: string): { parts: SamplePart[]; items: SampleItem[] } => {
    const members = people().filter((m) => m.membershipStatus !== 'disabled' && m.kind === 'person');
    const parts: SamplePart[] = [{ id: `${reviewId}-org`, reviewId, ms: null, status: 'open', signedOffBy: null, signedOffAt: null, evidenceId: null, evidenceFiledAt: null }];
    for (const system of systems()) parts.push({ id: `${reviewId}-${system.id}`, reviewId, ms: system.id, status: 'open', signedOffBy: null, signedOffAt: null, evidenceId: null, evidenceFiledAt: null });
    const items: SampleItem[] = [];
    const base = (partId: string, member: Member | null, kind: ItemKind, role: string | null, extra: Partial<SampleItem> = {}): SampleItem => {
      s.seq += 1;
      const subject = member ? (member.membershipStatus === 'invited' ? { handle: member.handle, displayName: member.email } : { handle: member.handle, displayName: member.displayName }) : GUEST;
      return {
        id: `sample-item-${s.seq}`, partId, subjectId: member?.handle ?? GUEST.handle, kind, subject, ms: null, role, grantedBy: null, grantedAt: null,
        requestedBy: null, approvedBy: null, validUntil: null,
        lastSignInAt: member?.lastLoginAt ?? null, decision: null, decisionNote: null, decidedBy: null, decidedAt: null, appliedAt: null, appliedBy: null,
        appliedAction: null, appliedNote: null, notAppliedReason: null, pendingApproval: false, ...extra,
      };
    };
    const orgPart = parts[0]!.id;
    for (const m of members) {
      items.push(base(orgPart, m, 'membership', m.membershipStatus, { grantedBy: personOf('rina'), grantedAt: at('2025-02-03') }));
      for (const role of [...m.adminRoles].sort()) items.push(base(orgPart, m, 'admin_role', role));
    }
    const bagus = members.find((m) => m.handle === 'bagus');
    if (bagus) items.push(base(orgPart, bagus, 'linked_sign_in', 'keycloak', { grantedBy: personOf('rina'), grantedAt: at('2026-03-02'), lastSignInAt: at(addDays(opened, -3), '01:40:00') }));
    for (const system of systems()) {
      const partId = `${reviewId}-${system.id}`;
      for (const m of members) {
        for (const g of m.roles.filter((r) => r.ms === system.id && r.approvalStatus !== 'rejected')) {
          // A business role was asked for by a Tenant Admin and, when active, approved by the other one under the
          // four-eyes flow; the two Tenant Admins granted each other's roles directly (nobody approves their own).
          const pending = g.approvalStatus === 'pending_approval';
          const requester = m.handle === 'rina' ? 'tono' : 'rina';
          const approver = pending || m.handle === 'rina' || m.handle === 'tono' ? null : 'tono';
          items.push(base(partId, m, 'business_role', g.role, {
            ms: system.id, grantedBy: personOf(approver ?? requester), grantedAt: at('2025-03-01'), requestedBy: personOf(requester), approvedBy: approver ? personOf(approver) : null,
            validUntil: g.validUntil ? g.validUntil.slice(0, 10) : null, pendingApproval: pending,
          }));
        }
      }
      if (system.id === systems()[0]?.id) {
        items.push(base(partId, null, 'auditor_access', 'external_auditor', { ms: system.id, grantedBy: personOf('rina'), grantedAt: at(addDays(opened, -10)), validUntil: addDays(opened, 25), lastSignInAt: at(addDays(opened, -2), '08:10:00') }));
      }
    }
    return { parts, items };
  };

  const init = (): SampleState => {
    const key = `${getOrg() ?? ''}:${today()}`;
    if (state && stateKey === key) return state;
    const t = today();
    const s: SampleState = { settings: { frequencyMonths: 3, nextDueOn: addMonths(addDays(t, -5), 3), daysToComplete: 14, etag: 'W/"1"' }, reviews: [], parts: [], items: [], seq: 0 };
    // The completed review of the last quarter.
    const pastOpened = addDays(t, -96);
    const past: SampleReview = {
      id: 'sample-review-2', reviewNo: `AR-${pastOpened.slice(0, 4)}-02`, status: 'completed', openedOn: pastOpened, dueOn: addDays(pastOpened, 14), openedBy: null,
      completedAt: at(addDays(pastOpened, 12)), completedBy: personOf('tono'), cancelReason: null, warnings: [],
    };
    const pastSnap = snapshot(s, past.id, pastOpened);
    for (const item of pastSnap.items) {
      const by = item.subjectId === 'tono' || item.subjectId === 'rina' ? (item.subjectId === 'rina' ? personOf('tono') : personOf('rina')) : personOf(item.ms ? 'rina' : 'tono');
      Object.assign(item, { decision: 'keep', decidedBy: by, decidedAt: at(addDays(pastOpened, 6)) });
    }
    const revoked = pastSnap.items.find((i) => i.kind === 'auditor_access');
    if (revoked) Object.assign(revoked, { decision: 'revoke', decisionNote: 'The surveillance audit ended', appliedAt: at(addDays(pastOpened, 7)), appliedBy: personOf('rina'), appliedAction: 'auditor_access.revoked' });
    for (const part of pastSnap.parts) {
      Object.assign(part, { status: 'signed_off', signedOffBy: personOf(part.ms ? 'rina' : 'tono'), signedOffAt: at(addDays(pastOpened, part.ms ? 9 : 12)) });
      if (part.ms) {
        const ev = suggested(part.ms);
        if (ev) Object.assign(part, { evidenceId: ev.id, evidenceFiledAt: at(addDays(pastOpened, 12)) });
      }
    }
    // The open review, opened by the schedule five days ago; tono decided rina's organisation items.
    const opened = addDays(t, -5);
    const open: SampleReview = {
      id: 'sample-review-3', reviewNo: `AR-${opened.slice(0, 4)}-03`, status: 'open', openedOn: opened, dueOn: addDays(opened, 14), openedBy: null,
      completedAt: null, completedBy: null, cancelReason: null, warnings: [],
    };
    const openSnap = snapshot(s, open.id, opened);
    for (const item of openSnap.items.filter((i) => i.subjectId === 'rina' && i.ms === null)) {
      Object.assign(item, { decision: 'keep', decidedBy: personOf('tono'), decidedAt: at(addDays(opened, 2)) });
    }
    s.reviews.push(open, past);
    s.parts.push(...openSnap.parts, ...pastSnap.parts);
    s.items.push(...openSnap.items, ...pastSnap.items);
    state = s;
    stateKey = key;
    return s;
  };

  const partOf = (s: SampleState, id: string) => s.parts.find((p) => p.id === id)!;
  const view = (item: SampleItem): ItemRow => {
    const { partId: _p, subjectId, ...rest } = item;
    const part = partOf(init(), item.partId);
    const deciders = reviewersOf(part.ms);
    const others = [...deciders].filter((h) => h !== subjectId);
    return { ...rest, ownAccess: subjectId === getPerson(), needsSecondReviewer: item.decision === null && deciders.size > 0 && others.length === 0 };
  };
  const partRow = (s: SampleState, part: SamplePart): PartRow => {
    const review = s.reviews.find((r) => r.id === part.reviewId)!;
    const rows = s.items.filter((i) => i.partId === part.id).map(view);
    return {
      id: part.id, reviewId: review.id, reviewNo: review.reviewNo, reviewStatus: review.status, ms: part.ms, status: part.status, dueOn: review.dueOn,
      items: rows.length, decided: rows.filter((r) => r.decision !== null).length, needsSecondReviewer: rows.filter((r) => r.needsSecondReviewer).length,
      noReviewer: review.status === 'open' && part.status === 'open' && reviewersOf(part.ms).size === 0,
      signedOffBy: part.signedOffBy, signedOffAt: part.signedOffAt, evidenceId: part.evidenceId, evidenceCode: part.evidenceId, evidenceFiledAt: part.evidenceFiledAt,
    };
  };
  const partDetail = (s: SampleState, part: SamplePart): PartDetail => ({
    ...partRow(s, part),
    rows: s.items.filter((i) => i.partId === part.id).map(view),
    suggestedEvidence: part.ms ? suggested(part.ms) : null,
  });
  const progressOf = (s: SampleState, reviewId: string): Progress => {
    const items = s.items.filter((i) => s.parts.some((p) => p.id === i.partId && p.reviewId === reviewId));
    const parts = s.parts.filter((p) => p.reviewId === reviewId);
    const changes = items.filter((i) => i.decision === 'revoke' || i.decision === 'change');
    return {
      items: items.length, decided: items.filter((i) => i.decision !== null).length, revocations: changes.length,
      applied: changes.filter((i) => i.appliedAt !== null || i.notAppliedReason !== null).length, parts: parts.length, signedOff: parts.filter((p) => p.status === 'signed_off').length,
    };
  };
  const summary = (s: SampleState, r: SampleReview): ReviewRow => {
    const { warnings: _w, ...rest } = r;
    return { ...rest, progress: progressOf(s, r.id) };
  };
  const singleReviewerWarnings = (s: SampleState, reviewId: string): WarningRow[] => {
    const names = [...new Set(s.items.filter((i) => s.parts.some((p) => p.id === i.partId && p.reviewId === reviewId)).map(view).filter((i) => i.needsSecondReviewer).map((i) => i.subject.displayName))].sort();
    if (!names.length) return [];
    return [{ rule: 'REVIEW-SINGLE-ADMIN', messages: { en: `${TEXT.singleAdmin[0]} ${names.join(', ')}.`, id: `${TEXT.singleAdmin[1]} ${names.join(', ')}.` } }];
  };
  const detail = (s: SampleState, r: SampleReview): ReviewDetail => {
    const parts = s.parts.filter((p) => p.reviewId === r.id);
    const org = parts.find((p) => p.ms === null)!;
    const all = s.items.filter((i) => parts.some((p) => p.id === i.partId)).map(view);
    return {
      ...summary(s, r),
      organisationPart: partDetail(s, org),
      parts: parts.filter((p) => p.ms !== null).map((p) => partRow(s, p)),
      pendingApplications: all.filter((i) => (i.decision === 'revoke' || i.decision === 'change') && i.appliedAt === null && i.notAppliedReason === null),
      warnings: r.status === 'completed' ? r.warnings : r.status === 'open' ? singleReviewerWarnings(s, r.id) : [],
    };
  };
  const reviewOf = (s: SampleState, id: string) => s.reviews.find((r) => r.id === id) ?? null;

  /** A decision on an item of a part (`ms` null: the organisation part). */
  const decideIn = (id: string, itemId: string, body: DecideBody, ms: MsId | null): Result<Outcome> => {
    const s = init();
    const review = reviewOf(s, id);
    const item = s.items.find((i) => i.id === itemId && partOf(s, i.partId).reviewId === id);
    if (!review || !item || partOf(s, item.partId).ms !== ms) return refuse(404, TEXT.notFound);
    if (review.status !== 'open') return refuse(409, TEXT.blockNotOpen);
    if (partOf(s, item.partId).status === 'signed_off') return refuse(409, TEXT.blockSignedOff);
    if (item.appliedAt !== null || item.notAppliedReason !== null) return refuse(409, TEXT.lockedApplied);
    if (item.subjectId === getPerson()) return refuse(422, TEXT.ownAccess, { rule: 'REVIEW-OWN-ACCESS' });
    if (body.decision === 'change' && !body.note) return refuse(400, TEXT.badChangeNote, { errors: [{ path: 'body.note', message: TEXT.badChangeNote[0] }] });
    Object.assign(item, { decision: body.decision, decisionNote: body.note ?? null, decidedBy: me(), decidedAt: new Date().toISOString() });
    return ok(null, { changed: ms ? [ms] : [], data: { decision: body.decision } });
  };

  const applyIn = (id: string, itemId: string, body: ApplyBody, ms: MsId | null): Result<Outcome> => {
    const s = init();
    const review = reviewOf(s, id);
    const item = s.items.find((i) => i.id === itemId && partOf(s, i.partId).reviewId === id);
    if (!review || !item || (ms !== null && partOf(s, item.partId).ms !== ms)) return refuse(404, TEXT.notFound);
    if (review.status !== 'open') return refuse(409, TEXT.blockNotOpen);
    if (ms !== null && item.kind !== 'auditor_access') return refuse(409, TEXT.onlyGuestHere);
    if (ms === null && item.kind === 'auditor_access') return refuse(409, TEXT.guestOnSystem);
    if (item.decision === null) return refuse(409, TEXT.decideFirst);
    if (item.decision === 'keep') return refuse(409, TEXT.nothingToApply);
    if (body.action === 'apply' && item.decision !== 'revoke') return refuse(409, TEXT.onlyRevoke);
    if (item.appliedAt !== null || item.notAppliedReason !== null) return ok(null, { data: { appliedAction: null } });
    if (body.action === 'apply' && item.kind === 'membership' && item.role === 'invited') return refuse(409, TEXT.invitedMembership);
    const now = new Date().toISOString();
    if (body.action === 'not_applied') {
      Object.assign(item, { notAppliedReason: body.reason, appliedBy: me(), appliedAction: 'not_applied' });
      return ok(TEXT.recordedNotApplied, { data: { appliedAction: 'not_applied' } });
    }
    if (body.action === 'mark_applied') {
      Object.assign(item, { appliedAt: now, appliedBy: me(), appliedAction: 'marked_applied', appliedNote: body.note ?? null });
      return ok(TEXT.aMarked, { data: { appliedAction: 'marked_applied' } });
    }
    const action = { business_role: 'role.revoked', admin_role: 'membership.admin_role_removed', membership: 'membership.disabled', linked_sign_in: 'identity.unlinked', auditor_access: 'auditor_access.revoked' }[item.kind];
    const message = { business_role: TEXT.okRole, admin_role: TEXT.okAdminRole, membership: TEXT.okMembership, linked_sign_in: TEXT.okLinked, auditor_access: TEXT.okGuest }[item.kind];
    Object.assign(item, { appliedAt: now, appliedBy: me(), appliedAction: action });
    return ok(message, { changed: item.ms ? [item.ms] : [], data: { appliedAction: action } });
  };

  const csvCell = (v: string) => (/[",\r\n]/.test(v) || /^[=+\-@\t\r]/.test(v) ? `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);

  return {
    sample: true,
    async settings() {
      return { ok: true, data: { ...init().settings } };
    },
    async putSettings(body: SettingsBody, etag: string) {
      const s = init();
      if (etag !== s.settings.etag) return refuse(412, TEXT.changedMeanwhile);
      if (body.nextDueOn < today()) return refuse(400, TEXT.badNextDue, { errors: [{ path: 'body.nextDueOn', message: TEXT.badNextDue[0] }] });
      const n = Number(s.settings.etag.replace(/\D/g, '')) + 1;
      s.settings = { ...body, etag: `W/"${n}"` };
      return { ok: true, data: { ...s.settings } };
    },
    async list() {
      const s = init();
      return { ok: true, data: s.reviews.map((r) => summary(s, r)) };
    },
    async create() {
      const s = init();
      if (s.reviews.some((r) => r.status === 'open')) return refuse(409, TEXT.openExists);
      const t = today();
      const year = t.slice(0, 4);
      const n = s.reviews.filter((r) => r.reviewNo.startsWith(`AR-${year}-`)).length + 1;
      const review: SampleReview = {
        id: `sample-review-new-${s.seq + 1}`, reviewNo: `AR-${year}-${String(n).padStart(2, '0')}`, status: 'open', openedOn: t, dueOn: addDays(t, s.settings.daysToComplete),
        openedBy: me(), completedAt: null, completedBy: null, cancelReason: null, warnings: [],
      };
      const snap = snapshot(s, review.id, t);
      s.reviews.unshift(review);
      s.parts.push(...snap.parts);
      s.items.push(...snap.items);
      s.settings = { ...s.settings, nextDueOn: addMonths(t, s.settings.frequencyMonths) };
      return ok([`Access review ${review.reviewNo} started with ${snap.items.length} item(s) to review`, `Tinjauan akses ${review.reviewNo} dimulai dengan ${snap.items.length} item untuk ditinjau`], {
        data: { id: review.id, reviewNo: review.reviewNo, dueOn: review.dueOn },
      });
    },
    async get(id) {
      const s = init();
      const review = reviewOf(s, id);
      return review ? { ok: true, data: detail(s, review) } : refuse(404, TEXT.notFound);
    },
    async decide(id, itemId, body) {
      return decideIn(id, itemId, body, null);
    },
    async apply(id, itemId, body) {
      return applyIn(id, itemId, body, null);
    },
    async complete(id) {
      const s = init();
      const review = reviewOf(s, id);
      if (!review) return refuse(404, TEXT.notFound);
      const current = detail(s, review);
      const blocks = completionBlocks(current, (t) => t[0], (t, v) => t[0].replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k])));
      if (blocks.length) return refuse(409, [`${TEXT.cannotComplete[0]} ${blocks.join('; ')}.`, `${TEXT.cannotComplete[1]} ${completionBlocks(current, (t) => t[1], (t, v) => t[1].replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]))).join('; ')}.`]);
      const now = new Date().toISOString();
      const warnings = singleReviewerWarnings(s, id);
      for (const part of s.parts.filter((p) => p.reviewId === id)) {
        if (part.ms === null) Object.assign(part, { status: 'signed_off', signedOffBy: me(), signedOffAt: now });
        else if (part.evidenceId) part.evidenceFiledAt = now;
      }
      Object.assign(review, { status: 'completed', completedAt: now, completedBy: me(), warnings });
      const filed = s.parts.filter((p) => p.reviewId === id && p.evidenceId).length;
      return ok(
        filed
          ? [`Access review ${review.reviewNo} completed; the rows of ${filed} system(s) were filed as evidence`, `Tinjauan akses ${review.reviewNo} selesai; baris dari ${filed} sistem diarsipkan sebagai bukti`]
          : [`Access review ${review.reviewNo} completed`, `Tinjauan akses ${review.reviewNo} selesai`],
        { warnings, changed: s.parts.filter((p) => p.reviewId === id && p.ms).map((p) => p.ms!) },
      );
    },
    async cancel(id, reason) {
      const s = init();
      const review = reviewOf(s, id);
      if (!review) return refuse(404, TEXT.notFound);
      if (review.status !== 'open') return refuse(409, TEXT.blockNotOpen);
      Object.assign(review, { status: 'cancelled', cancelReason: reason });
      return ok([`Access review ${review.reviewNo} cancelled`, `Tinjauan akses ${review.reviewNo} dibatalkan`]);
    },
    async report(r) {
      const s = init();
      const review = reviewOf(s, r.id);
      if (!review) return refuse(404, TEXT.notFound);
      const rows = s.items.filter((i) => partOf(s, i.partId).reviewId === r.id).map(view);
      const header = 'review_no,opened_on,due_on,system,item_kind,person,handle,role,requested_by,approved_by,decision,decision_note,decided_by,decided_at,applied_action,applied_by,applied_at,not_applied_reason';
      const lines = rows.map((i) => [
        review.reviewNo, review.openedOn, review.dueOn, (i.ms ?? '').toUpperCase(), i.kind, i.subject.displayName, i.subject.handle, i.role ?? '',
        i.requestedBy?.displayName ?? '', i.approvedBy?.displayName ?? '', i.decision ?? '',
        i.decisionNote ?? '', i.decidedBy?.displayName ?? '', i.decidedAt ?? '', i.appliedAction ?? '', i.appliedBy?.displayName ?? '', i.appliedAt ?? '', i.notAppliedReason ?? '',
      ].map(csvCell).join(','));
      return { ok: true, data: textFile([header, ...lines].join('\r\n') + '\r\n', `access-review-${review.reviewNo}.csv`, 'text/csv') };
    },
    async msList(ms) {
      const s = init();
      const rows = s.parts.filter((p) => p.ms === ms).map((p) => partRow(s, p));
      return { ok: true, data: rows.sort((a, b) => Number(b.reviewStatus === 'open') - Number(a.reviewStatus === 'open')) };
    },
    async msGet(ms, id) {
      const s = init();
      const part = s.parts.find((p) => p.reviewId === id && p.ms === ms);
      return part ? { ok: true, data: partDetail(s, part) } : refuse(404, TEXT.notFound);
    },
    async msDecide(ms, id, itemId, body) {
      return decideIn(id, itemId, body, ms);
    },
    async msApply(ms, id, itemId, body) {
      return applyIn(id, itemId, body, ms);
    },
    async signOff(ms, id, evidenceId) {
      const s = init();
      const review = reviewOf(s, id);
      const part = s.parts.find((p) => p.reviewId === id && p.ms === ms);
      if (!review || !part) return refuse(404, TEXT.notFound);
      const block = signOffBlock(partDetail(s, part));
      if (block) return refuse(409, block);
      if (evidenceId && !evidenceOf(ms).some((e) => e.id === evidenceId)) return refuse(404, TEXT.notFound);
      Object.assign(part, { status: 'signed_off', signedOffBy: me(), signedOffAt: new Date().toISOString(), evidenceId: evidenceId ?? null });
      const code = ms.toUpperCase();
      const names = [...new Set(partDetail(s, part).rows.filter((r) => r.needsSecondReviewer).map((r) => r.subject.displayName))];
      const warnings: WarningRow[] = names.length ? [{ rule: 'REVIEW-SINGLE-ADMIN', messages: { en: `${TEXT.singleAdmin[0]} ${names.join(', ')}.`, id: `${TEXT.singleAdmin[1]} ${names.join(', ')}.` } }] : [];
      return ok(
        evidenceId
          ? [`${code} signed off; its rows are filed to ${evidenceId} when the review completes`, `${code} ditandatangani; barisnya diarsipkan ke ${evidenceId} saat tinjauan selesai`]
          : [`${code} signed off`, `${code} ditandatangani`],
        { warnings, changed: [ms] },
      );
    },
    evidence: evidenceOf,
  };
}
