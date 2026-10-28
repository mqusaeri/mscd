// Operator console, Health and Jobs (MILESTONE-2 M2-16): components, migrations, licence states and the diagnostics
// archive; queue statistics and "Run job" for the jobs of the allow-list.
import { useCallback, useEffect, useState } from 'react';
import type { ApiResult } from '../../data/api/ApiClient';
import { useMutation } from '../api';
import type { HostContext } from '../types';
import { Alert, Badge, Button, Card, Field, Select, Table, TextInput } from '../ui';
import type { Column, Tone } from '../ui';
import { LICENCE_TEXT, NO_END_DATE, OPS_JOBS, STATUS_TEXT, ageText, validJobOrg } from './model';
import type { ComponentStatus, Health, OpsAdapter, QueueStat, Result } from './model';
import { TEXT } from './text';

/** Loads a result when the component mounts and on `reload()`; a newer load wins over an older one. */
export function useLoad<T>(load: () => Promise<Result<T>>): { result: Result<T> | null; reload(): void } {
  const [result, setResult] = useState<Result<T> | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setResult(null);
    void load().then((r) => { if (live) setResult(r); });
    return () => { live = false; };
  }, [load, tick]);
  return { result, reload: () => setTick((t) => t + 1) };
}

export const asApi = <T,>(r: Result<T>): ApiResult<T> => (r.ok ? { ok: true, status: 200, data: r.data } : { ok: false, status: r.error.status, error: r.error });

const STATUS_TONE: Readonly<Record<ComponentStatus, Tone>> = { ok: 'ok', degraded: 'warn', down: 'bad' };

/** Loading text, or the error with Try again. */
export function LoadState({ ctx, result, failed, retry }: { ctx: HostContext; result: Result<unknown> | null; failed: readonly [string, string]; retry(): void }) {
  if (!result) return <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  if (result.ok) return null;
  return (
    <Alert tone="bad" title={failed}>
      <div>{ctx.li(result.error.message)}</div>
      <div style={{ marginTop: 8 }}><Button onClick={retry}>{ctx.li(TEXT.tryAgain)}</Button></div>
    </Alert>
  );
}

/** Saves a downloaded file through a link the browser follows. */
export function saveBlob(blob: Blob, fileName: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function HealthView({ ctx, health }: { ctx: HostContext; health: Health }) {
  const day = (iso: string) => (iso === NO_END_DATE ? ctx.li(TEXT.noEndDate) : ctx.D ? ctx.D.fmt(iso, ctx.lang) : iso);
  const components: Column<Health['components'][number]>[] = [
    { key: 'name', label: TEXT.colComponent, render: (c) => <span className="mx-mono">{c.name}</span> },
    { key: 'status', label: TEXT.colStatus, render: (c) => <Badge tone={STATUS_TONE[c.status]}>{ctx.li(STATUS_TEXT[c.status])}</Badge> },
    { key: 'detail', label: TEXT.colDetail, render: (c) => <span className="mx-muted">{c.detail}</span> },
  ];
  const migrations: Column<Health['migrations'][number]>[] = [
    { key: 'schema', label: TEXT.colSchema, render: (m) => <span className="mx-mono">{m.schema}</span> },
    { key: 'latest', label: TEXT.colLatest, render: (m) => <span className="mx-mono">{m.latest ?? '-'}</span> },
    { key: 'expected', label: TEXT.colExpected, render: (m) => <span className="mx-mono">{m.expected ?? '-'}</span> },
    {
      key: 'state',
      label: TEXT.colStatus,
      render: (m) => (m.latest === m.expected ? <Badge tone="ok">{ctx.li(TEXT.upToDate)}</Badge> : <Badge tone="bad">{ctx.li(TEXT.behind)}</Badge>),
    },
  ];
  const licences: Column<Health['licences'][number]>[] = [
    { key: 'org', label: TEXT.colOrg, render: (l) => <span className="mx-mono">{l.org}</span> },
    { key: 'state', label: TEXT.colState, render: (l) => <Badge tone={l.state === 'valid' ? 'ok' : l.state === 'grace' ? 'warn' : 'bad'}>{ctx.li(LICENCE_TEXT[l.state])}</Badge> },
    { key: 'until', label: TEXT.colValidUntil, render: (l) => day(l.validUntil) },
  ];
  return (
    <>
      <Card title={TEXT.components} sub={TEXT.componentsSub} flush>
        <Table columns={components} rows={health.components} rowKey={(c) => c.name} />
      </Card>
      <Card title={TEXT.migrations} sub={TEXT.migrationsSub} flush>
        <Table columns={migrations} rows={health.migrations} rowKey={(m) => m.schema} />
      </Card>
      <Card title={TEXT.licences} sub={TEXT.licencesSub} flush={health.licences.length > 0}>
        {health.licences.length ? <Table columns={licences} rows={health.licences} rowKey={(l) => l.org} /> : <span className="mx-muted">{ctx.li(TEXT.noLicences)}</span>}
      </Card>
    </>
  );
}

export function DiagnosticsCard({ ctx, adapter }: { ctx: HostContext; adapter: OpsAdapter }) {
  const run = useCallback(() => adapter.diagnostics().then(asApi), [adapter]);
  const mutation = useMutation<void, { blob: Blob; fileName: string }>(run);
  const download = () => {
    void ctx.track(mutation.submit()).then((res) => {
      if (!res.ok) return;
      saveBlob(res.data.blob, res.data.fileName);
      ctx.toast(ctx.li(TEXT.diagnosticsSaved));
    }, () => undefined);
  };
  return (
    <Card title={TEXT.diagnostics} sub={TEXT.diagnosticsSub}>
      <div className="mx-stack">
        {mutation.error ? <Alert tone="bad">{ctx.li(mutation.error.message)}</Alert> : null}
        <div><Button busy={mutation.busy} onClick={download}>{ctx.li(TEXT.downloadDiagnostics)}</Button></div>
      </div>
    </Card>
  );
}

export function HealthTab({ ctx, adapter }: { ctx: HostContext; adapter: OpsAdapter }) {
  const load = useCallback(() => adapter.health(), [adapter]);
  const { result, reload } = useLoad(load);
  return (
    <>
      <div className="mx-row" style={{ justifyContent: 'flex-end' }}><Button onClick={reload}>{ctx.li(TEXT.refresh)}</Button></div>
      {result && result.ok ? <HealthView ctx={ctx} health={result.data} /> : <LoadState ctx={ctx} result={result} failed={TEXT.healthFailed} retry={reload} />}
      <DiagnosticsCard ctx={ctx} adapter={adapter} />
    </>
  );
}

export function QueuesTable({ ctx, queues }: { ctx: HostContext; queues: QueueStat[] }) {
  const columns: Column<QueueStat>[] = [
    { key: 'name', label: TEXT.colQueue, render: (q) => <span className="mx-mono">{q.name}</span> },
    { key: 'waiting', label: TEXT.colWaiting, align: 'right', render: (q) => q.waiting },
    { key: 'active', label: TEXT.colActive, align: 'right', render: (q) => q.active },
    { key: 'failed', label: TEXT.colFailed, align: 'right', render: (q) => (q.failed ? <Badge tone="bad">{q.failed}</Badge> : 0) },
    {
      key: 'oldest',
      label: TEXT.colOldest,
      align: 'right',
      render: (q) => {
        if (!q.waiting) return '-';
        const age = ageText(q.oldestAgeSeconds);
        return ctx.fill(age.text, { n: age.n });
      },
    },
  ];
  if (!queues.length) return <div style={{ padding: 'var(--pad)' }}><span className="mx-muted">{ctx.li(TEXT.noQueues)}</span></div>;
  return <Table columns={columns} rows={queues} rowKey={(q) => q.name} />;
}

export function RunJobCard({ ctx, adapter, onRun }: { ctx: HostContext; adapter: OpsAdapter; onRun(): void }) {
  const [job, setJob] = useState<string>(OPS_JOBS[0]);
  const [org, setOrg] = useState('');
  const [shown, setShown] = useState<readonly [string, string] | null>(null);
  const run = useCallback((input: { job: string; org: string | null }) => adapter.runJob(input.job, input.org).then(asApi), [adapter]);
  const mutation = useMutation<{ job: string; org: string | null }, string>(run);
  const submit = () => {
    if (!validJobOrg(org)) {
      setShown(TEXT.slugInvalid);
      return;
    }
    void ctx.track(mutation.submit({ job, org: org.trim() || null })).then((res) => {
      if (!res.ok) return;
      ctx.toast(ctx.fill(TEXT.jobQueued, { job, id: res.data }));
      onRun();
    }, () => undefined);
  };
  return (
    <Card title={TEXT.runJob} sub={TEXT.runJobSub}>
      <form className="mx-stack" style={{ maxWidth: 480 }} onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <Field label={TEXT.job}>
          <Select value={job} onChange={setJob} options={OPS_JOBS.map((j) => ({ value: j, label: j }))} />
        </Field>
        <Field label={TEXT.jobOrg} hint={TEXT.jobOrgHint} error={shown ?? mutation.fields.org ?? null}>
          <TextInput value={org} onChange={(v) => { setOrg(v); setShown(null); mutation.reset(); }} autoComplete="off" />
        </Field>
        {mutation.error && !mutation.fields.org ? <Alert tone="bad">{ctx.li(mutation.error.message)}</Alert> : null}
        <div><Button type="submit" variant="primary" busy={mutation.busy}>{ctx.li(TEXT.run)}</Button></div>
      </form>
    </Card>
  );
}

export function JobsTab({ ctx, adapter }: { ctx: HostContext; adapter: OpsAdapter }) {
  const load = useCallback(() => adapter.queues(), [adapter]);
  const { result, reload } = useLoad(load);
  return (
    <>
      <Card title={TEXT.queues} sub={TEXT.queuesSub} flush actions={<Button onClick={reload}>{ctx.li(TEXT.refresh)}</Button>}>
        {result && result.ok ? <QueuesTable ctx={ctx} queues={result.data} /> : <div style={{ padding: 'var(--pad)' }}><LoadState ctx={ctx} result={result} failed={TEXT.healthFailed} retry={reload} /></div>}
      </Card>
      {ctx.platformCan('ops.jobs.run') ? <RunJobCard ctx={ctx} adapter={adapter} onRun={reload} /> : null}
    </>
  );
}
