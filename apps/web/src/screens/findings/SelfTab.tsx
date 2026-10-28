// The Self-assessment tab of "Findings and actions" (MILESTONE-2 M2-14): one row per finding condition of the
// system's edition with its assessment, "Assess" (conforming, gap with an owner and a target date, not applicable,
// with evidence codes) and "Raise finding" from a gap.
import { useEffect, useState } from 'react';
import type { MsId } from '../../data/types';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext } from '../types';
import { Button, Card, DateInput, EmptyState, Field, Modal, PersonPicker, Radio, Select, Table, TextInput, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { CLASSIFICATION_TEXT, SA_STATUSES, SA_STATUS_TEXT, assessBody, assessErrors, assessFormOf, mayAssess, mayRaise } from './model';
import type { AssessForm, Classification, FindingsAdapter, SelfRow } from './model';
import { ClassBadge, FormError, SelfStatusBadge } from './parts';
import type { Outcome } from './shared';
import { asApiResult, day, optional, outcomeText, peopleOf, personName } from './shared';
import { TEXT } from './text';

export function SelfList({ ctx, ms, rows, onAssess, onRaise }: {
  ctx: HostContext;
  ms: MsId;
  rows: SelfRow[];
  onAssess(row: SelfRow): void;
  onRaise(row: SelfRow): void;
}) {
  if (!rows.length) {
    return (
      <Card>
        <EmptyState title={TEXT.noConditions} text={TEXT.noConditionsText} />
      </Card>
    );
  }
  const assess = mayAssess(ctx, ms);
  const raise = mayRaise(ctx, ms);
  const columns: Column<SelfRow>[] = [
    {
      key: 'condition',
      label: TEXT.colCondition,
      render: (r) => (
        <span>
          <span className="mx-mono" style={{ fontWeight: 600, marginRight: 8 }}>{r.conditionCode}</span>
          {r.text}
          {r.note ? <span className="mx-small" style={{ display: 'block', marginTop: 2 }}>{r.note}</span> : null}
        </span>
      ),
    },
    { key: 'class', label: TEXT.colClassification, render: (r) => <ClassBadge ctx={ctx} value={r.classification} /> },
    { key: 'clause', label: TEXT.colClause, render: (r) => <span className="mx-mono">{r.requirementCode ?? '-'}</span> },
    { key: 'assessment', label: TEXT.colAssessment, render: (r) => <SelfStatusBadge ctx={ctx} value={r.status} /> },
    { key: 'owner', label: TEXT.colOwner, render: (r) => personName(ctx.D, r.owner) },
    { key: 'target', label: TEXT.colTargetDate, render: (r) => day(ctx, r.targetFixAt) },
    { key: 'finding', label: TEXT.colFinding, render: (r) => <span className="mx-mono">{r.findingCode ?? '-'}</span> },
    {
      key: 'actions',
      label: TEXT.colRowActions,
      render: (r) => (
        <span className="mx-btn-group">
          {assess ? <Button onClick={() => onAssess(r)}>{ctx.li(TEXT.assess)}</Button> : null}
          {raise && r.status === 'gap' && r.id && !r.findingCode ? <Button onClick={() => onRaise(r)}>{ctx.li(TEXT.raise)}</Button> : null}
        </span>
      ),
    },
  ];
  return (
    <Card title={TEXT.tabSelf} sub={TEXT.selfIntro} flush>
      <Table columns={columns} rows={rows} rowKey={(r) => r.conditionCode} />
    </Card>
  );
}

export function AssessDialog({ ctx, ms, row, adapter, onClose, onSaved }: {
  ctx: HostContext;
  ms: MsId;
  row: SelfRow | null;
  adapter: FindingsAdapter;
  onClose(): void;
  onSaved(outcome: Outcome, text: string): void;
}) {
  const [form, setForm] = useState<AssessForm>(() => (row ? assessFormOf(row) : { status: 'conforming', owner: '', targetFixAt: '', note: '', evidence: '' }));
  const [errors, setErrors] = useState<ReturnType<typeof assessErrors>>({});
  const mutation = useMutation((body: ReturnType<typeof assessBody>) => asApiResult(adapter.assess(ms, row!, body)));
  useEffect(() => {
    if (row) {
      setForm(assessFormOf(row));
      setErrors({});
      mutation.reset();
    }
  }, [row?.conditionCode]);
  const set = <K extends keyof AssessForm>(name: K, value: AssessForm[K]) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
  };
  const submit = () => {
    if (!row) return;
    const found = assessErrors(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    ctx.track(mutation.submit(assessBody(form))).then((res) => {
      if (res.ok) onSaved(res.data, outcomeText(ctx, res.data, ctx.fill(TEXT.assessed, { code: row.conditionCode })));
    }, () => undefined);
  };
  const fields = mutation.fields;
  const gap = form.status === 'gap';
  return (
    <Modal
      open={row !== null}
      title={ctx.fill(TEXT.assessTitle, { code: row?.conditionCode ?? '' })}
      sub={row?.text}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(UI_TEXT.save)}</Button>
        </>
      )}
    >
      <FormError ctx={ctx} error={mutation.error && !Object.keys(fields).length ? mutation.error : null} />
      <Radio
        legend={TEXT.fAssessment}
        value={form.status}
        onChange={(v) => set('status', v as AssessForm['status'])}
        name="status"
        options={SA_STATUSES.map((s) => ({ value: s, label: SA_STATUS_TEXT[s] }))}
      />
      <Field label={TEXT.fOwner} error={errors.owner ?? fields.ownerHandle ?? null} required={gap}>
        <PersonPicker value={form.owner} onChange={(v) => set('owner', v)} people={peopleOf(ctx.D)} allowNone={!gap} />
      </Field>
      <Field label={TEXT.fTargetFix} error={errors.targetFixAt ?? fields.targetFixAt ?? null} required={gap}>
        <DateInput value={form.targetFixAt} onChange={(v) => set('targetFixAt', v)} name="targetFixAt" disabled={!gap} />
      </Field>
      <Field label={TEXT.fNote} error={errors.note ?? fields.note ?? null}>
        <Textarea value={form.note} onChange={(v) => set('note', v)} name="note" rows={3} maxLength={2000} />
      </Field>
      <Field label={TEXT.fEvidence} hint={TEXT.fEvidenceHint} error={errors.evidence ?? fields.evidenceCodes ?? null}>
        <TextInput value={form.evidence} onChange={(v) => set('evidence', v)} name="evidence" />
      </Field>
    </Modal>
  );
}

export function RaiseGapDialog({ ctx, ms, row, adapter, onClose, onRaised }: {
  ctx: HostContext;
  ms: MsId;
  row: SelfRow | null;
  adapter: FindingsAdapter;
  onClose(): void;
  onRaised(outcome: Outcome, text: string): void;
}) {
  const [classification, setClassification] = useState<Classification>('minor');
  const [title, setTitle] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const mutation = useMutation((body: { classification: Classification; title?: string }) => asApiResult(adapter.raiseFromGap(ms, row!, body, key)));
  useEffect(() => {
    if (row) {
      setClassification(row.classification === 'major' || row.classification === 'minor' || row.classification === 'ofi' ? row.classification : 'minor');
      setTitle('');
      setKey(newIdempotencyKey());
      mutation.reset();
    }
  }, [row?.conditionCode]);
  const submit = () => {
    if (!row) return;
    const t = optional(title);
    ctx.track(mutation.submit({ classification, ...(t ? { title: t } : {}) })).then((res) => {
      if (res.ok) onRaised(res.data, outcomeText(ctx, res.data, ctx.fill(TEXT.raisedFromGap, { code: row.conditionCode })));
    }, () => undefined);
  };
  return (
    <Modal
      open={row !== null}
      title={ctx.fill(TEXT.raiseGapTitle, { code: row?.conditionCode ?? '' })}
      sub={TEXT.raiseGapSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.raise)}</Button>
        </>
      )}
    >
      <FormError ctx={ctx} error={mutation.error && !Object.keys(mutation.fields).length ? mutation.error : null} />
      <Field label={TEXT.fClassification} hint={TEXT.fClassHint} error={mutation.fields.classification ?? null} required>
        <Select
          value={classification}
          onChange={(v) => setClassification(v as Classification)}
          name="classification"
          options={(['major', 'minor', 'ofi'] as const).map((c) => ({ value: c, label: CLASSIFICATION_TEXT[c] }))}
        />
      </Field>
      <Field label={TEXT.fTitleOptional} hint={TEXT.fTitleOptionalHint} error={mutation.fields.title ?? null}>
        <TextInput value={title} onChange={setTitle} name="title" maxLength={255} placeholder={row?.text} />
      </Field>
    </Modal>
  );
}
