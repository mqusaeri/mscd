// "My data" of My account (MILESTONE-3 M3-04, D.6.6): "Download my data" (the export of one's own data in the current
// organisation, queued on the server and downloaded when ready; a file made in the browser in the sample build),
// "Correct my name and job title" (`me.profile`, without a request, H.6), "Ask the organisation" (a correction, a stop
// to the use or an erasure, `me.privacy-requests.create`) and the list of the person's requests with status and due time.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult } from '../../data/api/ApiClient';
import { useMutation } from '../api';
import { formatInstant, saveFile, textFile } from '../auditor-access/shared';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, Field, Modal, Radio, Table, TextInput, Textarea } from '../ui';
import type { Column } from '../ui';
import { ASK_TEXT, ASK_TYPES, MY_STATUS_TEXT, MY_TYPE_TEXT, myDataFileName } from './model';
import type { AccountAdapter, AskType, MyRequest, ProfileCorrection, Result } from './model';
import { TEXT } from './text';

function asApi<T>(r: Result<T>): ApiResult<T> {
  return r.ok ? { ok: true, status: 200, data: r.data } : { ok: false, status: r.error.status, error: r.error };
}

/** "Correct my name and job title". */
export function CorrectDialog({ ctx, adapter, open, profile, onClose, onSaved }: {
  ctx: HostContext;
  adapter: AccountAdapter;
  open: boolean;
  profile: { name: string; jobTitle: string | null };
  onClose(): void;
  onSaved(correction: ProfileCorrection): void;
}) {
  const [name, setName] = useState(profile.name);
  const [job, setJob] = useState(profile.jobTitle ?? '');
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (open) {
      setName(profile.name);
      setJob(profile.jobTitle ?? '');
      setMissing(false);
    }
  }, [open, profile.name, profile.jobTitle]);
  const run = useCallback((c: ProfileCorrection) => adapter.correctProfile(c).then(asApi), [adapter]);
  const mutation = useMutation<ProfileCorrection, null>(run);
  useEffect(() => { if (open) mutation.reset(); }, [open]);
  const submit = () => {
    if (!name.trim()) {
      setMissing(true);
      return;
    }
    const correction: ProfileCorrection = { displayName: name.trim(), jobTitle: job.trim() || null };
    void ctx.track(mutation.submit(correction)).then((res) => {
      if (!res.ok) return;
      ctx.toast(ctx.li(TEXT.corrected));
      onSaved(correction);
    }, () => undefined);
  };
  return (
    <Modal
      open={open}
      title={TEXT.correctTitle}
      sub={TEXT.correctSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.correctSave)}</Button>
        </>
      )}
    >
      <div className="mx-stack" data-form="my-profile">
        <Field label={TEXT.name} error={missing ? TEXT.nameRequired : (mutation.fields.displayName ?? null)} required>
          <TextInput value={name} onChange={setName} maxLength={150} autoComplete="name" />
        </Field>
        <Field label={TEXT.jobTitle} error={mutation.fields.jobTitle ?? null}>
          <TextInput value={job} onChange={setJob} maxLength={150} autoComplete="organization-title" />
        </Field>
        {mutation.error && !Object.keys(mutation.fields).length ? <Alert tone="bad">{ctx.li(mutation.error.message)}</Alert> : null}
      </div>
    </Modal>
  );
}

/** "Ask the organisation": a correction, a stop to the use or an erasure. */
export function AskDialog({ ctx, adapter, open, onClose, onSent }: {
  ctx: HostContext;
  adapter: AccountAdapter;
  open: boolean;
  onClose(): void;
  onSent(): void;
}) {
  const [type, setType] = useState<AskType>('rectification');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) {
      setType('rectification');
      setNote('');
    }
  }, [open]);
  const run = useCallback((input: { type: AskType; note: string | null }) => adapter.askOrganisation(input.type, input.note).then(asApi), [adapter]);
  const mutation = useMutation(run);
  useEffect(() => { if (open) mutation.reset(); }, [open]);
  const submit = () => {
    void ctx.track(mutation.submit({ type, note: note.trim() || null })).then((res) => {
      if (!res.ok) return;
      ctx.toast(ctx.fill(TEXT.asked, { no: res.data.requestNo }));
      onSent();
    }, () => undefined);
  };
  return (
    <Modal
      open={open}
      title={TEXT.askTitle}
      sub={TEXT.askSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.askSend)}</Button>
        </>
      )}
    >
      <div className="mx-stack" data-form="my-privacy-request">
        <Radio legend={TEXT.askType} name="my-privacy-type" value={type} onChange={(v) => setType(v as AskType)} options={ASK_TYPES.map((t) => ({ value: t, label: ASK_TEXT[t] }))} />
        <Field label={TEXT.askNote} hint={TEXT.askNoteHint}>
          <Textarea value={note} onChange={setNote} rows={4} maxLength={2000} />
        </Field>
        {mutation.error ? <Alert tone="bad">{ctx.li(mutation.error.message)}</Alert> : null}
      </div>
    </Modal>
  );
}

/** The person's own requests. */
export function MyRequestsTable({ ctx, rows }: { ctx: HostContext; rows: MyRequest[] }) {
  const open = (r: MyRequest) => r.status === 'received' || r.status === 'in_progress';
  const columns: Column<MyRequest>[] = [
    { key: 'no', label: TEXT.colRequest, render: (r) => <span className="mx-mono" style={{ fontWeight: 600 }}>{r.requestNo}</span> },
    { key: 'type', label: TEXT.colType, render: (r) => ctx.li(MY_TYPE_TEXT[r.type]) },
    { key: 'status', label: TEXT.colStatus, render: (r) => <Badge tone={r.status === 'completed' ? 'ok' : open(r) ? 'warn' : 'mute'}>{ctx.li(MY_STATUS_TEXT[r.status])}</Badge> },
    { key: 'received', label: TEXT.colReceived, render: (r) => formatInstant(r.receivedAt, ctx.lang) },
    { key: 'due', label: TEXT.colDue, render: (r) => (open(r) || !r.closedAt ? formatInstant(r.dueAt, ctx.lang) : ctx.fill(TEXT.answered, { date: formatInstant(r.closedAt, ctx.lang) })) },
  ];
  return <Table columns={columns} rows={rows} rowKey={(r) => r.id} />;
}

/** The "My data" card. `profile` is what the page shows; `onCorrected` gives the page the saved correction. */
export function MyDataCard({ ctx, adapter, profile, handle, onCorrected }: {
  ctx: HostContext;
  adapter: AccountAdapter;
  profile: { name: string; email: string | null; jobTitle: string | null };
  handle: string;
  onCorrected(correction: ProfileCorrection): void;
}) {
  const [dialog, setDialog] = useState<'correct' | 'ask' | null>(null);
  const [requests, setRequests] = useState<Result<MyRequest[]> | null>(null);
  const [task, setTask] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'preparing' | 'failed'>('idle');
  const [problem, setProblem] = useState<TextPair | null>(null);
  const [busy, setBusy] = useState(false);
  const polls = useRef(0);
  const loadRequests = useCallback(() => {
    void adapter.myRequests().then(setRequests);
  }, [adapter]);
  useEffect(() => loadRequests(), [loadRequests]);
  const fileName = myDataFileName(handle, new Date().toISOString().slice(0, 10));
  const check = useCallback((taskId: string, quiet = false) => {
    void adapter.myDataState(taskId).then((res) => {
      if (!res.ok) {
        if (!quiet) setProblem([res.error.message[0], res.error.message[1]]);
        return;
      }
      if (res.data.status === 'succeeded' && res.data.downloadUrl) {
        saveFile({ href: res.data.downloadUrl, fileName });
        setTask(null);
        setState('idle');
        ctx.toast(ctx.li(TEXT.dataSaved));
      } else if (res.data.status === 'failed') {
        setTask(null);
        setState('failed');
      } else setState('preparing');
    }, () => undefined);
  }, [adapter, ctx, fileName]);
  // While a copy is prepared, its state is read again every five seconds for a minute.
  useEffect(() => {
    if (!task) return undefined;
    polls.current = 0;
    const timer = setInterval(() => {
      polls.current += 1;
      if (polls.current > 12) {
        clearInterval(timer);
        return;
      }
      check(task, true);
    }, 5000);
    return () => clearInterval(timer);
  }, [task, check]);
  const download = () => {
    setBusy(true);
    setProblem(null);
    void ctx.track(adapter.requestMyData(profile)).then((res) => {
      setBusy(false);
      if (!res.ok) {
        setProblem([res.error.message[0], res.error.message[1]]);
        return;
      }
      if ('file' in res.data) {
        saveFile(textFile(res.data.file.text, res.data.file.fileName, 'application/json'));
        ctx.toast(ctx.li(TEXT.dataSaved));
        return;
      }
      setTask(res.data.taskId);
      setState('preparing');
    }, () => setBusy(false));
  };
  let list;
  if (!requests) list = <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  else if (!requests.ok) list = <Alert tone="bad" title={TEXT.requestsFailed}>{ctx.li(requests.error.message)}</Alert>;
  else if (!requests.data.length) list = <span className="mx-muted">{ctx.li(TEXT.noRequests)}</span>;
  else list = <MyRequestsTable ctx={ctx} rows={requests.data} />;
  return (
    <Card title={TEXT.myData} sub={TEXT.myDataSub}>
      <div className="mx-stack" data-section="my-data">
        <div className="mx-btn-group" style={{ flexWrap: 'wrap' }}>
          <Button variant="primary" busy={busy} onClick={download}>{ctx.li(TEXT.downloadData)}</Button>
          <Button onClick={() => setDialog('correct')}>{ctx.li(TEXT.correctProfile)}</Button>
          <Button onClick={() => setDialog('ask')}>{ctx.li(TEXT.askOrganisation)}</Button>
        </div>
        <span className="mx-small">{ctx.li(TEXT.downloadDataNote)}</span>
        {state === 'preparing' && task ? (
          <Alert tone="info">
            <div>{ctx.li(TEXT.dataPreparing)}</div>
            <div style={{ marginTop: 8 }}><Button onClick={() => check(task)}>{ctx.li(TEXT.dataCheck)}</Button></div>
          </Alert>
        ) : null}
        {state === 'failed' ? <Alert tone="bad">{ctx.li(TEXT.dataFailed)}</Alert> : null}
        {problem ? <Alert tone="bad">{ctx.li(problem)}</Alert> : null}
        <h3 className="mx-label" style={{ margin: '8px 0 0' }}>{ctx.li(TEXT.myRequests)}</h3>
        {list}
      </div>
      <CorrectDialog
        ctx={ctx}
        adapter={adapter}
        open={dialog === 'correct'}
        profile={profile}
        onClose={() => setDialog(null)}
        onSaved={(c) => { setDialog(null); onCorrected(c); }}
      />
      <AskDialog ctx={ctx} adapter={adapter} open={dialog === 'ask'} onClose={() => setDialog(null)} onSent={() => { setDialog(null); loadRequests(); }} />
    </Card>
  );
}
