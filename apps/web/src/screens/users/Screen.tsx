// People and roles (MILESTONE-2 M2-10, `/admin/users`): the members of the organisation with their administration
// roles and their business roles per management system (the real role label of each grant), membership, authenticator
// and last sign-in; search and filters; a drawer per person with Edit, Grant role, Revoke role, Pre-register company
// sign-in, Reset sign-in factor and Disable (or Enable again); "Invite person"; and "Export roles and
// responsibilities", a CSV built in the browser. Grants to yourself or to an administrator wait for a second Tenant
// Admin (F.6), and the forms say so (D2-12). A change of your own administration roles or of your own active grant
// renews the session (F.1): the dialog reads `GET /me` for the new CSRF token, then the snapshot is loaded again so the
// permissions and the sidebar follow, or the app loads again when the shell's roles changed (`sessionRestart`).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Badge, Button, Card, Drawer, EmptyState, Facts, Field, Select, Table, TextInput, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import { APPROVAL_PERMS, refreshBadge } from '../approvals/badge';
import { adapterFor, settled, tenancyOf } from './adapter';
import {
  DisableDialog, EditDialog, GrantDialog, InviteDialog, PreRegisterDialog, ResetDialog, RevokeDialog,
} from './dialogs';
import {
  BUSINESS_ROLES, EMPTY_FILTER, MEMBERSHIP_LABELS, adminRoleLabel, dayOf, disableBlock, errorText, filterMembers, grantBlock, isSelf, roleLabel,
  rolesCsv, snapshotReload, systemCode,
} from './model';
import type { GrantModel, Member, MemberFilter, ProviderRef, Renewal, SystemRef, UsersAdapter } from './model';
import { TEXT } from './text';

/** What the screen loads: the members, the systems the grant routes name, the providers and the tenancy mode. */
export interface UsersData {
  members: Member[];
  systems: SystemRef[];
  providers: ProviderRef[];
  tenancy: 'single' | 'multi';
}

/** An instant as a date and time in the interface language. */
export function formatInstant(iso: string | null, lang: 'en' | 'id'): string {
  if (!iso) return '-';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}

/** One role grant as text: "MS Manager in ISMS", with primary, waiting for approval and the end date. */
export function grantText(ctx: HostContext, grant: GrantModel, systems: readonly SystemRef[]): string {
  const base = ctx.fill(TEXT.roleInSystem, { role: ctx.li(roleLabel(grant.role)), system: systemCode(systems, grant.ms) });
  const parts = [base];
  if (grant.isPrimary) parts.push(ctx.li(TEXT.primary));
  if (grant.validUntil) parts.push(ctx.fill(TEXT.until, { date: dayOf(ctx, grant.validUntil) }));
  return parts.join(', ');
}

/** The grants of a member as lines, pending ones marked. */
function GrantLines({ ctx, member, systems }: { ctx: HostContext; member: Member; systems: readonly SystemRef[] }) {
  const grants = member.roles.filter((g) => g.approvalStatus !== 'rejected');
  if (!grants.length) return <span className="mx-small">{ctx.li(TEXT.none)}</span>;
  return (
    <div className="mx-stack" style={{ gap: 4 }}>
      {grants.map((g) => (
        <span key={g.grantId}>
          {grantText(ctx, g, systems)}
          {g.approvalStatus === 'pending_approval' ? <span style={{ marginLeft: 6 }}><Badge tone="warn">{ctx.li(TEXT.pending)}</Badge></span> : null}
        </span>
      ))}
    </div>
  );
}

/** The membership badge of a member, with the account state and the guest mark. */
function MembershipBadges({ ctx, member }: { ctx: HostContext; member: Member }) {
  const m = MEMBERSHIP_LABELS[member.membershipStatus];
  return (
    <span className="mx-btn-group" style={{ gap: 4 }}>
      <Badge tone={m.tone}>{ctx.li(m.label)}</Badge>
      {member.accountStatus === 'disabled' && member.membershipStatus !== 'disabled' ? <Badge tone="bad">{ctx.li(TEXT.accountDisabled)}</Badge> : null}
      {member.kind === 'guest' ? <Badge tone="info">{ctx.li(TEXT.guest)}</Badge> : null}
    </span>
  );
}

export function MembersTable({ ctx, members, systems, onOpen }: { ctx: HostContext; members: Member[]; systems: readonly SystemRef[]; onOpen(m: Member): void }) {
  const columns: Column<Member>[] = [
    {
      key: 'name',
      label: TEXT.colName,
      render: (m) => (
        <div className="mx-stack" style={{ gap: 2 }}>
          <span style={{ fontWeight: 600 }}>
            {m.displayName}
            {isSelf(ctx, m) ? <span style={{ marginLeft: 6 }}><Badge tone="acc">{ctx.li(TEXT.you)}</Badge></span> : null}
          </span>
          <span className="mx-small" style={{ overflowWrap: 'anywhere' }}>{m.email}</span>
        </div>
      ),
    },
    { key: 'job', label: TEXT.colJob, render: (m) => m.jobTitle ?? '-' },
    {
      key: 'admin',
      label: TEXT.colAdmin,
      render: (m) => (m.adminRoles.length
        ? <span className="mx-btn-group" style={{ gap: 4 }}>{m.adminRoles.map((r) => <Badge key={r} tone="info">{ctx.li(adminRoleLabel(r))}</Badge>)}</span>
        : <span className="mx-small">{ctx.li(TEXT.none)}</span>),
    },
    { key: 'roles', label: TEXT.colRoles, render: (m) => <GrantLines ctx={ctx} member={m} systems={systems} /> },
    { key: 'status', label: TEXT.colStatus, render: (m) => <MembershipBadges ctx={ctx} member={m} /> },
    {
      key: 'mfa',
      label: TEXT.colMfa,
      render: (m) => (m.membershipStatus === 'invited' ? '-' : <Badge tone={m.mfaEnrolled ? 'ok' : 'warn'}>{ctx.li(m.mfaEnrolled ? TEXT.mfaSet : TEXT.mfaMissing)}</Badge>),
    },
    { key: 'last', label: TEXT.colLastSignIn, render: (m) => (m.lastLoginAt ? formatInstant(m.lastLoginAt, ctx.lang) : <span className="mx-small">{ctx.li(TEXT.never)}</span>) },
  ];
  return <Table columns={columns} rows={members} rowKey={(m) => m.id} onRow={onOpen} />;
}

export function Filters({ filter, systems, onChange }: { filter: MemberFilter; systems: readonly SystemRef[]; onChange(f: MemberFilter): void }) {
  return (
    <div className="mx-row" style={{ padding: 'var(--pad)', alignItems: 'flex-end' }}>
      <div style={{ minWidth: 240, flex: '1 1 240px' }}>
        <Field label={TEXT.searchLabel}>
          <TextInput type="search" value={filter.q} onChange={(q) => onChange({ ...filter, q })} placeholder={TEXT.search} name="q" />
        </Field>
      </div>
      <div style={{ minWidth: 180 }}>
        <Field label={TEXT.filterStatus}>
          <Select
            value={filter.status}
            onChange={(v) => onChange({ ...filter, status: v as MemberFilter['status'] })}
            name="status"
            options={[{ value: '', label: TEXT.allStatuses }, ...(['active', 'invited', 'disabled'] as const).map((s) => ({ value: s, label: MEMBERSHIP_LABELS[s].label }))]}
          />
        </Field>
      </div>
      <div style={{ minWidth: 200 }}>
        <Field label={TEXT.filterRole}>
          <Select
            value={filter.role}
            onChange={(role) => onChange({ ...filter, role })}
            name="role"
            options={[
              { value: '', label: TEXT.allRoles },
              { value: 'admin', label: TEXT.adminsOnly },
              { value: 'pending', label: TEXT.pendingOnly },
              { value: 'none', label: TEXT.noRole },
              ...BUSINESS_ROLES.map((r) => ({ value: r, label: roleLabel(r) })),
            ]}
          />
        </Field>
      </div>
      <div style={{ minWidth: 160 }}>
        <Field label={TEXT.filterSystem}>
          <Select value={filter.ms} onChange={(ms) => onChange({ ...filter, ms })} name="ms" options={[{ value: '', label: TEXT.allSystems }, ...systems.map((s) => ({ value: s.slug, label: s.code }))]} />
        </Field>
      </div>
    </div>
  );
}

/** What the drawer of a person can open. */
export type DrawerAction = 'edit' | 'grant' | 'preRegister' | 'reset' | 'disable';

export function PersonDrawer({ ctx, member, data, onClose, onAction, onRevoke }: {
  ctx: HostContext;
  member: Member | null;
  data: UsersData;
  onClose(): void;
  onAction(action: DrawerAction, member: Member): void;
  onRevoke(member: Member, grant: GrantModel): void;
}) {
  if (!member) return null;
  const grants = member.roles.filter((g) => g.approvalStatus !== 'rejected');
  const enabledProviders = data.providers.filter((p) => p.enabled);
  const guest = member.kind === 'guest' ? TEXT.grantGuest : null;
  const disabling = member.membershipStatus !== 'disabled';
  return (
    <Drawer open title={member.displayName} crumb={TEXT.drawerCrumb} onClose={onClose}>
      <Facts
        items={[
          { label: TEXT.handle, value: member.handle, mono: true },
          { label: TEXT.colEmail, value: <span style={{ overflowWrap: 'anywhere' }}>{member.email}</span> },
          { label: TEXT.colJob, value: member.jobTitle ?? '-' },
          { label: TEXT.colStatus, value: <MembershipBadges ctx={ctx} member={member} /> },
          { label: TEXT.colAdmin, value: member.adminRoles.length ? member.adminRoles.map((r) => ctx.li(adminRoleLabel(r))).join(', ') : ctx.li(TEXT.none) },
          { label: TEXT.colMfa, value: member.membershipStatus === 'invited' ? '-' : ctx.li(member.mfaEnrolled ? TEXT.mfaSet : TEXT.mfaMissing) },
          { label: TEXT.colLastSignIn, value: member.lastLoginAt ? formatInstant(member.lastLoginAt, ctx.lang) : ctx.li(TEXT.never) },
          { label: TEXT.otherOrgs, value: ctx.li(member.otherMemberships ? TEXT.otherOrgsYes : TEXT.otherOrgsNo) },
        ]}
      />
      {member.membershipStatus === 'invited' ? <Alert tone="info">{ctx.li(TEXT.invitedNote)}</Alert> : null}
      <section className="mx-stack" style={{ gap: 8 }}>
        <h3 className="mx-card-title" style={{ margin: 0, fontSize: '1em' }}>{ctx.li(TEXT.businessRoles)}</h3>
        {grants.length ? (
          <div className="mx-stack" style={{ gap: 6 }} data-grants="">
            {grants.map((g) => (
              <div key={g.grantId} className="mx-row" style={{ justifyContent: 'space-between', padding: '8px 10px', border: '1px solid var(--bd)', borderRadius: 8 }} data-grant={g.grantId}>
                <span>
                  {grantText(ctx, g, data.systems)}
                  {g.approvalStatus === 'pending_approval' ? <span style={{ marginLeft: 6 }}><Badge tone="warn">{ctx.li(TEXT.pending)}</Badge></span> : null}
                </span>
                <Button onClick={() => onRevoke(member, g)}>{ctx.li(TEXT.revoke)}</Button>
              </div>
            ))}
          </div>
        ) : <div className="mx-small">{ctx.li(TEXT.noGrants)}</div>}
      </section>
      <section className="mx-stack" style={{ gap: 8 }}>
        <h3 className="mx-card-title" style={{ margin: 0, fontSize: '1em' }}>{ctx.li(TEXT.actions)}</h3>
        <div className="mx-stack" style={{ gap: 8, alignItems: 'flex-start' }}>
          <Button disabledReason={guest} onClick={() => onAction('edit', member)}>{ctx.li(TEXT.edit)}</Button>
          <Button variant="primary" disabledReason={grantBlock(member)} onClick={() => onAction('grant', member)}>{ctx.li(TEXT.grant)}</Button>
          <Button disabledReason={guest ?? (enabledProviders.length ? null : TEXT.noProviders)} onClick={() => onAction('preRegister', member)}>{ctx.li(TEXT.preRegister)}</Button>
          <Button disabledReason={member.membershipStatus === 'invited' || !member.mfaEnrolled ? TEXT.resetNoFactor : null} onClick={() => onAction('reset', member)}>{ctx.li(TEXT.resetMfa)}</Button>
          {disabling
            ? <Button variant="danger" disabledReason={disableBlock(ctx, member, data.members)} onClick={() => onAction('disable', member)}>{ctx.li(TEXT.disable)}</Button>
            : <Button onClick={() => onAction('disable', member)}>{ctx.li(TEXT.enable)}</Button>}
        </div>
      </section>
    </Drawer>
  );
}

/** How long the toast shows (with the busy bar) before the app loads again after a change of your own roles. */
export const RESTART_DELAY_MS = 1200;

/** Loads the app again: the shell reads the session's roles from `GET /me` when it starts. */
export function restartApp(): void {
  if (typeof window !== 'undefined') window.location.reload();
}

/** Saves a text as a file in the browser (the CSV export). */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

type LoadState = { loading: boolean; data: UsersData | null; error: ApiError | null };

/** Loads the members, systems, providers and the tenancy mode; only the members are required. */
export async function loadUsers(adapter: UsersAdapter, ctx: HostContext): Promise<LoadState> {
  const [members, systems, providers, org] = await Promise.all([
    settled(adapter.members()),
    settled(adapter.systems()),
    ctx.orgCan('idp.manage') ? settled(adapter.providers()) : Promise.resolve(null),
    ctx.orgCan('org.settings.manage') ? settled(adapter.org()) : Promise.resolve(null),
  ]);
  if (!members.ok) return { loading: false, data: null, error: members.error };
  const fallback: SystemRef[] = (ctx.D?.MS ?? []).map((m) => ({ id: m.id, slug: m.id, code: m.short, name: ctx.li(m.name), archived: false }));
  return {
    loading: false,
    error: null,
    data: {
      members: members.data,
      systems: systems.ok ? systems.data : fallback,
      providers: providers && providers.ok ? providers.data : [],
      tenancy: org && org.ok && org.data.tenancyMode ? org.data.tenancyMode : tenancyOf(ctx),
    },
  };
}

export default function UsersScreen({ ctx }: ScreenProps) {
  const context = useRef(ctx);
  context.current = ctx;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(() => context.current), [client]);
  const [state, setState] = useState<LoadState>({ loading: true, data: null, error: null });
  const [filter, setFilter] = useState<MemberFilter>(EMPTY_FILTER);
  const [openId, setOpenId] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [action, setAction] = useState<{ kind: DrawerAction; member: Member } | null>(null);
  const [revoking, setRevoking] = useState<{ member: Member; grant: GrantModel } | null>(null);
  const [exportError, setExportError] = useState<ApiError | null>(null);
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    loadUsers(adapter, context.current).then(setState);
  }, [adapter]);
  useEffect(() => load(), [load]);
  // The page actions "Invite person" and "Export roles and responsibilities" arrive through the screen params.
  const { invite, exportAt } = ctx.params as { invite?: number; exportAt?: number };
  useEffect(() => {
    if (invite) setInviting(true);
  }, [invite]);
  const data = state.data;
  const runExport = useCallback(() => {
    const c = context.current;
    if (!data) return;
    setExportError(null);
    c.track(settled(adapter.history(null))).then((res) => {
      if (!res.ok) {
        setExportError(res.error);
        return;
      }
      const today = c.D?.TODAY_S ?? new Date().toISOString().slice(0, 10);
      const org = c.me?.org?.slug ?? c.org?.id ?? 'organisation';
      downloadText(`roles-and-responsibilities-${org}-${today}.csv`, rolesCsv(data.members, data.systems, res.data, c.lang));
      c.toast(c.li(TEXT.exported));
    });
  }, [adapter, data]);
  const lastExport = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (exportAt && data && lastExport.current !== exportAt) {
      lastExport.current = exportAt;
      runExport();
    }
  }, [exportAt, data, runExport]);
  /**
   * After a change: the member list again and, when the change touches snapshot data (D2-08: the people of the
   * organisation snapshot, the role holders of a system), the organisation snapshot with the systems in `msIds` (an
   * empty list reloads the organisation snapshot only; null leaves the snapshot as it is).
   */
  const changed = (msIds: string[] | null = null) => {
    load();
    if (msIds) context.current.reload(msIds).catch(() => undefined);
    // A grant to an administrator, a revoked request or a disabled requester changes the badge of Pending approvals.
    if (context.current.orgCan([...APPROVAL_PERMS])) refreshBadge(context.current);
  };
  const member = data?.members.find((m) => m.id === openId) ?? null;
  const done = (text: string, msIds: string[] | null = null) => {
    context.current.toast(text);
    setAction(null);
    changed(msIds);
  };
  /**
   * After an Edit or a revocation: a change of your own roles (`renewal`, the dialog already read `GET /me`) reloads
   * at least the organisation snapshot, whose permissions, systems and sidebar follow the new roles, or loads the app
   * again after the toast when the shell's roles changed.
   */
  const settle = (text: string, renewal: Renewal, msIds: string[] | null) => {
    if (renewal !== 'restart') {
      done(text, renewal === 'reload' ? msIds ?? [] : msIds);
      return;
    }
    const c = context.current;
    c.toast(text);
    setAction(null);
    void c.track(new Promise<void>((resolve) => { setTimeout(resolve, RESTART_DELAY_MS); })).then(restartApp);
  };
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
    const shown = filterMembers(data.members, filter);
    const pending = data.members.reduce((n, m) => n + m.roles.filter((g) => g.approvalStatus === 'pending_approval').length, 0);
    body = (
      <>
        {exportError ? <Alert tone="bad" title={TEXT.exportFailed}>{errorText(ctx, exportError)}</Alert> : null}
        {pending ? (
          <Alert tone="warn">
            <div className="mx-row">
              <span>{pending === 1 ? ctx.li(TEXT.pendingOneNote) : ctx.fill(TEXT.pendingNote, { n: pending })}</span>
              <Button onClick={() => ctx.go('approvals')}>{ctx.li(TEXT.openApprovals)}</Button>
            </div>
          </Alert>
        ) : null}
        <Card title={TEXT.members} sub={ctx.fill(TEXT.membersSub, { shown: shown.length, total: data.members.length })} flush>
          <Filters filter={filter} systems={data.systems} onChange={setFilter} />
          {data.members.length === 0 ? (
            <EmptyState
              illustration={<Illustration scene="no-documents" size="sm" decorative />}
              title={TEXT.noMembers}
              text={TEXT.noMembersText}
              action={<Button variant="primary" onClick={() => setInviting(true)}>{ctx.li(TEXT.invite)}</Button>}
            />
          ) : shown.length === 0 ? (
            <div className="mx-small" style={{ padding: '0 var(--pad) var(--pad)' }}>{ctx.li(TEXT.noMatch)}</div>
          ) : (
            <MembersTable ctx={ctx} members={shown} systems={data.systems} onOpen={(m) => setOpenId(m.id)} />
          )}
        </Card>
      </>
    );
  }
  const tenancy = data?.tenancy ?? tenancyOf(ctx);
  const msOf = (slug: string) => [slug];
  return (
    <>
      {body}
      {data ? (
        <>
          <PersonDrawer
            ctx={ctx}
            member={member}
            data={data}
            onClose={() => setOpenId(null)}
            onAction={(kind, m) => setAction({ kind, member: m })}
            onRevoke={(m, g) => setRevoking({ member: m, grant: g })}
          />
          <InviteDialog
            ctx={ctx}
            adapter={adapter}
            open={inviting}
            tenancy={tenancy}
            onClose={() => setInviting(false)}
            onInvited={(email) => { setInviting(false); done(ctx.fill(TEXT.invited, { email })); }}
          />
          <EditDialog
            ctx={ctx}
            adapter={adapter}
            member={action?.kind === 'edit' ? action.member : null}
            members={data.members}
            onClose={() => setAction(null)}
            onSaved={(updated, renewal) => settle(ctx.li(TEXT.saved), renewal, action?.kind === 'edit' ? snapshotReload(action.member, updated) : null)}
          />
          <GrantDialog
            ctx={ctx}
            adapter={adapter}
            member={action?.kind === 'grant' ? action.member : null}
            members={data.members}
            systems={data.systems}
            onClose={() => setAction(null)}
            onGranted={(outcome, system, _form, message) => {
              const text: TextPair = outcome.approvalStatus === 'pending_approval' ? TEXT.grantPending : TEXT.granted;
              done(message ? `${ctx.li(text)}. ${ctx.li(message)}` : ctx.li(text), outcome.approvalStatus === 'active' ? msOf(system.slug) : null);
            }}
          />
          <RevokeDialog
            ctx={ctx}
            adapter={adapter}
            target={revoking}
            systems={data.systems}
            onClose={() => setRevoking(null)}
            onRevoked={(grant, renewal) => {
              setRevoking(null);
              // Your own grant reloads its system too: the server may have held it active while the dialog read it waiting.
              settle(ctx.li(TEXT.revoked), renewal, grant.approvalStatus === 'active' || renewal !== 'none' ? msOf(grant.ms) : null);
            }}
          />
          <PreRegisterDialog
            ctx={ctx}
            adapter={adapter}
            member={action?.kind === 'preRegister' ? action.member : null}
            providers={data.providers}
            onClose={() => setAction(null)}
            onDone={() => done(ctx.li(TEXT.registered))}
          />
          <ResetDialog
            ctx={ctx}
            adapter={adapter}
            member={action?.kind === 'reset' ? action.member : null}
            onClose={() => setAction(null)}
            onDone={() => done(ctx.li(TEXT.resetDone))}
          />
          <DisableDialog
            ctx={ctx}
            adapter={adapter}
            member={action?.kind === 'disable' ? action.member : null}
            tenancy={tenancy}
            onClose={() => setAction(null)}
            onDone={(m, status, heldIn) => done(
              ctx.fill(status === 'disabled' ? TEXT.disabled : TEXT.enabled, { name: m.displayName }),
              action?.kind === 'disable' ? snapshotReload(action.member, m, heldIn) : [],
            )}
          />
        </>
      ) : null}
    </>
  );
}
