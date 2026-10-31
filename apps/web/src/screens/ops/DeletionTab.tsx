// Deletion tab of the organisation drawer (MILESTONE-3 M3-09, D.5): the verified deletion of the organisation
// (`ops.deletion.get`) with its status and dates, "Change date" or "Schedule deletion" (not earlier than archiving plus
// 7 days, with a reason and the slug typed again), "Cancel deletion", "Retry" of a failed purge from its failed step,
// the steps and checks of the purge, and "Download certificate" once it has completed. The purge itself runs only on
// its date (A.2); nothing here starts it early. Refusals (409 `deletion_not_archived`, `deletion_too_soon`,
// `deletion_in_progress`, 422 `confirmation_mismatch`) show the server's message.
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation } from '../api';
import { saveFile } from '../auditor-access/shared';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, DateInput, Facts, Field, Modal, Table, TextInput, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { LoadState, asApi, useLoad } from './Health';
import {
  DELETION_STATUS_TEXT, DELETION_STATUS_TONE, EMPTY_SCHEDULE, STEP_STATUS_TEXT, STEP_STATUS_TONE, minScheduleDay, reasonError, scheduleAction, scheduleBody,
  scheduleErrors, scheduleForm, stepLabel, instantDay,
} from './lifecycle-model';
import type { DeletionDone, DeletionSchedule, DeletionStep, DeletionView, ScheduleForm } from './lifecycle-model';
import { LIFE_TEXT } from './lifecycle-text';
import type { OpsAdapter } from './model';
import { DELETION_GRACE_DAYS, dayText, refusalText, todayOf, whenText } from './org-model';
import type { OrgDetail } from './org-model';

/** Now on the controller's day (the sample's day, the organisation's local date) at the current time, else the browser's. */
export function nowOf(ctx: Pick<HostContext, 'D'>): Date {
  const now = new Date();
  const day = todayOf(ctx);
  const pad = (n: number) => String(n).padStart(2, '0');
  const at = new Date(`${day}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);
  return Number.isNaN(at.getTime()) ? now : at;
}

/** The facts of a deletion. */
export function DeletionFacts({ ctx, view }: { ctx: HostContext; view: DeletionView }) {
  const day = (instant: string | null) => (instant ? dayText(ctx, instantDay(instant)) : '-');
  return (
    <Facts
      items={[
        { label: LIFE_TEXT.factStatus, value: <Badge tone={DELETION_STATUS_TONE[view.status]}>{ctx.li(DELETION_STATUS_TEXT[view.status])}</Badge> },
        { label: LIFE_TEXT.factScheduledFor, value: <span data-deletion-date={instantDay(view.scheduledFor)}>{day(view.scheduledFor)}</span> },
        { label: LIFE_TEXT.factScheduledBy, value: view.scheduledBy ? view.scheduledBy.displayName : ctx.li(LIFE_TEXT.bySystem) },
        { label: LIFE_TEXT.factReason, value: view.reason ? <span style={{ overflowWrap: 'anywhere' }}>{view.reason}</span> : '-' },
        { label: LIFE_TEXT.factArchived, value: day(view.archivedAt) },
        { label: LIFE_TEXT.factEarliest, value: day(view.earliestAllowed) },
        { label: LIFE_TEXT.factFinalExport, value: ctx.li(view.finalExportId ? LIFE_TEXT.finalTaken : LIFE_TEXT.finalNone) },
        ...(view.startedAt ? [{ label: LIFE_TEXT.factStarted, value: whenText(ctx, view.startedAt) }] : []),
        ...(view.completedAt ? [{ label: LIFE_TEXT.factCompleted, value: whenText(ctx, view.completedAt) }] : []),
        ...(view.failedStep ? [{ label: LIFE_TEXT.factFailedStep, value: ctx.li(stepLabel(view.failedStep)) }] : []),
        ...(view.error ? [{ label: LIFE_TEXT.factError, value: <span className="mx-mono" style={{ overflowWrap: 'anywhere' }}>{view.error}</span> }] : []),
        ...(view.vaultObjectsDeleted !== null ? [{ label: LIFE_TEXT.factVault, value: view.vaultObjectsDeleted }] : []),
        ...(view.certificateId ? [{ label: LIFE_TEXT.factCertificate, value: view.certificateId, mono: true }] : []),
      ]}
    />
  );
}

/** The steps of the purge and the checks of its result, as recorded. */
export function StepsTable({ ctx, steps }: { ctx: HostContext; steps: DeletionStep[] }) {
  const columns: Column<DeletionStep>[] = [
    { key: 'step', label: LIFE_TEXT.colStep, render: (s) => <span data-step={s.step}>{ctx.li(stepLabel(s.step))}</span> },
    { key: 'status', label: LIFE_TEXT.colStepStatus, render: (s) => <Badge tone={STEP_STATUS_TONE[s.status]}>{ctx.li(STEP_STATUS_TEXT[s.status])}</Badge> },
    { key: 'at', label: LIFE_TEXT.colStepAt, render: (s) => (s.at ? <span style={{ whiteSpace: 'nowrap' }}>{whenText(ctx, s.at)}</span> : '-') },
    { key: 'detail', label: LIFE_TEXT.colStepDetail, render: (s) => (s.detail ? <span style={{ overflowWrap: 'anywhere' }}>{s.detail}</span> : '-') },
  ];
  return <Table columns={columns} rows={steps} rowKey={(s) => s.step} />;
}

type ScheduleErrors = Partial<Record<'day' | 'reason' | 'confirmSlug', TextPair>>;

/** "Change date" or "Schedule deletion": the date (not earlier than the earliest allowed one), a reason and the slug. */
export function ScheduleDialog({ ctx, adapter, detail, view, mode, onClose, onDone }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  detail: OrgDetail;
  view: DeletionView | null;
  mode: 'change' | 'schedule' | null;
  onClose(): void;
  onDone(done: DeletionDone): void;
}) {
  const [form, setForm] = useState<ScheduleForm>(EMPTY_SCHEDULE);
  const [shown, setShown] = useState<ScheduleErrors>({});
  const run = useCallback((body: DeletionSchedule) => adapter.scheduleDeletion(detail.slug, body).then(asApi), [adapter, detail.slug]);
  const mutation = useMutation<DeletionSchedule, DeletionDone>(run);
  const { reset } = mutation;
  useEffect(() => {
    setForm(scheduleForm(view));
    setShown({});
    reset();
  }, [mode]);
  if (!mode) return null;
  const minDay = minScheduleDay(view, todayOf(ctx));
  const set = (field: keyof ScheduleForm) => (value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setShown((s) => ({ ...s, [field === 'confirm' ? 'confirmSlug' : field]: undefined }));
    mutation.reset();
  };
  const submit = () => {
    const errors = scheduleErrors(detail.slug, form, minDay);
    setShown(errors);
    if (Object.keys(errors).length) return;
    void ctx.track(mutation.submit(scheduleBody(form, view, nowOf(ctx)))).then((res) => {
      if (res.ok) onDone(res.data);
    }, () => undefined);
  };
  const action = mode === 'change' ? LIFE_TEXT.changeDate : LIFE_TEXT.scheduleDeletion;
  const fields = mutation.fields;
  const error = mutation.error;
  const general = error && !fields.reason && !fields.confirmSlug && !fields.scheduledFor ? refusalText(error) : null;
  const minText = dayText(ctx, minDay);
  return (
    <Modal
      open
      title={ctx.fill(LIFE_TEXT.scheduleTitle, { action: ctx.li(action), org: detail.name })}
      sub={LIFE_TEXT.scheduleSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="danger" busy={mutation.busy} onClick={submit}>{ctx.li(action)}</Button>
        </>
      )}
    >
      <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate data-deletion-form={mode}>
        <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--tx)' }}>
          {[LIFE_TEXT.schedule1, LIFE_TEXT.schedule2].map((t) => <li key={t[0]} style={{ marginTop: 4 }}>{ctx.li(t)}</li>)}
        </ul>
        <Field label={LIFE_TEXT.day} hint={ctx.fill(LIFE_TEXT.dayHint, { date: minText })} error={shown.day ? ctx.fill(shown.day, { date: minText }) : (fields.scheduledFor ?? null)} required>
          <DateInput value={form.day} onChange={set('day')} min={minDay} />
        </Field>
        <Field label={LIFE_TEXT.reason} hint={LIFE_TEXT.reasonHint} error={shown.reason ?? fields.reason ?? null} required>
          <Textarea value={form.reason} onChange={set('reason')} rows={3} maxLength={500} />
        </Field>
        <Field label={ctx.fill(LIFE_TEXT.confirmSlug, { slug: detail.slug })} error={shown.confirmSlug ? ctx.fill(shown.confirmSlug, { slug: detail.slug }) : (fields.confirmSlug ?? null)} required>
          <TextInput value={form.confirm} onChange={set('confirm')} autoComplete="off" maxLength={40} />
        </Field>
        {general ? <Alert tone="bad">{ctx.li(general)}</Alert> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** "Cancel deletion" or "Retry": what it does, then the reason. */
export function ReasonDialog({ ctx, adapter, detail, view, kind, onClose, onDone }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  detail: OrgDetail;
  view: DeletionView;
  kind: 'cancel' | 'retry' | null;
  onClose(): void;
  onDone(done: DeletionDone): void;
}) {
  const [reason, setReason] = useState('');
  const [shown, setShown] = useState<TextPair | null>(null);
  const run = useCallback(
    (input: { kind: 'cancel' | 'retry'; reason: string }) => (input.kind === 'cancel' ? adapter.cancelDeletion(detail.slug, input.reason) : adapter.retryDeletion(detail.slug, input.reason)).then(asApi),
    [adapter, detail.slug],
  );
  const mutation = useMutation<{ kind: 'cancel' | 'retry'; reason: string }, DeletionDone>(run);
  const { reset } = mutation;
  useEffect(() => {
    setReason('');
    setShown(null);
    reset();
  }, [kind]);
  if (!kind) return null;
  const step = ctx.li(stepLabel(view.failedStep ?? 'check'));
  const submit = () => {
    const error = reasonError(reason);
    setShown(error);
    if (error) return;
    void ctx.track(mutation.submit({ kind, reason: reason.trim() })).then((res) => {
      if (res.ok) onDone(res.data);
    }, () => undefined);
  };
  const cancel = kind === 'cancel';
  const lines = cancel ? [ctx.li(LIFE_TEXT.cancel1), ctx.li(LIFE_TEXT.cancel2)] : [ctx.fill(LIFE_TEXT.retry1, { step }), ctx.li(LIFE_TEXT.retry2)];
  const general = mutation.error && !mutation.fields.reason ? refusalText(mutation.error) : null;
  return (
    <Modal
      open
      title={ctx.fill(cancel ? LIFE_TEXT.cancelTitle : LIFE_TEXT.retryTitle, { org: detail.name })}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(cancel ? LIFE_TEXT.keep : UI_TEXT.cancel)}</Button>
          <Button variant={cancel ? 'danger' : 'primary'} busy={mutation.busy} onClick={submit}>{ctx.li(cancel ? LIFE_TEXT.cancelDeletion : LIFE_TEXT.retry)}</Button>
        </>
      )}
    >
      <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate data-deletion-reason={kind}>
        <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--tx)' }}>
          {lines.map((t) => <li key={t} style={{ marginTop: 4 }}>{t}</li>)}
        </ul>
        <Field label={LIFE_TEXT.reason} hint={LIFE_TEXT.reasonHint} error={shown ?? mutation.fields.reason ?? null} required>
          <Textarea value={reason} onChange={(v) => { setReason(v); setShown(null); mutation.reset(); }} rows={3} maxLength={500} />
        </Field>
        {general ? <Alert tone="bad">{ctx.li(general)}</Alert> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** What the tab says when the organisation has no deletion, by its status. */
function NoDeletion({ ctx, detail }: { ctx: HostContext; detail: OrgDetail }) {
  let text: string;
  if (detail.status === 'offboarding' && detail.offboardingEndsAt) {
    text = ctx.fill(LIFE_TEXT.noDeletionOffboarding, { end: dayText(ctx, instantDay(detail.offboardingEndsAt)), days: DELETION_GRACE_DAYS });
  } else if (detail.status === 'archived') text = ctx.li(LIFE_TEXT.noDeletionArchived);
  else text = ctx.li(LIFE_TEXT.noDeletionActive);
  return <span className="mx-muted" data-no-deletion={detail.status}>{text}</span>;
}

export function DeletionTab({ ctx, adapter, detail, tick, onChanged }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  detail: OrgDetail;
  tick: number;
  onChanged(): void;
}) {
  const [scheduling, setScheduling] = useState<'change' | 'schedule' | null>(null);
  const [reasonKind, setReasonKind] = useState<'cancel' | 'retry' | null>(null);
  const [failure, setFailure] = useState<TextPair | null>(null);
  const load = useCallback(() => adapter.deletion(detail.slug), [adapter, detail.slug, tick]);
  const { result, reload } = useLoad<DeletionView | null>(load);
  const [shown, setShown] = useState<{ view: DeletionView | null } | null>(null);
  useEffect(() => {
    if (result && result.ok) setShown({ view: result.data });
  }, [result]);
  const canManage = ctx.platformCan('ops.tenants.manage');
  const done = (outcome: DeletionDone, text: TextPair) => {
    setScheduling(null);
    setReasonKind(null);
    ctx.toast(outcome.message ? ctx.li(outcome.message) : ctx.fill(text, { org: detail.name, date: dayText(ctx, instantDay(outcome.scheduledFor)) }));
    onChanged();
  };
  const download = () => {
    setFailure(null);
    void adapter.certificate(detail.slug).then((res) => {
      // The api build saves through the api's link, so the browser alone knows whether the file arrived: the toast
      // says the download started and claims nothing more.
      if (res.ok) {
        saveFile(res.data);
        ctx.toast(ctx.li(LIFE_TEXT.certificateStarted));
      } else setFailure(res.error.message);
    }, () => undefined);
  };
  if (!shown) return <Card><LoadState ctx={ctx} result={result} failed={LIFE_TEXT.deletionFailed} retry={reload} /></Card>;
  const view = shown.view;
  const action = scheduleAction(detail.status, view);
  const buttons: ReactElement[] = [];
  if (canManage && action) buttons.push(<Button key="date" variant={action === 'schedule' ? 'danger' : 'default'} onClick={() => setScheduling(action)}>{ctx.li(action === 'change' ? LIFE_TEXT.changeDate : LIFE_TEXT.scheduleDeletion)}</Button>);
  if (canManage && view?.status === 'scheduled') buttons.push(<Button key="cancel" onClick={() => setReasonKind('cancel')}>{ctx.li(LIFE_TEXT.cancelDeletion)}</Button>);
  if (canManage && view?.status === 'failed') buttons.push(<Button key="retry" variant="primary" onClick={() => setReasonKind('retry')}>{ctx.li(LIFE_TEXT.retry)}</Button>);
  if (view?.status === 'completed') buttons.push(<Button key="certificate" variant="primary" onClick={download}>{ctx.li(LIFE_TEXT.downloadCertificate)}</Button>);
  const managedHere = Boolean(action) || view?.status === 'scheduled' || view?.status === 'failed';
  return (
    <>
      <Card title={LIFE_TEXT.deletion} sub={LIFE_TEXT.deletionSub} actions={buttons.length ? <>{buttons}</> : null}>
        <div className="mx-stack" data-deletion={view ? view.status : 'none'}>
          {view ? <DeletionFacts ctx={ctx} view={view} /> : <NoDeletion ctx={ctx} detail={detail} />}
          {view?.status === 'running' ? <Alert tone="info">{ctx.li(LIFE_TEXT.runningNote)}</Alert> : null}
          {view?.status === 'failed' ? <Alert tone="bad">{ctx.fill(LIFE_TEXT.failedNote, { step: ctx.li(stepLabel(view.failedStep ?? 'check')) })}</Alert> : null}
          {view?.status === 'completed' ? <Alert tone="ok">{ctx.li(LIFE_TEXT.completedNote)}</Alert> : null}
          {failure ? <Alert tone="bad">{ctx.li(failure)}</Alert> : null}
          {!canManage && managedHere ? <span className="mx-muted">{ctx.li(LIFE_TEXT.noRightDeletion)}</span> : null}
        </div>
      </Card>
      {view ? (
        <Card title={LIFE_TEXT.steps} sub={LIFE_TEXT.stepsSub} flush>
          {view.steps.length ? <StepsTable ctx={ctx} steps={view.steps} /> : <div style={{ padding: 'var(--pad)' }}><span className="mx-muted">{ctx.li(LIFE_TEXT.noSteps)}</span></div>}
        </Card>
      ) : null}
      <ScheduleDialog ctx={ctx} adapter={adapter} detail={detail} view={view} mode={scheduling} onClose={() => setScheduling(null)} onDone={(d) => done(d, LIFE_TEXT.scheduled)} />
      {view ? (
        <ReasonDialog
          ctx={ctx}
          adapter={adapter}
          detail={detail}
          view={view}
          kind={reasonKind}
          onClose={() => setReasonKind(null)}
          onDone={(d) => done(d, reasonKind === 'retry' ? LIFE_TEXT.retried : LIFE_TEXT.cancelled)}
        />
      ) : null}
    </>
  );
}
