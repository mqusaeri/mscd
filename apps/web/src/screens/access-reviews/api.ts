// API adapter of the periodic access review (MILESTONE-3 M3-07, D.1, D.9) through the host's client (R-17): the
// settings with their ETag (`If-Match`), the reviews, one review, decisions, applying, completion, cancel, the report
// (the api's download link: the session cookie goes with it and the api audits `file.downloaded`), and the parts of a
// system with their decisions, the guest grant revocation and the sign-off. The evidence items of the sign-off picker
// come from the snapshot (`D.bundles[ms].evs` with the uuids of `D.refs`).
import type {
  AccessReviewDetail, AccessReviewItemView, AccessReviewPartDetail, AccessReviewPartSummary, AccessReviewSettings, AccessReviewSummary,
  CommandResult, RecordRef,
} from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import type { ControllerData, MsId } from '../../data/types';
import { call } from '../api';
import type { TextPair } from '../types';
import type { AccessReviewsAdapter, ItemRow, Outcome, PartDetail, PartRow, ReviewDetail, ReviewRow, Settings } from './model';
import { ROUTES, pathOf } from './routes';

export const fromSettings = (s: AccessReviewSettings): Settings => ({ frequencyMonths: s.frequencyMonths, nextDueOn: s.nextDueOn, daysToComplete: s.daysToComplete, etag: s.etag });

export const fromSummary = (r: AccessReviewSummary): ReviewRow => ({
  id: r.id, reviewNo: r.reviewNo, status: r.status, openedOn: r.openedOn, dueOn: r.dueOn, openedBy: r.openedBy, completedAt: r.completedAt,
  completedBy: r.completedBy, cancelReason: r.cancelReason, progress: { ...r.progress },
});

export const fromItem = (i: AccessReviewItemView): ItemRow => ({
  id: i.id, kind: i.kind, subject: i.subject, ms: i.ms, role: i.role, grantedBy: i.grantedBy, grantedAt: i.grantedAt, requestedBy: i.requestedBy,
  approvedBy: i.approvedBy, validUntil: i.validUntil,
  lastSignInAt: i.lastSignInAt, decision: i.decision, decisionNote: i.decisionNote, decidedBy: i.decidedBy, decidedAt: i.decidedAt, appliedAt: i.appliedAt,
  appliedBy: i.appliedBy, appliedAction: i.appliedAction, appliedNote: i.appliedNote, notAppliedReason: i.notAppliedReason, ownAccess: i.ownAccess,
  pendingApproval: i.pendingApproval, needsSecondReviewer: i.needsSecondReviewer,
});

export const fromPart = (p: AccessReviewPartSummary): PartRow => ({
  id: p.id, reviewId: p.reviewId, reviewNo: p.reviewNo, reviewStatus: p.reviewStatus, ms: p.ms, status: p.status, dueOn: p.dueOn, items: p.items,
  decided: p.decided, needsSecondReviewer: p.needsSecondReviewer, noReviewer: p.noReviewer, signedOffBy: p.signedOffBy, signedOffAt: p.signedOffAt, evidenceId: p.evidenceId,
  evidenceCode: p.evidenceCode, evidenceFiledAt: p.evidenceFiledAt,
});

export const fromPartDetail = (p: AccessReviewPartDetail): PartDetail => ({ ...fromPart(p), rows: p.rows.map(fromItem), suggestedEvidence: p.suggestedEvidence });

export const fromDetail = (d: AccessReviewDetail): ReviewDetail => ({
  ...fromSummary(d),
  organisationPart: fromPartDetail(d.organisationPart),
  parts: d.parts.map(fromPart),
  pendingApplications: d.pendingApplications.map(fromItem),
  warnings: d.warnings.map((w) => ({ rule: w.rule, messages: { en: w.messages.en, id: w.messages.id } })),
});

export const outcomeOf = (r: CommandResult): Outcome => ({
  message: r.message ? ([r.message[0], r.message[1]] as TextPair) : null,
  warnings: (r.warnings ?? []).map((w) => ({ rule: w.rule, messages: { en: w.messages.en, id: w.messages.id } })),
  changed: [...r.changed],
  data: r.data ?? null,
});

/** The api's link of the report CSV of a review. */
export const reportHref = (id: string): string => pathOf(ROUTES.report, { id });

export function createApiAdapter(client: ApiClient | null, getD: () => ControllerData | null = () => null): AccessReviewsAdapter {
  const command = async (route: (typeof ROUTES)[keyof typeof ROUTES], options: Parameters<typeof call>[2]) => {
    const res = await call<CommandResult>(client, route, options);
    return res.ok ? { ok: true as const, data: outcomeOf(res.data) } : { ok: false as const, error: res.error };
  };
  const refs = () => (getD() as unknown as { refs?: Record<string, RecordRef> } | null)?.refs ?? {};
  return {
    sample: false,
    async settings() {
      const res = await call<AccessReviewSettings>(client, ROUTES.settings);
      return res.ok ? { ok: true, data: fromSettings(res.data) } : { ok: false, error: res.error };
    },
    async putSettings(body, etag) {
      const res = await call<AccessReviewSettings>(client, ROUTES.putSettings, { body, ifMatch: etag });
      return res.ok ? { ok: true, data: fromSettings(res.data) } : { ok: false, error: res.error };
    },
    async list() {
      const res = await call<AccessReviewSummary[]>(client, ROUTES.list);
      return res.ok ? { ok: true, data: res.data.map(fromSummary) } : { ok: false, error: res.error };
    },
    create: (idempotencyKey) => command(ROUTES.create, { idempotencyKey }),
    async get(id) {
      const res = await call<AccessReviewDetail>(client, ROUTES.get, { params: { id } });
      return res.ok ? { ok: true, data: fromDetail(res.data) } : { ok: false, error: res.error };
    },
    decide: (id, itemId, body) => command(ROUTES.decide, { params: { id, itemId }, body }),
    apply: (id, itemId, body) => command(ROUTES.apply, { params: { id, itemId }, body }),
    complete: (id) => command(ROUTES.complete, { params: { id } }),
    cancel: (id, reason) => command(ROUTES.cancel, { params: { id }, body: { reason } }),
    async report(review) {
      return { ok: true, data: { href: reportHref(review.id), fileName: `access-review-${review.reviewNo}.csv` } };
    },
    async msList(ms) {
      const res = await call<AccessReviewPartSummary[]>(client, ROUTES.msList, { params: { ms } });
      return res.ok ? { ok: true, data: res.data.map(fromPart) } : { ok: false, error: res.error };
    },
    async msGet(ms, id) {
      const res = await call<AccessReviewPartDetail>(client, ROUTES.msGet, { params: { ms, id } });
      return res.ok ? { ok: true, data: fromPartDetail(res.data) } : { ok: false, error: res.error };
    },
    msDecide: (ms, id, itemId, body) => command(ROUTES.msDecide, { params: { ms, id, itemId }, body }),
    msApply: (ms, id, itemId, body) => command(ROUTES.msApply, { params: { ms, id, itemId }, body }),
    signOff: (ms, id, evidenceId) => command(ROUTES.signOff, { params: { ms, id }, body: evidenceId ? { evidenceId } : {} }),
    evidence(ms: MsId) {
      const evs = getD()?.bundles?.[ms]?.evs ?? [];
      return evs
        .map((e) => ({ id: refs()[`${ms}:ev:${e.code}`]?.id ?? '', code: e.code, title: e.title }))
        .filter((e) => e.id)
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    },
  };
}
