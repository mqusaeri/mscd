// "Due for review" and "Awaiting approval" of Retention and disposal (MILESTONE-3 M3-06, D.8). Due for review lists the
// records whose period ended, with a record type filter, multi-select and the decision form (keep until a date, extend
// by months, propose disposal; a reason is required). Awaiting approval lists the proposed disposals with "Approve"
// (disabled with "You proposed this disposal" for the proposer, SOD-SELF-APPROVE) and "Reject" with a note.
import { useEffect, useState } from 'react';
import type { MsId } from '../../data/types';
import { useMutation } from '../api';
import type { HostContext } from '../types';
import {
  Alert, Badge, Button, Card, Checkbox, ConfirmDialog, DateInput, EmptyState, Field, Modal, Pager, Radio, Select, Table, TextInput, Textarea, UI_TEXT,
} from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import { adapterFor } from './adapter';
import { HoldDialog } from './holds';
import type { DecideBody, DecisionForm, RecordClass, ReviewModel } from './model';
import {
  CLASS_TEXT, RECORD_CLASSES, asApiResult, decisionBody, decisionErrors, emptyDecision, formatDay, itemLabel, mayApprove, mayManage, noteError, proposedByMe,
} from './model';
import { ItemCell, LoadState, PersonAt, useLoad } from './parts';
import { noteRetentionChanged } from './store';
import { TEXT } from './text';

const PAGE_SIZE = 50;

const HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;

/** The checkbox of a row: its label names the record for screen readers, the row shows the record itself. */
function RowCheck({ name, checked, onChange, label }: { name: string; checked: boolean; onChange(on: boolean): void; label: string }) {
  return (
    <label className="mx-check" style={{ position: 'relative' }}>
      <input type="checkbox" name={name} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span style={HIDDEN}>{label}</span>
    </label>
  );
}

export function DecisionDialog({ ctx, ms, reviews, onClose, onDecided }: {
  ctx: HostContext; ms: MsId; reviews: ReviewModel[]; onClose(): void; onDecided(): void;
}) {
  const adapter = adapterFor(ctx);
  const today = ctx.D?.TODAY_S ?? new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<DecisionForm>(emptyDecision);
  const [errors, setErrors] = useState<ReturnType<typeof decisionErrors>>({});
  const mutation = useMutation((body: DecideBody) => asApiResult(adapter.decide(ms, body)));
  const set = (patch: Partial<DecisionForm>) => {
    setForm((c) => ({ ...c, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch) as (keyof DecisionForm)[]) delete next[k];
      return next;
    });
  };
  const submit = () => {
    const found = decisionErrors(form, today);
    setErrors(found);
    if (Object.keys(found).length) return;
    ctx.track(mutation.submit(decisionBody(reviews.map((r) => r.id), form))).then((res) => {
      if (res.ok) onDecided();
    }, () => undefined);
  };
  const f = mutation.fields;
  const general = mutation.error && !f.keepUntil && !f.extendMonths && !f.reason ? mutation.error : null;
  return (
    <Modal
      open
      title={ctx.fill(TEXT.decisionTitle, { n: reviews.length })}
      sub={TEXT.decisionSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.saveDecision)}</Button>
        </>
      )}
    >
      {general ? <Alert tone="bad">{ctx.li(general.message)}</Alert> : null}
      <ul className="mx-small" style={{ margin: '0 0 12px', paddingLeft: 18 }}>
        {reviews.slice(0, 6).map((r) => <li key={r.id} style={{ overflowWrap: 'anywhere' }}>{itemLabel(r)}</li>)}
        {reviews.length > 6 ? <li>{`+${reviews.length - 6}`}</li> : null}
      </ul>
      <Radio
        legend={TEXT.fDecision}
        name="decision"
        value={form.decision}
        onChange={(v) => set({ decision: v as DecisionForm['decision'] })}
        options={[{ value: 'keep', label: TEXT.dKeep }, { value: 'extend', label: TEXT.dExtend }, { value: 'dispose', label: TEXT.dDispose }]}
      />
      {errors.decision ? <span className="mx-error" role="alert">{ctx.li(errors.decision)}</span> : null}
      {form.decision === 'keep' ? (
        <Field label={TEXT.fKeepUntil} error={errors.keepUntil ?? f.keepUntil ?? null} required>
          <DateInput name="keepUntil" value={form.keepUntil} min={today} onChange={(v) => set({ keepUntil: v })} />
        </Field>
      ) : null}
      {form.decision === 'extend' ? (
        <Field label={TEXT.fExtendMonths} hint={TEXT.fMonthsHint} error={errors.months ?? f.extendMonths ?? null} required>
          <TextInput name="months" type="number" value={form.months} onChange={(v) => set({ months: v })} />
        </Field>
      ) : null}
      {form.decision === 'dispose' ? <Alert tone="warn">{ctx.li(TEXT.disposeWarning)}</Alert> : null}
      <Field label={TEXT.fReason} error={errors.reason ?? f.reason ?? null} required>
        <Textarea name="reason" rows={3} maxLength={1000} value={form.reason} onChange={(v) => set({ reason: v })} />
      </Field>
    </Modal>
  );
}

/** What happened to a review before (a rejected disposal, or the decision of an earlier review of the item). */
function earlierStep(ctx: HostContext, r: ReviewModel): string | null {
  if (r.rejectedNote) return ctx.fill(TEXT.rejectedBefore, { note: r.rejectedNote });
  return null;
}

export function DueTab({ ctx, ms }: { ctx: HostContext; ms: MsId }) {
  const adapter = adapterFor(ctx);
  const manage = mayManage(ctx, ms);
  const [recordClass, setRecordClass] = useState<RecordClass | ''>('');
  const [page, setPage] = useState(1);
  const list = useLoad(() => adapter.reviews(ms, { status: 'open', ...(recordClass ? { recordClass } : {}), page, pageSize: PAGE_SIZE }), [ms, recordClass, page]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deciding, setDeciding] = useState(false);
  const [holding, setHolding] = useState<ReviewModel | null>(null);
  useEffect(() => setSelected(new Set()), [ms, recordClass, page]);
  const rows = list.data?.items ?? [];
  const chosen = rows.filter((r) => selected.has(r.id));
  const toggle = (id: string, on: boolean) => setSelected((s) => {
    const next = new Set(s);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const columns: Column<ReviewModel>[] = [
    ...(manage ? [{
      key: 'select', label: TEXT.select, width: 72,
      render: (r: ReviewModel) => <RowCheck name={`select-${r.id}`} checked={selected.has(r.id)} onChange={(on) => toggle(r.id, on)} label={ctx.fill(TEXT.selectItem, { code: itemLabel(r) })} />,
    }] : []),
    { key: 'item', label: TEXT.colItem, render: (r) => <ItemCell row={r} /> },
    { key: 'class', label: TEXT.colClass, render: (r) => ctx.li(CLASS_TEXT[r.recordClass]) },
    { key: 'ended', label: TEXT.colEnded, render: (r) => formatDay(r.retentionEndsOn, ctx.lang) },
    { key: 'last', label: TEXT.colLast, render: (r) => earlierStep(ctx, r) ?? <span className="mx-muted">{ctx.li(TEXT.none)}</span> },
    ...(manage ? [{ key: 'actions', label: TEXT.colActions, render: (r: ReviewModel) => <Button variant="link" onClick={() => setHolding(r)}>{ctx.li(TEXT.placeHold)}</Button> }] : []),
  ];
  const total = list.data?.total ?? 0;
  return (
    <Card
      title={TEXT.dueTitle}
      sub={TEXT.dueSub}
      flush
      actions={manage ? (
        <Button variant="primary" disabledReason={chosen.length ? null : TEXT.selectFirst} onClick={() => setDeciding(true)}>
          {chosen.length ? ctx.fill(TEXT.decideSelected, { n: chosen.length }) : ctx.li(TEXT.decide)}
        </Button>
      ) : null}
    >
      <div className="mx-row" style={{ padding: 12, alignItems: 'flex-end' }}>
        <div style={{ minWidth: 240 }}>
          <Field label={TEXT.filterClass}>
            <Select name="recordClass" value={recordClass} onChange={(v) => { setRecordClass(v as RecordClass | ''); setPage(1); }} empty={TEXT.allClasses} options={RECORD_CLASSES.map((c) => ({ value: c, label: CLASS_TEXT[c] }))} />
          </Field>
        </div>
        {manage && rows.length > 0 ? (
          <Checkbox name="select-all" checked={allOn} onChange={(on) => setSelected(on ? new Set(rows.map((r) => r.id)) : new Set())} label={TEXT.selectAll} />
        ) : null}
      </div>
      {!manage ? <div style={{ padding: '0 12px 12px' }}><Alert tone="info">{ctx.li(TEXT.readOnly)}</Alert></div> : null}
      <LoadState ctx={ctx} list={list} />
      {list.data ? (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={<EmptyState title={TEXT.noDue} text={TEXT.noDueText} illustration={<Illustration scene="no-documents" size="sm" decorative />} />}
        />
      ) : null}
      <Pager page={page} pages={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPage={setPage} />
      {deciding && chosen.length ? (
        <DecisionDialog
          ctx={ctx}
          ms={ms}
          reviews={chosen}
          onClose={() => setDeciding(false)}
          onDecided={() => {
            ctx.toast(ctx.fill(TEXT.decided, { n: chosen.length }));
            setDeciding(false);
            setSelected(new Set());
            noteRetentionChanged();
          }}
        />
      ) : null}
      {holding ? (
        <HoldDialog
          ctx={ctx}
          ms={ms}
          item={holding}
          onClose={() => setHolding(null)}
          onHeld={(code) => {
            ctx.toast(ctx.fill(TEXT.held, { code }));
            setHolding(null);
            noteRetentionChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

export function RejectDialog({ ctx, ms, review, onClose, onRejected }: { ctx: HostContext; ms: MsId; review: ReviewModel; onClose(): void; onRejected(): void }) {
  const adapter = adapterFor(ctx);
  const [note, setNote] = useState('');
  const [error, setError] = useState<ReturnType<typeof noteError>>(null);
  const mutation = useMutation((text: string) => asApiResult(adapter.reject(ms, review, text)));
  const submit = () => {
    const found = noteError(note, 500);
    setError(found);
    if (found) return;
    ctx.track(mutation.submit(note.trim())).then((res) => {
      if (res.ok) onRejected();
    }, () => undefined);
  };
  const general = mutation.error && !mutation.fields.note ? mutation.error : null;
  return (
    <Modal
      open
      title={ctx.fill(TEXT.rejectTitle, { code: itemLabel(review) })}
      sub={TEXT.rejectSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.reject)}</Button>
        </>
      )}
    >
      {general ? <Alert tone="bad">{ctx.li(general.message)}</Alert> : null}
      <Field label={TEXT.fNote} error={error ?? mutation.fields.note ?? null} required>
        <Textarea name="note" rows={3} maxLength={500} value={note} onChange={(v) => { setNote(v); setError(null); }} />
      </Field>
    </Modal>
  );
}

export function ApprovalTab({ ctx, ms }: { ctx: HostContext; ms: MsId }) {
  const adapter = adapterFor(ctx);
  const approver = mayApprove(ctx, ms);
  const [page, setPage] = useState(1);
  const list = useLoad(() => adapter.reviews(ms, { status: 'awaiting_approval', page, pageSize: PAGE_SIZE }), [ms, page]);
  const [approving, setApproving] = useState<ReviewModel | null>(null);
  const [rejecting, setRejecting] = useState<ReviewModel | null>(null);
  const approval = useMutation((r: ReviewModel) => asApiResult(adapter.approve(ms, r)));
  const confirm = () => {
    if (!approving) return;
    const code = itemLabel(approving);
    ctx.track(approval.submit(approving)).then((res) => {
      if (!res.ok) return;
      ctx.toast(res.data.message ? ctx.li(res.data.message) : ctx.fill(TEXT.approved, { code }));
      setApproving(null);
      noteRetentionChanged();
    }, () => undefined);
  };
  const columns: Column<ReviewModel>[] = [
    {
      key: 'item', label: TEXT.colItem,
      render: (r) => (
        <span style={{ display: 'block' }}>
          <ItemCell row={r} />
          {r.onHold ? <Badge tone="warn">{ctx.li(TEXT.heldNow)}</Badge> : null}
        </span>
      ),
    },
    { key: 'class', label: TEXT.colClass, render: (r) => ctx.li(CLASS_TEXT[r.recordClass]) },
    { key: 'ended', label: TEXT.colEnded, render: (r) => formatDay(r.retentionEndsOn, ctx.lang) },
    { key: 'proposed', label: TEXT.colProposed, render: (r) => <PersonAt ctx={ctx} who={r.decidedBy} at={r.decidedAt} /> },
    { key: 'reason', label: TEXT.colReason, render: (r) => <span style={{ overflowWrap: 'anywhere' }}>{r.reason ?? '-'}</span> },
    ...(approver ? [{
      key: 'actions', label: TEXT.colActions,
      render: (r: ReviewModel) => (
        <span className="mx-row" style={{ alignItems: 'flex-start' }}>
          <Button variant="primary" disabledReason={proposedByMe(ctx, r) ? TEXT.youProposed : null} onClick={() => { approval.reset(); setApproving(r); }}>{ctx.li(TEXT.approve)}</Button>
          <Button onClick={() => setRejecting(r)}>{ctx.li(TEXT.reject)}</Button>
        </span>
      ),
    }] : []),
  ];
  const total = list.data?.total ?? 0;
  return (
    <Card title={TEXT.approvalTitle} sub={TEXT.approvalSub} flush>
      <LoadState ctx={ctx} list={list} />
      {list.data ? (
        <Table
          columns={columns}
          rows={list.data.items}
          rowKey={(r) => r.id}
          empty={<EmptyState title={TEXT.noApproval} text={TEXT.noApprovalText} illustration={<Illustration scene="no-documents" size="sm" decorative />} />}
        />
      ) : null}
      <Pager page={page} pages={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPage={setPage} />
      <ConfirmDialog
        open={Boolean(approving)}
        title={approving ? ctx.fill(TEXT.approveTitle, { code: itemLabel(approving) }) : TEXT.approveConfirm}
        body={<p style={{ margin: 0 }}>{ctx.li(TEXT.approveBody)}</p>}
        confirmLabel={TEXT.approveConfirm}
        tone="bad"
        busy={approval.busy}
        error={approval.error ? approval.error.message : null}
        onConfirm={confirm}
        onCancel={() => setApproving(null)}
      />
      {rejecting ? (
        <RejectDialog
          ctx={ctx}
          ms={ms}
          review={rejecting}
          onClose={() => setRejecting(null)}
          onRejected={() => {
            ctx.toast(ctx.fill(TEXT.rejected, { code: itemLabel(rejecting) }));
            setRejecting(null);
            noteRetentionChanged();
          }}
        />
      ) : null}
    </Card>
  );
}
