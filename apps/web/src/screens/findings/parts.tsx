// Small parts shared by the audit register screens of M2-14: loading a list with "Try again", the badges of findings
// and corrective actions, a warning list and the person and date cells.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, UI_TEXT } from '../ui';
import type { Classification, CaStatus, FindingStatus, SaStatus } from './model';
import {
  CA_STATUS_TEXT, CA_STATUS_TONE, CLASSIFICATION_TEXT, CLASSIFICATION_TONE, FINDING_STATUS_TEXT, FINDING_STATUS_TONE, SA_STATUS_TEXT, SA_STATUS_TONE,
} from './model';
import type { Result, Warn } from './shared';
import { settled } from './shared';
import { TEXT } from './text';

export interface Loaded<T> {
  loading: boolean;
  data: T | null;
  error: ApiError | null;
  reload(): void;
}

/**
 * Loads data with `run` when a key changes (the system, a tab) and on `reload()`. The latest answer wins; a load
 * never rejects (settled), so the screen always ends in data or an error with "Try again".
 */
export function useLoad<T>(run: () => Promise<Result<T>>, key: string, enabled = true): Loaded<T> {
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: ApiError | null }>({ loading: enabled, data: null, error: null });
  const [tick, setTick] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    settled(runRef.current()).then((res) => {
      if (!live) return;
      setState(res.ok ? { loading: false, data: res.data, error: null } : { loading: false, data: null, error: res.error });
    });
    return () => {
      live = false;
    };
  }, [key, tick, enabled]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** The body of a list that is loading or could not be loaded; null when the data is there. */
export function LoadState({ ctx, loaded, failed }: { ctx: HostContext; loaded: Loaded<unknown>; failed: TextPair }): ReactNode {
  if (loaded.error) {
    return (
      <Alert tone="bad" title={failed}>
        <div>{ctx.li(loaded.error.message)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={loaded.reload}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  }
  if (loaded.loading && loaded.data === null) return <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div>;
  return null;
}

export function ClassBadge({ ctx, value }: { ctx: HostContext; value: Classification }) {
  return <Badge tone={CLASSIFICATION_TONE[value]}>{ctx.li(CLASSIFICATION_TEXT[value])}</Badge>;
}

export function FindingStatusBadge({ ctx, value }: { ctx: HostContext; value: FindingStatus }) {
  return <Badge tone={FINDING_STATUS_TONE[value]}>{ctx.li(FINDING_STATUS_TEXT[value])}</Badge>;
}

export function ActionStatusBadge({ ctx, value }: { ctx: HostContext; value: CaStatus }) {
  return <Badge tone={CA_STATUS_TONE[value]}>{ctx.li(CA_STATUS_TEXT[value])}</Badge>;
}

export function SelfStatusBadge({ ctx, value }: { ctx: HostContext; value: SaStatus }) {
  return <Badge tone={SA_STATUS_TONE[value]}>{ctx.li(SA_STATUS_TEXT[value])}</Badge>;
}

/**
 * The buttons of a drawer footer, kept clear of the Tera button that floats at the bottom right corner of the shell
 * (fixed, 24px from the edges, 54px wide), so it never covers the primary action.
 */
export function DrawerFoot({ children }: { children: ReactNode }) {
  return <div className="mx-btn-group" style={{ marginRight: 72, justifyContent: 'flex-end' }}>{children}</div>;
}

/** Warnings of a write (warn-and-allow rules), each with its rule id. */
export function Warnings({ ctx, warnings }: { ctx: HostContext; warnings: readonly Warn[] }) {
  if (!warnings.length) return null;
  return (
    <>
      {warnings.map((w, i) => (
        <Alert key={`${w.rule}-${i}`} tone="warn" role="status">
          <span>{ctx.li(w.message)}</span>
          <span className="mx-small" style={{ display: 'block', marginTop: 2 }}>{w.rule}</span>
        </Alert>
      ))}
    </>
  );
}

/** The error of a refused write inside a form: the rule's message (with its rule id) or the api's message. */
export function FormError({ ctx, error }: { ctx: HostContext; error: ApiError | null }) {
  if (!error) return null;
  return (
    <Alert tone="bad" role="alert">
      <span>{ctx.li(error.message)}</span>
      {error.rule ? <span className="mx-small" style={{ display: 'block', marginTop: 2 }}>{error.rule}</span> : null}
    </Alert>
  );
}
