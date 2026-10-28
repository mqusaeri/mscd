// The drawers a claim of the Storage repositories screen opens (MILESTONE-2 M2-09): the "Connect repository" wizard,
// or the settings of the card's repository. It loads the repositories with the build's adapter and, after every
// change, reloads them and the organisation snapshot, so the cards of the Storage repositories screen follow (D2-08).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext } from '../types';
import { Alert, Button, Drawer, UI_TEXT } from '../ui';
import { adapterFor, settled } from './adapter';
import type { AdminData, RepoModel } from './model';
import { ConnectWizard, RepositoryPanel, errorText } from './panels';
import type { StorageRequest } from './store';
import { TEXT } from './text';

/** The repository a settings request names: by its uuid, else by its short id. */
export function repoOf(data: AdminData | null, request: StorageRequest): RepoModel | null {
  if (!data || request.kind !== 'settings') return null;
  return data.repos.find((r) => (request.ref && r.ref === request.ref) || (!request.ref && request.slug && r.slug === request.slug)) ?? null;
}

export default function LayerHost({ ctx, request, onClose }: { ctx: HostContext; request: StorageRequest; onClose(): void }) {
  const snapshot = useRef(ctx.D);
  snapshot.current = ctx.D;
  const context = useRef(ctx);
  context.current = ctx;
  const adapter = useMemo(() => adapterFor(context.current, () => snapshot.current), []);
  const [data, setData] = useState<AdminData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(() => {
    setError(null);
    settled(adapter.load()).then((res) => {
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
  }, [adapter]);
  useEffect(() => load(), [load]);
  const changed = useCallback(() => {
    load();
    // A reload that fails (the session ended, for example) leaves the screen as it is; the shell handles the sign-in.
    context.current.reload().catch(() => undefined);
  }, [load]);
  const title = request.kind === 'connect' ? TEXT.wizardTitle : TEXT.settings;
  if (error) {
    return (
      <Drawer open title={title} crumb={TEXT.crumb} onClose={onClose}>
        <Alert tone="bad" title={TEXT.loadFailed}>
          <div>{errorText(ctx, error)}</div>
          <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
        </Alert>
      </Drawer>
    );
  }
  if (!data) {
    return (
      <Drawer open title={title} crumb={TEXT.crumb} onClose={onClose}>
        <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div>
      </Drawer>
    );
  }
  if (request.kind === 'connect') return <ConnectWizard ctx={ctx} adapter={adapter} data={data} open onClose={onClose} onChanged={changed} />;
  const openAdmin = () => {
    onClose();
    context.current.go('storage-admin');
  };
  return <RepositoryPanel ctx={ctx} adapter={adapter} data={data} repo={repoOf(data, request)} open onClose={onClose} onChanged={changed} onOpenAdmin={openAdmin} />;
}
