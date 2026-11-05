// Shared parts of the Retention and disposal tabs (MILESTONE-3 M3-06): loading a list of the adapter into state, the
// loading and error lines of a card, a person with a date, and the item cell (code and title).
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext } from '../types';
import { Alert, Button } from '../ui';
import { formatInstant } from '../auditor-access/shared';
import type { PersonRef, ReviewFile, ReviewModel, Result } from './model';
import { FILE_ACTION_TEXT, fileActionOfFiles, itemLabel, settled } from './model';
import { retentionVersion, subscribeRetention } from './store';
import { TEXT } from './text';

export type Loaded<T> = { loading: boolean; data: T | null; error: ApiError | null; reload(): void };

/** Loads a list of the adapter into state; it reads again on `reload` and after every retention command. */
export function useLoad<T>(load: () => Promise<Result<T>>, deps: unknown[]): Loaded<T> {
  const changed = useSyncExternalStore(subscribeRetention, retentionVersion, retentionVersion);
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: ApiError | null }>({ loading: true, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    void settled(load()).then((res) => {
      if (!live) return;
      setState(res.ok ? { loading: false, data: res.data, error: null } : { loading: false, data: null, error: res.error });
    });
    return () => {
      live = false;
    };
  }, [...deps, tick, changed]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** The loading line and the error alert of a list card. */
export function LoadState({ ctx, list }: { ctx: HostContext; list: Loaded<unknown> }) {
  return (
    <>
      {list.loading && !list.data ? <div className="mx-small" role="status" style={{ padding: 12 }}>{ctx.li(TEXT.loading)}</div> : null}
      {list.error ? (
        <div style={{ padding: 12 }}>
          <Alert tone="bad" title={TEXT.loadFailed}>
            <span style={{ display: 'block' }}>{ctx.li(list.error.message)}</span>
            <Button variant="link" onClick={list.reload}>{ctx.li(TEXT.tryAgain)}</Button>
          </Alert>
        </div>
      ) : null}
    </>
  );
}

/** A record: its code in bold and its title below. */
export function ItemCell({ row }: { row: Pick<ReviewModel, 'itemCode' | 'itemTitle' | 'itemId'> }) {
  return (
    <span style={{ display: 'block', minWidth: 0 }}>
      <strong className="mx-mono" style={{ overflowWrap: 'anywhere' }}>{itemLabel(row)}</strong>
      {row.itemTitle && row.itemCode ? <span className="mx-small" style={{ display: 'block', overflowWrap: 'anywhere' }}>{row.itemTitle}</span> : null}
    </span>
  );
}

/** The files of a review item and what a disposal does with each (M3-13). */
export function FilesList({ ctx, files }: { ctx: HostContext; files: readonly ReviewFile[] }) {
  if (files.length === 0) return null;
  const actionText = (f: ReviewFile) =>
    f.action === 'kept_in_use' ? ctx.fill(TEXT.fileKept, { code: f.usedBy ?? '-' }) : ctx.li(f.action === 'delete' ? TEXT.fileDelete : TEXT.fileOwner);
  return (
    <div className="mx-small" data-files="retention">
      <span style={{ fontWeight: 600 }}>{ctx.li(TEXT.filesTitle)}</span>
      <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
        {files.map((f, i) => (
          <li key={`${f.name ?? ''}-${i}`} data-file-action={f.action} style={{ overflowWrap: 'anywhere' }}>
            {`${f.name ?? '-'} (${f.repository}): ${actionText(f)}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the disposal register will record for the files of an item once its disposal is approved (`fileActionOfFiles`,
 * the rule of the server): shown in the approve dialog, so a file kept because another record uses it reads "File kept:
 * used by another record" before the approval, as in the register (M3-15). Nothing for an item without files.
 */
export function RegisterFileAction({ ctx, files }: { ctx: HostContext; files: readonly ReviewFile[] }) {
  if (files.length === 0) return null;
  const action = fileActionOfFiles(files);
  return (
    <p className="mx-small" style={{ margin: 0 }} data-register-file-action={action}>
      <span style={{ display: 'block', fontWeight: 600 }}>{ctx.li(TEXT.approveFileAction)}</span>
      {ctx.li(FILE_ACTION_TEXT[action])}
    </p>
  );
}

/** A person and the instant of their step, or `-`. */
export function PersonAt({ ctx, who, at }: { ctx: HostContext; who: PersonRef | null; at: string | null }) {
  if (!who) return <span className="mx-muted">-</span>;
  return (
    <span style={{ display: 'block' }}>
      {who.displayName}
      {at ? <span className="mx-small" style={{ display: 'block' }}>{formatInstant(at, ctx.lang)}</span> : null}
    </span>
  );
}
