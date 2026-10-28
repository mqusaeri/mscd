// Pending approvals (MILESTONE-2 M2-10, `/admin/users/approvals`): the role grants waiting for a second Tenant Admin
// (person, role and system, who asked, who can approve) and the routing changes waiting for a second approval, each
// with "Approve" and "Reject". The buttons are disabled with the reason for the person who asked and for the person
// who receives the role (F.6, A-50); Reject asks first. The sidebar badge follows the number left (badge.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Table, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import { adapterFor as usersAdapterFor, settled } from '../users/adapter';
import { roleLabel } from '../users/model';
import type { Member, SystemRef, UsersAdapter } from '../users/model';
import { adapterFor as routingAdapterFor } from '../routing/adapter';
import { decisionBlock as ruleDecisionBlock } from '../routing/model';
import type { RoutingAdapter, RoutingData, RuleModel } from '../routing/model';
import { CLASSIFICATION_LABELS, MODE_LABELS, OBJECT_KIND_LABELS, labelOf } from '../storage-admin/labels';
import { setBadgeCount } from './badge';
import { approverNames, grantDecisionBlock, pendingGrants } from './model';
import type { PendingGrant } from './model';
import { TEXT } from './text';

/** The text of a refusal: the server's message, with its detail when it carries no translated message. */
export function errorText(ctx: HostContext, error: ApiError): string {
  const message = ctx.li(error.message);
  return error.detail && error.message[0] === error.message[1] && !error.messageKey ? `${message}: ${error.detail}` : message;
}

function dayOf(ctx: HostContext, iso: string | null): string {
  if (!iso) return '';
  const day = iso.slice(0, 10);
  return ctx.D ? ctx.D.fmt(day, ctx.lang) : day;
}

/** What the screen shows: the members and pending grants (with `user.manage`), and the routing data (rules read). */
export interface ApprovalsData {
  members: Member[] | null;
  systems: SystemRef[];
  grants: PendingGrant[] | null;
  routing: RoutingData | null;
  errors: ApiError[];
}

/** Loads the pending grants and the routing rules the session may read; one failure leaves the other part shown. */
export async function loadApprovals(ctx: HostContext, users: UsersAdapter, routing: RoutingAdapter): Promise<ApprovalsData> {
  const readGrants = ctx.orgCan('user.manage');
  const readRules = ctx.orgCan('storage.repository.read');
  const [members, systems, rules] = await Promise.all([
    readGrants ? settled(users.members()) : Promise.resolve(null),
    readGrants ? settled(users.systems()) : Promise.resolve(null),
    readRules ? routing.load().catch(() => ({ ok: false as const, error: { status: 0, message: CONNECTION_LOST } })) : Promise.resolve(null),
  ]);
  const errors: ApiError[] = [];
  const systemList = systems && systems.ok ? systems.data : (ctx.D?.MS ?? []).map((m) => ({ id: m.id, slug: m.id, code: m.short, name: ctx.li(m.name), archived: false }));
  let grants: PendingGrant[] | null = null;
  if (members) {
    if (members.ok) {
      const waiting = members.data.flatMap((m) => m.roles.filter((g) => g.approvalStatus === 'pending_approval').map((g) => g.grantId));
      const history = waiting.length ? await settled(users.history(waiting)) : { ok: true as const, data: {} };
      grants = pendingGrants(members.data, systemList, history.ok ? history.data : {});
    } else errors.push(members.error);
  }
  let routingData: RoutingData | null = null;
  if (rules) {
    if (rules.ok) routingData = rules.data;
    else errors.push(rules.error);
  }
  return { members: members && members.ok ? members.data : null, systems: systemList, grants, routing: routingData, errors };
}

/** The number of waiting approvals in loaded data. */
export function waitingCount(data: ApprovalsData): number {
  return (data.grants?.length ?? 0) + (data.routing?.rules.filter((r) => r.approvalStatus === 'pending_approval').length ?? 0);
}

function Decision({ ctx, id, block, busy, onApprove, onReject }: { ctx: HostContext; id: string; block: TextPair | null; busy: boolean; onApprove(): void; onReject(): void }) {
  const reasonId = `approval-reason-${id}`;
  return (
    <div className="mx-stack" style={{ gap: 6 }}>
      <div className="mx-btn-group" role="group" aria-describedby={block ? reasonId : undefined}>
        <Button variant="primary" busy={busy} disabled={Boolean(block)} onClick={onApprove}>{ctx.li(TEXT.approve)}</Button>
        <Button variant="danger" disabled={Boolean(block) || busy} onClick={onReject}>{ctx.li(TEXT.reject)}</Button>
      </div>
      {block ? <span id={reasonId} className="mx-reason">{ctx.li(block)}</span> : null}
    </div>
  );
}

export function GrantsTable({ ctx, grants, members, busy, onApprove, onReject }: {
  ctx: HostContext;
  grants: PendingGrant[];
  members: readonly Member[];
  busy: string | null;
  onApprove(g: PendingGrant): void;
  onReject(g: PendingGrant): void;
}) {
  const columns: Column<PendingGrant>[] = [
    {
      key: 'person',
      label: TEXT.colPerson,
      render: (g) => (
        <div className="mx-stack" style={{ gap: 2 }}>
          <span style={{ fontWeight: 600 }}>{g.member.displayName}</span>
          <span className="mx-small" style={{ overflowWrap: 'anywhere' }}>{g.member.email}</span>
          {g.member.adminRoles.length ? <span><Badge tone="info">{ctx.li(TEXT.admin)}</Badge></span> : null}
        </div>
      ),
    },
    {
      key: 'role',
      label: TEXT.colRole,
      render: (g) => (
        <div className="mx-stack" style={{ gap: 2 }}>
          <span>{`${ctx.li(roleLabel(g.role))}, ${g.system.code}`}</span>
          <span className="mx-small">{g.system.name}</span>
        </div>
      ),
    },
    {
      key: 'requested',
      label: TEXT.colRequested,
      render: (g) => (g.requestedBy ? [g.requestedBy.name, dayOf(ctx, g.requestedAt)].filter(Boolean).join(', ') : <span className="mx-small">{ctx.li(TEXT.unknown)}</span>),
    },
    {
      key: 'approvers',
      label: TEXT.colApprovers,
      render: (g) => {
        const names = approverNames(members, g);
        return names.length ? names.join(', ') : <span className="mx-small">{ctx.li(TEXT.noApprover)}</span>;
      },
    },
    {
      key: 'actions',
      label: TEXT.colActions,
      width: 240,
      render: (g) => <Decision ctx={ctx} id={g.grantId} block={grantDecisionBlock(ctx, g)} busy={busy === g.grantId} onApprove={() => onApprove(g)} onReject={() => onReject(g)} />,
    },
  ];
  return <Table columns={columns} rows={grants} rowKey={(g) => g.grantId} />;
}

export function RulesTable({ ctx, data, rules, members = [], busy, onApprove, onReject }: {
  ctx: HostContext;
  data: RoutingData;
  /** Members of the organisation (with `user.manage`), to name the person who asked. */
  members?: readonly Member[];
  rules: RuleModel[];
  busy: string | null;
  onApprove(r: RuleModel): void;
  onReject(r: RuleModel): void;
}) {
  const repoName = (slug: string) => data.repos.find((r) => r.slug === slug)?.name ?? slug;
  // The members list names everyone a Tenant Admin may see; the snapshot names the people of the session's systems.
  const personName = (handle: string | null) => (handle
    ? members.find((m) => m.handle === handle)?.displayName ?? ctx.D?.PEOPLE?.[handle]?.[0] ?? handle
    : ctx.li(TEXT.unknown));
  const manage = ctx.orgCan('storage.routing.manage');
  const columns: Column<RuleModel>[] = [
    { key: 'system', label: TEXT.colSystem, render: (r) => <span style={{ fontWeight: 600 }}>{r.ms ? data.systems.find((s) => s.slug === r.ms)?.code ?? r.ms.toUpperCase() : ctx.li(TEXT.wholeOrg)}</span> },
    {
      key: 'applies',
      label: TEXT.colAppliesTo,
      render: (r) => (
        <>
          <div>{ctx.li(r.classification ? labelOf(CLASSIFICATION_LABELS, r.classification) : TEXT.anyClassification)}</div>
          <div className="mx-small">{ctx.li(r.objectKind ? labelOf(OBJECT_KIND_LABELS, r.objectKind) : TEXT.anyKind)}</div>
        </>
      ),
    },
    {
      key: 'target',
      label: TEXT.colTarget,
      render: (r) => (
        <>
          <div>{`${repoName(r.repository)}, ${ctx.li(labelOf(MODE_LABELS, r.mode))}`}</div>
          {r.note ? <div className="mx-small">{ctx.li(r.note)}</div> : null}
        </>
      ),
    },
    { key: 'requested', label: TEXT.colRequested, render: (r) => `${personName(r.requestedBy)}${r.createdAt ? `, ${dayOf(ctx, r.createdAt)}` : ''}` },
  ];
  if (manage) {
    columns.push({
      key: 'actions',
      label: TEXT.colActions,
      width: 240,
      render: (r) => <Decision ctx={ctx} id={r.id} block={ruleDecisionBlock(ctx, r)} busy={busy === r.id} onApprove={() => onApprove(r)} onReject={() => onReject(r)} />,
    });
  }
  return <Table columns={columns} rows={rules} rowKey={(r) => r.id} />;
}

type LoadState = { loading: boolean; data: ApprovalsData | null };
type Rejecting = { kind: 'grant'; grant: PendingGrant } | { kind: 'rule'; rule: RuleModel };

export default function ApprovalsScreen({ ctx }: ScreenProps) {
  const context = useRef(ctx);
  context.current = ctx;
  const { client } = ctx;
  const users = useMemo(() => usersAdapterFor(() => context.current), [client]);
  const routing = useMemo(() => routingAdapterFor(() => context.current), [client]);
  const [state, setState] = useState<LoadState>({ loading: true, data: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Rejecting | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    loadApprovals(context.current, users, routing).then((data) => {
      setState({ loading: false, data });
      if (!data.errors.length && setBadgeCount(waitingCount(data))) context.current.track(Promise.resolve()).catch(() => undefined);
    });
  }, [users, routing]);
  useEffect(() => load(), [load]);
  const decideGrant = (g: PendingGrant, to: 'approve' | 'reject') => {
    setBusy(g.grantId);
    setFailure(null);
    settled(to === 'approve' ? users.approve(g.system, g.grantId) : users.reject(g.system, g.grantId)).then((res) => {
      setBusy(null);
      setRejecting(null);
      const c = context.current;
      if (!res.ok) {
        setFailure(res.error);
        return;
      }
      c.toast(c.fill(to === 'approve' ? TEXT.approved : TEXT.rejected, { role: c.li(roleLabel(g.role)), system: g.system.code, name: g.member.displayName }));
      load();
      // An approved grant changes the people of the system's snapshot (D2-08).
      if (to === 'approve') c.reload([g.ms]).catch(() => undefined);
    });
  };
  const decideRule = (r: RuleModel, to: 'approve' | 'reject') => {
    setBusy(r.id);
    setFailure(null);
    settled(to === 'approve' ? routing.approve(r.id) : routing.reject(r.id)).then((res) => {
      setBusy(null);
      setRejecting(null);
      const c = context.current;
      if (!res.ok) {
        setFailure(res.error);
        return;
      }
      c.toast(c.li(res.data.message ?? (to === 'approve' ? TEXT.ruleApproved : TEXT.ruleRejected)));
      load();
      if (res.data.changed.length) c.reload(res.data.changed).catch(() => undefined);
    });
  };
  const { data } = state;
  let body;
  if (state.loading && !data) body = <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div>;
  else if (!data || (data.errors.length && !data.grants && !data.routing)) {
    body = (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <div>{data?.errors[0] ? errorText(ctx, data.errors[0]) : null}</div>
        <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  } else {
    const rules = data.routing?.rules.filter((r) => r.approvalStatus === 'pending_approval') ?? [];
    const grants = data.grants ?? [];
    const nothing = grants.length === 0 && rules.length === 0 && !data.errors.length;
    body = nothing ? (
      <Card>
        <EmptyState illustration={<Illustration scene="all-done" size="sm" decorative />} title={TEXT.allDone} text={TEXT.allDoneText} />
      </Card>
    ) : (
      <>
        {data.errors.map((e, i) => <Alert key={i} tone="bad" title={TEXT.loadFailed}>{errorText(ctx, e)}</Alert>)}
        {data.grants ? (
          <Card title={TEXT.grants} sub={TEXT.grantsSub} flush>
            {grants.length ? (
              <div data-approvals="grants"><GrantsTable ctx={ctx} grants={grants} members={data.members ?? []} busy={busy} onApprove={(g) => decideGrant(g, 'approve')} onReject={(g) => setRejecting({ kind: 'grant', grant: g })} /></div>
            ) : <div className="mx-small" style={{ padding: 'var(--pad)' }}>{ctx.li(TEXT.noGrants)}</div>}
          </Card>
        ) : null}
        {data.routing ? (
          <Card title={TEXT.rules} sub={TEXT.rulesSub} flush actions={<Button variant="link" onClick={() => ctx.go('routing')}>{ctx.li(TEXT.openRouting)}</Button>}>
            {rules.length ? (
              <div data-approvals="rules"><RulesTable ctx={ctx} data={data.routing} rules={rules} members={data.members ?? []} busy={busy} onApprove={(r) => decideRule(r, 'approve')} onReject={(r) => setRejecting({ kind: 'rule', rule: r })} /></div>
            ) : <div className="mx-small" style={{ padding: 'var(--pad)' }}>{ctx.li(TEXT.noRules)}</div>}
          </Card>
        ) : null}
      </>
    );
  }
  const values = rejecting?.kind === 'grant'
    ? { name: rejecting.grant.member.displayName, role: ctx.li(roleLabel(rejecting.grant.role)), system: rejecting.grant.system.code }
    : { name: '', role: '', system: '' };
  return (
    <>
      {ctx.mode === 'sample' ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
      <Alert tone="info">{ctx.li(TEXT.fourEyes)}</Alert>
      {failure ? <Alert tone="bad">{errorText(ctx, failure)}</Alert> : null}
      {body}
      <ConfirmDialog
        open={Boolean(rejecting)}
        title={rejecting?.kind === 'rule' ? TEXT.rejectRuleTitle : TEXT.rejectGrantTitle}
        body={rejecting?.kind === 'rule' ? ctx.li(TEXT.rejectRuleBody) : ctx.fill(TEXT.rejectGrantBody, values)}
        confirmLabel={TEXT.reject}
        tone="bad"
        busy={Boolean(rejecting && busy === (rejecting.kind === 'grant' ? rejecting.grant.grantId : rejecting.rule.id))}
        onConfirm={() => {
          if (rejecting?.kind === 'grant') decideGrant(rejecting.grant, 'reject');
          else if (rejecting?.kind === 'rule') decideRule(rejecting.rule, 'reject');
        }}
        onCancel={() => setRejecting(null)}
      />
    </>
  );
}
