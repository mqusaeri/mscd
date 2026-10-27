// UI kit (MILESTONE-2 C.6): cards, facts, badges, buttons, alerts, the empty state, tabs and tables of the host
// screens. Styling comes only from the .mx- classes of screens.css over the tokens of src/styles.css; every label
// takes an [English, Indonesian] pair or a plain string and is shown in the language of the host context.
import { Component, useId } from 'react';
import type { ErrorInfo, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { UI_TEXT, fillText, useLang, useText } from './text';
import type { TextLike } from './text';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'acc' | 'mute';

const cls = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

export function Card({ title, sub, actions, children, flush, className, labelledBy }: {
  title?: TextLike;
  sub?: TextLike;
  actions?: ReactNode;
  children?: ReactNode;
  /** No padding around the body (tables). */
  flush?: boolean;
  className?: string;
  labelledBy?: string;
}) {
  const t = useText();
  const id = useId();
  const headingId = labelledBy ?? (title ? `${id}-title` : undefined);
  return (
    <section className={cls('mx-card', className)} aria-labelledby={headingId}>
      {title || actions ? (
        <div className="mx-card-head">
          <div style={{ minWidth: 0 }}>
            {title ? <h2 id={headingId} className="mx-card-title" style={{ margin: 0, fontSize: 'inherit' }}>{t(title)}</h2> : null}
            {sub ? <span className="mx-card-sub">{t(sub)}</span> : null}
          </div>
          {actions ? <div className="mx-btn-group">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cls('mx-card-body', flush && 'mx-flush')}>{children}</div>
    </section>
  );
}

/** A list of labelled values. */
export function Facts({ items }: { items: { label: TextLike; value: ReactNode; mono?: boolean }[] }) {
  const t = useText();
  return (
    <dl className="mx-facts">
      {items.map((item, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{t(item.label)}</dt>
          <dd className={item.mono ? 'mx-mono' : undefined}>{item.value ?? '-'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Badge({ tone = 'mute', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`mx-badge mx-tone-${tone}`} title={title}>{children}</span>;
}

export interface ButtonProps {
  children?: ReactNode;
  variant?: 'default' | 'primary' | 'danger' | 'link';
  /** Why the action is not available; shown next to the disabled button as text (never by opacity alone). */
  disabledReason?: TextLike | null;
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
  icon?: string;
  title?: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  form?: string;
  id?: string;
}

/** A button of the kit. A disabled button keeps readable text and shows its reason next to it (C.6). */
export function Button({ children, variant = 'default', disabledReason, disabled, busy, type = 'button', icon, title, onClick, form, id }: ButtonProps) {
  const t = useText();
  const off = Boolean(disabled || busy || disabledReason);
  const reasonId = useId();
  const button = (
    <button
      id={id}
      type={type}
      form={form}
      className={cls('mx-btn', variant !== 'default' && `mx-btn-${variant}`)}
      disabled={off}
      aria-busy={busy || undefined}
      aria-describedby={disabledReason ? reasonId : undefined}
      title={title}
      onClick={off ? undefined : onClick}
    >
      {icon ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={icon} />
        </svg>
      ) : null}
      {busy ? t(UI_TEXT.saving) : children}
    </button>
  );
  if (!disabledReason) return button;
  return (
    <span className="mx-btn-group">
      {button}
      <span id={reasonId} className="mx-reason">{t(disabledReason)}</span>
    </span>
  );
}

export function Alert({ tone = 'info', title, children, role }: { tone?: Tone; title?: TextLike; children?: ReactNode; role?: 'alert' | 'status' }) {
  const t = useText();
  const mark = tone === 'ok' ? '✓' : tone === 'bad' || tone === 'warn' ? '!' : 'i';
  return (
    <div className={`mx-alert mx-tone-${tone}`} role={role ?? (tone === 'bad' ? 'alert' : 'status')}>
      <span className="mx-alert-mark" aria-hidden="true">{mark}</span>
      <div style={{ minWidth: 0 }}>
        {title ? <span className="mx-alert-title">{t(title)}</span> : null}
        {children}
      </div>
    </div>
  );
}

/**
 * The empty state of a list or a screen. `illustration` takes a scene of the illustration library
 * (src/illustrations, MOT-03, section L), so screens pick a scene without editing this component.
 */
export function EmptyState({ title, text, action, illustration }: { title: TextLike; text?: TextLike; action?: ReactNode; illustration?: ReactNode }) {
  const t = useText();
  return (
    <div className="mx-empty">
      {illustration ? <div className="mx-empty-art">{illustration}</div> : null}
      <div className="mx-empty-title">{t(title)}</div>
      {text ? <div className="mx-empty-text">{t(text)}</div> : null}
      {action ? <div className="mx-btn-group">{action}</div> : null}
    </div>
  );
}

export interface TabDef {
  id: string;
  label: TextLike;
  count?: number;
}

/** Tabs (WAI-ARIA tab pattern): arrow keys move between tabs. */
export function Tabs({ tabs, active, onChange, label }: { tabs: TabDef[]; active: string; onChange(id: string): void; label: TextLike }) {
  const t = useText();
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    onChange(next.id);
  };
  return (
    <div className="mx-tabs" role="tablist" aria-label={t(label)}>
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="mx-tab"
          aria-selected={tab.id === active}
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t(tab.label)}
          {typeof tab.count === 'number' ? <span className="mx-tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface Column<R> {
  key: string;
  label: TextLike;
  render(row: R): ReactNode;
  align?: 'left' | 'right';
  width?: number | string;
}

/** A table with 12px upper case headers; rows with `onRow` are clickable and keyboard reachable. */
export function Table<R>({ columns, rows, rowKey, onRow, empty, caption }: {
  columns: Column<R>[];
  rows: R[];
  rowKey(row: R): string;
  onRow?(row: R): void;
  empty?: ReactNode;
  caption?: TextLike;
}) {
  const t = useText();
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div className="mx-table-wrap">
      <table className="mx-table">
        {caption ? <caption style={{ textAlign: 'left', padding: '0 12px 8px', color: 'var(--tx2)', fontSize: 12 }}>{t(caption)}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'mx-num' : undefined} style={c.width ? { width: c.width } : undefined} scope="col">{t(c.label)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const open = onRow ? () => onRow(row) : undefined;
            return (
              <tr
                key={rowKey(row)}
                data-hov={onRow ? '' : undefined}
                tabIndex={onRow ? 0 : undefined}
                onClick={open}
                onKeyDown={open ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } : undefined}
              >
                {columns.map((c) => <td key={c.key} className={c.align === 'right' ? 'mx-num' : undefined}>{c.render(row)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A bar of `used` against `limit` (decorative: the text next to it carries the numbers); warns from 90%. */
export function Meter({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = pct >= 100 ? 'bad' : pct >= 90 ? 'warn' : 'acc';
  return (
    <span className="mx-meter" aria-hidden="true">
      <span style={{ width: `${pct}%`, background: `var(--${tone})` }} />
    </span>
  );
}

/** Previous and Next of a paged list, with "Page n of m". */
export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage(page: number): void }) {
  const lang = useLang();
  const t = useText();
  if (pages <= 1) return null;
  return (
    <div className="mx-row" style={{ justifyContent: 'flex-end', padding: '8px 12px' }}>
      <span className="mx-small">{fillText(UI_TEXT.page, { page, pages }, lang)}</span>
      <Button onClick={() => onPage(page - 1)} disabled={page <= 1}>{t(UI_TEXT.previous)}</Button>
      <Button onClick={() => onPage(page + 1)} disabled={page >= pages}>{t(UI_TEXT.next)}</Button>
    </div>
  );
}

/** Keeps a failure inside one screen or extension from blanking the whole app. */
export class Boundary extends Component<{ children?: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('host screen failed', error, info.componentStack);
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** The fallback of a failed screen part. */
export function Failed() {
  const t = useText();
  return <Alert tone="bad">{t(UI_TEXT.failed)}</Alert>;
}
