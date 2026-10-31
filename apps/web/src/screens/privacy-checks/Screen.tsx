// Personal data checks (MILESTONE-3 M3-04, D.6.4, `/ms/:ms/privacy-checks`): the checks of the selected system, open
// ones first by due time. A check opens a drawer with the records of the system whose text names the person (record
// kind, code, field and the text found, each with a link to the screen that edits it), a link to Handover for the
// person's open items, and "Mark checked" with a note of what was checked and changed.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiResult } from '../../data/api/ApiClient';
import { useMutation } from '../api';
import { formatInstant } from '../auditor-access/shared';
import { notePrivacyChanged, usePrivacyVersion } from '../privacy-requests/store';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Badge, Button, Card, Drawer, EmptyState, Facts, Field, Modal, Table, Textarea } from '../ui';
import type { Column } from '../ui';
import { adapterFor } from './adapter';
import { TYPE_TEXT, fieldText, kindText, targetOf } from './model';
import type { CheckRow, Mention, Mentions, PrivacyChecksAdapter } from './model';
import { TEXT } from './text';

/** The status badge of a check. */
export function CheckStatus({ ctx, row }: { ctx: HostContext; row: Pick<CheckRow, 'status' | 'doneAt' | 'dueAt'> }) {
  if (row.status === 'done') return <Badge tone="ok">{row.doneAt ? ctx.fill(TEXT.doneOn, { date: formatInstant(row.doneAt, ctx.lang) }) : ctx.li(TEXT.done)}</Badge>;
  const late = new Date(row.dueAt).getTime() < Date.now();
  return <Badge tone={late ? 'bad' : 'warn'}>{ctx.li(late ? TEXT.overdue : TEXT.open)}</Badge>;
}

/** "Mark checked": the note of what was checked and changed. */
export function MarkDialog({ ctx, open, row, busy, error, onSubmit, onClose }: {
  ctx: HostContext;
  open: boolean;
  row: CheckRow;
  busy: boolean;
  error: TextPair | null;
  onSubmit(note: string): void;
  onClose(): void;
}) {
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (open) {
      setNote('');
      setMissing(false);
    }
  }, [open]);
  const submit = () => {
    if (!note.trim()) {
      setMissing(true);
      return;
    }
    onSubmit(note.trim());
  };
  return (
    <Modal
      open={open}
      title={ctx.fill(TEXT.markTitle, { no: row.requestNo })}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(TEXT.cancel)}</Button>
          <Button variant="primary" busy={busy} onClick={submit}>{ctx.li(TEXT.markDone)}</Button>
        </>
      )}
    >
      <div className="mx-stack" data-form="privacy-check-done">
        <Field label={TEXT.markNote} hint={TEXT.markHint} error={missing ? TEXT.required : null} required>
          <Textarea value={note} onChange={setNote} rows={4} maxLength={500} />
        </Field>
        {error ? <Alert tone="bad">{ctx.li(error)}</Alert> : null}
      </div>
    </Modal>
  );
}

/** The records that name the person of a check. */
export function MentionsTable({ ctx, ms, mentions }: { ctx: HostContext; ms: string; mentions: Mentions }) {
  const columns: Column<Mention>[] = [
    { key: 'kind', label: TEXT.colRecord, render: (m) => <span style={{ fontWeight: 600 }}>{ctx.li(kindText(m.recordKind))}</span> },
    { key: 'code', label: TEXT.colCode, render: (m) => (m.code ? <span className="mx-mono">{m.code}</span> : '-') },
    { key: 'field', label: TEXT.colField, render: (m) => fieldText(m.field) },
    { key: 'text', label: TEXT.colText, render: (m) => <span className="mx-small" style={{ fontSize: 12 }}>{m.excerpt}</span> },
    {
      key: 'open',
      label: TEXT.openRecord,
      render: (m) => {
        const target = targetOf(ms, m);
        return target
          ? <Button variant="link" onClick={() => ctx.go(target.screen, target.extra)}>{ctx.li(TEXT.openRecord)}</Button>
          : <span className="mx-small">{ctx.li(TEXT.noPage)}</span>;
      },
    },
  ];
  return (
    <div className="mx-stack">
      {mentions.truncated ? <Alert tone="warn">{ctx.li(TEXT.truncated)}</Alert> : null}
      <Table columns={columns} rows={mentions.items} rowKey={(m) => `${m.recordKind}:${m.recordId}:${m.field}`} />
    </div>
  );
}

export function CheckDrawer({ ctx, adapter, ms, row, onClose }: { ctx: HostContext; adapter: PrivacyChecksAdapter; ms: string; row: CheckRow; onClose(): void }) {
  const [mentions, setMentions] = useState<ApiResult<Mentions> | null>(null);
  const [marking, setMarking] = useState(false);
  const version = usePrivacyVersion();
  useEffect(() => {
    let live = true;
    setMentions(null);
    void adapter.mentions(ms, row.id).then((res) => { if (live) setMentions(res); });
    return () => { live = false; };
  }, [adapter, ms, row.id, version]);
  const run = useCallback((note: string) => adapter.done(ms, row.id, note), [adapter, ms, row.id]);
  const mutation = useMutation(run);
  const submit = (note: string) => {
    void ctx.track(mutation.submit(note)).then((res) => {
      if (!res.ok) return;
      setMarking(false);
      ctx.toast(ctx.fill(TEXT.marked, { no: row.requestNo }));
      notePrivacyChanged();
    }, () => undefined);
  };
  let found;
  if (!mentions) found = <div className="mx-small" role="status">{ctx.li(TEXT.mentionsLoading)}</div>;
  else if (!mentions.ok) found = <Alert tone="bad">{ctx.li(mentions.error.message)}</Alert>;
  else if (!mentions.data.items.length) found = <span className="mx-muted">{ctx.li(TEXT.noMentions)}</span>;
  else found = <MentionsTable ctx={ctx} ms={ms} mentions={mentions.data} />;
  const handle = row.subject.handle;
  return (
    <Drawer open title={ctx.fill(TEXT.checkTitle, { no: row.requestNo })} crumb={TEXT.crumb} onClose={onClose}>
      <div className="mx-stack" data-check={row.requestNo}>
        <Card title={TEXT.facts}>
          <Facts
            items={[
              { label: TEXT.colRequest, value: row.requestNo, mono: true },
              { label: TEXT.colType, value: ctx.li(TYPE_TEXT[row.type]) },
              { label: TEXT.colPerson, value: handle ? row.subject.name : `${row.subject.name} (${ctx.li(TEXT.noAccount)})` },
              { label: TEXT.colDue, value: formatInstant(row.dueAt, ctx.lang) },
              { label: TEXT.colStatus, value: <CheckStatus ctx={ctx} row={row} /> },
            ]}
          />
          <div style={{ marginTop: 12 }}>
            <Button variant="primary" disabledReason={row.status === 'done' ? TEXT.alreadyDone : null} onClick={() => { mutation.reset(); setMarking(true); }}>{ctx.li(TEXT.markDone)}</Button>
          </div>
        </Card>
        <Card title={TEXT.mentions} sub={TEXT.mentionsSub}>
          {found}
        </Card>
        {handle ? (
          <Card title={TEXT.handover}>
            <p style={{ margin: '0 0 12px' }}>{ctx.fill(TEXT.handoverText, { name: row.subject.name })}</p>
            <Button onClick={() => ctx.go('handover', { ms, params: { handle, name: row.subject.name } })}>{ctx.li(TEXT.handoverOpen)}</Button>
          </Card>
        ) : null}
      </div>
      <MarkDialog ctx={ctx} open={marking} row={row} busy={mutation.busy} error={mutation.error?.message ?? null} onSubmit={submit} onClose={() => setMarking(false)} />
    </Drawer>
  );
}

export default function PrivacyChecksScreen({ ctx }: ScreenProps) {
  const adapter = useMemo(() => adapterFor(ctx), [ctx.client, ctx.ds]);
  const ms = ctx.msObj?.id ?? null;
  const version = usePrivacyVersion();
  const [rows, setRows] = useState<ApiResult<CheckRow[]> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (!ms) return undefined;
    let live = true;
    setRows(null);
    void adapter.list(ms).then((res) => { if (live) setRows(res); });
    return () => { live = false; };
  }, [adapter, ms, version, attempt]);
  useEffect(() => { setOpenId(null); }, [ms]);
  const columns: Column<CheckRow>[] = [
    { key: 'no', label: TEXT.colRequest, render: (r) => <span className="mx-mono" style={{ fontWeight: 600 }}>{r.requestNo}</span> },
    { key: 'type', label: TEXT.colType, render: (r) => ctx.li(TYPE_TEXT[r.type]) },
    { key: 'person', label: TEXT.colPerson, render: (r) => <span>{r.subject.name}{r.subject.handle ? null : <span className="mx-small"> ({ctx.li(TEXT.noAccount)})</span>}</span> },
    { key: 'due', label: TEXT.colDue, render: (r) => formatInstant(r.dueAt, ctx.lang) },
    { key: 'status', label: TEXT.colStatus, render: (r) => <CheckStatus ctx={ctx} row={r} /> },
  ];
  let body;
  if (!rows) body = <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  else if (!rows.ok) {
    body = (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <div>{ctx.li(rows.error.message)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={() => setAttempt((n) => n + 1)}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  } else if (!rows.data.length) body = <EmptyState title={TEXT.emptyTitle} text={TEXT.emptyText} />;
  else body = <Table columns={columns} rows={rows.data} rowKey={(r) => r.id} onRow={(r) => setOpenId(r.id)} />;
  const open = rows?.ok && openId ? rows.data.find((r) => r.id === openId) ?? null : null;
  return (
    <>
      <Card title={TEXT.title} flush={Boolean(rows?.ok && rows.data.length)}>{body}</Card>
      {open && ms ? <CheckDrawer ctx={ctx} adapter={adapter} ms={ms} row={open} onClose={() => setOpenId(null)} /> : null}
    </>
  );
}
