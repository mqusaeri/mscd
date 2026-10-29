// Management systems (MILESTONE-2 M2-09, `/admin/systems`): every system of the organisation with its code, name,
// standard and edition, status, primary MS Manager and default repository; "New management system" (on an installed
// pack, with the beta notice for pre-release packs), "Edit" (scope, certification body, colour, default repository),
// "Start implementation" (refused with the server's message while no MS Manager is granted) and "Archive".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import { Illustration } from '../../illustrations';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Badge, Button, Card, ConfirmDialog, Drawer, EmptyState, Facts, Field, Select, Table, TextInput, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { settled } from '../storage-admin/adapter';
import { DrawerFoot, asApi, errorText } from '../storage-admin/panels';
import { adapterFor } from './adapter';
import {
  STATUS_LABELS, createBody, emptySystem, formOfSystem, frameworkName, installablePacks, patchBody, slugOfCode, systemErrors,
} from './model';
import type { FormErrors, PackChoice, SystemForm, SystemModel, SystemsAdapter, SystemsData } from './model';
import { PALETTE, TEXT } from './text';

/** The organisation has no management system yet: the no-systems scene of the illustration library and the form. */
export function NoSystems({ ctx, onNew }: { ctx: HostContext; onNew(): void }) {
  return (
    <EmptyState
      title={TEXT.none}
      text={TEXT.noneText}
      illustration={<Illustration scene="no-systems" decorative />}
      action={<Button variant="primary" onClick={onNew}>{ctx.li(TEXT.newSystem)}</Button>}
    />
  );
}

/** The standard and edition of a system, with the edition it is moving to. */
export function editionText(ctx: HostContext, s: SystemModel): string {
  const base = `${frameworkName(s.frameworkCode, s.frameworkName)} ${s.edition}`;
  return s.transitionTargetEdition ? `${base}, ${ctx.fill(TEXT.toEdition, { edition: s.transitionTargetEdition })}` : base;
}

/** The label of an installed pack in the form. */
export function packLabel(ctx: HostContext, p: PackChoice): string {
  return ctx.fill(TEXT.packOption, { framework: frameworkName(p.frameworkCode), edition: p.edition, version: p.version });
}

export function SystemsTable({ ctx, data, onEdit, onStart, onArchive }: {
  ctx: HostContext;
  data: SystemsData;
  onEdit(s: SystemModel): void;
  onStart(s: SystemModel): void;
  onArchive(s: SystemModel): void;
}) {
  const repoName = (slug: string) => data.repos.find((r) => r.slug === slug)?.name ?? slug;
  const rows = [...data.systems].sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived'));
  const columns: Column<SystemModel>[] = [
    {
      key: 'code',
      label: TEXT.colCode,
      render: (s) => (
        <span className="mx-row" style={{ flexWrap: 'nowrap' }}>
          <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flex: 'none' }} />
          <span style={{ fontWeight: 600 }}>{s.code}</span>
        </span>
      ),
    },
    {
      key: 'name',
      label: TEXT.colName,
      render: (s) => (
        <>
          <div>{ctx.li(s.name)}</div>
          <div className="mx-small mx-mono">{s.slug}</div>
        </>
      ),
    },
    { key: 'edition', label: TEXT.colEdition, render: (s) => editionText(ctx, s) },
    { key: 'status', label: TEXT.colStatus, render: (s) => <Badge tone={STATUS_LABELS[s.status].tone}>{ctx.li(STATUS_LABELS[s.status].label)}</Badge> },
    {
      key: 'manager',
      label: TEXT.colManager,
      render: (s) => (s.primaryManager === undefined
        ? <span className="mx-muted">{ctx.li(TEXT.managerUnknown)}</span>
        : s.primaryManager
          ? s.primaryManager
          : <Badge tone="warn">{ctx.li(TEXT.noManager)}</Badge>),
    },
    { key: 'repository', label: TEXT.colRepository, render: (s) => repoName(s.defaultRepository) },
    {
      key: 'actions',
      label: TEXT.colActions,
      render: (s) => (s.status === 'archived' ? '-' : (
        <div className="mx-btn-group">
          <Button onClick={() => onEdit(s)}>{ctx.li(TEXT.edit)}</Button>
          {s.status === 'setup' ? <Button variant="primary" onClick={() => onStart(s)}>{ctx.li(TEXT.start)}</Button> : null}
          <Button onClick={() => onArchive(s)}>{ctx.li(TEXT.archive)}</Button>
        </div>
      )),
    },
  ];
  return <Table columns={columns} rows={rows} rowKey={(s) => s.id} />;
}

/** The colour choice: the token-safe palette, plus the system's current colour when it is not one of them. */
export function ColourField({ ctx, value, onChange, current }: { ctx: HostContext; value: string; onChange(v: string): void; current?: string }) {
  const options: { value: string; name: TextPair | readonly [string, string] }[] = [...PALETTE];
  if (current && !PALETTE.some((p) => p.value.toLowerCase() === current.toLowerCase())) options.unshift({ value: current, name: TEXT.currentColour });
  return (
    <fieldset className="mx-radios">
      <legend className="mx-label">{ctx.li(TEXT.colour)}</legend>
      <div className="mx-row" style={{ gap: 12 }}>
        {options.map((o) => (
          <label key={o.value} className="mx-check">
            <input type="radio" name="system-colour" value={o.value} checked={value.toLowerCase() === o.value.toLowerCase()} onChange={() => onChange(o.value)} />
            <span aria-hidden="true" style={{ display: 'inline-block', width: 16, height: 16, borderRadius: 4, background: o.value, border: '1px solid var(--bd)' }} />
            <span>{ctx.li(o.name)}</span>
          </label>
        ))}
      </div>
      <span className="mx-hint">{ctx.li(TEXT.colourHint)}</span>
    </fieldset>
  );
}

export function SystemDrawer({ ctx, adapter, data, system, open, onClose, onSaved }: {
  ctx: HostContext;
  adapter: SystemsAdapter;
  data: SystemsData;
  /** The system to edit; null for a new one. */
  system: SystemModel | null;
  open: boolean;
  onClose(): void;
  onSaved(saved: SystemModel, message: string): void;
}) {
  const packs = useMemo(() => installablePacks(data.packs), [data.packs]);
  const [form, setForm] = useState<SystemForm>(() => (system ? formOfSystem(system) : emptySystem(data)));
  const [local, setLocal] = useState<FormErrors>({});
  const [note, setNote] = useState<TextPair | null>(null);
  const key = useRef(newIdempotencyKey());
  const save = useMutation((_: null) => {
    if (system) return asApi(adapter.update(system.id, patchBody(form, system) ?? {}));
    return asApi(adapter.create(createBody(form, packs), key.current));
  });
  const { reset } = save;
  useEffect(() => {
    setForm(system ? formOfSystem(system) : emptySystem(data));
    setLocal({});
    setNote(null);
    key.current = newIdempotencyKey();
    reset();
    // A different system, or opening the drawer again, starts the form again; `reset` uses a stable state setter.
  }, [system?.id, open]);
  // A functional update, so a change made right after Edit opens the drawer applies to the chosen system's form
  // (the effect above fills it after the first render) and never to the form of the system shown before.
  const set = <K extends keyof SystemForm>(k: K, v: SystemForm[K]) => {
    setForm((prev) => {
      const next = { ...prev, [k]: v };
      if (k === 'code' && !system && (!prev.slug || prev.slug === slugOfCode(prev.code))) next.slug = slugOfCode(String(v));
      return next;
    });
  };
  // Errors shown after a refused submit follow the form while the person corrects it.
  useEffect(() => {
    setLocal((shown) => (Object.keys(shown).length ? systemErrors(form, system ? 'edit' : 'create') : shown));
  }, [form]);
  const submit = () => {
    const problems = systemErrors(form, system ? 'edit' : 'create');
    setLocal(problems);
    setNote(null);
    if (Object.values(problems).some(Boolean)) return;
    if (system && !patchBody(form, system)) {
      setNote(TEXT.nothingChanged);
      return;
    }
    save.submit(null).then((res) => {
      if (!res.ok) return;
      const saved = res.data.data;
      const message = res.data.message ? ctx.li(res.data.message) : ctx.fill(system ? TEXT.saved : TEXT.createdShort, { code: saved.code });
      onSaved(saved, message);
    });
  };
  const server: FormErrors = {};
  for (const e of save.error?.errors ?? []) {
    let k = String(e.path).replace(/^body\./, '');
    if (k === 'edition') k = 'packId';
    if (k in form && !server[k as keyof SystemForm]) server[k as keyof SystemForm] = e.message;
  }
  if (save.error?.messageKey === 'ms.duplicate' || (save.error?.slug === 'conflict' && /slug|code/i.test(save.error.detail ?? ''))) {
    const detail = save.error.detail ?? ctx.li(save.error.message);
    if (/slug/i.test(detail)) server.slug = detail;
    else server.code = detail;
  }
  const errors: FormErrors = { ...server, ...Object.fromEntries(Object.entries(local).filter(([, v]) => v)) };
  const err = (k: keyof SystemForm) => errors[k] ?? null;
  const refused = save.error && !Object.keys(server).length ? save.error : null;
  const pack = packs.find((p) => p.packId === form.packId) ?? null;
  return (
    <Drawer
      open={open}
      title={system ? ctx.fill(TEXT.formEdit, { code: system.code }) : TEXT.formNew}
      crumb={TEXT.title}
      onClose={onClose}
      footer={<DrawerFoot><Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button><Button variant="primary" busy={save.busy} onClick={submit}>{ctx.li(UI_TEXT.save)}</Button></DrawerFoot>}
    >
      {!system ? <div className="mx-small">{ctx.li(TEXT.formSub)}</div> : null}
      {data.sample ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
      {system ? (
        <Facts
          items={[
            { label: TEXT.code, value: system.code },
            { label: TEXT.slug, value: system.slug, mono: true },
            { label: TEXT.name, value: ctx.li(system.name) },
            { label: TEXT.pack, value: editionText(ctx, system) },
          ]}
        />
      ) : (
        <>
          <Field label={TEXT.code} hint={TEXT.codeHint} error={err('code')} required>
            <TextInput value={form.code} onChange={(v) => set('code', v)} maxLength={20} name="code" autoComplete="off" />
          </Field>
          <Field label={TEXT.slug} hint={TEXT.slugHint} error={err('slug')} required>
            <TextInput value={form.slug} onChange={(v) => set('slug', v.trim().toLowerCase())} maxLength={20} name="slug" autoComplete="off" />
          </Field>
          <Field label={TEXT.name} error={err('name')} required>
            <TextInput value={form.name} onChange={(v) => set('name', v)} maxLength={150} name="name" />
          </Field>
          <Field label={TEXT.pack} hint={TEXT.packHint} error={err('packId')} required>
            <Select value={form.packId} onChange={(v) => set('packId', v)} empty={UI_TEXT.choose} options={packs.map((p) => ({ value: p.packId, label: packLabel(ctx, p) }))} />
          </Field>
          {!packs.length ? <Alert tone="warn">{ctx.li(TEXT.noPacks)}</Alert> : null}
          {pack ? (
            <div className="mx-row">
              <Badge tone="ok">{ctx.li(TEXT.installed)}</Badge>
              {pack.preRelease ? <Badge tone="warn">{ctx.li(TEXT.preRelease)}</Badge> : null}
              <span className="mx-small mx-mono">{`${pack.packId} ${pack.version}`}</span>
            </div>
          ) : null}
          {pack?.preRelease ? <Alert tone="warn">{ctx.li(TEXT.betaNotice)}</Alert> : null}
        </>
      )}
      <Field label={TEXT.scope} hint={TEXT.scopeHint} error={err('scopeStatement')} required>
        <Textarea value={form.scopeStatement} onChange={(v) => set('scopeStatement', v)} rows={4} maxLength={4000} name="scopeStatement" />
      </Field>
      <Field label={TEXT.body} hint={TEXT.bodyHint} error={err('certificationBody')}>
        <TextInput value={form.certificationBody} onChange={(v) => set('certificationBody', v)} maxLength={150} name="certificationBody" />
      </Field>
      <ColourField ctx={ctx} value={form.color} onChange={(v) => set('color', v)} current={system?.color} />
      <Field label={TEXT.repository} hint={TEXT.repositoryHint} error={err('defaultRepository')} required>
        <Select value={form.defaultRepository} onChange={(v) => set('defaultRepository', v)} empty={UI_TEXT.choose} options={data.repos.map((r) => ({ value: r.slug, label: r.name }))} />
      </Field>
      {refused ? <Alert tone="bad">{errorText(ctx, refused)}</Alert> : null}
      {note ? <Alert tone="info">{ctx.li(note)}</Alert> : null}
    </Drawer>
  );
}

type LoadState = { loading: boolean; data: SystemsData | null; error: ApiError | null };
type Confirm = { kind: 'start' | 'archive'; system: SystemModel } | null;

export default function SystemsScreen({ ctx }: ScreenProps) {
  const snapshot = useRef(ctx.D);
  snapshot.current = ctx.D;
  const context = useRef(ctx);
  context.current = ctx;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(context.current, () => snapshot.current), [client]);
  const [state, setState] = useState<LoadState>({ loading: true, data: null, error: null });
  const [editing, setEditing] = useState<{ system: SystemModel | null } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    settled(adapter.load()).then((res) => setState(res.ok ? { loading: false, data: res.data, error: null } : { loading: false, data: null, error: res.error }));
  }, [adapter]);
  useEffect(() => load(), [load]);
  // The page action "New management system" opens the form through the screen params (index.tsx).
  const request = ctx.params.create;
  useEffect(() => {
    if (request) setEditing({ system: null });
  }, [request]);
  const changed = useCallback(() => {
    load();
    // Systems are snapshot data (D2-08): the switcher, portfolio and framework library follow.
    context.current.reload().catch(() => undefined);
  }, [load]);
  const move = useMutation((input: { system: SystemModel; status: 'implementing' | 'archived' }) => asApi(adapter.update(input.system.id, { status: input.status })));
  const runConfirm = () => {
    if (!confirm) return;
    const status = confirm.kind === 'start' ? 'implementing' : 'archived';
    move.submit({ system: confirm.system, status }).then((res) => {
      if (!res.ok) return;
      ctx.toast(ctx.fill(confirm.kind === 'start' ? TEXT.started : TEXT.archived, { code: confirm.system.code }));
      setConfirm(null);
      changed();
    });
  };
  const openConfirm = (next: Confirm) => {
    move.reset();
    setConfirm(next);
  };
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
        {data.systems.some((s) => s.status === 'setup' && s.primaryManager === null) ? <Alert tone="warn">{ctx.li(TEXT.noManagerHint)}</Alert> : null}
        <Card title={TEXT.title} sub={TEXT.listSub} flush>
          {data.systems.length ? (
            <SystemsTable
              ctx={ctx}
              data={data}
              onEdit={(s) => setEditing({ system: s })}
              onStart={(s) => openConfirm({ kind: 'start', system: s })}
              onArchive={(s) => openConfirm({ kind: 'archive', system: s })}
            />
          ) : (
            <NoSystems ctx={ctx} onNew={() => setEditing({ system: null })} />
          )}
        </Card>
      </>
    );
  }
  return (
    <>
      {body}
      {data ? (
        <SystemDrawer
          ctx={ctx}
          adapter={adapter}
          data={data}
          system={editing?.system ?? null}
          open={Boolean(editing)}
          onClose={() => setEditing(null)}
          onSaved={(_saved, message) => { ctx.toast(message); setEditing(null); changed(); }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.kind === 'archive' ? TEXT.archiveTitle : TEXT.startTitle}
        body={confirm ? ctx.fill(confirm.kind === 'archive' ? TEXT.archiveBody : TEXT.startBody, { code: confirm.system.code }) : null}
        confirmLabel={confirm?.kind === 'archive' ? TEXT.archive : TEXT.start}
        tone={confirm?.kind === 'archive' ? 'bad' : 'acc'}
        requireText={confirm?.kind === 'archive' ? confirm.system.code : undefined}
        busy={move.busy}
        error={move.error ? errorText(ctx, move.error) : null}
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
