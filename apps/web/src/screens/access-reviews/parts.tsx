// Shared parts of Access reviews and Access review of this system (MILESTONE-3 M3-07, D.9): loading from the adapter
// into state, the loading and error lines of a card, a person with a date, who granted an item (with the requester and
// approver of a business role), the table of review items with selection and its per-row actions, the decision form for one item or a selection, the "Mark as applied" and "Not applied"
// forms, and the warning of items that only their own subject could decide.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import { formatInstant } from '../auditor-access/shared';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Field, Modal, Radio, Table, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import type { ApplyBody, DecideBody, DecisionForm, ItemRow, Outcome, PersonRef, Result, WarningRow } from './model';
import { DECISION_TEXT, DECISION_TONE, KIND_TEXT, accessText, appliedText, decisionBody, decisionErrors, formatDay, noteError, settled } from './model';
import { accessReviewsVersion, subscribeAccessReviews } from './store';
import { TEXT } from './text';

export type Loaded<T> = { loading: boolean; data: T | null; error: ApiError | null; reload(): void };

/** Loads from the adapter into state; it reads again on `reload` and after every access review command. */
export function useLoad<T>(load: () => Promise<Result<T>>, deps: unknown[]): Loaded<T> {
  const changed = useSyncExternalStore(subscribeAccessReviews, accessReviewsVersion, accessReviewsVersion);
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: ApiError | null }>({ loading: true, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    void settled(load()).then((res) => {
      if (!live) return;
      setState(res.ok ? { loading: false, data: res.data, error: null } : { loading: false, data: null, error: res.error });
    });
    return () => {
      live = false;
    };
  }, [...deps, tick, changed]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** The loading line and the error alert of a card. */
export function LoadState({ ctx, list }: { ctx: HostContext; list: Loaded<unknown> }) {
  return (
    <>
      {list.loading && !list.data ? <div className="mx-small" role="status" style={{ padding: 12 }}>{ctx.li(TEXT.loading)}</div> : null}
      {list.error ? (
        <div style={{ padding: 12 }}>
          <Alert tone="bad" title={TEXT.loadFailed}>
            <span style={{ display: 'block' }}>{ctx.li(list.error.message)}</span>
            <Button variant="link" onClick={list.reload}>{ctx.li(TEXT.tryAgain)}</Button>
          </Alert>
        </div>
      ) : null}
    </>
  );
}

/** A person and the instant of their step, or `-`. */
export function PersonAt({ ctx, who, at }: { ctx: HostContext; who: PersonRef | null; at: string | null }) {
  if (!who) return <span className="mx-muted">-</span>;
  return (
    <span style={{ display: 'block' }}>
      {who.displayName}
      {at ? <span className="mx-small" style={{ display: 'block' }}>{formatInstant(at, ctx.lang)}</span> : null}
    </span>
  );
}

/** The warnings a command or a review gives (REVIEW-SINGLE-ADMIN), in the interface language. */
export function Warnings({ ctx, warnings }: { ctx: HostContext; warnings: readonly WarningRow[] }) {
  if (!warnings.length) return null;
  return (
    <Alert tone="warn" title={TEXT.secondReviewerTitle}>
      {warnings.map((w, i) => <span key={i} style={{ display: 'block' }}>{ctx.lang === 'id' ? w.messages.id : w.messages.en}</span>)}
    </Alert>
  );
}

/** The text of a command's outcome for a toast: its message, else `fallback`. */
export const outcomeText = (ctx: HostContext, outcome: Outcome, fallback: string): string => (outcome.message ? ctx.li(outcome.message) : fallback);

/** The error text of a refused command (with the rule's message where the server sent one). */
export function errorText(ctx: HostContext, error: ApiError): string {
  return ctx.li(error.message);
}

const HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;

/** The checkbox of a row: its label names the item for screen readers, the row shows the item itself. */
export function RowCheck({ name, checked, onChange, label }: { name: string; checked: boolean; onChange(on: boolean): void; label: string }) {
  return (
    <label className="mx-check" style={{ position: 'relative' }}>
      <input type="checkbox" name={name} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span style={HIDDEN}>{label}</span>
    </label>
  );
}

/** The decision of a row: its badge, note and who decided; or why it waits. */
export function DecisionCell({ ctx, row }: { ctx: HostContext; row: ItemRow }) {
  if (row.decision) {
    return (
      <span style={{ display: 'block', minWidth: 0 }}>
        <Badge tone={DECISION_TONE[row.decision]}>{ctx.li(DECISION_TEXT[row.decision])}</Badge>
        {row.decisionNote ? <span className="mx-small" style={{ display: 'block', overflowWrap: 'anywhere' }}>{row.decisionNote}</span> : null}
        {row.decidedBy ? <span className="mx-small" style={{ display: 'block' }}>{ctx.fill(TEXT.decidedBy, { name: row.decidedBy.displayName })}</span> : null}
      </span>
    );
  }
  if (row.needsSecondReviewer) return <Badge tone="warn">{ctx.li(TEXT.needsSecond)}</Badge>;
  if (row.ownAccess) return <span className="mx-small">{ctx.li(TEXT.ownAccessWait)}</span>;
  return <span className="mx-muted">{ctx.li(TEXT.notDecided)}</span>;
}

/** How a decision was applied, with who and when, or the reason it is not applied. */
export function AppliedCell({ ctx, row }: { ctx: HostContext; row: ItemRow }) {
  const text = appliedText(row, ctx.li);
  if (!text) return <span className="mx-muted">-</span>;
  return (
    <span style={{ display: 'block', minWidth: 0 }}>
      {text}
      {row.appliedNote ? <span className="mx-small" style={{ display: 'block', overflowWrap: 'anywhere' }}>{row.appliedNote}</span> : null}
      {row.notAppliedReason ? <span className="mx-small" style={{ display: 'block', overflowWrap: 'anywhere' }}>{row.notAppliedReason}</span> : null}
      {row.appliedBy ? <span className="mx-small" style={{ display: 'block' }}>{row.appliedAt ? ctx.fill(TEXT.appliedByAt, { name: row.appliedBy.displayName, at: formatInstant(row.appliedAt, ctx.lang) }) : ctx.fill(TEXT.explainedBy, { name: row.appliedBy.displayName })}</span> : null}
    </span>
  );
}

/** The access an item reviews: its kind, the role or provider, and its end date or pending approval. */
export function AccessCell({ ctx, row }: { ctx: HostContext; row: ItemRow }) {
  return (
    <span style={{ display: 'block', minWidth: 0 }}>
      <strong>{accessText(row, ctx.li)}</strong>
      <span className="mx-small" style={{ display: 'block' }}>{ctx.li(KIND_TEXT[row.kind])}{row.ms ? ` ${row.ms.toUpperCase()}` : ''}</span>
      {row.validUntil ? <span className="mx-small" style={{ display: 'block' }}>{ctx.fill(TEXT.validUntil, { date: formatDay(row.validUntil, ctx.lang) })}</span> : null}
      {row.pendingApproval ? <Badge tone="info">{ctx.li(TEXT.pendingApproval)}</Badge> : null}
    </span>
  );
}

/**
 * Who granted an item and when. A business role names who asked for it and who approved it under the four-eyes flow
 * (D.9); the other kinds name who granted them.
 */
export function GrantedCell({ ctx, row }: { ctx: HostContext; row: ItemRow }) {
  if (row.requestedBy || row.approvedBy) {
    return (
      <span style={{ display: 'block', minWidth: 0 }}>
        {row.requestedBy ? <span style={{ display: 'block' }}>{ctx.fill(TEXT.requestedByName, { name: row.requestedBy.displayName })}</span> : null}
        {row.approvedBy ? <span style={{ display: 'block' }}>{ctx.fill(TEXT.approvedByName, { name: row.approvedBy.displayName })}</span> : null}
        {row.grantedAt ? <span className="mx-small" style={{ display: 'block' }}>{formatInstant(row.grantedAt, ctx.lang)}</span> : null}
      </span>
    );
  }
  if (row.grantedBy) return <PersonAt ctx={ctx} who={row.grantedBy} at={row.grantedAt} />;
  return row.grantedAt ? <>{formatInstant(row.grantedAt, ctx.lang)}</> : <span className="mx-muted">-</span>;
}

/** The person of an item, with "you" for the session's own access. */
export function PersonCell({ ctx, row }: { ctx: HostContext; row: ItemRow }) {
  return (
    <span style={{ display: 'block', minWidth: 0 }}>
      <strong data-person="" style={{ overflowWrap: 'anywhere' }}>{row.subject.displayName}</strong>
      <span className="mx-small mx-mono" style={{ display: 'block', overflowWrap: 'anywhere' }}>{row.subject.handle}</span>
      {row.ownAccess ? <Badge tone="acc">{ctx.li(TEXT.you)}</Badge> : null}
    </span>
  );
}

/** The table of review items, with a checkbox column when `selection` is given and the actions of each row. */
export function ItemsTable({ ctx, rows, selection, actions, empty, caption }: {
  ctx: HostContext;
  rows: ItemRow[];
  selection?: { selected: Set<string>; toggle(id: string, on: boolean): void; can(row: ItemRow): boolean };
  actions?: (row: ItemRow) => ReactNode;
  empty?: ReactNode;
  caption?: TextPair;
}) {
  const columns: Column<ItemRow>[] = [
    ...(selection ? [{
      key: 'select', label: TEXT.select, width: 72,
      render: (r: ItemRow) => (selection.can(r)
        ? <RowCheck name={`select-${r.id}`} checked={selection.selected.has(r.id)} onChange={(on) => selection.toggle(r.id, on)} label={ctx.fill(TEXT.selectItem, { name: r.subject.displayName, access: accessText(r, ctx.li) })} />
        : null),
    }] : []),
    { key: 'person', label: TEXT.colPerson, render: (r) => <PersonCell ctx={ctx} row={r} /> },
    { key: 'access', label: TEXT.colAccess, render: (r) => <AccessCell ctx={ctx} row={r} /> },
    { key: 'granted', label: TEXT.colGranted, render: (r) => <GrantedCell ctx={ctx} row={r} /> },
    { key: 'signin', label: TEXT.colLastSignIn, render: (r) => (r.lastSignInAt ? formatInstant(r.lastSignInAt, ctx.lang) : <span className="mx-muted">{ctx.li(TEXT.noSignIn)}</span>) },
    { key: 'decision', label: TEXT.colDecision, render: (r) => <DecisionCell ctx={ctx} row={r} /> },
    { key: 'applied', label: TEXT.colApplied, render: (r) => <AppliedCell ctx={ctx} row={r} /> },
    ...(actions ? [{ key: 'actions', label: TEXT.colActions, render: (r: ItemRow) => actions(r) }] : []),
  ];
  return <Table columns={columns} rows={rows} rowKey={(r) => r.id} empty={empty} caption={caption} />;
}

/**
 * The decision form for one item or a selection: keep, change (with a note) or revoke. Each item is sent in turn; a
 * refusal stops the run and shows its reason, and the items decided before it stay decided.
 */
export function DecisionDialog({ ctx, rows, run, onClose, onDone }: {
  ctx: HostContext;
  rows: ItemRow[];
  run(row: ItemRow, body: DecideBody): Promise<Result<Outcome>>;
  onClose(): void;
  onDone(count: number): void;
}) {
  const [form, setForm] = useState<DecisionForm>({ decision: '', note: '' });
  const [errors, setErrors] = useState<ReturnType<typeof decisionErrors>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const set = (patch: Partial<DecisionForm>) => {
    setForm((c) => ({ ...c, ...patch }));
    setErrors({});
  };
  const submit = async () => {
    const found = decisionErrors(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setFailure(null);
    let done = 0;
    for (const row of rows) {
      const res = await ctx.track(settled(run(row, decisionBody(form))));
      if (!res.ok) {
        setBusy(false);
        setFailure(done ? ctx.fill(TEXT.partlyDecided, { n: done, reason: errorText(ctx, res.error) }) : errorText(ctx, res.error));
        if (done) onDone(-done);
        return;
      }
      done += 1;
    }
    setBusy(false);
    onDone(done);
  };
  const title = rows.length === 1 ? ctx.fill(TEXT.decideOneTitle, { name: rows[0]!.subject.displayName }) : ctx.fill(TEXT.decideManyTitle, { n: rows.length });
  return (
    <Modal
      open
      title={title}
      sub={TEXT.decideSub}
      onClose={onClose}
      layer={ctx.layer()}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={busy} onClick={() => void submit()}>{ctx.li(TEXT.saveDecision)}</Button>
        </>
      )}
    >
      {failure ? <Alert tone="bad">{failure}</Alert> : null}
      <ul className="mx-small" style={{ margin: '0 0 12px', paddingLeft: 18 }}>
        {rows.slice(0, 6).map((r) => <li key={r.id} style={{ overflowWrap: 'anywhere' }}>{`${r.subject.displayName}: ${accessText(r, ctx.li)}`}</li>)}
        {rows.length > 6 ? <li>{`+${rows.length - 6}`}</li> : null}
      </ul>
      <Radio
        legend={TEXT.fDecision}
        name="decision"
        value={form.decision}
        onChange={(v) => set({ decision: v as DecisionForm['decision'] })}
        options={[{ value: 'keep', label: TEXT.dKeepLong }, { value: 'change', label: TEXT.dChangeLong }, { value: 'revoke', label: TEXT.dRevokeLong }]}
      />
      {errors.decision ? <span className="mx-error" role="alert">{ctx.li(errors.decision)}</span> : null}
      <Field label={form.decision === 'change' ? TEXT.fChangeNote : TEXT.fNote} hint={TEXT.fNoteHint} error={errors.note ?? null} required={form.decision === 'change'}>
        <Textarea name="note" rows={3} maxLength={500} value={form.note} onChange={(v) => set({ note: v })} />
      </Field>
    </Modal>
  );
}

/** "Not applied" (a reason, required) or "Mark as applied" (a note, optional) for one decided item. */
export function ApplyNoteDialog({ ctx, row, kind, run, onClose, onDone }: {
  ctx: HostContext;
  row: ItemRow;
  kind: 'not_applied' | 'mark_applied';
  run(body: ApplyBody): Promise<Result<Outcome>>;
  onClose(): void;
  onDone(outcome: Outcome): void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<TextPair | string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = () => {
    const found = noteError(text, kind === 'mark_applied');
    if (found) {
      setError(found);
      return;
    }
    setBusy(true);
    setError(null);
    const body: ApplyBody = kind === 'not_applied' ? { action: 'not_applied', reason: text.trim() } : { action: 'mark_applied', ...(text.trim() ? { note: text.trim() } : {}) };
    void ctx.track(settled(run(body))).then((res) => {
      setBusy(false);
      if (!res.ok) setError(errorText(ctx, res.error));
      else onDone(res.data);
    });
  };
  const title = ctx.fill(kind === 'not_applied' ? TEXT.notAppliedTitle : TEXT.markAppliedTitle, { name: row.subject.displayName, access: accessText(row, ctx.li) });
  return (
    <Modal
      open
      title={title}
      sub={kind === 'not_applied' ? TEXT.notAppliedSub : TEXT.markAppliedSub}
      onClose={onClose}
      layer={ctx.layer()}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={busy} onClick={submit}>{ctx.li(kind === 'not_applied' ? TEXT.recordNotApplied : TEXT.markApplied)}</Button>
        </>
      )}
    >
      {row.decisionNote ? <p className="mx-small" style={{ marginTop: 0 }}>{ctx.fill(TEXT.decisionWas, { note: row.decisionNote })}</p> : null}
      <Field label={kind === 'not_applied' ? TEXT.fReason : TEXT.fAppliedNote} error={typeof error === 'string' ? null : error} required={kind === 'not_applied'}>
        <Textarea name={kind === 'not_applied' ? 'reason' : 'note'} rows={3} maxLength={500} value={text} onChange={(v) => { setText(v); setError(null); }} />
      </Field>
      {typeof error === 'string' ? <div className="mx-error" role="alert">{error}</div> : null}
    </Modal>
  );
}
