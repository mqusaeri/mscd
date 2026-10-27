// Form controls of the UI kit (MILESTONE-2 C.6): a labelled field with its hint and error line, and the inputs it
// wraps. Controls are 36px high on --sur2 with a --field border; an error line has role="alert" and the control
// gets aria-invalid, so screen readers announce the server's field error next to the field.
import { createContext, useContext, useId, useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { UI_TEXT, useText } from './text';
import type { TextLike } from './text';

interface FieldInfo {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}
const FieldCtx = createContext<FieldInfo | null>(null);

/** The id, description and state of the field around a control (or a fresh id outside a field). */
function useField(): FieldInfo {
  const ctx = useContext(FieldCtx);
  const own = useId();
  return ctx ?? { id: own, invalid: false, required: false };
}

/** A labelled control with an optional hint and error line. `error` is the server's or the form's message. */
export function Field({ label, hint, error, required, children }: {
  label: TextLike;
  hint?: TextLike;
  error?: TextLike | null;
  required?: boolean;
  children: ReactNode;
}) {
  const t = useText();
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const info = useMemo<FieldInfo>(() => ({
    id: `${id}-control`,
    describedBy: [hintId, errorId].filter(Boolean).join(' ') || undefined,
    invalid: Boolean(error),
    required: Boolean(required),
  }), [id, hintId, errorId, error, required]);
  return (
    <div className="mx-field">
      <label className="mx-label" htmlFor={info.id}>
        {t(label)}
        {required ? <span className="mx-req" aria-hidden="true">*</span> : null}
        {required ? <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{` (${t(UI_TEXT.requiredMark)})`}</span> : null}
      </label>
      <FieldCtx.Provider value={info}>{children}</FieldCtx.Provider>
      {hint ? <span id={hintId} className="mx-hint">{t(hint)}</span> : null}
      {error ? <span id={errorId} className="mx-error" role="alert">{t(error)}</span> : null}
    </div>
  );
}

interface InputBase {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  placeholder?: TextLike;
  name?: string;
  autoFocus?: boolean;
}

export function TextInput({ value, onChange, disabled, placeholder, name, type = 'text', autoComplete, maxLength, autoFocus }: InputBase & {
  type?: 'text' | 'email' | 'number' | 'password' | 'search' | 'url';
  autoComplete?: string;
  maxLength?: number;
}) {
  const f = useField();
  const t = useText();
  return (
    <input
      id={f.id}
      className="mx-input"
      type={type}
      name={name}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={placeholder ? t(placeholder) : undefined}
      aria-invalid={f.invalid || undefined}
      aria-describedby={f.describedBy}
      aria-required={f.required || undefined}
      autoComplete={autoComplete}
      maxLength={maxLength}
      autoFocus={autoFocus}
    />
  );
}

export function DateInput({ value, onChange, disabled, name, min, max }: InputBase & { min?: string; max?: string }) {
  const f = useField();
  return (
    <input
      id={f.id}
      className="mx-input"
      type="date"
      name={name}
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-invalid={f.invalid || undefined}
      aria-describedby={f.describedBy}
      aria-required={f.required || undefined}
    />
  );
}

export function Textarea({ value, onChange, disabled, placeholder, name, rows = 5, maxLength, mono }: InputBase & { rows?: number; maxLength?: number; mono?: boolean }) {
  const f = useField();
  const t = useText();
  return (
    <textarea
      id={f.id}
      className="mx-textarea"
      name={name}
      rows={rows}
      value={value}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={placeholder ? t(placeholder) : undefined}
      aria-invalid={f.invalid || undefined}
      aria-describedby={f.describedBy}
      aria-required={f.required || undefined}
      style={mono ? { fontFamily: 'var(--ffm)', fontSize: 12 } : undefined}
    />
  );
}

export interface Option {
  value: string;
  label: TextLike;
}

export function Select({ value, onChange, options, disabled, name, empty }: {
  value: string;
  onChange(value: string): void;
  options: Option[];
  disabled?: boolean;
  name?: string;
  /** Label of an empty first option (no choice yet). */
  empty?: TextLike;
}) {
  const f = useField();
  const t = useText();
  return (
    <select
      id={f.id}
      className="mx-select"
      name={name}
      value={value}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      disabled={disabled}
      aria-invalid={f.invalid || undefined}
      aria-describedby={f.describedBy}
      aria-required={f.required || undefined}
    >
      {empty !== undefined ? <option value="">{t(empty)}</option> : null}
      {options.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
    </select>
  );
}

export function Checkbox({ checked, onChange, label, disabled, name }: { checked: boolean; onChange(checked: boolean): void; label: TextLike; disabled?: boolean; name?: string }) {
  const t = useText();
  return (
    <label className="mx-check">
      <input type="checkbox" name={name} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{t(label)}</span>
    </label>
  );
}

/** A group of radio buttons with its legend. */
export function Radio({ legend, value, onChange, options, name, disabled }: {
  legend: TextLike;
  value: string;
  onChange(value: string): void;
  options: Option[];
  name: string;
  disabled?: boolean;
}) {
  const t = useText();
  return (
    <fieldset className="mx-radios">
      <legend className="mx-label">{t(legend)}</legend>
      {options.map((o) => (
        <label key={o.value} className="mx-check">
          <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} />
          <span>{t(o.label)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * A file input; `onFile` gets the chosen file (or null when the choice is cleared). The native control is visually
 * hidden behind a button and the file name, so every text follows the interface language.
 */
export function FileInput({ accept, onFile, disabled, name }: { accept?: string; onFile(file: File | null): void; disabled?: boolean; name?: string }) {
  const f = useField();
  const t = useText();
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <span className="mx-file">
      <input
        id={f.id}
        className="mx-file-input"
        type="file"
        name={name}
        accept={accept}
        disabled={disabled}
        aria-invalid={f.invalid || undefined}
        aria-describedby={f.describedBy}
        onChange={(e) => {
          const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
          setChosen(file ? file.name : null);
          onFile(file);
        }}
      />
      <label htmlFor={f.id} className="mx-btn">{t(UI_TEXT.chooseFile)}</label>
      <span className="mx-small mx-file-name">{chosen ?? t(UI_TEXT.noFile)}</span>
    </span>
  );
}

/** A person of the organisation: the PEOPLE entries of the snapshot ([name, job title]). */
export interface PersonOption {
  id: string;
  name: string;
  jobTitle?: string;
}

/** Choice of one person (holder, owner, approver); `none` is the unassigned choice when `allowNone`. */
export function PersonPicker({ value, onChange, people, allowNone, disabled }: {
  value: string;
  onChange(id: string): void;
  people: PersonOption[];
  allowNone?: boolean;
  disabled?: boolean;
}) {
  const options = people.map((p) => ({ value: p.id, label: p.jobTitle && p.jobTitle !== '-' ? `${p.name}, ${p.jobTitle}` : p.name }));
  return <Select value={value} onChange={onChange} options={options} disabled={disabled} empty={allowNone ? UI_TEXT.none : UI_TEXT.choose} />;
}

/** A record of a list (risk, document, control): its id, a title and an optional note. */
export interface RecordOption {
  id: string;
  title: string;
  note?: string;
}

/** Choice of one record from a long list, with a search box over id and title. */
export function RecordPicker({ value, onChange, records, disabled, limit = 50 }: {
  value: string;
  onChange(id: string): void;
  records: RecordOption[];
  disabled?: boolean;
  limit?: number;
}) {
  const f = useField();
  const t = useText();
  const [q, setQ] = useState('');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = records.filter((r) => words.every((w) => `${r.id} ${r.title}`.toLowerCase().includes(w))).slice(0, limit);
  const listId = `${f.id}-list`;
  return (
    <div className="mx-stack" style={{ gap: 6 }}>
      <input
        id={f.id}
        className="mx-input"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t(UI_TEXT.search)}
        disabled={disabled}
        aria-controls={listId}
        aria-invalid={f.invalid || undefined}
        aria-describedby={f.describedBy}
      />
      <div id={listId} className="mx-picker-list" role="listbox" aria-label={t(UI_TEXT.choose)}>
        {shown.length ? shown.map((r) => (
          <button
            key={r.id}
            type="button"
            role="option"
            aria-selected={r.id === value}
            className="mx-picker-option"
            disabled={disabled}
            onClick={() => onChange(r.id)}
          >
            <span><span className="mx-mono" style={{ fontWeight: 600, marginRight: 8 }}>{r.id}</span>{r.title}</span>
            {r.id === value ? <span className="mx-small">{t(UI_TEXT.selected)}</span> : r.note ? <span className="mx-small">{r.note}</span> : null}
          </button>
        )) : <div className="mx-small" style={{ padding: '8px 10px' }}>{t(UI_TEXT.noMatch)}</div>}
      </div>
    </div>
  );
}
