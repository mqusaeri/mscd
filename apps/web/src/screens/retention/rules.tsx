// Rules of Retention and disposal (MILESTONE-3 M3-06, D.8): the period in force for each record type (and document
// type for earlier document versions), marked Default or Set with its basis, and "Edit" and "Reset to default" for the
// Management System Manager (`retention.manage`).
import { useState } from 'react';
import type { MsId } from '../../data/types';
import { useMutation } from '../api';
import type { HostContext } from '../types';
import { Alert, Badge, Button, Card, Field, Modal, Table, TextInput, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { adapterFor } from './adapter';
import type { RuleBody, RuleForm, RuleModel } from './model';
import { CLASS_START_TEXT, CLASS_TEXT, DEFAULT_MONTHS, asApiResult, mayManage, ruleBody, ruleErrors } from './model';
import { LoadState, useLoad } from './parts';
import { noteRetentionChanged } from './store';
import { TEXT } from './text';

/** The name of a rule's records: the class, with the document type for document versions. */
export function ruleName(ctx: HostContext, rule: Pick<RuleModel, 'recordClass' | 'docTypeLabel'>): string {
  const what = ctx.li(CLASS_TEXT[rule.recordClass]);
  return rule.docTypeLabel ? `${what}: ${ctx.li(rule.docTypeLabel)}` : what;
}

export function RuleDialog({ ctx, ms, rule, reset, onClose, onSaved }: {
  ctx: HostContext; ms: MsId; rule: RuleModel; reset: boolean; onClose(): void; onSaved(): void;
}) {
  const adapter = adapterFor(ctx);
  const [form, setForm] = useState<RuleForm>({ months: String(rule.retainMonths), basis: reset ? '' : rule.basis ?? '' });
  const [errors, setErrors] = useState<ReturnType<typeof ruleErrors>>({});
  const mutation = useMutation((body: RuleBody) => asApiResult(adapter.putRule(ms, rule.recordClass, body)));
  const submit = () => {
    const found = ruleErrors(form, reset);
    setErrors(found);
    if (Object.keys(found).length) return;
    ctx.track(mutation.submit(ruleBody(rule, form, reset))).then((res) => {
      if (res.ok) onSaved();
    }, () => undefined);
  };
  const general = mutation.error && !mutation.fields.retainMonths && !mutation.fields.basis ? mutation.error : null;
  const what = ruleName(ctx, rule);
  return (
    <Modal
      open
      title={ctx.fill(reset ? TEXT.resetTitle : TEXT.ruleTitle, { what })}
      sub={reset ? TEXT.resetText : ctx.fill(TEXT.ruleSub, { start: ctx.li(CLASS_START_TEXT[rule.recordClass]).toLowerCase() })}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(reset ? TEXT.resetDefault : TEXT.save)}</Button>
        </>
      )}
    >
      {general ? <Alert tone="bad">{ctx.li(general.message)}</Alert> : null}
      {reset ? null : (
        <Field label={TEXT.fMonths} hint={TEXT.fMonthsHint} error={errors.months ?? mutation.fields.retainMonths ?? null} required>
          <TextInput name="months" type="number" value={form.months} onChange={(v) => { setForm((c) => ({ ...c, months: v })); setErrors((e) => ({ ...e, months: undefined })); }} />
        </Field>
      )}
      <Field label={reset ? TEXT.fResetReason : TEXT.fBasis} hint={reset ? undefined : TEXT.fBasisHint} error={errors.basis ?? mutation.fields.basis ?? null} required>
        <Textarea name="basis" rows={3} maxLength={500} value={form.basis} onChange={(v) => { setForm((c) => ({ ...c, basis: v })); setErrors((e) => ({ ...e, basis: undefined })); }} />
      </Field>
    </Modal>
  );
}

export function RulesTab({ ctx, ms }: { ctx: HostContext; ms: MsId }) {
  const adapter = adapterFor(ctx);
  const list = useLoad(() => adapter.rules(ms), [ms]);
  const manage = mayManage(ctx, ms);
  const [editing, setEditing] = useState<{ rule: RuleModel; reset: boolean } | null>(null);
  const columns: Column<RuleModel>[] = [
    {
      key: 'class', label: TEXT.colClass,
      render: (r) => (
        <span style={{ display: 'block' }}>
          {ctx.li(CLASS_TEXT[r.recordClass])}
          <span className="mx-small" style={{ display: 'block' }}>{ctx.li(CLASS_START_TEXT[r.recordClass])}</span>
        </span>
      ),
    },
    { key: 'doctype', label: TEXT.colDocType, render: (r) => (r.docTypeLabel ? ctx.li(r.docTypeLabel) : <span className="mx-muted">-</span>) },
    { key: 'period', label: TEXT.colPeriod, render: (r) => ctx.fill(TEXT.months, { n: r.retainMonths }) },
    { key: 'source', label: TEXT.colSource, render: (r) => <Badge tone={r.source === 'set' ? 'acc' : 'mute'}>{ctx.li(r.source === 'set' ? TEXT.sourceSet : TEXT.sourceDefault)}</Badge> },
    { key: 'basis', label: TEXT.colBasis, render: (r) => (r.basis ? <span style={{ overflowWrap: 'anywhere' }}>{r.basis}</span> : <span className="mx-muted">-</span>) },
    ...(manage ? [{
      key: 'actions', label: TEXT.colActions,
      render: (r: RuleModel) => (
        <span className="mx-row">
          <Button onClick={() => setEditing({ rule: r, reset: false })}>{ctx.li(TEXT.edit)}</Button>
          {r.source === 'set' ? <Button variant="link" onClick={() => setEditing({ rule: r, reset: true })}>{ctx.li(TEXT.resetDefault)}</Button> : null}
        </span>
      ),
    }] : []),
  ];
  return (
    <Card title={TEXT.rulesTitle} sub={ctx.fill(TEXT.rulesSub, { n: DEFAULT_MONTHS })} flush>
      {!manage ? <div style={{ padding: 12 }}><Alert tone="info">{ctx.li(TEXT.readOnly)}</Alert></div> : null}
      <LoadState ctx={ctx} list={list} />
      {list.data ? <Table columns={columns} rows={list.data} rowKey={(r) => `${r.recordClass}:${r.docType ?? ''}`} /> : null}
      {editing ? (
        <RuleDialog
          ctx={ctx}
          ms={ms}
          rule={editing.rule}
          reset={editing.reset}
          onClose={() => setEditing(null)}
          onSaved={() => {
            ctx.toast(ctx.li(editing.reset ? TEXT.ruleReset : TEXT.ruleSaved));
            setEditing(null);
            noteRetentionChanged();
          }}
        />
      ) : null}
    </Card>
  );
}
