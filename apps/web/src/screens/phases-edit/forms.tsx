// The activity forms (MILESTONE-2 M2-11): the activity panel of the `activity` detail with "Start" (activity transition
// to In progress, refused by BR-12 behind an unverified critical gate) and "Record blocker" (claim
// `phases.recordBlocker`): a gate item of the snapshot and what is holding the activity, then the transition to
// blocked (BR-39), with the BR-46 count of the gate phase before and after. Product decision 4: phases show in order and
// the hard block applies only at critical gates; these forms add no block of their own.
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { Activity, MsId } from '../../data/types';
import { useMutation } from '../api';
import type { DetailProps, HostContext, TextPair } from '../types';
import { Alert, Button, Field, Modal, RecordPicker, Textarea, UI_TEXT } from '../ui';
import { mayActOn, personName, refFor, reloadChanged } from '../controls-edit/common';
import { FormFooter, asApi, placeErrors, useAdapterOf } from '../controls-edit/parts';
import { adapterFor } from './adapter';
import { checkBlocker, gateChoices, gateConsistency } from './model';
import type { ActivityRef } from './model';
import { TEXT } from './text';

/** The activity a write is for, with the uuid and ETag of the latest snapshot (D.1). */
export function activityRefOf(ctx: Pick<HostContext, 'D'>, ms: MsId, activity: Pick<Activity, 'key' | 'no'>): ActivityRef {
  const ref = refFor(ctx.D, activity.key);
  return { ms, key: activity.key, no: activity.no, uuid: ref?.id ?? null, etag: ref?.etag ?? null };
}

/** True when the session may move the activity: the MS Manager, or its owner with an own grant (C.13). */
export function mayWorkOn(ctx: HostContext, ms: MsId, activity: Pick<Activity, 'owner'>): boolean {
  return mayActOn(ctx, ms, 'activity.transition', activity.owner) || ctx.can(ms, 'activity.verify');
}

export function ActivityPanel({ ctx, ms, record }: DetailProps) {
  const activity = record as Activity;
  const headingId = useId();
  const adapter = useAdapterOf(ctx, adapterFor);
  const mutation = useMutation(() => adapter.start(activityRefOf(ctx, ms, activity)).then(asApi));
  if (!activity || activity.st !== 'ns' || !mayActOn(ctx, ms, 'activity.transition', activity.owner)) return null;
  const start = async () => {
    const res = await ctx.track(mutation.submit(undefined));
    if (!res.ok) return;
    ctx.toast(ctx.fill(TEXT.started, { no: activity.no }));
    await reloadChanged(ctx, res.data.changed, ms);
  };
  return (
    <section className="mx-m11-panel" aria-labelledby={headingId} data-m11="activity">
      <h3 id={headingId} className="mx-m11-panel-title">{ctx.li(TEXT.panelTitle)}</h3>
      <div className="mx-btn-group">
        <Button onClick={() => void start()} busy={mutation.busy} disabledReason={ctx.mode === 'api' ? null : TEXT.sampleStart}>{ctx.li(TEXT.start)}</Button>
        {ctx.mode === 'api' ? <span className="mx-small">{ctx.li(TEXT.startHint)}</span> : null}
      </div>
      {mutation.error ? <Alert tone="bad">{ctx.li(mutation.error.message)}</Alert> : null}
    </section>
  );
}

export function BlockerDialog({ ctx, ms, activity, onClose }: { ctx: HostContext; ms: MsId; activity: Activity; onClose(): void }) {
  const formId = useId();
  const adapter = useAdapterOf(ctx, adapterFor);
  const [gate, setGate] = useState('');
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<Record<string, TextPair>>({});
  const mutation = useMutation((input: { gate: string; reason: string }) => adapter.block(activityRefOf(ctx, ms, activity), input.gate, input.reason).then(asApi));
  const placed = placeErrors(mutation.error, ctx.li, { blockerGateItemRef: 'gate', blockerReason: 'reason' }, { 'BR-39': 'gate' });
  const fieldError = (field: string) => (local[field] ? ctx.li(local[field]) : placed.fields[field] || null);
  const gates = gateChoices(ctx.D, ms);
  const before = gateConsistency(ctx.D, ms, activity);
  const records = gates.map((g) => ({
    id: g.id,
    title: ctx.li(g.why),
    note: g.blocks.length
      ? ctx.fill(TEXT.gateItemBlocks, { type: ctx.li(g.type), activities: g.blocks.join(', ') })
      : ctx.fill(TEXT.gateItemNote, { type: ctx.li(g.type), holder: personName(ctx.D, g.holder) }),
  }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems = checkBlocker(gate, reason);
    setLocal(problems);
    if (Object.keys(problems).length) return;
    const res = await ctx.track(mutation.submit({ gate, reason }));
    if (!res.ok) return;
    ctx.toast(ctx.fill(TEXT.recorded, { gate }));
    onClose();
    await reloadChanged(ctx, res.data.changed, ms);
  };
  return (
    <Modal
      open
      title={ctx.fill(TEXT.blockerTitle, { no: activity.no })}
      sub={`${activity.title}. ${ctx.li(TEXT.blockerSub)}`}
      onClose={onClose}
      footer={gates.length
        ? <FormFooter busy={mutation.busy} onCancel={onClose} submitLabel={TEXT.recordButton} form={formId} />
        : <Button variant="primary" onClick={onClose}>{ctx.li(UI_TEXT.close)}</Button>}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate>
        {placed.general ? <Alert tone="bad">{ctx.li(placed.general.message)}</Alert> : null}
        {!gates.length ? <Alert tone="info">{ctx.li(TEXT.noGateItems)}</Alert> : (
          <>
            {before ? (
              <Alert tone={before.blocked === before.open ? 'info' : 'warn'}>
                {ctx.fill(TEXT.consistency, before)}
                {before.blocked !== before.open ? ` ${ctx.li(TEXT.mismatch)}` : ''}
              </Alert>
            ) : null}
            <Field label={TEXT.gateItem} error={fieldError('gate')} required>
              <RecordPicker value={gate} onChange={setGate} records={records} limit={60} />
            </Field>
            <Field label={TEXT.reason} hint={TEXT.reasonHint} error={fieldError('reason')} required>
              <Textarea name="blockerReason" value={reason} onChange={setReason} rows={3} maxLength={1000} />
            </Field>
          </>
        )}
      </form>
    </Modal>
  );
}
