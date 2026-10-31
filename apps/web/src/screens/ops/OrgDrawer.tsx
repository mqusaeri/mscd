// The organisation drawer of the operator console (MILESTONE-2 M2-S12, MILESTONE-3 M3-09): Overview
// (`ops.organizations.get`, with the read-only end, the deletion and the last export of D.2), Status (the moves of
// Milestone 3 J.8), Export (`ops.exports.*`), Deletion (`ops.deletion.*`), Domains (M2-S11), Entitlements (M2-S10) and
// History (`ops.organizations.events`). Every change reads the detail again and tells the list (`onChanged`), so the
// row shows the new status, plan, domains, read-only end and deletion date.
import { useCallback, useEffect, useState } from 'react';
import type { HostContext } from '../types';
import { Badge, Card, Drawer, Facts, Pager, Table, Tabs } from '../ui';
import type { Column } from '../ui';
import { DeletionTab } from './DeletionTab';
import { DomainsTab } from './DomainsTab';
import { EntitlementsTab } from './EntitlementsTab';
import { ExportTab } from './ExportTab';
import { LoadState, useLoad } from './Health';
import { DELETION_STATUS_TEXT, EXPORT_STATUS_TEXT, instantDay } from './lifecycle-model';
import { LIFE_TEXT } from './lifecycle-text';
import type { OpsAdapter } from './model';
import { DOMAIN_LABEL, DOMAIN_TONE, EVENT_PAGE_SIZE, SOURCE_TEXT, dayText, whenText } from './org-model';
import type { EventPage, OrgDetail, StatusEvent } from './org-model';
import { StatusBadge, UsersOf, ValidUntil } from './org-parts';
import { ORG_TEXT } from './org-text';
import { StatusTab } from './StatusTab';

export type OrgTab = 'overview' | 'status' | 'export' | 'deletion' | 'domains' | 'entitlements' | 'history';

export const ORG_TABS: { id: OrgTab; label: readonly [string, string] }[] = [
  { id: 'overview', label: ORG_TEXT.tabOverview },
  { id: 'status', label: ORG_TEXT.tabStatus },
  { id: 'export', label: LIFE_TEXT.tabExport },
  { id: 'deletion', label: LIFE_TEXT.tabDeletion },
  { id: 'domains', label: ORG_TEXT.tabDomains },
  { id: 'entitlements', label: ORG_TEXT.tabEntitlements },
  { id: 'history', label: ORG_TEXT.tabHistory },
];

export function OverviewView({ ctx, detail }: { ctx: HostContext; detail: OrgDetail }) {
  const e = detail.entitlement;
  return (
    <Facts
      items={[
        { label: ORG_TEXT.factSlug, value: detail.slug, mono: true },
        { label: ORG_TEXT.factStatus, value: <StatusBadge ctx={ctx} status={detail.status} /> },
        { label: ORG_TEXT.factRegion, value: detail.region ?? '-' },
        { label: ORG_TEXT.factCreated, value: dayText(ctx, detail.createdAt) },
        { label: ORG_TEXT.factMembers, value: detail.memberCount },
        { label: ORG_TEXT.factSystems, value: detail.systemCount },
        { label: ORG_TEXT.factPlan, value: e ? (e.plan ?? '-') : ctx.li(ORG_TEXT.noEntitlement) },
        ...(e
          ? [
            { label: ORG_TEXT.factSource, value: ctx.li(SOURCE_TEXT[e.source]) },
            { label: ORG_TEXT.factUsersLimit, value: <UsersOf ctx={ctx} used={detail.memberCount} limit={e.maxUsers} /> },
            { label: ORG_TEXT.factSystemsLimit, value: <UsersOf ctx={ctx} used={detail.systemCount} limit={e.maxManagementSystems} /> },
            { label: ORG_TEXT.factValidUntil, value: <ValidUntil ctx={ctx} validUntil={e.validUntil} hasPlan /> },
          ]
          : []),
        {
          label: ORG_TEXT.factDomains,
          value: detail.domains.length ? (
            <span className="mx-stack" style={{ gap: 6 }}>
              {detail.domains.map((d) => (
                <span key={d.domain} className="mx-row">
                  <span className="mx-mono">{d.domain}</span>
                  <Badge tone={DOMAIN_TONE[d.status]}>{ctx.li(DOMAIN_LABEL[d.status])}</Badge>
                </span>
              ))}
            </span>
          ) : ctx.li(ORG_TEXT.noDomains),
        },
        { label: ORG_TEXT.factLastSignIn, value: detail.lastSignInAt ? whenText(ctx, detail.lastSignInAt) : ctx.li(ORG_TEXT.noSignIn) },
        ...(detail.offboardingEndsAt ? [{ label: LIFE_TEXT.factReadOnlyUntil, value: dayText(ctx, instantDay(detail.offboardingEndsAt)) }] : []),
        {
          label: LIFE_TEXT.factDeletion,
          value: detail.deletion
            ? ctx.fill(LIFE_TEXT.deletionOn, { status: ctx.li(DELETION_STATUS_TEXT[detail.deletion.status]), date: dayText(ctx, instantDay(detail.deletion.scheduledFor)) })
            : ctx.li(LIFE_TEXT.noDeletion),
        },
        {
          label: LIFE_TEXT.factLastExport,
          value: detail.lastExport
            ? (detail.lastExport.readyAt
              ? ctx.fill(LIFE_TEXT.lastExportReady, { status: ctx.li(EXPORT_STATUS_TEXT[detail.lastExport.status]), date: dayText(ctx, instantDay(detail.lastExport.readyAt)) })
              : ctx.li(EXPORT_STATUS_TEXT[detail.lastExport.status]))
            : ctx.li(LIFE_TEXT.noExportYet),
        },
      ]}
    />
  );
}

export function HistoryTable({ ctx, events }: { ctx: HostContext; events: StatusEvent[] }) {
  const columns: Column<StatusEvent>[] = [
    { key: 'when', label: ORG_TEXT.colWhen, render: (e) => whenText(ctx, e.at) },
    {
      key: 'change',
      label: ORG_TEXT.colChange,
      render: (e) => (
        <span className="mx-row">
          <StatusBadge ctx={ctx} status={e.from} />
          <span aria-hidden="true">{'→'}</span>
          <StatusBadge ctx={ctx} status={e.to} />
        </span>
      ),
    },
    { key: 'reason', label: ORG_TEXT.colReason, render: (e) => <span style={{ overflowWrap: 'anywhere' }}>{e.reason}</span> },
    { key: 'by', label: ORG_TEXT.colBy, render: (e) => e.actor?.displayName ?? ctx.li(ORG_TEXT.commandLine) },
  ];
  return <Table columns={columns} rows={events} rowKey={(e) => e.id} />;
}

export function HistoryTab({ ctx, adapter, slug, tick }: { ctx: HostContext; adapter: OpsAdapter; slug: string; tick: number }) {
  const [page, setPage] = useState(1);
  // `tick` reads the history again after a status change.
  const load = useCallback(() => adapter.events(slug, page, EVENT_PAGE_SIZE), [adapter, slug, page, tick]);
  const { result, reload } = useLoad<EventPage>(load);
  let body;
  if (!result || !result.ok) body = <div style={{ padding: 'var(--pad)' }}><LoadState ctx={ctx} result={result} failed={ORG_TEXT.historyFailed} retry={reload} /></div>;
  else if (!result.data.items.length) body = <div style={{ padding: 'var(--pad)' }}><span className="mx-muted">{ctx.li(ORG_TEXT.noHistory)}</span></div>;
  else {
    body = (
      <>
        <HistoryTable ctx={ctx} events={result.data.items} />
        <Pager page={page} pages={Math.max(1, Math.ceil(result.data.total / result.data.pageSize))} onPage={setPage} />
      </>
    );
  }
  return <Card title={ORG_TEXT.history} sub={ORG_TEXT.historySub} flush>{body}</Card>;
}

export function OrgDrawer({ ctx, adapter, slug, name, onClose, onChanged, initialTab = 'overview' }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  slug: string;
  name: string;
  onClose(): void;
  /** Something of the organisation changed: the list reads it again. */
  onChanged(): void;
  initialTab?: OrgTab;
}) {
  const [tab, setTab] = useState<OrgTab>(initialTab);
  const [tick, setTick] = useState(0);
  const load = useCallback(() => adapter.organization(slug), [adapter, slug, tick]);
  const { result, reload } = useLoad<OrgDetail>(load);
  // Keeps the last detail on screen while it is read again after a change.
  const [shown, setShown] = useState<OrgDetail | null>(null);
  useEffect(() => {
    if (result && result.ok) setShown(result.data);
  }, [result]);
  const detail = result && result.ok ? result.data : shown;
  const changed = () => {
    setTick((t) => t + 1);
    onChanged();
  };
  let body;
  if (!detail) body = <LoadState ctx={ctx} result={result} failed={ORG_TEXT.detailFailed} retry={reload} />;
  else if (tab === 'overview') body = <Card><OverviewView ctx={ctx} detail={detail} /></Card>;
  else if (tab === 'status') body = <StatusTab ctx={ctx} adapter={adapter} detail={detail} tick={tick} onChanged={changed} />;
  else if (tab === 'export') body = <ExportTab ctx={ctx} adapter={adapter} detail={detail} onChanged={changed} />;
  else if (tab === 'deletion') body = <DeletionTab ctx={ctx} adapter={adapter} detail={detail} tick={tick} onChanged={changed} />;
  else if (tab === 'domains') body = <DomainsTab ctx={ctx} adapter={adapter} detail={detail} onChanged={changed} />;
  else if (tab === 'entitlements') body = <EntitlementsTab ctx={ctx} adapter={adapter} detail={detail} onChanged={changed} />;
  else body = <HistoryTab ctx={ctx} adapter={adapter} slug={slug} tick={tick} />;
  return (
    <Drawer open title={detail?.name ?? name} crumb={ORG_TEXT.crumb} onClose={onClose}>
      <div className="mx-stack" data-org-drawer={slug}>
        {detail ? (
          <div className="mx-row">
            <span className="mx-mono mx-small">{detail.slug}</span>
            <StatusBadge ctx={ctx} status={detail.status} />
          </div>
        ) : null}
        <Tabs tabs={ORG_TABS} active={tab} onChange={(id) => setTab(id as OrgTab)} label={ORG_TEXT.drawerTabs} />
        <div className="mx-stack" role="tabpanel" data-org-tab={tab}>{body}</div>
      </div>
    </Drawer>
  );
}
