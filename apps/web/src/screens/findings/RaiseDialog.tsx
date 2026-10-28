// "Raise finding" (MILESTONE-2 M2-14): source, classification, the clause or control it concerns (a code of
// `applicability.targets`, stored as `targetCode`), the free-text reference, what was found, owner, due date and the
// audit event. The Internal audit screen opens it prefilled with its audit (source internal audit, the event).
import { useEffect, useMemo, useState } from 'react';
import type { MsId } from '../../data/types';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext } from '../types';
import { Button, DateInput, Field, Modal, PersonPicker, Select, TextInput, Textarea, UI_TEXT } from '../ui';
import { CLASSIFICATIONS, CLASSIFICATION_TEXT, CODE_PREFIX, SOURCES, SOURCE_TEXT, emptyRaise, raiseBody, raiseErrors } from './model';
import type { FindingsAdapter, RaiseForm, RaisePrefill } from './model';
import { FormError, useLoad } from './parts';
import type { Outcome } from './shared';
import { asApiResult, day, nextCode, peopleOf, todayOf } from './shared';
import { TEXT } from './text';

export interface RaiseDialogProps {
  ctx: HostContext;
  ms: MsId;
  open: boolean;
  adapter: FindingsAdapter;
  /** Codes already used by findings of the system (the code check and the suggested code). */
  codes: readonly string[];
  prefill?: RaisePrefill;
  onClose(): void;
  onRaised(outcome: Outcome, code: string): void;
}

export function RaiseDialog({ ctx, ms, open, adapter, codes, prefill, onClose, onRaised }: RaiseDialogProps) {
  const [form, setForm] = useState<RaiseForm>(() => emptyRaise(prefill));
  const [touched, setTouched] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const year = todayOf(ctx).slice(0, 4);
  const suggested = useMemo(() => nextCode(CODE_PREFIX[form.source], year, codes), [form.source, year, codes]);
  const targets = useLoad(() => adapter.targets(ms), `${ms}:${open}`, open);
  const events = useLoad(() => adapter.events(ms), `${ms}:${open}`, open);
  const mutation = useMutation((body: ReturnType<typeof raiseBody>) => asApiResult(adapter.raise(ms, body, key)));
  const [errors, setErrors] = useState<ReturnType<typeof raiseErrors>>({});

  useEffect(() => {
    if (open) {
      setForm({ ...emptyRaise(prefill), code: '' });
      setTouched(false);
      setErrors({});
      setKey(newIdempotencyKey());
      mutation.reset();
    }
    // The form starts again each time the dialog opens; the prefill of that opening counts.
  }, [open]);
  useEffect(() => {
    if (open && !touched) setForm((f) => ({ ...f, code: suggested }));
  }, [open, touched, suggested]);

  const set = <K extends keyof RaiseForm>(name: K, value: RaiseForm[K]) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
    mutation.reset();
  };
  const submit = () => {
    const found = raiseErrors(form, codes);
    setErrors(found);
    if (Object.keys(found).length) return;
    const code = form.code.trim();
    ctx.track(mutation.submit(raiseBody(form))).then((res) => {
      if (res.ok) onRaised(res.data, code);
    }, () => undefined);
  };
  const fields = mutation.fields;
  const people = peopleOf(ctx.D);
  const eventOptions = (events.data ?? []).map((e) => ({ value: e.id, label: `${e.shortLabel}, ${day(ctx, e.scheduledAt)}` }));
  const targetOptions = (targets.data ?? []).map((t) => ({ value: t.code, label: `${t.code} ${t.title}` }));
  return (
    <Modal
      open={open}
      title={TEXT.raiseTitle}
      sub={TEXT.raiseSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.raise)}</Button>
        </>
      )}
    >
      <FormError ctx={ctx} error={mutation.error && !Object.keys(fields).length ? mutation.error : null} />
      <Field label={TEXT.fSource} required>
        <Select value={form.source} onChange={(v) => set('source', v as RaiseForm['source'])} options={SOURCES.map((s) => ({ value: s, label: SOURCE_TEXT[s] }))} name="source" />
      </Field>
      <Field label={TEXT.fCode} hint={TEXT.fCodeHint} error={errors.code ?? fields.code ?? null} required>
        <TextInput value={form.code} onChange={(v) => { setTouched(true); set('code', v); }} name="code" maxLength={30} />
      </Field>
      <Field label={TEXT.fTitle} error={errors.title ?? fields.title ?? null} required>
        <Textarea value={form.title} onChange={(v) => set('title', v)} name="title" rows={3} maxLength={255} />
      </Field>
      <Field label={TEXT.fClassification} hint={TEXT.fClassHint} error={errors.classification ?? fields.classification ?? null} required>
        <Select value={form.classification} onChange={(v) => set('classification', v as RaiseForm['classification'])} options={CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_TEXT[c] }))} empty={UI_TEXT.choose} name="classification" />
      </Field>
      <Field label={TEXT.fTarget} hint={targets.error ? TEXT.targetsFailed : TEXT.fTargetHint} error={fields.targetCode ?? null}>
        <Select value={form.targetCode} onChange={(v) => set('targetCode', v)} options={targetOptions} empty={TEXT.noTarget} name="targetCode" />
      </Field>
      <Field label={TEXT.fClauseRef} hint={TEXT.fClauseRefHint} error={errors.clauseRef ?? fields.clauseRef ?? null}>
        <TextInput value={form.clauseRef} onChange={(v) => set('clauseRef', v)} name="clauseRef" maxLength={40} />
      </Field>
      <Field label={TEXT.fEvent} error={fields.auditEventId ?? null}>
        <Select value={form.auditEventId} onChange={(v) => set('auditEventId', v)} options={eventOptions} empty={TEXT.noEvent} name="auditEventId" />
      </Field>
      <Field label={TEXT.fOwner} error={errors.owner ?? fields.ownerHandle ?? null} required>
        <PersonPicker value={form.owner} onChange={(v) => set('owner', v)} people={people} />
      </Field>
      <Field label={TEXT.fDue} error={fields.dueAt ?? null}>
        <DateInput value={form.dueAt} onChange={(v) => set('dueAt', v)} name="dueAt" />
      </Field>
    </Modal>
  );
}
