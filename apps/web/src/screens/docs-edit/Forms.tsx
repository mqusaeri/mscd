// The forms of document control (MILESTONE-2 M2-12), rendered by the layer item of actions.ts for the open request of
// store.ts: New document (a drawer), the review panel (Approve, Return to draft; the next version of a draft), Edit,
// Change owner or approver, Reassign and the new version with its change summary (modals over the document detail).
// Every form keeps its values and shows the server's field errors on failure (useMutation, C.6); a change to a shared
// document asks for the BR-22 confirmation and is sent again with `confirm`.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import { useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import {
  Alert, Badge, Button, Checkbox, ConfirmDialog, DateInput, Drawer, Facts, Field, Modal, PersonPicker, Radio, Select, TextInput, Textarea, UI_TEXT,
} from '../ui';
import { useDocsAdapter } from './adapter';
import { VERSION_STATUS, openStoredFile, startUpload } from './DocPanel';
import {
  approvalAuthorOf, asApi, br16Conflicts, chainItemOf, checkNew, docKey, docOf, hasVersion, holdsInFull, inReviewOf, mayActOn, meOf, needsConfirmation, peopleOf,
  personName, returnedOf, showDay,
} from './model';
import type { DocRecord, DocsAdapter, DocumentChange, NewDocumentInput, Outcome, TemplateOption, VersionRow } from './model';
import { closeForm } from './store';
import type { DocsRequest } from './store';
import { CLASSIFICATIONS, DOC_TYPES, TEXT } from './text';

/** The toast of a successful write: its own text, the server's message when there is one, and the warnings. */
export function doneText(ctx: HostContext, text: string, outcome: Outcome | null): string {
  const parts = [outcome?.message ? ctx.li(outcome.message) : text];
  for (const w of outcome?.warnings ?? []) parts.push(ctx.li(w.message));
  return parts.join(' ');
}

/** Loads the systems a write changed again (D2-08), the current one when the answer names none. */
async function reloadAfter(ctx: HostContext, outcome: Outcome, ms: MsId): Promise<void> {
  const ids = [...new Set(outcome.changed.length ? outcome.changed : [ms])];
  await ctx.reload(ids);
}

const shortOf = (ctx: HostContext, ms: MsId) => ctx.D?.MS?.find((m) => m.id === ms)?.short ?? ms;
const typeOptions = () => DOC_TYPES.map((t) => ({ value: t.value, label: t.label }));
const classOptions = () => CLASSIFICATIONS.map((c) => ({ value: c.value, label: c.label }));

/** The error of a form: its own check, else the server's message for the field, else nothing. */
function errorFor(own: TextPair | undefined, fields: Record<string, string>, ...paths: string[]): TextPair | string | null {
  if (own) return own;
  for (const p of paths) if (fields[p]) return fields[p];
  return null;
}

/** The versions of a document, read when a form opens (submitter of the version in review, BR-16). */
function useVersions(adapter: DocsAdapter, ms: MsId, code: string, wanted: boolean): { rows: VersionRow[] | null; loading: boolean } {
  const [state, setState] = useState<{ rows: VersionRow[] | null; loading: boolean }>({ rows: null, loading: wanted });
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    void adapter.versions(ms, code).then((res) => {
      if (live) setState({ rows: res.ok ? res.data : null, loading: false });
    });
    return () => {
      live = false;
    };
  }, [adapter, ms, code, wanted]);
  return state;
}

function Footer({ ctx, onClose, children }: { ctx: HostContext; onClose(): void; children?: ReactNode }) {
  return (
    <>
      <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
      {children}
    </>
  );
}

function GeneralError({ ctx, error }: { ctx: HostContext; error: ApiError | null }) {
  if (!error) return null;
  return <Alert tone="bad">{ctx.li(error.message)}</Alert>;
}

// ---------------------------------------------------------------------------------------------------------------
// New document
// ---------------------------------------------------------------------------------------------------------------

/** The fields of a server error that belong to a field of New document; anything else is shown above the form. */
const NEW_FIELDS = ['docCode', 'title', 'docType', 'ownerHandle', 'approverHandle', 'nextReviewAt', 'classification', 'linkedMs', 'origin', 'externalSource', 'externalRef', 'receivedAt'];

export function NewDocumentForm({ ctx, request }: { ctx: HostContext; request: Extract<DocsRequest, { type: 'new' }> }) {
  const ms = request.ms;
  const adapter = useDocsAdapter(ctx);
  const formId = useId();
  const people = useMemo(() => peopleOf(ctx.D), [ctx.D]);
  const systems = (ctx.D?.MS ?? []).filter((m) => m.id === ms || holdsInFull(ctx, m.id, 'document.manage'));
  const prefill = request.prefill ?? {};
  const [values, setValues] = useState<NewDocumentInput>(() => ({
    docCode: prefill.docCode ?? '',
    title: prefill.title ?? '',
    docType: prefill.docType ?? '',
    ownerHandle: '',
    approverHandle: ctx.D?.MS?.find((m) => m.id === ms)?.approver ?? '',
    nextReviewAt: '',
    classification: 'internal',
    orgWide: false,
    linkedMs: [ms],
    origin: 'internal',
    externalSource: '',
    externalRef: '',
    receivedAt: '',
  }));
  const [template, setTemplate] = useState(prefill.docCode ?? '');
  const [templates, setTemplates] = useState<{ loading: boolean; options: TemplateOption[] }>({ loading: true, options: [] });
  const [own, setOwn] = useState<Record<string, TextPair>>({});
  const mutation = useMutation((input: NewDocumentInput) => asApi(adapter.create(ms, input)));
  useEffect(() => {
    let live = true;
    void adapter.templates(ms).then((res) => {
      if (live) setTemplates({ loading: false, options: res.ok ? res.data : [] });
    });
    return () => {
      live = false;
    };
  }, [adapter, ms]);
  const set = <K extends keyof NewDocumentInput>(key: K, value: NewDocumentInput[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setOwn((o) => {
      if (!(key in o)) return o;
      const next = { ...o };
      delete next[key as string];
      return next;
    });
  };
  const pickTemplate = (code: string) => {
    setTemplate(code);
    const t = templates.options.find((o) => o.code === code);
    if (!t) return;
    setValues((v) => ({ ...v, docCode: t.code, title: t.title || v.title, docType: t.docType || v.docType }));
    setOwn({});
  };
  const fields = mutation.fields;
  const generalError = mutation.error && !NEW_FIELDS.some((f) => fields[f]) && !(mutation.error.status === 409 && mutation.error.slug === 'conflict') ? mutation.error : null;
  const codeServer = mutation.error?.status === 409 && mutation.error.slug === 'conflict' ? mutation.error.message : null;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const problems = checkNew(values);
    const mapped: Record<string, TextPair> = {};
    for (const [k, v] of Object.entries(problems)) mapped[k] = TEXT[v];
    setOwn(mapped);
    if (Object.keys(mapped).length) return;
    void ctx.track(mutation.submit(values)).then(async (res) => {
      if (!res.ok) return;
      const code = values.docCode.trim();
      await reloadAfter(ctx, res.data, ms);
      closeForm();
      ctx.toast(doneText(ctx, ctx.fill(ctx.screen === 'docs' ? TEXT.registered : TEXT.registeredNext, { code }), res.data));
      request.onDone?.(res.data, code);
      if (ctx.screen === 'docs') {
        const key = docKey(ms, code);
        ctx.go('docs', { ms, sel: key, expanded: { [key]: true } });
      }
    });
  };
  const toggleSystem = (id: MsId, on: boolean) => set('linkedMs', on ? [...new Set([...values.linkedMs, id])] : values.linkedMs.filter((x) => x !== id || x === ms));
  return (
    <Drawer
      open
      title={TEXT.newTitle}
      crumb={ctx.fill(TEXT.newCrumb, { system: shortOf(ctx, ms) })}
      onClose={closeForm}
      footer={(
        <Footer ctx={ctx} onClose={closeForm}>
          <Button variant="primary" type="submit" form={formId} busy={mutation.busy}>{ctx.li(TEXT.register)}</Button>
        </Footer>
      )}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate data-docs-form="new">
        <GeneralError ctx={ctx} error={generalError} />
        <Field label={TEXT.template} hint={templates.loading ? TEXT.templatesLoading : TEXT.templateHint}>
          <Select
            value={template}
            onChange={pickTemplate}
            empty={TEXT.templateNone}
            options={templates.options.map((t) => ({
              value: t.code,
              label: t.title ? `${t.code}, ${t.title}` : t.activity ? ctx.fill(TEXT.templateOutput, { code: t.code, no: t.activity.no, title: t.activity.title }) : t.code,
            }))}
          />
        </Field>
        <div className="mx-de-grid">
          <Field label={TEXT.code} hint={TEXT.codeHint} required error={codeServer ?? errorFor(own.docCode, fields, 'docCode')}>
            <TextInput value={values.docCode} onChange={(v) => set('docCode', v)} maxLength={30} autoComplete="off" />
          </Field>
          <Field label={TEXT.docType} required error={errorFor(own.docType, fields, 'docType')}>
            <Select value={values.docType} onChange={(v) => set('docType', v)} options={typeOptions()} empty={UI_TEXT.choose} />
          </Field>
        </div>
        <Field label={TEXT.title} required error={errorFor(own.title, fields, 'title')}>
          <TextInput value={values.title} onChange={(v) => set('title', v)} maxLength={255} />
        </Field>
        <div className="mx-de-grid">
          <Field label={TEXT.owner} hint={TEXT.ownerHint} required error={errorFor(own.ownerHandle, fields, 'ownerHandle')}>
            <PersonPicker value={values.ownerHandle} onChange={(v) => set('ownerHandle', v)} people={people} />
          </Field>
          <Field label={TEXT.approver} hint={TEXT.approverHint} error={errorFor(undefined, fields, 'approverHandle')}>
            <PersonPicker value={values.approverHandle ?? ''} onChange={(v) => set('approverHandle', v)} people={people} allowNone />
          </Field>
        </div>
        {values.ownerHandle && values.approverHandle && values.ownerHandle === values.approverHandle ? (
          <p className="mx-de-warn" role="status" data-rule="BR-16">{ctx.li(TEXT.br16Same)}</p>
        ) : null}
        <div className="mx-de-grid">
          <Field label={TEXT.classification} required error={errorFor(own.classification, fields, 'classification')}>
            <Select value={values.classification} onChange={(v) => set('classification', v)} options={classOptions()} />
          </Field>
          <Field label={TEXT.nextReview} hint={TEXT.nextReviewHint} error={errorFor(undefined, fields, 'nextReviewAt')}>
            <DateInput value={values.nextReviewAt ?? ''} onChange={(v) => set('nextReviewAt', v)} />
          </Field>
        </div>
        <div className="mx-field">
          <Checkbox checked={values.orgWide} onChange={(v) => set('orgWide', v)} label={TEXT.orgWide} />
          <span className="mx-hint">{ctx.li(TEXT.orgWideHint)}</span>
        </div>
        {systems.length > 1 ? (
          <fieldset className="mx-de-set">
            <legend className="mx-label">{ctx.li(TEXT.linkedSystems)}</legend>
            {systems.map((m) => (
              <Checkbox
                key={m.id}
                checked={values.linkedMs.includes(m.id)}
                disabled={m.id === ms}
                onChange={(on) => toggleSystem(m.id, on)}
                label={m.id === ms ? ctx.fill(TEXT.thisSystem, { system: m.short }) : `${m.short}, ${m.code}`}
              />
            ))}
            <span className="mx-hint">{ctx.li(TEXT.linkedHint)}</span>
            {fields.linkedMs ? <span className="mx-error" role="alert">{fields.linkedMs}</span> : null}
          </fieldset>
        ) : null}
        <Radio
          legend={TEXT.origin}
          name={`${formId}-origin`}
          value={values.origin}
          onChange={(v) => set('origin', v === 'external' ? 'external' : 'internal')}
          options={[{ value: 'internal', label: TEXT.originInternal }, { value: 'external', label: TEXT.originExternal }]}
        />
        {values.origin === 'external' ? (
          <>
            <Field label={TEXT.externalSource} hint={TEXT.externalSourceHint} required error={errorFor(own.externalSource, fields, 'externalSource')}>
              <TextInput value={values.externalSource ?? ''} onChange={(v) => set('externalSource', v)} maxLength={200} />
            </Field>
            <div className="mx-de-grid">
              <Field label={TEXT.externalRef} hint={TEXT.externalRefHint} error={errorFor(undefined, fields, 'externalRef')}>
                <TextInput value={values.externalRef ?? ''} onChange={(v) => set('externalRef', v)} maxLength={120} />
              </Field>
              <Field label={TEXT.receivedAt} error={errorFor(undefined, fields, 'receivedAt')}>
                <DateInput value={values.receivedAt ?? ''} onChange={(v) => set('receivedAt', v)} />
              </Field>
            </div>
          </>
        ) : null}
      </form>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Changes of a document with the BR-22 confirmation
// ---------------------------------------------------------------------------------------------------------------

/** Sends a document change; a shared document asks first (409 BR-22) and is sent again with `confirm`. */
function useConfirmedChange(ctx: HostContext, adapter: DocsAdapter, ms: MsId, code: string, onSaved: (outcome: Outcome) => void) {
  const [question, setQuestion] = useState<ApiError | null>(null);
  const pending = useRef<DocumentChange | null>(null);
  const mutation = useMutation((input: { change: DocumentChange; confirm: boolean }) => asApi(adapter.update(ms, code, input.change, input.confirm)));
  const send = (change: DocumentChange, confirm: boolean) => {
    pending.current = change;
    void ctx.track(mutation.submit({ change, confirm })).then(async (res) => {
      if (res.ok) {
        setQuestion(null);
        await reloadAfter(ctx, res.data, ms);
        onSaved(res.data);
        return;
      }
      if (!confirm && needsConfirmation(res.error)) {
        setQuestion(res.error);
        mutation.reset();
      } else setQuestion(null);
    });
  };
  const dialog = (
    <ConfirmDialog
      open={Boolean(question)}
      title={TEXT.confirmShared}
      body={question ? ctx.li(question.message) : ''}
      confirmLabel={TEXT.confirmApply}
      busy={mutation.busy}
      onConfirm={() => pending.current && send(pending.current, true)}
      onCancel={() => setQuestion(null)}
    />
  );
  return { send, mutation, dialog };
}

/** The members of an edit that differ from the document (title, review date, classification, origin, external facts). */
export function editChange(doc: DocRecord, v: { title: string; classification: string; nextReviewAt: string; origin: 'internal' | 'external'; externalSource: string; externalRef: string; receivedAt: string }): DocumentChange {
  const change: DocumentChange = {};
  if (v.title.trim() && v.title.trim() !== doc.title) change.title = v.title.trim();
  if (v.classification) change.classification = v.classification;
  if ((v.nextReviewAt || '') !== (doc.rev || '')) change.nextReviewAt = v.nextReviewAt || null;
  const before = doc.origin === 'external' ? 'external' : 'internal';
  if (v.origin !== before) change.origin = v.origin;
  if (v.origin === 'external') {
    if (v.externalSource.trim()) change.externalSource = v.externalSource.trim();
    if (v.externalRef.trim()) change.externalRef = v.externalRef.trim();
    if (v.receivedAt) change.receivedAt = v.receivedAt;
  }
  return change;
}

export function EditForm({ ctx, ms, doc, onClose }: { ctx: HostContext; ms: MsId; doc: DocRecord; onClose(): void }) {
  const adapter = useDocsAdapter(ctx);
  const formId = useId();
  const [values, setValues] = useState(() => ({
    title: doc.title,
    classification: '',
    nextReviewAt: doc.rev || '',
    origin: (doc.origin === 'external' ? 'external' : 'internal') as 'internal' | 'external',
    externalSource: '',
    externalRef: '',
    receivedAt: '',
  }));
  const [own, setOwn] = useState<Record<string, TextPair>>({});
  const { send, mutation, dialog } = useConfirmedChange(ctx, adapter, ms, doc.id, (outcome) => {
    onClose();
    ctx.toast(doneText(ctx, ctx.fill(TEXT.saved, { code: doc.id }), outcome));
  });
  const set = (key: keyof typeof values, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setOwn({});
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const problems: Record<string, TextPair> = {};
    if (!values.title.trim()) problems.title = TEXT.required;
    if (values.origin === 'external' && doc.origin !== 'external' && !values.externalSource.trim()) problems.externalSource = TEXT.sourceRequired;
    const change = editChange(doc, values);
    if (!Object.keys(problems).length && !Object.keys(change).length) problems[''] = TEXT.nothingChanged;
    setOwn(problems);
    if (Object.keys(problems).length) return;
    send(change, false);
  };
  const fields = mutation.fields;
  return (
    <Modal
      open
      title={ctx.fill(TEXT.editTitle, { code: doc.id })}
      sub={doc.title}
      onClose={onClose}
      footer={(
        <Footer ctx={ctx} onClose={onClose}>
          <Button variant="primary" type="submit" form={formId} busy={mutation.busy}>{ctx.li(UI_TEXT.save)}</Button>
        </Footer>
      )}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate data-docs-form="edit">
        {own[''] ? <Alert tone="info">{ctx.li(own[''])}</Alert> : null}
        <GeneralError ctx={ctx} error={mutation.error && !Object.keys(fields).length ? mutation.error : null} />
        <Field label={TEXT.title} required error={errorFor(own.title, fields, 'title')}>
          <TextInput value={values.title} onChange={(v) => set('title', v)} maxLength={255} />
        </Field>
        <div className="mx-de-grid">
          <Field label={TEXT.classification} error={errorFor(undefined, fields, 'classification')}>
            <Select value={values.classification} onChange={(v) => set('classification', v)} options={classOptions()} empty={TEXT.classificationKeep} />
          </Field>
          <Field label={TEXT.nextReview} error={errorFor(undefined, fields, 'nextReviewAt')}>
            <DateInput value={values.nextReviewAt} onChange={(v) => set('nextReviewAt', v)} />
          </Field>
        </div>
        <Radio
          legend={TEXT.origin}
          name={`${formId}-origin`}
          value={values.origin}
          onChange={(v) => set('origin', v === 'external' ? 'external' : 'internal')}
          options={[{ value: 'internal', label: TEXT.originInternal }, { value: 'external', label: TEXT.originExternal }]}
        />
        {values.origin === 'external' ? (
          <>
            {doc.origin === 'external' ? <p className="mx-de-text">{ctx.li(TEXT.externalKeep)}</p> : null}
            <Field label={TEXT.externalSource} hint={TEXT.externalSourceHint} required={doc.origin !== 'external'} error={errorFor(own.externalSource, fields, 'externalSource')}>
              <TextInput value={values.externalSource} onChange={(v) => set('externalSource', v)} maxLength={200} />
            </Field>
            <div className="mx-de-grid">
              <Field label={TEXT.externalRef} error={errorFor(undefined, fields, 'externalRef')}>
                <TextInput value={values.externalRef} onChange={(v) => set('externalRef', v)} maxLength={120} />
              </Field>
              <Field label={TEXT.receivedAt} error={errorFor(undefined, fields, 'receivedAt')}>
                <DateInput value={values.receivedAt} onChange={(v) => set('receivedAt', v)} />
              </Field>
            </div>
          </>
        ) : null}
      </form>
      {dialog}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Owner and approver
// ---------------------------------------------------------------------------------------------------------------

export function OwnerForm({ ctx, ms, doc, onClose }: { ctx: HostContext; ms: MsId; doc: DocRecord; onClose(): void }) {
  const adapter = useDocsAdapter(ctx);
  const formId = useId();
  const people = useMemo(() => peopleOf(ctx.D), [ctx.D]);
  // The sample snapshot leaves the approver out when it is the system's default approver, which the detail shows.
  const startApprover = doc.approver ?? (ctx.mode === 'sample' ? ctx.D?.MS?.find((m) => m.id === ms)?.approver ?? '' : '');
  const [owner, setOwner] = useState(doc.owner && doc.owner !== 'none' ? doc.owner : '');
  const [approver, setApprover] = useState(startApprover);
  const [own, setOwn] = useState<TextPair | null>(null);
  const versions = useVersions(adapter, ms, doc.id, doc.st === 'review');
  const submitter = inReviewOf(versions.rows)?.submittedBy ?? null;
  const conflicts = br16Conflicts(owner, approver, submitter);
  const { send, mutation, dialog } = useConfirmedChange(ctx, adapter, ms, doc.id, (outcome) => {
    onClose();
    ctx.toast(doneText(ctx, ctx.fill(TEXT.saved, { code: doc.id }), outcome));
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!owner) return setOwn(TEXT.required);
    const change: DocumentChange = {};
    if (owner !== doc.owner) change.ownerHandle = owner;
    if (approver !== startApprover) change.approverHandle = approver || null;
    if (!Object.keys(change).length) return setOwn(TEXT.nothingChanged);
    setOwn(null);
    send(change, false);
  };
  const fields = mutation.fields;
  return (
    <Modal
      open
      title={ctx.fill(TEXT.ownerTitle, { code: doc.id })}
      sub={doc.title}
      onClose={onClose}
      footer={(
        <Footer ctx={ctx} onClose={onClose}>
          <Button variant="primary" type="submit" form={formId} busy={mutation.busy}>{ctx.li(UI_TEXT.save)}</Button>
        </Footer>
      )}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate data-docs-form="owner">
        <GeneralError ctx={ctx} error={mutation.error && !fields.ownerHandle && !fields.approverHandle ? mutation.error : null} />
        {own === TEXT.nothingChanged ? <Alert tone="info">{ctx.li(own)}</Alert> : null}
        <Field label={TEXT.owner} hint={TEXT.ownerHint} required error={own === TEXT.required ? own : errorFor(undefined, fields, 'ownerHandle')}>
          <PersonPicker value={owner} onChange={(v) => { setOwner(v); setOwn(null); }} people={people} />
        </Field>
        <Field label={TEXT.approver} hint={TEXT.approverHint} error={errorFor(undefined, fields, 'approverHandle')}>
          <PersonPicker value={approver} onChange={(v) => { setApprover(v); setOwn(null); }} people={people} allowNone />
        </Field>
        {conflicts.includes('same') ? <p className="mx-de-warn" role="status" data-rule="BR-16">{ctx.li(TEXT.br16Same)}</p> : null}
        {conflicts.includes('submitter') ? (
          <p className="mx-de-warn" role="status" data-rule="BR-16">{ctx.fill(TEXT.br16Submitter, { name: personName(ctx.D, submitter) })}</p>
        ) : null}
      </form>
      {dialog}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Reassign the person who acts on a document in review
// ---------------------------------------------------------------------------------------------------------------

export function ReassignForm({ ctx, ms, doc, onClose }: { ctx: HostContext; ms: MsId; doc: DocRecord; onClose(): void }) {
  const adapter = useDocsAdapter(ctx);
  const formId = useId();
  const people = useMemo(() => peopleOf(ctx.D), [ctx.D]);
  const item = chainItemOf(ctx.D, ms, doc.id);
  const start = item?.h && item.h !== 'none' ? item.h : '';
  const [holder, setHolder] = useState(start);
  const [due, setDue] = useState(item?.due ?? '');
  const [tried, setTried] = useState(false);
  const versions = useVersions(adapter, ms, doc.id, true);
  const submitter = inReviewOf(versions.rows)?.submittedBy ?? null;
  const mutation = useMutation((input: { holder: string; due: string | null }) => asApi(adapter.assign(ms, doc.id, input.holder, input.due)));
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setTried(true);
    if (!holder || holder === 'none') return;
    void ctx.track(mutation.submit({ holder, due: due || null })).then(async (res) => {
      if (!res.ok) return;
      await reloadAfter(ctx, res.data, ms);
      onClose();
      ctx.toast(doneText(ctx, ctx.fill(TEXT.reassigned, { code: doc.id, name: personName(ctx.D, holder) }), { ...res.data, message: undefined }));
    });
  };
  const fields = mutation.fields;
  const unassigned = tried && (!holder || holder === 'none');
  return (
    <Modal
      open
      title={ctx.fill(TEXT.reassignTitle, { code: doc.id })}
      sub={TEXT.reassignSub}
      onClose={onClose}
      footer={(
        <Footer ctx={ctx} onClose={onClose}>
          <Button variant="primary" type="submit" form={formId} busy={mutation.busy}>{ctx.li(UI_TEXT.save)}</Button>
        </Footer>
      )}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate data-docs-form="reassign">
        <GeneralError ctx={ctx} error={mutation.error && !fields.holder && !fields.dueAt ? mutation.error : null} />
        <Field label={TEXT.holder} required error={unassigned ? TEXT.br17 : errorFor(undefined, fields, 'holder')}>
          <PersonPicker value={holder} onChange={(v) => { setHolder(v); setTried(false); }} people={people} allowNone />
        </Field>
        {!holder || holder === 'none' ? <p className="mx-de-text" data-rule="BR-17">{ctx.li(TEXT.br17)}</p> : null}
        {holder && submitter && holder === submitter ? (
          <p className="mx-de-warn" role="status" data-rule="BR-16">{ctx.fill(TEXT.br16Submitter, { name: personName(ctx.D, submitter) })}</p>
        ) : null}
        <Field label={TEXT.due} hint={TEXT.dueHint} error={errorFor(undefined, fields, 'dueAt')}>
          <DateInput value={due} onChange={setDue} />
        </Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// A new version with its change summary
// ---------------------------------------------------------------------------------------------------------------

export function UploadForm({ ctx, request, doc, onClose }: { ctx: HostContext; request: Extract<DocsRequest, { type: 'upload' }>; doc: DocRecord; onClose(): void }) {
  const adapter = useDocsAdapter(ctx);
  const formId = useId();
  const [summary, setSummary] = useState('');
  const [own, setOwn] = useState<TextPair | null>(null);
  const mutation = useMutation((input: string) => asApi(adapter.addVersion(request.ms, doc.id, request.file, input)));
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (summary.trim().length > 500) return setOwn(TEXT.summaryLong);
    setOwn(null);
    void ctx.track(mutation.submit(summary)).then(async (res) => {
      if (!res.ok) return;
      await reloadAfter(ctx, res.data, request.ms);
      onClose();
      ctx.toast(doneText(ctx, ctx.fill(TEXT.submitted, { code: doc.id }), res.data));
    });
  };
  const fields = mutation.fields;
  return (
    <Modal
      open
      title={ctx.fill(request.first ? TEXT.firstTitle : TEXT.uploadTitle, { code: doc.id })}
      sub={doc.title}
      onClose={onClose}
      footer={(
        <Footer ctx={ctx} onClose={onClose}>
          <Button variant="primary" type="submit" form={formId} busy={mutation.busy}>{ctx.li(TEXT.submitReview)}</Button>
        </Footer>
      )}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate data-docs-form="upload">
        <GeneralError ctx={ctx} error={mutation.error && !fields.changeSummary ? mutation.error : null} />
        <Facts items={[{ label: TEXT.file, value: request.file.fileName }]} />
        <Field label={TEXT.changeSummary} hint={TEXT.summaryHint} error={errorFor(own ?? undefined, fields, 'changeSummary')}>
          <Textarea value={summary} onChange={(v) => { setSummary(v); setOwn(null); }} rows={4} maxLength={500} />
        </Field>
        <p className="mx-de-text">{ctx.li(TEXT.uploadNote)}</p>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The review panel
// ---------------------------------------------------------------------------------------------------------------

/** Why Approve is not available to the session: the author of the version, or no approval right; null when it is. */
export function approveBlock(ctx: HostContext, ms: MsId, submitter: string | null): TextPair | null {
  if (submitter && submitter === meOf(ctx)) return TEXT.youSubmitted;
  if (!holdsInFull(ctx, ms, 'document.approve')) return TEXT.noApproveRight;
  return null;
}

export function ReviewPanel({ ctx, ms, doc, onClose }: { ctx: HostContext; ms: MsId; doc: DocRecord; onClose(): void }) {
  const adapter = useDocsAdapter(ctx);
  const versions = useVersions(adapter, ms, doc.id, true);
  const [step, setStep] = useState<'review' | 'return'>('review');
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<TextPair | null>(null);
  const mutation = useMutation((input: { to: 'approved' | 'draft'; note?: string }) => asApi(adapter.transition(ms, doc.id, input.to, input.note)));
  const pending = inReviewOf(versions.rows);
  const returned = returnedOf(versions.rows);
  const review = doc.st === 'review';
  const decide = (to: 'approved' | 'draft') => {
    if (to === 'draft' && !note.trim()) return setNoteError(TEXT.noteRequired);
    setNoteError(null);
    void ctx.track(mutation.submit(to === 'draft' ? { to, note: note.trim() } : { to })).then(async (res) => {
      if (!res.ok) return;
      await reloadAfter(ctx, res.data, ms);
      onClose();
      const text = to === 'draft'
        ? ctx.fill(TEXT.returned, { code: doc.id })
        : pending ? ctx.fill(TEXT.approvedVersion, { code: doc.id, label: pending.label }) : ctx.fill(TEXT.approved, { code: doc.id });
      ctx.toast(doneText(ctx, text, { ...res.data, message: undefined }));
    });
  };
  // BR-16: without a version in review the server checks the author of the version in force, so Approve does too.
  const block = approveBlock(ctx, ms, approvalAuthorOf(versions.rows));
  const canReturn = holdsInFull(ctx, ms, 'document.approve');
  const canVersion = mayActOn(ctx, ms, 'document.version.create', doc.owner);
  // The label follows the version in force, as the detail's own button does; the text follows the versions sent so far.
  const first = !hasVersion(doc);
  const noFileYet = first && !(versions.rows ?? []).length;
  const status = pending ? VERSION_STATUS[pending.status] : null;
  let body: ReactNode;
  let footer: ReactNode;
  if (review) {
    body = (
      <>
        <GeneralError ctx={ctx} error={mutation.error && !mutation.fields.note ? mutation.error : null} />
        {versions.loading ? <div className="mx-small" role="status">{ctx.li(TEXT.versionsLoading)}</div> : pending ? (
          <>
            <Facts
              items={[
                { label: TEXT.inReviewVersion, value: <span className="mx-row"><span className="mx-mono">v{pending.label}</span>{status ? <Badge tone={status.tone}>{ctx.li(status.label)}</Badge> : null}</span> },
                { label: TEXT.submittedByL, value: personName(ctx.D, pending.submittedBy) },
                { label: TEXT.submittedAtL, value: showDay(ctx, pending.submittedAt) },
                { label: TEXT.changeSummary, value: pending.changeSummary ?? '-' },
              ]}
            />
            {pending.storageObjectId && ctx.can(ms, 'storage.object.read') ? (
              <div><Button onClick={() => openStoredFile(ctx, adapter, ms, pending.storageObjectId!)}>{ctx.li(TEXT.openFile)}</Button></div>
            ) : null}
          </>
        ) : (
          <Alert tone="info">{ctx.li(TEXT.noNewFile)}</Alert>
        )}
        {step === 'return' ? (
          <Field label={TEXT.returnNote} hint={TEXT.returnNoteHint} required error={noteError ?? (mutation.fields.note || null)}>
            <Textarea value={note} onChange={(v) => { setNote(v); setNoteError(null); }} rows={4} maxLength={1000} />
          </Field>
        ) : null}
      </>
    );
    footer = step === 'return' ? (
      <>
        <Button onClick={() => { setStep('review'); setNoteError(null); }}>{ctx.li(TEXT.back)}</Button>
        <Button variant="danger" busy={mutation.busy} onClick={() => decide('draft')}>{ctx.li(TEXT.returnDraft)}</Button>
      </>
    ) : (
      <>
        <Button onClick={onClose}>{ctx.li(UI_TEXT.close)}</Button>
        {canReturn ? <Button onClick={() => setStep('return')} disabled={mutation.busy}>{ctx.li(TEXT.returnDraft)}</Button> : null}
        <Button variant="primary" busy={mutation.busy} disabledReason={versions.loading ? null : block} disabled={versions.loading} onClick={() => decide('approved')}>
          {ctx.li(TEXT.approve)}
        </Button>
      </>
    );
  } else if (doc.st === 'draft') {
    body = (
      <>
        {returned ? (
          <Alert tone="warn" title={TEXT.rejectionNote}>
            <div>{ctx.fill(TEXT.returnedOn, { label: returned.label, date: showDay(ctx, returned.submittedAt) })}</div>
            {returned.rejectionNote ? <p className="mx-de-quote" style={{ marginTop: 8 }}>{returned.rejectionNote}</p> : null}
          </Alert>
        ) : null}
        <p className="mx-de-text">{ctx.li(noFileYet ? TEXT.draftNoFile : TEXT.draftWithFile)}</p>
        {!canVersion ? <p className="mx-de-text">{ctx.li(TEXT.noVersionRight)}</p> : null}
      </>
    );
    footer = (
      <>
        <Button onClick={onClose}>{ctx.li(UI_TEXT.close)}</Button>
        {canVersion ? (
          <Button variant="primary" onClick={() => { onClose(); startUpload(ctx, adapter, ms, doc.id, first); }}>
            {ctx.li(first ? TEXT.attachFirst : TEXT.uploadNew)}
          </Button>
        ) : null}
      </>
    );
  } else {
    body = <Alert tone="info">{ctx.li(TEXT.notInReview)}</Alert>;
    footer = <Button onClick={onClose}>{ctx.li(UI_TEXT.close)}</Button>;
  }
  return (
    <Modal open title={ctx.fill(review ? TEXT.reviewTitle : TEXT.draftTitle, { code: doc.id })} sub={doc.title} onClose={onClose} footer={footer}>
      <div className="mx-stack" data-docs-form="review">{body}</div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The open form
// ---------------------------------------------------------------------------------------------------------------

export default function Forms({ ctx, request }: { ctx: HostContext; request: DocsRequest }) {
  if (request.type === 'new') return <NewDocumentForm ctx={ctx} request={request} />;
  const doc = docOf(ctx.D, request.ms, request.code);
  if (!doc) {
    return (
      <Modal open title={request.code} onClose={closeForm} footer={<Button onClick={closeForm}>{ctx.li(UI_TEXT.close)}</Button>}>
        <Alert tone="warn">{ctx.li(TEXT.gone)}</Alert>
      </Modal>
    );
  }
  const props = { ctx, ms: request.ms, doc, onClose: closeForm };
  if (request.type === 'review') return <ReviewPanel {...props} />;
  if (request.type === 'edit') return <EditForm {...props} />;
  if (request.type === 'owner') return <OwnerForm {...props} />;
  if (request.type === 'reassign') return <ReassignForm {...props} />;
  return <UploadForm ctx={ctx} request={request} doc={doc} onClose={closeForm} />;
}

