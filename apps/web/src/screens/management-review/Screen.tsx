// Management review (MILESTONE-2 M2-14, `/ms/:ms/management-review`): the management reviews linked to the selected
// system with the completeness of their mandatory inputs, the review drawer, and "Plan review" for MS Managers and
// Programme Owners (`management_review.manage`).
import { useEffect, useMemo, useRef, useState } from 'react';
import { LoadState, useLoad } from '../findings/parts';
import type { Outcome } from '../findings/shared';
import { day, msShort, outcomeText, personName } from '../findings/shared';
import type { HostContext, ScreenProps } from '../types';
import { Badge, Button, Card, EmptyState, Table } from '../ui';
import type { Column } from '../ui';
import { adapterFor } from './adapter';
import { REVIEW_STATUS_TEXT, REVIEW_STATUS_TONE, completeness, mayManage } from './model';
import type { ReviewModel } from './model';
import { ReviewDrawer, ReviewFormDialog } from './ReviewDrawer';
import { TEXT } from './text';

export function ReviewsTable({ ctx, rows, onOpen }: { ctx: HostContext; rows: ReviewModel[]; onOpen(r: ReviewModel): void }) {
  const columns: Column<ReviewModel>[] = [
    { key: 'code', label: TEXT.colCode, render: (r) => <span className="mx-mono" style={{ whiteSpace: 'nowrap' }}>{r.code}</span> },
    { key: 'review', label: TEXT.colReview, render: (r) => r.title },
    { key: 'planned', label: TEXT.colPlanned, render: (r) => day(ctx, r.plannedAt) },
    { key: 'held', label: TEXT.colHeld, render: (r) => day(ctx, r.heldAt) },
    { key: 'owner', label: TEXT.colOwner, render: (r) => personName(ctx.D, r.owner) },
    { key: 'systems', label: TEXT.colSystems, render: (r) => r.linkedMs.map((m) => msShort(ctx.D, m)).join(', ') },
    {
      key: 'inputs',
      label: TEXT.colInputs,
      render: (r) => {
        const c = completeness(r);
        return <Badge tone={c.done === c.total ? 'ok' : 'warn'}>{ctx.fill(TEXT.inputsDone, { done: c.done, total: c.total })}</Badge>;
      },
    },
    { key: 'status', label: TEXT.colStatus, render: (r) => <Badge tone={REVIEW_STATUS_TONE[r.status]}>{ctx.li(REVIEW_STATUS_TEXT[r.status])}</Badge> },
  ];
  return <Table columns={columns} rows={rows} rowKey={(r) => r.id} onRow={onOpen} />;
}

export default function ManagementReviewScreen({ ctx }: ScreenProps) {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(() => ctxRef.current), [client]);
  const ms = ctx.msObj?.id ?? null;
  const org = ctx.org?.id ?? '';
  const reviews = useLoad(() => adapter.list(ms!), `${org}:${ms}`, Boolean(ms));
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const planRequest = ctx.params.plan;
  useEffect(() => {
    if (planRequest) setPlanning(true);
  }, [planRequest]);
  useEffect(() => setReviewId(null), [ms]);

  if (!ms) return <div className="mx-small">{ctx.li(TEXT.noSystem)}</div>;
  const rows = reviews.data ?? [];
  const review = reviewId ? rows.find((r) => r.id === reviewId) ?? null : null;
  const manage = mayManage(ctx, ms);
  const codes = rows.map((r) => r.code);
  const after = (_outcome: Outcome, text: string) => {
    ctx.toast(text);
    reviews.reload();
  };
  const body = LoadState({ ctx, loaded: reviews, failed: TEXT.loadFailed }) ?? (rows.length ? (
    <Card title={TEXT.reviews} sub={TEXT.reviewsSub} flush>
      <ReviewsTable ctx={ctx} rows={rows} onOpen={(r) => setReviewId(r.id)} />
    </Card>
  ) : (
    <Card>
      <EmptyState
        title={TEXT.noReviews}
        text={TEXT.noReviewsText}
        action={manage ? <Button variant="primary" onClick={() => setPlanning(true)}>{ctx.li(TEXT.plan)}</Button> : null}
      />
    </Card>
  ));
  return (
    <>
      {body}
      <ReviewDrawer ctx={ctx} ms={ms} review={review} adapter={adapter} codes={codes} onClose={() => setReviewId(null)} onChanged={after} />
      {manage ? (
        <ReviewFormDialog
          ctx={ctx}
          ms={ms}
          open={planning}
          adapter={adapter}
          review={null}
          codes={codes}
          onClose={() => setPlanning(false)}
          onSaved={(o, code) => {
            setPlanning(false);
            after(o, outcomeText(ctx, o, ctx.fill(TEXT.planned, { code })));
            if (o.ref?.id) setReviewId(o.ref.id);
          }}
        />
      ) : null}
    </>
  );
}
