// Forms of the Registers screen (MILESTONE-2 M2-13): "Add" and "Edit" of a register row with the fields of its kind
// (RegisterCreate and RegisterPatch, BR-22 confirmation for shared rows), "Record value" of a metric, "Add treatment"
// and "Accept residual risk" of a risk, and "Link to another system". Every form uses `useMutation`, keeps its fields
// on a refusal and shows the server's field errors next to the fields.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RegisterCreate, RegisterPatch } from '@mscd/shared';
import type { ApiError } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import { fieldErrors, newIdempotencyKey, useMutation } from '../api';
import type { HostContext, PickedFile, TextPair } from '../types';
import { Alert, Button, ConfirmDialog, DateInput, Drawer, Field, Modal, RecordPicker, Select, TextInput, Textarea, UI_TEXT } from '../ui';
import type { Option } from '../ui';
import { settled } from './adapter';
import { keepUnlinkedProof, proofKey, unlinkedProof } from './cache';
import type { AttachedProof } from './cache';
import {
  FIELDS, KIND_DEFS, RISK_ASSESSMENT_FIELDS, acceptBlock, acceptCandidates, createBody, editScope, emptyForm, formErrors, formOfRow, meOf,
  nextCode, outcomeOf, ownerFixed, patchBody, residualBody, residualErrors, systemName, treatmentBody, treatmentErrors, valueBody, valueErrors,
} from './model';
import type {
  FieldKey, FormErrors, FormState, Outcome, ProofHolder, RegisterKind, RegistersAdapter, ResidualForm, Result, RowModel, TargetOption, TreatmentForm,
  TreatmentModel,
} from './model';
import { ErrorAlert, FieldControl, SCORE_OPTIONS, asApi, peopleOf, problemText } from './parts';
import { KIND_TEXT, TEXT, VALUE_TEXT } from './text';

/** Server field errors by field key (`body.likelihood` and `likelihood`), with the duplicate code under `code`. */
function serverErrors(error: ApiError | null): FormErrors {
  const out: FormErrors = { ...fieldErrors(error) };
  if (error?.messageKey === 'register.duplicate_code') out.code = TEXT.duplicateCode;
  return out;
}

/** True when the refusal names one of the form's fields, so the form shows it there and not as a banner. */
function namesAField(error: ApiError | null, keys: readonly string[]): boolean {
  const fields = serverErrors(error);
  return keys.some((k) => fields[k]);
}

// ---------------------------------------------------------------------------------------------------------------
// Add and Edit
// ---------------------------------------------------------------------------------------------------------------

export type { AttachedProof } from './cache';

/** What one try of "Save" in the Add and Edit form sends. */
export interface RowSaveInput {
  kind: RegisterKind;
  /** The row to change, or null to add one. */
  row: RowModel | null;
  /** The `RegisterCreate` of the form without the proof (add). */
  create: RegisterCreate | null;
  /** The changed fields without the proof (edit), or null when only the proof file changes. */
  patch: RegisterPatch | null;
  /** The person confirmed the change of a shared row (BR-22). */
  confirm: boolean;
  /** The evidence record and the file chosen in the form, or null. */
  proof: { holder: ProofHolder; file: PickedFile } | null;
  /** The file as an earlier try (or an earlier Edit of the record) attached it without linking it, if any. */
  attached: AttachedProof | null;
  idempotencyKey: string;
}

/** What one try of "Save" did. */
export interface RowSaveTry {
  /** The answer to show: the register write (with a warning when its proof file was not kept), or the refusal. */
  result: Result<Outcome>;
  /**
   * The file attached to the evidence record that the record does not point to yet: the next try of the form, or the
   * next Edit of the record, reuses it. Null when nothing waits to be linked.
   */
  attached: AttachedProof | null;
  /** The id of the record the try wrote or checked; null when no record exists. */
  recordId: string | null;
}

/** A warning in both languages that the proof file was not kept, with the reason of the refusal as a sentence. */
function proofWarning(pair: TextPair, values: Record<string, string>, error: ApiError): TextPair {
  const sentence = (s: string) => {
    const text = (error.detail && error.message[0] === error.message[1] && !error.messageKey ? `${s}: ${error.detail}` : s).trim();
    return /[.!?]$/.test(text) ? text : `${text}.`;
  };
  const fill = (template: string, reason: string) => template.replace(/\{(\w+)\}/g, (m: string, k: string) => (k === 'reason' ? reason : values[k] ?? m));
  return [fill(pair[0], sentence(error.message[0])), fill(pair[1], sentence(error.message[1]))];
}

/** The register write and the proof patch as one outcome: the systems of both, the warnings of both, the newest ETag. */
function joined(first: Outcome, second: Outcome, wrote: boolean): Outcome {
  return {
    message: second.message ?? (wrote ? first.message : null),
    warnings: [...first.warnings, ...second.warnings],
    changed: [...new Set([...first.changed, ...second.changed])],
    ref: second.ref ?? first.ref,
    data: first.data ?? second.data,
  };
}

/**
 * One try of "Save" in the Add and Edit form. The evidence record that keeps a competence proof changes only after the
 * server accepted the register write: `evidence.files` makes the picked file that record's current file, so a save
 * that is refused (BR-22 confirmation, a stale ETag, a field error, a person who is not a member) or cancelled must
 * never reach it.
 *
 * 1. The register write without the proof: the create, or the patch of the changed fields. When only the proof file
 *    changes, the patch sends the row's role unchanged, so the server checks the ETag, the permission and BR-22
 *    before any file moves, and changes nothing.
 * 2. The file is attached to the evidence record (once: a later try of the same form reuses it).
 * 3. A second patch points the record to the stored file, with the ETag the first write answered.
 *
 * When step 2 or 3 is refused after step 1 changed the register, the record stays saved and the result carries a
 * warning that says the proof file was not kept, and why. When step 3 is refused, the stored file is handed back, so
 * the next try links it without a second `evidence.files` call (the form keeps it per record, see `unlinkedProof`).
 */
export async function trySaveRow(adapter: RegistersAdapter, ms: MsId, input: RowSaveInput): Promise<RowSaveTry> {
  const { kind, row, proof } = input;
  const confirm = input.confirm ? { confirm: true } : {};
  const sameFile = (a: AttachedProof | null) => (a && proof && a.file === proof.file && a.holder === proof.holder.id ? a : null);
  let attached = sameFile(input.attached);
  const done = (result: Result<Outcome>, kept: AttachedProof | null): RowSaveTry => ({
    result, attached: kept, recordId: row?.id ?? (result.ok ? result.data.ref?.id ?? null : null),
  });
  let first: Result<Outcome>;
  if (!row) {
    if (!input.create) return done({ ok: true, data: outcomeOf({ message: TEXT.nothingChanged }) }, attached);
    first = await settled(adapter.create(ms, kind, input.create, input.idempotencyKey));
  } else {
    const fields = input.patch ?? (proof ? { title: row.title } : null);
    if (!fields) return done({ ok: true, data: outcomeOf({ message: TEXT.nothingChanged }) }, attached);
    first = await settled(adapter.update(ms, kind, row, { ...fields, ...confirm } as RegisterPatch));
  }
  if (!first.ok || !proof) return done(first, attached);
  const written = first.data;
  // The first write changed the register (a create or changed fields), so a refusal from here on keeps the record.
  const wrote = !row || Boolean(input.patch);
  const code = written.ref?.code ?? row?.code ?? '';
  if (!attached) {
    const stored = await settled(adapter.attachProof(ms, proof.holder, proof.file));
    if (!stored.ok) {
      if (!wrote) return done({ ok: false, error: stored.error }, null);
      const warning = proofWarning(TEXT.proofNotAttached, { code }, stored.error);
      return done({ ok: true, data: { ...written, warnings: [...written.warnings, warning] } }, null);
    }
    attached = { file: proof.file, holder: proof.holder.id, storageObjectId: stored.data.storageObjectId };
  }
  const target: RowModel = row
    ? { ...row, etag: written.ref?.etag ?? row.etag }
    : { id: written.ref?.id ?? '', code, etag: written.ref?.etag ?? null, title: '', owner: 'none', updatedAt: '', shared: false, ms: [ms] };
  const linked = await settled(adapter.update(ms, kind, target, { proofObjectId: attached.storageObjectId, ...confirm }));
  if (!linked.ok) {
    // The file is the evidence record's current file now: the next try (or the next Edit of the record, when the
    // record is saved) sends the same stored file again without attaching it twice.
    if (!wrote) return done(linked, attached);
    const warning = proofWarning(TEXT.proofNotLinked, { code, holder: proof.holder.code }, linked.error);
    return done({ ok: true, data: { ...written, warnings: [...written.warnings, warning] } }, attached);
  }
  return done({ ok: true, data: joined(written, linked.data, wrote) }, null);
}

/**
 * Keeps the file a try attached without linking it for the next Edit of its record, or forgets it once the record is
 * saved without one waiting (linked, or the proof left out). A refused try that attached nothing keeps what was kept.
 */
export function rememberProof(ctx: Pick<HostContext, 'org' | 'me' | 'person'>, ms: MsId, run: RowSaveTry): void {
  if (run.recordId && (run.attached || run.result.ok)) keepUnlinkedProof(proofKey(ctx, ms, run.recordId), run.attached);
}

export interface RowFormProps {
  ctx: HostContext;
  adapter: RegistersAdapter;
  ms: MsId;
  /** The kind to add to (add), or of the row (edit). */
  kind: RegisterKind;
  /** The kinds the session may add to; the form offers a choice when there are several (add only). */
  kinds?: readonly RegisterKind[];
  /** The row to edit; null to add one. */
  row: RowModel | null;
  /** Codes of the loaded list, for the suggested code of a new row. */
  codes: readonly string[];
  onClose(): void;
  /** A write went through: its outcome, the code of the row and the register it was written to. */
  onSaved(outcome: Outcome, code: string, kind: RegisterKind): void;
}

/** The kinds' metrics for the objective form (`metricCode`). */
function useMetrics(adapter: RegistersAdapter, ms: MsId, wanted: boolean): Option[] {
  const [metrics, setMetrics] = useState<Option[]>([]);
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    void adapter.list(ms, 'metrics', { page: 1, pageSize: 200 }).then((res) => {
      if (live && res.ok) setMetrics(res.data.items.map((m) => ({ value: m.code, label: `${m.code}  ${m.title}` })));
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [adapter, ms, wanted]);
  return metrics;
}

export function RowFormDrawer({ ctx, adapter, ms, kind: initialKind, kinds, row, codes, onClose, onSaved }: RowFormProps) {
  const me = meOf(ctx);
  const today = ctx.D?.today ?? ctx.D?.TODAY_S ?? null;
  const [kind, setKind] = useState<RegisterKind>(initialKind);
  const [form, setForm] = useState<FormState>(() => (row ? formOfRow(initialKind, row) : emptyForm(initialKind, codes, me, today)));
  const [local, setLocal] = useState<FormErrors>({});
  const [note, setNote] = useState<TextPair | null>(null);
  const [confirming, setConfirming] = useState<ApiError | null>(null);
  // A file an earlier save attached to the evidence record without the record pointing to it starts chosen.
  const [kept] = useState<AttachedProof | null>(() => (row ? unlinkedProof(proofKey(ctx, ms, row.id)) : null));
  const [holder, setHolder] = useState(kept?.holder ?? '');
  const [picked, setPicked] = useState<PickedFile | null>(kept?.file ?? null);
  const key = useRef(newIdempotencyKey());
  const def = KIND_DEFS[kind];
  const scope = row ? editScope(ctx, ms, kind, row) : 'all';
  const fixedOwner = !row && ownerFixed(ctx, ms, kind);
  const people = useMemo(() => peopleOf(ctx), [ctx.D]);
  const metrics = useMetrics(adapter, ms, kind === 'objectives');
  const holders: ProofHolder[] = kind === 'competence' ? adapter.proofHolders(ms) : [];

  // A new row suggests the next free code of its register: read the codes once the kind is known.
  const suggested = useRef(String(form.code ?? ''));
  useEffect(() => {
    if (row || !def.prefix) return undefined;
    let live = true;
    void adapter.list(ms, kind, { page: 1, pageSize: 200 }).then((res) => {
      if (!live || !res.ok) return;
      const next = nextCode(def.prefix!, [...codes, ...res.data.items.map((r) => r.code)]);
      setForm((f) => (String(f.code ?? '') === suggested.current ? { ...f, code: next } : f));
      suggested.current = next;
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [adapter, ms, kind]);

  // The register is written first and the evidence record only after the server accepted it (`trySaveRow`). A file
  // attached by a try whose last step was refused is reused by the next try of the same pick, and kept per record
  // (cache.ts) for the next Edit when the form closes.
  const attachedProof = useRef<AttachedProof | null>(kept);
  const save = useMutation(async (confirm: boolean) => {
    const chosen = holders.find((h) => h.id === holder);
    const run = await trySaveRow(adapter, ms, {
      kind,
      row,
      create: row ? null : createBody(kind, form, { ownerFixed: fixedOwner, me }),
      patch: row ? patchBody(kind, form, row, scope ?? 'own') : null,
      confirm,
      proof: picked && chosen ? { holder: chosen, file: picked } : null,
      attached: attachedProof.current,
      idempotencyKey: key.current,
    });
    attachedProof.current = run.attached;
    rememberProof(ctx, ms, run);
    return asApi(Promise.resolve(run.result));
  });

  const changeKind = (next: RegisterKind) => {
    setKind(next);
    const fresh = emptyForm(next, codes, me, today);
    suggested.current = String(fresh.code ?? '');
    setForm(fresh);
    setLocal({});
    setNote(null);
    save.reset();
  };
  const set = (k: string, v: string | boolean) => {
    const next = { ...form, [k]: v };
    setForm(next);
    if (Object.keys(local).length) setLocal(formErrors(kind, next));
  };
  const submit = (confirm: boolean) => {
    const problems = formErrors(kind, form);
    setLocal(problems);
    setNote(null);
    if (Object.values(problems).some(Boolean)) return;
    if (row && !picked && !patchBody(kind, form, row, scope ?? 'own')) {
      setNote(TEXT.nothingChanged);
      return;
    }
    void save.submit(confirm).then((res) => {
      if (res.ok) {
        setConfirming(null);
        onSaved(res.data, res.data.ref?.code ?? row?.code ?? String(form.code), kind);
        return;
      }
      // BR-22: a shared row changes in every linked system; ask, then send again with confirm.
      if (res.error.slug === 'confirmation-required') setConfirming(res.error);
      else setConfirming(null);
    });
  };
  const pick = () => {
    const chosen = holders.find((h) => h.id === holder);
    if (!chosen) return;
    void ctx.openPicker({ ms, kind: 'evidence', recordId: chosen.id }).then((file) => {
      if (file) setPicked(file);
    });
  };

  const server = serverErrors(save.error);
  const errors: FormErrors = { ...server, ...Object.fromEntries(Object.entries(local).filter(([, v]) => v)) };
  const err = (k: string) => errors[k] ?? null;
  const fieldKeys = ['code', 'title', 'ownerHandle', ...def.fields];
  const refused = save.error && save.error.slug !== 'confirmation-required' && !namesAField(save.error, fieldKeys) ? save.error : null;
  const enabled = (k: string) => scope === 'all' || (scope === 'own' && k !== 'ownerHandle') || (scope === 'assessment' && (RISK_ASSESSMENT_FIELDS as readonly string[]).includes(k));
  const otherSystems = row && row.ms.length > 1 ? row.ms.map((m) => systemName(ctx, m)).join(', ') : null;
  const title = row ? ctx.fill(TEXT.formEdit, { code: row.code }) : ctx.fill(TEXT.formAdd, { kind: ctx.li(KIND_TEXT[kind].label) });

  return (
    <>
      <Drawer
        open
        title={title}
        crumb={TEXT.title}
        onClose={onClose}
        footer={(
          <div className="mx-reg-foot-actions">
            <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
            <Button variant="primary" busy={save.busy && !confirming} onClick={() => submit(false)}>{ctx.li(UI_TEXT.save)}</Button>
          </div>
        )}
      >
        <div className="mx-small">{ctx.li(TEXT.formSub)}</div>
        {adapter.sample ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
        {otherSystems ? <Alert tone="warn">{ctx.fill(TEXT.sharedNote, { systems: otherSystems })}</Alert> : null}
        {scope === 'assessment' ? <Alert tone="info">{ctx.li(TEXT.assessmentOnly)}</Alert> : null}
        {!row && kinds && kinds.length > 1 ? (
          <Field label={TEXT.register}>
            <Select value={kind} onChange={(v) => changeKind(v as RegisterKind)} name="register" options={kinds.map((k) => ({ value: k, label: KIND_TEXT[k].one }))} />
          </Field>
        ) : null}
        {def.prefix ? (
          <Field label={TEXT.code} hint={TEXT.codeHint} error={err('code')} required>
            <TextInput value={String(form.code ?? '')} onChange={(v) => set('code', v)} name="code" maxLength={30} disabled={!enabled('code')} />
          </Field>
        ) : null}
        {kind === 'competence' ? (
          <Field label={FIELDS.personHandle.label} error={err('personHandle')} required>
            <FieldControl ctx={ctx} field="personHandle" form={form} onChange={set} metrics={metrics} people={people} disabled={!enabled('personHandle')} />
          </Field>
        ) : null}
        <Field label={kind === 'competence' ? TEXT.roleField : TEXT.titleField} hint={kind === 'competence' ? TEXT.roleHint : undefined} error={err('title')} required>
          <TextInput value={String(form.title ?? '')} onChange={(v) => set('title', v)} name="title" maxLength={kind === 'competence' ? 150 : 255} disabled={!enabled('title')} />
        </Field>
        <Field
          label={TEXT.owner}
          hint={fixedOwner ? TEXT.ownerSelf : kind === 'risks' ? TEXT.ownerRisk : def.ownerRequired ? TEXT.ownerAlways : undefined}
          error={err('ownerHandle')}
          required={def.ownerRequired}
        >
          <Select
            value={fixedOwner ? me : String(form.ownerHandle ?? '')}
            onChange={(v) => set('ownerHandle', v)}
            name="ownerHandle"
            disabled={fixedOwner || !enabled('ownerHandle')}
            empty={def.ownerRequired ? UI_TEXT.choose : UI_TEXT.none}
            options={people.map((p) => ({ value: p.id, label: p.jobTitle && p.jobTitle !== '-' ? `${p.name}, ${p.jobTitle}` : p.name }))}
          />
        </Field>
        {def.fields.filter((k) => k !== 'personHandle').map((k: FieldKey) => {
          const f = FIELDS[k];
          if (f.type === 'proof') {
            return (
              <ProofField
                key={k}
                ctx={ctx}
                row={row}
                holders={holders}
                chosen={holders.find((h) => h.id === holder) ?? null}
                holder={holder}
                picked={picked}
                kept={Boolean(kept && picked === kept.file && holder === kept.holder)}
                disabled={!enabled(k)}
                onHolder={(id) => { setHolder(id); setPicked(null); }}
                onPick={pick}
              />
            );
          }
          if (f.type === 'bool') {
            return <FieldControl key={k} ctx={ctx} field={k} form={form} onChange={set} metrics={metrics} people={people} disabled={!enabled(k)} />;
          }
          return (
            <Field key={k} label={f.label} hint={f.hint} error={err(k)} required={f.required}>
              <FieldControl ctx={ctx} field={k} form={form} onChange={set} metrics={metrics} people={people} disabled={!enabled(k)} />
            </Field>
          );
        })}
        {refused ? <ErrorAlert ctx={ctx} error={refused} /> : null}
        {note ? <Alert tone="info">{ctx.li(note)}</Alert> : null}
      </Drawer>
      <ConfirmDialog
        open={Boolean(confirming)}
        title={TEXT.confirmShared}
        body={(
          <>
            <div>{confirming ? problemText(ctx, confirming) : null}</div>
            <div style={{ marginTop: 8 }}>{ctx.li(TEXT.confirmSharedBody)}</div>
          </>
        )}
        confirmLabel={TEXT.confirm}
        busy={save.busy}
        onConfirm={() => submit(true)}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}

/**
 * The proof file of a competence record: the evidence record that keeps it (one of competence only, see
 * `proofHoldersOf`) and the file chosen in the picker. A record that has a file gets the chosen file in its place,
 * which the form says before anything is saved. A file an earlier save attached without linking (`kept`) is already
 * that record's file, so the form says that saving links it.
 */
function ProofField({ ctx, row, holders, chosen, holder, picked, kept, disabled, onHolder, onPick }: {
  ctx: HostContext;
  row: RowModel | null;
  holders: ProofHolder[];
  chosen: ProofHolder | null;
  holder: string;
  picked: PickedFile | null;
  kept: boolean;
  disabled: boolean;
  onHolder(id: string): void;
  onPick(): void;
}) {
  const current = row?.proofObjectId ? (row.proofName ? ctx.fill(TEXT.fProofChosen, { name: row.proofName }) : ctx.li(TEXT.proofStored)) : ctx.li(TEXT.proofNone);
  return (
    <fieldset className="mx-reg-proof">
      <legend className="mx-label">{ctx.li(TEXT.fProofFile)}</legend>
      <div className="mx-small">{picked ? ctx.fill(TEXT.fProofChosen, { name: picked.fileName }) : current}</div>
      {holders.length ? (
        <>
          <Field label={TEXT.fProofEvidence} hint={TEXT.fProofEvidenceHint}>
            <Select value={holder} onChange={onHolder} name="proofEvidence" disabled={disabled} empty={UI_TEXT.choose} options={holders.map((h) => ({ value: h.id, label: `${h.code}  ${h.title}` }))} />
          </Field>
          {kept && chosen && picked
            ? <Alert tone="info">{ctx.fill(TEXT.fProofKept, { name: picked.fileName, code: chosen.code })}</Alert>
            : chosen?.hasFile ? <Alert tone="warn">{ctx.fill(TEXT.fProofReplaces, { code: chosen.code })}</Alert> : null}
          <div><Button onClick={onPick} disabled={disabled || !holder}>{ctx.li(TEXT.fChooseProof)}</Button></div>
        </>
      ) : <div className="mx-small">{ctx.li(TEXT.fProofNoEvidence)}</div>}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Record value
// ---------------------------------------------------------------------------------------------------------------

function monthStart(today: string): string {
  return `${today.slice(0, 8)}01`;
}

export function ValueDialog({ ctx, adapter, ms, row, onClose, onSaved }: {
  ctx: HostContext;
  adapter: RegistersAdapter;
  ms: MsId;
  row: RowModel;
  onClose(): void;
  onSaved(outcome: Outcome): void;
}) {
  const today = ctx.D?.today ?? ctx.D?.TODAY_S ?? new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ periodStart: monthStart(today), periodEnd: today, value: '', note: '' });
  const [local, setLocal] = useState<FormErrors>({});
  const key = useRef(newIdempotencyKey());
  const save = useMutation(() => asApi(adapter.recordValue(ms, row, valueBody(form), key.current)));
  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });
  const submit = () => {
    const problems = valueErrors(form);
    setLocal(problems);
    if (Object.keys(problems).length) return;
    void save.submit(undefined).then((res) => {
      if (res.ok) onSaved(res.data);
    });
  };
  const server = fieldErrors(save.error);
  const err = (k: string) => local[k] ?? server[k] ?? null;
  const refused = save.error && !['periodStart', 'periodEnd', 'value', 'note'].some((k) => server[k]) ? save.error : null;
  const unit = row.unit ? ` (${row.unit})` : '';
  return (
    <Modal
      open
      title={ctx.fill(TEXT.valueTitle, { code: row.code })}
      sub={row.title}
      onClose={onClose}
      footer={<><Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button><Button variant="primary" busy={save.busy} onClick={submit}>{ctx.li(TEXT.recordValue)}</Button></>}
    >
      <div className="mx-reg-pair">
        <Field label={TEXT.periodStart} error={err('periodStart')} required><DateInput value={form.periodStart} onChange={(v) => set('periodStart', v)} name="periodStart" /></Field>
        <Field label={TEXT.periodEnd} error={err('periodEnd')} required><DateInput value={form.periodEnd} onChange={(v) => set('periodEnd', v)} name="periodEnd" /></Field>
      </div>
      <Field label={[`${TEXT.value[0]}${unit}`, `${TEXT.value[1]}${unit}`]} error={err('value')} required>
        <TextInput type="number" value={form.value} onChange={(v) => set('value', v)} name="value" />
      </Field>
      <Field label={TEXT.note} error={err('note')}>
        <Textarea value={form.note} onChange={(v) => set('note', v)} rows={2} maxLength={1000} name="note" />
      </Field>
      <ErrorAlert ctx={ctx} error={refused} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Add treatment
// ---------------------------------------------------------------------------------------------------------------

/** The suggested code of a treatment: T- and the number of the risk (R-031 gives T-031), else the next free T- code. */
export function treatmentCode(risk: Pick<RowModel, 'code'>, existing: readonly string[]): string {
  const m = /(\d+)$/.exec(risk.code);
  const own = m ? `T-${m[1]}` : null;
  if (own && !existing.includes(own)) return own;
  return nextCode('T-', existing);
}

/** What one try of "Add treatment" did. */
export interface TreatmentTry {
  /** The answer of the create, or of the option change when that was refused. */
  result: Result<Outcome>;
  /** The risk after the try: with the new option and the ETag the change answered when the change went through. */
  risk: RowModel;
  /** The outcome of the option change made on this try, or null. */
  optionChanged: Outcome | null;
}

/**
 * One try of "Add treatment". The treatment option belongs to the risk: it is changed first when it differs from the
 * risk as last known (a shared risk changes everywhere, which the form says), then the treatment is created. A create
 * refused after the change leaves the risk changed; the caller keeps the returned risk, so the next try neither sends
 * the change again nor sends the old ETag (412).
 */
export async function tryAddTreatment(
  adapter: RegistersAdapter, ms: MsId, risk: RowModel, form: TreatmentForm, targets: readonly TargetOption[], idempotencyKey: string,
): Promise<TreatmentTry> {
  let current = risk;
  let optionChanged: Outcome | null = null;
  if (form.option && form.option !== (risk.treatmentOption ?? '')) {
    const changed = await settled(adapter.update(ms, 'risks', risk, { treatmentOption: form.option, ...(risk.ms.length > 1 ? { confirm: true } : {}) }));
    if (!changed.ok) return { result: changed, risk, optionChanged: null };
    optionChanged = changed.data;
    current = { ...risk, treatmentOption: form.option, etag: changed.data.ref?.etag ?? null };
  }
  const created = await settled(adapter.addTreatment(ms, current, treatmentBody(current, form, targets), idempotencyKey));
  if (created.ok && optionChanged) {
    const data: Outcome = {
      ...created.data,
      changed: [...new Set([...optionChanged.changed, ...created.data.changed])],
      warnings: [...optionChanged.warnings, ...created.data.warnings],
    };
    return { result: { ok: true, data }, risk: current, optionChanged };
  }
  return { result: created, risk: current, optionChanged };
}

export function TreatmentDialog({ ctx, adapter, ms, risk, existing, onClose, onSaved, onRiskChanged }: {
  ctx: HostContext;
  adapter: RegistersAdapter;
  ms: MsId;
  risk: RowModel;
  /** The treatments of this risk, for the code suggested before the codes of the whole system are read. */
  existing: readonly TreatmentModel[];
  onClose(): void;
  onSaved(outcome: Outcome, code: string): void;
  /** The option of the risk changed and the create was refused: the drawer reads the risk again (its new ETag). */
  onRiskChanged?(outcome: Outcome): void;
}) {
  const [form, setForm] = useState<TreatmentForm>(() => ({
    option: risk.treatmentOption ?? 'modify', code: treatmentCode(risk, existing.map((t) => t.code)), title: '', owner: risk.owner !== 'none' ? risk.owner : '', due: '', target: '',
  }));
  const [local, setLocal] = useState<FormErrors>({});
  const [targets, setTargets] = useState<{ list: TargetOption[] | null; error: ApiError | null }>({ list: null, error: null });
  const key = useRef(newIdempotencyKey());
  const people = useMemo(() => peopleOf(ctx), [ctx.D]);
  // The risk as this dialog last knows it: a reload of the drawer's row, or the option change of a refused try.
  const current = useRef<RowModel>(risk);
  useEffect(() => {
    current.current = risk;
  }, [risk]);
  // Treatment codes are unique per system: the suggested code skips every code of the system, so the targets show
  // once those codes are read too (a code the person typed is kept).
  const suggested = useRef(form.code);
  useEffect(() => {
    let live = true;
    void Promise.all([settled(adapter.targets(ms)), settled(adapter.treatmentCodes(ms))]).then(([res, codes]) => {
      if (!live) return;
      if (codes.ok) {
        const next = treatmentCode(risk, [...existing.map((t) => t.code), ...codes.data]);
        setForm((f) => (f.code === suggested.current ? { ...f, code: next } : f));
        suggested.current = next;
      }
      setTargets(res.ok ? { list: res.data, error: null } : { list: [], error: res.error });
    });
    return () => {
      live = false;
    };
  }, [adapter, ms]);
  const save = useMutation(async () => {
    const run = await tryAddTreatment(adapter, ms, current.current, form, targets.list ?? [], key.current);
    current.current = run.risk;
    if (!run.result.ok && run.optionChanged) onRiskChanged?.(run.optionChanged);
    return asApi(Promise.resolve(run.result));
  });
  const set = (k: keyof TreatmentForm, v: string) => {
    const next = { ...form, [k]: v };
    setForm(next);
    if (Object.keys(local).length) setLocal(treatmentErrors(next));
  };
  const submit = () => {
    const problems = treatmentErrors(form);
    setLocal(problems);
    if (Object.keys(problems).length) return;
    void save.submit(undefined).then((res) => {
      if (res.ok) onSaved(res.data, form.code.trim());
    });
  };
  const server = serverErrors(save.error);
  const map: Record<string, string> = { code: 'code', title: 'title', ownerHandle: 'owner', targetDate: 'due', targetCode: 'target' };
  const fromServer: FormErrors = {};
  for (const [wireKey, formKey] of Object.entries(map)) if (server[wireKey]) fromServer[formKey] = server[wireKey];
  const err = (k: string) => local[k] ?? fromServer[k] ?? null;
  const refused = save.error && !Object.keys(fromServer).length ? save.error : null;
  return (
    <Modal
      open
      title={ctx.fill(TEXT.treatmentTitle, { code: risk.code })}
      sub={risk.title}
      onClose={onClose}
      footer={<><Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button><Button variant="primary" busy={save.busy} onClick={submit}>{ctx.li(TEXT.addTreatment)}</Button></>}
    >
      {risk.ms.length > 1 ? <Alert tone="warn">{ctx.fill(TEXT.sharedNote, { systems: risk.ms.map((m) => systemName(ctx, m)).join(', ') })}</Alert> : null}
      <Field label={TEXT.fTreatmentOption} hint={TEXT.treatmentOptionHint}>
        <Select value={form.option} onChange={(v) => set('option', v)} name="treatmentOption" options={Object.entries(VALUE_TEXT.treatmentOption).map(([value, label]) => ({ value, label }))} />
      </Field>
      <div className="mx-reg-pair">
        <Field label={TEXT.treatmentCode} error={err('code')} required>
          <TextInput value={form.code} onChange={(v) => set('code', v)} name="treatmentCode" maxLength={30} />
        </Field>
        <Field label={TEXT.treatmentDue} error={err('due')} required>
          <DateInput value={form.due} onChange={(v) => set('due', v)} name="targetDate" />
        </Field>
      </div>
      <Field label={TEXT.treatmentName} error={err('title')} required>
        <TextInput value={form.title} onChange={(v) => set('title', v)} name="treatmentTitle" maxLength={255} />
      </Field>
      <Field label={TEXT.treatmentOwner} error={err('owner')} required>
        <Select value={form.owner} onChange={(v) => set('owner', v)} name="treatmentOwner" empty={UI_TEXT.choose} options={people.map((p) => ({ value: p.id, label: p.jobTitle && p.jobTitle !== '-' ? `${p.name}, ${p.jobTitle}` : p.name }))} />
      </Field>
      <Field label={TEXT.treatmentTarget} hint={TEXT.treatmentTargetHint} error={err('target')} required>
        {targets.list === null ? <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div> : (
          <RecordPicker value={form.target} onChange={(v) => set('target', v)} records={targets.list.map((t) => ({ id: t.code, title: t.title }))} limit={40} />
        )}
      </Field>
      {targets.error ? <Alert tone="warn">{ctx.li(TEXT.targetsFailed)}</Alert> : null}
      <ErrorAlert ctx={ctx} error={refused} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Accept residual risk
// ---------------------------------------------------------------------------------------------------------------

export function ResidualDialog({ ctx, adapter, ms, risk, treatments, onClose, onSaved }: {
  ctx: HostContext;
  adapter: RegistersAdapter;
  ms: MsId;
  risk: RowModel;
  treatments: readonly TreatmentModel[];
  onClose(): void;
  onSaved(outcome: Outcome, treatmentId: string): void;
}) {
  const candidates = acceptCandidates(treatments);
  const exact = candidates.filter((t) => t.status === 'implemented');
  const [form, setForm] = useState<ResidualForm>(() => ({
    treatmentId: exact.length === 1 ? exact[0].id : '',
    likelihood: risk.residualLikelihood ? String(risk.residualLikelihood) : '',
    consequence: risk.residualConsequence ? String(risk.residualConsequence) : '',
    note: '',
  }));
  const [local, setLocal] = useState<FormErrors>({});
  const key = useRef(newIdempotencyKey());
  const save = useMutation(() => asApi(adapter.acceptResidual(ms, risk, residualBody(form), key.current)));
  const set = (k: keyof ResidualForm, v: string) => setForm({ ...form, [k]: v });
  const block = acceptBlock(ctx, ms, risk, candidates, form.treatmentId || null);
  const submit = () => {
    const problems = residualErrors(form);
    setLocal(problems);
    if (Object.keys(problems).length || block) return;
    void save.submit(undefined).then((res) => {
      if (res.ok) onSaved(res.data, form.treatmentId);
    });
  };
  const server = fieldErrors(save.error);
  const err = (k: string, wire: string) => local[k] ?? server[wire] ?? null;
  const refused = save.error && !['residualLikelihood', 'residualConsequence', 'note'].some((k) => server[k]) ? save.error : null;
  const choices: Option[] = candidates.map((t) => ({ value: t.id, label: `${t.code}  ${t.title}` }));
  return (
    <Modal
      open
      title={ctx.fill(TEXT.residualTitle, { code: risk.code })}
      sub={TEXT.residualSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={save.busy} disabledReason={block} onClick={submit}>{ctx.li(TEXT.acceptResidual)}</Button>
        </>
      )}
    >
      <Field label={TEXT.residualTreatment}>
        <Select
          value={form.treatmentId}
          onChange={(v) => set('treatmentId', v)}
          name="treatmentId"
          empty={exact.length === 1 ? undefined : TEXT.residualAuto}
          options={choices}
        />
      </Field>
      <div className="mx-reg-pair">
        <Field label={TEXT.fResidualLikelihood} hint={TEXT.fScaleHint} error={err('likelihood', 'residualLikelihood')} required>
          <Select value={form.likelihood} onChange={(v) => set('likelihood', v)} name="residualLikelihood" empty={UI_TEXT.choose} options={SCORE_OPTIONS} />
        </Field>
        <Field label={TEXT.fResidualConsequence} hint={TEXT.fScaleHint} error={err('consequence', 'residualConsequence')} required>
          <Select value={form.consequence} onChange={(v) => set('consequence', v)} name="residualConsequence" empty={UI_TEXT.choose} options={SCORE_OPTIONS} />
        </Field>
      </div>
      <Field label={TEXT.residualNote} error={err('note', 'note')} required>
        <Textarea value={form.note} onChange={(v) => set('note', v)} rows={3} maxLength={2000} name="residualNote" />
      </Field>
      <ErrorAlert ctx={ctx} error={refused} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Link to another system
// ---------------------------------------------------------------------------------------------------------------

export function LinkDialog({ ctx, adapter, ms, kind, row, targets, onClose, onSaved }: {
  ctx: HostContext;
  adapter: RegistersAdapter;
  ms: MsId;
  kind: RegisterKind;
  row: RowModel;
  targets: { id: MsId; label: string }[];
  onClose(): void;
  onSaved(outcome: Outcome, target: MsId): void;
}) {
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const [note, setNote] = useState('');
  const save = useMutation(() => asApi(adapter.link(ms, kind, row, target, note)));
  const submit = () => {
    if (!target) return;
    void save.submit(undefined).then((res) => {
      if (res.ok) onSaved(res.data, target);
    });
  };
  return (
    <Modal
      open
      title={ctx.fill(TEXT.linkTitle, { code: row.code })}
      sub={TEXT.linkSub}
      onClose={onClose}
      footer={<><Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button><Button variant="primary" busy={save.busy} disabled={!target} onClick={submit}>{ctx.li(TEXT.linkOther)}</Button></>}
    >
      <Field label={TEXT.linkSystem} required>
        <Select value={target} onChange={setTarget} name="linkSystem" options={targets.map((t) => ({ value: t.id, label: t.label }))} />
      </Field>
      {KIND_DEFS[kind].linkByCode ? (
        <Field label={TEXT.linkNote}>
          <Textarea value={note} onChange={setNote} rows={2} maxLength={1000} name="relevanceNote" />
        </Field>
      ) : null}
      <ErrorAlert ctx={ctx} error={save.error} />
    </Modal>
  );
}
