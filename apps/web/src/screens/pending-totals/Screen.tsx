// Open work totals (MILESTONE-3 M3-08, D.10): how much work is open and overdue along the chain of a management
// system, per chain stage and per business role, for Top Management, the Programme Owner and the Management System
// Manager (`audit.pending.aggregate`). The page shows counts only: no name, holder or due date (product decision 2).
//
// Tab "This system": the totals of the selected system and the stage by role table, or the `all-done` scene when
// nothing is open. Tab "All my systems": one row per system where the session holds the permission, from one call per
// system, with "Show table" to read the table of one of them. The tab is part of the screen's address (M2-20).
import { useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import { Illustration } from '../../illustrations';
import { useScreenTab } from '../../routing';
import type { HostContext, ScreenProps } from '../types';
import { Alert, Button, Card, EmptyState, Tabs } from '../ui';
import { adapterFor } from './adapter';
import {
  SCREEN_ID, TABS, TOTALS_PERM, onTime, overdueShare, roleColumns, roleLabel, roleTotals, stageLines, stagesOf, stagesWithWork, sumOf,
  systemName, systemTitle, systemsWithTotals,
} from './model';
import type { Count, PendingTotalsAdapter, RoleKey, StageLine, TabId, TotalsRow } from './model';
import { TEXT } from './text';
import './pending-totals.css';

const pair = (p: readonly [string, string]): [string, string] => [p[0], p[1]];

/** What a load of the totals of one system gives. */
export type LoadState =
  | { status: 'loading' }
  | { status: 'ok'; rows: TotalsRow[] }
  | { status: 'failed'; error: ApiError };

/** The totals of one system, loaded again when the system or `tick` changes; a late answer of an old load is ignored. */
export function useTotals(adapter: PendingTotalsAdapter, ms: MsId, tick: number): LoadState {
  const [state, setState] = useState<{ key: string; load: LoadState }>({ key: '', load: { status: 'loading' } });
  const key = `${ms}|${tick}`;
  useEffect(() => {
    let live = true;
    adapter.totals(ms).then(
      (res) => {
        if (!live) return;
        setState({ key, load: res.ok ? { status: 'ok', rows: res.data } : { status: 'failed', error: res.error } });
      },
      () => {
        if (live) setState({ key, load: { status: 'failed', error: { status: 0, message: pair(TEXT.loadFailed) } } });
      },
    );
    return () => {
      live = false;
    };
  }, [adapter, ms, key]);
  return state.key === key ? state.load : { status: 'loading' };
}

/** The totals of several systems, each loaded on its own; a system without an answer yet is `loading`. */
export function useAllTotals(adapter: PendingTotalsAdapter, systems: readonly MsId[], tick: number): Record<MsId, LoadState> {
  const [state, setState] = useState<{ key: string; loads: Record<MsId, LoadState> }>({ key: '', loads: {} });
  const key = `${systems.join(',')}|${tick}`;
  useEffect(() => {
    let live = true;
    const put = (ms: MsId, load: LoadState) => {
      if (live) setState((s) => ({ key, loads: { ...(s.key === key ? s.loads : {}), [ms]: load } }));
    };
    for (const ms of key.split('|')[0].split(',').filter(Boolean)) {
      adapter.totals(ms).then(
        (res) => put(ms, res.ok ? { status: 'ok', rows: res.data } : { status: 'failed', error: res.error }),
        () => put(ms, { status: 'failed', error: { status: 0, message: pair(TEXT.loadFailed) } }),
      );
    }
    return () => {
      live = false;
    };
  }, [adapter, key]);
  const loads = state.key === key ? state.loads : {};
  return Object.fromEntries(systems.map((ms) => [ms, loads[ms] ?? { status: 'loading' }]));
}

function Loading({ ctx }: { ctx: HostContext }) {
  return <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
}

function LoadFailed({ ctx, error, onRetry }: { ctx: HostContext; error: ApiError; onRetry(): void }) {
  return (
    <Alert tone="bad" title={TEXT.loadFailed}>
      <div className="mx-stack" style={{ gap: 8 }}>
        <span>{ctx.li(error.message)}</span>
        <div className="mx-btn-group"><Button onClick={onRetry}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </div>
    </Alert>
  );
}

function Stat({ label, value, sub, tone, name }: { label: string; value: string | number; sub?: string; tone?: 'bad'; name: string }) {
  return (
    <li className="mx-pt-stat" data-stat={name}>
      <span className="mx-pt-stat-label">{label}</span>
      <span className="mx-pt-stat-value" data-tone={tone} data-value="">{value}</span>
      {sub ? <span className="mx-pt-stat-sub">{sub}</span> : null}
    </li>
  );
}

/** The totals of the selected system: open, overdue or missing, on time and the stages with open work. */
export function SummaryCard({ ctx, ms, total, lines }: { ctx: HostContext; ms: MsId; total: Count; lines: StageLine[] }) {
  const stages = stagesWithWork(lines);
  return (
    <Card title={ctx.fill(TEXT.summaryTitle, { system: systemName(ctx, ms) })} sub={TEXT.summarySub}>
      <ul className="mx-pt-stats" data-total-open={total.open} data-total-overdue={total.overdue}>
        <Stat name="open" label={ctx.li(TEXT.statOpen)} value={total.open} />
        <Stat name="overdue" label={ctx.li(TEXT.statOverdue)} value={total.overdue} tone={total.overdue > 0 ? 'bad' : undefined} sub={ctx.fill(TEXT.shareValue, { n: overdueShare(total) })} />
        <Stat name="ontime" label={ctx.li(TEXT.statOnTime)} value={onTime(total)} sub={ctx.li(TEXT.onTimeSub)} />
        <Stat name="stages" label={ctx.li(TEXT.statStages)} value={ctx.fill(TEXT.stagesValue, stages)} sub={ctx.li(TEXT.stagesSub)} />
      </ul>
    </Card>
  );
}

/** One cell of the stage by role table: the open items and, under them, how many are overdue or missing. */
export function CountCell({ ctx, count }: { ctx: HostContext; count: Count | undefined }) {
  if (!count || count.open === 0) return <span className="mx-pt-zero">0</span>;
  return (
    <span className="mx-pt-cell">
      <span className="mx-pt-open">{count.open}</span>
      {count.overdue > 0 ? <span className="mx-pt-overdue">{ctx.fill(TEXT.overdueCount, { n: count.overdue })}</span> : null}
    </span>
  );
}

const countData = (count: Count | undefined) => ({ 'data-open': count?.open ?? 0, 'data-overdue': count?.overdue ?? 0 });

/** The stage by role table of one system: a line per chain stage, a column per role that holds open work. */
export function StageRoleTable({ ctx, rows, lines }: { ctx: HostContext; rows: TotalsRow[]; lines: StageLine[] }) {
  const columns = roleColumns(rows);
  const totals = roleTotals(rows);
  const all = sumOf(rows);
  return (
    <div className="mx-table-wrap mx-pt-matrix">
      <table className="mx-table" aria-label={ctx.li(TEXT.matrixCaption)}>
        <thead>
          <tr>
            <th scope="col">{ctx.li(TEXT.colStage)}</th>
            {columns.map((key) => <th key={key} scope="col" className="mx-num" data-role={key}>{ctx.li(roleLabel(key))}</th>)}
            <th scope="col" className="mx-num" data-role="all">{ctx.li(TEXT.colAllRoles)}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.key} data-stage={line.key}>
              <th scope="row">{ctx.li(line.label)}</th>
              {columns.map((key: RoleKey) => (
                <td key={key} className="mx-num" data-role={key} {...countData(line.cells[key])}><CountCell ctx={ctx} count={line.cells[key]} /></td>
              ))}
              <td className="mx-num" data-role="all" {...countData(line.total)}><CountCell ctx={ctx} count={line.total} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr data-stage="all">
            <th scope="row">{ctx.li(TEXT.rowAllStages)}</th>
            {columns.map((key) => (
              <td key={key} className="mx-num" data-role={key} {...countData(totals[key])}><CountCell ctx={ctx} count={totals[key]} /></td>
            ))}
            <td className="mx-num" data-role="all" {...countData(all)}><CountCell ctx={ctx} count={all} /></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** The totals of one system as loaded: the summary and the table, or the empty state when nothing is open. */
export function SystemView({ ctx, ms, rows }: { ctx: HostContext; ms: MsId; rows: TotalsRow[] }) {
  const lines = stageLines(rows, stagesOf(ctx, ms));
  const total = sumOf(rows);
  const system = systemName(ctx, ms);
  if (total.open === 0) {
    return (
      <Card>
        <div data-empty="">
          <EmptyState
            title={ctx.fill(TEXT.emptyTitle, { system })}
            text={TEXT.emptyText}
            illustration={<Illustration scene="all-done" size="sm" decorative />}
          />
        </div>
      </Card>
    );
  }
  return (
    <>
      <SummaryCard ctx={ctx} ms={ms} total={total} lines={lines} />
      <Card title={TEXT.matrixTitle} sub={TEXT.matrixSub} flush>
        <StageRoleTable ctx={ctx} rows={rows} lines={lines} />
      </Card>
    </>
  );
}

function SystemTab({ ctx, adapter, ms }: { ctx: HostContext; adapter: PendingTotalsAdapter; ms: MsId }) {
  const [tick, setTick] = useState(0);
  const load = useTotals(adapter, ms, tick);
  const retry = useCallback(() => setTick((n) => n + 1), []);
  if (load.status === 'loading') return <Loading ctx={ctx} />;
  if (load.status === 'failed') return <LoadFailed ctx={ctx} error={load.error} onRetry={retry} />;
  return <SystemView ctx={ctx} ms={ms} rows={load.rows} />;
}

/** The table of "All my systems": one row per system with its open and overdue totals, and their sum. */
export function AllSystemsView({ ctx, systems, loads, onShow, onRetry }: {
  ctx: HostContext;
  systems: readonly MsId[];
  loads: Record<MsId, LoadState>;
  onShow(ms: MsId): void;
  onRetry?(): void;
}) {
  const current = ctx.msObj?.id ?? null;
  const loaded = systems.map((ms) => loads[ms]).filter((l): l is { status: 'ok'; rows: TotalsRow[] } => l?.status === 'ok');
  const failed = systems.some((ms) => loads[ms]?.status === 'failed');
  const waiting = systems.some((ms) => !loads[ms] || loads[ms].status === 'loading');
  const sum = sumOf(loaded.map((l) => sumOf(l.rows)));
  return (
    <Card title={TEXT.allTitle} sub={TEXT.allSub} flush>
      <div className="mx-stack" style={{ gap: 0 }}>
        {failed ? (
          <div style={{ padding: '12px 12px 0' }}>
            <Alert tone="warn">
              <div className="mx-stack" style={{ gap: 8 }}>
                <span>{ctx.li(TEXT.someFailed)}</span>
                {onRetry ? <div className="mx-btn-group"><Button onClick={onRetry}>{ctx.li(TEXT.tryAgain)}</Button></div> : null}
              </div>
            </Alert>
          </div>
        ) : null}
        <div className="mx-table-wrap mx-pt-all">
          <table className="mx-table" aria-label={ctx.li(TEXT.allCaption)}>
            <thead>
              <tr>
                <th scope="col">{ctx.li(TEXT.colSystem)}</th>
                <th scope="col" className="mx-num">{ctx.li(TEXT.colOpen)}</th>
                <th scope="col" className="mx-num">{ctx.li(TEXT.colOverdue)}</th>
                <th scope="col" className="mx-num">{ctx.li(TEXT.colShare)}</th>
                <th scope="col">{ctx.li(TEXT.colAction)}</th>
              </tr>
            </thead>
            <tbody>
              {systems.map((ms) => {
                const load = loads[ms] ?? { status: 'loading' };
                const count = load.status === 'ok' ? sumOf(load.rows) : null;
                const name = systemName(ctx, ms);
                const title = systemTitle(ctx, ms);
                return (
                  <tr key={ms} data-ms={ms} data-open={count?.open} data-overdue={count?.overdue} aria-current={ms === current ? 'true' : undefined}>
                    <th scope="row">
                      <span className="mx-pt-system">
                        <span className="mx-pt-system-short">{name}</span>
                        {title ? <span className="mx-pt-system-name">{ctx.li(title)}</span> : null}
                        {ms === current ? <span className="mx-pt-system-name">{ctx.li(TEXT.current)}</span> : null}
                      </span>
                    </th>
                    {count ? (
                      <>
                        <td className="mx-num">{count.open}</td>
                        <td className="mx-num">{count.overdue > 0 ? <span className="mx-pt-overdue">{count.overdue}</span> : <span className="mx-pt-zero">0</span>}</td>
                        <td className="mx-num">{`${overdueShare(count)}%`}</td>
                      </>
                    ) : (
                      <td className="mx-num" colSpan={3}>
                        {load.status === 'failed'
                          ? <span className="mx-pt-failed" role="alert">{ctx.li(TEXT.systemFailed)}</span>
                          : <span className="mx-small" role="status">{ctx.li(TEXT.systemLoading)}</span>}
                      </td>
                    )}
                    <td>
                      <Button variant="link" title={ctx.fill(TEXT.showTableOf, { system: name })} onClick={() => onShow(ms)}>{ctx.li(TEXT.showTable)}</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {systems.length > 1 ? (
              <tfoot>
                <tr data-ms="all" data-open={waiting ? undefined : sum.open} data-overdue={waiting ? undefined : sum.overdue}>
                  <th scope="row">{ctx.li(TEXT.rowAllSystems)}</th>
                  {waiting ? (
                    <td className="mx-num" colSpan={3}><span className="mx-small" role="status">{ctx.li(TEXT.systemLoading)}</span></td>
                  ) : (
                    <>
                      <td className="mx-num">{sum.open}</td>
                      <td className="mx-num">{sum.overdue}</td>
                      <td className="mx-num">{`${overdueShare(sum)}%`}</td>
                    </>
                  )}
                  <td />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </div>
    </Card>
  );
}

function AllTab({ ctx, adapter, onShow }: { ctx: HostContext; adapter: PendingTotalsAdapter; onShow(ms: MsId): void }) {
  const systems = systemsWithTotals(ctx).map((m) => m.id);
  const [tick, setTick] = useState(0);
  const loads = useAllTotals(adapter, systems, tick);
  const retry = useCallback(() => setTick((n) => n + 1), []);
  if (!systems.length) return <div className="mx-notice">{ctx.li(TEXT.noSystems)}</div>;
  return <AllSystemsView ctx={ctx} systems={systems} loads={loads} onShow={onShow} onRetry={retry} />;
}

/** The screen body with a given adapter (the unit tests pass one). */
export function PendingTotalsBody({ ctx, adapter }: { ctx: HostContext; adapter: PendingTotalsAdapter }) {
  const [tab, setTab] = useScreenTab<TabId>(ctx, TABS, 'system');
  const ms = ctx.msObj?.id ?? null;
  const show = useCallback((target: MsId) => ctx.go(SCREEN_ID, { ms: target, params: { tab: 'system' } }), [ctx]);
  if (!ms) return <div className="mx-notice">{ctx.li(TEXT.noSystem)}</div>;
  if (!ctx.can(ms, TOTALS_PERM)) return <Alert tone="warn">{ctx.li(TEXT.notAllowed)}</Alert>;
  return (
    <div className="mx-stack" data-tab={tab}>
      <p className="mx-pt-note">{ctx.li(TEXT.countsOnly)}</p>
      <Tabs
        tabs={[{ id: 'system', label: TEXT.tabSystem }, { id: 'all', label: TEXT.tabAll }]}
        active={tab}
        onChange={(id) => setTab(id as TabId)}
        label={TEXT.tabsLabel}
      />
      <div role="tabpanel" aria-label={ctx.li(tab === 'system' ? TEXT.tabSystem : TEXT.tabAll)} className="mx-stack">
        {tab === 'system' ? <SystemTab key={ms} ctx={ctx} adapter={adapter} ms={ms} /> : <AllTab ctx={ctx} adapter={adapter} onShow={show} />}
      </div>
    </div>
  );
}

export default function PendingTotalsScreen({ ctx }: ScreenProps) {
  return <PendingTotalsBody ctx={ctx} adapter={adapterFor(ctx)} />;
}
