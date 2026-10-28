// Audit trail (MILESTONE-2 M2-15): the entries of the management system newest first, or the organisation's metadata
// for a Tenant Admin, with filters (action, person, date range), the entry in a drawer with its changed fields,
// "Export CSV", "Verify chain" with the result of each chain, and "Download anchors" (the signed chain heads an
// auditor checks offline).
import { useEffect, useState } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext, ScreenProps } from '../types';
import { Alert, Button, Card, DateInput, Drawer, EmptyState, Facts, Field, Select, Table } from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import { formatInstant, saveFile } from '../auditor-access/shared';
import { adapterFor } from './adapter';
import {
  actionsOf, actorName, applyFilters, changeLines, latestOnly, mayReadOrg, mayReadSystem, mayVerify, peopleOfEntries, rangeError, settled,
} from './model';
import type { ChainResult, EntryModel, Filters, TrailQuery } from './model';
import { TEXT } from './text';

const PAGE_SIZE = 100;

interface ListState {
  loading: boolean;
  entries: EntryModel[];
  total: number;
  page: number;
  error: ApiError | null;
}

const EMPTY: ListState = { loading: true, entries: [], total: 0, page: 0, error: null };

/** The verification result of each chain as text and tone. */
export function chainLine(ctx: Pick<HostContext, 'fill'>, r: ChainResult): { tone: 'ok' | 'bad'; text: string } {
  if (r.firstBrokenSeq !== null) return { tone: 'bad', text: ctx.fill(TEXT.chainBroken, { chain: r.chain, seq: r.firstBrokenSeq, n: r.checked }) };
  if (!r.anchorOk) return { tone: 'bad', text: ctx.fill(TEXT.chainNoAnchor, { chain: r.chain, n: r.checked }) };
  return { tone: 'ok', text: ctx.fill(TEXT.chainOk, { chain: r.chain, n: r.checked }) };
}

export function EntryDrawer({ ctx, entry, onClose }: { ctx: HostContext; entry: EntryModel; onClose(): void }) {
  const lines = entry.full ? changeLines(entry.before, entry.after) : [];
  return (
    <Drawer open title={ctx.fill(TEXT.detailTitle, { seq: entry.seq })} crumb={TEXT.title} onClose={onClose}>
      <Facts items={[
        { label: TEXT.fWhen, value: formatInstant(entry.occurredAt, ctx.lang) },
        { label: TEXT.fActor, value: actorName(ctx, entry) },
        { label: TEXT.fActionCode, value: entry.action, mono: true },
        { label: TEXT.fRecord, value: [entry.entityType, entry.entityCode].filter(Boolean).join(', ') || '-' },
        { label: TEXT.fSystem, value: entry.ms ? entry.ms.toUpperCase() : '-' },
        ...(entry.edition ? [{ label: TEXT.fEdition, value: entry.edition }] : []),
        ...(entry.requestId ? [{ label: TEXT.fRequest, value: entry.requestId, mono: true }] : []),
        ...(entry.sourceIp ? [{ label: TEXT.fSource, value: entry.sourceIp, mono: true }] : []),
      ]} />
      {!entry.full ? <Alert tone="info">{ctx.li(TEXT.metaOnly)}</Alert> : null}
      {entry.full && !lines.length ? <p className="mx-muted" style={{ margin: 0 }}>{ctx.li(TEXT.noChanges)}</p> : null}
      {lines.length ? (
        <Card title={`${ctx.li(TEXT.before)} > ${ctx.li(TEXT.after)}`}>
          <div className="mx-stack" style={{ gap: 4 }}>
            {lines.map((l) => <span key={l} className="mx-mono" style={{ fontSize: 12, overflowWrap: 'anywhere', color: 'var(--tx)' }}>{l}</span>)}
          </div>
        </Card>
      ) : null}
    </Drawer>
  );
}

export default function AuditTrailScreen({ ctx }: ScreenProps) {
  const ms = ctx.msObj?.id ?? null;
  const adapter = adapterFor(ctx);
  const system = mayReadSystem(ctx, ms);
  const org = mayReadOrg(ctx);
  const [view, setView] = useState<'system' | 'org'>(system ? 'system' : 'org');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filters, setFilters] = useState<Filters>({ action: '', person: '' });
  const [list, setList] = useState<ListState>(EMPTY);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<EntryModel | null>(null);
  const [checks, setChecks] = useState<ChainResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const badRange = rangeError(from, to);
  const query: TrailQuery = { ms: view === 'system' ? ms : null, from: from || null, to: to || null };
  const queryKey = JSON.stringify(query);

  // A new query (view, dates, Try again) or leaving the screen starts a new generation of the list; an answer of an
  // earlier one is dropped, so a slow answer or a "Load more" of the old query never lands in the list shown.
  const [latest] = useState(latestOnly);
  const loadPage = (page: number, append: boolean) => {
    setList((s) => ({ ...s, loading: true, error: null }));
    return latest.ask(settled(adapter.list(query, page, PAGE_SIZE))).then((res) => {
      if (!res) return;
      setList((s) => (res.ok
        ? { loading: false, entries: append ? [...s.entries, ...res.data.items] : res.data.items, total: res.data.total, page, error: null }
        : { ...s, loading: false, error: res.error }));
    });
  };
  useEffect(() => {
    latest.start();
    if (badRange) {
      setList((s) => ({ ...s, loading: false }));
      return;
    }
    setList(EMPTY);
    setFilters({ action: '', person: '' });
    void loadPage(1, false);
  }, [queryKey, tick]);
  useEffect(() => () => latest.start(), [latest]);

  const shown = applyFilters(list.entries, filters);
  const filtered = Boolean(filters.action || filters.person);
  const columns: Column<EntryModel>[] = [
    { key: 'when', label: TEXT.colWhen, render: (e) => <span style={{ whiteSpace: 'nowrap' }}>{formatInstant(e.occurredAt, ctx.lang)}</span> },
    { key: 'person', label: TEXT.colPerson, render: (e) => actorName(ctx, e) },
    { key: 'action', label: TEXT.colAction, render: (e) => <span className="mx-mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{e.action}</span> },
    { key: 'record', label: TEXT.colRecord, render: (e) => <span style={{ overflowWrap: 'anywhere' }}>{[e.entityType, e.entityCode].filter(Boolean).join(', ') || '-'}</span> },
    ...(view === 'org' ? [{ key: 'system', label: TEXT.colSystem, render: (e: EntryModel) => (e.ms ? e.ms.toUpperCase() : '-') }] : []),
    { key: 'seq', label: TEXT.colSeq, align: 'right', render: (e) => <span className="mx-mono">{e.seq}</span> },
  ];

  const exportCsv = () => {
    if (!ms) return;
    ctx.track(settled(adapter.exportCsv(ms))).then((res) => {
      if (!res.ok) {
        ctx.toast(ctx.li(res.error.message));
        return;
      }
      saveFile(res.data);
      ctx.toast(ctx.li(TEXT.exported));
    });
  };
  const verify = () => {
    setChecking(true);
    ctx.track(settled(adapter.verify())).then((res) => {
      setChecking(false);
      if (!res.ok) {
        ctx.toast(ctx.li(res.error.message));
        return;
      }
      setChecks(res.data);
    });
  };
  const anchors = () => {
    ctx.track(settled(adapter.anchors(from || null, to || null))).then((res) => {
      if (!res.ok) {
        ctx.toast(ctx.li(res.error.message));
        return;
      }
      saveFile(res.data);
      ctx.toast(ctx.li(TEXT.anchorsSaved));
    });
  };

  const verifyRight = mayVerify(ctx, ms);
  const broken = checks?.some((r) => r.firstBrokenSeq !== null || !r.anchorOk) ?? false;
  return (
    <>
      <Card title={TEXT.tools} sub={TEXT.toolsSub}>
        <div className="mx-stack">
          <div className="mx-row">
            <Button icon="M12 3v12M7 10l5 5 5-5M4 19h16" onClick={exportCsv} disabledReason={view === 'system' && ms ? null : TEXT.exportNeedsSystem}>{ctx.li(TEXT.exportCsv)}</Button>
            {verifyRight ? <Button busy={checking} onClick={verify}>{ctx.li(TEXT.verify)}</Button> : null}
            {verifyRight ? <Button onClick={anchors}>{ctx.li(TEXT.anchors)}</Button> : null}
          </div>
          {checks ? (
            <div className="mx-stack" style={{ gap: 6 }} data-chain-result={broken ? 'broken' : 'intact'}>
              <Alert tone={broken ? 'bad' : 'ok'} title={broken ? TEXT.verifiedBroken : TEXT.verifiedAll}>
                <span className="mx-stack" style={{ gap: 2 }}>
                  {checks.map((r) => <span key={r.chain}>{chainLine(ctx, r).text}</span>)}
                </span>
              </Alert>
            </div>
          ) : null}
        </div>
      </Card>
      <Card title={TEXT.title} flush>
        <div className="mx-row" style={{ padding: '12px var(--pad)', alignItems: 'flex-end', gap: 12 }}>
          {system && org ? (
            <div style={{ minWidth: 260 }}>
              <Field label={TEXT.view}>
                <Select name="view" value={view} onChange={(v) => setView(v as 'system' | 'org')} options={[{ value: 'system', label: TEXT.viewSystem }, { value: 'org', label: TEXT.viewOrg }]} />
              </Field>
            </div>
          ) : null}
          <div style={{ minWidth: 200 }}>
            <Field label={TEXT.fAction}>
              <Select name="action" value={filters.action} onChange={(v) => setFilters((f) => ({ ...f, action: v }))} options={actionsOf(list.entries).map((a) => ({ value: a, label: a }))} empty={TEXT.anyAction} />
            </Field>
          </div>
          <div style={{ minWidth: 200 }}>
            <Field label={TEXT.fPerson}>
              <Select name="person" value={filters.person} onChange={(v) => setFilters((f) => ({ ...f, person: v }))} options={peopleOfEntries(ctx, list.entries)} empty={TEXT.anyPerson} />
            </Field>
          </div>
          <div style={{ minWidth: 160 }}>
            <Field label={TEXT.fFrom} error={badRange}>
              <DateInput name="from" value={from} onChange={setFrom} />
            </Field>
          </div>
          <div style={{ minWidth: 160 }}>
            <Field label={TEXT.fTo}>
              <DateInput name="to" value={to} onChange={setTo} />
            </Field>
          </div>
          {filtered || from || to ? (
            <Button variant="link" onClick={() => { setFilters({ action: '', person: '' }); setFrom(''); setTo(''); }}>{ctx.li(TEXT.clear)}</Button>
          ) : null}
        </div>
        {filtered ? <div className="mx-small" style={{ padding: '0 var(--pad) 8px' }}>{ctx.fill(TEXT.filterNote, { n: list.entries.length })}</div> : null}
        {list.error ? (
          <div style={{ padding: '0 var(--pad) 12px' }}>
            <Alert tone="bad" title={TEXT.listFailed}>
              <span className="mx-row">{ctx.li(list.error.message)}<Button variant="link" onClick={() => setTick((t) => t + 1)}>{ctx.li(TEXT.tryAgain)}</Button></span>
            </Alert>
          </div>
        ) : null}
        {list.loading && !list.entries.length ? <div className="mx-small" role="status" style={{ padding: '0 var(--pad) 12px' }}>{ctx.li(TEXT.loading)}</div> : null}
        {!list.loading || list.entries.length ? (
          <Table
            columns={columns}
            rows={shown}
            rowKey={(e) => e.key}
            onRow={(e: EntryModel) => setSelected(e)}
            empty={list.error ? null : <EmptyState title={TEXT.noEntries} text={TEXT.noEntriesText} illustration={<Illustration scene="no-findings" size="sm" decorative />} />}
          />
        ) : null}
        <div className="mx-row" style={{ justifyContent: 'space-between', padding: '8px var(--pad) 12px' }}>
          <span className="mx-small" data-trail-count="">
            {ctx.fill(TEXT.shown, { shown: shown.length, total: filtered ? list.entries.length : list.total })}
          </span>
          {list.entries.length < list.total ? <Button busy={list.loading} onClick={() => void loadPage(list.page + 1, true)}>{ctx.li(TEXT.loadMore)}</Button> : null}
        </div>
      </Card>
      {selected ? <EntryDrawer ctx={ctx} entry={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}
