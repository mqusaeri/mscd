// Dialogs of the Internal audit screen (MILESTONE-2 M2-14): "Plan internal audit", "Edit activity" (auditor, clause or
// control, planned date, auditee, status and note; the key questions and evidence to request of the template are
// shown), "Attach report" (a registered record, or a new record from a file) and "Record outcome summary".
import { useEffect, useState } from 'react';
import type { MsId } from '../../data/types';
import { newIdempotencyKey, useMutation } from '../api';
import type { TargetOption } from '../findings/model';
import { FormError } from '../findings/parts';
import type { Outcome } from '../findings/shared';
import { asApiResult, filled, meOf, outcomeText, peopleOf, todayOf } from '../findings/shared';
import type { HostContext, TextPair } from '../types';
import { Alert, Button, DateInput, Facts, Field, Modal, PersonPicker, Radio, Select, TextInput, Textarea, UI_TEXT } from '../ui';
import {
  ACTIVITY_STATUSES, ACTIVITY_STATUS_TEXT, activityFormOf, activityPatch, emptyPlan, mayRegisterRecord, planBody, planErrors, reportCode,
} from './model';
import type { ActivityForm, ActivityModel, InternalAuditAdapter, PlanForm, RecordOption } from './model';
import { TEXT } from './text';

// ---------------------------------------------------------------------------------------------------------------
// Plan internal audit
// ---------------------------------------------------------------------------------------------------------------

export function PlanDialog({ ctx, ms, open, adapter, hasCycle, onClose, onPlanned }: {
  ctx: HostContext;
  ms: MsId;
  open: boolean;
  adapter: InternalAuditAdapter;
  hasCycle: boolean;
  onClose(): void;
  onPlanned(outcome: Outcome, text: string): void;
}) {
  const year = todayOf(ctx).slice(0, 4);
  const [form, setForm] = useState<PlanForm>(() => emptyPlan(ctx.lang, year));
  const [errors, setErrors] = useState<ReturnType<typeof planErrors>>({});
  const [key, setKey] = useState(newIdempotencyKey);
  const mutation = useMutation((body: ReturnType<typeof planBody>) => asApiResult(adapter.plan(ms, body, key)));
  useEffect(() => {
    if (open) {
      setForm(emptyPlan(ctx.lang, year));
      setErrors({});
      setKey(newIdempotencyKey());
      mutation.reset();
    }
  }, [open]);
  const set = <K extends keyof PlanForm>(name: K, value: PlanForm[K]) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
  };
  const people = peopleOf(ctx.D);
  const submit = () => {
    const found = planErrors(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    const lead = people.find((p) => p.id === form.lead)?.name ?? null;
    const label = form.shortLabel.trim();
    ctx.track(mutation.submit(planBody(form, lead))).then((res) => {
      if (res.ok) onPlanned(res.data, outcomeText(ctx, res.data, ctx.fill(hasCycle ? TEXT.planned : TEXT.plannedNoCycle, { label })));
    }, () => undefined);
  };
  const fields = mutation.fields;
  return (
    <Modal
      open={open}
      title={TEXT.planTitle}
      sub={hasCycle ? TEXT.planSub : TEXT.noCycleText}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.plan)}</Button>
        </>
      )}
    >
      <FormError ctx={ctx} error={mutation.error && !Object.keys(fields).length ? mutation.error : null} />
      <Field label={TEXT.fName} error={errors.name ?? fields.nameEn ?? null} required>
        <TextInput value={form.name} onChange={(v) => set('name', v)} name="name" maxLength={200} />
      </Field>
      <Field label={TEXT.fNameId} hint={TEXT.fNameIdHint} error={errors.nameId ?? fields.nameId ?? null}>
        <TextInput value={form.nameId} onChange={(v) => set('nameId', v)} name="nameId" maxLength={200} />
      </Field>
      <Field label={TEXT.fShort} hint={TEXT.fShortHint} error={errors.shortLabel ?? fields.shortLabel ?? null} required>
        <TextInput value={form.shortLabel} onChange={(v) => set('shortLabel', v)} name="shortLabel" maxLength={80} />
      </Field>
      <Field label={TEXT.fDate} error={errors.scheduledAt ?? fields.scheduledAt ?? null} required>
        <DateInput value={form.scheduledAt} onChange={(v) => set('scheduledAt', v)} name="scheduledAt" />
      </Field>
      <Field label={TEXT.fDays} error={errors.auditDays ?? fields.auditDays ?? null}>
        <TextInput value={form.auditDays} onChange={(v) => set('auditDays', v)} name="auditDays" type="number" />
      </Field>
      <Field label={TEXT.fLead} error={fields.leadAuditorName ?? null}>
        <Select value={form.lead} onChange={(v) => set('lead', v)} options={people.map((p) => ({ value: p.id, label: p.jobTitle && p.jobTitle !== '-' ? `${p.name}, ${p.jobTitle}` : p.name }))} empty={TEXT.noLead} name="lead" />
      </Field>
      <Field label={TEXT.fScope} hint={TEXT.fScopeHint} error={errors.scopeText ?? fields.scopeText ?? null}>
        <Textarea value={form.scopeText} onChange={(v) => set('scopeText', v)} name="scopeText" rows={3} maxLength={4000} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Edit activity
// ---------------------------------------------------------------------------------------------------------------

export function ActivityDialog({ ctx, ms, activity, adapter, targets, onClose, onSaved }: {
  ctx: HostContext;
  ms: MsId;
  activity: ActivityModel | null;
  adapter: InternalAuditAdapter;
  targets: readonly TargetOption[];
  onClose(): void;
  onSaved(outcome: Outcome, text: string): void;
}) {
  const blank: ActivityForm = { auditor: '', targetCode: '', scheduledAt: '', auditee: '', status: 'planned', note: '' };
  const [form, setForm] = useState<ActivityForm>(() => (activity ? activityFormOf(activity) : blank));
  const [unchanged, setUnchanged] = useState(false);
  const mutation = useMutation((patch: NonNullable<ReturnType<typeof activityPatch>>) => asApiResult(adapter.updateActivity(ms, activity!, patch)));
  useEffect(() => {
    if (activity) {
      setForm(activityFormOf(activity));
      setUnchanged(false);
      mutation.reset();
    }
  }, [activity?.id]);
  const set = <K extends keyof ActivityForm>(name: K, value: ActivityForm[K]) => {
    setForm((f) => ({ ...f, [name]: value }));
    setUnchanged(false);
  };
  const submit = () => {
    if (!activity) return;
    const patch = activityPatch(form, activity);
    if (!patch) {
      setUnchanged(true);
      return;
    }
    ctx.track(mutation.submit(patch)).then((res) => {
      if (res.ok) onSaved(res.data, outcomeText(ctx, res.data, ctx.fill(TEXT.activitySaved, { code: activity.code })));
    }, () => undefined);
  };
  const fields = mutation.fields;
  const people = peopleOf(ctx.D);
  return (
    <Modal
      open={activity !== null}
      title={ctx.fill(TEXT.activityTitle, { code: activity?.code ?? '' })}
      sub={activity?.title}
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
      <Field label={TEXT.fAuditor} hint={TEXT.fAuditorHint} error={fields.auditorHandle ?? null}>
        <Select value={form.auditor} onChange={(v) => set('auditor', v)} options={people.map((p) => ({ value: p.id, label: p.name }))} empty={TEXT.noAuditor} name="auditor" />
      </Field>
      <Field label={TEXT.fTarget} error={fields.targetCode ?? null}>
        <Select value={form.targetCode} onChange={(v) => set('targetCode', v)} options={targets.map((t) => ({ value: t.code, label: `${t.code} ${t.title}` }))} empty={TEXT.noTarget} name="targetCode" />
      </Field>
      <Field label={TEXT.fPlanned} error={fields.scheduledAt ?? null}>
        <DateInput value={form.scheduledAt} onChange={(v) => set('scheduledAt', v)} name="scheduledAt" />
      </Field>
      <Field label={TEXT.fAuditee} error={fields.auditeeHandle ?? null}>
        <PersonPicker value={form.auditee} onChange={(v) => set('auditee', v)} people={people} allowNone />
      </Field>
      <Radio legend={TEXT.fStatus} value={form.status} onChange={(v) => set('status', v as ActivityForm['status'])} name="activityStatus" options={ACTIVITY_STATUSES.map((s) => ({ value: s, label: ACTIVITY_STATUS_TEXT[s] }))} />
      <Field label={TEXT.fNote} error={fields.note ?? null}>
        <Textarea value={form.note} onChange={(v) => set('note', v)} name="note" rows={2} maxLength={2000} />
      </Field>
      {activity ? (
        <div className="mx-stack" style={{ gap: 6 }}>
          <span className="mx-small">{ctx.li(TEXT.fromTemplate)}</span>
          <Facts items={[{ label: TEXT.fQuestions, value: activity.keyQuestions ?? '-' }, { label: TEXT.fEvidence, value: activity.evidenceToRequest ?? '-' }]} />
        </div>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Attach report
// ---------------------------------------------------------------------------------------------------------------

export function ReportDialog({ ctx, ms, open, adapter, eventId, label, records, onClose, onAttached }: {
  ctx: HostContext;
  ms: MsId;
  open: boolean;
  adapter: InternalAuditAdapter;
  eventId: string;
  label: string;
  records: readonly RecordOption[];
  onClose(): void;
  onAttached(outcome: Outcome, text: string): void;
}) {
  const canRegister = mayRegisterRecord(ctx, ms);
  const [from, setFrom] = useState<'record' | 'file'>(records.length || !canRegister ? 'record' : 'file');
  const [recordId, setRecordId] = useState('');
  const [code, setCode] = useState(reportCode(label));
  const [title, setTitle] = useState('');
  const [error, setError] = useState<TextPair | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  // The file picker of the controller opens over the page, so this dialog steps aside while it is open.
  const [picking, setPicking] = useState(false);
  const attach = useMutation((id: string) => asApiResult(adapter.updateEvent(ms, eventId, { reportDocumentId: id })));
  const register = useMutation((body: { code: string; title: string; owner: string }) => asApiResult(adapter.registerRecord(ms, body, key)));
  useEffect(() => {
    if (open) {
      setFrom(records.length || !canRegister ? 'record' : 'file');
      setRecordId('');
      setCode(reportCode(label));
      setTitle(ctx.lang === 'id' ? `Laporan ${label}` : `${label} report`);
      setError(null);
      setKey(newIdempotencyKey());
      setPicking(false);
      attach.reset();
      register.reset();
    }
  }, [open]);
  const busy = attach.busy || register.busy;
  const finish = (record: RecordOption, extra: string | null) => ctx.track(attach.submit(record.id)).then((res) => {
    if (res.ok) {
      const text = outcomeText(ctx, res.data, ctx.fill(TEXT.attached, { code: record.code, label }));
      onAttached(res.data, extra ? `${text} ${extra}` : text);
    }
  }, () => undefined);
  const submit = async () => {
    setError(null);
    if (from === 'record') {
      const record = records.find((r) => r.id === recordId);
      if (!record) {
        setError(TEXT.pickRecord);
        return;
      }
      await finish(record, null);
      return;
    }
    if (!filled(code) || !filled(title)) {
      setError(TEXT.required);
      return;
    }
    const made = await ctx.track(register.submit({ code: code.trim(), title: title.trim(), owner: meOf(ctx) }));
    if (!made.ok) return;
    setPicking(true);
    const file = await ctx.openPicker({ ms, kind: 'document', recordId: made.data.id }).catch(() => null);
    setPicking(false);
    let extra: string | null = null;
    if (file) {
      const added = await ctx.track(adapter.addFile(ms, made.data, file));
      if (!added.ok) extra = ctx.li(added.error.message);
    } else {
      extra = ctx.fill(TEXT.noFileChosen, { code: made.data.code });
    }
    await finish(made.data, extra);
  };
  const failure = attach.error ?? register.error;
  return (
    <Modal
      open={open && !picking}
      title={TEXT.reportTitle}
      sub={TEXT.reportSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={busy} onClick={() => { void submit(); }}>{ctx.li(from === 'file' ? TEXT.chooseFile : TEXT.attach)}</Button>
        </>
      )}
    >
      <FormError ctx={ctx} error={failure && !Object.keys(register.fields).length ? failure : null} />
      {canRegister ? (
        <Radio legend={TEXT.reportFrom} value={from} onChange={(v) => { setFrom(v as 'record' | 'file'); setError(null); }} name="reportFrom" options={[{ value: 'record', label: TEXT.fromRecord }, { value: 'file', label: TEXT.fromFile }]} />
      ) : null}
      {from === 'record' ? (
        records.length ? (
          <Field label={TEXT.fRecord} error={error} required>
            <Select value={recordId} onChange={(v) => { setRecordId(v); setError(null); }} options={records.map((r) => ({ value: r.id, label: `${r.code} ${r.title}` }))} empty={UI_TEXT.choose} name="record" />
          </Field>
        ) : <Alert tone="info">{ctx.li(TEXT.noRecords)}</Alert>
      ) : (
        <>
          <Field label={TEXT.fRecordCode} error={(error && !filled(code) ? error : null) ?? register.fields.docCode ?? null} required>
            <TextInput value={code} onChange={(v) => { setCode(v); setError(null); }} name="docCode" maxLength={30} />
          </Field>
          <Field label={TEXT.fRecordTitle} error={(error && !filled(title) ? error : null) ?? register.fields.title ?? null} required>
            <TextInput value={title} onChange={(v) => { setTitle(v); setError(null); }} name="docTitle" maxLength={255} />
          </Field>
          <span className="mx-small">{ctx.li(TEXT.fileHint)}</span>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Outcome summary
// ---------------------------------------------------------------------------------------------------------------

export function OutcomeDialog({ ctx, ms, open, adapter, eventId, label, summary, onClose, onSaved }: {
  ctx: HostContext;
  ms: MsId;
  open: boolean;
  adapter: InternalAuditAdapter;
  eventId: string;
  label: string;
  summary: string | null;
  onClose(): void;
  onSaved(outcome: Outcome, text: string): void;
}) {
  const [text, setText] = useState(summary ?? '');
  const mutation = useMutation((value: string | null) => asApiResult(adapter.updateEvent(ms, eventId, { outcomeSummary: value })));
  useEffect(() => {
    if (open) {
      setText(summary ?? '');
      mutation.reset();
    }
  }, [open]);
  const submit = () => {
    ctx.track(mutation.submit(filled(text) ? text.trim() : null)).then((res) => {
      if (res.ok) onSaved(res.data, outcomeText(ctx, res.data, ctx.fill(TEXT.outcomeSaved, { label })));
    }, () => undefined);
  };
  return (
    <Modal
      open={open}
      title={ctx.fill(TEXT.outcomeTitle, { label })}
      sub={TEXT.outcomeSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(UI_TEXT.save)}</Button>
        </>
      )}
    >
      <FormError ctx={ctx} error={mutation.error && !mutation.fields.outcomeSummary ? mutation.error : null} />
      <Field label={TEXT.factOutcome} error={mutation.fields.outcomeSummary ?? null}>
        <Textarea value={text} onChange={setText} name="outcomeSummary" rows={5} maxLength={4000} />
      </Field>
    </Modal>
  );
}
