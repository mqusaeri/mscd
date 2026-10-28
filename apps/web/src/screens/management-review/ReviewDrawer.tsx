// The drawer of a management review (MILESTONE-2 M2-14) and its dialogs: the facts, the inputs per linked system with
// "Record input" for the inputs of the open system, "Edit" (PATCH while planned or held), "Mark held" and "Close" with
// the decisions; the BR-13 and BR-14 messages of the api show in the Close dialog.
import { useEffect, useState } from 'react';
import type { MsId } from '../../data/types';
import { newIdempotencyKey, useMutation } from '../api';
import { DrawerFoot, FormError } from '../findings/parts';
import type { Outcome } from '../findings/shared';
import { asApiResult, day, filled, msShort, nextCode, outcomeText, peopleOf, personName, todayOf } from '../findings/shared';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, Checkbox, DateInput, Drawer, Facts, Field, Modal, PersonPicker, TextInput, Textarea, UI_TEXT } from '../ui';
import { REVIEW_STATUS_TEXT, REVIEW_STATUS_TONE, completeness, createBody, formOf, inputsBySystem, mayManage, reviewErrors, reviewPatch } from './model';
import type { ReviewAdapter, ReviewForm, ReviewInput, ReviewModel } from './model';
import { TEXT } from './text';

// ---------------------------------------------------------------------------------------------------------------
// Plan and edit
// ---------------------------------------------------------------------------------------------------------------

export function ReviewFormDialog({ ctx, ms, open, adapter, review, codes, onClose, onSaved }: {
  ctx: HostContext;
  ms: MsId;
  open: boolean;
  adapter: ReviewAdapter;
  /** The review to edit; null to plan one. */
  review: ReviewModel | null;
  codes: readonly string[];
  onClose(): void;
  onSaved(outcome: Outcome, code: string): void;
}) {
  const create = review === null;
  const year = todayOf(ctx).slice(0, 4);
  const blank = (): ReviewForm => (review
    ? formOf(review)
    : { code: nextCode('MR', year, codes, true), title: ctx.lang === 'id' ? `Tinjauan manajemen ${year}` : `Management review ${year}`, plannedAt: '', owner: '', linked: [ms] });
  const [form, setForm] = useState<ReviewForm>(blank);
  const [errors, setErrors] = useState<ReturnType<typeof reviewErrors>>({});
  const [unchanged, setUnchanged] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const mutation = useMutation((body: unknown) => asApiResult(create
    ? adapter.create(ms, body as Parameters<ReviewAdapter['create']>[1], key)
    : adapter.update(ms, review!, body as Parameters<ReviewAdapter['update']>[2])));
  useEffect(() => {
    if (open) {
      setForm(blank());
      setErrors({});
      setUnchanged(false);
      setKey(newIdempotencyKey());
      mutation.reset();
    }
  }, [open, review?.id]);
  const set = <K extends keyof ReviewForm>(name: K, value: ReviewForm[K]) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
    setUnchanged(false);
  };
  // Systems the session may link: those where it manages reviews, the open system always first and kept.
  const systems = (ctx.D?.MS ?? []).filter((m) => m.id === ms || mayManage(ctx, m.id) || form.linked.includes(m.id));
  const submit = () => {
    const found = reviewErrors(form, create ? codes : [], create);
    setErrors(found);
    if (Object.keys(found).length) return;
    let body: unknown;
    if (create) body = createBody(form, ms);
    else {
      body = reviewPatch(form, review!, ms);
      if (!body) {
        setUnchanged(true);
        return;
      }
    }
    ctx.track(mutation.submit(body)).then((res) => {
      if (res.ok) onSaved(res.data, create ? form.code.trim() : review!.code);
    }, () => undefined);
  };
  const fields = mutation.fields;
  return (
    <Modal
      open={open}
      title={create ? TEXT.planTitle : ctx.fill(TEXT.editTitle, { code: review!.code })}
      sub={create ? TEXT.planSub : undefined}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(create ? TEXT.plan : UI_TEXT.save)}</Button>
        </>
      )}
    >
      {unchanged ? <Alert tone="info">{ctx.li(TEXT.nothingChanged)}</Alert> : null}
      <FormError ctx={ctx} error={mutation.error && !Object.keys(fields).length ? mutation.error : null} />
      {create ? (
        <Field label={TEXT.fCode} error={errors.code ?? fields.code ?? null} required>
          <TextInput value={form.code} onChange={(v) => set('code', v)} name="code" maxLength={30} />
        </Field>
      ) : null}
      <Field label={TEXT.fTitle} error={errors.title ?? fields.title ?? null} required>
        <TextInput value={form.title} onChange={(v) => set('title', v)} name="title" maxLength={255} />
      </Field>
      <Field label={TEXT.fPlanned} error={errors.plannedAt ?? fields.plannedAt ?? null} required>
        <DateInput value={form.plannedAt} onChange={(v) => set('plannedAt', v)} name="plannedAt" />
      </Field>
      <Field label={TEXT.fOwner} error={errors.owner ?? fields.ownerHandle ?? null} required>
        <PersonPicker value={form.owner} onChange={(v) => set('owner', v)} people={peopleOf(ctx.D)} />
      </Field>
      {systems.length > 1 ? (
        <fieldset className="mx-radios">
          <legend className="mx-label">{ctx.li(TEXT.fSystems)}</legend>
          {systems.map((m) => (
            <Checkbox
              key={m.id}
              name="linkedMs"
              checked={m.id === ms || form.linked.includes(m.id)}
              disabled={m.id === ms}
              onChange={(on) => set('linked', on ? [...form.linked, m.id] : form.linked.filter((x) => x !== m.id))}
              label={m.id === ms ? ctx.fill(TEXT.thisSystem, { name: m.short }) : m.short}
            />
          ))}
          <span className="mx-hint">{ctx.li(TEXT.fSystemsHint)}</span>
          {fields.linkedMs ? <span className="mx-error" role="alert">{fields.linkedMs}</span> : null}
        </fieldset>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Input, held and close
// ---------------------------------------------------------------------------------------------------------------

function InputDialog({ ctx, ms, review, input, adapter, onClose, onSaved }: {
  ctx: HostContext;
  ms: MsId;
  review: ReviewModel;
  input: ReviewInput | null;
  adapter: ReviewAdapter;
  onClose(): void;
  onSaved(outcome: Outcome, text: string): void;
}) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<TextPair | null>(null);
  const mutation = useMutation((value: string) => asApiResult(adapter.putInput(ms, review, input!.defCode, value)));
  useEffect(() => {
    if (input) {
      setContent(input.content ?? '');
      setError(null);
      mutation.reset();
    }
  }, [input?.defCode]);
  const submit = () => {
    if (!input) return;
    if (!filled(content)) {
      setError(TEXT.required);
      return;
    }
    ctx.track(mutation.submit(content.trim())).then((res) => {
      if (res.ok) onSaved(res.data, outcomeText(ctx, res.data, ctx.fill(TEXT.inputSaved, { code: input.defCode })));
    }, () => undefined);
  };
  return (
    <Modal
      open={input !== null}
      title={input ? ctx.fill(TEXT.inputTitle, { code: input.defCode, title: input.title }) : ''}
      sub={ctx.fill(TEXT.inputSub, { ms: msShort(ctx.D, ms) })}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(UI_TEXT.save)}</Button>
        </>
      )}
    >
      <FormError ctx={ctx} error={mutation.error && !mutation.fields.content ? mutation.error : null} />
      <Field label={TEXT.fContent} hint={TEXT.fContentHint} error={error ?? mutation.fields.content ?? null} required>
        <Textarea value={content} onChange={(v) => { setContent(v); setError(null); }} name="content" rows={6} maxLength={20000} />
      </Field>
    </Modal>
  );
}

function MoveDialog({ ctx, ms, review, mode, adapter, onClose, onDone }: {
  ctx: HostContext;
  ms: MsId;
  review: ReviewModel;
  mode: 'held' | 'closed' | null;
  adapter: ReviewAdapter;
  onClose(): void;
  onDone(outcome: Outcome, text: string): void;
}) {
  const [heldAt, setHeldAt] = useState('');
  const [decisions, setDecisions] = useState('');
  const mutation = useMutation((body: Parameters<ReviewAdapter['move']>[2]) => asApiResult(adapter.move(ms, review, body)));
  useEffect(() => {
    if (mode) {
      setHeldAt(todayOf(ctx));
      setDecisions(review.decisionsText ?? '');
      mutation.reset();
    }
  }, [mode]);
  const held = mode === 'held';
  const submit = () => {
    const body = held
      ? { to: 'held' as const, ...(heldAt ? { heldAt } : {}) }
      : { to: 'closed' as const, ...(filled(decisions) ? { decisionsText: decisions.trim() } : {}) };
    ctx.track(mutation.submit(body)).then((res) => {
      if (res.ok) onDone(res.data, outcomeText(ctx, res.data, ctx.fill(held ? TEXT.heldSaved : TEXT.closed, { code: review.code })));
    }, () => undefined);
  };
  return (
    <Modal
      open={mode !== null}
      title={ctx.fill(held ? TEXT.heldTitle : TEXT.closeTitle, { code: review.code })}
      sub={held ? TEXT.heldSub : TEXT.closeSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(held ? TEXT.markHeld : TEXT.close)}</Button>
        </>
      )}
    >
      <FormError ctx={ctx} error={mutation.error && !Object.keys(mutation.fields).length ? mutation.error : null} />
      {held ? (
        <Field label={TEXT.fHeldAt} error={mutation.fields.heldAt ?? null}>
          <DateInput value={heldAt} onChange={setHeldAt} name="heldAt" />
        </Field>
      ) : (
        <Field label={TEXT.fDecisions} error={mutation.fields.decisionsText ?? null}>
          <Textarea value={decisions} onChange={setDecisions} name="decisionsText" rows={6} maxLength={8000} />
        </Field>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------------------------------------------

type Dialog = 'edit' | 'held' | 'closed' | null;

export function ReviewDrawer({ ctx, ms, review, adapter, codes, onClose, onChanged }: {
  ctx: HostContext;
  ms: MsId;
  review: ReviewModel | null;
  adapter: ReviewAdapter;
  codes: readonly string[];
  onClose(): void;
  onChanged(outcome: Outcome, text: string): void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [input, setInput] = useState<ReviewInput | null>(null);
  useEffect(() => {
    setDialog(null);
    setInput(null);
  }, [review?.id]);
  if (!review) return null;
  const manage = mayManage(ctx, ms);
  const open = review.status !== 'closed';
  const all = completeness(review);
  const footer = manage && open ? (
    <DrawerFoot>
      <Button onClick={() => setDialog('edit')}>{ctx.li(TEXT.edit)}</Button>
      {review.status === 'planned' ? <Button variant="primary" onClick={() => setDialog('held')}>{ctx.li(TEXT.markHeld)}</Button> : null}
      {review.status === 'held' ? <Button variant="primary" onClick={() => setDialog('closed')}>{ctx.li(TEXT.close)}</Button> : null}
    </DrawerFoot>
  ) : undefined;
  return (
    <>
      <Drawer open title={`${review.code} ${review.title}`} crumb={TEXT.crumb} onClose={onClose} footer={footer}>
        <div className="mx-row">
          <Badge tone={REVIEW_STATUS_TONE[review.status]}>{ctx.li(REVIEW_STATUS_TEXT[review.status])}</Badge>
          <Badge tone={all.done === all.total ? 'ok' : 'warn'}>{ctx.fill(TEXT.inputsDone, { done: all.done, total: all.total })}</Badge>
        </div>
        <Facts
          items={[
            { label: TEXT.factPlanned, value: day(ctx, review.plannedAt) },
            { label: TEXT.factHeld, value: day(ctx, review.heldAt) },
            { label: TEXT.factOwner, value: personName(ctx.D, review.owner) },
            { label: TEXT.factSystems, value: review.linkedMs.map((m) => msShort(ctx.D, m)).join(', ') },
            ...(review.decisionsText ? [{ label: TEXT.factDecisions, value: review.decisionsText }] : []),
          ]}
        />
        {!open ? <Alert tone="ok">{ctx.li(TEXT.closedText)}</Alert> : null}
        <Card title={TEXT.inputs} sub={TEXT.inputsSub}>
          <div className="mx-stack" style={{ gap: 16 }}>
            {inputsBySystem(review, ms).map((group) => {
              const c = completeness(review, group.ms);
              return (
                <div key={group.ms} className="mx-stack" style={{ gap: 8 }}>
                  {review.linkedMs.length > 1 ? (
                    <div className="mx-row">
                      <strong>{ctx.fill(TEXT.inputsOf, { ms: msShort(ctx.D, group.ms) })}</strong>
                      <span className="mx-small">{ctx.fill(TEXT.inputsDone, { done: c.done, total: c.total })}</span>
                    </div>
                  ) : null}
                  {group.inputs.map((i) => (
                    <div key={`${i.ms}:${i.defCode}`} className="mx-stack" style={{ gap: 4, paddingBottom: 8, borderBottom: '1px solid var(--bd)' }} data-input={i.defCode}>
                      <div className="mx-row" style={{ alignItems: 'flex-start' }}>
                        <span className="mx-mono" style={{ fontWeight: 600 }}>{i.defCode}</span>
                        <span style={{ flex: 1, minWidth: 160 }}>{i.title}</span>
                        <Badge tone={i.complete ? 'ok' : i.mandatory ? 'bad' : 'mute'}>{ctx.li(i.complete ? TEXT.complete : i.mandatory ? TEXT.missing : TEXT.optional)}</Badge>
                        {manage && open && i.ms === ms ? (
                          <Button onClick={() => setInput(i)}>{ctx.li(i.complete ? TEXT.editInput : TEXT.recordInput)}</Button>
                        ) : null}
                      </div>
                      {i.content ? <div className="mx-muted" style={{ whiteSpace: 'pre-wrap' }}>{i.content}</div> : null}
                      {manage && open && i.ms !== ms ? <span className="mx-small">{ctx.fill(TEXT.otherSystemInput, { ms: msShort(ctx.D, i.ms) })}</span> : null}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </Card>
      </Drawer>
      {manage ? (
        <>
          <ReviewFormDialog
            ctx={ctx} ms={ms} open={dialog === 'edit'} adapter={adapter} review={review} codes={codes}
            onClose={() => setDialog(null)}
            onSaved={(o, code) => { setDialog(null); onChanged(o, outcomeText(ctx, o, ctx.fill(TEXT.saved, { code }))); }}
          />
          <InputDialog ctx={ctx} ms={ms} review={review} input={input} adapter={adapter} onClose={() => setInput(null)} onSaved={(o, t) => { setInput(null); onChanged(o, t); }} />
          <MoveDialog ctx={ctx} ms={ms} review={review} mode={dialog === 'held' || dialog === 'closed' ? dialog : null} adapter={adapter} onClose={() => setDialog(null)} onDone={(o, t) => { setDialog(null); onChanged(o, t); }} />
        </>
      ) : null}
    </>
  );
}
