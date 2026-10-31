// Registers (MILESTONE-2 M2-13, `/ms/:ms/registers`): one tab per register kind with a paged list from
// `registers.list`, a search over code, title and owner, a drawer per row (the drill pattern of the generated lists, so
// e2e/display.spec.js opens the first row), and the Add and Edit forms with the fields of the kind. After a write the
// screen reloads its list and, when the write changed chain records, the systems it names (D2-08).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import { Illustration } from '../../illustrations';
import { useScreenTab } from '../../routing';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Badge, Button, EmptyState, Pager, Tabs } from '../ui';
import { adapterFor, settled } from './adapter';
import { PAGE_SIZE, cacheFirstPage, cachedFirstPage, firstPageKey } from './cache';
import { RowFormDrawer } from './Forms';
import {
  KINDS, SEARCH_MAX, canAdd, editScope, formatDate, personName, scoreOf, scoreTone, validityOf, valueLabel,
} from './model';
import type { Outcome, RegisterKind, RegistersAdapter, RowModel, RowPage } from './model';
import { Warnings, problemText } from './parts';
import { RowPanel } from './RowPanel';
import { KIND_TEXT, TEXT } from './text';
import './registers.css';

interface Column {
  key: string;
  label: TextPair;
  render(row: RowModel): ReactNode;
  num?: boolean;
}

/** The columns of a register kind. */
export function columnsOf(ctx: HostContext, kind: RegisterKind): Column[] {
  const id: Column = { key: 'code', label: TEXT.colId, render: (r) => <span className="mx-mono mx-reg-code">{r.code}</span> };
  const title: Column = {
    key: 'title',
    label: kind === 'competence' ? TEXT.colRole : TEXT.colTitle,
    render: (r) => (
      <>
        <div className="mx-reg-wrap" style={{ fontWeight: 500 }}>{r.title}</div>
        {r.shared ? <div className="mx-small">{ctx.fill(TEXT.shared, { n: r.ms.length })}</div> : null}
      </>
    ),
  };
  const owner: Column = { key: 'owner', label: TEXT.colOwner, render: (r) => personName(ctx, r.owner) };
  const status: Column = {
    key: 'status',
    label: TEXT.colStatus,
    render: (r) => (r.status ? <Badge tone={r.status === 'open' ? 'warn' : 'ok'}>{ctx.li(r.status === 'open' ? TEXT.stateOpen : TEXT.stateReady)}</Badge> : null),
  };
  const date = (key: 'lastReviewedAt' | 'nextReviewAt' | 'lastMeasuredAt' | 'dueAt', label: TextPair): Column => ({ key, label, render: (r) => formatDate(ctx, r[key] as string | null | undefined) });
  const value = (key: 'issueType' | 'classification' | 'treatmentOption' | 'objectiveStatus' | 'proofType', label: TextPair): Column => ({
    key, label, render: (r) => ctx.li(valueLabel(key, r[key])),
  });
  const score = (key: string, label: TextPair, l: 'likelihood' | 'residualLikelihood', c: 'consequence' | 'residualConsequence'): Column => ({
    key,
    label,
    num: true,
    render: (r) => {
      const s = scoreOf(r[l], r[c]);
      return s === null ? '-' : <Badge tone={scoreTone(s)}>{s}</Badge>;
    },
  });
  switch (kind) {
    case 'context-issues':
      return [id, title, value('issueType', TEXT.colType), owner, status, date('lastReviewedAt', TEXT.colReviewed)];
    case 'interested-parties':
      return [id, title, { key: 'requirements', label: TEXT.colRequirements, render: (r) => <span className="mx-reg-clamp">{r.requirements ?? '-'}</span> }, owner, date('lastReviewedAt', TEXT.colReviewed)];
    case 'assets':
      return [id, title, { key: 'assetType', label: TEXT.colType, render: (r) => r.assetType ?? '-' }, value('classification', TEXT.colClassification), owner];
    case 'risks':
      return [
        id, title, owner,
        score('inherent', TEXT.colInherent, 'likelihood', 'consequence'),
        score('residual', TEXT.colResidual, 'residualLikelihood', 'residualConsequence'),
        value('treatmentOption', TEXT.colOption), status,
      ];
    case 'metrics':
      return [
        id, title,
        { key: 'target', label: TEXT.colTarget, render: (r) => (r.targetValue === null || r.targetValue === undefined ? '-' : `${r.targetValue}${r.unit ? ` ${r.unit}` : ''}`) },
        { key: 'frequency', label: TEXT.colFrequency, render: (r) => (r.frequencyCode && ctx.D?.FREQ?.[r.frequencyCode as never] ? ctx.li([ctx.D.FREQ[r.frequencyCode as never][0], ctx.D.FREQ[r.frequencyCode as never][1]]) : r.frequencyCode ?? '-') },
        date('lastMeasuredAt', TEXT.colMeasured), owner, status,
      ];
    case 'objectives':
      return [id, title, { key: 'targetText', label: TEXT.colTarget, render: (r) => r.targetText ?? '-' }, date('dueAt', TEXT.colDue), value('objectiveStatus', TEXT.colStatus), owner];
    case 'competence':
      return [
        id, { key: 'person', label: TEXT.colPerson, render: (r) => personName(ctx, r.personHandle) }, title, value('proofType', TEXT.colProof),
        {
          key: 'validUntil',
          label: TEXT.colValidUntil,
          render: (r) => {
            const validity = validityOf(r.validUntil, ctx.D?.today ?? ctx.D?.TODAY_S);
            return (
              <>
                <div>{formatDate(ctx, r.validUntil)}</div>
                {validity ? <Badge tone={validity === 'expired' ? 'bad' : 'warn'}>{ctx.li(validity === 'expired' ? TEXT.expired : TEXT.renewSoon)}</Badge> : null}
              </>
            );
          },
        },
        owner,
      ];
    default:
      return [id, title, owner];
  }
}

type ListState = { loading: boolean; data: RowPage | null; error: ApiError | null };

/** The list of one register: search, rows that open the drawer, "Showing n of total items" and the pager. */
export function RegisterList({ ctx, kind, state, query, onQuery, onPage, onOpen, onAdd, onRetry }: {
  ctx: HostContext;
  kind: RegisterKind;
  state: ListState;
  query: string;
  onQuery(q: string): void;
  onPage(page: number): void;
  onOpen(row: RowModel): void;
  onAdd: (() => void) | null;
  onRetry(): void;
}) {
  const columns = columnsOf(ctx, kind);
  const data = state.data;
  const rows = data?.items ?? [];
  let body: ReactNode;
  if (state.error) {
    body = (
      <div className="mx-reg-pad">
        <Alert tone="bad" title={TEXT.loadFailed}>
          <div>{problemText(ctx, state.error)}</div>
          <div style={{ marginTop: 8 }}><Button onClick={onRetry}>{ctx.li(TEXT.tryAgain)}</Button></div>
        </Alert>
      </div>
    );
  } else if (!data) {
    body = <div className="mx-small mx-reg-pad" role="status">{ctx.li(TEXT.loading)}</div>;
  } else if (!rows.length) {
    body = query.trim()
      ? <EmptyState title={TEXT.noMatchTitle} text={TEXT.noMatchText} />
      : (
        <EmptyState
          title={TEXT.emptyTitle}
          text={TEXT.emptyText}
          illustration={<Illustration scene="no-documents" size="sm" decorative />}
          action={onAdd ? <Button onClick={onAdd}>{ctx.li(TEXT.addFirst)}</Button> : null}
        />
      );
  } else {
    body = (
      <div className="mx-table-wrap">
        <table className="mx-table mx-reg-table">
          <thead>
            <tr>{columns.map((c) => <th key={c.key} scope="col" className={c.num ? 'mx-num' : undefined}>{ctx.li(c.label)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="mx-reg-row"
                style={{ cursor: 'pointer' }}
                tabIndex={0}
                onClick={() => onOpen(r)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(r);
                  }
                }}
              >
                {columns.map((c) => <td key={c.key} className={c.num ? 'mx-num' : undefined}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const total = data?.total ?? 0;
  const pages = data ? Math.max(1, Math.ceil(total / data.pageSize)) : 1;
  return (
    <section className="mx-card mx-reg-list" aria-label={ctx.li(KIND_TEXT[kind].label)} data-register={kind}>
      <div className="mx-reg-tools">
        <input
          className="mx-input mx-reg-search"
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={ctx.li(TEXT.search)}
          aria-label={ctx.li(TEXT.search)}
          name="q"
          maxLength={SEARCH_MAX}
        />
        {onAdd ? <Button variant="primary" onClick={onAdd}>{ctx.li(TEXT.add)}</Button> : null}
      </div>
      {body}
      <div className="mx-reg-foot">
        <span>{ctx.fill(TEXT.showing, { n: rows.length, total })}</span>
        {data ? <Pager page={data.page} pages={pages} onPage={onPage} /> : null}
      </div>
    </section>
  );
}

/** The kinds the session may add to in the system, the current tab first. */
export function addableKinds(ctx: HostContext, ms: MsId, current: RegisterKind): RegisterKind[] {
  const all = KINDS.filter((k) => canAdd(ctx, ms, k));
  return all.includes(current) ? [current, ...all.filter((k) => k !== current)] : all;
}

function isKind(value: unknown): value is RegisterKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

export default function RegistersScreen({ ctx }: ScreenProps) {
  const context = useRef(ctx);
  context.current = ctx;
  const { client } = ctx;
  const adapter: RegistersAdapter = useMemo(() => adapterFor(() => context.current), [client]);
  const ms = ctx.msObj?.id ?? null;
  // The register kind is the screen's tab and part of its address (`tab=<kind>`, M2-20).
  const [kind, setKind] = useScreenTab<RegisterKind>(ctx, KINDS, isKind(ctx.params.tab) ? ctx.params.tab : 'context-issues');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  // The first page kept for this system and register (cache.ts) shows at once; the read below replaces it.
  const keptPage = (k: RegisterKind) => (ms ? cachedFirstPage(firstPageKey(context.current, ms, k)) : null);
  const [state, setState] = useState<ListState>(() => ({ loading: true, data: keptPage(kind), error: null }));
  const [tick, setTick] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: 'add'; kind: RegisterKind } | { mode: 'edit'; row: RowModel } | null>(null);
  const [warnings, setWarnings] = useState<TextPair[]>([]);
  const lastRow = useRef<RowModel | null>(null);
  const shownMs = useRef(ms);

  // The search is sent a moment after the last key stroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(() => {
    if (!ms) return () => undefined;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    void settled(adapter.list(ms, kind, { q: search || undefined, page, pageSize: PAGE_SIZE })).then((res) => {
      if (res.ok && page === 1 && !search) cacheFirstPage(firstPageKey(context.current, ms, kind), res.data);
      if (!live) return;
      setState(res.ok ? { loading: false, data: res.data, error: null } : { loading: false, data: null, error: res.error });
    });
    return () => {
      live = false;
    };
  }, [adapter, ms, kind, search, page]);
  useEffect(() => load(), [load, tick]);

  // A new system or tab starts without an open row, with the page kept for it (if any) until its read answers.
  useEffect(() => {
    setOpenId(null);
    setForm(null);
    setState((s) => ({ ...s, data: keptPage(kind) ?? (s.data && ms === shownMs.current ? s.data : null) }));
    shownMs.current = ms;
  }, [ms, kind]);

  // The page action "Add record" opens the form through the screen params (index.tsx).
  const request = ctx.params.add;
  useEffect(() => {
    if (!request || !ms) return;
    const kinds = addableKinds(context.current, ms, kind);
    if (kinds.length) setForm({ mode: 'add', kind: kinds[0] });
    // Only a new request opens the form; the tab and system are read from the latest render.
  }, [request]);

  const changeTab = (next: string) => {
    if (!isKind(next)) return;
    setKind(next);
    setQuery('');
    setSearch('');
    setPage(1);
    setWarnings([]);
    setState({ loading: true, data: keptPage(next), error: null });
  };

  const after = (outcome: Outcome, message: string | null) => {
    const c = context.current;
    if (outcome.message) c.toast(c.li(outcome.message));
    else if (message) c.toast(message);
    setWarnings(outcome.warnings);
    setTick((t) => t + 1);
    // Register rows are chain records of the snapshot (D2-08): reload the systems the write changed.
    if (outcome.changed.length) c.reload(outcome.changed).catch(() => undefined);
  };

  if (!ms) return <Alert tone="info">{ctx.li(TEXT.noSystem)}</Alert>;

  const rows = state.data?.items ?? [];
  const open = openId ? rows.find((r) => r.id === openId) ?? (lastRow.current?.id === openId ? lastRow.current : null) : null;
  if (open) lastRow.current = open;
  const kinds = addableKinds(ctx, ms, kind);
  const canAddHere = canAdd(ctx, ms, kind);
  const anyWrite = kinds.length > 0 || ctx.can(ms, ['metric.record', 'risk.treatment.update', 'risk.residual.accept']);

  return (
    <>
      <Tabs label={TEXT.tabsLabel} active={kind} onChange={changeTab} tabs={KINDS.map((k) => ({ id: k, label: KIND_TEXT[k].label }))} />
      <div className="mx-small mx-reg-about">{ctx.li(KIND_TEXT[kind].about)}</div>
      {adapter.sample ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
      {!anyWrite ? <Alert tone="info">{ctx.li(TEXT.readOnly)}</Alert> : null}
      <Warnings ctx={ctx} warnings={warnings} />
      <RegisterList
        ctx={ctx}
        kind={kind}
        state={state}
        query={query}
        onQuery={setQuery}
        onPage={setPage}
        onOpen={(r) => { setOpenId(r.id); setWarnings([]); }}
        onAdd={canAddHere ? () => setForm({ mode: 'add', kind }) : null}
        onRetry={() => setTick((t) => t + 1)}
      />
      {open && !form ? (
        <RowPanel
          ctx={ctx}
          adapter={adapter}
          ms={ms}
          kind={kind}
          row={open}
          onClose={() => setOpenId(null)}
          onEdit={() => (editScope(ctx, ms, kind, open) ? setForm({ mode: 'edit', row: open }) : undefined)}
          onChanged={after}
        />
      ) : null}
      {form ? (
        <RowFormDrawer
          key={form.mode === 'add' ? `add:${form.kind}` : `edit:${form.row.id}`}
          ctx={ctx}
          adapter={adapter}
          ms={ms}
          kind={form.mode === 'add' ? form.kind : kind}
          kinds={form.mode === 'add' ? kinds : undefined}
          row={form.mode === 'edit' ? form.row : null}
          codes={rows.map((r) => r.code)}
          onClose={() => setForm(null)}
          onSaved={(outcome, code, savedKind) => {
            const added = form.mode === 'add';
            setForm(null);
            if (added && savedKind !== kind) changeTab(savedKind);
            after(outcome, ctx.fill(added ? TEXT.created : TEXT.saved, { code }));
          }}
        />
      ) : null}
    </>
  );
}
