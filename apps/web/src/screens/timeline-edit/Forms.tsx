// The forms of the certification timeline (MILESTONE-2 M2-15), rendered in the host layer by the layer item of
// actions.ts for the request of store.ts: "Add audit event", "Edit audit event" (the BR-42 count of notified holders in
// the toast), "Record audit result", "Start certification cycle", "Record certificate", the moves of a cycle
// (suspension, reinstatement, withdrawal, closing) with a reason and the cycle's ETag, "Edit activity" and
// "Reassign or change due date" of a preparation task (BR-43) or cycle item. Every form uses `useMutation`, keeps the
// server's field errors next to the fields and stays open on a refusal. Edit and Record result load the audit event
// first; when that load fails they say so, keep Save off with that reason and offer "Try again".
import { useEffect, useState } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Button, DateInput, Facts, Field, Modal, PersonPicker, Select, TextInput, Textarea, UI_TEXT } from '../ui';
import { adapterFor } from './adapter';
import {
  ACTIVITY_STATUSES, ACTIVITY_STATUS_TEXT, ADDABLE_TYPES, CYCLE_STATUS_TEXT, EVENT_TYPE_TEXT, MOVE_TEXT, OUTCOMES, OUTCOME_TEXT,
  activeCycle, activityErrors, activityFormOf, activityPatch, asApiResult, breaksBr43, certificateBody, certificateErrors, createBody,
  emptyCertificate, emptyEventForm, eventErrors, eventFormOf, eventPatch, fmtDate, isConflict, itemErrors, itemPatch, movesOf, outcomeText, peopleOf,
  plannedCycle, reasonError, recommendation, resultFormOf, resultHint, resultPatch, startBody, startErrors, todayOf, withType,
} from './model';
import type {
  ActivityForm, ActivityModel, CertificateForm, CycleModel, CycleMove, EventDetail, EventForm, EventModel, EventType, FormErrors, ItemForm,
  ItemModel, Outcome, ResultForm, StartForm, TimelineAdapter,
} from './model';
import { closeForm, cyclesEntry, loadActivities, loadCycles } from './store';
import type { TimelineRequest } from './store';
import { TEXT } from './text';

/** The text of a refusal: the server's message (or the conflict message of a 412), with its rule id. */
function errorText(ctx: HostContext, error: ApiError): string {
  const text = isConflict(error) ? ctx.li(TEXT.conflict) : ctx.li(error.message);
  return error.rule && !text.startsWith(error.rule) ? `${error.rule}: ${text}` : text;
}

/** The refusal of a form that has no field to show it next to: the server's message, with its rule id. */
export function FormError({ ctx, error }: { ctx: HostContext; error: ApiError | null }) {
  if (!error) return null;
  return <Alert tone="bad">{errorText(ctx, error)}</Alert>;
}

/** The detail of the event a form edits: loaded, still loading, or the refusal of its load. */
export interface DetailState {
  detail: EventDetail | null;
  error: ApiError | null;
  loading: boolean;
}

/** Why Save of a form on an existing event is off: while the event loads, or after its load failed. */
export function detailReason(state: Pick<DetailState, 'detail' | 'error'>): TextPair | null {
  if (state.detail) return null;
  return state.error ? TEXT.eventLoadFailed : TEXT.loadingEvent;
}

/** The refusal of the event's load with "Try again", which loads the event once more. */
export function DetailLoadError({ ctx, error, onRetry }: { ctx: HostContext; error: ApiError | null; onRetry(): void }) {
  if (!error) return null;
  return (
    <Alert tone="bad" title={TEXT.eventLoadFailed}>
      <div>{errorText(ctx, error)}</div>
      <div style={{ marginTop: 8 }}><Button onClick={onRetry}>{ctx.li(TEXT.tryAgain)}</Button></div>
    </Alert>
  );
}

/** Loads the systems and cycles a write changed again, then closes the form and shows the toast. */
async function afterWrite(ctx: HostContext, adapter: TimelineAdapter, ms: MsId, outcome: Outcome, text: string): Promise<void> {
  closeForm();
  ctx.toast(text);
  const changed = [...new Set(outcome.changed.length ? outcome.changed : [ms])];
  await ctx.reload(changed);
  void loadCycles(ctx, adapter, ms, true);
}

const fieldOf = (errors: Record<string, string>, ...names: string[]): string | null => {
  for (const n of names) if (errors[n]) return errors[n];
  return null;
};

function Footer({ ctx, busy, label, onSave, disabledReason }: { ctx: HostContext; busy: boolean; label: TextPair; onSave(): void; disabledReason?: TextPair | null }) {
  return (
    <>
      <Button onClick={closeForm}>{ctx.li(UI_TEXT.cancel)}</Button>
      <Button variant="primary" busy={busy} disabledReason={disabledReason ?? null} onClick={onSave}>{ctx.li(label)}</Button>
    </>
  );
}

/** The form of the open request. */
export default function Forms({ ctx, request }: { ctx: HostContext; request: TimelineRequest }) {
  switch (request.type) {
    case 'add':
      return <EventDialog ctx={ctx} ms={request.ms} event={null} />;
    case 'edit':
      return <EventDialog ctx={ctx} ms={request.ms} event={request.event} />;
    case 'result':
      return <ResultDialog ctx={ctx} ms={request.ms} event={request.event} />;
    case 'start':
      return <StartDialog ctx={ctx} ms={request.ms} />;
    case 'certificate':
      return <CertificateDialog ctx={ctx} ms={request.ms} />;
    case 'move':
      return <MoveDialog ctx={ctx} ms={request.ms} cycle={request.cycle} to={request.to} />;
    case 'activity':
      return <ActivityDialog ctx={ctx} ms={request.ms} event={request.event} activity={request.activity} />;
    case 'item':
      return <ItemDialog ctx={ctx} ms={request.ms} item={request.item} />;
    default:
      return null;
  }
}

/** Loads the detail of an event for a form (never rejects); `retry` loads it again after a failed load. */
function useDetail(ctx: HostContext, ms: MsId, event: EventModel | null): DetailState & { retry(): void } {
  const [state, setState] = useState<DetailState>({ detail: null, error: null, loading: Boolean(event) });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!event) return undefined;
    let live = true;
    asApiResult(adapterFor(ctx).eventDetail(ms, event)).then((res) => {
      if (!live) return;
      setState(res.ok ? { detail: res.data, error: null, loading: false } : { detail: null, error: res.error, loading: false });
    });
    return () => {
      live = false;
    };
  }, [ms, event?.id, attempt]);
  const retry = () => {
    setState({ detail: null, error: null, loading: true });
    setAttempt((n) => n + 1);
  };
  return { ...state, retry };
}

// ---------------------------------------------------------------------------------------------------------------
// Add and edit an audit event
// ---------------------------------------------------------------------------------------------------------------

function EventDialog({ ctx, ms, event }: { ctx: HostContext; ms: MsId; event: EventModel | null }) {
  const adapter = adapterFor(ctx);
  const { detail, error: loadError, loading, retry } = useDetail(ctx, ms, event);
  const system = ctx.D?.MS?.find((m) => m.id === ms) ?? null;
  // The api gives the preparation window of the next audit only (`MS.audit`).
  const withWindow = (d: EventDetail): EventDetail => (d.prepWindowDays !== null ? d : {
    ...d, prepWindowDays: system?.audit && system.audit.date === d.scheduledAt && typeof system.audit.prepWindowDays === 'number' ? system.audit.prepWindowDays : null,
  });
  const [form, setForm] = useState<EventForm>(() => emptyEventForm('stage1'));
  const [errors, setErrors] = useState<FormErrors<keyof EventForm>>({});
  const [unchanged, setUnchanged] = useState(false);
  const [key] = useState(newIdempotencyKey);
  useEffect(() => {
    if (detail) setForm(eventFormOf(withWindow(detail)));
  }, [detail]);
  const mutation = useMutation((run: () => ReturnType<TimelineAdapter['createEvent']>) => asApiResult(run()));
  const set = <K extends keyof EventForm>(name: K, value: EventForm[K]) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
    setUnchanged(false);
  };
  const label = form.shortLabel.trim();
  const submit = () => {
    const found = eventErrors(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    if (!event) {
      ctx.track(mutation.submit(() => adapter.createEvent(ms, createBody(form), key))).then((res) => {
        if (res.ok) void afterWrite(ctx, adapter, ms, res.data, outcomeText(ctx, { ...res.data, message: undefined }, [ctx.fill(TEXT.added, { label }), res.data.message ? ctx.li(res.data.message) : ''].filter(Boolean).join('. ')));
      }, () => undefined);
      return;
    }
    if (!detail) return;
    const patch = eventPatch(withWindow(detail), form);
    if (!patch) {
      setUnchanged(true);
      return;
    }
    ctx.track(mutation.submit(() => adapter.updateEvent(ms, event, patch))).then((res) => {
      if (res.ok) {
        const n = res.data.count ?? 0;
        const head = n > 0 ? ctx.fill(TEXT.notified, { label, n }) : ctx.fill(TEXT.eventSaved, { label });
        void afterWrite(ctx, adapter, ms, res.data, outcomeText(ctx, { ...res.data, message: undefined }, [head, res.data.message ? ctx.li(res.data.message) : ''].filter(Boolean).join('. ')));
      } else if (isConflict(res.error)) {
        void loadCycles(ctx, adapter, ms, true);
      }
    }, () => undefined);
  };
  const f = mutation.fields;
  const types: EventType[] = event && detail?.eventType === 'internal_audit' ? [...ADDABLE_TYPES, 'internal_audit'] : [...ADDABLE_TYPES];
  const ready = !event || Boolean(detail);
  return (
    <Modal
      open
      title={event ? TEXT.editTitle : TEXT.addTitle}
      sub={event ? TEXT.editSub : TEXT.addSub}
      onClose={closeForm}
      footer={<Footer ctx={ctx} busy={mutation.busy} label={event ? UI_TEXT.save : TEXT.addEvent} onSave={submit} disabledReason={event ? detailReason({ detail, error: loadError }) : null} />}
    >
      {loading ? <div className="mx-small" role="status">{ctx.li(TEXT.loadingEvent)}</div> : null}
      <DetailLoadError ctx={ctx} error={loadError} onRetry={retry} />
      <FormError ctx={ctx} error={mutation.error && !Object.keys(f).length ? mutation.error : null} />
      {unchanged ? <Alert tone="info">{ctx.li(TEXT.nothingChanged)}</Alert> : null}
      {ready ? (
        <>
          <Field label={TEXT.fType} error={fieldOf(f, 'eventType')} required>
            <Select
              name="eventType"
              value={form.eventType}
              onChange={(v) => {
                setForm((cur) => (event ? { ...cur, eventType: v as EventType } : withType(cur, v as EventType)));
                setUnchanged(false);
              }}
              options={types.map((t) => ({ value: t, label: EVENT_TYPE_TEXT[t] }))}
            />
          </Field>
          <Field label={TEXT.fNameEn} error={errors.nameEn ?? fieldOf(f, 'nameEn')} required>
            <TextInput name="nameEn" value={form.nameEn} onChange={(v) => set('nameEn', v)} maxLength={200} />
          </Field>
          <Field label={TEXT.fNameId} hint={TEXT.fNameIdHint} error={errors.nameId ?? fieldOf(f, 'nameId')}>
            <TextInput name="nameId" value={form.nameId} onChange={(v) => set('nameId', v)} maxLength={200} />
          </Field>
          <Field label={TEXT.fShort} hint={TEXT.fShortHint} error={errors.shortLabel ?? fieldOf(f, 'shortLabel')} required>
            <TextInput name="shortLabel" value={form.shortLabel} onChange={(v) => set('shortLabel', v)} maxLength={80} />
          </Field>
          <Field label={TEXT.fDate} error={errors.scheduledAt ?? fieldOf(f, 'scheduledAt')} required>
            <DateInput name="scheduledAt" value={form.scheduledAt} onChange={(v) => set('scheduledAt', v)} />
          </Field>
          <Field label={TEXT.fDays} error={errors.auditDays ?? fieldOf(f, 'auditDays')}>
            <TextInput name="auditDays" type="number" value={form.auditDays} onChange={(v) => set('auditDays', v)} />
          </Field>
          <Field label={TEXT.fLead} hint={TEXT.fLeadHint} error={errors.leadAuditor ?? fieldOf(f, 'leadAuditorName')}>
            <TextInput name="leadAuditor" value={form.leadAuditor} onChange={(v) => set('leadAuditor', v)} maxLength={150} />
          </Field>
          <Field label={TEXT.fWindow} hint={event && !form.prepWindowDays ? TEXT.fWindowKeep : TEXT.fWindowHint} error={errors.prepWindowDays ?? fieldOf(f, 'prepWindowDays')}>
            <TextInput name="prepWindowDays" type="number" value={form.prepWindowDays} onChange={(v) => set('prepWindowDays', v)} />
          </Field>
          <Field label={TEXT.fFocus} hint={TEXT.fFocusHint} error={errors.expectedFocus ?? fieldOf(f, 'expectedFocus')}>
            <Textarea name="expectedFocus" rows={3} value={form.expectedFocus} onChange={(v) => set('expectedFocus', v)} maxLength={4000} />
          </Field>
        </>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Record audit result
// ---------------------------------------------------------------------------------------------------------------

function ResultDialog({ ctx, ms, event }: { ctx: HostContext; ms: MsId; event: EventModel }) {
  const adapter = adapterFor(ctx);
  const { detail, error: loadError, loading, retry } = useDetail(ctx, ms, event);
  const [form, setForm] = useState<ResultForm>({ outcome: event.outcome ?? '', summary: '' });
  const [unchanged, setUnchanged] = useState(false);
  useEffect(() => {
    if (detail) setForm(resultFormOf(detail));
  }, [detail]);
  const mutation = useMutation((patch: NonNullable<ReturnType<typeof resultPatch>>) => asApiResult(adapter.updateEvent(ms, event, patch)));
  const submit = () => {
    if (!detail) return;
    const patch = resultPatch(detail, form);
    if (!patch) {
      setUnchanged(true);
      return;
    }
    ctx.track(mutation.submit(patch)).then((res) => {
      if (res.ok) void afterWrite(ctx, adapter, ms, res.data, outcomeText(ctx, res.data, ctx.fill(TEXT.resultSaved, { label: event.shortLabel })));
    }, () => undefined);
  };
  const hint = resultHint(detail?.eventType ?? event.eventType);
  const f = mutation.fields;
  return (
    <Modal
      open
      title={TEXT.resultTitle}
      sub={`${event.shortLabel}, ${fmtDate(ctx, event.scheduledAt)}. ${ctx.li(TEXT.resultSub)}`}
      onClose={closeForm}
      footer={<Footer ctx={ctx} busy={mutation.busy} label={UI_TEXT.save} onSave={submit} disabledReason={detailReason({ detail, error: loadError })} />}
    >
      {loading ? <div className="mx-small" role="status">{ctx.li(TEXT.loadingEvent)}</div> : null}
      <DetailLoadError ctx={ctx} error={loadError} onRetry={retry} />
      <FormError ctx={ctx} error={mutation.error && !Object.keys(f).length ? mutation.error : null} />
      {unchanged ? <Alert tone="info">{ctx.li(TEXT.nothingChanged)}</Alert> : null}
      {detail ? (
        <>
          <Field label={TEXT.fOutcome} hint={hint ?? undefined} error={fieldOf(f, 'outcome')}>
            <Select
              name="outcome"
              value={form.outcome}
              onChange={(v) => { setForm((cur) => ({ ...cur, outcome: v as ResultForm['outcome'] })); setUnchanged(false); }}
              options={OUTCOMES.map((o) => ({ value: o, label: OUTCOME_TEXT[o] }))}
              empty={TEXT.oNone}
            />
          </Field>
          <Field label={TEXT.fSummary} hint={TEXT.fSummaryHint} error={fieldOf(f, 'outcomeSummary')}>
            <Textarea name="summary" rows={3} value={form.summary} onChange={(v) => { setForm((cur) => ({ ...cur, summary: v })); setUnchanged(false); }} maxLength={4000} />
          </Field>
        </>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Start certification cycle, record certificate, move a cycle
// ---------------------------------------------------------------------------------------------------------------

/** The cycles of a system from the store, loaded when missing. */
function useCycles(ctx: HostContext, ms: MsId): CycleModel[] | null {
  const adapter = adapterFor(ctx);
  const entry = cyclesEntry(ctx, ms);
  useEffect(() => {
    if (!entry) void loadCycles(ctx, adapter, ms);
  }, [ms]);
  return entry?.data ?? null;
}

function StartDialog({ ctx, ms }: { ctx: HostContext; ms: MsId }) {
  const adapter = adapterFor(ctx);
  const cycles = useCycles(ctx, ms);
  const [form, setForm] = useState<StartForm>({ cycleStart: todayOf(ctx), cycleEnd: '' });
  const [errors, setErrors] = useState<FormErrors<keyof StartForm>>({});
  const [key] = useState(newIdempotencyKey);
  const mutation = useMutation((body: ReturnType<typeof startBody>) => asApiResult(adapter.startCycle(ms, body, key)));
  const active = cycles ? activeCycle(cycles) : null;
  const planned = cycles ? plannedCycle(cycles) : null;
  const submit = () => {
    const found = startErrors(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    ctx.track(mutation.submit(startBody(form))).then((res) => {
      if (res.ok) void afterWrite(ctx, adapter, ms, res.data, outcomeText(ctx, res.data, ctx.li(TEXT.started)));
    }, () => undefined);
  };
  const f = mutation.fields;
  const blocked: TextPair | null = active
    ? [ctx.fill(TEXT.activeExists, { from: fmtDate({ ...ctx, lang: 'en' }, active.cycleStart), to: fmtDate({ ...ctx, lang: 'en' }, active.cycleEnd) }), ctx.fill(TEXT.activeExists, { from: fmtDate({ ...ctx, lang: 'id' }, active.cycleStart), to: fmtDate({ ...ctx, lang: 'id' }, active.cycleEnd) })]
    : null;
  return (
    <Modal open title={TEXT.startTitle} sub={TEXT.startSub} onClose={closeForm} footer={<Footer ctx={ctx} busy={mutation.busy} label={TEXT.startCycle} onSave={submit} disabledReason={blocked} />}>
      <FormError ctx={ctx} error={mutation.error && !Object.keys(f).length ? mutation.error : null} />
      {planned && !active ? <Alert tone="info">{ctx.li(TEXT.startPlanned)}</Alert> : null}
      <Field label={TEXT.fStart} error={errors.cycleStart ?? fieldOf(f, 'cycleStart')} required>
        <DateInput name="cycleStart" value={form.cycleStart} onChange={(v) => { setForm((c) => ({ ...c, cycleStart: v })); setErrors((e) => ({ ...e, cycleStart: undefined })); }} />
      </Field>
      <Field label={TEXT.fEnd} hint={TEXT.fEndHint} error={errors.cycleEnd ?? fieldOf(f, 'cycleEnd')}>
        <DateInput name="cycleEnd" value={form.cycleEnd} onChange={(v) => { setForm((c) => ({ ...c, cycleEnd: v })); setErrors((e) => ({ ...e, cycleEnd: undefined })); }} />
      </Field>
    </Modal>
  );
}

function CertificateDialog({ ctx, ms }: { ctx: HostContext; ms: MsId }) {
  const adapter = adapterFor(ctx);
  const cycles = useCycles(ctx, ms);
  const system = ctx.D?.MS?.find((m) => m.id === ms) ?? null;
  const [form, setForm] = useState<CertificateForm>(() => emptyCertificate(todayOf(ctx), system?.certifier, system?.scope));
  const [errors, setErrors] = useState<FormErrors<keyof CertificateForm>>({});
  const mutation = useMutation((body: ReturnType<typeof certificateBody>) => asApiResult(adapter.recordCertificate(ms, body)));
  const active = cycles ? activeCycle(cycles) : null;
  const basis = recommendation(active);
  const reason: TextPair | null = !cycles ? TEXT.loading : !active ? TEXT.certNeedsActive : !basis ? TEXT.certNeedsResult : null;
  const set = <K extends keyof CertificateForm>(name: K, value: CertificateForm[K]) => {
    setForm((c) => ({ ...c, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
  };
  const submit = () => {
    const found = certificateErrors(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    const body = certificateBody(form);
    ctx.track(mutation.submit(body)).then((res) => {
      // The toast names the expiry date, which the server's message leaves out.
      if (res.ok) void afterWrite(ctx, adapter, ms, res.data, outcomeText(ctx, { ...res.data, message: undefined }, ctx.fill(TEXT.certRecorded, { no: body.certificateNo, date: fmtDate(ctx, body.expiresAt) })));
    }, () => undefined);
  };
  const f = mutation.fields;
  return (
    <Modal open title={TEXT.certTitle} sub={TEXT.certSub} onClose={closeForm} footer={<Footer ctx={ctx} busy={mutation.busy} label={TEXT.recordCertificate} onSave={submit} disabledReason={reason} />}>
      <FormError ctx={ctx} error={mutation.error && !Object.keys(f).length ? mutation.error : null} />
      {basis ? (
        <Alert tone="ok">{ctx.fill(TEXT.certBasis, { label: basis.shortLabel, date: fmtDate(ctx, basis.scheduledAt), outcome: ctx.li(OUTCOME_TEXT[basis.outcome!]) })}</Alert>
      ) : null}
      <Field label={TEXT.fCertificate} error={errors.certificateNo ?? fieldOf(f, 'certificateNo')} required>
        <TextInput name="certificateNo" value={form.certificateNo} onChange={(v) => set('certificateNo', v)} maxLength={60} />
      </Field>
      <Field label={TEXT.fIssued} error={errors.issuedAt ?? fieldOf(f, 'issuedAt')} required>
        <DateInput name="issuedAt" value={form.issuedAt} onChange={(v) => set('issuedAt', v)} />
      </Field>
      <Field label={TEXT.fExpires} hint={TEXT.fExpiresHint} error={errors.expiresAt ?? fieldOf(f, 'expiresAt')} required>
        <DateInput name="expiresAt" value={form.expiresAt} onChange={(v) => set('expiresAt', v)} />
      </Field>
      <Field label={TEXT.fBody} error={errors.certificationBody ?? fieldOf(f, 'certificationBody')} required>
        <TextInput name="certificationBody" value={form.certificationBody} onChange={(v) => set('certificationBody', v)} maxLength={200} />
      </Field>
      <Field label={TEXT.fScope} error={errors.certifiedScope ?? fieldOf(f, 'certifiedScope')}>
        <Textarea name="certifiedScope" rows={3} value={form.certifiedScope} onChange={(v) => set('certifiedScope', v)} maxLength={4000} />
      </Field>
    </Modal>
  );
}

function MoveDialog({ ctx, ms, cycle, to }: { ctx: HostContext; ms: MsId; cycle: CycleModel; to: CycleMove }) {
  const adapter = adapterFor(ctx);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<TextPair | null>(null);
  const [target, setTarget] = useState(cycle);
  const mutation = useMutation((text: string) => asApiResult(adapter.transition(ms, target, to, text)));
  const copy = MOVE_TEXT[to];
  // After a conflict the latest cycle is loaded; when its status no longer allows this move (J.8), Save stays off
  // with the reason, so the form never sends a move the server refuses with 409.
  const status = ctx.li(CYCLE_STATUS_TEXT[target.status]).toLowerCase();
  const stale = movesOf(target.status).includes(to) ? null : ctx.fill(target.status === to ? TEXT.moveAlready : TEXT.moveStale, { status });
  const submit = () => {
    if (stale) return;
    const problem = reasonError(reason);
    setError(problem);
    if (problem) return;
    ctx.track(mutation.submit(reason)).then((res) => {
      if (res.ok) {
        void afterWrite(ctx, adapter, ms, res.data, outcomeText(ctx, res.data, ctx.fill(TEXT.transitioned, { status: ctx.li(CYCLE_STATUS_TEXT[to]) })));
      } else if (isConflict(res.error)) {
        // The cycle changed since the panel was drawn: the latest version (and its ETag) is loaded for the next try.
        void loadCycles(ctx, adapter, ms, true).then(() => {
          const fresh = cyclesEntry(ctx, ms)?.data?.find((c) => c.id === cycle.id);
          if (fresh) setTarget(fresh);
        });
      }
    }, () => undefined);
  };
  return (
    <Modal open title={copy.title} sub={copy.sub} onClose={closeForm} footer={(
      <>
        <Button onClick={closeForm}>{ctx.li(UI_TEXT.cancel)}</Button>
        <Button variant={copy.tone === 'bad' ? 'danger' : 'primary'} busy={mutation.busy} disabledReason={stale} onClick={submit}>{ctx.li(copy.action)}</Button>
      </>
    )}>
      <FormError ctx={ctx} error={mutation.error && !mutation.fields.reason ? mutation.error : null} />
      <Facts items={[
        { label: TEXT.fCycle, value: ctx.fill(TEXT.to, { from: fmtDate(ctx, target.cycleStart), to: fmtDate(ctx, target.cycleEnd) }) },
        { label: TEXT.fStatus, value: ctx.li(CYCLE_STATUS_TEXT[target.status]) },
        ...(target.certificateNo ? [{ label: TEXT.fCertificate, value: target.certificateNo, mono: true }] : []),
      ]} />
      <Field label={TEXT.fReason} hint={TEXT.fReasonHint} error={error ?? mutation.fields.reason ?? null} required>
        <Textarea name="reason" rows={3} value={reason} onChange={(v) => { setReason(v); setError(null); }} maxLength={1000} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Edit activity
// ---------------------------------------------------------------------------------------------------------------

function ActivityDialog({ ctx, ms, event, activity }: { ctx: HostContext; ms: MsId; event: EventModel; activity: ActivityModel }) {
  const adapter = adapterFor(ctx);
  const [form, setForm] = useState<ActivityForm>(() => activityFormOf(activity));
  const [errors, setErrors] = useState<FormErrors<keyof ActivityForm>>({});
  const [unchanged, setUnchanged] = useState(false);
  const mutation = useMutation((patch: NonNullable<ReturnType<typeof activityPatch>>) => asApiResult(adapter.updateActivity(ms, activity, patch)));
  const people = peopleOf(ctx.D);
  const set = <K extends keyof ActivityForm>(name: K, value: ActivityForm[K]) => {
    setForm((c) => ({ ...c, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
    setUnchanged(false);
  };
  const submit = () => {
    const found = activityErrors(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    const patch = activityPatch(activity, form);
    if (!patch) {
      setUnchanged(true);
      return;
    }
    ctx.track(mutation.submit(patch)).then((res) => {
      if (!res.ok) return;
      closeForm();
      ctx.toast(outcomeText(ctx, { ...res.data, message: undefined }, ctx.fill(TEXT.activitySaved, { code: activity.code })));
      void loadActivities(ctx, adapter, ms, event, true);
    }, () => undefined);
  };
  const f = mutation.fields;
  return (
    <Modal open title={ctx.fill(TEXT.activityTitle, { code: activity.code })} sub={activity.title} onClose={closeForm} footer={<Footer ctx={ctx} busy={mutation.busy} label={UI_TEXT.save} onSave={submit} />}>
      <FormError ctx={ctx} error={mutation.error && !Object.keys(f).length ? mutation.error : null} />
      {unchanged ? <Alert tone="info">{ctx.li(TEXT.nothingChanged)}</Alert> : null}
      {activity.keyQuestions || activity.evidenceToRequest ? (
        <div className="mx-tl-template">
          <span className="mx-small">{ctx.li(TEXT.fromTemplate)}</span>
          {activity.keyQuestions ? <span><b>{ctx.li(TEXT.keyQuestions)}:</b> {activity.keyQuestions}</span> : null}
          {activity.evidenceToRequest ? <span><b>{ctx.li(TEXT.evidenceToRequest)}:</b> {activity.evidenceToRequest}</span> : null}
        </div>
      ) : null}
      <Field label={TEXT.fAuditee} error={fieldOf(f, 'auditeeHandle')}>
        <PersonPicker value={form.auditee} onChange={(v) => set('auditee', v)} people={people} />
      </Field>
      <Field label={TEXT.fAuditor} error={fieldOf(f, 'auditorHandle')}>
        <PersonPicker value={form.auditor} onChange={(v) => set('auditor', v)} people={people} allowNone />
      </Field>
      <Field label={TEXT.fTarget} hint={TEXT.fTargetHint} error={errors.targetCode ?? fieldOf(f, 'targetCode')}>
        <TextInput name="targetCode" value={form.targetCode} onChange={(v) => set('targetCode', v)} maxLength={30} />
      </Field>
      <Field label={TEXT.fActivityDate} error={errors.scheduledAt ?? fieldOf(f, 'scheduledAt')}>
        <DateInput name="activityDate" value={form.scheduledAt} onChange={(v) => set('scheduledAt', v)} />
      </Field>
      <Field label={TEXT.fStatus} error={fieldOf(f, 'status')}>
        <Select name="status" value={form.status} onChange={(v) => set('status', v as ActivityForm['status'])} options={ACTIVITY_STATUSES.map((s) => ({ value: s, label: ACTIVITY_STATUS_TEXT[s] }))} />
      </Field>
      <Field label={TEXT.fNote} error={errors.note ?? fieldOf(f, 'note')}>
        <Textarea name="note" rows={3} value={form.note} onChange={(v) => set('note', v)} maxLength={2000} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Reassign or change due date of a preparation task or cycle item
// ---------------------------------------------------------------------------------------------------------------

function ItemDialog({ ctx, ms, item }: { ctx: HostContext; ms: MsId; item: ItemModel }) {
  const adapter = adapterFor(ctx);
  const [form, setForm] = useState<ItemForm>({ owner: item.owner === 'none' ? '' : item.owner, due: item.due });
  const [errors, setErrors] = useState<FormErrors<keyof ItemForm>>({});
  const [unchanged, setUnchanged] = useState(false);
  const mutation = useMutation((patch: NonNullable<ReturnType<typeof itemPatch>>) => asApiResult(adapter.updateItem(ms, item, patch)));
  const br43 = breaksBr43(item, form.due);
  const submit = () => {
    const found = itemErrors(item, form);
    setErrors(found);
    if (Object.keys(found).length || br43) return;
    const patch = itemPatch(item, form);
    if (!patch) {
      setUnchanged(true);
      return;
    }
    ctx.track(mutation.submit(patch)).then((res) => {
      if (res.ok) void afterWrite(ctx, adapter, ms, res.data, outcomeText(ctx, { ...res.data, message: undefined }, ctx.fill(TEXT.itemSaved, { title: item.title })));
      else if (isConflict(res.error)) void ctx.reload([ms]);
    }, () => undefined);
  };
  const f = mutation.fields;
  const sub = item.kind === 'prep' ? ctx.fill(TEXT.itemSubPrep, { date: fmtDate(ctx, item.auditDate) }) : ctx.li(TEXT.itemSubCycle);
  return (
    <Modal open title={TEXT.itemTitle} sub={`${item.title}. ${sub}`} onClose={closeForm} footer={<Footer ctx={ctx} busy={mutation.busy} label={UI_TEXT.save} onSave={submit} />}>
      <FormError ctx={ctx} error={mutation.error && !Object.keys(f).length ? mutation.error : null} />
      {unchanged ? <Alert tone="info">{ctx.li(TEXT.nothingChanged)}</Alert> : null}
      <Field label={TEXT.fHolder} error={errors.owner ?? fieldOf(f, 'ownerHandle')} required>
        <PersonPicker value={form.owner} onChange={(v) => { setForm((c) => ({ ...c, owner: v })); setErrors((e) => ({ ...e, owner: undefined })); setUnchanged(false); }} people={peopleOf(ctx.D)} />
      </Field>
      <Field
        label={TEXT.fDue}
        error={errors.due ?? (br43 ? ctx.fill(TEXT.br43, { date: fmtDate(ctx, item.auditDate) }) : null) ?? fieldOf(f, 'dueAt')}
        required
      >
        <DateInput name="due" value={form.due} onChange={(v) => { setForm((c) => ({ ...c, due: v })); setErrors((e) => ({ ...e, due: undefined })); setUnchanged(false); }} />
      </Field>
    </Modal>
  );
}
