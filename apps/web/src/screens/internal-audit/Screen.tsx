// Internal audit (MILESTONE-2 M2-14, `/ms/:ms/internal-audit`): the internal audit programme of a certification cycle
// (clauses 4 to 10 and the applicable controls, covered or not covered), the internal audits of the cycle with their
// drawer, and "Plan internal audit" for MS Managers and Internal Auditors.
import { useEffect, useMemo, useRef, useState } from 'react';
import { adapterFor as findingsAdapterFor } from '../findings/adapter';
import { LoadState, useLoad } from '../findings/parts';
import type { Outcome } from '../findings/shared';
import { day, reloadChanged } from '../findings/shared';
import type { HostContext, ScreenProps } from '../types';
import { Alert, Badge, Card, EmptyState, Field, Select, Table } from '../ui';
import type { Column } from '../ui';
import { adapterFor } from './adapter';
import { PlanDialog } from './dialogs';
import { EventDrawer } from './EventDrawer';
import { CYCLE_STATUS_TEXT, defaultCycle, filterProgramme, mayRun } from './model';
import type { AuditModel, CycleModel, Programme, ProgrammeFilter, ProgrammeRow, RecordOption } from './model';
import { TEXT } from './text';

export function cycleLabel(ctx: HostContext, c: CycleModel): string {
  return ctx.fill(TEXT.cycleOption, { start: day(ctx, c.cycleStart), end: day(ctx, c.cycleEnd), status: ctx.li(CYCLE_STATUS_TEXT[c.status]) });
}

export function AuditsTable({ ctx, audits, records, onOpen }: { ctx: HostContext; audits: AuditModel[]; records: readonly RecordOption[]; onOpen(a: AuditModel): void }) {
  const columns: Column<AuditModel>[] = [
    { key: 'audit', label: TEXT.colAudit, render: (a) => <span style={{ fontWeight: 600 }}>{a.shortLabel}</span> },
    { key: 'date', label: TEXT.colDate, render: (a) => day(ctx, a.scheduledAt) },
    { key: 'scope', label: TEXT.colScope, render: (a) => <span className="mx-muted">{a.scopeText ?? '-'}</span> },
    {
      key: 'report',
      label: TEXT.colReport,
      render: (a) => {
        if (!a.reportDocumentId) return <Badge tone="warn">{ctx.li(TEXT.reportMissing)}</Badge>;
        const r = records.find((x) => x.id === a.reportDocumentId);
        return <Badge tone="ok">{r ? r.code : ctx.li(TEXT.reportAttached)}</Badge>;
      },
    },
  ];
  return <Table columns={columns} rows={audits} rowKey={(a) => a.id} onRow={onOpen} />;
}

export function ProgrammeCard({ ctx, programme }: { ctx: HostContext; programme: Programme }) {
  const [filter, setFilter] = useState<ProgrammeFilter>('all');
  const rows = filterProgramme(programme.rows, filter);
  const covered = programme.rows.filter((r) => r.covered).length;
  const columns: Column<ProgrammeRow>[] = [
    { key: 'code', label: TEXT.colCode, render: (r) => <span className="mx-mono" style={{ whiteSpace: 'nowrap' }}>{r.code}</span> },
    { key: 'title', label: TEXT.colTitle, render: (r) => r.title },
    { key: 'kind', label: TEXT.colKind, render: (r) => ctx.li(r.kind === 'clause' ? TEXT.kindClause : TEXT.kindControl) },
    {
      key: 'coverage',
      label: TEXT.colCoverage,
      render: (r) => (r.covered
        ? (
          <span className="mx-row" style={{ gap: 6 }}>
            <Badge tone="ok">{ctx.li(TEXT.covered)}</Badge>
            <span className="mx-small">{r.audits.map((a) => a.shortLabel).join(', ')}</span>
          </span>
        )
        : <Badge tone="warn">{ctx.li(TEXT.notCovered)}</Badge>),
    },
  ];
  return (
    <Card title={TEXT.programme} sub={TEXT.programmeSub} flush>
      <div className="mx-row" style={{ padding: '12px 16px', alignItems: 'flex-end' }}>
        <div style={{ width: 260 }}>
          <Field label={TEXT.show}>
            <Select
              value={filter}
              onChange={(v) => setFilter(v as ProgrammeFilter)}
              name="coverage"
              options={[
                { value: 'all', label: TEXT.showAll }, { value: 'uncovered', label: TEXT.showUncovered },
                { value: 'clause', label: TEXT.showClauses }, { value: 'control', label: TEXT.showControls },
              ]}
            />
          </Field>
        </div>
        <span className="mx-small" style={{ marginLeft: 'auto' }} data-coverage>{ctx.fill(TEXT.coverage, { covered, total: programme.rows.length })}</span>
      </div>
      {rows.length ? <Table columns={columns} rows={rows} rowKey={(r) => `${r.kind}:${r.code}`} /> : <div className="mx-small" style={{ padding: '0 16px 16px' }}>{ctx.li(TEXT.noRows)}</div>}
    </Card>
  );
}

export default function InternalAuditScreen({ ctx }: ScreenProps) {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(() => ctxRef.current), [client]);
  const findingsAdapter = useMemo(() => findingsAdapterFor(() => ctxRef.current), [client]);
  const ms = ctx.msObj?.id ?? null;
  const org = ctx.org?.id ?? '';
  const [cycleId, setCycleId] = useState<string | null>(null);
  const [auditId, setAuditId] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const cycles = useLoad(() => adapter.cycles(ms!), `${org}:${ms}`, Boolean(ms));
  const list = cycles.data ?? [];
  const cycle = list.find((c) => c.id === cycleId) ?? defaultCycle(list);
  const programme = useLoad(() => adapter.programme(ms!, cycle?.id ?? null), `${org}:${ms}:${cycle?.id ?? 'none'}`, Boolean(ms) && cycles.data !== null);
  // The records come from the documents of the snapshot (API) and are read again when the system's documents change.
  const docs = ms ? ctx.D?.bundles?.[ms]?.docs.length ?? 0 : 0;
  const records = useLoad(() => adapter.records(ms!), `${org}:${ms}:${docs}`, Boolean(ms));
  const targets = useLoad(() => adapter.targets(ms!), `${org}:${ms}`, Boolean(ms));

  const planRequest = ctx.params.plan;
  useEffect(() => {
    if (planRequest) setPlanning(true);
  }, [planRequest]);
  useEffect(() => {
    setCycleId(null);
    setAuditId(null);
  }, [ms]);

  if (!ms) return <div className="mx-small">{ctx.li(TEXT.noSystem)}</div>;
  const audit = cycle?.audits.find((a) => a.id === auditId) ?? null;
  const after = (outcome: Outcome, text: string) => {
    ctx.toast(text);
    cycles.reload();
    programme.reload();
    records.reload();
    void reloadChanged(ctx, outcome.changed).then(() => records.reload(), () => undefined);
  };

  let body;
  const failed = LoadState({ ctx, loaded: cycles, failed: TEXT.loadFailed });
  if (failed) body = failed;
  else if (!cycle) {
    body = (
      <Alert tone="info" title={TEXT.noCycle}>
        <span>{ctx.li(TEXT.noCycleText)}</span>
      </Alert>
    );
  } else {
    body = (
      <>
        {list.length > 1 ? (
          <div style={{ maxWidth: 420 }}>
            <Field label={TEXT.cycle}>
              <Select value={cycle.id} onChange={(v) => { setCycleId(v); setAuditId(null); }} options={list.map((c) => ({ value: c.id, label: cycleLabel(ctx, c) }))} name="cycle" />
            </Field>
          </div>
        ) : (
          <div className="mx-small">{ctx.li(TEXT.cycle)}: {cycleLabel(ctx, cycle)}</div>
        )}
        <Card title={TEXT.audits} sub={TEXT.auditsSub} flush>
          {cycle.audits.length
            ? <AuditsTable ctx={ctx} audits={cycle.audits} records={records.data ?? []} onOpen={(a) => setAuditId(a.id)} />
            : <EmptyState title={TEXT.noAudits} text={TEXT.noAuditsText} />}
        </Card>
        {LoadState({ ctx, loaded: programme, failed: TEXT.programmeFailed }) ?? (programme.data ? <ProgrammeCard key={cycle.id} ctx={ctx} programme={programme.data} /> : null)}
      </>
    );
  }
  return (
    <>
      {body}
      {/* Keyed by the audit, so a warning, dialog or activity of one audit never shows in the drawer of another. */}
      <EventDrawer
        key={audit?.id ?? 'none'}
        ctx={ctx}
        ms={ms}
        audit={audit}
        adapter={adapter}
        findingsAdapter={findingsAdapter}
        records={records.data ?? []}
        targets={targets.data ?? []}
        onClose={() => setAuditId(null)}
        onChanged={after}
      />
      {mayRun(ctx, ms) ? (
        <PlanDialog
          ctx={ctx}
          ms={ms}
          open={planning}
          adapter={adapter}
          hasCycle={Boolean(cycle)}
          onClose={() => setPlanning(false)}
          onPlanned={(o, text) => {
            setPlanning(false);
            after(o, text);
            if (o.ref?.id) setAuditId(o.ref.id);
          }}
        />
      ) : null}
    </>
  );
}
