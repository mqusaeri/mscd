// The forms and confirmations of the People and roles screen (MILESTONE-2 M2-10): Invite person, Edit, Grant role,
// Revoke role (with the open items held in that system), Pre-register company sign-in, Reset sign-in factor, Disable
// (with the open items per system and a typed confirmation while there are any) and Enable again. Forms use
// `useMutation`, so the action is disabled while it runs and the form stays open with the server's message after a
// refusal. A refusal of the licence user limit (`LIC-USERS`) shows the limit and who can raise it.
// A change of your own administration roles (Edit) or of your own active grant (Revoke role) gives the session a new
// id and CSRF token (F.1): the dialog stays busy until `GET /me` has given the client the new token, so the next change
// in the same page is accepted. The page may list a grant as waiting that another Tenant Admin has approved since, so
// every revocation of your own grant reads `GET /me`, and the Revoke dialog reads the current state of a waiting grant.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Button, Checkbox, ConfirmDialog, DateInput, Field, Modal, Select, TextInput, UI_TEXT, useText } from '../ui';
import { settled } from './adapter';
import {
  ADMIN_ROLES, BUSINESS_ROLES, adminRoleLabel, approversOf, editPatch, grantBody, grantErrors, inviteBody, inviteErrors, isSelf, isUserLimit,
  jobTitleBlock, kindLabel, needsApproval, refusalText, renewsOnEdit, renewsOnRevoke, revokesOwnRole, roleLabel, selfMember, selfOf, sessionRestart,
  activeTenantAdmins, errorText,
} from './model';
import type {
  AdminRole, EditForm, GrantForm, GrantModel, GrantOutcome, HoldingsSystem, InviteForm, Member, ProviderRef, Renewal, Result, SystemRef, UsersAdapter,
} from './model';
import { TEXT } from './text';

/** An adapter call as the `ApiResult` that `useMutation` keeps (status, error and field errors). */
export function asApi<T>(promise: Promise<Result<T>>): Promise<ApiResult<{ data: T; message?: TextPair | null }>> {
  return settled(promise).then((r) => (r.ok
    ? { ok: true as const, status: 200, data: { data: r.data, message: r.message ?? null } }
    : { ok: false as const, status: r.error.status, error: r.error }));
}

/**
 * `GET /me` after a change of the session user's own roles (F.1): the client takes the renewed session's CSRF token
 * from it. `reload` when a snapshot reload carries the change, `restart` when the app must load again: the roles the
 * shell read from `Me` changed (`sessionRestart`), or `GET /me` failed, so the token may be the old one.
 * The sample build has no session (`none`).
 */
export async function renewSession(ctx: HostContext, adapter: UsersAdapter): Promise<Renewal> {
  const res = await settled(adapter.renewSession());
  if (!res.ok) return 'restart';
  if (!res.data) return 'none';
  return sessionRestart(ctx.me, res.data) ? 'restart' : 'reload';
}

/** Edit: `PATCH /admin/users/{id}`, then `GET /me` when it changed your own administration roles. */
export async function saveEdit(ctx: HostContext, adapter: UsersAdapter, member: Member, patch: NonNullable<ReturnType<typeof editPatch>>): Promise<Result<{ member: Member; renewal: Renewal }>> {
  const res = await adapter.update(member.id, patch);
  if (!res.ok) return res;
  const renewal = renewsOnEdit(ctx, member, patch) ? await renewSession(ctx, adapter) : 'none';
  return { ok: true, data: { member: res.data, renewal } };
}

/**
 * Revoke role: `POST .../roles/{roleId}/revoke`, then `GET /me` when it was your own grant, whatever state the page
 * shows: the server renews the session when the grant is active in the database (`renewsOnRevoke`).
 */
export async function revokeGrant(ctx: HostContext, adapter: UsersAdapter, system: SystemRef, member: Member, grant: GrantModel): Promise<Result<Renewal>> {
  const res = await adapter.revoke(system, grant.grantId);
  if (!res.ok) return res;
  return { ok: true, data: renewsOnRevoke(ctx, member) ? await renewSession(ctx, adapter) : 'none', message: res.message ?? null };
}

/** The member and the grant a Revoke dialog opens with, as the page lists them. */
export interface RevokeTarget { member: Member; grant: GrantModel }

/**
 * The grant the Revoke dialog shows. For a grant the page lists as waiting, the state the server holds now: another
 * Tenant Admin may have approved it since the page loaded, and then the role itself is revoked (with its open items and,
 * for your own grant, the note on your session). `checking` while that is read; when the read fails or the grant is
 * gone, the page's state stays and the server's answer to the revocation says the rest.
 */
export function useCurrentGrant(adapter: UsersAdapter, target: RevokeTarget | null): CurrentGrant {
  const [read, setRead] = useState<GrantRead | null>(null);
  const check = needsGrantRead(target);
  useEffect(() => {
    if (!target || !check) return undefined;
    let live = true;
    settled(adapter.currentGrant(target.member, target.grant.grantId)).then((res) => {
      if (live) setRead({ target, grant: res.ok ? res.data : null });
    });
    return () => {
      live = false;
    };
  }, [adapter, target, check]);
  return currentGrantOf(target, read);
}

/** The grant a Revoke dialog shows, and whether its current state is still being read. */
export interface CurrentGrant { grant: GrantModel | null; checking: boolean }
/** The answer of `currentGrant` for one opening of the dialog (`target`): the grant, or null when the read failed or it is gone. */
export interface GrantRead { target: RevokeTarget; grant: GrantModel | null }

/** Whether the dialog reads the current state of the grant: a grant the page lists as waiting. */
export const needsGrantRead = (target: RevokeTarget | null): boolean => target?.grant.approvalStatus === 'pending_approval';

/** The grant the dialog shows for `target`, given the latest read (`useCurrentGrant`). */
export function currentGrantOf(target: RevokeTarget | null, read: GrantRead | null): CurrentGrant {
  if (!target) return { grant: null, checking: false };
  if (!needsGrantRead(target)) return { grant: target.grant, checking: false };
  if (read?.target !== target) return { grant: target.grant, checking: true };
  return { grant: read.grant ?? target.grant, checking: false };
}

/** The server's field errors by the field names of a form (`body.email` names `email`). */
function serverFields(error: ApiError | null, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of error?.errors ?? []) {
    const k = String(e.path).replace(/^body\./, '');
    if (fields.includes(k) && !out[k]) out[k] = e.message;
  }
  return out;
}

/**
 * The licence user limit (`LIC-USERS`, D-15): the server's message, and who can raise the limit. With multi tenancy the
 * limit comes from the organisation's plan, which the MSCD service provider changes; with single tenancy a licence
 * with more users is installed on the Licence screen.
 */
export function LimitAlert({ ctx, error, tenancy }: { ctx: HostContext; error: ApiError; tenancy: 'single' | 'multi' }) {
  const canLicence = tenancy === 'single' && ctx.orgCan('license.manage');
  return (
    <Alert tone="bad" title={TEXT.limitTitle}>
      <div>{errorText(ctx, error)}</div>
      <div style={{ marginTop: 6 }}>{ctx.li(tenancy === 'multi' ? TEXT.limitSaas : TEXT.limitOnPrem)}</div>
      {canLicence ? <div style={{ marginTop: 8 }}><Button onClick={() => ctx.go('license')}>{ctx.li(TEXT.openLicence)}</Button></div> : null}
    </Alert>
  );
}

/** A refusal: the user limit with its explanation, else the server's message with its field messages. */
export function Refusal({ ctx, error, tenancy }: { ctx: HostContext; error: ApiError | null; tenancy: 'single' | 'multi' }) {
  if (!error) return null;
  if (isUserLimit(error)) return <LimitAlert ctx={ctx} error={error} tenancy={tenancy} />;
  return <Alert tone="bad">{refusalText(ctx, error)}</Alert>;
}

function AdminRoleChecks({ value, onChange, disabled }: { value: AdminRole[]; onChange(v: AdminRole[]): void; disabled?: boolean }) {
  return (
    <div className="mx-stack" style={{ gap: 6 }}>
      {ADMIN_ROLES.map((r) => (
        <Checkbox
          key={r}
          name={`admin-${r}`}
          checked={value.includes(r)}
          disabled={disabled}
          onChange={(on) => onChange(on ? ADMIN_ROLES.filter((x) => x === r || value.includes(x)) : value.filter((x) => x !== r))}
          label={adminRoleLabel(r)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Invite person
// ---------------------------------------------------------------------------------------------------------------

export function InviteDialog({ ctx, adapter, open, tenancy, onClose, onInvited }: {
  ctx: HostContext;
  adapter: UsersAdapter;
  open: boolean;
  tenancy: 'single' | 'multi';
  onClose(): void;
  onInvited(email: string): void;
}) {
  const empty: InviteForm = { email: '', displayName: '', jobTitle: '', adminRoles: [] };
  const [form, setForm] = useState<InviteForm>(empty);
  const [local, setLocal] = useState<ReturnType<typeof inviteErrors>>({});
  const key = useRef(newIdempotencyKey());
  const save = useMutation((f: InviteForm) => asApi(adapter.invite(inviteBody(f), key.current)));
  const { reset } = save;
  useEffect(() => {
    if (open) {
      setForm(empty);
      setLocal({});
      key.current = newIdempotencyKey();
      reset();
    }
  }, [open]);
  const set = <K extends keyof InviteForm>(k: K, v: InviteForm[K]) => {
    const next = { ...form, [k]: v };
    setForm(next);
    if (Object.keys(local).length) setLocal(inviteErrors(next, ctx.lang));
    // A new address is a new invitation (a new Idempotency-Key).
    if (k === 'email') key.current = newIdempotencyKey();
  };
  const server = serverFields(save.error, ['email', 'displayName', 'jobTitle', 'adminRoles']);
  const err = (k: keyof InviteForm) => local[k] ?? server[k] ?? null;
  const submit = () => {
    const problems = inviteErrors(form, ctx.lang);
    setLocal(problems);
    if (Object.keys(problems).length) return;
    save.submit(form).then((res) => {
      if (res.ok) onInvited(form.email.trim());
    });
  };
  const refused = save.error && !Object.keys(server).length ? save.error : null;
  return (
    <Modal
      open={open}
      title={TEXT.inviteTitle}
      sub={TEXT.inviteSub}
      onClose={onClose}
      footer={<><Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button><Button variant="primary" busy={save.busy} onClick={submit}>{ctx.li(TEXT.sendInvite)}</Button></>}
    >
      <Field label={TEXT.email} error={err('email')} required>
        <TextInput type="email" value={form.email} onChange={(v) => set('email', v)} name="email" autoComplete="off" maxLength={254} />
      </Field>
      <Field label={TEXT.displayName} error={err('displayName')} required>
        <TextInput value={form.displayName} onChange={(v) => set('displayName', v)} name="displayName" maxLength={150} />
      </Field>
      <Field label={TEXT.jobTitle} error={err('jobTitle')}>
        <TextInput value={form.jobTitle} onChange={(v) => set('jobTitle', v)} name="jobTitle" maxLength={150} />
      </Field>
      <Field label={TEXT.adminRoles} hint={TEXT.adminRolesHint}>
        <AdminRoleChecks value={form.adminRoles} onChange={(v) => set('adminRoles', v)} />
      </Field>
      <Refusal ctx={ctx} error={refused} tenancy={tenancy} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------------------------------------------

export function EditDialog({ ctx, adapter, member, members, onClose, onSaved }: {
  ctx: HostContext;
  adapter: UsersAdapter;
  member: Member | null;
  members: readonly Member[];
  onClose(): void;
  /** After the save and, for a change of your own administration roles, after `GET /me` (`renewal`). */
  onSaved(updated: Member, renewal: Renewal): void;
}) {
  const [form, setForm] = useState<EditForm>({ jobTitle: '', adminRoles: [] });
  const [note, setNote] = useState<TextPair | null>(null);
  const save = useMutation((input: { member: Member; patch: NonNullable<ReturnType<typeof editPatch>> }) => asApi(saveEdit(ctx, adapter, input.member, input.patch)));
  const { reset } = save;
  useEffect(() => {
    if (member) {
      setForm({ jobTitle: member.jobTitle ?? '', adminRoles: [...member.adminRoles] });
      setNote(null);
      reset();
    }
  }, [member?.id]);
  if (!member) return null;
  const jobBlock = jobTitleBlock(ctx, member);
  const self = isSelf(ctx, member);
  const otherAdmins = activeTenantAdmins(members).filter((m) => m.id !== member.id).length;
  const dropsLastAdmin = member.adminRoles.includes('tenant_admin') && !form.adminRoles.includes('tenant_admin') && member.membershipStatus === 'active' && otherAdmins === 0;
  const submit = () => {
    setNote(null);
    if (dropsLastAdmin) return;
    const patch = editPatch(ctx, form, member);
    if (!patch) {
      setNote(TEXT.noChange);
      return;
    }
    save.submit({ member, patch }).then((res) => {
      if (res.ok) onSaved(res.data.data.member, res.data.data.renewal);
    });
  };
  const server = serverFields(save.error, ['jobTitle', 'adminRoles']);
  const refused = save.error && !Object.keys(server).length ? save.error : null;
  return (
    <Modal
      open
      title={ctx.fill(TEXT.editTitle, { name: member.displayName })}
      sub={TEXT.editSub}
      onClose={onClose}
      footer={<><Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button><Button variant="primary" busy={save.busy} onClick={submit}>{ctx.li(UI_TEXT.save)}</Button></>}
    >
      <Field label={TEXT.jobTitle} hint={jobBlock ?? undefined} error={server.jobTitle ?? null}>
        <TextInput value={form.jobTitle} onChange={(v) => setForm({ ...form, jobTitle: v })} name="jobTitle" maxLength={150} disabled={Boolean(jobBlock)} />
      </Field>
      <Field label={TEXT.adminRoles} hint={TEXT.adminRolesHint} error={dropsLastAdmin ? TEXT.lastAdminRole : server.adminRoles ?? null}>
        <AdminRoleChecks value={form.adminRoles} onChange={(v) => setForm({ ...form, adminRoles: v })} disabled={member.kind === 'guest'} />
      </Field>
      {self ? <Alert tone="warn">{ctx.li(TEXT.ownAdminWarning)}</Alert> : null}
      {!self && form.adminRoles.length > 0 && member.adminRoles.length === 0 ? <Alert tone="info">{ctx.li(TEXT.adminGrantNote)}</Alert> : null}
      {note ? <Alert tone="info">{ctx.li(note)}</Alert> : null}
      {refused ? <Alert tone="bad">{refusalText(ctx, refused)}</Alert> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Grant role
// ---------------------------------------------------------------------------------------------------------------

/**
 * Who approves a grant to `member` (D2-12, H.3): a grant to yourself or to an administrator waits for another Tenant
 * Admin who neither asks for it nor receives it; the warning names them, or says that the organisation has none.
 */
export function ApprovalNote({ ctx, member, members }: { ctx: HostContext; member: Member; members: readonly Member[] }) {
  if (!needsApproval(ctx, member)) return null;
  const me = selfMember(ctx, members);
  const approvers = approversOf(members, me ? { id: me.id, handle: me.handle } : { handle: ctx.person.handle }, member.id);
  return (
    <Alert tone="warn">
      <div>{isSelf(ctx, member) ? ctx.li(TEXT.approvalNeededSelf) : ctx.fill(TEXT.approvalNeededAdmin, { name: member.displayName })}</div>
      <div style={{ marginTop: 6 }}>
        {approvers.length ? ctx.fill(TEXT.approversAre, { names: approvers.map((a) => a.displayName).join(', ') }) : ctx.li(TEXT.singleAdmin)}
      </div>
    </Alert>
  );
}

export function GrantDialog({ ctx, adapter, member, members, systems, onClose, onGranted }: {
  ctx: HostContext;
  adapter: UsersAdapter;
  member: Member | null;
  members: readonly Member[];
  systems: readonly SystemRef[];
  onClose(): void;
  onGranted(outcome: GrantOutcome, system: SystemRef, form: GrantForm, message: TextPair | null): void;
}) {
  const usable = systems.filter((s) => !s.archived);
  const [form, setForm] = useState<GrantForm>({ ms: '', role: '', isPrimary: false, validUntil: '' });
  const [local, setLocal] = useState<ReturnType<typeof grantErrors>>({});
  const key = useRef(newIdempotencyKey());
  const save = useMutation((input: { system: SystemRef; form: GrantForm; member: Member }) => asApi(adapter.grant(input.system, grantBody(input.form, input.member), key.current)));
  const { reset } = save;
  useEffect(() => {
    if (member) {
      setForm({ ms: usable.length === 1 ? usable[0].slug : '', role: '', isPrimary: false, validUntil: '' });
      setLocal({});
      key.current = newIdempotencyKey();
      reset();
    }
  }, [member?.id]);
  if (!member) return null;
  const today = ctx.D?.TODAY_S ?? null;
  const set = <K extends keyof GrantForm>(k: K, v: GrantForm[K]) => {
    const next = { ...form, [k]: v };
    if (k === 'role' && v !== 'ms_manager') next.isPrimary = false;
    setForm(next);
    key.current = newIdempotencyKey();
    if (Object.keys(local).length) setLocal(grantErrors(next, member, today, ctx));
  };
  const submit = () => {
    const problems = grantErrors(form, member, today, ctx);
    setLocal(problems);
    if (Object.keys(problems).length) return;
    const system = usable.find((s) => s.slug === form.ms)!;
    save.submit({ system, form, member }).then((res) => {
      if (res.ok) onGranted(res.data.data, system, form, res.data.message ?? null);
    });
  };
  const server = serverFields(save.error, ['role', 'isPrimary', 'validUntil', 'user']);
  const err = (k: keyof GrantForm) => local[k] ?? server[k] ?? null;
  const refused = save.error && !Object.keys(server).length ? save.error : null;
  return (
    <Modal
      open
      title={ctx.fill(TEXT.grantTitle, { name: member.displayName })}
      sub={TEXT.grantSub}
      onClose={onClose}
      footer={<><Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button><Button variant="primary" busy={save.busy} disabled={!usable.length} onClick={submit}>{ctx.li(TEXT.grantSubmit)}</Button></>}
    >
      {!usable.length ? <Alert tone="info">{ctx.li(TEXT.noSystems)}</Alert> : null}
      <Field label={TEXT.system} error={err('ms')} required>
        <Select value={form.ms} onChange={(v) => set('ms', v)} empty={UI_TEXT.choose} name="ms" options={usable.map((s) => ({ value: s.slug, label: `${s.code}, ${s.name}` }))} />
      </Field>
      <Field label={TEXT.role} error={err('role')} required>
        <Select value={form.role} onChange={(v) => set('role', v as GrantForm['role'])} empty={UI_TEXT.choose} name="role" options={BUSINESS_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))} />
      </Field>
      {form.role === 'ms_manager' ? (
        <Field label={TEXT.primaryLabel} hint={TEXT.primaryHint}>
          <Checkbox checked={form.isPrimary} onChange={(v) => set('isPrimary', v)} label={TEXT.primaryLabel} name="isPrimary" />
        </Field>
      ) : null}
      <Field label={TEXT.validUntil} hint={TEXT.validUntilHint} error={err('validUntil')} required={form.role === 'external_auditor'}>
        <DateInput value={form.validUntil} onChange={(v) => set('validUntil', v)} name="validUntil" min={today ?? undefined} />
      </Field>
      <ApprovalNote ctx={ctx} member={member} members={members} />
      {refused ? <Alert tone="bad">{refusalText(ctx, refused)}</Alert> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Open items held (admin.users.holdings: counts only, no titles, H.13)
// ---------------------------------------------------------------------------------------------------------------

type HoldingsState = { loading: boolean; systems: HoldingsSystem[] | null; error: ApiError | null };

/** Loads the open items of a member per system while `active`. */
export function useHoldings(adapter: UsersAdapter, member: Member | null, active: boolean): HoldingsState & { reload(): void } {
  const [state, setState] = useState<HoldingsState>({ loading: false, systems: null, error: null });
  const [tick, setTick] = useState(0);
  const id = member?.id ?? null;
  useEffect(() => {
    if (!active || !id) {
      setState({ loading: false, systems: null, error: null });
      return undefined;
    }
    let live = true;
    setState({ loading: true, systems: null, error: null });
    settled(adapter.holdings(id)).then((res) => {
      if (live) setState(res.ok ? { loading: false, systems: res.data, error: null } : { loading: false, systems: null, error: res.error });
    });
    return () => {
      live = false;
    };
  }, [adapter, id, active, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

/** The open items of one system: the count per kind and the primary MS Manager to contact. */
export function SystemHoldings({ ctx, member, system, onHandover }: { ctx: HostContext; member: Member; system: HoldingsSystem; onHandover?: (() => void) | null }) {
  const t = useText();
  const kinds = Object.entries(system.counts).filter(([, n]) => (n ?? 0) > 0);
  const manager = system.primaryManager;
  return (
    <div className="mx-stack" style={{ gap: 6, padding: '10px 12px', border: '1px solid var(--bd)', borderRadius: 8, background: 'var(--sur2)' }} data-holdings={system.ms}>
      <div style={{ fontWeight: 600 }}>
        {system.name}
        <span className="mx-small" style={{ marginLeft: 8 }}>{ctx.fill(TEXT.holdingsTotal, { n: system.total })}</span>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {kinds.map(([kind, n]) => <li key={kind}>{`${t(kindLabel(kind))}: ${n}`}</li>)}
      </ul>
      <div className="mx-small">
        {manager ? ctx.fill(TEXT.primaryManager, { name: manager.displayName, email: manager.email }) : ctx.li(TEXT.noPrimaryManager)}
      </div>
      {manager && manager.handle !== member.handle && manager.handle !== selfOf(ctx).handle ? <div className="mx-small">{ctx.fill(TEXT.askManager, { name: manager.displayName })}</div> : null}
      {onHandover ? <div><Button variant="link" onClick={onHandover}>{ctx.li(TEXT.openHandover)}</Button></div> : null}
    </div>
  );
}

/**
 * The Handover link of a system, when the session may open Handover there (MS Manager or Programme Owner, H.13). The
 * name goes along, so Handover can name a person who is no longer among the active members with a role.
 */
function handoverLink(ctx: HostContext, member: Member, ms: string): (() => void) | null {
  if (!ctx.can(ms, 'record.assign')) return null;
  return () => ctx.go('handover', { ms, params: { handle: member.handle, name: member.displayName } });
}

// ---------------------------------------------------------------------------------------------------------------
// Revoke role
// ---------------------------------------------------------------------------------------------------------------

export function RevokeDialog({ ctx, adapter, target, systems, onClose, onRevoked }: {
  ctx: HostContext;
  adapter: UsersAdapter;
  /** The member and the grant as the page lists them; a waiting grant is read again (`useCurrentGrant`). */
  target: RevokeTarget | null;
  systems: readonly SystemRef[];
  onClose(): void;
  /** After the revocation and, for your own grant, after `GET /me` (`renewal`); `grant` in its current state. */
  onRevoked(grant: GrantModel, renewal: Renewal): void;
}) {
  const current = useCurrentGrant(adapter, target);
  const pending = current.grant ? current.grant.approvalStatus !== 'active' : false;
  const holdings = useHoldings(adapter, target?.member ?? null, Boolean(target) && !current.checking && !pending);
  const save = useMutation((input: { system: SystemRef; member: Member; grant: GrantModel }) => asApi(revokeGrant(ctx, adapter, input.system, input.member, input.grant)));
  const { reset } = save;
  useEffect(() => reset(), [target?.grant.grantId]);
  if (!target || !current.grant) return null;
  const { member } = target;
  const grant = current.grant;
  const system = systems.find((s) => s.slug === grant.ms) ?? { id: grant.ms, slug: grant.ms, code: grant.ms.toUpperCase(), name: grant.ms, archived: false };
  const values = { role: ctx.li(roleLabel(grant.role)), system: system.code, name: member.displayName };
  const held = holdings.systems?.find((s) => s.ms === grant.ms) ?? null;
  let items: ReactNode = null;
  if (!pending) {
    if (holdings.loading) items = <div className="mx-small" role="status">{ctx.li(TEXT.holdingsLoading)}</div>;
    else if (holdings.error) items = <Alert tone="warn">{`${ctx.li(TEXT.holdingsFailed)} ${errorText(ctx, holdings.error)}`}</Alert>;
    else if (held && held.total > 0) items = <SystemHoldings ctx={ctx} member={member} system={held} onHandover={handoverLink(ctx, member, grant.ms)} />;
    else if (holdings.systems) items = <div className="mx-small">{ctx.fill(TEXT.holdingsNone, values)}</div>;
  }
  return (
    <ConfirmDialog
      open
      title={ctx.fill(TEXT.revokeTitle, values)}
      body={(
        <div className="mx-stack" style={{ gap: 10 }}>
          {current.checking ? <div className="mx-small" role="status">{ctx.li(TEXT.grantChecking)}</div> : null}
          <div>{pending ? ctx.li(TEXT.revokePending) : ctx.fill(TEXT.revokeBody, values)}</div>
          {!pending ? <div style={{ fontWeight: 600 }}>{ctx.fill(TEXT.holdingsTitle, values)}</div> : null}
          {items}
          {revokesOwnRole(ctx, member, grant) ? <Alert tone="warn">{ctx.li(TEXT.revokeOwn)}</Alert> : null}
        </div>
      )}
      confirmLabel={TEXT.revokeConfirm}
      tone="bad"
      busy={save.busy}
      error={save.error ? refusalText(ctx, save.error) : null}
      onConfirm={() => save.submit({ system, member, grant }).then((res) => { if (res.ok) onRevoked(grant, res.data.data); })}
      onCancel={onClose}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Pre-register company sign-in
// ---------------------------------------------------------------------------------------------------------------

export function PreRegisterDialog({ ctx, adapter, member, providers, onClose, onDone }: {
  ctx: HostContext;
  adapter: UsersAdapter;
  member: Member | null;
  providers: readonly ProviderRef[];
  onClose(): void;
  onDone(): void;
}) {
  const usable = providers.filter((p) => p.enabled);
  const [provider, setProvider] = useState('');
  const [subject, setSubject] = useState('');
  const [local, setLocal] = useState<{ provider?: TextPair; subject?: TextPair }>({});
  const key = useRef(newIdempotencyKey());
  const save = useMutation((input: { id: string; provider: string; subject: string }) => asApi(adapter.registerIdentity(input.id, { provider: input.provider, subject: input.subject }, key.current)));
  const { reset } = save;
  useEffect(() => {
    if (member) {
      setProvider(usable.length === 1 ? usable[0].slug : '');
      setSubject('');
      setLocal({});
      key.current = newIdempotencyKey();
      reset();
    }
  }, [member?.id]);
  if (!member) return null;
  const submit = () => {
    const problems: typeof local = {};
    if (!provider) problems.provider = TEXT.required;
    if (!subject.trim()) problems.subject = TEXT.required;
    setLocal(problems);
    if (Object.keys(problems).length) return;
    save.submit({ id: member.id, provider, subject: subject.trim() }).then((res) => {
      if (res.ok) onDone();
    });
  };
  const server = serverFields(save.error, ['provider', 'subject']);
  const refused = save.error && !Object.keys(server).length ? save.error : null;
  return (
    <Modal
      open
      title={ctx.fill(TEXT.preTitle, { name: member.displayName })}
      sub={TEXT.preSub}
      onClose={onClose}
      footer={<><Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button><Button variant="primary" busy={save.busy} onClick={submit}>{ctx.li(TEXT.register)}</Button></>}
    >
      <Field label={TEXT.provider} error={local.provider ?? server.provider ?? null} required>
        <Select value={provider} onChange={(v) => { setProvider(v); key.current = newIdempotencyKey(); }} empty={UI_TEXT.choose} name="provider" options={usable.map((p) => ({ value: p.slug, label: `${p.name} (${p.kind.toUpperCase()})` }))} />
      </Field>
      <Field label={TEXT.subject} hint={TEXT.subjectHint} error={local.subject ?? server.subject ?? null} required>
        <TextInput value={subject} onChange={(v) => { setSubject(v); key.current = newIdempotencyKey(); }} name="subject" autoComplete="off" maxLength={255} />
      </Field>
      {refused ? <Alert tone="bad">{refusalText(ctx, refused)}</Alert> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Reset sign-in factor
// ---------------------------------------------------------------------------------------------------------------

export function ResetDialog({ ctx, adapter, member, onClose, onDone }: { ctx: HostContext; adapter: UsersAdapter; member: Member | null; onClose(): void; onDone(): void }) {
  const save = useMutation((id: string) => asApi(adapter.resetMfa(id)));
  const { reset } = save;
  useEffect(() => reset(), [member?.id]);
  if (!member) return null;
  return (
    <ConfirmDialog
      open
      title={ctx.fill(TEXT.resetTitle, { name: member.displayName })}
      body={(
        <div className="mx-stack" style={{ gap: 8 }}>
          <div>{ctx.fill(TEXT.resetBody, { name: member.displayName })}</div>
          {member.otherMemberships ? <div>{ctx.fill(TEXT.resetOtherOrg, { name: member.displayName })}</div> : null}
        </div>
      )}
      confirmLabel={TEXT.resetConfirm}
      tone="bad"
      busy={save.busy}
      error={save.error ? refusalText(ctx, save.error) : null}
      onConfirm={() => save.submit(member.id).then((res) => { if (res.ok) onDone(); })}
      onCancel={onClose}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Disable and Enable again
// ---------------------------------------------------------------------------------------------------------------

export function DisableDialog({ ctx, adapter, member, tenancy, onClose, onDone }: {
  ctx: HostContext;
  adapter: UsersAdapter;
  member: Member | null;
  tenancy: 'single' | 'multi';
  onClose(): void;
  /** `heldIn`: the systems where the member holds open items, as the dialog counted them. */
  onDone(member: Member, status: 'active' | 'disabled', heldIn: string[]): void;
}) {
  const enabling = member?.membershipStatus === 'disabled';
  const holdings = useHoldings(adapter, member, Boolean(member) && !enabling);
  const save = useMutation((input: { id: string; status: 'active' | 'disabled' }) => asApi(adapter.update(input.id, { membershipStatus: input.status })));
  const { reset } = save;
  useEffect(() => reset(), [member?.id]);
  if (!member) return null;
  const systems = (holdings.systems ?? []).filter((s) => s.total > 0);
  const total = systems.reduce((n, s) => n + s.total, 0);
  const status = enabling ? 'active' as const : 'disabled' as const;
  const confirm = () => save.submit({ id: member.id, status }).then((res) => { if (res.ok) onDone(res.data.data, status, systems.map((s) => s.ms)); });
  if (enabling) {
    return (
      <ConfirmDialog
        open
        title={ctx.fill(TEXT.enableTitle, { name: member.displayName })}
        body={(
          <div className="mx-stack" style={{ gap: 10 }}>
            <div>{ctx.fill(TEXT.enableBody, { name: member.displayName })}</div>
            {save.error ? <Refusal ctx={ctx} error={save.error} tenancy={tenancy} /> : null}
          </div>
        )}
        confirmLabel={TEXT.enableConfirm}
        busy={save.busy}
        onConfirm={confirm}
        onCancel={onClose}
      />
    );
  }
  return (
    <ConfirmDialog
      open
      title={ctx.fill(TEXT.disableTitle, { name: member.displayName })}
      body={(
        <div className="mx-stack" style={{ gap: 10 }}>
          <div>{ctx.fill(TEXT.disableBody, { name: member.displayName })}</div>
          {holdings.loading ? <div className="mx-small" role="status">{ctx.li(TEXT.holdingsLoading)}</div> : null}
          {holdings.error ? <Alert tone="warn">{`${ctx.li(TEXT.holdingsFailed)} ${errorText(ctx, holdings.error)}`}</Alert> : null}
          {systems.length ? (
            <>
              <div style={{ fontWeight: 600 }}>{ctx.li(TEXT.disableHoldings)}</div>
              {systems.map((s) => <SystemHoldings key={s.ms} ctx={ctx} member={member} system={s} onHandover={handoverLink(ctx, member, s.ms)} />)}
              <div className="mx-small">{ctx.li(TEXT.disableHoldingsNote)}</div>
            </>
          ) : holdings.systems ? <div className="mx-small">{ctx.fill(TEXT.holdingsNoneAll, { name: member.displayName })}</div> : null}
        </div>
      )}
      confirmLabel={TEXT.disableConfirm}
      tone="bad"
      busy={save.busy}
      requireText={holdings.loading || holdings.error || total > 0 ? member.email : undefined}
      error={save.error ? refusalText(ctx, save.error) : null}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}
