// Status tab of the organisation drawer (MILESTONE-2 M2-S12, MILESTONE-3 M3-09): the current status with one plain
// sentence on what the members can do, and the moves of Milestone 3 J.8 ("Suspend", "Reactivate", "Start offboarding",
// "Archive" and, for an archived organisation whose deletion is scheduled, "Reopen for export"). Each move lists its
// effects before the operator confirms it and needs a reason; "Start offboarding", "Archive" and "Reopen for export"
// also need the slug typed again. The answer's ended sessions and emailed Tenant Admins are shown; refusals (409
// `invalid_status_transition`, 422 `confirmation_mismatch`) show the server's message. In offboarding the tab says when
// the read-only period ends (`offboardingEndsAt`, D.2), after which MSCD archives the organisation by itself; an
// archived organisation shows its deletion date. Nobody moves an organisation to deleted: `deleted` is final.
import { useCallback, useEffect, useState } from 'react';
import { useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Button, Card, Field, Modal, TextInput, Textarea, UI_TEXT } from '../ui';
import { LoadState, asApi, useLoad } from './Health';
import type { OpsAdapter } from './model';
import { DELETION_STATUS_TEXT, instantDay } from './lifecycle-model';
import {
  EFFECT_VALUES, EMPTY_STATUS_FORM, EVENT_PAGE_SIZE, MOVE_TONE, READ_ONLY_DAYS, STATUS_LABEL, STATUS_MEANING, addDays, dayText, localIso, moveEffects,
  moveLabel, movesOf, needsSlug, offboardingStart, refusalText, statusBody, statusErrors, todayOf,
} from './org-model';
import type { EventPage, OrgDetail, OrgStatus, StatusChange, StatusChanged, StatusForm } from './org-model';
import { StatusBadge } from './org-parts';
import { ORG_TEXT } from './org-text';

type FormErrors = Partial<Record<'reason' | 'confirmSlug', TextPair>>;

/** The confirmation of one move: its effects, the reason and, for the two final moves, the slug typed again. */
export function StatusDialog({ ctx, adapter, detail, to, onClose, onMoved }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  detail: OrgDetail;
  to: OrgStatus | null;
  onClose(): void;
  onMoved(moved: StatusChanged): void;
}) {
  const [form, setForm] = useState<StatusForm>(EMPTY_STATUS_FORM);
  const [shown, setShown] = useState<FormErrors>({});
  const run = useCallback((input: { slug: string; body: StatusChange }) => adapter.changeStatus(input.slug, input.body).then(asApi), [adapter]);
  const mutation = useMutation<{ slug: string; body: StatusChange }, StatusChanged>(run);
  const { reset } = mutation;
  useEffect(() => {
    setForm(EMPTY_STATUS_FORM);
    setShown({});
    reset();
  }, [to]);
  if (!to) return null;
  const set = (field: keyof StatusForm) => (value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setShown((s) => ({ ...s, [field === 'confirm' ? 'confirmSlug' : field]: undefined }));
    mutation.reset();
  };
  const submit = () => {
    const errors = statusErrors(detail.slug, to, form);
    setShown(errors);
    if (Object.keys(errors).length) return;
    void ctx.track(mutation.submit({ slug: detail.slug, body: statusBody(to, form) })).then((res) => {
      if (res.ok) onMoved(res.data);
    }, () => undefined);
  };
  const fields = mutation.fields;
  const error = mutation.error;
  const general = error && !fields.reason && !fields.confirmSlug ? refusalText(error) : null;
  const slugError = shown.confirmSlug ? ctx.fill(shown.confirmSlug, { slug: detail.slug }) : (fields.confirmSlug ?? null);
  return (
    <Modal
      open
      title={ctx.fill(ORG_TEXT.moveTitle, { action: ctx.li(moveLabel(detail.status, to)), org: detail.name })}
      sub={ctx.fill(ORG_TEXT.moveSub, { from: ctx.li(STATUS_LABEL[detail.status]), to: ctx.li(STATUS_LABEL[to]) })}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant={MOVE_TONE[to] === 'default' ? 'primary' : MOVE_TONE[to]} busy={mutation.busy} onClick={submit}>{ctx.li(moveLabel(detail.status, to))}</Button>
        </>
      )}
    >
      <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate data-status-move={to}>
        <div>
          <div className="mx-label">{ctx.li(ORG_TEXT.effectsTitle)}</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20, color: 'var(--tx)' }}>
            {moveEffects(detail.status, to).map((e) => <li key={e[0]} style={{ marginTop: 4 }}>{ctx.fill(e, EFFECT_VALUES)}</li>)}
          </ul>
        </div>
        <Field label={ORG_TEXT.reason} hint={ORG_TEXT.reasonHint} error={shown.reason ?? fields.reason ?? null} required>
          <Textarea value={form.reason} onChange={set('reason')} rows={3} maxLength={500} />
        </Field>
        {needsSlug(to) ? (
          <Field label={ctx.fill(ORG_TEXT.confirmSlug, { slug: detail.slug })} error={slugError} required>
            <TextInput value={form.confirm} onChange={set('confirm')} autoComplete="off" maxLength={40} />
          </Field>
        ) : null}
        {general ? <Alert tone="bad">{ctx.li(general)}</Alert> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** The result of a move: the sessions it ended and the Tenant Admins told by email. */
export function MovedAlert({ ctx, name, moved }: { ctx: HostContext; name: string; moved: StatusChanged }) {
  const short = moved.tenantAdminsEmailed < moved.tenantAdmins;
  return (
    <Alert tone={short ? 'warn' : 'ok'} title={ctx.fill(ORG_TEXT.moved, { org: name, status: ctx.li(STATUS_LABEL[moved.to]) })}>
      <div data-sessions-revoked={moved.sessionsRevoked}>{ctx.fill(ORG_TEXT.movedSessions, { n: moved.sessionsRevoked })}</div>
      <div data-admins-emailed={moved.tenantAdminsEmailed}>{ctx.fill(ORG_TEXT.movedEmails, { sent: moved.tenantAdminsEmailed, total: moved.tenantAdmins })}</div>
      {short ? <div>{ctx.li(ORG_TEXT.movedEmailsShort)}</div> : null}
    </Alert>
  );
}

const NO_EVENTS: EventPage = { items: [], page: 1, pageSize: EVENT_PAGE_SIZE, total: 0 };

/**
 * The read-only period of an organisation in offboarding: its start (from the history), its end (`offboardingEndsAt`,
 * or the start plus the read-only days when the answer has none) and whether it passed.
 */
export function OffboardingNote({ ctx, detail, events }: { ctx: HostContext; detail: OrgDetail; events: EventPage | null }) {
  if (detail.status !== 'offboarding') return null;
  const start = events ? offboardingStart(detail.status, events.items) : null;
  const startDay = start ? localIso(new Date(start)) : null;
  const end = detail.offboardingEndsAt ? instantDay(detail.offboardingEndsAt) : startDay ? addDays(startDay, READ_ONLY_DAYS) : null;
  if (!end) return null;
  const over = todayOf(ctx) >= end;
  const text = !startDay ? ORG_TEXT.offboardingUntil : over ? ORG_TEXT.offboardingOver : ORG_TEXT.offboardingSince;
  return (
    <Alert tone={over ? 'warn' : 'info'}>
      <span data-offboarding-end={end}>{ctx.fill(text, { date: startDay ? dayText(ctx, startDay) : '', end: dayText(ctx, end) })}</span>
    </Alert>
  );
}

/** The deletion of an archived organisation: its date while scheduled, else its state, with a pointer to the Deletion tab. */
export function ArchivedNote({ ctx, detail }: { ctx: HostContext; detail: OrgDetail }) {
  if (detail.status !== 'archived') return null;
  const d = detail.deletion;
  if (d?.status === 'scheduled') return <Alert tone="warn">{ctx.fill(ORG_TEXT.archivedDeletion, { date: dayText(ctx, instantDay(d.scheduledFor)) })}</Alert>;
  if (d) return <Alert tone={d.status === 'failed' ? 'bad' : 'info'}>{ctx.fill(ORG_TEXT.archivedDeletionState, { status: ctx.li(DELETION_STATUS_TEXT[d.status]) })}</Alert>;
  return <Alert tone="info">{ctx.li(ORG_TEXT.archivedNoDeletion)}</Alert>;
}

export function StatusTab({ ctx, adapter, detail, tick, onChanged }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  detail: OrgDetail;
  tick: number;
  onChanged(): void;
}) {
  const [moving, setMoving] = useState<OrgStatus | null>(null);
  const [moved, setMoved] = useState<StatusChanged | null>(null);
  const offboarding = detail.status === 'offboarding';
  // The history is read only in offboarding, for the start of the read-only period.
  const load = useCallback(
    () => (offboarding ? adapter.events(detail.slug, 1, EVENT_PAGE_SIZE) : Promise.resolve({ ok: true as const, data: NO_EVENTS })),
    [adapter, detail.slug, offboarding, tick],
  );
  const { result, reload } = useLoad<EventPage>(load);
  const canManage = ctx.platformCan('ops.tenants.manage');
  const moves = movesOf(detail);
  const done = (change: StatusChanged) => {
    setMoving(null);
    setMoved(change);
    ctx.toast(ctx.fill(ORG_TEXT.moved, { org: detail.name, status: ctx.li(STATUS_LABEL[change.to]) }));
    onChanged();
  };
  let actions;
  if (!moves.length) actions = <span className="mx-muted" data-no-move={detail.status}>{ctx.li(detail.status === 'archived' ? ORG_TEXT.archivedNoMove : ORG_TEXT.finalStatus)}</span>;
  else if (!canManage) actions = <span className="mx-muted">{ctx.li(ORG_TEXT.readOnlyRights)}</span>;
  else {
    actions = (
      <div className="mx-btn-group">
        {moves.map((to) => <Button key={to} variant={MOVE_TONE[to]} onClick={() => setMoving(to)}>{ctx.li(moveLabel(detail.status, to))}</Button>)}
      </div>
    );
  }
  return (
    <>
      {moved ? <MovedAlert ctx={ctx} name={detail.name} moved={moved} /> : null}
      <Card title={ORG_TEXT.currentStatus}>
        <div className="mx-stack">
          <div><StatusBadge ctx={ctx} status={detail.status} /></div>
          <div data-status-meaning={detail.status}>{ctx.li(STATUS_MEANING[detail.status])}</div>
          {offboarding && result && !result.ok ? <LoadState ctx={ctx} result={result} failed={ORG_TEXT.historyFailed} retry={reload} /> : null}
          {offboarding && result && result.ok ? <OffboardingNote ctx={ctx} detail={detail} events={result.data} /> : null}
          <ArchivedNote ctx={ctx} detail={detail} />
        </div>
      </Card>
      <Card title={ORG_TEXT.changeStatus} sub={moves.length ? ORG_TEXT.changeStatusSub : undefined}>{actions}</Card>
      <StatusDialog ctx={ctx} adapter={adapter} detail={detail} to={moving} onClose={() => setMoving(null)} onMoved={done} />
    </>
  );
}
