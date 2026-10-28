// The drawer of an internal audit (MILESTONE-2 M2-14): its facts (date, days, lead auditor, scope, report, outcome
// summary), "Attach report" and "Record outcome summary", the audit activities with "Generate from templates" and
// "Edit activity" (the AUD-INDEP warning after a save), and the findings of the audit with "Raise finding" prefilled
// with the audit.
import { useState } from 'react';
import type { MsId } from '../../data/types';
import type { FindingsAdapter, TargetOption } from '../findings/model';
import { mayRaise } from '../findings/model';
import { ClassBadge, DrawerFoot, FindingStatusBadge, FormError, LoadState, Warnings, useLoad } from '../findings/parts';
import { RaiseDialog } from '../findings/RaiseDialog';
import type { Outcome, Warn } from '../findings/shared';
import { asApiResult, day, outcomeText, personName } from '../findings/shared';
import { TEXT as FINDING_TEXT } from '../findings/text';
import { useMutation } from '../api';
import type { HostContext } from '../types';
import { Badge, Button, Card, Drawer, Facts } from '../ui';
import { ActivityDialog, OutcomeDialog, ReportDialog } from './dialogs';
import { ACTIVITY_STATUS_TEXT, ACTIVITY_STATUS_TONE, mayRun, noTemplates } from './model';
import type { ActivityModel, AuditModel, InternalAuditAdapter, RecordOption } from './model';
import { TEXT } from './text';

type Dialog = 'report' | 'outcome' | 'raise' | null;

export function EventDrawer({ ctx, ms, audit, adapter, findingsAdapter, records, targets, onClose, onChanged }: {
  ctx: HostContext;
  ms: MsId;
  audit: AuditModel | null;
  adapter: InternalAuditAdapter;
  findingsAdapter: FindingsAdapter;
  records: readonly RecordOption[];
  targets: readonly TargetOption[];
  onClose(): void;
  /** After a write: the toast text and whether the cycles, programme and snapshot load again. */
  onChanged(outcome: Outcome, text: string): void;
}) {
  const id = audit?.id ?? '';
  const org = ctx.org?.id ?? '';
  const detail = useLoad(() => adapter.detail(ms, id), `${org}:${ms}:${id}:${ctx.lang}`, Boolean(audit));
  const activities = useLoad(() => adapter.activities(ms, id), `${org}:${ms}:${id}`, Boolean(audit));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editing, setEditing] = useState<ActivityModel | null>(null);
  const [warnings, setWarnings] = useState<Warn[]>([]);
  const codes = useLoad(() => findingsAdapter.findings(ms), `${org}:${ms}:${dialog === 'raise'}`, dialog === 'raise');
  const generate = useMutation(() => asApiResult(adapter.generate(ms, id)));
  if (!audit) return null;
  const run = mayRun(ctx, ms);
  const info = detail.data;
  const report = audit.reportDocumentId ? records.find((r) => r.id === audit.reportDocumentId) ?? null : null;
  const changed = (o: Outcome, text: string, lists: { detail?: boolean; activities?: boolean }) => {
    if (lists.detail) detail.reload();
    if (lists.activities) activities.reload();
    onChanged(o, text);
  };
  const doGenerate = () => {
    ctx.track(generate.submit(undefined)).then((res) => {
      if (!res.ok) return;
      const none = noTemplates(res.data.count, (activities.data ?? []).length);
      changed(res.data, none ? ctx.li(TEXT.noTemplates) : outcomeText(ctx, res.data, ctx.fill(TEXT.generated, { n: res.data.count ?? 0 })), { activities: true });
    }, () => undefined);
  };
  const reportText = audit.reportDocumentId ? (report ? `${report.code} ${report.title}` : ctx.li(TEXT.reportHidden)) : ctx.li(TEXT.reportMissing);
  return (
    <>
      <Drawer
        open
        title={info ? `${audit.shortLabel}: ${info.name}` : audit.shortLabel}
        crumb={TEXT.crumb}
        onClose={onClose}
        footer={run ? (
          <DrawerFoot>
            <Button onClick={() => setDialog('outcome')}>{ctx.li(TEXT.recordOutcome)}</Button>
            <Button variant="primary" onClick={() => setDialog('report')}>{ctx.li(audit.reportDocumentId ? TEXT.replaceReport : TEXT.attachReport)}</Button>
          </DrawerFoot>
        ) : undefined}
      >
        {LoadState({ ctx, loaded: detail, failed: TEXT.detailFailed })}
        <Facts
          items={[
            { label: TEXT.factDate, value: day(ctx, audit.scheduledAt) },
            { label: TEXT.factDays, value: info?.auditDays ? ctx.fill(TEXT.days, { n: info.auditDays }) : '-' },
            { label: TEXT.factLead, value: info?.leadAuditor ?? '-' },
            { label: TEXT.factScope, value: audit.scopeText ?? '-' },
            { label: TEXT.factReport, value: reportText },
            { label: TEXT.factOutcome, value: info?.outcomeSummary ?? '-' },
          ]}
        />
        <Warnings ctx={ctx} warnings={warnings} />
        <Card
          title={TEXT.activities}
          sub={TEXT.activitiesSub}
          actions={run ? <Button busy={generate.busy} onClick={doGenerate}>{ctx.li(TEXT.generate)}</Button> : null}
          flush
        >
          <div style={{ padding: generate.error ? '12px 16px 0' : 0 }}><FormError ctx={ctx} error={generate.error} /></div>
          {LoadState({ ctx, loaded: activities, failed: TEXT.activitiesFailed }) ?? (
            (activities.data ?? []).length ? (
              <div className="mx-stack" style={{ gap: 0 }}>
                {(activities.data ?? []).map((a) => (
                  <div key={a.id} className="mx-stack" style={{ gap: 4, padding: '10px 16px', borderTop: '1px solid var(--bd)' }} data-activity={a.code}>
                    <div className="mx-row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="mx-mono" style={{ fontWeight: 600, marginRight: 6 }}>{a.code}</span>
                        {a.title}
                      </span>
                      <Badge tone={ACTIVITY_STATUS_TONE[a.status]}>{ctx.li(ACTIVITY_STATUS_TEXT[a.status])}</Badge>
                      {run ? <Button onClick={() => setEditing(a)}>{ctx.li(TEXT.editActivity)}</Button> : null}
                    </div>
                    <span className="mx-small">
                      {ctx.fill(TEXT.activityLine, { target: a.targetCode ?? a.clauseRef ?? '-', auditor: personName(ctx.D, a.auditor), date: day(ctx, a.scheduledAt) })}
                    </span>
                  </div>
                ))}
              </div>
            ) : <div className="mx-small" style={{ padding: 16 }}>{ctx.li(TEXT.noActivities)}</div>
          )}
        </Card>
        <Card
          title={TEXT.findingsOfAudit}
          actions={mayRaise(ctx, ms) ? <Button onClick={() => setDialog('raise')}>{ctx.li(TEXT.raiseFinding)}</Button> : null}
        >
          {info && info.findings.length ? (
            <div className="mx-stack" style={{ gap: 8 }}>
              {info.findings.map((f) => (
                <div key={f.id} className="mx-row" style={{ alignItems: 'flex-start' }}>
                  <span className="mx-mono" style={{ fontWeight: 600 }}>{f.code}</span>
                  <span style={{ flex: 1, minWidth: 160 }}>{f.title}</span>
                  <ClassBadge ctx={ctx} value={f.classification} />
                  <FindingStatusBadge ctx={ctx} value={f.status} />
                </div>
              ))}
            </div>
          ) : <span className="mx-small">{ctx.li(TEXT.noFindingsOfAudit)}</span>}
        </Card>
      </Drawer>
      {run ? (
        <ActivityDialog
          ctx={ctx}
          ms={ms}
          activity={editing}
          adapter={adapter}
          targets={targets}
          onClose={() => setEditing(null)}
          onSaved={(o, text) => {
            setEditing(null);
            setWarnings(o.warnings);
            changed(o, text, { activities: true });
          }}
        />
      ) : null}
      {run ? (
        <ReportDialog
          ctx={ctx}
          ms={ms}
          open={dialog === 'report'}
          adapter={adapter}
          eventId={audit.id}
          label={audit.shortLabel}
          records={records}
          onClose={() => setDialog(null)}
          onAttached={(o, text) => { setDialog(null); changed(o, text, { detail: true }); }}
        />
      ) : null}
      {run ? (
        <OutcomeDialog
          ctx={ctx}
          ms={ms}
          open={dialog === 'outcome'}
          adapter={adapter}
          eventId={audit.id}
          label={audit.shortLabel}
          summary={info?.outcomeSummary ?? null}
          onClose={() => setDialog(null)}
          onSaved={(o, text) => { setDialog(null); changed(o, text, { detail: true }); }}
        />
      ) : null}
      {mayRaise(ctx, ms) ? (
        <RaiseDialog
          ctx={ctx}
          ms={ms}
          open={dialog === 'raise'}
          adapter={findingsAdapter}
          codes={(codes.data ?? []).map((f) => f.code)}
          prefill={{ source: 'internal_audit', auditEventId: audit.id }}
          onClose={() => setDialog(null)}
          onRaised={(o, code) => { setDialog(null); changed(o, outcomeText(ctx, o, ctx.fill(FINDING_TEXT.raised, { code })), { detail: true }); }}
        />
      ) : null}
    </>
  );
}
