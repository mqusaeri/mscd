// Holds of Retention and disposal (MILESTONE-3 M3-06, D.8): legal holds in force and released, "New hold" (record type
// and code, or a record of the review list through "Place on hold") and "Release" with a reason, for the Management
// System Manager (`retention.manage`).
import { useState } from 'react';
import type { MsId } from '../../data/types';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext } from '../types';
import { Alert, Badge, Button, Card, EmptyState, Field, Modal, Select, Table, TextInput, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import { formatInstant } from '../auditor-access/shared';
import { adapterFor } from './adapter';
import type { HoldBody, HoldForm, HoldModel, RecordClass, ReviewModel } from './model';
import { CLASS_TEXT, RECORD_CLASSES, asApiResult, holdErrors, itemLabel, mayManage, noteError } from './model';
import { LoadState, PersonAt, useLoad } from './parts';
import { noteRetentionChanged } from './store';
import { TEXT } from './text';

/** "Place a record on hold": a record of the review list (`item`), or a record type and code. */
export function HoldDialog({ ctx, ms, item, onClose, onHeld }: {
  ctx: HostContext; ms: MsId; item: Pick<ReviewModel, 'recordClass' | 'itemId' | 'itemCode' | 'itemTitle'> | null; onClose(): void; onHeld(code: string): void;
}) {
  const adapter = adapterFor(ctx);
  const [form, setForm] = useState<HoldForm>({ recordClass: item?.recordClass ?? '', code: '', reason: '' });
  const [errors, setErrors] = useState<ReturnType<typeof holdErrors>>({});
  const [key] = useState(newIdempotencyKey);
  const mutation = useMutation((body: HoldBody) => asApiResult(adapter.createHold(ms, body, key)));
  const set = (patch: Partial<HoldForm>) => {
    setForm((c) => ({ ...c, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch) as (keyof HoldForm)[]) delete next[k];
      return next;
    });
  };
  const submit = () => {
    const found = holdErrors(form, Boolean(item));
    setErrors(found);
    if (Object.keys(found).length) return;
    const body: HoldBody = item
      ? { recordClass: item.recordClass, itemId: item.itemId, reason: form.reason.trim() }
      : { recordClass: form.recordClass as RecordClass, itemCode: form.code.trim(), reason: form.reason.trim() };
    const code = item ? itemLabel({ ...item, itemTitle: item.itemTitle ?? null }) : form.code.trim();
    ctx.track(mutation.submit(body)).then((res) => {
      if (res.ok) onHeld(code);
    }, () => undefined);
  };
  const f = mutation.fields;
  const general = mutation.error && !f.itemCode && !f.reason && !f.recordClass ? mutation.error : null;
  return (
    <Modal
      open
      title={TEXT.holdTitle}
      sub={TEXT.holdSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.placeHoldAction)}</Button>
        </>
      )}
    >
      {general ? <Alert tone="bad">{ctx.li(general.message)}</Alert> : null}
      {item ? (
        <p style={{ margin: '0 0 12px' }}>
          <strong>{ctx.fill(TEXT.holdItem, { code: itemLabel({ ...item, itemTitle: item.itemTitle ?? null }) })}</strong>
          <span className="mx-small" style={{ display: 'block' }}>{ctx.li(CLASS_TEXT[item.recordClass])}</span>
        </p>
      ) : (
        <>
          <Field label={TEXT.fClass} error={errors.recordClass ?? f.recordClass ?? null} required>
            <Select name="recordClass" value={form.recordClass} onChange={(v) => set({ recordClass: v as RecordClass | '' })} empty={TEXT.chooseClass} options={RECORD_CLASSES.map((c) => ({ value: c, label: CLASS_TEXT[c] }))} />
          </Field>
          <Field label={TEXT.fCode} hint={TEXT.fCodeHint} error={errors.code ?? f.itemCode ?? null} required>
            <TextInput name="code" value={form.code} maxLength={60} onChange={(v) => set({ code: v })} autoComplete="off" />
          </Field>
        </>
      )}
      <Field label={TEXT.fReason} error={errors.reason ?? f.reason ?? null} required>
        <Textarea name="reason" rows={3} maxLength={500} value={form.reason} onChange={(v) => set({ reason: v })} />
      </Field>
    </Modal>
  );
}

export function ReleaseDialog({ ctx, ms, hold, onClose, onReleased }: { ctx: HostContext; ms: MsId; hold: HoldModel; onClose(): void; onReleased(): void }) {
  const adapter = adapterFor(ctx);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ReturnType<typeof noteError>>(null);
  const mutation = useMutation((text: string) => asApiResult(adapter.releaseHold(ms, hold, text)));
  const submit = () => {
    const found = noteError(reason, 500);
    setError(found);
    if (found) return;
    ctx.track(mutation.submit(reason.trim())).then((res) => {
      if (res.ok) onReleased();
    }, () => undefined);
  };
  const general = mutation.error && !mutation.fields.reason ? mutation.error : null;
  return (
    <Modal
      open
      title={ctx.fill(TEXT.releaseTitle, { code: hold.itemCode ?? hold.itemId.slice(0, 8) })}
      sub={TEXT.releaseSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.release)}</Button>
        </>
      )}
    >
      {general ? <Alert tone="bad">{ctx.li(general.message)}</Alert> : null}
      <Field label={TEXT.fReason} error={error ?? mutation.fields.reason ?? null} required>
        <Textarea name="reason" rows={3} maxLength={500} value={reason} onChange={(v) => { setReason(v); setError(null); }} />
      </Field>
    </Modal>
  );
}

export function HoldsTab({ ctx, ms }: { ctx: HostContext; ms: MsId }) {
  const adapter = adapterFor(ctx);
  const manage = mayManage(ctx, ms);
  const list = useLoad(() => adapter.holds(ms), [ms]);
  const [creating, setCreating] = useState(false);
  const [releasing, setReleasing] = useState<HoldModel | null>(null);
  const columns: Column<HoldModel>[] = [
    { key: 'item', label: TEXT.colItem, render: (h) => <strong className="mx-mono" style={{ overflowWrap: 'anywhere' }}>{h.itemCode ?? h.itemId.slice(0, 8)}</strong> },
    { key: 'class', label: TEXT.colClass, render: (h) => ctx.li(CLASS_TEXT[h.recordClass]) },
    { key: 'reason', label: TEXT.colReason, render: (h) => <span style={{ overflowWrap: 'anywhere' }}>{h.reason}</span> },
    { key: 'set', label: TEXT.colSet, render: (h) => <PersonAt ctx={ctx} who={h.setBy} at={h.setAt} /> },
    {
      key: 'status', label: TEXT.colStatus,
      render: (h) => (h.releasedAt ? (
        <span style={{ display: 'block' }}>
          <Badge tone="mute">{ctx.li(TEXT.released)}</Badge>
          <span className="mx-small" style={{ display: 'block', marginTop: 4, overflowWrap: 'anywhere' }}>
            {ctx.fill(TEXT.releasedLine, { name: h.releasedBy?.displayName ?? '-', date: formatInstant(h.releasedAt, ctx.lang), reason: h.releaseReason ?? '' })}
          </span>
        </span>
      ) : <Badge tone="warn">{ctx.li(TEXT.inForce)}</Badge>),
    },
    ...(manage ? [{ key: 'actions', label: TEXT.colActions, render: (h: HoldModel) => (h.releasedAt ? null : <Button onClick={() => setReleasing(h)}>{ctx.li(TEXT.release)}</Button>) }] : []),
  ];
  return (
    <Card title={TEXT.holdsTitle} sub={TEXT.holdsSub} flush actions={manage ? <Button variant="primary" onClick={() => setCreating(true)}>{ctx.li(TEXT.newHold)}</Button> : null}>
      <LoadState ctx={ctx} list={list} />
      {list.data ? (
        <Table
          columns={columns}
          rows={list.data}
          rowKey={(h) => h.id}
          empty={<EmptyState title={TEXT.noHolds} text={TEXT.noHoldsText} illustration={<Illustration scene="no-documents" size="sm" decorative />} />}
        />
      ) : null}
      {creating ? (
        <HoldDialog
          ctx={ctx}
          ms={ms}
          item={null}
          onClose={() => setCreating(false)}
          onHeld={(code) => {
            ctx.toast(ctx.fill(TEXT.held, { code }));
            setCreating(false);
            noteRetentionChanged();
          }}
        />
      ) : null}
      {releasing ? (
        <ReleaseDialog
          ctx={ctx}
          ms={ms}
          hold={releasing}
          onClose={() => setReleasing(null)}
          onReleased={() => {
            ctx.toast(ctx.li(TEXT.releasedToast));
            setReleasing(null);
            noteRetentionChanged();
          }}
        />
      ) : null}
    </Card>
  );
}
