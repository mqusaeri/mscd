// Handover (MILESTONE-2 M2-10, `/ms/:ms/handover`): an MS Manager or the Programme Owner of the selected system picks
// a person, sees the open items that person holds in the system (`records.holdings`, H.13: detail for MM and PO), and
// moves all of them, or the kinds ticked, to a successor in one step (`records.holdings.reassign`). The rules of the
// system run per record and their warnings are shown per record after the move; records shared with other systems
// ask for the BR-22 confirmation first. The person may have left: someone disabled, or whose last role was revoked, is
// no longer among the snapshot's people but still holds items, so the picker also lists the holders the snapshot names
// and the person People and roles opened the screen with, and takes a typed user name.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { useMutation } from '../api';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, Field, PersonPicker, Table, TextInput, UI_TEXT } from '../ui';
import type { Column, PersonOption } from '../ui';
import { Illustration } from '../../illustrations';
import { adapterFor, settled } from './adapter';
import { KIND_ORDER, formerPeople, handleOf, kindLabel, kindRows, moveBlock, nameOf, peopleOf, reassignBody, sortedItems } from './model';
import type { HandoverAdapter, HeldItem, HoldingKind, HoldingsModel, MoveOutcome } from './model';
import { TEXT } from './text';

/** The text of a refusal: the server's message, with its detail when it carries no translated message. */
export function errorText(ctx: HostContext, error: ApiError): string {
  const message = ctx.li(error.message);
  return error.detail && error.message[0] === error.message[1] && !error.messageKey ? `${message}: ${error.detail}` : message;
}

/** A date (or instant) as a day in the interface language. */
function dayOf(ctx: HostContext, iso: string | null): string {
  if (!iso) return '-';
  const day = iso.slice(0, 10);
  return ctx.D ? ctx.D.fmt(day, ctx.lang) : day;
}

/** The open items of a person: a table of the kinds with a tick each, and a table of the items. */
export function HoldingsView({ ctx, model, chosen, onChoose }: {
  ctx: HostContext;
  model: HoldingsModel;
  chosen: readonly HoldingKind[];
  onChoose(kind: HoldingKind, on: boolean): void;
}) {
  const rows = kindRows(model);
  const kindColumns: Column<{ kind: HoldingKind; count: number }>[] = [
    {
      key: 'kind',
      label: TEXT.colKind,
      render: (r) => <Checkbox checked={chosen.includes(r.kind)} onChange={(on) => onChoose(r.kind, on)} label={kindLabel(r.kind)} name={`kind-${r.kind}`} />,
    },
    { key: 'count', label: TEXT.colCount, align: 'right', render: (r) => r.count },
  ];
  const itemColumns: Column<HeldItem>[] = [
    { key: 'kind', label: TEXT.colKind, render: (i) => <Badge tone="mute">{ctx.li(kindLabel(i.kind))}</Badge> },
    { key: 'code', label: TEXT.colCode, render: (i) => <span className="mx-mono" style={{ fontWeight: 600 }}>{i.code}</span> },
    { key: 'title', label: TEXT.colTitle, render: (i) => <span style={{ overflowWrap: 'anywhere' }}>{i.title}</span> },
    { key: 'due', label: TEXT.colDue, render: (i) => dayOf(ctx, i.dueAt) },
  ];
  return (
    <>
      <Card title={TEXT.summary} sub={TEXT.summarySub} flush>
        <Table columns={kindColumns} rows={rows} rowKey={(r) => r.kind} />
      </Card>
      <Card title={TEXT.itemsTitle} flush>
        <Table columns={itemColumns} rows={sortedItems(model.items)} rowKey={(i) => `${i.kind}:${i.code}`} />
      </Card>
    </>
  );
}

/** The label of a person in a picker: the name with the job title, or the name with the user name when only that is known. */
function optionLabel(p: PersonOption): string {
  if (p.jobTitle && p.jobTitle !== '-') return `${p.name}, ${p.jobTitle}`;
  return p.name !== p.id ? `${p.name} (${p.id})` : p.id;
}

/**
 * The person who holds the items: the active members with a role, then (when there are any) the former members and
 * people without a role who still hold items. A native select with option groups, labelled like the fields of the kit.
 */
export function HolderPicker({ ctx, value, onChange, people, former }: {
  ctx: HostContext;
  value: string;
  onChange(handle: string): void;
  people: readonly PersonOption[];
  former: readonly PersonOption[];
}) {
  const id = useId();
  const option = (p: PersonOption) => <option key={p.id} value={p.id}>{optionLabel(p)}</option>;
  return (
    <div className="mx-field">
      <label className="mx-label" htmlFor={`${id}-control`}>{ctx.li(TEXT.person)}</label>
      <select id={`${id}-control`} className="mx-select" name="holder" value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`}>
        <option value="">{ctx.li(UI_TEXT.choose)}</option>
        {former.length ? (
          <>
            <optgroup label={ctx.li(TEXT.groupMembers)}>{people.map(option)}</optgroup>
            <optgroup label={ctx.li(TEXT.groupFormer)} data-group="former">{former.map(option)}</optgroup>
          </>
        ) : people.map(option)}
      </select>
      <span id={`${id}-hint`} className="mx-hint">{ctx.li(TEXT.personHint)}</span>
    </div>
  );
}

/** A user name typed for a person the picker does not list; a name that cannot be a user name is refused here. */
export function TypedHolder({ ctx, onPick }: { ctx: HostContext; onPick(handle: string): void }) {
  const [typed, setTyped] = useState('');
  const [invalid, setInvalid] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const handle = handleOf(typed);
    setInvalid(!handle);
    if (handle) {
      setTyped('');
      onPick(handle);
    }
  };
  return (
    <form onSubmit={submit} style={{ maxWidth: 420 }} data-typed-holder="">
      <Field label={TEXT.typedLabel} hint={TEXT.typedHint} error={invalid ? TEXT.typedInvalid : null}>
        <div className="mx-row" style={{ flexWrap: 'nowrap' }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <TextInput value={typed} onChange={(v) => { setTyped(v); setInvalid(false); }} name="holderHandle" autoComplete="off" maxLength={40} />
          </div>
          <Button type="submit">{ctx.li(TEXT.showItems)}</Button>
        </div>
      </Field>
    </form>
  );
}

type LoadState = { loading: boolean; model: HoldingsModel | null; error: ApiError | null };

export function HandoverBody({ ctx, adapter, ms }: { ctx: HostContext; adapter: HandoverAdapter; ms: string }) {
  const context = useRef(ctx);
  context.current = ctx;
  const people = useMemo(() => peopleOf(ctx), [ctx.D]);
  const requested = typeof ctx.params.handle === 'string' ? ctx.params.handle : '';
  const requestedName = typeof ctx.params.name === 'string' ? ctx.params.name : '';
  const [holder, setHolder] = useState(requested);
  const [typed, setTyped] = useState<string[]>([]);
  const names = useMemo<Record<string, string>>(() => (requested && requestedName ? { [requested]: requestedName } : {}), [requested, requestedName]);
  const former = useMemo(() => formerPeople(ctx, ms, [requested, ...typed].filter(Boolean), names), [ctx.D, ms, requested, typed, names]);
  const pick = (handle: string) => {
    if (!people.some((p) => p.id === handle)) setTyped((list) => (list.includes(handle) ? list : [...list, handle]));
    setHolder(handle);
  };
  const [successor, setSuccessor] = useState('');
  const [chosen, setChosen] = useState<HoldingKind[]>([]);
  const [state, setState] = useState<LoadState>({ loading: false, model: null, error: null });
  const [asking, setAsking] = useState<{ kinds: HoldingKind[] | null } | null>(null);
  const [shared, setShared] = useState<{ kinds: HoldingKind[] | null; message: TextPair } | null>(null);
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null);
  useEffect(() => {
    if (requested) setHolder(requested);
  }, [requested]);
  const load = useCallback(() => {
    if (!holder) {
      setState({ loading: false, model: null, error: null });
      return undefined;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    settled(adapter.holdings(ms, holder)).then((res) => {
      if (!live) return;
      setState(res.ok ? { loading: false, model: res.data, error: null } : { loading: false, model: null, error: res.error });
    });
    return () => {
      live = false;
    };
  }, [adapter, ms, holder]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    setChosen([]);
    setOutcome(null);
    if (successor === holder) setSuccessor('');
  }, [holder, ms]);
  const move = useMutation<{ kinds: HoldingKind[] | null; confirm: boolean }, MoveOutcome>((input) => settled(adapter.reassign(ms, holder, reassignBody(successor, input.kinds, input.confirm))).then((r): ApiResult<MoveOutcome> => (
    r.ok ? { ok: true, status: 200, data: r.data } : { ok: false, status: r.error.status, error: r.error })));
  const send = (kinds: HoldingKind[] | null, confirm: boolean) => {
    move.submit({ kinds, confirm }).then((res) => {
      setAsking(null);
      if (!res.ok) {
        // BR-22: records shared with other systems change there too; ask, then send again with `confirm`.
        if (res.error.slug === 'confirmation-required') setShared({ kinds, message: res.error.message });
        else setShared(null);
        return;
      }
      setShared(null);
      const c = context.current;
      setOutcome(res.data);
      c.toast(res.data.message ? c.li(res.data.message) : c.fill(TEXT.moved, { n: res.data.count, successor: nameOf(c, successor) }));
      setChosen([]);
      load();
      c.reload(res.data.changed.length ? res.data.changed : [ms]).catch(() => undefined);
    });
  };
  const model = state.model;
  const system = ctx.msObj?.short ?? ms.toUpperCase();
  const holderName = holder ? nameOf(ctx, holder, names) : '';
  const holderFormer = Boolean(holder) && !people.some((p) => p.id === holder);
  const total = model ? model.items.length : 0;
  const allBlock = moveBlock(holder, successor, null);
  const kindsBlock = moveBlock(holder, successor, chosen);
  const refused = move.error && move.error.slug !== 'confirmation-required' ? move.error : null;
  const kindsText = KIND_ORDER.filter((k) => chosen.includes(k)).map((k) => ctx.li(kindLabel(k))).join(', ');
  return (
    <>
      <Card>
        <div className="mx-stack" style={{ gap: 14 }}>
          <div style={{ maxWidth: 420 }}>
            <HolderPicker ctx={ctx} value={holder} onChange={setHolder} people={people} former={former} />
          </div>
          <TypedHolder ctx={ctx} onPick={pick} />
        </div>
      </Card>
      {holderFormer ? <Alert tone="info">{ctx.fill(TEXT.formerNote, { name: holderName })}</Alert> : null}
      {ctx.mode === 'sample' ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
      {outcome && outcome.warnings.length ? (
        <Alert tone="warn" title={TEXT.warningsTitle}>
          <div>{ctx.li(TEXT.warningsSub)}</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {outcome.warnings.map((w, i) => <li key={i}>{ctx.li(w.text)}</li>)}
          </ul>
        </Alert>
      ) : null}
      {!holder ? (
        <Card><EmptyState title={TEXT.choosePerson} text={TEXT.pickFirst} /></Card>
      ) : state.error ? (
        <Alert tone="bad" title={TEXT.loadFailed}>
          <div>{errorText(ctx, state.error)}</div>
          <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
        </Alert>
      ) : !model ? (
        <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div>
      ) : total === 0 ? (
        <Card>
          <EmptyState
            illustration={<Illustration scene="all-done" size="sm" decorative />}
            title={TEXT.nothingHeld}
            text={ctx.fill(TEXT.nothingHeldText, { name: holderName, system })}
          />
        </Card>
      ) : (
        <>
          <Card title={ctx.fill(TEXT.heldTitle, { name: holderName, system })} sub={total === 1 ? TEXT.heldSubOne : ctx.fill(TEXT.heldSub, { n: total })}>
            <div className="mx-row" style={{ alignItems: 'flex-end' }}>
              <div style={{ minWidth: 260, flex: '1 1 260px', maxWidth: 420 }}>
                <Field label={TEXT.successor} hint={TEXT.successorHint}>
                  <PersonPicker value={successor} onChange={setSuccessor} people={people.filter((p) => p.id !== holder)} />
                </Field>
              </div>
            </div>
            <div className="mx-row" style={{ marginTop: 12 }}>
              <Button variant="primary" disabledReason={allBlock} busy={move.busy && !asking?.kinds} onClick={() => setAsking({ kinds: null })}>{ctx.li(TEXT.moveAllButton)}</Button>
              <Button disabledReason={allBlock ? null : kindsBlock} disabled={Boolean(allBlock)} onClick={() => setAsking({ kinds: [...chosen] })}>{ctx.li(TEXT.moveChosen)}</Button>
            </div>
            {refused ? <div style={{ marginTop: 12 }}><Alert tone="bad">{errorText(ctx, refused)}</Alert></div> : null}
          </Card>
          <HoldingsView ctx={ctx} model={model} chosen={chosen} onChoose={(kind, on) => setChosen((c) => (on ? [...c, kind] : c.filter((k) => k !== kind)))} />
        </>
      )}
      <ConfirmDialog
        open={Boolean(asking)}
        title={TEXT.confirmTitle}
        body={(
          <>
            <div>
              {asking?.kinds
                ? ctx.fill(TEXT.confirmKinds, { kinds: kindsText, name: holderName, system, successor: successor ? nameOf(ctx, successor) : '' })
                : ctx.fill(TEXT.confirmAll, { n: total, name: holderName, system, successor: successor ? nameOf(ctx, successor) : '' })}
            </div>
            <div style={{ marginTop: 8 }}>{ctx.li(TEXT.confirmNote)}</div>
          </>
        )}
        confirmLabel={TEXT.move}
        busy={move.busy}
        onConfirm={() => asking && send(asking.kinds, false)}
        onCancel={() => setAsking(null)}
      />
      <ConfirmDialog
        open={Boolean(shared)}
        title={TEXT.sharedTitle}
        body={(
          <>
            <div>{shared ? ctx.li(shared.message) : null}</div>
            <div style={{ marginTop: 8 }}>{ctx.li(TEXT.sharedBody)}</div>
          </>
        )}
        confirmLabel={TEXT.sharedConfirm}
        busy={move.busy}
        onConfirm={() => shared && send(shared.kinds, true)}
        onCancel={() => setShared(null)}
      />
    </>
  );
}

export default function HandoverScreen({ ctx }: ScreenProps) {
  const context = useRef(ctx);
  context.current = ctx;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(() => context.current), [client]);
  const ms = ctx.msObj?.id ?? null;
  if (!ms) return <Alert tone="info">{ctx.li(TEXT.noSystem)}</Alert>;
  if (!ctx.can(ms, 'record.assign')) return <Alert tone="info">{ctx.li(TEXT.readOnly)}</Alert>;
  return <HandoverBody key={ms} ctx={ctx} adapter={adapter} ms={ms} />;
}
