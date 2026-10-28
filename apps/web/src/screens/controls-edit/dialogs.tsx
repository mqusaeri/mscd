// The forms of an applicability entry (MILESTONE-2 M2-11): Edit (applicability, justifications with the BR-03
// warnings under the field after Save, linked risks, implementing documents, owner, gate flag and reason, status note,
// operating frequency and description), Reject (back to partially implemented with a reason), Mark not applicable
// (refused for clause rows, APPL-ASSESS) and Delete entry (`records.delete` with a reason and the BR-22 confirmation).
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { MsId } from '../../data/types';
import { useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Button, Checkbox, Field, Modal, PersonPicker, Radio, Select, TextInput, Textarea, UI_TEXT } from '../ui';
import { filled, frequencyOptions, peopleOf, recordKey, refFor, reloadChanged } from './common';
import type { EntryRecord, Outcome, Result, Warn } from './common';
import { checkReason, checkValues, criteriaOf, implementingDocuments, patchOf, valuesOf } from './model';
import type { ControlsAdapter, EntryRef, EntryValues } from './model';
import { adapterFor } from './adapter';
import { CodeList, FieldWarnings, FormFooter, WarningList, asApi, placeErrors, placeWarnings, useAdapterOf } from './parts';
import type { CodeOption } from './parts';
import { forgetTargets } from './targets';
import { TEXT } from './text';

/** The entry a write is for, with the uuid and ETag of the latest snapshot (D.1). */
export function entryRefOf(ctx: Pick<HostContext, 'D'>, ms: MsId, entry: Pick<EntryRecord, 'id'>): EntryRef {
  const key = recordKey(ms, 'req', entry.id);
  const ref = refFor(ctx.D, key);
  return { ms, key, id: entry.id, uuid: ref?.id ?? null, etag: ref?.etag ?? null };
}

const PATHS = {
  isApplicable: 'isApplicable',
  inclusionJustification: 'inclusion',
  exclusionJustification: 'exclusion',
  ownerHandle: 'owner',
  holdsGate: 'holdsGate',
  gateReason: 'gateReason',
  statusNote: 'note',
  riskCodes: 'risks',
  documentCodes: 'documents',
  frequencyCode: 'frequency',
  description: 'description',
  reason: 'reason',
} as const;
const RULES = { 'BR-02': 'risks', 'APPL-ASSESS': 'isApplicable', 'NOT-A-MEMBER': 'owner', 'BR-03': 'exclusion' } as const;
const WARNING_FIELDS = { 'BR-03': 'exclusion', 'BR-02': 'risks' } as const;

interface DialogProps {
  ctx: HostContext;
  adapter: ControlsAdapter;
  ms: MsId;
  entry: EntryRecord;
  onClose(): void;
}

type Saved = { changed: MsId[]; warnings: Warn[]; nothing?: boolean };

/** The Edit form of an entry. */
export function EditDialog({ ctx, adapter, ms, entry, assessable, onClose }: DialogProps & { assessable: boolean }) {
  const formId = useId();
  const first = valuesOf(entry, entry.doc ? [entry.doc] : []);
  const initial = useRef<EntryValues>(first);
  const [values, setValues] = useState<EntryValues>(first);
  const [risks, setRisks] = useState<CodeOption[] | null>(null);
  const [risksFailed, setRisksFailed] = useState(false);
  const [docs, setDocs] = useState<CodeOption[] | null>(null);
  const [docsKnown, setDocsKnown] = useState(false);
  const [docsFailed, setDocsFailed] = useState(false);
  const [local, setLocal] = useState<Record<string, TextPair>>({});
  const [warnings, setWarnings] = useState<Warn[] | null>(null);

  useEffect(() => {
    let live = true;
    void adapter.risks(ms).then((res) => {
      if (!live) return;
      if (res.ok) setRisks(res.data.map((r) => ({ code: r.code, title: r.title })));
      else setRisksFailed(true);
    });
    void adapter.documents(ms).then((res) => {
      if (!live) return;
      if (!res.ok) {
        setDocsFailed(true);
        return;
      }
      // The register names every implementing document of the entry; the snapshot only the first one.
      const current = implementingDocuments(res.data, entry);
      initial.current = { ...initial.current, documents: current };
      setValues((v) => ({ ...v, documents: current }));
      setDocs(res.data.map((d) => ({ code: d.code, title: d.title })));
      setDocsKnown(true);
    });
    return () => {
      live = false;
    };
    // Loaded once when the form opens.
  }, []);

  const mutation = useMutation(async (next: EntryValues) => {
    const target = entryRefOf(ctx, ms, entry);
    const patch = patchOf(initial.current, next, { documentsKnown: docsKnown });
    const criteria = criteriaOf(initial.current, next);
    const out: Saved = { changed: [], warnings: [], nothing: !patch && !criteria };
    if (patch) {
      const res = await adapter.update(target, patch);
      if (!res.ok) return asApi(res as Result<Saved>);
      out.changed.push(...res.data.changed);
      out.warnings.push(...res.data.warnings);
      // A second Save sends only what changed after this one.
      initial.current = { ...next, frequency: initial.current.frequency, description: initial.current.description };
    }
    if (criteria) {
      const res = await adapter.criteria({ ...target, etag: null }, criteria);
      if (!res.ok) {
        await reloadChanged(ctx, out.changed);
        return asApi(res as Result<Saved>);
      }
      out.changed.push(...res.data.changed);
      out.warnings.push(...res.data.warnings);
      initial.current = { ...initial.current, frequency: next.frequency, description: '' };
    }
    return asApi<Saved>({ ok: true, data: out });
  });

  const placed = placeErrors(mutation.error, ctx.li, PATHS, RULES);
  const shown = placeWarnings(warnings ?? [], WARNING_FIELDS);
  const fieldError = (field: string) => (local[field] ? ctx.li(local[field]) : placed.fields[field] || null);
  const set = <K extends keyof EntryValues>(key: K) => (value: EntryValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems = checkValues(values, assessable, initial.current);
    setLocal(problems);
    if (Object.keys(problems).length) return;
    if (!patchOf(initial.current, values, { documentsKnown: docsKnown }) && !criteriaOf(initial.current, values)) {
      ctx.toast(ctx.li(TEXT.nothingChanged));
      onClose();
      return;
    }
    const res = await ctx.track(mutation.submit(values));
    if (!res.ok) return;
    await reloadChanged(ctx, res.data.changed, ms);
    if (res.data.warnings.length) {
      setWarnings(res.data.warnings);
      setValues((v) => ({ ...v, description: '' }));
      return;
    }
    ctx.toast(ctx.fill(TEXT.saved, { id: entry.id }));
    onClose();
  };

  const people = peopleOf(ctx.D);
  return (
    <Modal
      open
      title={ctx.fill(TEXT.editTitle, { id: entry.id })}
      sub={`${entry.title}. ${ctx.li(TEXT.editSub)}`}
      onClose={onClose}
      footer={<FormFooter saved={warnings !== null} busy={mutation.busy} onCancel={onClose} submitLabel={UI_TEXT.save} form={formId} />}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate>
        {warnings !== null ? <Alert tone="ok" role="status">{ctx.li(TEXT.savedWarnings)}</Alert> : null}
        {placed.general ? <Alert tone="bad">{ctx.li(placed.general.message)}</Alert> : null}
        <WarningList warnings={shown.general} title={TEXT.warningsTitle} />
        <Radio
          legend={TEXT.applies}
          name={`${formId}-applies`}
          value={values.isApplicable ? 'yes' : 'no'}
          onChange={(v) => set('isApplicable')(v === 'yes')}
          options={[{ value: 'yes', label: TEXT.appliesYes }, { value: 'no', label: TEXT.appliesNo }]}
          disabled={!assessable && values.isApplicable}
        />
        {!assessable ? <span className="mx-small">{ctx.li(TEXT.alwaysApplicableReason)}</span> : null}
        {fieldError('isApplicable') ? <span className="mx-error" role="alert">{fieldError('isApplicable')}</span> : null}
        {values.isApplicable ? (
          <Field label={TEXT.inclusion} hint={TEXT.inclusionHint} error={fieldError('inclusion')}>
            <Textarea name="inclusionJustification" value={values.inclusion} onChange={set('inclusion')} rows={3} maxLength={4000} />
          </Field>
        ) : (
          <>
            <Field label={TEXT.exclusion} hint={TEXT.exclusionHint} error={fieldError('exclusion')} required>
              <Textarea name="exclusionJustification" value={values.exclusion} onChange={set('exclusion')} rows={3} maxLength={4000} />
            </Field>
            <FieldWarnings warnings={shown.fields.exclusion} />
          </>
        )}
        <CodeList
          label={TEXT.risks}
          value={values.risks}
          onChange={set('risks')}
          options={risks}
          empty={TEXT.noRisks}
          pickLabel={TEXT.riskPick}
          pickerOff={risksFailed ? TEXT.risksFailed : null}
          removeLabel={TEXT.removeItem}
          error={fieldError('risks')}
        />
        <FieldWarnings warnings={shown.fields.risks} />
        <CodeList
          label={TEXT.documents}
          value={values.documents}
          onChange={set('documents')}
          options={docs}
          empty={TEXT.noDocuments}
          pickLabel={TEXT.documentPick}
          pickerOff={docsFailed ? TEXT.documentsFailed : null}
          removeLabel={TEXT.removeItem}
          error={fieldError('documents')}
          disabled={!docsKnown}
        />
        <Field label={TEXT.owner} error={fieldError('owner')}>
          <PersonPicker value={values.owner} onChange={set('owner')} people={people} allowNone />
        </Field>
        <Checkbox checked={values.holdsGate} onChange={set('holdsGate')} label={TEXT.holdsGate} name="holdsGate" />
        {values.holdsGate ? (
          <Field label={TEXT.gateReason} hint={initial.current.holdsGate ? TEXT.gateReasonKeep : undefined} error={fieldError('gateReason')} required={!initial.current.holdsGate}>
            <TextInput name="gateReason" value={values.gateReason} onChange={set('gateReason')} maxLength={1000} />
          </Field>
        ) : null}
        <Field label={TEXT.note} error={fieldError('note')}>
          <Textarea name="statusNote" value={values.note} onChange={set('note')} rows={2} maxLength={1000} />
        </Field>
        <Field label={TEXT.frequency} hint={TEXT.frequencyHint} error={fieldError('frequency')}>
          <Select name="frequencyCode" value={values.frequency} onChange={set('frequency')} options={frequencyOptions(ctx.D)} />
        </Field>
        <Field label={TEXT.description} hint={TEXT.descriptionHint} error={fieldError('description')}>
          <Textarea name="description" value={values.description} onChange={set('description')} rows={2} maxLength={2000} />
        </Field>
      </form>
    </Modal>
  );
}

/** A form with one text field and one write: Reject and Mark not applicable. */
function ReasonDialog({ ctx, ms, entry, onClose, title, text, label, hint, required, min, max, submitLabel, run, done, danger, warningField, emptyText }: Omit<DialogProps, 'adapter'> & {
  title: TextPair;
  text: TextPair;
  label: TextPair;
  hint?: TextPair;
  required: boolean;
  min: number;
  max: number;
  submitLabel: TextPair;
  run(target: EntryRef, value: string): Promise<Result<Outcome>>;
  done: TextPair;
  danger?: boolean;
  warningField?: boolean;
  /** The message of an empty field; the reason texts by default. */
  emptyText?: TextPair;
}) {
  const formId = useId();
  const [value, setValue] = useState('');
  const [local, setLocal] = useState<TextPair | null>(null);
  const [warnings, setWarnings] = useState<Warn[] | null>(null);
  const mutation = useMutation((v: string) => run(entryRefOf(ctx, ms, entry), v).then(asApi));
  const placed = placeErrors(mutation.error, ctx.li, PATHS, RULES);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = !filled(value) && required && emptyText ? emptyText : required || filled(value) ? checkReason(value, min, max) : null;
    setLocal(problem);
    if (problem) return;
    const res = await ctx.track(mutation.submit(value.trim()));
    if (!res.ok) return;
    await reloadChanged(ctx, res.data.changed, ms);
    if (res.data.warnings.length) {
      setWarnings(res.data.warnings);
      return;
    }
    ctx.toast(ctx.fill(done, { id: entry.id }));
    onClose();
  };
  const fieldError = local ? ctx.li(local) : placed.fields.reason || placed.fields.exclusion || placed.fields.isApplicable || null;
  return (
    <Modal
      open
      title={ctx.fill(title, { id: entry.id })}
      sub={entry.title}
      onClose={onClose}
      footer={warnings !== null
        ? <Button variant="primary" onClick={onClose}>{ctx.li(UI_TEXT.close)}</Button>
        : <FormFooter busy={mutation.busy} onCancel={onClose} submitLabel={submitLabel} form={formId} danger={danger} />}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate>
        <p className="mx-muted" style={{ margin: 0 }}>{ctx.li(text)}</p>
        {warnings !== null ? <Alert tone="ok" role="status">{ctx.li(TEXT.savedWarnings)}</Alert> : null}
        {placed.general ? <Alert tone="bad">{ctx.li(placed.general.message)}</Alert> : null}
        <Field label={label} hint={hint} error={fieldError} required={required}>
          <Textarea name="reason" value={value} onChange={setValue} rows={3} maxLength={max} disabled={warnings !== null} />
        </Field>
        {warningField ? <FieldWarnings warnings={warnings ?? undefined} /> : <WarningList warnings={warnings ?? []} title={TEXT.warningsTitle} />}
      </form>
    </Modal>
  );
}

export function RejectDialog({ adapter, ...props }: DialogProps) {
  return (
    <ReasonDialog
      {...props}
      title={TEXT.rejectTitle}
      text={TEXT.rejectText}
      label={TEXT.reason}
      required
      min={1}
      max={1000}
      submitLabel={TEXT.reject}
      done={TEXT.rejected}
      danger
      run={(target, reason) => adapter.transition(target, { to: 'partially_implemented', reason })}
    />
  );
}

export function NotApplicableDialog({ adapter, ...props }: DialogProps) {
  return (
    <ReasonDialog
      {...props}
      title={TEXT.naTitle}
      text={TEXT.naText}
      label={TEXT.exclusion}
      hint={TEXT.exclusionHint}
      required
      min={1}
      max={4000}
      submitLabel={TEXT.notApplicable}
      done={TEXT.naDone}
      warningField
      emptyText={TEXT.exclusionRequired}
      run={(target, exclusionJustification) => adapter.transition(target, { to: 'not_applicable', exclusionJustification })}
    />
  );
}

/** Delete entry: a reason of 10 to 500 characters, then the BR-22 confirmation when the server asks for it. */
export function DeleteDialog({ ctx, adapter, ms, entry, onClose }: DialogProps) {
  const formId = useId();
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<TextPair | null>(null);
  const [confirming, setConfirming] = useState<TextPair | null>(null);
  const mutation = useMutation((input: { reason: string; confirm: boolean }) => adapter.remove(entryRefOf(ctx, ms, entry), input.reason, input.confirm).then(asApi));
  const placed = placeErrors(confirming ? null : mutation.error, ctx.li, PATHS, RULES);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = checkReason(reason, 10, 500);
    setLocal(problem);
    if (problem) return;
    const res = await ctx.track(mutation.submit({ reason: reason.trim(), confirm: confirming !== null }));
    if (!res.ok) {
      // BR-22: the server lists the other systems the change reaches; Delete anyway sends the confirmation.
      if (res.status === 409 && res.error.slug === 'confirmation-required') setConfirming(res.error.message);
      return;
    }
    forgetTargets(ms);
    ctx.toast(ctx.fill(TEXT.deleted, { id: entry.id }));
    onClose();
    await reloadChanged(ctx, res.data.changed, ms);
  };
  return (
    <Modal
      open
      title={ctx.fill(TEXT.deleteTitle, { id: entry.id })}
      sub={entry.title}
      onClose={onClose}
      footer={<FormFooter busy={mutation.busy} onCancel={onClose} submitLabel={confirming ? TEXT.deleteConfirm : TEXT.deleteEntry} form={formId} danger />}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate>
        <p className="mx-muted" style={{ margin: 0 }}>{ctx.li(TEXT.deleteText)}</p>
        {placed.general ? <Alert tone="bad">{ctx.li(placed.general.message)}</Alert> : null}
        {confirming ? <Alert tone="warn" role="alert">{ctx.li(confirming)}</Alert> : null}
        <Field label={TEXT.reason} hint={TEXT.deleteReasonHint} error={local ? ctx.li(local) : placed.fields.reason || null} required>
          <Textarea name="reason" value={reason} onChange={setReason} rows={3} maxLength={500} />
        </Field>
      </form>
    </Modal>
  );
}

/** The entry form a layer request asked for, with an adapter of its own. */
export function EntryForms({ ctx, request, onClose }: {
  ctx: HostContext;
  request: { kind: 'edit' | 'reject' | 'na' | 'delete'; ms: MsId; entry: EntryRecord; assessable: boolean };
  onClose(): void;
}) {
  const adapter = useAdapterOf(ctx, adapterFor);
  const props = { ctx, adapter, ms: request.ms, entry: request.entry, onClose };
  if (request.kind === 'edit') return <EditDialog {...props} assessable={request.assessable} />;
  if (request.kind === 'reject') return <RejectDialog {...props} />;
  if (request.kind === 'na') return <NotApplicableDialog {...props} />;
  return <DeleteDialog {...props} />;
}
