// "Add control or requirement" (MILESTONE-2 M2-11, claim `controls.add`): the controls and clause rows of the edition
// the system uses that have no entry yet and are still in the standard (`applicability.targets`), with a search; then
// applicability, the justification, the owner and the operating frequency, sent as `applicability.create`. A custom
// control is not offered, because the route takes pack targets only. The form links to the bulk import of M2-08.
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import { newIdempotencyKey, useMutation } from '../api';
import { sessionMayImport } from '../import/model';
import type { HostContext, TextPair } from '../types';
import { Alert, Button, Field, Modal, PersonPicker, Radio, RecordPicker, Select, Textarea, UI_TEXT } from '../ui';
import { adapterFor } from './adapter';
import { entryIdOf, frequencyOptions, peopleOf, reloadChanged } from './common';
import type { Warn } from './common';
import { addable, checkCreate, createBodyOf } from './model';
import type { CreateValues, TargetItem } from './model';
import { FieldWarnings, FormFooter, WarningList, asApi, placeErrors, placeWarnings, useAdapterOf } from './parts';
import { forgetTargets, loadTargets } from './targets';
import { TEXT } from './text';

const PATHS = {
  code: 'target', targetType: 'target', isApplicable: 'isApplicable', inclusionJustification: 'inclusion',
  exclusionJustification: 'exclusion', ownerHandle: 'owner', frequencyCode: 'frequency',
} as const;
const RULES = { 'APPL-ASSESS': 'isApplicable', 'NOT-A-MEMBER': 'owner', 'BR-02': 'target' } as const;

/** The frequency a new entry starts with: annual when the edition has it, else the first one. */
function defaultFrequency(ctx: Pick<HostContext, 'D'>): string {
  const options = frequencyOptions(ctx.D);
  return options.find((o) => o.value === 'annual')?.value ?? options[0]?.value ?? '';
}

export default function AddDialog({ ctx, ms, onClose }: { ctx: HostContext; ms: MsId; onClose(): void }) {
  const formId = useId();
  const adapter = useAdapterOf(ctx, adapterFor);
  const scope = `${ctx.mode}:${ctx.org?.id ?? ''}`;
  const key = useRef(newIdempotencyKey());
  const [targets, setTargets] = useState<TargetItem[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const manager = ctx.D?.MS?.find((m) => m.id === ms)?.mgr;
  const [values, setValues] = useState<CreateValues>({
    target: null,
    isApplicable: true,
    inclusion: '',
    exclusion: '',
    owner: manager && ctx.D?.PEOPLE?.[manager] ? manager : 'none',
    frequency: defaultFrequency(ctx),
  });
  const [local, setLocal] = useState<Record<string, TextPair>>({});
  const [added, setAdded] = useState<{ id: string; warnings: Warn[] } | null>(null);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    void loadTargets(adapter, scope, ms, true).then((res) => {
      if (!live) return;
      if (res.ok) setTargets(res.data);
      else setLoadError(res.error);
    });
    return () => {
      live = false;
    };
  }, [adapter, scope, ms, attempt]);

  const mutation = useMutation((input: CreateValues) => adapter.create(ms, createBodyOf(input), key.current).then(asApi));
  const placed = placeErrors(mutation.error, ctx.li, PATHS, RULES);
  const fieldError = (field: string) => (local[field] ? ctx.li(local[field]) : placed.fields[field] || null);
  const set = <K extends keyof CreateValues>(name: K) => (value: CreateValues[K]) => setValues((v) => ({ ...v, [name]: value }));

  const choices = targets ? addable(targets, '') : [];
  const records = choices.map((t) => ({
    id: entryIdOf(t.kind, t.code),
    title: t.title,
    note: t.kind === 'requirement' && t.clauseGroup ? ctx.fill(TEXT.clauseGroup, { n: t.clauseGroup }) : undefined,
  }));
  const chosenId = values.target ? entryIdOf(values.target.kind, values.target.code) : '';
  const choose = (id: string) => {
    const target = choices.find((t) => entryIdOf(t.kind, t.code) === id) ?? null;
    setValues((v) => ({ ...v, target, isApplicable: target && !target.assessable ? true : v.isApplicable }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems = checkCreate(values);
    setLocal(problems);
    if (Object.keys(problems).length) return;
    const res = await ctx.track(mutation.submit(values));
    if (!res.ok) return;
    forgetTargets(ms);
    const id = chosenId;
    await reloadChanged(ctx, res.data.changed, ms);
    if (res.data.warnings.length) {
      setAdded({ id, warnings: res.data.warnings });
      return;
    }
    ctx.toast(ctx.fill(TEXT.added, { id }));
    onClose();
  };

  const mayImport = sessionMayImport(ctx, ms, 'applicability');
  const shown = placeWarnings(added?.warnings ?? [], {});
  const body = () => {
    if (added) {
      return (
        <>
          <Alert tone="ok" role="status">{ctx.fill(TEXT.added, { id: added.id })}</Alert>
          <WarningList warnings={shown.general} title={TEXT.warningsTitle} />
        </>
      );
    }
    if (loadError) {
      return (
        <Alert tone="bad">
          {ctx.li(TEXT.targetsFailed)} {ctx.li(loadError.message)}
          <div className="mx-btn-group" style={{ marginTop: 8 }}><Button onClick={() => setAttempt((n) => n + 1)}>{ctx.li(TEXT.tryAgain)}</Button></div>
        </Alert>
      );
    }
    if (!targets) return <div className="mx-small" role="status">{ctx.li(TEXT.targetsLoading)}</div>;
    if (!choices.length) return <Alert tone="info">{ctx.li(TEXT.allHaveEntries)}</Alert>;
    const target = values.target;
    return (
      <>
        {placed.general ? <Alert tone="bad">{ctx.li(placed.general.message)}</Alert> : null}
        <Field label={TEXT.target} error={fieldError('target')} required>
          <RecordPicker value={chosenId} onChange={choose} records={records} limit={60} />
        </Field>
        {target ? <div className="mx-small" role="status">{ctx.fill(TEXT.chosen, { id: chosenId, title: target.title })}</div> : null}
        <Radio
          legend={TEXT.applies}
          name={`${formId}-applies`}
          value={values.isApplicable ? 'yes' : 'no'}
          onChange={(v) => set('isApplicable')(v === 'yes')}
          options={[{ value: 'yes', label: TEXT.appliesYes }, { value: 'no', label: TEXT.appliesNo }]}
          disabled={Boolean(target && !target.assessable)}
        />
        {target && !target.assessable ? <span className="mx-small">{ctx.li(TEXT.alwaysApplicableReason)}</span> : null}
        {fieldError('isApplicable') ? <span className="mx-error" role="alert">{fieldError('isApplicable')}</span> : null}
        {values.isApplicable ? (
          <Field label={TEXT.inclusion} hint={TEXT.inclusionHint} error={fieldError('inclusion')}>
            <Textarea name="inclusionJustification" value={values.inclusion} onChange={set('inclusion')} rows={2} maxLength={4000} />
          </Field>
        ) : (
          <>
            <Field label={TEXT.exclusion} hint={TEXT.exclusionHint} error={fieldError('exclusion')} required>
              <Textarea name="exclusionJustification" value={values.exclusion} onChange={set('exclusion')} rows={2} maxLength={4000} />
            </Field>
            <FieldWarnings warnings={shown.fields.exclusion} />
          </>
        )}
        <div className="mx-m11-grid">
          <Field label={TEXT.owner} error={fieldError('owner')}>
            <PersonPicker value={values.owner} onChange={set('owner')} people={peopleOf(ctx.D)} allowNone />
          </Field>
          <Field label={TEXT.frequency} error={fieldError('frequency')} required>
            <Select name="frequencyCode" value={values.frequency} onChange={set('frequency')} options={frequencyOptions(ctx.D)} />
          </Field>
        </div>
        {mayImport ? (
          <div className="mx-btn-group">
            <Button variant="link" onClick={() => { onClose(); ctx.go('import', { params: { kind: 'applicability', at: Date.now() } }); }}>{ctx.li(TEXT.importLink)}</Button>
          </div>
        ) : null}
      </>
    );
  };

  const ready = Boolean(targets && choices.length && !added);
  return (
    <Modal
      open
      title={TEXT.addTitle}
      sub={TEXT.addSub}
      onClose={onClose}
      footer={ready
        ? <FormFooter busy={mutation.busy} onCancel={onClose} submitLabel={TEXT.addButton} form={formId} />
        : <Button variant={added ? 'primary' : 'default'} onClick={onClose}>{ctx.li(added ? UI_TEXT.close : UI_TEXT.cancel)}</Button>}
    >
      <form id={formId} className="mx-stack" onSubmit={submit} noValidate>
        {body()}
      </form>
    </Modal>
  );
}
