// Repository administration (MILESTONE-2 M2-09, screen `storage-admin`, no sidebar entry): every repository of the
// organisation with its storage type, modes, connection and credential, "Connect repository" (the wizard) and
// "Settings" per repository. The Storage repositories screen opens the same drawers through its claims (actions.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext, ScreenProps } from '../types';
import { Alert, Badge, Button, Card, EmptyState, Table, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { adapterFor, settled } from './adapter';
import { ADAPTER_SHORT, MODE_LABELS, OWNERSHIP_LABELS, labelOf } from './labels';
import type { AdminData, RepoModel } from './model';
import { ConnectWizard, ConnectionBadge, RepositoryPanel, errorText, formatDay } from './panels';
import { TEXT } from './text';

/** The credential cell of a repository: not needed for the vault, set (with its expiry) or not set. */
export function credentialText(ctx: HostContext, repo: RepoModel): { text: string; tone: 'ok' | 'warn' | 'mute' } {
  if (repo.adapter === 'managed_vault') return { text: ctx.li(TEXT.credNone), tone: 'mute' };
  if (!repo.credentialSet) return { text: ctx.li(TEXT.credNotSet), tone: 'warn' };
  return { text: repo.credentialExpiresAt ? ctx.fill(TEXT.credExpires, { date: formatDay(ctx, repo.credentialExpiresAt) }) : ctx.li(TEXT.credSet), tone: 'ok' };
}

/** The table of repositories. */
export function RepositoryTable({ ctx, repos, onSettings }: { ctx: HostContext; repos: RepoModel[]; onSettings?(repo: RepoModel): void }) {
  const columns: Column<RepoModel>[] = [
    {
      key: 'name',
      label: TEXT.colName,
      render: (r) => (
        <>
          <div style={{ fontWeight: 600 }}>{r.name}</div>
          <div className="mx-small mx-mono">{r.slug}</div>
        </>
      ),
    },
    {
      key: 'storage',
      label: TEXT.colStorage,
      render: (r) => (
        <>
          <div>{ctx.li(labelOf(ADAPTER_SHORT, r.adapter))}</div>
          <div className="mx-small">{ctx.li(labelOf(OWNERSHIP_LABELS, r.ownershipType))}</div>
        </>
      ),
    },
    { key: 'modes', label: TEXT.colModes, render: (r) => r.modes.map((m) => ctx.li(labelOf(MODE_LABELS, m))).join(', ') || '-' },
    {
      key: 'connection',
      label: TEXT.colConnection,
      render: (r) => (
        <div className="mx-stack" style={{ gap: 4 }}>
          <span className="mx-row">
            <ConnectionBadge ctx={ctx} status={r.connectionStatus} />
            {r.readOnly ? <Badge tone="mute">{ctx.li(TEXT.readOnly)}</Badge> : null}
          </span>
          {r.message ? <span className="mx-small">{ctx.li(r.message)}</span> : null}
          <span className="mx-small">{ctx.li(r.summary)}</span>
        </div>
      ),
    },
    {
      key: 'credential',
      label: TEXT.colCredential,
      render: (r) => {
        const c = credentialText(ctx, r);
        return <Badge tone={c.tone}>{c.text}</Badge>;
      },
    },
    { key: 'systems', label: TEXT.colSystems, render: (r) => (r.systems.length ? r.systems.join(', ') : '-') },
  ];
  if (onSettings) {
    columns.push({
      key: 'actions',
      label: TEXT.colActions,
      render: (r) => <Button onClick={(e) => { e.stopPropagation(); onSettings(r); }}>{ctx.li(TEXT.settings)}</Button>,
    });
  }
  return <Table columns={columns} rows={repos} rowKey={(r) => r.ref} onRow={onSettings} />;
}

type LoadState = { loading: boolean; data: AdminData | null; error: ApiError | null };

export default function StorageAdminScreen({ ctx }: ScreenProps) {
  const snapshot = useRef(ctx.D);
  snapshot.current = ctx.D;
  const context = useRef(ctx);
  context.current = ctx;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(context.current, () => snapshot.current), [client]);
  const [state, setState] = useState<LoadState>({ loading: true, data: null, error: null });
  const [wizard, setWizard] = useState(false);
  const [settingsOf, setSettingsOf] = useState<string | null>(null);
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    settled(adapter.load()).then((res) => setState(res.ok ? { loading: false, data: res.data, error: null } : { loading: false, data: null, error: res.error }));
  }, [adapter]);
  useEffect(() => load(), [load]);
  // The page action "Connect repository" opens the wizard through the screen params (index.tsx).
  const request = ctx.params.connect;
  useEffect(() => {
    if (request) setWizard(true);
  }, [request]);
  const changed = useCallback(() => {
    load();
    context.current.reload().catch(() => undefined);
  }, [load]);
  const canManage = ctx.orgCan('storage.repository.manage');
  const { data } = state;
  let body;
  if (state.loading && !data) body = <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div>;
  else if (state.error || !data) {
    body = (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <div>{state.error ? errorText(ctx, state.error) : null}</div>
        <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  } else {
    body = (
      <>
        {data.sample ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
        {!canManage ? <Alert tone="info">{ctx.li(TEXT.noManage)}</Alert> : null}
        <Card title={TEXT.repositories} sub={TEXT.repositoriesSub} flush>
          {data.repos.length ? (
            <RepositoryTable ctx={ctx} repos={data.repos} onSettings={canManage ? (r) => setSettingsOf(r.ref) : undefined} />
          ) : (
            <EmptyState
              title={TEXT.noRepos}
              text={TEXT.noReposText}
              action={canManage ? <Button variant="primary" onClick={() => setWizard(true)}>{ctx.li(TEXT.connect)}</Button> : null}
            />
          )}
        </Card>
      </>
    );
  }
  const repo = data && settingsOf ? data.repos.find((r) => r.ref === settingsOf) ?? null : null;
  return (
    <>
      {body}
      {data && canManage ? (
        <>
          <ConnectWizard ctx={ctx} adapter={adapter} data={data} open={wizard} onClose={() => setWizard(false)} onChanged={changed} />
          {settingsOf ? <RepositoryPanel ctx={ctx} adapter={adapter} data={data} repo={repo} open onClose={() => setSettingsOf(null)} onChanged={changed} /> : null}
        </>
      ) : null}
    </>
  );
}
