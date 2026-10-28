// The evidence forms (MILESTONE-2 M2-11): New evidence (code, title, owner, frequency, classification, the controls and
// requirements of this system it serves and, with `integrated_mode`, of other systems, with the BR-23 warning), then
// "Attach the first file" through the repository picker of the host (`ctx.openPicker`); Edit evidence (BR-22
// confirmation for shared evidence); Add target and Remove target (never the last one).
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Evidence, MsId, Requirement } from '../../data/types';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Illustration } from '../../illustrations';
import { Alert, Button, EmptyState, Field, Modal, PersonPicker, RecordPicker, Select, TextInput, Textarea, UI_TEXT } from '../ui';
import { frequencyOptions, holdsInFull, peopleOf, recordKey, refFor, reloadChanged } from '../controls-edit/common';
import type { Warn } from '../controls-edit/common';
import { CodeList, FormFooter, WarningList, asApi, placeErrors, useAdapterOf } from '../controls-edit/parts';
import { adapterFor } from './adapter';
import { checkEvidence, createBodyOf, idOfTarget, patchOf, suggestCode, targetOfId, valuesOfEvidence } from './model';
import type { EvidenceAdapter, EvidenceRef, EvidenceTarget, EvidenceValues, PickedTarget } from './model';
import { targetsChanged } from './store';
import type { EvidenceRequest } from './store';
import { forgetTarget, learnTarget, targetScopeOf } from './targets';
import { CLASSIFICATIONS, TEXT } from './text';

const PATHS = {
  code: 'code', title: 'title', ownerHandle: 'owner', frequencyCode: 'frequency', classification: 'classification', targets: 'targets',
  mappingNote: 'note', reason: 'reason', ms: 'system',
} as const;
const RULES = { 'NOT-A-MEMBER': 'owner', 'LIC-FEATURE': 'others' } as const;

/** The evidence a write is for, with the uuid and ETag of the latest snapshot (D.1). */
export function evidenceRefOf(ctx: Pick<HostContext, 'D'>, ms: MsId, code: string): EvidenceRef {
  const ref = refFor(ctx.D, recordKey(ms, 'ev', code));
  return { ms, code, uuid: ref?.id ?? null, etag: ref?.etag ?? null };
}

/** Entries of a system an evidence record can serve: still applicable and in the standard. */
export function servableEntries(ctx: Pick<HostContext, 'D'>, ms: MsId): Requirement[] {
  return ((ctx.D?.bundles?.[ms]?.reqs ?? []) as (Requirement & { retired?: boolean })[]).filter((c) => c.st !== 'na' && !c.retired);
}

/** Every evidence code of the snapshot (codes are unique in the organisation). */
function allCodes(ctx: Pick<HostContext, 'D'>): string[] {
  const out = new Set<string>();
  for (const bundle of Object.values(ctx.D?.bundles ?? {})) for (const e of (bundle?.evs ?? []) as Evidence[]) out.add(e.code);
  return [...out];
}

const shortOf = (ctx: Pick<HostContext, 'D'>, ms: MsId) => ctx.D?.MS?.find((m) => m.id === ms)?.short ?? ms;
const classOptions = () => CLASSIFICATIONS.map(([value, label]) => ({ value, label }));

/** Other systems of the snapshot, for targets in another management system. */
function otherSystems(ctx: Pick<HostContext, 'D'>, ms: MsId): { value: string; label: string }[] {
  return (ctx.D?.MS ?? []).filter((m) => m.id !== ms && ctx.D?.bundles?.[m.id]).map((m) => ({ value: m.id, label: m.short }));
}

/** A created evidence record: its ref, the systems to load again, warnings and the targets of other systems refused. */
export interface Created {
  ref: EvidenceRef;
  changed: MsId[];
  warnings: Warn[];
  failures: string[];
}

/**
 * The second step of New evidence: the record exists without a file (it counts as critical until one is attached),
 * with the warnings of the create and the targets of other systems that were refused. "Choose file" opens the
 * repository picker of the host; "Later" closes.
 */
export function FirstFileStep({ ctx, created, onLater, onAttach }: { ctx: HostContext; created: Created; onLater(): void; onAttach(): void }) {
  return (
    <Modal
      open
      title={TEXT.firstFileTitle}
      onClose={onLater}
      footer={(
        <>
          <Button onClick={onLater}>{ctx.li(TEXT.attachLater)}</Button>
          <Button variant="primary" onClick={onAttach}>{ctx.li(TEXT.attachNow)}</Button>
        </>
      )}
    >
      <div className="mx-stack">
        <Alert tone="ok" role="status">{ctx.fill(TEXT.created, { code: created.ref.code })}</Alert>
        {created.failures.length ? <Alert tone="bad"><ul className="mx-m11-list">{created.failures.map((f) => <li key={f}>{f}</li>)}</ul></Alert> : null}
        <WarningList warnings={created.warnings} title={TEXT.warningsTitle} />
        <EmptyState
          title={TEXT.noFileYet}
          text={ctx.fill(TEXT.firstFileText, { code: created.ref.code })}
          illustration={<Illustration scene="no-evidence" size="sm" decorative />}
        />
      </div>
    </Modal>
  );
}

/** New evidence: the form, then the first file. */
export function NewEvidenceDialog({ ctx, ms, target, onClose }: { ctx: HostContext; ms: MsId; target?: string; onClose(): void }) {
  const formId = useId();
  const adapter = useAdapterOf(ctx, adapterFor);
  const key = useRef(newIdempotencyKey());
  const full = holdsInFull(ctx, ms, 'evidence.manage');
  const entry = target ? servableEntries(ctx, ms).find((c) => c.id === target) : undefined;
  const me = ctx.person.handle;
  const codes = allCodes(ctx);
  const [values, setValues] = useState<EvidenceValues>(() => ({
    code: suggestCode(codes),
    title: entry ? entry.title : '',
    owner: full ? (entry && entry.owner !== 'none' ? entry.owner : me) : me,
    frequency: entry?.freq ?? (frequencyOptions(ctx.D).find((o) => o.value === 'quarterly')?.value ?? frequencyOptions(ctx.D)[0]?.value ?? ''),
    classification: 'internal',
    targets: entry ? [entry.id] : [],
    others: [],
  }));
  const [otherMs, setOtherMs] = useState('');
  const [note, setNote] = useState('');
  const [local, setLocal] = useState<Record<string, TextPair>>({});
  const [created, setCreated] = useState<Created | null>(null);
  const [picking, setPicking] = useState(false);

  const mutation = useMutation<EvidenceValues, Created>(async (input) => {
    const res = await adapter.create(ms, createBodyOf(input), key.current);
    if (!res.ok) return asApi<Created>(res);
    const ref: EvidenceRef = { ms, code: input.code.trim(), uuid: res.data.ref?.id ?? null, etag: null };
    const out: Created = { ref, changed: [...res.data.changed], warnings: [...res.data.warnings], failures: [] };
    for (const other of input.others) {
      const t = targetOfId(other.id);
      const added = await adapter.addTarget(ref, { ms: other.ms, ...t, ...(note.trim() ? { mappingNote: note.trim() } : {}) }, newIdempotencyKey());
      if (added.ok) {
        out.changed.push(...added.data.changed);
        out.warnings.push(...added.data.warnings);
        const id = (added.data.data as { targetId?: string } | undefined)?.targetId ?? null;
        learnTarget(targetScopeOf(ctx), ref.code, { id, ms: other.ms, ...t });
      } else {
        out.failures.push(ctx.fill(TEXT.crossFailed, { code: other.id, system: shortOf(ctx, other.ms), reason: ctx.li(added.error.message) }));
      }
    }
    return asApi<Created>({ ok: true, data: out });
  });
  const placed = placeErrors(mutation.error, ctx.li, PATHS, RULES);
  const fieldError = (field: string) => (local[field] ? ctx.li(local[field]) : placed.fields[field] || null);
  const set = <K extends keyof EvidenceValues>(name: K) => (value: EvidenceValues[K]) => setValues((v) => ({ ...v, [name]: value }));

  const finish = async (changed: MsId[]) => {
    onClose();
    await reloadChanged(ctx, changed, ms);
  };
  // Closing after the record exists still loads the system again, so the new evidence shows.
  const close = () => (created ? void finish(created.changed) : onClose());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems = checkEvidence(values, 'new', codes);
    setLocal(problems);
    if (Object.keys(problems).length) return;
    const res = await ctx.track(mutation.submit(values));
    if (res.ok) setCreated(res.data);
  };

  const attach = async () => {
    if (!created) return;
    setPicking(true);
    const file = (created.ref.uuid || ctx.mode !== 'api') ? await ctx.openPicker({ ms, kind: 'evidence', recordId: created.ref.uuid ?? created.ref.code }) : null;
    if (!file) {
      setPicking(false);
      return;
    }
    const res = await ctx.track(adapter.attach(created.ref, file, ctx.D?.TODAY_S ?? ''));
    if (!res.ok) {
      setPicking(false);
      ctx.toast(ctx.li(res.error.message));
      return;
    }
    ctx.toast(ctx.fill(TEXT.attached, { code: created.ref.code, file: file.fileName }));
    await finish([...created.changed, ...res.data.changed]);
  };

  if (picking) return null;
  if (created) return <FirstFileStep ctx={ctx} created={created} onLater={close} onAttach={() => void attach()} />;
  const entries = servableEntries(ctx, ms).map((c) => ({ code: c.id, title: c.title }));
  const others = otherSystems(ctx, ms);
  const otherEntries = otherMs ? servableEntries(ctx, otherMs).filter((c) => !values.others.some((o) => o.ms === otherMs && o.id === c.id)).map((c) => ({ id: c.id, title: c.title })) : [];

  return (
    <Modal
      open
      title={TEXT.newTitle}
      sub={TEXT.newSub}
      onClose={onClose}
      footer={<FormFooter busy={mutation.busy} onCancel={onClose} submitLabel={TEXT.create} form={formId} />}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate>
        {placed.general ? <Alert tone="bad">{ctx.li(placed.general.message)}</Alert> : null}
        <div className="mx-m11-grid">
          <Field label={TEXT.code} hint={ctx.fill(TEXT.codeHint, { example: suggestCode(codes) })} error={fieldError('code')} required>
            <TextInput name="code" value={values.code} onChange={set('code')} maxLength={30} autoComplete="off" />
          </Field>
          <Field label={TEXT.classification} error={fieldError('classification')} required>
            <Select name="classification" value={values.classification} onChange={set('classification')} options={classOptions()} />
          </Field>
        </div>
        <Field label={TEXT.title} error={fieldError('title')} required>
          <TextInput name="title" value={values.title} onChange={set('title')} maxLength={255} />
        </Field>
        <div className="mx-m11-grid">
          <Field label={TEXT.owner} hint={full ? undefined : TEXT.ownerSelf} error={fieldError('owner')} required>
            <PersonPicker value={values.owner} onChange={set('owner')} people={peopleOf(ctx.D)} disabled={!full} />
          </Field>
          <Field label={TEXT.frequency} error={fieldError('frequency')} required>
            <Select name="frequencyCode" value={values.frequency} onChange={set('frequency')} options={frequencyOptions(ctx.D)} />
          </Field>
        </div>
        <CodeList
          label={[ctx.fill(TEXT.thisSystem, { system: shortOf(ctx, ms) }), ctx.fill(TEXT.thisSystem, { system: shortOf(ctx, ms) })]}
          value={values.targets}
          onChange={set('targets')}
          options={entries}
          empty={TEXT.noTargetsYet}
          pickLabel={TEXT.pickTarget}
          removeLabel={TEXT.removeTargetOf}
          error={fieldError('targets')}
        />
        {others.length ? (
          <fieldset className="mx-m11-set">
            <legend className="mx-label">{ctx.li(TEXT.otherSystems)}</legend>
            <span className="mx-small">{ctx.li(TEXT.otherSystemsHint)}</span>
            {values.others.length ? (
              <ul className="mx-m11-codes">
                {values.others.map((o) => (
                  <li key={`${o.ms}:${o.id}`}>
                    <span className="mx-mono mx-m11-code">{ctx.fill(TEXT.inSystem, { code: o.id, system: shortOf(ctx, o.ms) })}</span>
                    <span className="mx-m11-code-title" />
                    <Button variant="link" onClick={() => set('others')(values.others.filter((x) => x !== o))}>{ctx.fill(TEXT.removeTargetOf, { code: o.id })}</Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <Field label={TEXT.system}>
              <Select name="otherSystem" value={otherMs} onChange={setOtherMs} options={others} empty={UI_TEXT.choose} />
            </Field>
            {otherMs ? (
              <Field label={TEXT.pickTarget} error={fieldError('others')}>
                <RecordPicker value="" onChange={(id) => id && set('others')([...values.others, { ms: otherMs, id } as PickedTarget])} records={otherEntries} limit={30} />
              </Field>
            ) : null}
            {values.others.length ? (
              <Field label={TEXT.mappingNote} hint={TEXT.mappingNoteHint} error={fieldError('note')}>
                <Textarea name="mappingNote" value={note} onChange={setNote} rows={2} maxLength={1000} />
              </Field>
            ) : null}
          </fieldset>
        ) : null}
      </form>
    </Modal>
  );
}

/** Edit evidence: title, owner, frequency and classification; shared evidence asks for the BR-22 confirmation. */
export function EditEvidenceDialog({ ctx, adapter, ms, evidence, onClose }: { ctx: HostContext; adapter: EvidenceAdapter; ms: MsId; evidence: Evidence; onClose(): void }) {
  const formId = useId();
  const full = holdsInFull(ctx, ms, 'evidence.manage');
  const initial = useRef(valuesOfEvidence(evidence));
  const [values, setValues] = useState<EvidenceValues>(initial.current);
  const [local, setLocal] = useState<Record<string, TextPair>>({});
  const [confirming, setConfirming] = useState<TextPair | null>(null);
  const mutation = useMutation((input: { values: EvidenceValues; confirm: boolean }) =>
    adapter.update(evidenceRefOf(ctx, ms, evidence.code), patchOf(initial.current, input.values, input.confirm)!).then(asApi));
  const placed = placeErrors(confirming ? null : mutation.error, ctx.li, PATHS, RULES);
  const fieldError = (field: string) => (local[field] ? ctx.li(local[field]) : placed.fields[field] || null);
  const set = <K extends keyof EvidenceValues>(name: K) => (value: EvidenceValues[K]) => setValues((v) => ({ ...v, [name]: value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems = checkEvidence(values, 'edit');
    setLocal(problems);
    if (Object.keys(problems).length) return;
    if (!patchOf(initial.current, values)) {
      ctx.toast(ctx.li(TEXT.nothingChanged));
      onClose();
      return;
    }
    const res = await ctx.track(mutation.submit({ values, confirm: confirming !== null }));
    if (!res.ok) {
      if (res.status === 409 && res.error.slug === 'confirmation-required') setConfirming(res.error.message);
      return;
    }
    ctx.toast(ctx.fill(TEXT.saved, { code: evidence.code }));
    onClose();
    await reloadChanged(ctx, res.data.changed, ms);
  };
  return (
    <Modal
      open
      title={ctx.fill(TEXT.editTitle, { code: evidence.code })}
      sub={evidence.title}
      onClose={onClose}
      footer={<FormFooter busy={mutation.busy} onCancel={onClose} submitLabel={confirming ? TEXT.confirmShared : UI_TEXT.save} form={formId} />}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate>
        {placed.general ? <Alert tone="bad">{ctx.li(placed.general.message)}</Alert> : null}
        {confirming ? <Alert tone="warn" role="alert">{ctx.li(confirming)}</Alert> : null}
        <Field label={TEXT.title} error={fieldError('title')} required>
          <TextInput name="title" value={values.title} onChange={set('title')} maxLength={255} />
        </Field>
        <div className="mx-m11-grid">
          <Field label={TEXT.owner} error={fieldError('owner')} required>
            <PersonPicker value={values.owner} onChange={set('owner')} people={peopleOf(ctx.D)} disabled={!full} />
          </Field>
          <Field label={TEXT.frequency} error={fieldError('frequency')} required>
            <Select name="frequencyCode" value={values.frequency} onChange={set('frequency')} options={frequencyOptions(ctx.D)} />
          </Field>
        </div>
        <Field label={TEXT.classification} error={fieldError('classification')}>
          <Select name="classification" value={values.classification} onChange={set('classification')} options={classOptions()} empty={TEXT.keepClassification} />
        </Field>
      </form>
    </Modal>
  );
}

/** Add target: a control or requirement of this or another management system. */
export function AddTargetDialog({ ctx, adapter, ms, evidence, existing, onClose, onDone }: {
  ctx: HostContext;
  adapter: EvidenceAdapter;
  ms: MsId;
  evidence: Evidence;
  existing: readonly EvidenceTarget[];
  onClose(): void;
  onDone(): void;
}) {
  const formId = useId();
  const key = useRef(newIdempotencyKey());
  const [system, setSystem] = useState<MsId>(ms);
  const [picked, setPicked] = useState('');
  const [note, setNote] = useState('');
  const [local, setLocal] = useState<Record<string, TextPair>>({});
  const [warnings, setWarnings] = useState<Warn[] | null>(null);
  useEffect(() => setPicked(''), [system]);
  const mutation = useMutation(() => {
    const t = targetOfId(picked);
    return adapter.addTarget(evidenceRefOf(ctx, ms, evidence.code), { ms: system, ...t, ...(note.trim() ? { mappingNote: note.trim() } : {}) }, key.current).then(asApi);
  });
  const placed = placeErrors(mutation.error, ctx.li, PATHS, RULES);
  const fieldError = (field: string) => (local[field] ? ctx.li(local[field]) : placed.fields[field] || null);
  const records = servableEntries(ctx, system)
    .filter((c) => !existing.some((t) => t.ms === system && idOfTarget(t) === c.id))
    .map((c) => ({ id: c.id, title: c.title }));
  const systems = (ctx.D?.MS ?? []).filter((m) => ctx.D?.bundles?.[m.id]).map((m) => ({ value: m.id, label: m.short }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems: Record<string, TextPair> = {};
    if (!picked) problems.target = TEXT.targetRequired;
    if (note.trim().length > 1000) problems.note = TEXT.noteTooLong;
    setLocal(problems);
    if (Object.keys(problems).length) return;
    const res = await ctx.track(mutation.submit(undefined));
    if (!res.ok) return;
    const t = targetOfId(picked);
    learnTarget(targetScopeOf(ctx), evidence.code, { id: (res.data.data as { targetId?: string } | undefined)?.targetId ?? null, ms: system, ...t });
    onDone();
    await reloadChanged(ctx, res.data.changed, ms);
    if (res.data.warnings.length) {
      setWarnings(res.data.warnings);
      return;
    }
    ctx.toast(ctx.fill(TEXT.targetAdded, { target: ctx.fill(TEXT.inSystem, { code: picked, system: shortOf(ctx, system) }), code: evidence.code }));
    onClose();
  };
  return (
    <Modal
      open
      title={ctx.fill(TEXT.addTargetTitle, { code: evidence.code })}
      sub={TEXT.addTargetSub}
      onClose={onClose}
      footer={warnings !== null
        ? <Button variant="primary" onClick={onClose}>{ctx.li(UI_TEXT.close)}</Button>
        : <FormFooter busy={mutation.busy} onCancel={onClose} submitLabel={TEXT.addTarget} form={formId} />}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate>
        {warnings !== null ? <Alert tone="ok" role="status">{ctx.li(TEXT.savedWarnings)}</Alert> : null}
        <WarningList warnings={warnings ?? []} title={TEXT.warningsTitle} />
        {placed.general ? <Alert tone="bad">{ctx.li(placed.general.message)}</Alert> : null}
        <Field label={TEXT.system} error={fieldError('system')}>
          <Select name="system" value={system} onChange={setSystem} options={systems} disabled={warnings !== null} />
        </Field>
        <Field label={TEXT.target} error={fieldError('target') ?? fieldError('others')} required>
          <RecordPicker value={picked} onChange={setPicked} records={records} limit={40} disabled={warnings !== null} />
        </Field>
        {system !== ms ? (
          <Field label={TEXT.mappingNote} hint={TEXT.mappingNoteHint} error={fieldError('note')}>
            <Textarea name="mappingNote" value={note} onChange={setNote} rows={2} maxLength={1000} disabled={warnings !== null} />
          </Field>
        ) : null}
      </form>
    </Modal>
  );
}

/** Remove target: a reason, then `evidence.targets.remove` (never the last target). */
export function RemoveTargetDialog({ ctx, adapter, ms, evidence, target, onClose, onDone }: {
  ctx: HostContext;
  adapter: EvidenceAdapter;
  ms: MsId;
  evidence: Evidence;
  target: EvidenceTarget;
  onClose(): void;
  onDone(): void;
}) {
  const formId = useId();
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<TextPair | null>(null);
  const mutation = useMutation((r: string) => adapter.removeTarget(evidenceRefOf(ctx, ms, evidence.code), target, r).then(asApi));
  const placed = placeErrors(mutation.error, ctx.li, PATHS, RULES);
  const label = ctx.fill(TEXT.inSystem, { code: idOfTarget(target), system: shortOf(ctx, target.ms) });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = reason.trim().length;
    const problem = n < 1 || n > 500 ? TEXT.reasonRequired : null;
    setLocal(problem);
    if (problem) return;
    const res = await ctx.track(mutation.submit(reason.trim()));
    if (!res.ok) return;
    forgetTarget(targetScopeOf(ctx), evidence.code, target);
    onDone();
    ctx.toast(ctx.fill(TEXT.targetRemoved, { target: label, code: evidence.code }));
    onClose();
    await reloadChanged(ctx, res.data.changed, ms);
  };
  return (
    <Modal
      open
      title={ctx.fill(TEXT.removeTitle, { target: label, code: evidence.code })}
      sub={evidence.title}
      onClose={onClose}
      footer={<FormFooter busy={mutation.busy} onCancel={onClose} submitLabel={TEXT.removeTarget} form={formId} danger />}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate>
        <p className="mx-muted" style={{ margin: 0 }}>{ctx.li(TEXT.removeText)}</p>
        {placed.general ? <Alert tone="bad">{ctx.li(placed.general.message)}</Alert> : null}
        <Field label={TEXT.reason} error={local ? ctx.li(local) : placed.fields.reason || null} required>
          <Textarea name="reason" value={reason} onChange={setReason} rows={3} maxLength={500} />
        </Field>
      </form>
    </Modal>
  );
}

/** The evidence form a layer request asked for (Edit, Add target, Remove target), with an adapter of its own. */
export function EvidenceForms({ ctx, request, onClose }: {
  ctx: HostContext;
  request: Extract<EvidenceRequest, { kind: 'edit' | 'addTarget' | 'removeTarget' }>;
  onClose(): void;
}) {
  const adapter = useAdapterOf(ctx, adapterFor);
  const props = { ctx, adapter, ms: request.ms, evidence: request.evidence, onClose };
  if (request.kind === 'edit') return <EditEvidenceDialog {...props} />;
  if (request.kind === 'addTarget') return <AddTargetDialog {...props} existing={request.existing} onDone={targetsChanged} />;
  return <RemoveTargetDialog {...props} target={request.target} onDone={targetsChanged} />;
}
