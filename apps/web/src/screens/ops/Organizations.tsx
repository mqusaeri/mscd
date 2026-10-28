// Operator console, Organisations (MILESTONE-2 M2-16, M2-S12): the customer organisations of a multi tenancy service
// with their status, plan, users against the limit, the last day of the plan with the days left, the licence state and
// the verified domains, filtered by status and searched by slug or name; "Manage" opens the organisation drawer
// (OrgDrawer.tsx: overview, status, domains, entitlements, history). "Create organisation" (slug with the permanence
// warning, name, time zone, sites, first administrator and the plan preset of `ops.plans.list`), whose one-time link
// shows only when the answer carries one (never on SaaS, where mail.required is true); and "Install licence" per
// organisation (`PUT /admin/license` with `{org, licence}`).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, EmptyState, Field, FileInput, Modal, Pager, Select, Table, TextInput, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { copyText } from '../organization/InstallationPanel';
import { timeZones } from '../organization/model';
import { LoadState, asApi, useLoad } from './Health';
import { EMPTY_CREATE, LICENCE_TEXT, ORG_PAGE_SIZE, createBody, createErrors, isSingleTenancy, multiTenancy } from './model';
import type { CreateForm, Created, OpsAdapter, OrgCreate, OrgItem, OrgPage } from './model';
import { ORG_STATUSES, STATUS_LABEL } from './org-model';
import type { OrgStatus, PlanPreset } from './org-model';
import { OrgDrawer } from './OrgDrawer';
import { DomainName, StatusBadge, UsersOf, ValidUntil } from './org-parts';
import { ORG_TEXT } from './org-text';
import { TEXT } from './text';

/** "Create organisation": the form, then the result (the invitation sent, or the one-time link to pass on). */
export function CreateDialog({ ctx, adapter, open, onClose, onCreated }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  open: boolean;
  onClose(): void;
  onCreated(created: Created): void;
}) {
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE);
  const [shown, setShown] = useState<Record<string, TextPair>>({});
  const [created, setCreated] = useState<Created | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey());
  const [presets, setPresets] = useState<PlanPreset[] | null>(null);
  const [plansFailed, setPlansFailed] = useState(false);
  const presetTouched = useRef(false);
  const zones = useMemo(() => timeZones(form.timeZone), [form.timeZone]);
  // The plan presets, read when the dialog opens; the first preset is the default until the operator picks another.
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    void adapter.plans().then((res) => {
      if (!live) return;
      setPresets(res.ok ? res.data : []);
      setPlansFailed(!res.ok);
      if (res.ok && res.data.length && !presetTouched.current) setForm((f) => ({ ...f, preset: res.data[0].name }));
    }, () => undefined);
    return () => { live = false; };
  }, [open, adapter]);
  const run = useCallback((input: { body: OrgCreate; key: string }) => adapter.createOrganization(input.body, input.key).then(asApi), [adapter]);
  const mutation = useMutation<{ body: OrgCreate; key: string }, Created>(run);
  const { reset } = mutation;
  useEffect(() => {
    if (open) return;
    setForm(EMPTY_CREATE);
    setShown({});
    setCreated(null);
    setKey(newIdempotencyKey());
    setPresets(null);
    setPlansFailed(false);
    presetTouched.current = false;
    reset();
  }, [open]);
  const set = (field: keyof CreateForm) => (value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    if (field === 'preset') presetTouched.current = true;
    const path = field === 'email' ? 'firstAdmin.email' : field === 'displayName' ? 'firstAdmin.displayName' : field;
    setShown((s) => {
      const next = { ...s };
      delete next[path];
      return next;
    });
    // A changed form is a new request: a new idempotency key.
    setKey(newIdempotencyKey());
  };
  const submit = () => {
    const errors = createErrors(form);
    setShown(errors);
    if (Object.keys(errors).length) return;
    void ctx.track(mutation.submit({ body: createBody(form), key })).then((res) => {
      if (!res.ok) return;
      setCreated(res.data);
      onCreated(res.data);
      ctx.toast(ctx.fill(TEXT.created, { slug: res.data.slug }));
    }, () => undefined);
  };
  const server = mutation.fields;
  const err = (path: string) => shown[path] ?? server[path] ?? null;
  const fieldPaths = ['slug', 'name', 'timeZone', 'siteCount', 'firstAdmin.email', 'firstAdmin.displayName', 'preset'];
  const planOptions = [
    ...(presets ?? []).map((p) => ({ value: p.name, label: ctx.fill(ORG_TEXT.presetSummary, { name: p.name, users: p.maxUsers, systems: p.maxManagementSystems, days: p.validDays }) })),
    { value: '', label: ORG_TEXT.noPlanYet },
  ];
  const general = mutation.error && !fieldPaths.some((p) => server[p]) ? mutation.error.message : null;
  return (
    <Modal
      open={open}
      title={TEXT.createTitle}
      sub={TEXT.createSub}
      onClose={onClose}
      footer={created ? <Button variant="primary" onClick={onClose}>{ctx.li(TEXT.close)}</Button> : (
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.create)}</Button>
        </>
      )}
    >
      {created ? (
        <div className="mx-stack" data-created={created.slug}>
          <Alert tone="ok" title={created.message ?? [ctx.fill(TEXT.created, { slug: created.slug }), ctx.fill(TEXT.created, { slug: created.slug })]} />
          {created.invitationUrl ? (
            <>
              <span>{ctx.fill(TEXT.invitationLink, { email: form.email.trim() })}</span>
              <code className="mx-mono" style={{ overflowWrap: 'anywhere', color: 'var(--tx)', userSelect: 'all' }}>{created.invitationUrl}</code>
              <div>
                <Button onClick={() => { void copyText(created.invitationUrl ?? '').then((ok) => ctx.toast(ctx.li(ok ? TEXT.linkCopied : TEXT.linkNotCopied))); }}>{ctx.li(TEXT.copyLink)}</Button>
              </div>
            </>
          ) : created.invitationSent ? <span>{ctx.fill(TEXT.invitationSent, { email: form.email.trim() })}</span> : null}
        </div>
      ) : (
        <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <Alert tone="warn">{ctx.li(TEXT.slugWarning)}</Alert>
          <Field label={TEXT.slug} hint={TEXT.slugHint} error={err('slug')} required>
            <TextInput value={form.slug} onChange={(v) => set('slug')(v.toLowerCase())} maxLength={40} autoComplete="off" />
          </Field>
          <Field label={TEXT.orgName} error={err('name')} required>
            <TextInput value={form.name} onChange={set('name')} maxLength={200} autoComplete="off" />
          </Field>
          <Field label={TEXT.timeZone} error={err('timeZone')} required>
            <Select value={form.timeZone} onChange={set('timeZone')} options={zones.map((z) => ({ value: z, label: z }))} />
          </Field>
          <Field label={TEXT.sites} error={err('siteCount')} required>
            <TextInput type="number" value={form.siteCount} onChange={set('siteCount')} />
          </Field>
          <Field label={TEXT.adminEmail} error={err('firstAdmin.email')} required>
            <TextInput type="email" value={form.email} onChange={set('email')} maxLength={254} autoComplete="off" />
          </Field>
          <Field label={TEXT.adminName} error={err('firstAdmin.displayName')} required>
            <TextInput value={form.displayName} onChange={set('displayName')} maxLength={150} autoComplete="off" />
          </Field>
          <Field label={ORG_TEXT.plan} hint={plansFailed ? ORG_TEXT.createPlansFailed : ORG_TEXT.planHint} error={err('preset')}>
            <Select value={form.preset} onChange={set('preset')} options={planOptions} />
          </Field>
          {general ? <Alert tone="bad">{ctx.li(general)}</Alert> : null}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Modal>
  );
}

/** Reads a chosen file as text. */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** "Install licence" for one organisation: a .json file or the pasted text, sent as `{org, licence}`. */
export function LicenceDialog({ ctx, adapter, org, onClose, onInstalled }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  org: OrgItem | null;
  onClose(): void;
  onInstalled(org: OrgItem): void;
}) {
  const [text, setText] = useState('');
  const [shown, setShown] = useState<TextPair | null>(null);
  const run = useCallback((input: { org: string; licence: unknown }) => adapter.installLicence(input.org, input.licence).then(asApi), [adapter]);
  const mutation = useMutation<{ org: string; licence: unknown }, null>(run);
  const { reset } = mutation;
  useEffect(() => {
    if (org) return;
    setText('');
    setShown(null);
    reset();
  }, [org]);
  const onFile = (file: File | null) => {
    if (!file) return;
    readText(file).then((t) => { setText(t); setShown(null); }, () => setShown(TEXT.unreadable));
  };
  const submit = () => {
    if (!org) return;
    if (!text.trim()) return setShown(TEXT.licenceEmpty);
    let licence: unknown;
    try {
      licence = JSON.parse(text);
    } catch {
      return setShown(TEXT.licenceNotJson);
    }
    setShown(null);
    void ctx.track(mutation.submit({ org: org.slug, licence })).then((res) => {
      if (!res.ok) return;
      ctx.toast(ctx.fill(TEXT.licenceInstalled, { org: org.name }));
      onInstalled(org);
    }, () => undefined);
  };
  const error = mutation.error;
  const detail = error && !error.rule ? Object.values(mutation.fields)[0] ?? null : null;
  const message = shown ? ctx.li(shown) : error ? ctx.li(error.message) + (detail ? ` (${detail})` : '') : null;
  return (
    <Modal
      open={Boolean(org)}
      title={org ? ctx.fill(TEXT.installTitle, { org: org.name }) : TEXT.installLicence}
      sub={TEXT.installSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.installLicence)}</Button>
        </>
      )}
    >
      <Field label={TEXT.licenceFile}>
        <FileInput accept=".json,application/json" onFile={onFile} />
      </Field>
      <Field label={TEXT.licenceText} hint={TEXT.licenceHint} error={message} required>
        <Textarea value={text} onChange={(v) => { setText(v); setShown(null); mutation.reset(); }} rows={8} mono />
      </Field>
    </Modal>
  );
}

export function OrganizationsTab({ ctx, adapter, creating, setCreating }: { ctx: HostContext; adapter: OpsAdapter; creating: boolean; setCreating(open: boolean): void }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<OrgStatus | ''>('');
  const [page, setPage] = useState(1);
  const [licenceFor, setLicenceFor] = useState<OrgItem | null>(null);
  const [opened, setOpened] = useState<OrgItem | null>(null);
  const load = useCallback(
    () => adapter.organizations({ page, pageSize: ORG_PAGE_SIZE, ...(query ? { q: query } : {}), ...(status ? { status } : {}) }),
    [adapter, page, query, status],
  );
  const { result, reload } = useLoad<OrgPage>(load);
  // The rows stay on screen while the list is read again after a change in the drawer.
  const [rows, setRows] = useState<OrgPage | null>(null);
  useEffect(() => {
    if (result && result.ok) setRows(result.data);
    else if (result) setRows(null);
  }, [result]);
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const single = result && !result.ok && isSingleTenancy(result.error);
  // The page action's rule (index.tsx): `ops.tenants.manage` is the operator's in both tenancy modes.
  const canCreate = ctx.platformCan('ops.tenants.manage') && multiTenancy(ctx) && !single;
  const canInstall = multiTenancy(ctx) && ctx.platformCan('license.manage');
  const columns: Column<OrgItem>[] = [
    {
      key: 'name',
      label: TEXT.colName,
      render: (o) => (
        <>
          <div style={{ fontWeight: 600 }}>{o.name}</div>
          <div className="mx-small mx-mono">{o.slug}</div>
        </>
      ),
    },
    { key: 'status', label: ORG_TEXT.colStatus, render: (o) => <StatusBadge ctx={ctx} status={o.status} /> },
    { key: 'plan', label: ORG_TEXT.colPlan, render: (o) => (o.plan ?? (o.licence ? '-' : <Badge tone="mute">{ctx.li(ORG_TEXT.noPlan)}</Badge>)) },
    { key: 'users', label: ORG_TEXT.colUsers, render: (o) => <UsersOf ctx={ctx} used={o.memberCount} limit={o.maxUsers} /> },
    { key: 'until', label: ORG_TEXT.colValidUntil, render: (o) => <ValidUntil ctx={ctx} validUntil={o.validUntil ?? o.licence?.validUntil ?? null} hasPlan={Boolean(o.licence || o.plan)} /> },
    {
      key: 'licence',
      label: TEXT.colLicence,
      render: (o) => (o.licence
        ? <Badge tone={o.licence.state === 'valid' ? 'ok' : o.licence.state === 'grace' ? 'warn' : 'bad'}>{ctx.li(LICENCE_TEXT[o.licence.state])}</Badge>
        : <Badge tone="mute">{ctx.li(TEXT.noLicence)}</Badge>),
    },
    {
      key: 'domains',
      label: ORG_TEXT.colDomains,
      render: (o) => (o.verifiedDomains.length
        ? <span className="mx-stack" style={{ gap: 2 }}>{o.verifiedDomains.map((d) => <DomainName key={d} name={d} />)}</span>
        : <span className="mx-muted">{ctx.li(ORG_TEXT.noDomains)}</span>),
    },
    {
      key: 'actions',
      label: TEXT.colActions,
      render: (o: OrgItem) => (
        <span className="mx-btn-group">
          <Button title={ctx.fill(ORG_TEXT.manageTitle, { org: o.name })} onClick={() => setOpened(o)}>{ctx.li(ORG_TEXT.manage)}</Button>
          {canInstall ? <Button onClick={() => setLicenceFor(o)}>{ctx.li(TEXT.installLicence)}</Button> : null}
        </span>
      ),
    },
  ];
  let body;
  if (single) body = <div style={{ padding: 'var(--pad)' }}><Alert tone="info">{ctx.li(TEXT.singleTenancy)}</Alert></div>;
  else if (!rows) body = <div style={{ padding: 'var(--pad)' }}><LoadState ctx={ctx} result={result} failed={TEXT.orgsFailed} retry={reload} /></div>;
  else if (!rows.items.length) {
    body = query || status
      ? <div style={{ padding: 'var(--pad)' }}><span className="mx-muted">{ctx.li(query ? TEXT.noMatch : ORG_TEXT.noStatusMatch)}</span></div>
      : <EmptyState title={TEXT.noOrgs} text={TEXT.noOrgsText} action={canCreate ? <Button variant="primary" onClick={() => setCreating(true)}>{ctx.li(TEXT.createOrg)}</Button> : null} />;
  } else {
    body = (
      <>
        <Table columns={columns} rows={rows.items} rowKey={(o) => o.slug} />
        <Pager page={page} pages={Math.max(1, Math.ceil(rows.total / rows.pageSize))} onPage={setPage} />
      </>
    );
  }
  const statusOptions = [{ value: '', label: ORG_TEXT.allStatuses }, ...ORG_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))];
  return (
    <>
      <Card title={TEXT.orgs} sub={TEXT.orgsSub} flush actions={canCreate ? <Button variant="primary" onClick={() => setCreating(true)}>{ctx.li(TEXT.createOrg)}</Button> : null}>
        {single ? null : (
          <div style={{ padding: '12px var(--pad)', borderBottom: '1px solid var(--bd)', display: 'grid', gridTemplateColumns: 'minmax(200px, 2fr) minmax(160px, 1fr)', gap: 12 }}>
            <Field label={TEXT.search}>
              <TextInput type="search" value={q} onChange={setQ} autoComplete="off" />
            </Field>
            <Field label={ORG_TEXT.statusFilter}>
              <Select value={status} onChange={(v) => { setStatus(v as OrgStatus | ''); setPage(1); }} options={statusOptions} />
            </Field>
          </div>
        )}
        {body}
      </Card>
      <CreateDialog ctx={ctx} adapter={adapter} open={creating} onClose={() => setCreating(false)} onCreated={() => reload()} />
      <LicenceDialog ctx={ctx} adapter={adapter} org={licenceFor} onClose={() => setLicenceFor(null)} onInstalled={() => { setLicenceFor(null); reload(); }} />
      {opened ? <OrgDrawer key={opened.slug} ctx={ctx} adapter={adapter} slug={opened.slug} name={opened.name} onClose={() => setOpened(null)} onChanged={reload} /> : null}
    </>
  );
}
