// Auditor access (MILESTONE-2 M2-15): the auditor workspace of a management system. "Guest access" lists the guest
// auditor grants (email, created, expires, last used, revoked) with "Revoke" and "Grant access" for the MS Manager
// (`auditor_access.grant`); "Evidence packs" lists the packs built for the audits (status, built at, repository, item
// count) with "Download manifest" and "Download archive" for everyone who reads the system (`ms.read`).
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import type { HostContext, ScreenProps } from '../types';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Pager, Table, Tabs } from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import { adapterFor } from './adapter';
import { GrantDialog } from './GrantDialog';
import { GRANT_STATE_TEXT, GRANT_STATE_TONE, PACK_FILE_TEXT, PACK_STATUS_TEXT, PACK_STATUS_TONE, asApiResult, grantState, mayGrant, settled } from './model';
import type { GrantModel, PackFile, PackModel } from './model';
import { formatInstant, saveFile } from './shared';
import { grantsMade, noteGranted, subscribeGrant } from './store';
import { TEXT } from './text';

const PAGE_SIZE = 20;
const personName = (ctx: HostContext, handle: string | null | undefined) => (handle ? ctx.D?.PEOPLE?.[handle]?.[0] ?? handle : '-');

type Loaded<T> = { loading: boolean; data: T | null; error: ApiError | null };

/** Loads a list of the adapter into state; `reload` reads it again. Never rejects (a failed load is an error). */
function useLoad<T>(load: () => Promise<{ ok: true; data: T } | { ok: false; error: ApiError }>, deps: unknown[]): Loaded<T> & { reload(): void } {
  const [state, setState] = useState<Loaded<T>>({ loading: true, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    settled(load()).then((res) => {
      if (!live) return;
      setState(res.ok ? { loading: false, data: res.data, error: null } : { loading: false, data: null, error: res.error });
    });
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export function GrantsTab({ ctx, ms }: { ctx: HostContext; ms: MsId }) {
  const adapter = adapterFor(ctx);
  const made = useSyncExternalStore(subscribeGrant, grantsMade, grantsMade);
  const list = useLoad(() => adapter.grants(ms), [ms, made]);
  const [revoking, setRevoking] = useState<GrantModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const confirm = () => {
    if (!revoking) return;
    setBusy(true);
    setError(null);
    ctx.track(asApiResult(adapter.revoke(ms, revoking))).then((res) => {
      setBusy(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      ctx.toast(ctx.fill(TEXT.revoked, { email: revoking.email }));
      setRevoking(null);
      list.reload();
    });
  };
  const columns: Column<GrantModel>[] = [
    { key: 'email', label: TEXT.colEmail, render: (g) => <span style={{ overflowWrap: 'anywhere' }}>{g.email}</span> },
    {
      key: 'created', label: TEXT.colCreated,
      render: (g) => (
        <span>{formatInstant(g.createdAt, ctx.lang)}<span className="mx-small" style={{ display: 'block' }}>{ctx.fill(TEXT.byWhom, { name: personName(ctx, g.createdBy) })}</span></span>
      ),
    },
    { key: 'expires', label: TEXT.colExpires, render: (g) => formatInstant(g.expiresAt, ctx.lang) },
    {
      key: 'used', label: TEXT.colUsed,
      render: (g) => (g.lastUsedAt || g.linkUsedAt ? (
        <span>{formatInstant(g.lastUsedAt ?? g.linkUsedAt, ctx.lang)}{g.linkUsedAt ? <span className="mx-small" style={{ display: 'block' }}>{ctx.fill(TEXT.linkOpened, { at: formatInstant(g.linkUsedAt, ctx.lang) })}</span> : null}</span>
      ) : <span className="mx-muted">{ctx.li(TEXT.notUsed)}</span>),
    },
    {
      key: 'status', label: TEXT.colStatus,
      render: (g) => {
        const state = grantState(g);
        return (
          <span>
            <Badge tone={GRANT_STATE_TONE[state]}>{ctx.li(GRANT_STATE_TEXT[state])}</Badge>
            {g.revokedAt ? <span className="mx-small" style={{ display: 'block', marginTop: 4 }}>{ctx.fill(TEXT.revokedBy, { at: formatInstant(g.revokedAt, ctx.lang), name: personName(ctx, g.revokedBy) })}</span> : null}
          </span>
        );
      },
    },
    { key: 'actions', label: TEXT.colActions, render: (g) => (grantState(g) === 'active' ? <Button onClick={() => { setError(null); setRevoking(g); }}>{ctx.li(TEXT.revoke)}</Button> : null) },
  ];
  return (
    <Card title={TEXT.tabGrants} flush>
      {list.loading && !list.data ? <div className="mx-small" role="status" style={{ padding: 12 }}>{ctx.li(TEXT.loading)}</div> : null}
      {list.error ? (
        <div style={{ padding: 12 }}>
          <Alert tone="bad" title={TEXT.grantsFailed}><Button variant="link" onClick={list.reload}>{ctx.li(TEXT.tryAgain)}</Button></Alert>
        </div>
      ) : null}
      {list.data ? (
        <Table
          columns={columns}
          rows={list.data}
          rowKey={(g) => g.id}
          empty={<EmptyState title={TEXT.noGrants} text={TEXT.noGrantsText} illustration={<Illustration scene="no-documents" size="sm" decorative />} />}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(revoking)}
        title={TEXT.revokeTitle}
        body={<p style={{ margin: 0 }}>{revoking ? ctx.fill(TEXT.revokeBody, { email: revoking.email }) : ''}</p>}
        confirmLabel={TEXT.revoke}
        tone="bad"
        busy={busy}
        error={error ? error.message : null}
        onConfirm={confirm}
        onCancel={() => setRevoking(null)}
      />
    </Card>
  );
}

export function PacksTab({ ctx, ms }: { ctx: HostContext; ms: MsId }) {
  const adapter = adapterFor(ctx);
  const [page, setPage] = useState(1);
  const list = useLoad(() => adapter.packs(ms, page, PAGE_SIZE), [ms, page]);
  const system = ctx.D?.MS?.find((m) => m.id === ms) ?? null;
  const repository = system ? ctx.D?.LOC?.[system.loc]?.[0] ?? null : null;
  const download = (pack: PackModel, file: PackFile) => {
    settled(adapter.download(ms, pack, file)).then((res) => {
      if (res.ok) saveFile(res.data);
      else ctx.toast(ctx.li(res.error.message));
    });
  };
  const columns: Column<PackModel>[] = [
    { key: 'status', label: TEXT.colPackStatus, render: (p) => <Badge tone={PACK_STATUS_TONE[p.status]}>{ctx.li(PACK_STATUS_TEXT[p.status])}</Badge> },
    { key: 'built', label: TEXT.colBuilt, render: (p) => (p.builtAt ? formatInstant(p.builtAt, ctx.lang) : <span className="mx-muted">{ctx.li(TEXT.notBuilt)}</span>) },
    {
      key: 'repository', label: TEXT.colRepository,
      render: (p) => (
        <span style={{ overflowWrap: 'anywhere' }}>{repository ?? '-'}{p.packFolder ? <span className="mx-small mx-mono" style={{ display: 'block' }}>{p.packFolder}</span> : null}</span>
      ),
    },
    { key: 'items', label: TEXT.colItems, render: (p) => ctx.fill(TEXT.itemsLine, { n: p.itemCount, x: p.exceptionCount }) },
    {
      key: 'download', label: TEXT.colDownload,
      render: (p) => (
        <span className="mx-row" style={{ alignItems: 'flex-start' }}>
          {p.files.map((f) => <Button key={f} variant="link" onClick={() => download(p, f)}>{ctx.li(PACK_FILE_TEXT[f])}</Button>)}
        </span>
      ),
    },
  ];
  const total = list.data?.total ?? 0;
  return (
    <Card title={TEXT.tabPacks} flush>
      {list.loading && !list.data ? <div className="mx-small" role="status" style={{ padding: 12 }}>{ctx.li(TEXT.loading)}</div> : null}
      {list.error ? (
        <div style={{ padding: 12 }}>
          <Alert tone="bad" title={TEXT.packsFailed}><Button variant="link" onClick={list.reload}>{ctx.li(TEXT.tryAgain)}</Button></Alert>
        </div>
      ) : null}
      {list.data ? (
        <Table
          columns={columns}
          rows={list.data.items}
          rowKey={(p) => p.id}
          empty={<EmptyState title={TEXT.noPacks} text={TEXT.noPacksText} illustration={<Illustration scene="no-evidence" size="sm" decorative />} />}
        />
      ) : null}
      <Pager page={page} pages={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPage={setPage} />
    </Card>
  );
}

export default function AuditorAccessScreen({ ctx }: ScreenProps) {
  const ms = ctx.msObj?.id ?? null;
  const grants = mayGrant(ctx, ms);
  const [tab, setTab] = useState<'grants' | 'packs'>(grants ? 'grants' : 'packs');
  const [granting, setGranting] = useState(false);
  const asked = ctx.params.grant;
  useEffect(() => {
    if (asked && grants) setGranting(true);
  }, [asked]);
  if (!ms) return null;
  const active = grants ? tab : 'packs';
  return (
    <>
      {grants ? (
        <Tabs
          label={TEXT.tabsLabel}
          active={active}
          onChange={(id) => setTab(id as 'grants' | 'packs')}
          tabs={[{ id: 'grants', label: TEXT.tabGrants }, { id: 'packs', label: TEXT.tabPacks }]}
        />
      ) : null}
      {active === 'grants' ? <GrantsTab ctx={ctx} ms={ms} /> : <PacksTab ctx={ctx} ms={ms} />}
      {granting ? (
        <GrantDialog
          ctx={ctx}
          ms={ms}
          onClose={() => setGranting(false)}
          onGranted={(text) => {
            setGranting(false);
            ctx.toast(text);
            setTab('grants');
            noteGranted();
          }}
        />
      ) : null}
    </>
  );
}
