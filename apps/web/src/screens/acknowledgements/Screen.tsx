// Policy read confirmations (MILESTONE-3 M3-05, D.7, `/ms/:ms/acknowledgements`): the confirmation requests of the
// documents of the selected system with their totals (confirmed, pending, overdue, excused). A request opens in a
// drawer with its facts and, for those who hold `audit.pending.all` (Management System Manager, Programme Owner), the
// person list; Top Management and anyone with only `audit.pending.aggregate` see the totals (product decisions 2 and 3).
// The Management System Manager asks for confirmation of an approved document ("Ask for confirmation", also the page
// action), reminds the pending people, downloads the register as CSV and closes a request, filing the register as a
// new file of an evidence item ("Close and file as evidence").
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import { Illustration } from '../../illustrations';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Badge, Button, Card, Checkbox, Drawer, EmptyState, Facts, Field, Modal, Radio, RecordPicker, Select, Table, TextInput, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { invalidateConfirmations } from '../my-confirmations/store';
import { adapterFor } from './adapter';
import type { AcknowledgementRole, AcknowledgementScope, AcknowledgementsAdapter, Download, PersonRow, RequestDetail, RequestRow, Totals } from './model';
import {
  AUDIENCE_ROLES, MANAGE_PERM, PEOPLE_PERM, SCOPES, approvedDocuments, askBlock, audienceText, dayOf, errorText, evidenceItems, personStatus, roleLabel,
  settled,
} from './model';
import { TEXT } from './text';
import './acknowledgements.css';

/** Saves a file the adapter offers (an api link, or a file made in the browser). */
export function saveDownload(file: Download): void {
  if (typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = file.href;
  a.download = file.fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (file.release) setTimeout(file.release, 1000);
}

/** The four totals of a request as tiles. */
export function TotalsTiles({ ctx, totals }: { ctx: HostContext; totals: Totals }) {
  const tile = (key: string, label: TextPair, value: number, tone?: 'bad' | 'ok') => (
    <li className="mx-ack-stat" data-stat={key}>
      <span className="mx-ack-stat-label">{ctx.li(label)}</span>
      <span className="mx-ack-stat-value" data-value={value} data-tone={tone}>{key === 'confirmed' ? ctx.fill(TEXT.confirmedOf, { confirmed: value, audience: totals.audience }) : value}</span>
    </li>
  );
  return (
    <ul className="mx-ack-stats" aria-label={ctx.li(TEXT.totalsLabel)}>
      {tile('confirmed', TEXT.statConfirmed, totals.confirmed, totals.confirmed > 0 ? 'ok' : undefined)}
      {tile('pending', TEXT.statPending, totals.pending)}
      {tile('overdue', TEXT.statOverdue, totals.overdue, totals.overdue > 0 ? 'bad' : undefined)}
      {tile('excused', TEXT.statExcused, totals.excused)}
    </ul>
  );
}

/** The table of requests; a row opens its drawer. */
export function RequestsTable({ ctx, rows, onOpen }: { ctx: HostContext; rows: RequestRow[]; onOpen(row: RequestRow): void }) {
  const columns: Column<RequestRow>[] = [
    {
      key: 'document',
      label: TEXT.colDocument,
      render: (r) => (
        <span className="mx-ack-doc" data-request={r.id}>
          <span className="mx-ack-code">{r.document.code}</span>
          <span className="mx-ack-title">{r.document.title}</span>
        </span>
      ),
    },
    { key: 'version', label: TEXT.colVersion, render: (r) => <span className="mx-mono">v{r.version.label}</span> },
    { key: 'due', label: TEXT.colDue, render: (r) => dayOf(ctx, r.dueOn) },
    { key: 'confirmed', label: TEXT.colConfirmed, align: 'right', render: (r) => <span className="mx-ack-num" data-confirmed={r.totals.confirmed}>{ctx.fill(TEXT.confirmedOf, { confirmed: r.totals.confirmed, audience: r.totals.audience })}</span> },
    { key: 'pending', label: TEXT.colPending, align: 'right', render: (r) => <span className="mx-ack-num">{r.totals.pending}</span> },
    { key: 'overdue', label: TEXT.colOverdue, align: 'right', render: (r) => <span className={r.totals.overdue > 0 ? 'mx-ack-overdue' : 'mx-ack-num'}>{r.totals.overdue}</span> },
    { key: 'excused', label: TEXT.colExcused, align: 'right', render: (r) => <span className="mx-ack-num">{r.totals.excused}</span> },
    {
      key: 'state',
      label: TEXT.colState,
      render: (r) => <Badge tone={r.status === 'open' ? 'acc' : 'mute'}>{ctx.li(r.status === 'open' ? TEXT.stateOpen : TEXT.stateClosed)}</Badge>,
    },
  ];
  return <Table columns={columns} rows={rows} rowKey={(r) => r.id} onRow={onOpen} />;
}

/** The people of a request with their status, dates and reminders. */
export function PeopleTable({ ctx, people }: { ctx: HostContext; people: PersonRow[] }) {
  const columns: Column<PersonRow>[] = [
    { key: 'person', label: TEXT.colPerson, render: (p) => <span data-person={p.handle}>{p.name}</span> },
    {
      key: 'status',
      label: TEXT.colState,
      render: (p) => {
        const s = personStatus(p);
        return <Badge tone={s.tone} title={p.excusedReason ?? undefined}>{ctx.li(s.label)}</Badge>;
      },
    },
    { key: 'opened', label: TEXT.colOpened, render: (p) => dayOf(ctx, p.openedAt) },
    { key: 'confirmed', label: TEXT.colConfirmedAt, render: (p) => dayOf(ctx, p.confirmedAt) },
    { key: 'reminders', label: TEXT.colReminders, align: 'right', render: (p) => <span className="mx-ack-num">{p.reminderCount}</span> },
  ];
  return <Table columns={columns} rows={people} rowKey={(p) => p.handle} />;
}

type Busy = 'remind' | 'export' | null;

/** One request in a drawer: facts, totals, the person list where allowed, and the actions of the manager. */
export function RequestDrawer({ ctx, adapter, ms, row, onClose, onChanged }: {
  ctx: HostContext;
  adapter: AcknowledgementsAdapter;
  ms: MsId;
  row: RequestRow;
  onClose(): void;
  onChanged(): void;
}) {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [closing, setClosing] = useState(false);
  const live = useRef(true);
  useEffect(() => () => {
    live.current = false;
  }, []);
  const load = useCallback(() => {
    setError(null);
    void settled(adapter.get(ms, row.id)).then((res) => {
      if (!live.current) return;
      if (res.ok) setDetail(res.data);
      else setError(res.error);
    });
  }, [adapter, ms, row.id]);
  useEffect(() => load(), [load]);
  const current = detail ?? row;
  const manager = ctx.can(ms, MANAGE_PERM);
  const peopleAllowed = ctx.can(ms, PEOPLE_PERM);
  const open = current.status === 'open';
  const remind = () => {
    setBusy('remind');
    setActionError(null);
    void ctx.track(settled(adapter.remind(ms, row.id))).then((res) => {
      if (!live.current) return;
      setBusy(null);
      if (!res.ok) {
        setActionError(res.error);
        return;
      }
      if (res.data.message) ctx.toast(ctx.li(res.data.message));
      load();
      onChanged();
    });
  };
  const exportCsv = () => {
    setBusy('export');
    setActionError(null);
    void settled(adapter.exportCsv(ms, current)).then((res) => {
      if (!live.current) return;
      setBusy(null);
      if (res.ok) saveDownload(res.data);
      else setActionError(res.error);
    });
  };
  const title = ctx.fill(TEXT.drawerTitle, { code: current.document.code, version: current.version.label });
  return (
    <>
      <Drawer open title={title} crumb={TEXT.drawerCrumb} onClose={onClose} layer={ctx.layer()}>
        <div className="mx-stack" data-acknowledgement-request={row.id}>
          <Facts
            items={[
              { label: TEXT.factDocument, value: `${current.document.code} ${current.document.title}` },
              { label: TEXT.factAudience, value: audienceText(ctx, current.audienceScope, current.audienceRoles) },
              { label: TEXT.factStarted, value: dayOf(ctx, current.createdAt) },
              { label: TEXT.factDue, value: dayOf(ctx, current.dueOn) },
              { label: TEXT.factReminded, value: current.lastRemindedAt ? dayOf(ctx, current.lastRemindedAt) : ctx.li(TEXT.never) },
              ...(current.closedAt ? [{ label: TEXT.factClosed, value: dayOf(ctx, current.closedAt) }] : []),
              ...(current.evidenceId ? [{ label: TEXT.factEvidence, value: evidenceLabel(ctx, ms, current.evidenceId) }] : []),
            ]}
          />
          <TotalsTiles ctx={ctx} totals={current.totals} />
          {!open ? <Alert tone="info">{ctx.li(TEXT.closedNote)}</Alert> : null}
          {actionError ? <Alert tone="bad">{errorText(ctx, actionError)}</Alert> : null}
          {manager || peopleAllowed ? (
            <div className="mx-ack-actions">
              {manager && open ? <Button busy={busy === 'remind'} onClick={remind}>{ctx.li(TEXT.remind)}</Button> : null}
              {peopleAllowed ? <Button busy={busy === 'export'} onClick={exportCsv}>{ctx.li(TEXT.exportCsv)}</Button> : null}
              {manager && open ? <Button variant="primary" onClick={() => setClosing(true)}>{ctx.li(TEXT.closeFile)}</Button> : null}
            </div>
          ) : null}
          {error ? (
            <Alert tone="bad" title={TEXT.detailFailed}>
              <div>{errorText(ctx, error)}</div>
              <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
            </Alert>
          ) : null}
          {peopleAllowed && detail?.people ? (
            <Card title={TEXT.peopleTitle} flush>
              <PeopleTable ctx={ctx} people={detail.people} />
            </Card>
          ) : !peopleAllowed ? <p className="mx-ack-note">{ctx.li(TEXT.totalsOnly)}</p> : null}
        </div>
      </Drawer>
      {closing ? (
        <CloseDialog
          ctx={ctx}
          adapter={adapter}
          ms={ms}
          row={current}
          onCancel={() => setClosing(false)}
          onDone={() => {
            setClosing(false);
            load();
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}

/** The evidence code of an evidence id (the snapshot ref's code in API builds, the code itself in the sample). */
function evidenceLabel(ctx: HostContext, ms: MsId, id: string): string {
  const refs = (ctx.D as unknown as { refs?: Record<string, { id: string; code: string }> } | null)?.refs ?? {};
  const prefix = `${ms}:ev:`;
  const hit = Object.entries(refs).find(([key, ref]) => key.startsWith(prefix) && ref.id === id);
  return hit ? hit[1].code : id;
}

/** "Close and file as evidence": an evidence item of the system, or a close without filing. */
export function CloseDialog({ ctx, adapter, ms, row, onCancel, onDone }: {
  ctx: HostContext;
  adapter: AcknowledgementsAdapter;
  ms: MsId;
  row: RequestRow;
  onCancel(): void;
  onDone(): void;
}) {
  const items = evidenceItems(ctx.D, ms);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'file' | 'close' | null>(null);
  const [error, setError] = useState<TextPair | string | null>(null);
  const send = (withEvidence: boolean) => {
    const evidenceId = withEvidence ? adapter.evidenceId(ms, code) : null;
    if (withEvidence && !evidenceId) {
      setError(TEXT.chooseEvidence);
      return;
    }
    setBusy(withEvidence ? 'file' : 'close');
    setError(null);
    void ctx.track(settled(adapter.close(ms, row.id, evidenceId))).then((res) => {
      setBusy(null);
      if (!res.ok) {
        setError(errorText(ctx, res.error));
        return;
      }
      ctx.toast(res.data.message ? ctx.li(res.data.message) : ctx.fill(TEXT.closed, { code: row.document.code }));
      if (res.data.changed.length) ctx.reload(res.data.changed).catch(() => undefined);
      onDone();
    });
  };
  return (
    <Modal
      open
      title={ctx.fill(TEXT.closeTitle, { code: row.document.code })}
      sub={TEXT.closeSub}
      onClose={onCancel}
      layer={ctx.layer()}
      footer={(
        <>
          <Button onClick={onCancel}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button busy={busy === 'close'} disabled={busy !== null} onClick={() => send(false)}>{ctx.li(TEXT.closeOnly)}</Button>
          <Button variant="primary" busy={busy === 'file'} disabled={busy !== null} onClick={() => send(true)}>{ctx.li(TEXT.closeAndFile)}</Button>
        </>
      )}
    >
      <div className="mx-stack" data-close-request={row.id}>
        {items.length ? (
          <Field label={TEXT.closeEvidence} hint={TEXT.closeEvidenceHint}>
            <RecordPicker value={code} onChange={(v) => { setCode(v); setError(null); }} records={items.map((e) => ({ id: e.code, title: e.title }))} />
          </Field>
        ) : <Alert tone="info">{ctx.li(TEXT.closeNoEvidence)}</Alert>}
        {error ? <div className="mx-error" role="alert">{typeof error === 'string' ? error : ctx.li(error)}</div> : null}
      </div>
    </Modal>
  );
}

/** "Ask for confirmation": an approved document, who is asked and the days to confirm. */
export function AskDialog({ ctx, adapter, ms, onCancel, onDone }: {
  ctx: HostContext;
  adapter: AcknowledgementsAdapter;
  ms: MsId;
  onCancel(): void;
  onDone(): void;
}) {
  const docs = approvedDocuments(ctx.D, ms);
  const [code, setCode] = useState('');
  const [scope, setScope] = useState<AcknowledgementScope>('system_roles');
  const [roles, setRoles] = useState<AcknowledgementRole[]>([]);
  const [days, setDays] = useState('14');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TextPair | string | null>(null);
  const toggle = (role: AcknowledgementRole, on: boolean) => setRoles((list) => (on ? [...list, role] : list.filter((r) => r !== role)));
  const send = () => {
    const documentId = code ? adapter.documentId(ms, code) : null;
    const block = askBlock({ documentId, scope, roles, dueDays: days });
    if (block) {
      setError(block);
      return;
    }
    setBusy(true);
    setError(null);
    const chosen = AUDIENCE_ROLES.filter((r) => roles.includes(r));
    void ctx.track(settled(adapter.ask(ms, { documentId: documentId!, scope, roles: chosen, dueDays: Number(days) }))).then((res) => {
      setBusy(false);
      if (!res.ok) {
        setError(errorText(ctx, res.error));
        return;
      }
      ctx.toast(res.data.message ? ctx.li(res.data.message) : ctx.fill(TEXT.asked, { n: res.data.count ?? 0, code }));
      // The session person may be in the audience: their list, banner and tasks change.
      invalidateConfirmations();
      if (!adapter.sample && res.data.changed.length) ctx.reload(res.data.changed).catch(() => undefined);
      onDone();
    });
  };
  return (
    <Modal
      open
      title={TEXT.askTitle}
      sub={TEXT.askSub}
      onClose={onCancel}
      layer={ctx.layer()}
      footer={(
        <>
          <Button onClick={onCancel}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={busy} onClick={send}>{ctx.li(TEXT.send)}</Button>
        </>
      )}
    >
      <div className="mx-stack" data-ask-confirmation="">
        {docs.length ? (
          <Field label={TEXT.askDocument} hint={TEXT.askDocumentHint} required>
            <Select
              value={code}
              onChange={(v) => { setCode(v); setError(null); }}
              options={docs.map((d) => ({ value: d.code, label: `${d.code} ${d.title}, v${d.version}` }))}
              empty={UI_TEXT.choose}
              name="document"
            />
          </Field>
        ) : <Alert tone="info">{ctx.li(TEXT.askNoDocuments)}</Alert>}
        <Radio
          legend={TEXT.audience}
          name="audience"
          value={scope}
          onChange={(v) => { setScope(v as AcknowledgementScope); setError(null); }}
          options={SCOPES.map((s) => ({ value: s, label: s === 'roles' ? TEXT.scopeRoles : s === 'organisation' ? TEXT.scopeOrganisation : TEXT.scopeSystemRoles }))}
        />
        {scope === 'roles' ? (
          <fieldset className="mx-radios">
            <legend className="mx-label">{ctx.li(TEXT.roles)}</legend>
            <div className="mx-ack-roles">
              {AUDIENCE_ROLES.map((r) => <Checkbox key={r} name={`role-${r}`} checked={roles.includes(r)} onChange={(on) => toggle(r, on)} label={roleLabel(r)} />)}
            </div>
            <span className="mx-hint">{ctx.li(TEXT.rolesHint)}</span>
          </fieldset>
        ) : null}
        <div style={{ maxWidth: 220 }}>
          <Field label={TEXT.dueDays} hint={TEXT.dueDaysHint}>
            <TextInput type="number" value={days} onChange={(v) => { setDays(v); setError(null); }} name="dueDays" />
          </Field>
        </div>
        {error ? <div className="mx-error" role="alert">{typeof error === 'string' ? error : ctx.li(error)}</div> : null}
      </div>
    </Modal>
  );
}

type LoadState = { loading: boolean; rows: RequestRow[] | null; error: ApiError | null };

export function RegisterBody({ ctx, adapter, ms }: { ctx: HostContext; adapter: AcknowledgementsAdapter; ms: MsId }) {
  const [state, setState] = useState<LoadState>({ loading: true, rows: null, error: null });
  const [openId, setOpenId] = useState<string | null>(typeof ctx.params.request === 'string' ? ctx.params.request : null);
  const [asking, setAsking] = useState(false);
  const live = useRef(true);
  useEffect(() => () => {
    live.current = false;
  }, []);
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    void settled(adapter.list(ms)).then((res) => {
      if (!live.current) return;
      setState(res.ok ? { loading: false, rows: res.data, error: null } : { loading: false, rows: null, error: res.error });
    });
  }, [adapter, ms]);
  useEffect(() => load(), [load]);
  // The page action "Ask for confirmation" opens the dialog with a new `ask` value.
  const ask = ctx.params.ask;
  useEffect(() => {
    if (ask !== undefined && ask !== null && ctx.can(ms, MANAGE_PERM)) setAsking(true);
  }, [ask]);
  const manager = ctx.can(ms, MANAGE_PERM);
  const rows = state.rows ?? [];
  const selected = openId ? rows.find((r) => r.id === openId) ?? null : null;
  return (
    <div className="mx-stack" data-register="">
      <p className="mx-ack-note">{ctx.li(TEXT.intro)}</p>
      {!ctx.can(ms, PEOPLE_PERM) ? <Alert tone="info">{ctx.li(TEXT.totalsOnly)}</Alert> : null}
      {adapter.sample ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
      <Card
        title={TEXT.listTitle}
        sub={TEXT.listSub}
        flush
        actions={manager ? <Button variant="primary" onClick={() => setAsking(true)}>{ctx.li(TEXT.ask)}</Button> : null}
      >
        {state.error ? (
          <div style={{ padding: 12 }}>
            <Alert tone="bad" title={TEXT.loadFailed}>
              <div>{errorText(ctx, state.error)}</div>
              <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
            </Alert>
          </div>
        ) : !state.rows ? (
          <div className="mx-small" role="status" style={{ padding: 12 }}>{ctx.li(TEXT.loading)}</div>
        ) : rows.length === 0 ? (
          <EmptyState illustration={<Illustration scene="no-documents" size="sm" decorative />} title={TEXT.emptyTitle} text={TEXT.emptyText} />
        ) : (
          <RequestsTable ctx={ctx} rows={rows} onOpen={(r) => setOpenId(r.id)} />
        )}
      </Card>
      {selected ? <RequestDrawer key={selected.id} ctx={ctx} adapter={adapter} ms={ms} row={selected} onClose={() => setOpenId(null)} onChanged={load} /> : null}
      {asking ? (
        <AskDialog
          ctx={ctx}
          adapter={adapter}
          ms={ms}
          onCancel={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

export default function AcknowledgementsScreen({ ctx }: ScreenProps) {
  const ms = ctx.msObj?.id;
  if (!ms) return <Card><EmptyState title={TEXT.noSystem} /></Card>;
  return <RegisterBody ctx={ctx} adapter={adapterFor(ctx)} ms={ms} />;
}
