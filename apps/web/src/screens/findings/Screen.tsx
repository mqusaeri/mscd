// "Findings and actions" (MILESTONE-2 M2-14, `/ms/:ms/findings`): the tabs Findings, Corrective actions and
// Self-assessment of the selected management system. "Raise finding" is a page action (finding.raise); the drawers of
// a finding and of a corrective action carry their moves. Opened with `params.finding` (the Open findings panel of a
// clause or control) it opens that finding's drawer; `params.tab` picks a tab.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScreenProps } from '../types';
import { Tabs } from '../ui';
import { ActionDrawer, ActionFormDialog, ActionsList } from './ActionsTab';
import { adapterFor } from './adapter';
import { FindingDrawer, FindingsList } from './FindingsTab';
import { mayCreateAction, mayRaise } from './model';
import type { ActionModel, FindingModel, SelfRow, TargetOption } from './model';
import { LoadState, useLoad } from './parts';
import { RaiseDialog } from './RaiseDialog';
import type { Outcome } from './shared';
import { outcomeText, reloadChanged } from './shared';
import { AssessDialog, RaiseGapDialog, SelfList } from './SelfTab';
import { TEXT } from './text';

export type TabId = 'findings' | 'actions' | 'self';
const TABS: readonly TabId[] = ['findings', 'actions', 'self'];

export default function FindingsScreen({ ctx }: ScreenProps) {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(() => ctxRef.current), [client]);
  const ms = ctx.msObj?.id ?? null;
  const org = ctx.org?.id ?? '';
  const requestedTab = TABS.includes(ctx.params.tab as TabId) ? (ctx.params.tab as TabId) : null;
  const [tab, setTab] = useState<TabId>(requestedTab ?? 'findings');
  const findings = useLoad(() => adapter.findings(ms!), `${org}:${ms}`, Boolean(ms));
  const actions = useLoad(() => adapter.actions(ms!), `${org}:${ms}`, Boolean(ms));
  const self = useLoad(() => adapter.selfAssessment(ms!), `${org}:${ms}`, Boolean(ms) && tab === 'self');
  const targets = useLoad(() => adapter.targets(ms!), `${org}:${ms}`, Boolean(ms));
  const [findingId, setFindingId] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);
  const [creating, setCreating] = useState<string[] | null>(null);
  const [assessing, setAssessing] = useState<SelfRow | null>(null);
  const [raisingGap, setRaisingGap] = useState<SelfRow | null>(null);

  // Page action "Raise finding" and the links of other screens arrive as params.
  const raiseRequest = ctx.params.raise;
  useEffect(() => {
    if (raiseRequest) setRaising(true);
  }, [raiseRequest]);
  useEffect(() => {
    if (requestedTab) setTab(requestedTab);
  }, [requestedTab, ctx.params.at]);
  const linked = typeof ctx.params.finding === 'string' ? ctx.params.finding : null;
  useEffect(() => {
    if (linked) {
      setTab('findings');
      setFindingId(linked);
    }
  }, [linked, ctx.params.at]);
  // A new system closes what belonged to the previous one.
  useEffect(() => {
    setFindingId((id) => (id && id === linked ? id : null));
    setActionId(null);
  }, [ms]);

  if (!ms) return <div className="mx-small">{ctx.li(TEXT.noSystem)}</div>;
  const findingRows: FindingModel[] = findings.data ?? [];
  const actionRows: ActionModel[] = actions.data ?? [];
  const targetRows: TargetOption[] = targets.data ?? [];
  const finding = findingId ? findingRows.find((f) => f.id === findingId) ?? null : null;
  const action = actionId ? actionRows.find((a) => a.id === actionId) ?? null : null;
  const canRaise = mayRaise(ctx, ms);
  const canCreate = mayCreateAction(ctx, ms);

  const after = (outcome: Outcome, message: string, lists: ('findings' | 'actions' | 'self')[]) => {
    ctx.toast(message);
    if (lists.includes('findings')) findings.reload();
    if (lists.includes('actions')) actions.reload();
    if (lists.includes('self')) self.reload();
    // Findings feed the snapshot (open and major counts, the findings of the timeline): load the system again.
    if (lists.includes('findings')) void reloadChanged(ctx, outcome.changed);
  };

  let body;
  if (tab === 'findings') {
    body = LoadState({ ctx, loaded: findings, failed: TEXT.loadFailed }) ?? (
      <FindingsList ctx={ctx} rows={findingRows} canRaise={canRaise} onRaise={() => setRaising(true)} onOpen={(f) => setFindingId(f.id)} />
    );
  } else if (tab === 'actions') {
    body = LoadState({ ctx, loaded: actions, failed: TEXT.actionsFailed }) ?? (
      <ActionsList ctx={ctx} rows={actionRows} canCreate={canCreate} onCreate={() => setCreating([])} onOpen={(a) => setActionId(a.id)} />
    );
  } else {
    body = LoadState({ ctx, loaded: self, failed: TEXT.selfFailed }) ?? (
      <SelfList ctx={ctx} ms={ms} rows={self.data ?? []} onAssess={setAssessing} onRaise={setRaisingGap} />
    );
  }
  const openCount = findingRows.filter((f) => f.status !== 'closed').length;
  const actionCount = actionRows.filter((a) => a.status !== 'closed' && a.status !== 'cancelled').length;
  return (
    <>
      <Tabs
        label={TEXT.tabsLabel}
        active={tab}
        onChange={(id) => setTab(id as TabId)}
        tabs={[
          { id: 'findings', label: TEXT.tabFindings, ...(findings.data ? { count: openCount } : {}) },
          { id: 'actions', label: TEXT.tabActions, ...(actions.data ? { count: actionCount } : {}) },
          { id: 'self', label: TEXT.tabSelf },
        ]}
      />
      {body}
      <FindingDrawer
        ctx={ctx}
        ms={ms}
        finding={finding}
        adapter={adapter}
        targets={targetRows}
        onClose={() => setFindingId(null)}
        onChanged={(o, m) => after(o, m, ['findings'])}
        onCreateAction={(f) => setCreating([f.id])}
        onOpenAction={(id) => { setFindingId(null); setTab('actions'); setActionId(id); }}
      />
      <ActionDrawer
        ctx={ctx}
        ms={ms}
        action={action}
        adapter={adapter}
        findings={findingRows}
        codes={actionRows.map((a) => a.code)}
        onClose={() => setActionId(null)}
        onChanged={(o, m) => after(o, m, ['actions', 'findings'])}
        onOpenFinding={(id) => { setActionId(null); setTab('findings'); setFindingId(id); }}
      />
      {canRaise ? (
        <RaiseDialog
          ctx={ctx}
          ms={ms}
          open={raising}
          adapter={adapter}
          codes={findingRows.map((f) => f.code)}
          onClose={() => setRaising(false)}
          onRaised={(o, code) => { setRaising(false); setTab('findings'); after(o, outcomeText(ctx, o, ctx.fill(TEXT.raised, { code })), ['findings']); }}
        />
      ) : null}
      {canCreate ? (
        <ActionFormDialog
          ctx={ctx}
          ms={ms}
          open={creating !== null}
          adapter={adapter}
          findings={findingRows}
          codes={actionRows.map((a) => a.code)}
          action={null}
          preselected={creating ?? []}
          onClose={() => setCreating(null)}
          onSaved={(o, code) => {
            setCreating(null);
            setFindingId(null);
            setTab('actions');
            if (o.ref?.id) setActionId(o.ref.id);
            after(o, outcomeText(ctx, o, ctx.fill(TEXT.actionCreated, { code })), ['actions', 'findings']);
          }}
        />
      ) : null}
      <AssessDialog ctx={ctx} ms={ms} row={assessing} adapter={adapter} onClose={() => setAssessing(null)} onSaved={(o, m) => { setAssessing(null); after(o, m, ['self']); }} />
      <RaiseGapDialog ctx={ctx} ms={ms} row={raisingGap} adapter={adapter} onClose={() => setRaisingGap(null)} onRaised={(o, m) => { setRaisingGap(null); after(o, m, ['self', 'findings']); }} />
    </>
  );
}
