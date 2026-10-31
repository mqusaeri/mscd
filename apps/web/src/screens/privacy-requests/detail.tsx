// The drawer of one personal data request (MILESTONE-3 M3-04, D.6): what the person asked for and when it is due, the
// system checks with who did them, what was done, the steps taken, and the actions of the request's type: "Start work"
// with the identity check, "Prepare a copy of the data" (access), "Correct name or job title" (correction), "Stop using
// the data" (restriction), "Erase the person" (erasure, a confirmation that names what stays and asks for the word
// ERASE), "Close with the answer", "Refuse", "Record withdrawal" and "Add note". A button that cannot run yet says why.
import { useCallback, useEffect, useState } from 'react';
import type { ApiResult } from '../../data/api/ApiClient';
import { useMutation } from '../api';
import { formatInstant, saveFile } from '../auditor-access/shared';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, ConfirmDialog, Drawer, Facts, Field, Modal, Table, TextInput, Textarea } from '../ui';
import type { Column } from '../ui';
import { ACTION_TEXT, CHANNEL_TEXT, RESULT_TEXT, STATUS_TEXT, TYPE_TEXT, actionsFor, statusTone, timeLeft } from './model';
import type { CheckView, Outcome, Patch, PrivacyRequestsAdapter, RequestDetail } from './model';
import { notePrivacyChanged, usePrivacyVersion } from './store';
import { TEXT } from './text';

/** A form of one required text (identity check, answer, reason, note). */
export function TextDialog({ ctx, open, title, label, hint, confirm, busy, error, onSubmit, onClose, maxLength = 2000 }: {
  ctx: HostContext;
  open: boolean;
  title: string;
  label: TextPair;
  hint?: TextPair;
  confirm: TextPair;
  busy: boolean;
  error: TextPair | null;
  onSubmit(text: string): void;
  onClose(): void;
  maxLength?: number;
}) {
  const [text, setText] = useState('');
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (open) {
      setText('');
      setMissing(false);
    }
  }, [open]);
  const submit = () => {
    if (!text.trim()) {
      setMissing(true);
      return;
    }
    onSubmit(text.trim());
  };
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(TEXT.cancel)}</Button>
          <Button variant="primary" busy={busy} onClick={submit}>{ctx.li(confirm)}</Button>
        </>
      )}
    >
      <div className="mx-stack">
        <Field label={label} hint={hint} error={missing ? TEXT.required : null} required>
          <Textarea value={text} onChange={setText} rows={4} maxLength={maxLength} />
        </Field>
        {error ? <Alert tone="bad">{ctx.li(error)}</Alert> : null}
      </div>
    </Modal>
  );
}

/** "Correct name or job title". */
export function RectifyDialog({ ctx, open, detail, busy, error, onSubmit, onClose }: {
  ctx: HostContext;
  open: boolean;
  detail: RequestDetail;
  busy: boolean;
  error: TextPair | null;
  onSubmit(body: { displayName?: string; jobTitle?: string | null }): void;
  onClose(): void;
}) {
  const [name, setName] = useState(detail.subject.name);
  const [job, setJob] = useState('');
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (open) {
      setName(detail.subject.name);
      setJob('');
      setMissing(false);
    }
  }, [open, detail.subject.name]);
  const submit = () => {
    if (!name.trim()) {
      setMissing(true);
      return;
    }
    onSubmit({ displayName: name.trim(), ...(job.trim() ? { jobTitle: job.trim() } : {}) });
  };
  return (
    <Modal
      open={open}
      title={ctx.fill(TEXT.rectifyTitle, { no: detail.requestNo })}
      sub={TEXT.rectifySub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(TEXT.cancel)}</Button>
          <Button variant="primary" busy={busy} onClick={submit}>{ctx.li(TEXT.rectify)}</Button>
        </>
      )}
    >
      <div className="mx-stack">
        <Field label={TEXT.displayName} error={missing ? TEXT.required : null} required>
          <TextInput value={name} onChange={setName} maxLength={150} />
        </Field>
        <Field label={TEXT.jobTitle}>
          <TextInput value={job} onChange={setJob} maxLength={150} />
        </Field>
        {error ? <Alert tone="bad">{ctx.li(error)}</Alert> : null}
      </div>
    </Modal>
  );
}

export type Dialog = 'start' | 'close' | 'refuse' | 'withdraw' | 'note' | 'rectify' | 'restrict' | 'erase' | null;

/** The checks table of a request. */
export function ChecksTable({ ctx, checks }: { ctx: HostContext; checks: CheckView[] }) {
  const name = (ms: string) => ctx.D?.MS?.find((m) => m.id === ms)?.short ?? ms.toUpperCase();
  const columns: Column<CheckView>[] = [
    { key: 'ms', label: TEXT.colSystem, render: (c) => <span style={{ fontWeight: 600 }}>{name(c.ms)}</span> },
    { key: 'status', label: TEXT.factStatus, render: (c) => <Badge tone={c.status === 'done' ? 'ok' : 'warn'}>{ctx.li(c.status === 'done' ? TEXT.checkDone : TEXT.checkOpen)}</Badge> },
    { key: 'by', label: TEXT.colCheckBy, render: (c) => (c.doneBy ? `${c.doneBy.displayName}, ${formatInstant(c.doneAt, ctx.lang)}` : '-') },
    { key: 'note', label: TEXT.colCheckNote, render: (c) => c.note ?? '-' },
  ];
  return <Table columns={columns} rows={checks} rowKey={(c) => c.id} />;
}

/** One loaded request: its facts, checks, result, steps and the actions of its type with their forms. */
export function RequestView({ ctx, adapter, detail: d, initialDialog = null }: { ctx: HostContext; adapter: PrivacyRequestsAdapter; detail: RequestDetail; initialDialog?: Dialog }) {
  const [dialog, setDialog] = useState<Dialog>(initialDialog);
  const [exportTask, setExportTask] = useState<string | null>(null);
  const run = useCallback((go: () => Promise<ApiResult<Outcome>>) => go(), []);
  const mutation = useMutation<() => Promise<ApiResult<Outcome>>, Outcome>(run);
  const day = (iso: string | null) => formatInstant(iso, ctx.lang);
  const perform = (go: () => Promise<ApiResult<Outcome>>, done: TextPair) => {
    void ctx.track(mutation.submit(go)).then((res) => {
      if (!res.ok) return;
      setDialog(null);
      ctx.toast(ctx.fill(done, { no: d.requestNo }));
      if (res.data.taskId) setExportTask(res.data.taskId);
      notePrivacyChanged();
    }, () => undefined);
  };
  const open = (next: Dialog) => {
    mutation.reset();
    setDialog(next);
  };
  const checkExport = (taskId: string) => {
    void ctx.track(adapter.exportState(taskId)).then((res) => {
      if (!res.ok) {
        ctx.toast(ctx.li(res.error.message));
        return;
      }
      if (res.data.status === 'succeeded' && res.data.downloadUrl) saveFile({ href: res.data.downloadUrl, fileName: `personal-data-${d.requestNo}.json` });
      else if (res.data.status === 'succeeded') ctx.toast(ctx.li(TEXT.sampleOnly));
      else ctx.toast(ctx.li(TEXT.exportQueued));
    }, () => undefined);
  };
  const acts = actionsFor(d);
  const left = timeLeft(ctx, d, Date.now(), (iso) => day(iso));
  const result = Object.entries(d.result ?? {}).filter(([, n]) => n > 0);
  const task = exportTask ?? d.exportTaskId;
  return (
    <div className="mx-stack" data-request={d.requestNo}>
      <Card title={TEXT.facts}>
        <Facts
          items={[
            { label: TEXT.factType, value: ctx.li(TYPE_TEXT[d.type]) },
            { label: TEXT.factPerson, value: d.subject.kind === 'member' ? d.subject.name : `${d.subject.name} (${ctx.li(TEXT.noAccount)})` },
            { label: TEXT.factEmail, value: d.subject.email ?? '-', mono: true },
            { label: TEXT.factChannel, value: ctx.li(CHANNEL_TEXT[d.channel]) },
            { label: TEXT.factReceived, value: day(d.receivedAt) },
            { label: TEXT.factDue, value: <span>{day(d.dueAt)} <Badge tone={left.tone}>{left.text}</Badge></span> },
            { label: TEXT.factStatus, value: <Badge tone={statusTone(d.status)}>{ctx.li(STATUS_TEXT[d.status])}</Badge> },
            { label: TEXT.factIdentity, value: d.identityCheckNote ? `${d.identityCheckNote}${d.identityCheckedBy ? `, ${d.identityCheckedBy.displayName}` : ''}` : '-' },
            { label: TEXT.factHandledBy, value: d.handledBy?.displayName ?? '-' },
            ...(d.note ? [{ label: TEXT.factNote, value: d.note }] : []),
            ...(d.outcome ? [{ label: TEXT.factOutcome, value: d.outcome }] : []),
          ]}
        />
      </Card>
      <Card title={TEXT.checks} sub={TEXT.checksSub} flush={d.checks.length > 0}>
        {d.checks.length ? <ChecksTable ctx={ctx} checks={d.checks} /> : <span className="mx-muted">{ctx.li(TEXT.noChecks)}</span>}
      </Card>
      {result.length ? (
        <Card title={TEXT.result}>
          <Facts items={result.map(([key, n]) => ({ label: RESULT_TEXT[key] ?? [key, key], value: String(n) }))} />
        </Card>
      ) : null}
      {acts.exportData.shown && task ? (
        <Alert tone="info">
          <div>{ctx.li(TEXT.exportQueued)}</div>
          <div style={{ marginTop: 8 }}><Button onClick={() => checkExport(task)}>{ctx.li(TEXT.exportReady)}</Button></div>
        </Alert>
      ) : null}
      {d.type === 'access' && d.subject.kind === 'other' && d.status === 'in_progress' ? <Alert tone="info">{ctx.li(TEXT.exportNoAccount)}</Alert> : null}
      <Card title={TEXT.steps}>
        <ol className="mx-stack" style={{ gap: 6, margin: 0, paddingLeft: 20 }}>
          {d.actions.map((a, i) => (
            <li key={`${a.action}-${i}`}>
              <span style={{ fontWeight: 600 }}>{ctx.li(ACTION_TEXT[a.action] ?? [a.action, a.action])}</span>
              <span className="mx-small"> {formatInstant(a.at, ctx.lang)}{a.actor ? `, ${a.actor.displayName}` : ''}</span>
            </li>
          ))}
        </ol>
      </Card>
      <Card title={TEXT.actions}>
        <div className="mx-btn-group" style={{ flexWrap: 'wrap' }} data-actions="privacy-request">
          {acts.start ? <Button variant="primary" onClick={() => open('start')}>{ctx.li(TEXT.start)}</Button> : null}
          {acts.exportData.shown ? <Button disabledReason={acts.exportData.waits} busy={mutation.busy} onClick={() => perform(() => adapter.exportPerson(d.id), TEXT.exportQueued)}>{ctx.li(TEXT.exportData)}</Button> : null}
          {acts.rectify.shown ? <Button disabledReason={acts.rectify.waits} onClick={() => open('rectify')}>{ctx.li(TEXT.rectify)}</Button> : null}
          {acts.restrict.shown ? <Button disabledReason={acts.restrict.waits} onClick={() => open('restrict')}>{ctx.li(TEXT.restrict)}</Button> : null}
          {acts.erase.shown ? <Button variant="danger" disabledReason={acts.erase.waits} onClick={() => open('erase')}>{ctx.li(TEXT.erase)}</Button> : null}
          {acts.close.shown ? <Button variant="primary" disabledReason={acts.close.waits} onClick={() => open('close')}>{ctx.li(TEXT.close)}</Button> : null}
          {acts.refuse ? <Button onClick={() => open('refuse')}>{ctx.li(TEXT.refuse)}</Button> : null}
          {acts.withdraw ? <Button onClick={() => open('withdraw')}>{ctx.li(TEXT.withdraw)}</Button> : null}
          <Button variant="link" onClick={() => open('note')}>{ctx.li(TEXT.addNote)}</Button>
        </div>
        {mutation.error && dialog === null ? <div style={{ marginTop: 12 }}><Alert tone="bad">{ctx.li(mutation.error.message)}</Alert></div> : null}
      </Card>
      <TextDialog
        ctx={ctx}
        open={dialog === 'start'}
        title={ctx.fill(TEXT.startTitle, { no: d.requestNo })}
        label={TEXT.identityNote}
        hint={TEXT.identityHint}
        confirm={TEXT.start}
        maxLength={500}
        busy={mutation.busy}
        error={mutation.error?.message ?? null}
        onClose={() => setDialog(null)}
        onSubmit={(text) => perform(() => adapter.update(d.id, { action: 'start', identityCheckNote: text } satisfies Patch, d.etag), TEXT.started)}
      />
      <TextDialog
        ctx={ctx}
        open={dialog === 'close'}
        title={ctx.fill(TEXT.closeTitle, { no: d.requestNo })}
        label={TEXT.outcome}
        confirm={TEXT.close}
        busy={mutation.busy}
        error={mutation.error?.message ?? null}
        onClose={() => setDialog(null)}
        onSubmit={(text) => perform(() => adapter.close(d.id, text), TEXT.closed)}
      />
      <TextDialog
        ctx={ctx}
        open={dialog === 'refuse'}
        title={ctx.fill(TEXT.refuseTitle, { no: d.requestNo })}
        label={TEXT.reason}
        confirm={TEXT.refuse}
        maxLength={1000}
        busy={mutation.busy}
        error={mutation.error?.message ?? null}
        onClose={() => setDialog(null)}
        onSubmit={(text) => perform(() => adapter.update(d.id, { action: 'refuse', reason: text }, d.etag), TEXT.refused)}
      />
      <TextDialog
        ctx={ctx}
        open={dialog === 'withdraw'}
        title={ctx.fill(TEXT.withdrawTitle, { no: d.requestNo })}
        label={TEXT.reason}
        confirm={TEXT.withdraw}
        maxLength={1000}
        busy={mutation.busy}
        error={mutation.error?.message ?? null}
        onClose={() => setDialog(null)}
        onSubmit={(text) => perform(() => adapter.update(d.id, { action: 'withdraw', reason: text }, d.etag), TEXT.withdrawn)}
      />
      <TextDialog
        ctx={ctx}
        open={dialog === 'note'}
        title={ctx.fill(TEXT.noteTitle, { no: d.requestNo })}
        label={TEXT.noteText}
        confirm={TEXT.addNote}
        busy={mutation.busy}
        error={mutation.error?.message ?? null}
        onClose={() => setDialog(null)}
        onSubmit={(text) => perform(() => adapter.update(d.id, { action: 'note', note: text }, d.etag), TEXT.noted)}
      />
      <RectifyDialog
        ctx={ctx}
        open={dialog === 'rectify'}
        detail={d}
        busy={mutation.busy}
        error={mutation.error?.message ?? null}
        onClose={() => setDialog(null)}
        onSubmit={(b) => perform(() => adapter.rectify(d.id, b), TEXT.rectified)}
      />
      <ConfirmDialog
        open={dialog === 'restrict'}
        title={ctx.fill(TEXT.restrictTitle, { no: d.requestNo })}
        body={<p style={{ margin: 0 }}>{ctx.li(TEXT.restrictBody)}</p>}
        confirmLabel={TEXT.restrict}
        busy={mutation.busy}
        error={mutation.error?.message ?? null}
        onConfirm={() => perform(() => adapter.restrict(d.id), TEXT.restricted)}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'erase'}
        title={ctx.fill(TEXT.eraseTitle, { no: d.requestNo })}
        tone="bad"
        body={d.subject.kind === 'member' ? (
          <div className="mx-stack" data-erase="member">
            <p style={{ margin: 0 }}>{ctx.li(TEXT.eraseBody)}</p>
            <p style={{ margin: 0 }}>{ctx.li(TEXT.eraseStays)}</p>
          </div>
        ) : <div className="mx-stack" data-erase="other"><p style={{ margin: 0 }}>{ctx.li(TEXT.eraseOther)}</p></div>}
        confirmLabel={TEXT.erase}
        requireText={d.subject.kind === 'member' ? 'ERASE' : undefined}
        busy={mutation.busy}
        error={mutation.error?.message ?? null}
        onConfirm={() => perform(() => adapter.erase(d.id), TEXT.erased)}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}

export function RequestDrawer({ ctx, adapter, id, onClose }: { ctx: HostContext; adapter: PrivacyRequestsAdapter; id: string; onClose(): void }) {
  const version = usePrivacyVersion();
  const [loaded, setLoaded] = useState<ApiResult<RequestDetail> | null>(null);
  useEffect(() => {
    let live = true;
    void adapter.get(id).then((res) => { if (live) setLoaded(res); });
    return () => { live = false; };
  }, [adapter, id, version]);
  const title = loaded?.ok ? ctx.fill(TEXT.requestTitle, { no: loaded.data.requestNo }) : ctx.li(TEXT.crumb);
  let body;
  if (!loaded) body = <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  else if (!loaded.ok) body = <Alert tone="bad" title={TEXT.loadFailed}>{ctx.li(loaded.error.message)}</Alert>;
  else body = <RequestView ctx={ctx} adapter={adapter} detail={loaded.data} />;
  return (
    <Drawer open title={title} crumb={TEXT.crumb} onClose={onClose}>
      {body}
    </Drawer>
  );
}
