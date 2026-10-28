// Parts shared by the forms of M2-11 (MILESTONE-2 M2-11): the adapter of a form bound to the latest snapshot, the
// list of linked codes with its picker (risks, documents, evidence targets), the warnings of a write, and the mapping
// of the server's field errors and rules onto the fields of a form.
import { useMemo, useRef } from 'react';
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import type { ControllerData } from '../../data/types';
import { fieldErrors } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Button, Field, RecordPicker, UI_TEXT, useText } from '../ui';
import type { RecordOption } from '../ui';
import type { Result, Warn } from './common';
import './forms.css';

/** A Result as `useMutation` reads it (an ApiResult with the error's status). */
export function asApi<T>(result: Result<T>): ApiResult<T> {
  return result.ok ? { ok: true, status: 200, data: result.data } : { ok: false, status: result.error.status, error: result.error };
}

/** A getter of the latest snapshot, for adapters made once per form. */
export function useLatestD(ctx: Pick<HostContext, 'D'>): () => ControllerData | null {
  const ref = useRef(ctx.D);
  ref.current = ctx.D;
  return useMemo(() => () => ref.current, []);
}

/** An adapter made once per component for the host's client and data source. */
export function useAdapterOf<A>(ctx: Pick<HostContext, 'client' | 'ds' | 'D'>, make: (ctx: Pick<HostContext, 'client' | 'ds' | 'D'>, getD: () => ControllerData | null) => A): A {
  const getD = useLatestD(ctx);
  // The client and the data source stay the same for a session; the snapshot is read through getD.
  return useMemo(() => make(ctx, getD), [ctx.client, ctx.ds, getD]);
}

/**
 * The problem of each field after a refused write: field errors by path (`exclusionJustification` gives `exclusion`
 * through `paths`), and the message of a business-rule refusal on the field named in `rules` (BR-02 under the risks,
 * APPL-ASSESS under the applicability). What no field takes is the form's general error.
 */
export function placeErrors(
  error: ApiError | null,
  li: (text: TextPair | readonly [string, string]) => string,
  paths: Readonly<Record<string, string>>,
  rules: Readonly<Record<string, string>> = {},
): { fields: Record<string, string>; general: ApiError | null } {
  const fields: Record<string, string> = {};
  if (!error) return { fields, general: null };
  const byPath = fieldErrors(error);
  const add = (field: string, text: string) => {
    fields[field] = fields[field] ? `${fields[field]}; ${text}` : text;
  };
  let placed = false;
  for (const [path, field] of Object.entries(paths)) {
    if (byPath[path]) {
      add(field, byPath[path]);
      placed = true;
    }
  }
  if (error.rule && rules[error.rule]) {
    add(rules[error.rule], li(error.message));
    placed = true;
  }
  return { fields, general: placed ? null : error };
}

/** Warnings by field: a rule named in `rules` goes under its field, the others in the general list. */
export function placeWarnings(warnings: readonly Warn[], rules: Readonly<Record<string, string>>): { fields: Record<string, Warn[]>; general: Warn[] } {
  const fields: Record<string, Warn[]> = {};
  const general: Warn[] = [];
  for (const w of warnings) {
    const field = rules[w.rule];
    if (field) (fields[field] ??= []).push(w);
    else general.push(w);
  }
  return { fields, general };
}

/** Warnings of a saved write, under a field or at the top of a form. */
export function WarningList({ warnings, title }: { warnings: readonly Warn[]; title?: TextPair }) {
  const t = useText();
  if (!warnings.length) return null;
  return (
    <Alert tone="warn" title={title} role="status">
      <ul className="mx-m11-list">
        {warnings.map((w, i) => <li key={`${w.rule}-${i}`}><span className="mx-mono">{w.rule}</span> {t(w.message)}</li>)}
      </ul>
    </Alert>
  );
}

/** Rule warnings shown as the field's hint line (role="status", so screen readers announce them after Save). */
export function FieldWarnings({ warnings }: { warnings: readonly Warn[] | undefined }) {
  const t = useText();
  if (!warnings?.length) return null;
  return (
    <span className="mx-m11-warn" role="status">
      {warnings.map((w) => t(w.message)).join(' ')}
    </span>
  );
}

export interface CodeOption {
  code: string;
  title: string;
}

/**
 * A list of linked codes with a Remove button each and a searchable picker that adds one (risks, documents). The
 * picker offers the options that are not in the list yet; `pickerOff` replaces it with a sentence (the list could not
 * be read, or the person may not add).
 */
export function CodeList({ label, hint, error, value, onChange, options, empty, pickLabel, pickerOff, removeLabel, disabled }: {
  label: TextPair;
  hint?: TextPair | string | null;
  error?: string | null;
  value: readonly string[];
  onChange(next: string[]): void;
  options: readonly CodeOption[] | null;
  empty: TextPair;
  pickLabel: TextPair;
  pickerOff?: TextPair | null;
  removeLabel: TextPair;
  disabled?: boolean;
}) {
  const t = useText();
  const titleOf = (code: string) => options?.find((o) => o.code === code)?.title ?? '';
  const records: RecordOption[] = (options ?? []).filter((o) => !value.includes(o.code)).map((o) => ({ id: o.code, title: o.title }));
  return (
    <fieldset className="mx-m11-set">
      <legend className="mx-label">{t(label)}</legend>
      {value.length ? (
        <ul className="mx-m11-codes">
          {value.map((code) => (
            <li key={code}>
              <span className="mx-mono mx-m11-code">{code}</span>
              <span className="mx-m11-code-title">{titleOf(code)}</span>
              <Button variant="link" disabled={disabled} onClick={() => onChange(value.filter((c) => c !== code))}>
                {t(removeLabel).replace('{code}', code)}
              </Button>
            </li>
          ))}
        </ul>
      ) : <span className="mx-small">{t(empty)}</span>}
      {pickerOff ? <span className="mx-small">{t(pickerOff)}</span> : (
        <Field label={pickLabel} hint={hint ?? undefined} error={error ?? undefined}>
          <RecordPicker value="" onChange={(code) => code && onChange([...value, code])} records={records} disabled={disabled || options === null} limit={30} />
        </Field>
      )}
      {pickerOff && error ? <span className="mx-error" role="alert">{error}</span> : null}
    </fieldset>
  );
}

/** The footer of a form: Cancel (Close once something was saved) and the primary action. */
export function FormFooter({ saved, busy, onCancel, submitLabel, form, danger, disabledReason }: {
  saved?: boolean;
  busy?: boolean;
  onCancel(): void;
  submitLabel: TextPair;
  form: string;
  danger?: boolean;
  disabledReason?: TextPair | null;
}) {
  const t = useText();
  return (
    <>
      <Button onClick={onCancel}>{t(saved ? UI_TEXT.close : UI_TEXT.cancel)}</Button>
      <Button type="submit" form={form} variant={danger ? 'danger' : 'primary'} busy={busy} disabledReason={disabledReason ?? undefined}>{t(submitLabel)}</Button>
    </>
  );
}
