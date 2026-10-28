// The Corrective actions tab of "Findings and actions" (MILESTONE-2 M2-14): the list, "Create" for one or more
// findings, and the action drawer with its steps (correction, root cause analysis, systemic check, action), the
// effectiveness check by someone other than the implementer and the owner (BR-09, BR-08), Edit and Cancel.
import { useEffect, useState } from 'react';
import type { MsId } from '../../data/types';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import {
  Alert, Badge, Button, Card, Checkbox, DateInput, Drawer, EmptyState, Facts, Field, Modal, PersonPicker, Radio, Table, TextInput, Textarea, UI_TEXT,
} from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import { CA_STEPS, actionErrors, actionPatch, isOpen, mayCreateAction, mayStep, stepIndex, verifyBlock } from './model';
import type { ActionForm, ActionModel, FindingModel, FindingsAdapter } from './model';
import { ActionStatusBadge, ClassBadge, DrawerFoot, FormError } from './parts';
import type { Outcome } from './shared';
import { asApiResult, day, filled, nextCode, outcomeText, peopleOf, personName, todayOf } from './shared';
import { TEXT } from './text';

export function ActionsList({ ctx, rows, canCreate, onCreate, onOpen }: {
  ctx: HostContext;
  rows: ActionModel[];
  canCreate: boolean;
  onCreate(): void;
  onOpen(a: ActionModel): void;
}) {
  const create = canCreate ? <Button variant="primary" onClick={onCreate}>{ctx.li(TEXT.createAction)}</Button> : null;
  if (!rows.length) {
    return (
      <Card>
        <EmptyState title={TEXT.noActions} text={TEXT.noActionsText} illustration={<Illustration scene="no-findings" />} action={create} />
      </Card>
    );
  }
  const columns: Column<ActionModel>[] = [
    { key: 'code', label: TEXT.colCode, render: (a) => <span className="mx-mono" style={{ whiteSpace: 'nowrap' }}>{a.code}</span> },
    { key: 'title', label: TEXT.colAction, render: (a) => a.title },
    { key: 'findings', label: TEXT.colFindings, render: (a) => <span className="mx-mono">{a.findings.map((f) => f.code).join(', ') || '-'}</span> },
    { key: 'owner', label: TEXT.colOwner, render: (a) => personName(ctx.D, a.owner) },
    { key: 'due', label: TEXT.colDue, render: (a) => day(ctx, a.dueAt) },
    { key: 'step', label: TEXT.colStep, render: (a) => <ActionStatusBadge ctx={ctx} value={a.status} /> },
  ];
  return (
    <Card title={TEXT.tabActions} actions={create} flush>
      <Table columns={columns} rows={rows} rowKey={(a) => a.id} onRow={onOpen} />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Create and edit
// ---------------------------------------------------------------------------------------------------------------

export function ActionFormDialog({ ctx, ms, open, adapter, findings, codes, action, preselected, onClose, onSaved }: {
  ctx: HostContext;
  ms: MsId;
  open: boolean;
  adapter: FindingsAdapter;
  findings: readonly FindingModel[];
  /** Codes of the corrective actions of the system (the code check and the suggested code). */
  codes: readonly string[];
  /** The action to edit; null to create one. */
  action: ActionModel | null;
  preselected?: readonly string[];
  onClose(): void;
  onSaved(outcome: Outcome, code: string): void;
}) {
  const create = action === null;
  const blank = (): ActionForm => (action
    ? { findingIds: action.findings.map((f) => f.id), code: action.code, title: action.title, owner: action.owner === 'none' ? '' : action.owner, dueAt: action.dueAt ?? '' }
    : { findingIds: [...(preselected ?? [])], code: nextCode('CA', todayOf(ctx).slice(0, 4), codes), title: '', owner: '', dueAt: '' });
  const [form, setForm] = useState<ActionForm>(blank);
  const [errors, setErrors] = useState<ReturnType<typeof actionErrors>>({});
  const [unchanged, setUnchanged] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const mutation = useMutation((input: { create: boolean; body: unknown }) => asApiResult(input.create
    ? adapter.createAction(ms, input.body as Parameters<FindingsAdapter['createAction']>[1], key)
    : adapter.updateAction(ms, action!, input.body as Parameters<FindingsAdapter['updateAction']>[2])));
  useEffect(() => {
    if (open) {
      setForm(blank());
      setErrors({});
      setUnchanged(false);
      setKey(newIdempotencyKey());
      mutation.reset();
    }
  }, [open, action?.id]);
  const set = <K extends keyof ActionForm>(name: K, value: ActionForm[K]) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
    setUnchanged(false);
  };
  // Findings that are not closed, and those the action already names.
  const choices = findings.filter((f) => isOpen(f) || form.findingIds.includes(f.id));
  const toggle = (id: string, on: boolean) => set('findingIds', on ? [...form.findingIds, id] : form.findingIds.filter((x) => x !== id));
  const submit = () => {
    const found = actionErrors(form, create ? codes : [], create);
    setErrors(found);
    if (Object.keys(found).length) return;
    let body: unknown;
    if (create) {
      body = { findingIds: form.findingIds, code: form.code.trim(), title: form.title.trim(), ownerHandle: form.owner, ...(form.dueAt ? { dueAt: form.dueAt } : {}) };
    } else {
      body = actionPatch(form, action!);
      if (!body) {
        setUnchanged(true);
        return;
      }
    }
    ctx.track(mutation.submit({ create, body })).then((res) => {
      if (res.ok) onSaved(res.data, create ? form.code.trim() : action!.code);
    }, () => undefined);
  };
  const fields = mutation.fields;
  return (
    <Modal
      open={open}
      title={create ? TEXT.createActionTitle : ctx.fill(TEXT.editActionTitle, { code: action!.code })}
      sub={create ? TEXT.createActionSub : undefined}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(create ? TEXT.createAction : UI_TEXT.save)}</Button>
        </>
      )}
    >
      {unchanged ? <Alert tone="info">{ctx.li(TEXT.nothingChanged)}</Alert> : null}
      <FormError ctx={ctx} error={mutation.error && !Object.keys(fields).length ? mutation.error : null} />
      <fieldset className="mx-radios">
        <legend className="mx-label">{ctx.li(TEXT.fFindings)}</legend>
        {choices.length ? choices.map((f) => (
          <Checkbox key={f.id} checked={form.findingIds.includes(f.id)} onChange={(on) => toggle(f.id, on)} label={`${f.code} ${f.title}`} name="findingIds" />
        )) : <span className="mx-small">{ctx.li(TEXT.noOpenFindings)}</span>}
        {errors.findingIds || fields.findingIds ? <span className="mx-error" role="alert">{ctx.li(errors.findingIds ?? fields.findingIds)}</span> : null}
      </fieldset>
      {create ? (
        <Field label={TEXT.fCode} error={errors.code ?? fields.code ?? null} required>
          <TextInput value={form.code} onChange={(v) => set('code', v)} name="code" maxLength={30} />
        </Field>
      ) : null}
      <Field label={TEXT.fActionTitle} error={errors.title ?? fields.title ?? null} required>
        <TextInput value={form.title} onChange={(v) => set('title', v)} name="title" maxLength={255} />
      </Field>
      <Field label={TEXT.fOwner} error={errors.owner ?? fields.ownerHandle ?? null} required>
        <PersonPicker value={form.owner} onChange={(v) => set('owner', v)} people={peopleOf(ctx.D)} />
      </Field>
      <Field label={TEXT.fDue} error={fields.dueAt ?? null}>
        <DateInput value={form.dueAt} onChange={(v) => set('dueAt', v)} name="dueAt" />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The action drawer
// ---------------------------------------------------------------------------------------------------------------

type ActionDialog = 'edit' | 'check' | 'cancel' | null;

export function ActionDrawer({ ctx, ms, action, adapter, findings, codes, onClose, onChanged, onOpenFinding }: {
  ctx: HostContext;
  ms: MsId;
  action: ActionModel | null;
  adapter: FindingsAdapter;
  findings: readonly FindingModel[];
  codes: readonly string[];
  onClose(): void;
  onChanged(outcome: Outcome, message: string): void;
  onOpenFinding(id: string): void;
}) {
  const [dialog, setDialog] = useState<ActionDialog>(null);
  const [text, setText] = useState('');
  const [textError, setTextError] = useState<TextPair | null>(null);
  const step = action ? CA_STEPS.find((s) => s.status === action.status) ?? null : null;
  const move = useMutation((body: { to: string; text: string }) => asApiResult(adapter.moveAction(ms, action!, body as Parameters<FindingsAdapter['moveAction']>[2])));
  // The status a completed step left, until the reloaded action shows the next step: the step form waits meanwhile, so
  // nothing typed in that moment is lost and the same step is not sent twice.
  const [left, setLeft] = useState<string | null>(null);
  useEffect(() => {
    setText('');
    setTextError(null);
    setLeft(null);
    move.reset();
  }, [action?.id, action?.status]);
  useEffect(() => setDialog(null), [action?.id]);
  if (!action) return null;
  const canStep = mayStep(ctx, ms, action);
  const manage = mayCreateAction(ctx, ms);
  const block = verifyBlock(ctx, ms, action);
  const finished = action.status === 'closed' || action.status === 'cancelled';
  const now = stepIndex(action.status);
  const waiting = left !== null && left === action.status;
  const completeStep = () => {
    if (!step || waiting) return;
    if (!filled(text)) {
      setTextError(TEXT.stepTextRequired);
      return;
    }
    const from = action.status;
    ctx.track(move.submit({ to: step.next, text: text.trim() })).then((res) => {
      if (!res.ok) return;
      setLeft(from);
      onChanged(res.data, outcomeText(ctx, res.data, ctx.fill(TEXT.stepSaved, { step: ctx.li(step.text), code: action.code })));
    }, () => undefined);
  };
  const recorded = (field: (typeof CA_STEPS)[number]['field']) => action[field];
  const footer = (
    <DrawerFoot>
      {manage && !finished ? <Button onClick={() => setDialog('edit')}>{ctx.li(TEXT.edit)}</Button> : null}
      {manage && !finished ? <Button variant="danger" onClick={() => setDialog('cancel')}>{ctx.li(TEXT.cancelAction)}</Button> : null}
    </DrawerFoot>
  );
  return (
    <>
      <Drawer open title={`${action.code} ${action.title}`} crumb={TEXT.actionCrumb} onClose={onClose} footer={manage && !finished ? footer : undefined}>
        <div className="mx-row">
          <ActionStatusBadge ctx={ctx} value={action.status} />
          {action.effective === true ? <Badge tone="ok">{ctx.li(TEXT.effective)}</Badge> : null}
          {action.effective === false ? <Badge tone="bad">{ctx.li(TEXT.notEffective)}</Badge> : null}
        </div>
        <Facts
          items={[
            {
              label: TEXT.fFindings,
              value: action.findings.length ? (
                <span className="mx-row">
                  {action.findings.map((f) => {
                    const known = findings.find((x) => x.id === f.id);
                    return (
                      <span key={f.id} className="mx-row" style={{ gap: 6 }}>
                        <Button variant="link" onClick={() => onOpenFinding(f.id)}>{f.code}</Button>
                        {known ? <ClassBadge ctx={ctx} value={known.classification} /> : null}
                      </span>
                    );
                  })}
                </span>
              ) : '-',
            },
            { label: TEXT.colOwner, value: personName(ctx.D, action.owner) },
            { label: TEXT.colDue, value: day(ctx, action.dueAt) },
            { label: TEXT.factImplemented, value: action.implementedAt ? ctx.fill(TEXT.byOn, { who: personName(ctx.D, action.implementedBy), date: day(ctx, action.implementedAt) }) : '-' },
            { label: TEXT.factChecked, value: action.verifiedAt ? ctx.fill(TEXT.byOn, { who: personName(ctx.D, action.verifiedBy), date: day(ctx, action.verifiedAt) }) : '-' },
          ]}
        />
        <Card title={TEXT.steps}>
          <ol className="mx-stack" style={{ margin: 0, paddingLeft: 18, gap: 10 }}>
            {CA_STEPS.map((s, i) => (
              <li key={s.status}>
                <div className="mx-row" style={{ gap: 8 }}>
                  <strong>{ctx.li(s.text)}</strong>
                  <span className="mx-small">{ctx.li(i < now ? TEXT.stepDone : i === now && !finished ? TEXT.stepNow : TEXT.stepLater)}</span>
                </div>
                {recorded(s.field) ? <div className="mx-muted" style={{ marginTop: 2 }}>{recorded(s.field)}</div> : null}
              </li>
            ))}
            <li>
              <div className="mx-row" style={{ gap: 8 }}>
                <strong>{ctx.li(TEXT.caVerification)}</strong>
                <span className="mx-small">{ctx.li(action.status === 'closed' ? TEXT.stepDone : now === 4 ? TEXT.stepNow : TEXT.stepLater)}</span>
              </div>
            </li>
          </ol>
        </Card>
        {step && !finished ? (
          <Card title={step.text} sub={step.hint}>
            {canStep ? (
              <div className="mx-stack">
                <FormError ctx={ctx} error={move.error && !move.fields.text ? move.error : null} />
                <Field label={step.text} error={textError ?? move.fields.text ?? null} required>
                  <Textarea value={text} onChange={(v) => { setText(v); setTextError(null); }} name="stepText" rows={3} maxLength={8000} disabled={waiting} />
                </Field>
                <div><Button variant="primary" busy={move.busy || waiting} onClick={completeStep}>{ctx.li(TEXT.completeStep)}</Button></div>
              </div>
            ) : <span className="mx-small">{ctx.li(TEXT.stepNoRight)}</span>}
          </Card>
        ) : null}
        {action.status === 'effectiveness_verification' ? (
          <Card title={TEXT.caVerification} sub={TEXT.checkSub}>
            <Button variant="primary" disabledReason={block} onClick={() => setDialog('check')}>{ctx.li(TEXT.recordCheck)}</Button>
          </Card>
        ) : null}
        {finished ? <span className="mx-small">{ctx.li(TEXT.finished)}</span> : null}
      </Drawer>
      <ActionFormDialog
        ctx={ctx} ms={ms} open={dialog === 'edit'} adapter={adapter} findings={findings} codes={codes} action={action}
        onClose={() => setDialog(null)}
        onSaved={(o) => { setDialog(null); onChanged(o, outcomeText(ctx, o, ctx.fill(TEXT.actionSaved, { code: action.code }))); }}
      />
      <CheckDialog ctx={ctx} ms={ms} open={dialog === 'check'} action={action} adapter={adapter} onClose={() => setDialog(null)} onDone={(o, t) => { setDialog(null); onChanged(o, t); }} />
      <CancelDialog ctx={ctx} ms={ms} open={dialog === 'cancel'} action={action} adapter={adapter} onClose={() => setDialog(null)} onDone={(o, t) => { setDialog(null); onChanged(o, t); }} />
    </>
  );
}

function CheckDialog({ ctx, ms, open, action, adapter, onClose, onDone }: {
  ctx: HostContext;
  ms: MsId;
  open: boolean;
  action: ActionModel;
  adapter: FindingsAdapter;
  onClose(): void;
  onDone(outcome: Outcome, text: string): void;
}) {
  const [effective, setEffective] = useState('yes');
  const [note, setNote] = useState('');
  const mutation = useMutation((body: { to: 'closed'; effective: boolean; note?: string }) => asApiResult(adapter.moveAction(ms, action, body)));
  useEffect(() => {
    if (open) {
      setEffective('yes');
      setNote('');
      mutation.reset();
    }
  }, [open]);
  const submit = () => {
    ctx.track(mutation.submit({ to: 'closed', effective: effective === 'yes', ...(filled(note) ? { note: note.trim() } : {}) })).then((res) => {
      if (res.ok) onDone(res.data, outcomeText(ctx, res.data, ctx.fill(TEXT.checkSaved, { code: action.code })));
    }, () => undefined);
  };
  return (
    <Modal
      open={open}
      title={ctx.fill(TEXT.checkTitle, { code: action.code })}
      sub={TEXT.checkSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.recordCheck)}</Button>
        </>
      )}
    >
      <FormError ctx={ctx} error={mutation.error} />
      <Radio legend={TEXT.fEffective} value={effective} onChange={setEffective} name="effective" options={[{ value: 'yes', label: TEXT.effectiveYes }, { value: 'no', label: TEXT.effectiveNo }]} />
      <Field label={TEXT.fCheckNote}>
        <Textarea value={note} onChange={setNote} name="note" rows={3} maxLength={2000} />
      </Field>
    </Modal>
  );
}

function CancelDialog({ ctx, ms, open, action, adapter, onClose, onDone }: {
  ctx: HostContext;
  ms: MsId;
  open: boolean;
  action: ActionModel;
  adapter: FindingsAdapter;
  onClose(): void;
  onDone(outcome: Outcome, text: string): void;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<TextPair | null>(null);
  const mutation = useMutation((body: { to: 'cancelled'; note: string }) => asApiResult(adapter.moveAction(ms, action, body)));
  useEffect(() => {
    if (open) {
      setNote('');
      setError(null);
      mutation.reset();
    }
  }, [open]);
  const submit = () => {
    if (!filled(note)) {
      setError(TEXT.reasonRequired);
      return;
    }
    ctx.track(mutation.submit({ to: 'cancelled', note: note.trim() })).then((res) => {
      if (res.ok) onDone(res.data, outcomeText(ctx, res.data, ctx.fill(TEXT.cancelled, { code: action.code })));
    }, () => undefined);
  };
  return (
    <Modal
      open={open}
      title={ctx.fill(TEXT.cancelTitle, { code: action.code })}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="danger" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.cancelAction)}</Button>
        </>
      )}
    >
      <FormError ctx={ctx} error={mutation.error && !mutation.fields.note ? mutation.error : null} />
      <Field label={TEXT.fReason} error={error ?? mutation.fields.note ?? null} required>
        <Textarea value={note} onChange={(v) => { setNote(v); setError(null); }} name="note" rows={3} maxLength={2000} />
      </Field>
    </Modal>
  );
}
