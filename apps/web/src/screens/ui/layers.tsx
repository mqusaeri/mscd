// Modal, drawer and confirmation dialog of the UI kit (MILESTONE-2 C.6). They portal into the host layer
// (`ctx.layer()`, the hostLayer slot at the .mscd root), so they sit inside the token and theme scope and outside the
// animated main column, and they keep the geometry and inline z-index values of the generated layers: modal backdrop
// 50 and dialog 51 at 520px, drawer backdrop 40 and panel 41 at 560px. The E2E helpers find them by those values.
//
// Each layer has role="dialog", aria-modal and aria-labelledby, moves the focus to its first field when it opens and
// back to where it was when it closes, keeps Tab inside, and closes on Escape through a document listener that stops
// the event, so the controller's own Escape handling (generated drawer and menus) is not triggered as well. Only the
// top layer of a stack (a confirmation over a drawer) reacts.
import { useContext, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './core';
import type { Tone } from './core';
import { HostCtx } from './host-context';
import { TextInput, Field } from './fields';
import { UI_TEXT, fillText, useLang, useText } from './text';
import type { TextLike } from './text';

const STACK: object[] = [];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const FIELDS = 'input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled])';

/** Focus, Escape and Tab handling of an open layer. */
function useLayerFocus(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const token = {};
    STACK.push(token);
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>(FIELDS) ?? el;
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (STACK[STACK.length - 1] !== token) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === firstItem || document.activeElement === el)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = STACK.indexOf(token);
      if (at >= 0) STACK.splice(at, 1);
      if (before && typeof before.focus === 'function' && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [open, ref]);
}

/** Renders into the host layer when there is one (browser), else in place (server rendering in unit tests). */
function useLayerTarget(layer?: HTMLElement | null): HTMLElement | null {
  const host = useContext(HostCtx);
  if (layer !== undefined) return layer;
  return host ? host.layer() : null;
}

function inLayer(node: ReactNode, target: HTMLElement | null) {
  return target ? createPortal(node, target) : <>{node}</>;
}

const BACKDROP: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(20,16,10,.35)', zIndex: 50 };

export interface ModalProps {
  open: boolean;
  title: TextLike;
  sub?: TextLike;
  onClose(): void;
  children?: ReactNode;
  footer?: ReactNode;
  /** The layer element; default the host context's `layer()`. */
  layer?: HTMLElement | null;
}

export function Modal({ open, title, sub, onClose, children, footer, layer }: ModalProps) {
  const t = useText();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const target = useLayerTarget(layer);
  useLayerFocus(open, ref, onClose);
  if (!open) return null;
  return inLayer(
    <>
      <div onClick={onClose} style={BACKDROP} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={sub ? `${id}-sub` : undefined}
        tabIndex={-1}
        className="mx-dialog"
        style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 520, maxWidth: '92vw', maxHeight: '88vh', zIndex: 51, border: '1px solid var(--bd)', borderRadius: 14 }}
      >
        <div className="mx-dialog-head">
          <h2 id={`${id}-title`} className="mx-dialog-title">{t(title)}</h2>
          {sub ? <div id={`${id}-sub`} className="mx-dialog-sub">{t(sub)}</div> : null}
        </div>
        <div className="mx-dialog-body">{children}</div>
        {footer ? <div className="mx-dialog-foot">{footer}</div> : null}
      </div>
    </>,
    target,
  );
}

export interface DrawerProps {
  open: boolean;
  title: TextLike;
  /** Small line above the title (the screen or record kind). */
  crumb?: TextLike;
  onClose(): void;
  children?: ReactNode;
  footer?: ReactNode;
  layer?: HTMLElement | null;
}

export function Drawer({ open, title, crumb, onClose, children, footer, layer }: DrawerProps) {
  const t = useText();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const target = useLayerTarget(layer);
  useLayerFocus(open, ref, onClose);
  if (!open) return null;
  return inLayer(
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(20,16,10,.25)', zIndex: 40 }} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        className="mx-dialog"
        style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 560, maxWidth: '100vw', zIndex: 41, overflow: 'auto', borderLeft: '1px solid var(--bd)', animation: 'drawerIn .22s ease' }}
      >
        <div className="mx-drawer-head">
          <div style={{ minWidth: 0 }}>
            {crumb ? <div className="mx-small">{t(crumb)}</div> : null}
            <h2 id={`${id}-title`} className="mx-dialog-title" style={{ fontSize: '1.2em' }}>{t(title)}</h2>
          </div>
          <button type="button" className="mx-close" onClick={onClose} title={t(UI_TEXT.close)} aria-label={t(UI_TEXT.close)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="mx-drawer-body">{children}</div>
        {footer ? <div className="mx-dialog-foot" style={{ position: 'sticky', bottom: 0, background: 'var(--sur)' }}>{footer}</div> : null}
      </div>
    </>,
    target,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: TextLike;
  body: ReactNode;
  confirmLabel: TextLike;
  tone?: Extract<Tone, 'bad' | 'acc'>;
  busy?: boolean;
  /** Text the person must type before Confirm is enabled (removals with consequences). */
  requireText?: string;
  error?: TextLike | null;
  onConfirm(): void;
  onCancel(): void;
  layer?: HTMLElement | null;
}

export function ConfirmDialog({ open, title, body, confirmLabel, tone = 'acc', busy, requireText, error, onConfirm, onCancel, layer }: ConfirmDialogProps) {
  const t = useText();
  const lang = useLang();
  const [typed, setTyped] = useState('');
  useEffect(() => { if (!open) setTyped(''); }, [open]);
  const blocked = Boolean(requireText) && typed.trim() !== requireText;
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      layer={layer}
      footer={(
        <>
          <Button onClick={onCancel}>{t(UI_TEXT.cancel)}</Button>
          <Button variant={tone === 'bad' ? 'danger' : 'primary'} busy={busy} disabled={blocked} onClick={onConfirm}>{t(confirmLabel)}</Button>
        </>
      )}
    >
      <div className="mx-muted">{body}</div>
      {requireText ? (
        <Field label={fillText(UI_TEXT.typeToConfirm, { text: requireText }, lang)}>
          <TextInput value={typed} onChange={setTyped} autoComplete="off" />
        </Field>
      ) : null}
      {error ? <div className="mx-error" role="alert">{t(error)}</div> : null}
    </Modal>
  );
}
