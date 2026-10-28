// Status tab of the organisation drawer (MILESTONE-2 M2-S12): the current status with one plain sentence on what the
// members can do, and the moves of J.8 ("Suspend", "Reactivate", "Start offboarding", "Archive"). Each move lists its
// effects before the operator confirms it and needs a reason; "Start offboarding" and "Archive" also need the slug
// typed again. The answer's ended sessions and emailed Tenant Admins are shown; refusals (409
// `invalid_status_transition`, 422 `confirmation_mismatch`) show the server's message. In offboarding the tab says
// when the read-only period of D-S5 ends, because the operator archives the organisation by hand.
import { useCallback, useEffect, useState } from 'react';
import { useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Button, Card, Field, Modal, TextInput, Textarea, UI_TEXT } from '../ui';
import { LoadState, asApi, useLoad } from './Health';
import type { OpsAdapter } from './model';
import {
  EMPTY_STATUS_FORM, EVENT_PAGE_SIZE, MOVE_LABEL, MOVE_TONE, READ_ONLY_DAYS, STATUS_LABEL, STATUS_MEANING, STATUS_MOVES, addDays, dayText,
  localIso, moveEffects, needsSlug, offboardingStart, refusalText, statusBody, statusErrors, todayOf,
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
      title={ctx.fill(ORG_TEXT.moveTitle, { action: ctx.li(MOVE_LABEL[to]), org: detail.name })}
      sub={ctx.fill(ORG_TEXT.moveSub, { from: ctx.li(STATUS_LABEL[detail.status]), to: ctx.li(STATUS_LABEL[to]) })}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant={MOVE_TONE[to] === 'default' ? 'primary' : MOVE_TONE[to]} busy={mutation.busy} onClick={submit}>{ctx.li(MOVE_LABEL[to])}</Button>
        </>
      )}
    >
      <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate data-status-move={to}>
        <div>
          <div className="mx-label">{ctx.li(ORG_TEXT.effectsTitle)}</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20, color: 'var(--tx)' }}>
            {moveEffects(detail.status, to).map((e) => <li key={e[0]} style={{ marginTop: 4 }}>{ctx.fill(e, { days: READ_ONLY_DAYS })}</li>)}
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

/** The read-only period of an organisation in offboarding: its start (from the history), its end and whether it passed. */
export function OffboardingNote({ ctx, detail, events }: { ctx: HostContext; detail: OrgDetail; events: EventPage | null }) {
  const start = events ? offboardingStart(detail.status, events.items) : null;
  if (!start) return null;
  const startDay = localIso(new Date(start));
  const end = addDays(startDay, READ_ONLY_DAYS);
  const over = todayOf(ctx) >= end;
  return (
    <Alert tone={over ? 'warn' : 'info'}>
      {ctx.fill(over ? ORG_TEXT.offboardingOver : ORG_TEXT.offboardingSince, { date: dayText(ctx, startDay), days: READ_ONLY_DAYS, end: dayText(ctx, end) })}
    </Alert>
  );
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
  const moves = STATUS_MOVES[detail.status];
  const done = (change: StatusChanged) => {
    setMoving(null);
    setMoved(change);
    ctx.toast(ctx.fill(ORG_TEXT.moved, { org: detail.name, status: ctx.li(STATUS_LABEL[change.to]) }));
    onChanged();
  };
  let actions;
  if (!moves.length) actions = <span className="mx-muted">{ctx.li(ORG_TEXT.finalStatus)}</span>;
  else if (!canManage) actions = <span className="mx-muted">{ctx.li(ORG_TEXT.readOnlyRights)}</span>;
  else {
    actions = (
      <div className="mx-btn-group">
        {moves.map((to) => <Button key={to} variant={MOVE_TONE[to]} onClick={() => setMoving(to)}>{ctx.li(MOVE_LABEL[to])}</Button>)}
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
        </div>
      </Card>
      <Card title={ORG_TEXT.changeStatus} sub={moves.length ? ORG_TEXT.changeStatusSub : undefined}>{actions}</Card>
      <StatusDialog ctx={ctx} adapter={adapter} detail={detail} to={moving} onClose={() => setMoving(null)} onMoved={done} />
    </>
  );
}
