// The Findings tab of "Findings and actions" (MILESTONE-2 M2-14): the finding register with its filters, the finding
// drawer (facts, root cause and systemic check, the moves of C.13 with the BR-06, BR-07 and BR-08 messages) and its
// Edit, Close and Reopen dialogs.
import { useEffect, useMemo, useState } from 'react';
import type { MsId } from '../../data/types';
import { useMutation } from '../api';
import type { HostContext } from '../types';
import {
  Alert, Badge, Button, Card, DateInput, Drawer, EmptyState, Facts, Field, Modal, PersonPicker, Select, Table, TextInput, Textarea, UI_TEXT,
} from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import {
  CLASSIFICATIONS, CLASSIFICATION_TEXT, SOURCE_TEXT, byUrgency, closeNeedsNote, editErrors, editFormOf, editPatch, mayCreateAction, mayManageFinding,
} from './model';
import type { EditForm, FindingModel, FindingsAdapter, TargetOption } from './model';
import { ActionStatusBadge, ClassBadge, DrawerFoot, FindingStatusBadge, FormError } from './parts';
import type { Outcome } from './shared';
import { asApiResult, day, filled, outcomeText, peopleOf, personName } from './shared';
import { TEXT } from './text';

export type StatusFilter = 'open' | 'all' | 'closed';

export function filterFindings(rows: readonly FindingModel[], status: StatusFilter, classification: string): FindingModel[] {
  return rows
    .filter((f) => (status === 'all' ? true : status === 'closed' ? f.status === 'closed' : f.status !== 'closed'))
    .filter((f) => !classification || f.classification === classification)
    .sort(byUrgency);
}

/** The clause or control a finding concerns: its target code, else its reference text. */
export function clauseOf(f: Pick<FindingModel, 'targetCode' | 'clauseRef'>): string {
  return f.targetCode ?? f.clauseRef ?? '-';
}

export function FindingsTable({ ctx, rows, onOpen }: { ctx: HostContext; rows: FindingModel[]; onOpen(f: FindingModel): void }) {
  const columns: Column<FindingModel>[] = [
    { key: 'code', label: TEXT.colCode, render: (f) => <span className="mx-mono" style={{ whiteSpace: 'nowrap' }}>{f.code}</span> },
    { key: 'finding', label: TEXT.colFinding, render: (f) => <span>{f.title}</span> },
    { key: 'clause', label: TEXT.colClause, render: (f) => <span className="mx-mono">{clauseOf(f)}</span> },
    { key: 'class', label: TEXT.colClassification, render: (f) => <ClassBadge ctx={ctx} value={f.classification} /> },
    { key: 'source', label: TEXT.colSource, render: (f) => ctx.li(SOURCE_TEXT[f.source]) },
    { key: 'owner', label: TEXT.colOwner, render: (f) => personName(ctx.D, f.owner) },
    { key: 'due', label: TEXT.colDue, render: (f) => day(ctx, f.dueAt) },
    { key: 'status', label: TEXT.colStatus, render: (f) => <FindingStatusBadge ctx={ctx} value={f.status} /> },
  ];
  return <Table columns={columns} rows={rows} rowKey={(f) => f.id} onRow={onOpen} />;
}

export function FindingsList({ ctx, rows, canRaise, onRaise, onOpen }: {
  ctx: HostContext;
  rows: FindingModel[];
  canRaise: boolean;
  onRaise(): void;
  onOpen(f: FindingModel): void;
}) {
  const [status, setStatus] = useState<StatusFilter>('open');
  const [classification, setClassification] = useState('');
  const shown = filterFindings(rows, status, classification);
  const open = rows.filter((f) => f.status !== 'closed');
  if (!rows.length) {
    return (
      <Card>
        <EmptyState
          title={TEXT.noFindings}
          text={TEXT.noFindingsText}
          illustration={<Illustration scene="no-findings" />}
          action={canRaise ? <Button variant="primary" onClick={onRaise}>{ctx.li(TEXT.raise)}</Button> : null}
        />
      </Card>
    );
  }
  return (
    <Card
      title={TEXT.tabFindings}
      sub={ctx.fill(TEXT.openCount, { open: open.length, major: open.filter((f) => f.classification === 'major').length })}
      flush
    >
      <div className="mx-row" style={{ padding: '12px 16px', alignItems: 'flex-end' }}>
        <div style={{ width: 240 }}>
          <Field label={TEXT.filterStatus}>
            <Select value={status} onChange={(v) => setStatus(v as StatusFilter)} options={[{ value: 'open', label: TEXT.optOpen }, { value: 'all', label: TEXT.optAll }, { value: 'closed', label: TEXT.optClosed }]} name="status" />
          </Field>
        </div>
        <div style={{ width: 260 }}>
          <Field label={TEXT.filterClass}>
            <Select value={classification} onChange={setClassification} options={CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_TEXT[c] }))} empty={TEXT.allClasses} name="classification" />
          </Field>
        </div>
        <span className="mx-small" style={{ marginLeft: 'auto' }}>{ctx.fill(TEXT.shown, { n: shown.length, total: rows.length })}</span>
      </div>
      {shown.length ? <FindingsTable ctx={ctx} rows={shown} onOpen={onOpen} /> : <div className="mx-small" style={{ padding: '0 16px 16px' }}>{ctx.li(TEXT.noMatch)}</div>}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The finding drawer
// ---------------------------------------------------------------------------------------------------------------

export interface FindingDrawerProps {
  ctx: HostContext;
  ms: MsId;
  finding: FindingModel | null;
  adapter: FindingsAdapter;
  targets: readonly TargetOption[];
  onClose(): void;
  onChanged(outcome: Outcome, message: string): void;
  onCreateAction(f: FindingModel): void;
  onOpenAction(id: string): void;
}

type Dialog = 'edit' | 'close' | 'reopen' | null;

export function FindingDrawer({ ctx, ms, finding, adapter, targets, onClose, onChanged, onCreateAction, onOpenAction }: FindingDrawerProps) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [rca, setRca] = useState('');
  const [systemic, setSystemic] = useState('');
  // Each text follows its stored value; a reload after a save never closes a dialog the person opened since.
  useEffect(() => setRca(finding?.rcaText ?? ''), [finding?.id, finding?.rcaText]);
  useEffect(() => setSystemic(finding?.systemicCheckText ?? ''), [finding?.id, finding?.systemicCheckText]);
  useEffect(() => setDialog(null), [finding?.id]);
  // "Start work" waits for the reloaded finding, so a second click does not send the move again.
  const [startedFrom, setStartedFrom] = useState<string | null>(null);
  useEffect(() => setStartedFrom(null), [finding?.id, finding?.status]);
  const texts = useMutation((patch: { rcaText?: string | null; systemicCheckText?: string | null }) => asApiResult(adapter.update(ms, finding!, patch)));
  const start = useMutation(() => asApiResult(adapter.move(ms, finding!, { to: 'in_progress' })));
  if (!finding) return null;
  const manage = mayManageFinding(ctx, ms);
  const known = finding.rcaText !== undefined;
  const target = finding.targetCode ? targets.find((t) => t.code === finding.targetCode) : null;
  const saveTexts = () => {
    const patch: { rcaText?: string | null; systemicCheckText?: string | null } = {};
    if (rca.trim() !== (finding.rcaText ?? '').trim() && (filled(rca) || known)) patch.rcaText = filled(rca) ? rca.trim() : null;
    if (systemic.trim() !== (finding.systemicCheckText ?? '').trim() && (filled(systemic) || known)) patch.systemicCheckText = filled(systemic) ? systemic.trim() : null;
    if (!Object.keys(patch).length) {
      ctx.toast(ctx.li(TEXT.nothingChanged));
      return;
    }
    ctx.track(texts.submit(patch)).then((res) => {
      if (res.ok) onChanged(res.data, outcomeText(ctx, res.data, TEXT.textsSaved));
    }, () => undefined);
  };
  const startWork = () => {
    const from = finding.status;
    ctx.track(start.submit(undefined)).then((res) => {
      if (!res.ok) return;
      setStartedFrom(from);
      onChanged(res.data, outcomeText(ctx, res.data, ctx.fill(TEXT.started, { code: finding.code })));
    }, () => undefined);
  };
  const footer = manage ? (
    <DrawerFoot>
      <Button onClick={() => setDialog('edit')}>{ctx.li(TEXT.edit)}</Button>
      {finding.status === 'open' ? <Button busy={start.busy || startedFrom === finding.status} onClick={startWork}>{ctx.li(TEXT.startWork)}</Button> : null}
      {finding.status !== 'closed' ? <Button variant="primary" onClick={() => setDialog('close')}>{ctx.li(TEXT.closeFinding)}</Button> : null}
      {finding.status === 'closed' ? <Button onClick={() => setDialog('reopen')}>{ctx.li(TEXT.reopen)}</Button> : null}
    </DrawerFoot>
  ) : null;
  return (
    <>
      <Drawer open title={`${finding.code} ${finding.title}`} crumb={TEXT.findingCrumb} onClose={onClose} footer={footer}>
        <FormError ctx={ctx} error={start.error} />
        <div className="mx-row">
          <ClassBadge ctx={ctx} value={finding.classification} />
          <FindingStatusBadge ctx={ctx} value={finding.status} />
          <Badge tone="mute">{ctx.li(SOURCE_TEXT[finding.source])}</Badge>
        </div>
        <Facts
          items={[
            { label: TEXT.factTarget, value: finding.targetCode ? `${finding.targetCode}${target ? ` ${target.title}` : ''}` : '-' },
            { label: TEXT.factReference, value: finding.clauseRef ?? '-' },
            { label: TEXT.factEvent, value: finding.auditEvent?.shortLabel ?? '-' },
            { label: TEXT.colOwner, value: personName(ctx.D, finding.owner) },
            { label: TEXT.factRaised, value: day(ctx, finding.raisedAt) },
            { label: TEXT.colDue, value: day(ctx, finding.dueAt) },
            ...(finding.statusNote ? [{ label: TEXT.factNote, value: finding.statusNote }] : []),
          ]}
        />
        <Card title={TEXT.factActions}>
          {finding.actions.length ? (
            <div className="mx-stack" style={{ gap: 8 }}>
              {finding.actions.map((a) => (
                <div key={a.id} className="mx-row">
                  <Button variant="link" onClick={() => onOpenAction(a.id)}>{a.code}</Button>
                  <ActionStatusBadge ctx={ctx} value={a.status} />
                </div>
              ))}
            </div>
          ) : <span className="mx-small">{ctx.li(TEXT.noneYet)}</span>}
          {mayCreateAction(ctx, ms) && finding.status !== 'closed' ? (
            <div style={{ marginTop: 12 }}><Button onClick={() => onCreateAction(finding)}>{ctx.li(TEXT.createAction)}</Button></div>
          ) : null}
        </Card>
        <Card title={TEXT.rootCause} sub={TEXT.rootCauseSub}>
          <div className="mx-stack">
            {!known ? <span className="mx-small">{ctx.li(TEXT.textsKept)}</span> : null}
            <FormError ctx={ctx} error={texts.error} />
            <Field label={TEXT.fRca} error={texts.fields.rcaText ?? null}>
              <Textarea value={rca} onChange={setRca} name="rcaText" rows={3} disabled={!manage} maxLength={8000} />
            </Field>
            <Field label={TEXT.fSystemic} error={texts.fields.systemicCheckText ?? null}>
              <Textarea value={systemic} onChange={setSystemic} name="systemicCheckText" rows={3} disabled={!manage} maxLength={8000} />
            </Field>
            {manage ? <div><Button busy={texts.busy} onClick={saveTexts}>{ctx.li(TEXT.saveTexts)}</Button></div> : null}
          </div>
        </Card>
      </Drawer>
      <EditFindingDialog ctx={ctx} ms={ms} open={dialog === 'edit'} finding={finding} adapter={adapter} targets={targets} onClose={() => setDialog(null)} onSaved={(o) => { setDialog(null); onChanged(o, outcomeText(ctx, o, ctx.fill(TEXT.saved, { code: finding.code }))); }} />
      <MoveFindingDialog ctx={ctx} ms={ms} mode={dialog === 'close' || dialog === 'reopen' ? dialog : null} finding={finding} adapter={adapter} onClose={() => setDialog(null)} onMoved={(o, text) => { setDialog(null); onChanged(o, text); }} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Edit, Close and Reopen
// ---------------------------------------------------------------------------------------------------------------

export function EditFindingDialog({ ctx, ms, open, finding, adapter, targets, onClose, onSaved }: {
  ctx: HostContext;
  ms: MsId;
  open: boolean;
  finding: FindingModel;
  adapter: FindingsAdapter;
  targets: readonly TargetOption[];
  onClose(): void;
  onSaved(outcome: Outcome): void;
}) {
  const [form, setForm] = useState<EditForm>(() => editFormOf(finding));
  const [errors, setErrors] = useState<ReturnType<typeof editErrors>>({});
  const [unchanged, setUnchanged] = useState(false);
  const mutation = useMutation((patch: NonNullable<ReturnType<typeof editPatch>>) => asApiResult(adapter.update(ms, finding, patch)));
  useEffect(() => {
    if (open) {
      setForm(editFormOf(finding));
      setErrors({});
      setUnchanged(false);
      mutation.reset();
    }
  }, [open, finding.id]);
  const set = <K extends keyof EditForm>(name: K, value: EditForm[K]) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
    setUnchanged(false);
  };
  const submit = () => {
    const found = editErrors(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    const patch = editPatch(form, finding);
    if (!patch) {
      setUnchanged(true);
      return;
    }
    ctx.track(mutation.submit(patch)).then((res) => {
      if (res.ok) onSaved(res.data);
    }, () => undefined);
  };
  const fields = mutation.fields;
  const targetOptions = useMemo(() => targets.map((t) => ({ value: t.code, label: `${t.code} ${t.title}` })), [targets]);
  return (
    <Modal
      open={open}
      title={ctx.fill(TEXT.editTitle, { code: finding.code })}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(UI_TEXT.save)}</Button>
        </>
      )}
    >
      {unchanged ? <Alert tone="info">{ctx.li(TEXT.nothingChanged)}</Alert> : null}
      <FormError ctx={ctx} error={mutation.error && !Object.keys(fields).length ? mutation.error : null} />
      <Field label={TEXT.fTitle} error={errors.title ?? fields.title ?? null} required>
        <Textarea value={form.title} onChange={(v) => set('title', v)} name="title" rows={3} maxLength={255} />
      </Field>
      <Field label={TEXT.fClassification} error={fields.classification ?? null} required>
        <Select value={form.classification} onChange={(v) => set('classification', v as EditForm['classification'])} options={CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_TEXT[c] }))} name="classification" />
      </Field>
      <Field label={TEXT.fTarget} hint={TEXT.fTargetHint} error={fields.targetCode ?? null}>
        <Select value={form.targetCode} onChange={(v) => set('targetCode', v)} options={targetOptions} empty={TEXT.noTarget} name="targetCode" />
      </Field>
      <Field label={TEXT.fClauseRef} hint={TEXT.fClauseRefHint} error={errors.clauseRef ?? fields.clauseRef ?? null}>
        <TextInput value={form.clauseRef} onChange={(v) => set('clauseRef', v)} name="clauseRef" maxLength={40} />
      </Field>
      <Field label={TEXT.fOwner} error={fields.ownerHandle ?? null}>
        <PersonPicker value={form.owner} onChange={(v) => set('owner', v)} people={peopleOf(ctx.D)} />
      </Field>
      <Field label={TEXT.fDue} error={fields.dueAt ?? null}>
        <DateInput value={form.dueAt} onChange={(v) => set('dueAt', v)} name="dueAt" />
      </Field>
    </Modal>
  );
}

export function MoveFindingDialog({ ctx, ms, mode, finding, adapter, onClose, onMoved }: {
  ctx: HostContext;
  ms: MsId;
  mode: 'close' | 'reopen' | null;
  finding: FindingModel;
  adapter: FindingsAdapter;
  onClose(): void;
  onMoved(outcome: Outcome, text: string): void;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<readonly [string, string] | null>(null);
  const mutation = useMutation((body: { to: 'in_progress' | 'closed'; note?: string }) => asApiResult(adapter.move(ms, finding, body)));
  useEffect(() => {
    setNote('');
    setError(null);
    mutation.reset();
  }, [mode]);
  const closing = mode === 'close';
  const noteNeeded = closing ? closeNeedsNote(finding) : true;
  const submit = () => {
    if (noteNeeded && !filled(note)) {
      setError(closing ? TEXT.noteRequired : TEXT.reasonRequired);
      return;
    }
    const body = { to: closing ? 'closed' as const : 'in_progress' as const, ...(filled(note) ? { note: note.trim() } : {}) };
    ctx.track(mutation.submit(body)).then((res) => {
      if (!res.ok) return;
      const done = closing ? TEXT.closed : TEXT.reopened;
      onMoved(res.data, outcomeText(ctx, res.data, ctx.fill(done, { code: finding.code })));
    }, () => undefined);
  };
  return (
    <Modal
      open={mode !== null}
      title={ctx.fill(closing ? TEXT.closeTitle : TEXT.reopenTitle, { code: finding.code })}
      sub={closing ? (closeNeedsNote(finding) ? TEXT.closeSubNote : TEXT.closeSubAction) : undefined}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(closing ? TEXT.closeFinding : TEXT.reopen)}</Button>
        </>
      )}
    >
      <FormError ctx={ctx} error={mutation.error && !mutation.fields.note ? mutation.error : null} />
      <Field label={closing ? TEXT.fCloseNote : TEXT.fReason} error={error ?? mutation.fields.note ?? null} required={noteNeeded}>
        <Textarea value={note} onChange={(v) => { setNote(v); setError(null); }} name="note" rows={3} maxLength={2000} />
      </Field>
    </Modal>
  );
}
