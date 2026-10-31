// Access reviews (MILESTONE-3 M3-07, C.2, D.9), for the Tenant Admins (`access_review.manage`): the open review with
// its progress, "Start review now", the schedule, and every review with its status and progress. Opening a review shows
// its page (review.tsx); `ctx.params.review` opens one directly (a notice or another screen).
import { useState } from 'react';
import type { ScreenProps } from '../types';
import { Badge, Button, Card, EmptyState, Facts, Meter, Table } from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import { newIdempotencyKey } from '../api';
import { adapterFor } from './adapter';
import type { ReviewRow } from './model';
import { STATUS_TEXT, STATUS_TONE, formatDay, settled } from './model';
import { LoadState, errorText, outcomeText, useLoad } from './parts';
import { ReviewPage } from './review';
import { ScheduleCard } from './settings';
import { noteAccessReviewsChanged } from './store';
import { TEXT } from './text';

export default function AccessReviewsScreen({ ctx }: ScreenProps) {
  const adapter = adapterFor(ctx);
  const initial = typeof ctx.params?.review === 'string' ? ctx.params.review : null;
  const [selected, setSelected] = useState<string | null>(initial);
  const reviews = useLoad(() => adapter.list(), []);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (selected) return <ReviewPage ctx={ctx} id={selected} onBack={() => setSelected(null)} />;

  const rows = reviews.data ?? [];
  const open = rows.find((r) => r.status === 'open') ?? null;
  const start = () => {
    setStarting(true);
    setFailure(null);
    void ctx.track(settled(adapter.create(newIdempotencyKey()))).then((res) => {
      setStarting(false);
      if (!res.ok) {
        setFailure(errorText(ctx, res.error));
        return;
      }
      ctx.toast(outcomeText(ctx, res.data, ctx.li(TEXT.started)));
      noteAccessReviewsChanged();
      const id = (res.data.data as { id?: string } | null)?.id;
      if (id) setSelected(id);
    });
  };
  const progress = (r: ReviewRow) => ctx.fill(TEXT.progressShort, { decided: r.progress.decided, items: r.progress.items, signed: r.progress.signedOff, parts: r.progress.parts });
  const columns: Column<ReviewRow>[] = [
    { key: 'no', label: TEXT.colReview, render: (r) => <strong className="mx-mono">{r.reviewNo}</strong> },
    { key: 'status', label: TEXT.colStatus, render: (r) => <Badge tone={STATUS_TONE[r.status]}>{ctx.li(STATUS_TEXT[r.status])}</Badge> },
    { key: 'opened', label: TEXT.colOpened, render: (r) => formatDay(r.openedOn, ctx.lang) },
    { key: 'due', label: TEXT.colDue, render: (r) => formatDay(r.dueOn, ctx.lang) },
    { key: 'progress', label: TEXT.colProgress, render: (r) => progress(r) },
    { key: 'done', label: TEXT.colCompleted, render: (r) => (r.completedAt ? formatDay(r.completedAt.slice(0, 10), ctx.lang) : r.cancelReason ? ctx.li(TEXT.stCancelled) : '-') },
  ];
  return (
    <div className="mx-stack">
      <LoadState ctx={ctx} list={reviews} />
      {reviews.data ? (
        <Card
          title={TEXT.openTitle}
          sub={open ? ctx.fill(TEXT.openSub, { no: open.reviewNo, due: formatDay(open.dueOn, ctx.lang) }) : TEXT.noneOpenSub}
          actions={open
            ? <Button variant="primary" onClick={() => setSelected(open.id)}>{ctx.li(TEXT.openReview)}</Button>
            : <Button variant="primary" busy={starting} onClick={start}>{ctx.li(TEXT.startNow)}</Button>}
        >
          {failure ? <div className="mx-error" role="alert">{failure}</div> : null}
          {open ? (
            <Facts
              items={[
                { label: TEXT.colOpened, value: `${formatDay(open.openedOn, ctx.lang)} (${open.openedBy ? open.openedBy.displayName : ctx.li(TEXT.bySchedule)})` },
                { label: TEXT.colDue, value: formatDay(open.dueOn, ctx.lang) },
                {
                  label: TEXT.colProgress,
                  value: (
                    <span style={{ display: 'block' }}>
                      <Meter used={open.progress.decided} limit={Math.max(1, open.progress.items)} />
                      <span className="mx-small" style={{ display: 'block' }}>{progress(open)}</span>
                    </span>
                  ),
                },
              ]}
            />
          ) : (
            <EmptyState title={TEXT.noneOpen} text={TEXT.noneOpenText} illustration={<Illustration scene="all-done" size="sm" decorative />} />
          )}
        </Card>
      ) : null}
      <ScheduleCard ctx={ctx} />
      {reviews.data ? (
        <Card title={TEXT.allTitle} sub={TEXT.allSub} flush>
          <Table
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            onRow={(r) => setSelected(r.id)}
            empty={<div className="mx-small" style={{ padding: 12 }}>{ctx.li(TEXT.noReviews)}</div>}
          />
        </Card>
      ) : null}
    </div>
  );
}
