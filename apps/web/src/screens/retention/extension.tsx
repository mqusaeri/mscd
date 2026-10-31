// Detail extensions of Retention and disposal (MILESTONE-3 M3-06, C.5 kinds `doc` and `ev`, D.8): the retention period of
// the record's earlier versions or files with the retention end it gives, the disposal reviews of the record's earlier
// versions or files, and the holds in force on them, with a link to the screen.
import { useId } from 'react';
import type { Document, Evidence } from '../../data/types';
import type { DetailProps, HostContext } from '../types';
import { Button } from '../ui';
import { adapterFor } from './adapter';
import type { HoldModel, ReviewModel, RuleModel } from './model';
import { STATUS_TEXT, addMonths, formatDay, ruleFor } from './model';
import { useLoad } from './parts';
import { TEXT } from './text';

interface RetentionFacts {
  rules: RuleModel[];
  reviews: ReviewModel[];
  holds: HoldModel[];
}

/** The items of a record: its own code, or its code and a space (`ISP-001 v1.0`, `EV-0313 v2`). */
const ofRecord = (code: string, itemCode: string | null) => Boolean(itemCode) && (itemCode === code || itemCode!.startsWith(`${code} `));

function useFacts(ctx: HostContext, ms: string, code: string | undefined) {
  const adapter = adapterFor(ctx);
  return useLoad<RetentionFacts>(async () => {
    if (!code) return { ok: true, data: { rules: [], reviews: [], holds: [] } };
    const [rules, reviews, holds] = await Promise.all([adapter.rules(ms), adapter.reviews(ms, { code, page: 1, pageSize: 50 }), adapter.holds(ms)]);
    if (!rules.ok) return { ok: false, error: rules.error };
    return {
      ok: true,
      data: {
        rules: rules.data,
        reviews: reviews.ok ? reviews.data.items.filter((r) => ofRecord(code, r.itemCode)) : [],
        holds: holds.ok ? holds.data.filter((h) => !h.releasedAt && ofRecord(code, h.itemCode)) : [],
      },
    };
  }, [ms, code]);
}

function Panel({ ctx, ms, lines, facts }: { ctx: HostContext; ms: string; lines: string[]; facts: RetentionFacts | null }) {
  const headingId = useId();
  if (!facts) return null;
  return (
    <section className="mx-stack" aria-labelledby={headingId} data-retention="panel" style={{ gap: 6 }}>
      <h3 id={headingId} className="mx-label" style={{ margin: 0 }}>{ctx.li(TEXT.extTitle)}</h3>
      {lines.map((l) => <span key={l} className="mx-small" style={{ display: 'block', color: 'var(--tx)' }}>{l}</span>)}
      {facts.reviews.map((r) => (
        <span key={r.id} className="mx-small" style={{ display: 'block' }}>
          {ctx.fill(TEXT.extReview, { code: r.itemCode ?? '-', status: ctx.li(STATUS_TEXT[r.status]).toLowerCase(), date: formatDay(r.retentionEndsOn, ctx.lang) })}
        </span>
      ))}
      {facts.holds.map((h) => (
        <span key={h.id} className="mx-small" style={{ display: 'block', color: 'var(--tx)' }}>
          {ctx.fill(TEXT.extHold, { code: h.itemCode ?? '-', reason: h.reason })}
        </span>
      ))}
      <span>
        <Button variant="link" onClick={() => ctx.go('retention', { ms })}>{ctx.li(TEXT.extOpen)}</Button>
      </span>
    </section>
  );
}

export function RetentionDocExtension({ ctx, ms, record }: DetailProps) {
  const doc = record as Document | null;
  const facts = useFacts(ctx, ms, doc?.id);
  if (!doc?.id || !facts.data) return null;
  const tier = (doc.tier ?? '').toLowerCase();
  const rule = facts.data.rules.find((r) => r.recordClass === 'document_version' && (r.docType === tier || r.docTypeLabel?.[0].toLowerCase() === tier))
    ?? ruleFor(facts.data.rules, 'document_version', null);
  const lines: string[] = [];
  if (rule) {
    lines.push(ctx.fill(TEXT.extDocRule, { n: rule.retainMonths, source: ctx.li(rule.source === 'set' ? TEXT.sourceSet : TEXT.sourceDefault).toLowerCase() }));
    if (doc.appr && /^\d{4}-\d{2}-\d{2}$/.test(doc.appr)) {
      const ver = /^v/i.test(doc.ver) ? doc.ver : `v${doc.ver}`;
      lines.push(ctx.fill(TEXT.extDocEnd, { ver, date: formatDay(addMonths(doc.appr, rule.retainMonths), ctx.lang) }));
    }
  }
  return <Panel ctx={ctx} ms={ms} lines={lines} facts={facts.data} />;
}

export function RetentionEvidenceExtension({ ctx, ms, record }: DetailProps) {
  const ev = record as Evidence | null;
  const facts = useFacts(ctx, ms, ev?.code);
  if (!ev?.code || !facts.data) return null;
  const rule = ruleFor(facts.data.rules, 'evidence_file');
  const today = ctx.D?.TODAY_S ?? new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  if (rule) {
    lines.push(ctx.fill(TEXT.extEvRule, { n: rule.retainMonths, source: ctx.li(rule.source === 'set' ? TEXT.sourceSet : TEXT.sourceDefault).toLowerCase() }));
    lines.push(ctx.fill(TEXT.extEvEnd, { date: formatDay(addMonths(today, rule.retainMonths), ctx.lang) }));
  }
  return <Panel ctx={ctx} ms={ms} lines={lines} facts={facts.data} />;
}
