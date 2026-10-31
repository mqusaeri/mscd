// API adapter of the Retention and disposal screen (MILESTONE-3 M3-06, D.8) through the host's client (R-17): the rules
// of the system, the disposal reviews with their decision, approval, rejection and "File removed", the disposal register
// (its CSV is the api's download link: the session cookie goes with it and the api audits `file.downloaded`), and holds.
import type {
  CommandResult, Page, RetentionHoldItem, RetentionRegisterItem, RetentionReviewItem, RetentionRuleItem,
} from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import { call } from '../api';
import type { TextPair } from '../types';
import type { HoldModel, Outcome, RegisterModel, RetentionAdapter, ReviewModel, RuleModel } from './model';
import { ROUTES } from './routes';

export const fromRule = (r: RetentionRuleItem): RuleModel => ({
  recordClass: r.recordClass, docType: r.docType, docTypeLabel: r.docTypeLabel ? [r.docTypeLabel[0], r.docTypeLabel[1]] : null, retainMonths: r.retainMonths,
  source: r.source, basis: r.basis,
});

export const fromReview = (r: RetentionReviewItem): ReviewModel => ({
  id: r.id, recordClass: r.recordClass, itemId: r.itemId, itemCode: r.itemCode, itemTitle: r.itemTitle, retentionEndsOn: r.retentionEndsOn, status: r.status,
  decision: r.decision, decidedBy: r.decidedBy, decidedAt: r.decidedAt, reason: r.reason, keepUntil: r.keepUntil, approvedBy: r.approvedBy,
  approvedAt: r.approvedAt, rejectedNote: r.rejectedNote, disposedAt: r.disposedAt, fileAction: r.fileAction, fileRemovedAt: r.fileRemovedAt, onHold: r.onHold,
});

export const fromRegister = (r: RetentionRegisterItem): RegisterModel => {
  const { onHold: _onHold, ...rest } = fromReview({ ...r, onHold: false });
  return { ...rest, retainMonths: r.retainMonths };
};

export const fromHold = (h: RetentionHoldItem): HoldModel => ({
  id: h.id, recordClass: h.recordClass, itemId: h.itemId, itemCode: h.itemCode, reason: h.reason, setBy: h.setBy, setAt: h.setAt, releasedBy: h.releasedBy,
  releasedAt: h.releasedAt, releaseReason: h.releaseReason,
});

const outcome = (r: CommandResult): Outcome => ({ message: r.message ? ([r.message[0], r.message[1]] as TextPair) : null });

/** The api's link of the register as CSV. */
export const registerCsvHref = (ms: MsId): string => `/api/v1/ms/${encodeURIComponent(ms)}/retention/register?format=csv`;

export function createApiAdapter(client: ApiClient | null): RetentionAdapter {
  const command = async (route: (typeof ROUTES)[keyof typeof ROUTES], options: Parameters<typeof call>[2]) => {
    const res = await call<CommandResult>(client, route, options);
    return res.ok ? { ok: true as const, data: outcome(res.data) } : { ok: false as const, error: res.error };
  };
  return {
    sample: false,
    async rules(ms) {
      const res = await call<RetentionRuleItem[]>(client, ROUTES.rules, { params: { ms } });
      return res.ok ? { ok: true, data: res.data.map(fromRule) } : { ok: false, error: res.error };
    },
    putRule: (ms, recordClass, body) => command(ROUTES.putRule, { params: { ms, recordClass }, body }),
    async reviews(ms, q) {
      const query: Record<string, string | number> = { page: q.page, pageSize: q.pageSize };
      if (q.status) query.status = q.status;
      if (q.recordClass) query.recordClass = q.recordClass;
      if (q.code) query.code = q.code;
      const res = await call<Page<RetentionReviewItem>>(client, ROUTES.reviews, { params: { ms }, query });
      return res.ok ? { ok: true, data: { items: res.data.items.map(fromReview), total: res.data.total } } : { ok: false, error: res.error };
    },
    decide: (ms, body) => command(ROUTES.decide, { params: { ms }, body }),
    approve: (ms, review) => command(ROUTES.approve, { params: { ms, id: review.id } }),
    reject: (ms, review, note) => command(ROUTES.reject, { params: { ms, id: review.id }, body: { note } }),
    fileRemoved: (ms, review) => command(ROUTES.fileRemoved, { params: { ms, id: review.id } }),
    async register(ms, page, pageSize) {
      const res = await call<Page<RetentionRegisterItem>>(client, ROUTES.register, { params: { ms }, query: { page, pageSize } });
      return res.ok ? { ok: true, data: { items: res.data.items.map(fromRegister), total: res.data.total } } : { ok: false, error: res.error };
    },
    async exportCsv(ms) {
      return { ok: true, data: { href: registerCsvHref(ms), fileName: `disposal-register-${ms}.csv` } };
    },
    async holds(ms) {
      const res = await call<RetentionHoldItem[]>(client, ROUTES.holds, { params: { ms } });
      return res.ok ? { ok: true, data: res.data.map(fromHold) } : { ok: false, error: res.error };
    },
    createHold: (ms, body, idempotencyKey) => command(ROUTES.createHold, { params: { ms }, body, idempotencyKey }),
    releaseHold: (ms, hold, reason) => command(ROUTES.releaseHold, { params: { ms, id: hold.id }, body: { reason } }),
  };
}
