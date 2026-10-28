// Small parts of the Registers screen (MILESTONE-2 M2-13): adapter results for `useMutation`, the text of a refusal,
// the field of a register kind and the people and frequency options of the snapshot.
import type { ReactNode } from 'react';
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import type { HostContext, TextPair } from '../types';
import { Alert, Checkbox, DateInput, PersonPicker, Select, TextInput, Textarea } from '../ui';
import type { Option, PersonOption } from '../ui';
import { settled } from './adapter';
import { FIELDS, SCORE_SCALE } from './model';
import type { FieldKey, FormState, Result } from './model';
import { TEXT } from './text';

/** An adapter result as the `ApiResult` that `useMutation` keeps (a failed promise becomes a connection error). */
export function asApi<T>(promise: Promise<Result<T>>): Promise<ApiResult<T>> {
  return settled(promise).then((r) => (r.ok ? { ok: true as const, status: 200, data: r.data } : { ok: false as const, status: r.error.status, error: r.error }));
}

/** The text of a refusal: the server's message, with its detail when it carries no translated message. */
export function problemText(ctx: Pick<HostContext, 'li'>, error: ApiError): string {
  const message = ctx.li(error.message);
  return error.detail && error.message[0] === error.message[1] && !error.messageKey ? `${message}: ${error.detail}` : message;
}

export function ErrorAlert({ ctx, error, title }: { ctx: HostContext; error: ApiError | null | undefined; title?: TextPair }) {
  if (!error) return null;
  return <Alert tone="bad" title={title}>{problemText(ctx, error)}</Alert>;
}

/** Warnings of a write (BR-23 and the other warn-and-allow rules). */
export function Warnings({ ctx, warnings }: { ctx: HostContext; warnings: readonly TextPair[] }) {
  if (!warnings.length) return null;
  return (
    <Alert tone="warn" title={TEXT.warningsTitle}>
      <ul style={{ margin: 0, paddingLeft: 18 }}>{warnings.map((w, i) => <li key={i}>{ctx.li(w)}</li>)}</ul>
    </Alert>
  );
}

/** The people of the organisation (snapshot `PEOPLE`), without the unassigned entry. */
export function peopleOf(ctx: Pick<HostContext, 'D'>): PersonOption[] {
  return Object.entries(ctx.D?.PEOPLE ?? {})
    .filter(([id]) => id !== 'none')
    .map(([id, [name, jobTitle]]) => ({ id, name, jobTitle }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The evidence frequencies of the snapshot (`FREQ`, `FREQ_ORDER`). */
export function frequencyOptions(ctx: Pick<HostContext, 'D'>): Option[] {
  const D = ctx.D;
  if (!D) return [];
  return (D.FREQ_ORDER ?? []).map((f) => ({ value: f, label: [D.FREQ[f][0], D.FREQ[f][1]] as TextPair }));
}

/** The scale of likelihood and impact. */
export const SCORE_OPTIONS: Option[] = Array.from({ length: SCORE_SCALE.max - SCORE_SCALE.min + 1 }, (_, i) => ({ value: String(SCORE_SCALE.min + i), label: String(SCORE_SCALE.min + i) }));

/** The control of one field of a register kind. */
export function FieldControl({ ctx, field, form, onChange, disabled, metrics, people }: {
  ctx: HostContext;
  field: FieldKey;
  form: FormState;
  onChange(key: FieldKey, value: string | boolean): void;
  disabled?: boolean;
  metrics: Option[];
  people: PersonOption[];
}): ReactNode {
  const def = FIELDS[field];
  const value = form[field];
  const text = typeof value === 'string' ? value : '';
  const set = (v: string | boolean) => onChange(field, v);
  switch (def.type) {
    case 'textarea':
      return <Textarea value={text} onChange={set} rows={3} maxLength={def.max} name={field} disabled={disabled} />;
    case 'date':
      return <DateInput value={text} onChange={set} name={field} disabled={disabled} />;
    case 'number':
      return <TextInput type="number" value={text} onChange={set} name={field} disabled={disabled} />;
    case 'score':
      return <Select value={text} onChange={set} name={field} disabled={disabled} empty={TEXT.noValue} options={SCORE_OPTIONS} />;
    case 'person':
      return <PersonPicker value={text} onChange={set} people={people} disabled={disabled} />;
    case 'personOrNone':
      return <PersonPicker value={text} onChange={set} people={people} allowNone disabled={disabled} />;
    case 'metric':
      return <Select value={text} onChange={set} name={field} disabled={disabled} empty={TEXT.noValue} options={metrics} />;
    case 'bool':
      return <Checkbox checked={Boolean(value)} onChange={set} label={def.label} disabled={disabled} name={field} />;
    case 'select': {
      const options = field === 'frequencyCode'
        ? frequencyOptions(ctx)
        : Object.entries(def.options ?? {}).map(([v, label]) => ({ value: v, label }));
      return <Select value={text} onChange={set} name={field} disabled={disabled} empty={def.required ? undefined : TEXT.noValue} options={options} />;
    }
    default:
      return <TextInput value={text} onChange={set} name={field} maxLength={def.max} disabled={disabled} />;
  }
}
