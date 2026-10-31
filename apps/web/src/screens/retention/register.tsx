// The disposal register of Retention and disposal (MILESTONE-3 M3-06, D.8): every decision with the record, its type and
// period, the decision and reason, who decided and approved, and what happened to the file, with "Export CSV" (the
// evidence for ISO/IEC 27001 A.5.33 and clause 7.5.3) and "File removed" once the owner deleted a file in the
// customer's repository.
import { useState } from 'react';
import type { MsId } from '../../data/types';
import { useMutation } from '../api';
import type { HostContext } from '../types';
import { Alert, Badge, Button, Card, EmptyState, Pager, Table } from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import { formatInstant, saveFile } from '../auditor-access/shared';
import { adapterFor } from './adapter';
import type { RegisterModel } from './model';
import { CLASS_TEXT, FILE_ACTION_TEXT, STATUS_TONE, asApiResult, formatDay, mayManage, settled } from './model';
import { ItemCell, LoadState, PersonAt, useLoad } from './parts';
import { noteRetentionChanged } from './store';
import { TEXT } from './text';

const PAGE_SIZE = 50;

function decisionText(ctx: HostContext, r: RegisterModel): string {
  if (r.status === 'kept') return ctx.fill(TEXT.regKept, { date: formatDay(r.keepUntil, ctx.lang) });
  if (r.status === 'extended') return ctx.fill(TEXT.regExtended, { date: formatDay(r.retentionEndsOn, ctx.lang) });
  return ctx.fill(TEXT.regDisposed, { date: formatInstant(r.disposedAt, ctx.lang) });
}

export function RegisterTab({ ctx, ms }: { ctx: HostContext; ms: MsId }) {
  const adapter = adapterFor(ctx);
  const manage = mayManage(ctx, ms);
  const [page, setPage] = useState(1);
  const list = useLoad(() => adapter.register(ms, page, PAGE_SIZE), [ms, page]);
  const removal = useMutation((r: RegisterModel) => asApiResult(adapter.fileRemoved(ms, r)));
  const exportCsv = () => {
    void settled(adapter.exportCsv(ms)).then((res) => {
      if (res.ok) saveFile(res.data);
      else ctx.toast(ctx.li(res.error.message));
    });
  };
  const removed = (r: RegisterModel) => {
    ctx.track(removal.submit(r)).then((res) => {
      if (!res.ok) return;
      ctx.toast(ctx.li(TEXT.fileRemovedToast));
      noteRetentionChanged();
    }, () => undefined);
  };
  const fileCell = (r: RegisterModel) => {
    if (!r.fileAction) return <span className="mx-muted">-</span>;
    return (
      <span style={{ display: 'block' }}>
        {ctx.li(FILE_ACTION_TEXT[r.fileAction])}
        {r.fileAction === 'owner_asked' && r.fileRemovedAt ? <span className="mx-small" style={{ display: 'block' }}>{ctx.fill(TEXT.fileRemovedOn, { date: formatInstant(r.fileRemovedAt, ctx.lang) })}</span> : null}
        {r.fileAction === 'owner_asked' && !r.fileRemovedAt && manage ? (
          <span style={{ display: 'block', marginTop: 4 }}><Button onClick={() => removed(r)} busy={removal.busy}>{ctx.li(TEXT.fileRemoved)}</Button></span>
        ) : null}
      </span>
    );
  };
  const columns: Column<RegisterModel>[] = [
    { key: 'item', label: TEXT.colItem, render: (r) => <ItemCell row={r} /> },
    { key: 'class', label: TEXT.colClass, render: (r) => ctx.li(CLASS_TEXT[r.recordClass]) },
    { key: 'period', label: TEXT.colPeriod, render: (r) => ctx.fill(TEXT.months, { n: r.retainMonths }) },
    { key: 'ended', label: TEXT.colEnded, render: (r) => formatDay(r.retentionEndsOn, ctx.lang) },
    { key: 'decision', label: TEXT.colDecision, render: (r) => <Badge tone={STATUS_TONE[r.status]}>{decisionText(ctx, r)}</Badge> },
    { key: 'reason', label: TEXT.colReason, render: (r) => <span style={{ overflowWrap: 'anywhere' }}>{r.reason ?? '-'}</span> },
    { key: 'decided', label: TEXT.colDecided, render: (r) => <PersonAt ctx={ctx} who={r.decidedBy} at={r.decidedAt} /> },
    { key: 'approved', label: TEXT.colApproved, render: (r) => <PersonAt ctx={ctx} who={r.approvedBy} at={r.approvedAt} /> },
    { key: 'file', label: TEXT.colFile, render: fileCell },
  ];
  const total = list.data?.total ?? 0;
  return (
    <Card title={TEXT.registerTitle} sub={TEXT.registerSub} flush actions={<Button onClick={exportCsv}>{ctx.li(TEXT.exportCsv)}</Button>}>
      {removal.error ? <div style={{ padding: 12 }}><Alert tone="bad">{ctx.li(removal.error.message)}</Alert></div> : null}
      <LoadState ctx={ctx} list={list} />
      {list.data ? (
        <Table
          columns={columns}
          rows={list.data.items}
          rowKey={(r) => r.id}
          empty={<EmptyState title={TEXT.noRegister} text={TEXT.noRegisterText} illustration={<Illustration scene="no-documents" size="sm" decorative />} />}
        />
      ) : null}
      <Pager page={page} pages={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPage={setPage} />
    </Card>
  );
}
