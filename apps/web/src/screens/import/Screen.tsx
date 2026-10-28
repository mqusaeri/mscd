// Import screen (MILESTONE-2 M2-08, D2-13): one file per import, checked first and imported as a whole. The person
// picks what to import (the kinds they may manage in the system), downloads the template, chooses an XLSX or CSV file
// and checks it: every row gets OK, a warning or an error, with what the import does with it, and nothing changes.
// "Import N rows" stays disabled while a row has an error; the import then runs in the worker, its progress follows
// the task, and the summary links to the screen of the kind. The api adapter or the sample adapter is chosen by the
// build (C.6), and forms use useMutation (M2-01 note).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommandResult } from '@mscd/shared';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ApiClient, ApiError, ApiResult } from '../../data/api/ApiClient';
import type { ControllerData, DataSource } from '../../data/types';
import type { HostContext, ScreenProps } from '../types';
import { useMutation } from '../api';
import { Alert, Badge, Button, Card, EmptyState, Field, FileInput, Meter, Pager, Select, Table, Tabs } from '../ui';
import type { Column, Tone } from '../ui';
import { createApiAdapter } from './api';
import { IMPORT_KINDS, KIND_SCREENS, filterRows, importBlocked, isRunning, rowsToImport, sessionMayImport } from './model';
import type { ImportAdapter, ImportKind, ImportRowResult, ImportRun, Result, RowFilter } from './model';
import { KIND_TEXT, TEXT } from './text';

/** Rows of the results table per page. */
export const PAGE_SIZE = 50;
/** Milliseconds between two reads of a running import. */
export const POLL_MS = 1000;

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(kinds: readonly ImportKind[], load: () => Promise<ImportAdapter>): ImportAdapter {
  let pending: Promise<ImportAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    kinds,
    template: (ms, kind, lang) => get().then((a) => a.template(ms, kind, lang)),
    check: (ms, kind, file) => get().then((a) => a.check(ms, kind, file)),
    get: (ms, id) => get().then((a) => a.get(ms, id)),
    commit: (ms, id) => get().then((a) => a.commit(ms, id)),
  };
}

/**
 * The adapter of the build (C.6): the api's routes when the build's `VITE_DATA_SOURCE` is `api`, the sample snapshot
 * otherwise. The value is written out in full so Vite replaces it and drops the other branch; the sample adapter comes
 * through a dynamic import, so an api build holds no sample code (R-13). Unit tests call both adapters directly.
 */
export function adapterFor(client: ApiClient | null, getD: () => ControllerData | null, getDs: () => DataSource | null): ImportAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(client)
    : deferredAdapter(['applicability', 'documents'], () => import('./sample').then((m) => m.createSampleAdapter(getD, getDs)));
}

/** An adapter result as the ApiResult that useMutation keeps (a failed module load is a connection error). */
function asApi<T>(promise: Promise<Result<T>>): Promise<ApiResult<T>> {
  return promise.then(
    (r): ApiResult<T> => (r.ok ? { ok: true, status: 200, data: r.data } : { ok: false, status: r.error.status, error: r.error }),
    (): ApiResult<T> => ({ ok: false, status: 0, error: { status: 0, message: CONNECTION_LOST } }),
  );
}

/**
 * The kinds the session may import in the system, in screen order: the permission held in full, or for evidence also
 * for own records (a Risk Owner is offered evidence, never risks, which the api would refuse).
 */
export function allowedKinds(ctx: HostContext, adapter: Pick<ImportAdapter, 'kinds'>, ms: string | null): ImportKind[] {
  if (!ms) return [];
  return IMPORT_KINDS.filter((k) => adapter.kinds.includes(k) && sessionMayImport(ctx, ms, k));
}

const STATUS_TONE: Readonly<Record<ImportRowResult['status'], Tone>> = { ok: 'ok', warning: 'warn', error: 'bad' };

/** The columns of the results table. */
export function resultColumns(ctx: HostContext): Column<ImportRowResult>[] {
  return [
    { key: 'row', label: TEXT.colRow, align: 'right', width: 64, render: (r) => r.row },
    { key: 'code', label: TEXT.colCode, width: 120, render: (r) => (r.code ? <span className="mx-mono">{r.code}</span> : '-') },
    {
      key: 'status', label: TEXT.colResult, width: 110,
      render: (r) => <Badge tone={STATUS_TONE[r.status]}>{ctx.li(r.status === 'ok' ? TEXT.ok : r.status === 'warning' ? TEXT.warning : TEXT.error)}</Badge>,
    },
    { key: 'action', label: TEXT.colAction, width: 130, render: (r) => ctx.li(r.status === 'error' || !r.action ? TEXT.none : TEXT[r.action]) },
    {
      key: 'messages', label: TEXT.colMessages,
      render: (r) => (r.messages.length === 0 ? '-' : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {r.messages.map((m, i) => <li key={i}>{ctx.lang === 'id' ? m.id : m.en}</li>)}
        </ul>
      )),
    },
  ];
}

/** The results of a checked file: counts, filters, the rows, and the import with its progress and outcome. */
export function ImportResults({ ctx, run, committing, commitError, onCommit, onReset }: {
  ctx: HostContext;
  run: ImportRun;
  committing: boolean;
  commitError: ApiError | null;
  onCommit(): void;
  onReset(): void;
}) {
  const [filter, setFilter] = useState<RowFilter>(run.counts.error > 0 ? 'error' : 'all');
  const [page, setPage] = useState(1);
  const rows = filterRows(run.results, filter);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice((Math.min(page, pages) - 1) * PAGE_SIZE, Math.min(page, pages) * PAGE_SIZE);
  const n = rowsToImport(run);
  const blocked = importBlocked(run);
  const target = KIND_SCREENS[run.kind];
  const done = run.status === 'committed' || run.status === 'failed';
  return (
    <Card
      title={TEXT.results}
      sub={ctx.fill(TEXT.resultsSub, { file: run.fileName, rows: run.rowCount })}
      actions={(
        <>
          <Badge tone="ok">{ctx.fill(TEXT.countOk, { n: run.counts.ok })}</Badge>
          <Badge tone={run.counts.warning ? 'warn' : 'mute'}>{ctx.fill(TEXT.countWarning, { n: run.counts.warning })}</Badge>
          <Badge tone={run.counts.error ? 'bad' : 'mute'}>{ctx.fill(TEXT.countError, { n: run.counts.error })}</Badge>
        </>
      )}
    >
      <div className="mx-stack">
        {run.status === 'validated' || run.status === 'expired' ? (
          <div className="mx-stack">
            {run.status === 'expired' ? <Alert tone="warn">{ctx.li(TEXT.expired)}</Alert> : null}
            {run.counts.warning > 0 && run.counts.error === 0 ? <Alert tone="warn">{ctx.li(TEXT.warningsNote)}</Alert> : null}
            {commitError ? (
              <Alert tone="bad" title={TEXT.commitFailed}>
                <div>{ctx.li(commitError.message)}</div>
              </Alert>
            ) : null}
            <div className="mx-row">
              <Button
                variant="primary"
                busy={committing}
                disabledReason={blocked === 'errors' ? TEXT.blockedByErrors : blocked === 'nothing' ? TEXT.nothingToImport : blocked === 'expired' ? TEXT.expired : null}
                onClick={onCommit}
              >
                {n === 1 ? ctx.li(TEXT.importOne) : ctx.fill(TEXT.importRows, { n })}
              </Button>
              <Button onClick={onReset}>{ctx.li(TEXT.startAgain)}</Button>
            </div>
          </div>
        ) : null}
        {isRunning(run) ? (
          <Alert tone="info" title={TEXT.importing}>
            <div>{ctx.fill(TEXT.importingText, { pct: run.progress ?? 0 })}</div>
            <div style={{ marginTop: 8, maxWidth: 360 }}><Meter used={run.progress ?? 0} limit={100} /></div>
          </Alert>
        ) : null}
        {run.status === 'committed' ? (
          <Alert tone="ok" title={TEXT.finished}>
            <div>{ctx.fill(TEXT.finishedText, { created: run.summary?.created ?? 0, updated: run.summary?.updated ?? 0, unchanged: run.summary?.unchanged ?? 0 })}</div>
          </Alert>
        ) : null}
        {run.status === 'failed' ? (
          <Alert tone="bad" title={TEXT.failed}>
            {run.failure ? <div>{ctx.lang === 'id' ? run.failure.id : run.failure.en}</div> : null}
          </Alert>
        ) : null}
        {done ? (
          <div className="mx-row">
            {run.status === 'committed' ? (
              <Button variant="primary" onClick={() => ctx.go(target.id)}>{ctx.fill(TEXT.open, { screen: ctx.li(target.label) })}</Button>
            ) : null}
            <Button onClick={onReset}>{ctx.li(TEXT.startAgain)}</Button>
          </div>
        ) : null}
        <Tabs
          label={TEXT.filterLabel}
          active={filter}
          onChange={(id) => { setFilter(id as RowFilter); setPage(1); }}
          tabs={[
            { id: 'all', label: TEXT.all, count: run.results.length },
            { id: 'error', label: TEXT.errorsOnly, count: run.counts.error },
            { id: 'warning', label: TEXT.warningsOnly, count: run.counts.warning },
          ]}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <Table
          columns={resultColumns(ctx)}
          rows={shown}
          rowKey={(r) => String(r.row)}
          empty={<div className="mx-small" style={{ padding: 12 }}>{ctx.li(TEXT.noRows)}</div>}
        />
        <Pager page={Math.min(page, pages)} pages={pages} onPage={setPage} />
      </div>
    </Card>
  );
}

/** Saves a file the adapter offers (an api link, or a file made in the browser). */
function save(href: string, fileName: string, release?: () => void): void {
  if (typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (release) setTimeout(release, 1000);
}

export default function ImportScreen({ ctx }: ScreenProps) {
  const data = useRef(ctx.D);
  data.current = ctx.D;
  const source = useRef(ctx.ds);
  source.current = ctx.ds;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(client, () => data.current, () => source.current), [client]);
  const ms = ctx.msObj?.id ?? null;
  const kinds = allowedKinds(ctx, adapter, ms);
  const requested = typeof ctx.params.kind === 'string' ? (ctx.params.kind as ImportKind) : null;
  const [kind, setKind] = useState<ImportKind | null>(requested && kinds.includes(requested) ? requested : (kinds[0] ?? null));
  const [file, setFile] = useState<File | null>(null);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const reloaded = useRef<string | null>(null);

  // The page action of Controls & requirements or Document register opens the screen with its kind.
  useEffect(() => {
    if (requested && kinds.includes(requested)) setKind(requested);
    // `kinds` follows the permissions, which do not change while the screen is open.
  }, [requested, ctx.params.at]);

  // Another management system starts over, with a kind the person may import there.
  const shownMs = useRef(ms);
  useEffect(() => {
    if (shownMs.current === ms) return;
    shownMs.current = ms;
    setRun(null);
    setFile(null);
    setFileKey((k) => k + 1);
    setLoadError(null);
    setKind((current) => (current && kinds.includes(current) ? current : (kinds[0] ?? null)));
  }, [ms]);

  const check = useMutation(useCallback(
    (input: { ms: string; kind: ImportKind; file: File }) => asApi(adapter.check(input.ms, input.kind, input.file)),
    [adapter],
  ));
  const commit = useMutation(useCallback((input: { ms: string; id: string }) => asApi<CommandResult>(adapter.commit(input.ms, input.id)), [adapter]));

  const reset = () => {
    setRun(null);
    setFile(null);
    setFileKey((k) => k + 1);
    check.reset();
    commit.reset();
    setLoadError(null);
  };

  // Follows a running import through its task until it ends (one read per POLL_MS, also while the progress stays the
  // same); then the screens of the kind load the changes again. An import that is gone (404) is not read again.
  const runId = run?.id ?? null;
  const running = isRunning(run);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running || !ms || !runId) return undefined;
    let stop = false;
    const timer = setTimeout(() => {
      adapter.get(ms, runId).then((res) => {
        if (stop) return;
        if (res.ok) {
          setRun(res.data);
          setLoadError(null);
        } else setLoadError(res.error);
        if (res.ok || res.error.status !== 404) setTick((t) => t + 1);
      }, () => {
        if (!stop) setTick((t) => t + 1);
      });
    }, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [adapter, ms, runId, running, tick]);

  useEffect(() => {
    if (run?.status === 'committed' && reloaded.current !== run.id) {
      reloaded.current = run.id;
      void ctx.reload(run.changed && run.changed.length ? run.changed : ms ? [ms] : []);
    }
  }, [run?.status, run?.id]);

  if (!ms) return <Card><EmptyState title={TEXT.noSystem} /></Card>;
  if (kinds.length === 0 || !kind) return <Card><EmptyState title={TEXT.noKinds} text={TEXT.noKindsText} /></Card>;

  const submitCheck = () => {
    if (!file) return;
    ctx.track(check.submit({ ms, kind, file })).then((res) => {
      if (res.ok) setRun(res.data);
    }, () => undefined);
  };
  const submitCommit = () => {
    if (!run) return;
    ctx.track(commit.submit({ ms, id: run.id })).then((res) => {
      if (!res.ok) return;
      setRun({ ...run, status: 'committing', taskId: res.data.taskId ?? null, progress: 0 });
      if (res.data.message) ctx.toast(ctx.li(res.data.message as readonly [string, string]));
    }, () => undefined);
  };
  const download = () => {
    adapter.template(ms, kind, ctx.lang).then((d) => save(d.href, d.fileName, d.release), () => ctx.toast(ctx.li(CONNECTION_LOST)));
  };

  return (
    <>
      {!run ? (
        <Card title={TEXT.fileCard} sub={TEXT.fileCardSub}>
          <div className="mx-stack">
            <Field label={TEXT.kind} hint={kinds.length > 1 ? TEXT.kindHint : undefined}>
              <Select
                value={kind}
                onChange={(v) => { setKind(v as ImportKind); check.reset(); }}
                options={kinds.map((k) => ({ value: k, label: KIND_TEXT[k] }))}
              />
            </Field>
            <div className="mx-stack" style={{ gap: 4 }}>
              <div className="mx-row"><Button icon="M12 3v12M7 10l5 5 5-5M4 19h16" onClick={download}>{ctx.li(TEXT.template)}</Button></div>
              <span className="mx-small">{ctx.li(TEXT.templateHint)}</span>
            </div>
            <Field label={TEXT.file} hint={TEXT.fileHint} error={check.error ? check.error.message : null} required>
              <FileInput key={fileKey} accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onFile={(f) => { setFile(f); check.reset(); }} />
            </Field>
            <div className="mx-row">
              <Button variant="primary" busy={check.busy} disabledReason={file ? null : TEXT.chooseFirst} onClick={submitCheck}>{ctx.li(TEXT.check)}</Button>
            </div>
          </div>
        </Card>
      ) : (
        <ImportResults ctx={ctx} run={run} committing={commit.busy} commitError={commit.error} onCommit={submitCommit} onReset={reset} />
      )}
      {loadError ? (
        <Alert tone="bad" title={TEXT.loadFailed}>
          <div>{ctx.li(loadError.message)}</div>
        </Alert>
      ) : null}
    </>
  );
}
