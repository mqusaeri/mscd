// Personal data requests (MILESTONE-3 M3-04, D.6): the register of requests from one person, with filters (status, type,
// search by number or name) and the time left, "Record request" (a member of the organisation from the member list, or a
// person without an account by name and email; what they ask for, when and how it arrived), and the request drawer
// (detail.tsx) with the system checks, the steps taken and the actions of the request's type. A link from a
// notification opens its request (`params.request`).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiResult } from '../../data/api/ApiClient';
import { useMutation } from '../api';
import { formatInstant } from '../auditor-access/shared';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Badge, Button, Card, DateInput, EmptyState, Field, Modal, Radio, RecordPicker, Select, Table, TextInput, Textarea } from '../ui';
import type { Column } from '../ui';
import { adapterFor } from './adapter';
import { RequestDrawer } from './detail';
import {
  CHANNEL_TEXT, RECORD_CHANNELS, STATUS_TEXT, STATUSES, TYPES, TYPE_TEXT, isOpen, recordBody, recordErrors, statusTone, timeLeft,
} from './model';
import type { ListFilter, Member, PrivacyRequestsAdapter, RecordInput, RequestRow, RequestType } from './model';
import { notePrivacyChanged, usePrivacyVersion } from './store';
import { TEXT } from './text';

const localDay = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
const localTime = (at: Date) => `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

interface RecordForm {
  type: RequestType;
  kind: 'member' | 'other';
  userId: string;
  name: string;
  email: string;
  date: string;
  time: string;
  channel: RecordInput['channel'];
  note: string;
}

export function emptyRecordForm(now = new Date()): RecordForm {
  return { type: 'access', kind: 'member', userId: '', name: '', email: '', date: localDay(now), time: localTime(now), channel: 'email', note: '' };
}

/** "Record request": the form of a new request. */
export function RecordDialog({ ctx, adapter, open, onClose, onDone }: {
  ctx: HostContext;
  adapter: PrivacyRequestsAdapter;
  open: boolean;
  onClose(): void;
  onDone(id: string): void;
}) {
  const [form, setForm] = useState<RecordForm>(() => emptyRecordForm());
  const [members, setMembers] = useState<Member[]>([]);
  const [shown, setShown] = useState<Partial<Record<'userId' | 'name' | 'email' | 'date' | 'time', TextPair>>>({});
  useEffect(() => {
    if (!open) return undefined;
    setForm(emptyRecordForm());
    setShown({});
    let live = true;
    void adapter.members().then((res) => { if (live && res.ok) setMembers(res.data); });
    return () => { live = false; };
  }, [open, adapter]);
  const run = useCallback((input: RecordInput): Promise<ApiResult<{ id: string; requestNo: string }>> => adapter.create(input), [adapter]);
  const mutation = useMutation(run);
  const set = <K extends keyof RecordForm>(key: K) => (value: string) => setForm((f) => ({ ...f, [key]: value as RecordForm[K] }));
  const submit = () => {
    const problems: Partial<Record<'userId' | 'name' | 'email' | 'date' | 'time', TextPair>> = { ...recordErrors(form) };
    if (!/^\d{2}:\d{2}$/.test(form.time)) problems.time = TEXT.required;
    setShown(problems);
    if (Object.keys(problems).length) return;
    void ctx.track(mutation.submit(recordBody(form))).then((res) => {
      if (!res.ok) return;
      ctx.toast(ctx.fill(TEXT.recorded, { no: res.data.requestNo }));
      notePrivacyChanged();
      onDone(res.data.id);
    }, () => undefined);
  };
  return (
    <Modal
      open={open}
      title={TEXT.recordTitle}
      sub={TEXT.recordSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.save)}</Button>
        </>
      )}
    >
      <div className="mx-stack" data-form="privacy-record">
        <Field label={TEXT.type}>
          <Select value={form.type} onChange={set('type')} options={TYPES.map((t) => ({ value: t, label: TYPE_TEXT[t] }))} />
        </Field>
        <Radio
          legend={TEXT.subjectKind}
          name="privacy-subject-kind"
          value={form.kind}
          onChange={set('kind')}
          options={[{ value: 'member', label: TEXT.subjectMember }, { value: 'other', label: TEXT.subjectOther }]}
        />
        {form.kind === 'member' ? (
          <Field label={TEXT.member} error={shown.userId ?? null} required>
            <RecordPicker
              value={members.find((m) => m.id === form.userId)?.handle ?? ''}
              onChange={(handle) => setForm((f) => ({ ...f, userId: members.find((m) => m.handle === handle)?.id ?? '' }))}
              records={members.map((m) => ({ id: m.handle, title: m.name, note: m.email }))}
            />
          </Field>
        ) : (
          <>
            <Field label={TEXT.personName} error={shown.name ?? null} required>
              <TextInput value={form.name} onChange={set('name')} maxLength={200} />
            </Field>
            <Field label={TEXT.personEmail} error={shown.email ?? null}>
              <TextInput type="email" value={form.email} onChange={set('email')} maxLength={320} />
            </Field>
          </>
        )}
        <div className="mx-row" style={{ alignItems: 'flex-start' }}>
          <Field label={TEXT.receivedAt} error={shown.date ?? null} required>
            <DateInput value={form.date} onChange={set('date')} max={localDay(new Date())} />
          </Field>
          <Field label={TEXT.receivedTime} error={shown.time ?? null} required>
            <TextInput value={form.time} onChange={set('time')} maxLength={5} placeholder={['HH:MM', 'JJ:MM']} />
          </Field>
        </div>
        <Field label={TEXT.channel}>
          <Select value={form.channel} onChange={set('channel')} options={RECORD_CHANNELS.map((c) => ({ value: c, label: CHANNEL_TEXT[c] }))} />
        </Field>
        <Field label={TEXT.note}>
          <Textarea value={form.note} onChange={set('note')} rows={3} maxLength={2000} />
        </Field>
        {mutation.error ? <Alert tone="bad">{ctx.li(mutation.error.message)}</Alert> : null}
      </div>
    </Modal>
  );
}

/** The register with its filters. */
export function RequestList({ ctx, adapter, onOpen }: { ctx: HostContext; adapter: PrivacyRequestsAdapter; onOpen(id: string): void }) {
  const version = usePrivacyVersion();
  const [filter, setFilter] = useState<ListFilter>({ status: '', type: '', q: '' });
  const [rows, setRows] = useState<ApiResult<RequestRow[]> | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setRows(null);
    void adapter.list(filter).then((res) => { if (live) setRows(res); });
    return () => { live = false; };
  }, [adapter, filter, version, attempt]);
  const now = Date.now();
  const day = (iso: string) => formatInstant(iso, ctx.lang);
  const columns: Column<RequestRow>[] = [
    { key: 'no', label: TEXT.colNo, render: (r) => <span className="mx-mono" style={{ fontWeight: 600 }}>{r.requestNo}</span> },
    { key: 'type', label: TEXT.colType, render: (r) => ctx.li(TYPE_TEXT[r.type]) },
    { key: 'person', label: TEXT.colPerson, render: (r) => <span>{r.subject.name}{r.subject.kind === 'other' ? <span className="mx-small"> ({ctx.li(TEXT.noAccount)})</span> : null}</span> },
    { key: 'status', label: TEXT.colStatus, render: (r) => <Badge tone={statusTone(r.status)}>{ctx.li(STATUS_TEXT[r.status])}</Badge> },
    { key: 'received', label: TEXT.colReceived, render: (r) => day(r.receivedAt) },
    {
      key: 'due',
      label: TEXT.colDue,
      render: (r) => {
        const left = timeLeft(ctx, r, now, day);
        return isOpen(r.status) ? <Badge tone={left.tone}>{left.text}</Badge> : <span className="mx-small">{left.text}</span>;
      },
    },
  ];
  const statusOptions = [{ value: '', label: TEXT.all }, { value: 'open', label: TEXT.openOnly }, ...STATUSES.map((s) => ({ value: s, label: STATUS_TEXT[s] }))];
  const typeOptions = [{ value: '', label: TEXT.all }, ...TYPES.map((t) => ({ value: t, label: TYPE_TEXT[t] }))];
  const filtered = filter.status !== '' || filter.type !== '' || filter.q.trim() !== '';
  let body;
  if (!rows) body = <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  else if (!rows.ok) {
    body = (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <div>{ctx.li(rows.error.message)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={() => setAttempt((n) => n + 1)}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  } else if (!rows.data.length && !filtered) {
    body = <EmptyState title={TEXT.emptyTitle} text={TEXT.emptyText} />;
  } else {
    body = (
      <Table
        columns={columns}
        rows={rows.data}
        rowKey={(r) => r.id}
        onRow={(r) => onOpen(r.id)}
        empty={<div style={{ padding: 'var(--pad)' }} className="mx-muted">{ctx.li(TEXT.noMatch)}</div>}
      />
    );
  }
  return (
    <Card title={TEXT.title} flush={Boolean(rows?.ok && rows.data.length)}>
      <div className="mx-row" style={{ padding: rows?.ok && rows.data.length ? 'var(--pad) var(--pad) 0' : 0, gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }} data-filters="privacy-requests">
        <Field label={TEXT.filterStatus}>
          <Select value={filter.status} onChange={(v) => setFilter((f) => ({ ...f, status: v as ListFilter['status'] }))} options={statusOptions} />
        </Field>
        <Field label={TEXT.filterType}>
          <Select value={filter.type} onChange={(v) => setFilter((f) => ({ ...f, type: v as ListFilter['type'] }))} options={typeOptions} />
        </Field>
        <Field label={TEXT.search}>
          <TextInput type="search" value={filter.q} onChange={(v) => setFilter((f) => ({ ...f, q: v }))} maxLength={100} />
        </Field>
      </div>
      <div style={{ marginTop: 12 }}>{body}</div>
    </Card>
  );
}

export default function PrivacyRequestsScreen({ ctx }: ScreenProps) {
  const adapter = useMemo(() => adapterFor(ctx), [ctx.client, ctx.ds]);
  const requested = typeof ctx.params.request === 'string' ? ctx.params.request : null;
  // The page action "Record request" opens the form through the params (`record`, a fresh value each time).
  const recordAsked = ctx.params.record ?? null;
  const [openId, setOpenId] = useState<string | null>(requested);
  const [recording, setRecording] = useState(false);
  useEffect(() => { if (requested) setOpenId(requested); }, [requested]);
  useEffect(() => { if (recordAsked !== null && recordAsked !== undefined) setRecording(true); }, [recordAsked]);
  return (
    <>
      <RequestList ctx={ctx} adapter={adapter} onOpen={setOpenId} />
      <RecordDialog ctx={ctx} adapter={adapter} open={recording} onClose={() => setRecording(false)} onDone={(id) => { setRecording(false); setOpenId(id); }} />
      {openId ? <RequestDrawer ctx={ctx} adapter={adapter} id={openId} onClose={() => setOpenId(null)} /> : null}
    </>
  );
}
