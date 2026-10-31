// Routing rules (MILESTONE-2 M2-09, `/admin/storage/routing`): the rules that send a new file of a system to a
// repository and a storage mode (A-37), with their state (active, waiting for approval, rejected), "Add rule" and
// "Edit" with the BR-38 confirmation, "Approve" and "Reject" for pending rules (never by the requester, A-50), and the
// tab "Stored files" over the storage object metadata (name, place and hash, never the content).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import { useScreenTab } from '../../routing';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext, ScreenProps, TextPair } from '../types';
import {
  Alert, Badge, Button, Card, Checkbox, ConfirmDialog, Drawer, EmptyState, Field, Pager, Select, Table, Tabs, TextInput, Textarea, UI_TEXT,
} from '../ui';
import type { Column, Tone } from '../ui';
import { settled } from '../storage-admin/adapter';
import {
  CLASSIFICATION_LABELS, LINK_STATUS_LABELS, LINK_STATUS_TONE, MODE_LABELS, OBJECT_KIND_LABELS, labelOf,
} from '../storage-admin/labels';
import type { LinkStatusCode } from '../storage-admin/labels';
import { DrawerFoot, asApi, errorText, formatInstant } from '../storage-admin/panels';
import { adapterFor } from './adapter';
import {
  HASH_NAMES, canEdit, decisionBlock, emptyRule, fileType, formOfRule, formatSize, ruleErrors, rulePatch, ruleRequest, systemOfObject,
} from './model';
import type { ApprovalCode, FormErrors, ObjectModel, ObjectPage, RoutingAdapter, RoutingData, RuleForm, RuleModel, RuleOutcome } from './model';
import { TEXT } from './text';

export const STATE_LABELS: Readonly<Record<ApprovalCode, { label: TextPair; tone: Tone }>> = {
  active: { label: TEXT.stateActive, tone: 'ok' },
  pending_approval: { label: TEXT.statePending, tone: 'warn' },
  rejected: { label: TEXT.stateRejected, tone: 'bad' },
  superseded: { label: TEXT.stateSuperseded, tone: 'mute' },
};

const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
const KINDS = ['document', 'evidence'] as const;
const LINK_STATES = Object.keys(LINK_STATUS_LABELS) as LinkStatusCode[];
/** The tabs of the screen: Rules, and Stored files with the metadata permission (M2-20 addresses). */
const ROUTING_TABS = ['rules', 'files'] as const;
const RULE_TABS = ['rules'] as const;

const nameOf = (ctx: HostContext, handle: string | null) => (handle ? ctx.D?.PEOPLE?.[handle]?.[0] ?? handle : '-');

/** The code of a rule's system, or "Whole organisation". */
export function systemLabel(ctx: HostContext, data: RoutingData, ms: string | null): string {
  if (!ms) return ctx.li(TEXT.wholeOrg);
  return data.systems.find((s) => s.slug === ms)?.code ?? ms.toUpperCase();
}

/** The rules shown: active, pending and rejected, and the replaced ones on request; pending first. */
export function visibleRules(rules: RuleModel[], showReplaced: boolean): RuleModel[] {
  const rank: Record<ApprovalCode, number> = { pending_approval: 0, active: 1, rejected: 2, superseded: 3 };
  return rules
    .filter((r) => showReplaced || r.approvalStatus !== 'superseded')
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank[a.r.approvalStatus] - rank[b.r.approvalStatus] || a.i - b.i)
    .map(({ r }) => r);
}

export function RulesTable({ ctx, data, rules, onEdit, onApprove, onReject, busy }: {
  ctx: HostContext;
  data: RoutingData;
  rules: RuleModel[];
  onEdit(rule: RuleModel): void;
  onApprove(rule: RuleModel): void;
  onReject(rule: RuleModel): void;
  busy: string | null;
}) {
  const manage = ctx.orgCan('storage.routing.manage');
  const repoName = (slug: string) => data.repos.find((r) => r.slug === slug)?.name ?? slug;
  const columns: Column<RuleModel>[] = [
    { key: 'system', label: TEXT.colSystem, render: (r) => <span style={{ fontWeight: 600 }}>{systemLabel(ctx, data, r.ms)}</span> },
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
      key: 'repository',
      label: TEXT.colRepository,
      render: (r) => (
        <>
          <div>{repoName(r.repository)}</div>
          {r.note ? <div className="mx-small">{ctx.li(r.note)}</div> : null}
        </>
      ),
    },
    { key: 'mode', label: TEXT.colMode, render: (r) => ctx.li(labelOf(MODE_LABELS, r.mode)) },
    { key: 'priority', label: TEXT.colPriority, align: 'right', render: (r) => r.priority },
    {
      key: 'state',
      label: TEXT.colState,
      render: (r) => (
        <div className="mx-stack" style={{ gap: 4 }}>
          <span><Badge tone={STATE_LABELS[r.approvalStatus].tone}>{ctx.li(STATE_LABELS[r.approvalStatus].label)}</Badge></span>
          {r.requestedBy ? <span className="mx-small">{ctx.fill(TEXT.requestedBy, { name: nameOf(ctx, r.requestedBy) })}</span> : null}
          {r.approvedBy ? <span className="mx-small">{ctx.fill(TEXT.approvedBy, { name: nameOf(ctx, r.approvedBy) })}</span> : null}
        </div>
      ),
    },
  ];
  if (manage) {
    columns.push({
      key: 'actions',
      label: TEXT.colActions,
      width: 240,
      render: (r) => {
        const block = r.approvalStatus === 'pending_approval' ? decisionBlock(ctx, r) : null;
        const reasonId = `routing-reason-${r.id}`;
        return (
          <div className="mx-stack" style={{ gap: 6 }}>
            <div className="mx-btn-group" role="group" aria-describedby={block ? reasonId : undefined}>
              {canEdit(ctx, r) ? <Button onClick={() => onEdit(r)}>{ctx.li(TEXT.edit)}</Button> : null}
              {r.approvalStatus === 'pending_approval' ? (
                <>
                  <Button variant="primary" busy={busy === r.id} disabled={Boolean(block)} onClick={() => onApprove(r)}>{ctx.li(TEXT.approve)}</Button>
                  <Button variant="danger" disabled={Boolean(block) || busy === r.id} onClick={() => onReject(r)}>{ctx.li(TEXT.reject)}</Button>
                </>
              ) : null}
            </div>
            {block ? <span id={reasonId} className="mx-reason">{ctx.li(block)}</span> : null}
          </div>
        );
      },
    });
  }
  return <Table columns={columns} rows={rules} rowKey={(r) => r.id} />;
}

// ---------------------------------------------------------------------------------------------------------------
// Add rule and Edit
// ---------------------------------------------------------------------------------------------------------------

export function RuleDrawer({ ctx, adapter, data, rule, open, onClose, onSaved }: {
  ctx: HostContext;
  adapter: RoutingAdapter;
  data: RoutingData;
  /** The rule to edit; null to add one. */
  rule: RuleModel | null;
  open: boolean;
  onClose(): void;
  onSaved(outcome: RuleOutcome): void;
}) {
  const usable = useMemo(() => data.repos.filter((r) => !r.readOnly || (rule && r.slug === rule.repository)), [data.repos, rule]);
  const [form, setForm] = useState<RuleForm>(() => (rule ? formOfRule(rule) : emptyRule(usable)));
  const [local, setLocal] = useState<FormErrors>({});
  const [note, setNote] = useState<TextPair | null>(null);
  const [confirming, setConfirming] = useState(false);
  const key = useRef(newIdempotencyKey());
  const save = useMutation((confirm: boolean) => {
    if (rule) {
      const patch = rulePatch(form, rule, confirm);
      return asApi(adapter.update(rule.id, patch ?? {}));
    }
    return asApi(adapter.create(ruleRequest(form, confirm), key.current));
  });
  const { reset } = save;
  useEffect(() => {
    setForm(rule ? formOfRule(rule) : emptyRule(usable));
    setLocal({});
    setNote(null);
    setConfirming(false);
    key.current = newIdempotencyKey();
    reset();
    // A new rule, or opening the drawer again, starts the form again; `reset` uses a stable state setter.
  }, [rule?.id, open]);
  const repo = data.repos.find((r) => r.slug === form.repository) ?? null;
  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => {
    const next = { ...form, [k]: v };
    if (k === 'repository') {
      const chosen = data.repos.find((r) => r.slug === v);
      if (chosen && !chosen.modes.includes(next.mode as never)) next.mode = chosen.modes[0] ?? '';
    }
    setForm(next);
    if (Object.keys(local).length) setLocal(ruleErrors(next, data.repos));
  };
  const submit = (confirm: boolean) => {
    const problems = ruleErrors(form, data.repos);
    setLocal(problems);
    setNote(null);
    if (Object.values(problems).some(Boolean)) return;
    if (rule && !rulePatch(form, rule)) {
      setNote(TEXT.nothingChanged);
      return;
    }
    save.submit(confirm).then((res) => {
      if (res.ok) {
        setConfirming(false);
        onSaved(res.data.data);
        return;
      }
      // BR-38: the change puts restricted files into the provider cloud; ask, then send again with confirm.
      if (res.error.slug === 'confirmation-required') setConfirming(true);
    });
  };
  const server: FormErrors = {};
  for (const e of save.error?.errors ?? []) {
    const k = String(e.path).replace(/^body\./, '') as keyof RuleForm;
    if (k in form && !server[k]) server[k] = e.message;
  }
  const errors: FormErrors = { ...server, ...Object.fromEntries(Object.entries(local).filter(([, v]) => v)) };
  const err = (k: keyof RuleForm) => errors[k] ?? null;
  const refused = save.error && save.error.slug !== 'confirmation-required' && !Object.keys(server).length ? save.error : null;
  return (
    <>
      <Drawer
        open={open}
        title={rule ? TEXT.formEdit : TEXT.formAdd}
        crumb={TEXT.title}
        onClose={onClose}
        footer={<DrawerFoot><Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button><Button variant="primary" busy={save.busy && !confirming} onClick={() => submit(false)}>{ctx.li(UI_TEXT.save)}</Button></DrawerFoot>}
      >
        <div className="mx-small">{ctx.li(TEXT.formSub)}</div>
        {data.sample ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
        {!usable.length ? <Alert tone="warn">{ctx.li(TEXT.noRepos)}</Alert> : null}
        <Field label={TEXT.system} hint={rule ? TEXT.systemFixed : undefined}>
          <Select value={form.ms} onChange={(v) => set('ms', v)} disabled={Boolean(rule)} options={[{ value: '', label: TEXT.wholeOrg }, ...data.systems.map((s) => ({ value: s.slug, label: s.code }))]} />
        </Field>
        <Field label={TEXT.classification}>
          <Select value={form.classification} onChange={(v) => set('classification', v)} options={[{ value: '', label: TEXT.any }, ...CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_LABELS[c] }))]} />
        </Field>
        <Field label={TEXT.kind}>
          <Select value={form.objectKind} onChange={(v) => set('objectKind', v)} options={[{ value: '', label: TEXT.any }, ...KINDS.map((k) => ({ value: k, label: OBJECT_KIND_LABELS[k] }))]} />
        </Field>
        <Field label={TEXT.repository} error={err('repository')} required>
          <Select value={form.repository} onChange={(v) => set('repository', v)} empty={UI_TEXT.choose} options={usable.map((r) => ({ value: r.slug, label: r.name }))} />
        </Field>
        <Field label={TEXT.mode} hint={TEXT.modeHint} error={err('mode')} required>
          <Select value={form.mode} onChange={(v) => set('mode', v)} empty={UI_TEXT.choose} options={(repo?.modes ?? []).map((m) => ({ value: m, label: MODE_LABELS[m] }))} />
        </Field>
        <Field label={TEXT.priority} hint={TEXT.priorityHint} error={err('priority')} required>
          <TextInput type="number" value={form.priority} onChange={(v) => set('priority', v)} name="priority" />
        </Field>
        <Field label={TEXT.note} hint={TEXT.noteHint} error={err('note')}>
          <Textarea value={form.note} onChange={(v) => set('note', v)} rows={3} maxLength={500} name="note" />
        </Field>
        {refused ? <Alert tone="bad">{errorText(ctx, refused)}</Alert> : null}
        {note ? <Alert tone="info">{ctx.li(note)}</Alert> : null}
      </Drawer>
      <ConfirmDialog
        open={confirming}
        title={TEXT.br38Title}
        body={(
          <>
            <div>{save.error?.slug === 'confirmation-required' ? ctx.li(save.error.message) : null}</div>
            <div style={{ marginTop: 8 }}>{ctx.li(TEXT.br38Body)}</div>
          </>
        )}
        confirmLabel={TEXT.br38Confirm}
        busy={save.busy}
        onConfirm={() => submit(true)}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Stored files
// ---------------------------------------------------------------------------------------------------------------

const PAGE_SIZE = 50;

export function hashText(ctx: HostContext, o: ObjectModel): string {
  const name = HASH_NAMES[o.hashAlgorithm];
  if (!name || o.hashSource === 'none') return ctx.li(TEXT.noHash);
  return `${name}, ${ctx.li(o.hashSource === 'computed' ? TEXT.hashComputed : TEXT.hashProvider)}`;
}

export function StoredFiles({ ctx, adapter, data }: { ctx: HostContext; adapter: RoutingAdapter; data: RoutingData }) {
  const [repository, setRepository] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [state, setState] = useState<{ loading: boolean; data: ObjectPage | null; error: ApiError | null }>({ loading: true, data: null, error: null });
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    let live = true;
    settled(adapter.objects({ page, pageSize: PAGE_SIZE, ...(repository ? { repository } : {}), ...(status ? { status: status as LinkStatusCode } : {}) })).then((res) => {
      if (!live) return;
      setState(res.ok ? { loading: false, data: res.data, error: null } : { loading: false, data: null, error: res.error });
    });
    return () => {
      live = false;
    };
  }, [adapter, page, repository, status]);
  useEffect(() => load(), [load]);
  const repoName = (slug: string) => data.repos.find((r) => r.slug === slug)?.name ?? slug;
  const columns: Column<ObjectModel>[] = [
    {
      key: 'name',
      label: TEXT.colName,
      render: (o) => (
        <>
          <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{o.displayName ?? '-'}</div>
          {o.folderPath ? <div className="mx-small" style={{ overflowWrap: 'anywhere' }}>{o.folderPath}</div> : null}
        </>
      ),
    },
    { key: 'repository', label: TEXT.colRepository, render: (o) => repoName(o.repository) },
    { key: 'system', label: TEXT.colSystem, render: (o) => systemOfObject(o, data.repos, data.systems) ?? '-' },
    { key: 'size', label: TEXT.colSize, align: 'right', render: (o) => formatSize(o.sizeBytes) },
    { key: 'type', label: TEXT.colType, render: (o) => fileType(o) },
    {
      key: 'hash',
      label: TEXT.colHash,
      render: (o) => (
        <div className="mx-stack" style={{ gap: 4 }}>
          <span>{hashText(ctx, o)}</span>
          <span><Badge tone={LINK_STATUS_TONE[o.linkStatus]}>{ctx.li(labelOf(LINK_STATUS_LABELS, o.linkStatus))}</Badge></span>
          {o.lastVerifiedAt ? <span className="mx-small">{ctx.fill(TEXT.checkedAt, { at: formatInstant(o.lastVerifiedAt, ctx.lang) })}</span> : null}
        </div>
      ),
    },
  ];
  const result = state.data;
  return (
    <Card title={TEXT.tabFiles} sub={TEXT.filesSub} flush>
      <div className="mx-row" style={{ padding: 'var(--pad)', alignItems: 'flex-end' }}>
        <div style={{ minWidth: 220 }}>
          <Field label={TEXT.filterRepository}>
            <Select value={repository} onChange={(v) => { setRepository(v); setPage(1); }} options={[{ value: '', label: TEXT.allRepositories }, ...data.repos.map((r) => ({ value: r.slug, label: r.name }))]} />
          </Field>
        </div>
        <div style={{ minWidth: 220 }}>
          <Field label={TEXT.filterStatus}>
            <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[{ value: '', label: TEXT.allStates }, ...LINK_STATES.map((s) => ({ value: s, label: LINK_STATUS_LABELS[s] }))]} />
          </Field>
        </div>
        {result ? <span className="mx-small">{ctx.fill(TEXT.shownOf, { n: result.items.length, total: result.total })}</span> : null}
      </div>
      {state.error ? (
        <div style={{ padding: '0 var(--pad) var(--pad)' }}>
          <Alert tone="bad" title={TEXT.filesFailed}>
            <div>{errorText(ctx, state.error)}</div>
            <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
          </Alert>
        </div>
      ) : !result ? (
        <div className="mx-small" role="status" style={{ padding: '0 var(--pad) var(--pad)' }}>{ctx.li(UI_TEXT.loading)}</div>
      ) : (
        <>
          <Table columns={columns} rows={result.items} rowKey={(o) => o.id} empty={<EmptyState title={TEXT.noFiles} text={TEXT.noFilesText} />} />
          <Pager page={result.page} pages={Math.max(1, Math.ceil(result.total / result.pageSize))} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------------------------------------------

type LoadState = { loading: boolean; data: RoutingData | null; error: ApiError | null };

export default function RoutingScreen({ ctx }: ScreenProps) {
  const context = useRef(ctx);
  context.current = ctx;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(() => context.current), [client]);
  const [state, setState] = useState<LoadState>({ loading: true, data: null, error: null });
  const canFiles = ctx.orgCan('storage.object.metadata.read');
  // The tab is part of the screen's address (`tab=rules|files`, M2-20); Stored files needs the metadata permission.
  const [tab, setTab] = useScreenTab<'rules' | 'files'>(ctx, canFiles ? ROUTING_TABS : RULE_TABS, 'rules');
  const [showReplaced, setShowReplaced] = useState(false);
  const [editing, setEditing] = useState<{ rule: RuleModel | null } | null>(null);
  const [rejecting, setRejecting] = useState<RuleModel | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<ApiError | null>(null);
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    settled(adapter.load()).then((res) => setState(res.ok ? { loading: false, data: res.data, error: null } : { loading: false, data: null, error: res.error }));
  }, [adapter]);
  useEffect(() => load(), [load]);
  // The page action "Add rule" opens the form through the screen params (index.tsx).
  const request = ctx.params.add;
  useEffect(() => {
    if (request) setEditing({ rule: null });
  }, [request]);
  const after = (outcome: RuleOutcome) => {
    if (outcome.message) context.current.toast(context.current.li(outcome.message));
    load();
    // Routing is snapshot data (`ROUTING`, D2-08): reload it when an active rule changed.
    if (outcome.changed.length) context.current.reload(outcome.changed).catch(() => undefined);
  };
  const decide = (rule: RuleModel, decision: 'approve' | 'reject') => {
    setBusy(rule.id);
    setDecisionError(null);
    settled(decision === 'approve' ? adapter.approve(rule.id) : adapter.reject(rule.id)).then((res) => {
      setBusy(null);
      setRejecting(null);
      if (res.ok) after(res.data);
      else setDecisionError(res.error);
    });
  };
  const manage = ctx.orgCan('storage.routing.manage');
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
    const rules = visibleRules(data.rules, showReplaced);
    const pending = data.rules.filter((r) => r.approvalStatus === 'pending_approval').length;
    body = (
      <>
        {canFiles ? (
          <Tabs
            label={TEXT.tabsLabel}
            active={tab}
            onChange={(id) => setTab(id as 'rules' | 'files')}
            tabs={[{ id: 'rules', label: TEXT.tabRules, count: rules.length }, { id: 'files', label: TEXT.tabFiles }]}
          />
        ) : null}
        {tab === 'files' && canFiles ? <StoredFiles ctx={ctx} adapter={adapter} data={data} /> : (
          <>
            {data.sample ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
            {!manage ? <Alert tone="info">{ctx.li(TEXT.readOnly)}</Alert> : null}
            {pending ? <Alert tone="warn">{pending === 1 ? ctx.li(TEXT.pendingOne) : ctx.fill(TEXT.pendingNote, { n: pending })}</Alert> : null}
            {decisionError ? <Alert tone="bad">{errorText(ctx, decisionError)}</Alert> : null}
            <Card title={TEXT.tabRules} sub={TEXT.rulesSub} flush actions={<Checkbox checked={showReplaced} onChange={setShowReplaced} label={TEXT.showReplaced} />}>
              {rules.length ? (
                <RulesTable ctx={ctx} data={data} rules={rules} busy={busy} onEdit={(r) => setEditing({ rule: r })} onApprove={(r) => decide(r, 'approve')} onReject={(r) => setRejecting(r)} />
              ) : (
                <EmptyState title={TEXT.noRules} text={TEXT.noRulesText} action={manage ? <Button variant="primary" onClick={() => setEditing({ rule: null })}>{ctx.li(TEXT.addRule)}</Button> : null} />
              )}
            </Card>
          </>
        )}
      </>
    );
  }
  return (
    <>
      {body}
      {data && manage ? (
        <RuleDrawer
          ctx={ctx}
          adapter={adapter}
          data={data}
          rule={editing?.rule ?? null}
          open={Boolean(editing)}
          onClose={() => setEditing(null)}
          onSaved={(outcome) => { setEditing(null); after(outcome); }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(rejecting)}
        title={TEXT.rejectTitle}
        body={TEXT.rejectBody[ctx.lang === 'id' ? 1 : 0]}
        confirmLabel={TEXT.reject}
        tone="bad"
        busy={Boolean(rejecting && busy === rejecting.id)}
        onConfirm={() => rejecting && decide(rejecting, 'reject')}
        onCancel={() => setRejecting(null)}
      />
    </>
  );
}
