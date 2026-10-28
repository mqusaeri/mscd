// The panel below the audit event of the certification timeline (detail extension of kind `event`, MILESTONE-2
// M2-15, C.5): what can be done with this audit ("Edit", "Record result"), the certification cycle it belongs to with
// its certificate and expiry date ("Start certification cycle", "Record certificate", "Record suspension",
// "Reinstate certificate", "Record withdrawal", "Close cycle"), and for a certification audit its audit activities
// ("Generate activities", "Edit activity"). Buttons show only with the permission of F.6, as Verify does.
import { useEffect, useId, useSyncExternalStore } from 'react';
import type { AuditEvent, MsId } from '../../data/types';
import type { DetailProps, HostContext } from '../types';
import { Alert, Badge, Button, Facts } from '../ui';
import { adapterFor } from './adapter';
import {
  ACTIVITY_STATUS_TEXT, ACTIVITY_STATUS_TONE, CERTIFICATION_AUDITS, CYCLE_STATUS_TEXT, CYCLE_STATUS_TONE, EVENT_TYPE_TEXT, MOVE_TEXT, OUTCOME_TEXT,
  OUTCOME_TONE, activeCycle, expiringSoon, expiryText, fmtDate, mayManageEvents, mayMoveCycle, movesOf, orgKeyOf, outcomeText, personName,
  recommendation, resolveEvent, todayOf,
} from './model';
import type { ActivityModel, CycleModel, EventModel, TimelineAdapter } from './model';
import { activitiesEntry, cyclesEntry, loadActivities, loadCycles, openForm, storeVersion, subscribe } from './store';
import { TEXT } from './text';

/** The record the controller passes for an audit event: its system, its position in `EVENTS` and the row. */
export interface EventRecord {
  ms: MsId;
  index: number;
  event: AuditEvent;
}

export function useStore(): number {
  return useSyncExternalStore(subscribe, storeVersion, storeVersion);
}

export default function EventPanel({ ctx, ms, record }: DetailProps) {
  useStore();
  const adapter = adapterFor(ctx);
  const rec = record as EventRecord | null;
  const org = orgKeyOf(ctx);
  useEffect(() => {
    void loadCycles(ctx, adapter, ms);
  }, [ms, org]);
  if (!rec || !rec.event) return null;
  const entry = cyclesEntry(ctx, ms);
  if (!entry || (entry.loading && !entry.data)) return <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  if (!entry.data) {
    return (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <Button variant="link" onClick={() => void loadCycles(ctx, adapter, ms, true)}>{ctx.li(TEXT.tryAgain)}</Button>
      </Alert>
    );
  }
  const cycles = entry.data;
  const event = resolveEvent(cycles, ms, rec.index, rec.event);
  const cycle = event ? cycles.find((c) => c.id === event.cycleId) ?? null : activeCycle(cycles) ?? cycles[0] ?? null;
  return (
    <div className="mx-tl-panel" data-tl-panel={ms}>
      <ThisAudit ctx={ctx} ms={ms} event={event} row={rec.event} />
      <CyclePanel ctx={ctx} ms={ms} cycle={cycle} cycles={cycles} inCycle={Boolean(event)} />
      {event && CERTIFICATION_AUDITS.includes(event.eventType) ? <Activities ctx={ctx} ms={ms} event={event} adapter={adapter} /> : null}
    </div>
  );
}

/** "This audit": its type and result, "Edit" and "Record result". */
function ThisAudit({ ctx, ms, event, row }: { ctx: HostContext; ms: MsId; event: EventModel | null; row: AuditEvent }) {
  const headId = useId();
  if (!event) {
    return (
      <section className="mx-tl-box" aria-labelledby={headId}>
        <h3 id={headId} className="mx-tl-title">{ctx.li(TEXT.eventActions)}</h3>
        <p className="mx-tl-text">{ctx.li(TEXT.notInCycle)}</p>
      </section>
    );
  }
  const internal = event.eventType === 'internal_audit';
  const manage = mayManageEvents(ctx, ms) && !internal;
  const happened = row.d <= todayOf(ctx);
  return (
    <section className="mx-tl-box" aria-labelledby={headId} data-tl-event={event.shortLabel}>
      <div className="mx-tl-head">
        <h3 id={headId} className="mx-tl-title">{ctx.li(TEXT.eventActions)}</h3>
        <span className="mx-tl-badges">
          <Badge tone="info">{ctx.li(EVENT_TYPE_TEXT[event.eventType])}</Badge>
          {event.outcome ? <Badge tone={OUTCOME_TONE[event.outcome]}>{ctx.fill(TEXT.resultLine, { outcome: ctx.li(OUTCOME_TEXT[event.outcome]) })}</Badge> : null}
        </span>
      </div>
      {internal ? (
        <>
          <p className="mx-tl-text">{ctx.li(TEXT.internalNote)}</p>
          <div className="mx-tl-actions">
            <Button onClick={() => ctx.go('internal-audit', { ms })}>{ctx.li(TEXT.openInternal)}</Button>
          </div>
        </>
      ) : manage ? (
        <>
          {!happened ? <p className="mx-tl-text">{ctx.li(TEXT.resultLater)}</p> : null}
          <div className="mx-tl-actions">
            <Button onClick={() => openForm({ type: 'edit', ms, event })}>{ctx.li(TEXT.edit)}</Button>
            {happened ? <Button onClick={() => openForm({ type: 'result', ms, event })}>{ctx.li(TEXT.recordResult)}</Button> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** The certification cycle with its certificate, expiry date and the moves of the cycle. */
export function CyclePanel({ ctx, ms, cycle, cycles, inCycle }: { ctx: HostContext; ms: MsId; cycle: CycleModel | null; cycles: readonly CycleModel[]; inCycle: boolean }) {
  const headId = useId();
  const today = todayOf(ctx);
  const canStart = mayManageEvents(ctx, ms) && !activeCycle(cycles);
  const canMove = mayMoveCycle(ctx, ms);
  if (!cycle) {
    return (
      <section className="mx-tl-box" aria-labelledby={headId} data-tl-cycle="none">
        <h3 id={headId} className="mx-tl-title">{ctx.li(TEXT.panelTitle)}</h3>
        <p className="mx-tl-text">{ctx.li(inCycle ? TEXT.noCycleHint : TEXT.noCycle)}</p>
        {canStart ? (
          <div className="mx-tl-actions">
            <Button variant="primary" onClick={() => openForm({ type: 'start', ms })}>{ctx.li(TEXT.startCycle)}</Button>
          </div>
        ) : null}
      </section>
    );
  }
  const soon = expiringSoon(cycle, today);
  const basis = recommendation(cycle);
  const moves = canMove ? movesOf(cycle.status) : [];
  const showItems = cycle.items.total > 0;
  // "Start certification cycle" while no cycle is active (D.4, as the page action of API builds): a planned cycle
  // starts, and after a cycle ended (withdrawn, closed, expired) or for the cycle after a certified one a new cycle
  // starts. A suspended certificate waits for the certification body to reinstate or withdraw it.
  const startHere = canStart && cycle.status !== 'suspended';
  const startMain = cycle.status !== 'certified';
  return (
    <section className="mx-tl-box" aria-labelledby={headId} data-tl-cycle={cycle.status}>
      <div className="mx-tl-head">
        <div style={{ minWidth: 0 }}>
          <h3 id={headId} className="mx-tl-title">{ctx.li(TEXT.panelTitle)}</h3>
          <span className="mx-tl-sub">{ctx.fill(TEXT.to, { from: fmtDate(ctx, cycle.cycleStart), to: fmtDate(ctx, cycle.cycleEnd) })}</span>
        </div>
        <Badge tone={CYCLE_STATUS_TONE[cycle.status]}>{ctx.li(CYCLE_STATUS_TEXT[cycle.status])}</Badge>
      </div>
      <Facts items={[
        { label: TEXT.fCertificate, value: cycle.certificateNo ?? ctx.li(TEXT.notRecorded), mono: Boolean(cycle.certificateNo) },
        ...(cycle.certifiedAt ? [{ label: TEXT.fIssued, value: fmtDate(ctx, cycle.certifiedAt) }] : []),
        ...(cycle.certificateExpiresAt ? [{ label: TEXT.fExpires, value: <span data-tl-expires="">{expiryText(ctx, cycle.certificateExpiresAt, today)}</span> }] : []),
        ...(cycle.certificationBody ? [{ label: TEXT.fBody, value: cycle.certificationBody }] : []),
        ...(cycle.certifiedScope ? [{ label: TEXT.fScope, value: cycle.certifiedScope }] : []),
        ...(showItems ? [{ label: TEXT.fItems, value: ctx.fill(TEXT.itemsOf, { done: cycle.items.done, total: cycle.items.total }) }] : []),
      ]} />
      {soon !== null ? <Alert tone="warn">{ctx.fill(TEXT.expiringSoon, { n: soon })}</Alert> : null}
      {cycle.status === 'suspended' ? <Alert tone="warn">{ctx.li(TEXT.suspendedNote)}</Alert> : null}
      {cycle.status === 'planned' ? <p className="mx-tl-text">{ctx.li(TEXT.plannedNote)}</p> : null}
      {cycle.status === 'active' && !basis ? <p className="mx-tl-text">{ctx.li(TEXT.activeNote)}</p> : null}
      {startHere || (cycle.status === 'active' && canMove) || moves.length ? (
        <div className="mx-tl-actions">
          {startHere ? <Button variant={startMain ? 'primary' : 'default'} onClick={() => openForm({ type: 'start', ms })}>{ctx.li(TEXT.startCycle)}</Button> : null}
          {cycle.status === 'active' && canMove ? (
            <Button variant="primary" disabledReason={basis ? null : TEXT.certNeedsResult} onClick={() => openForm({ type: 'certificate', ms })}>{ctx.li(TEXT.recordCertificate)}</Button>
          ) : null}
          {moves.map((to) => (
            <Button key={to} onClick={() => openForm({ type: 'move', ms, cycle, to })}>{ctx.li(MOVE_TEXT[to].action)}</Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** "Clause 4.3, auditee Rina Kusuma, auditor Maya Putri, 10 Feb 2027": the parts an activity has. */
export function activityLine(ctx: Pick<HostContext, 'D' | 'lang' | 'fill' | 'li'>, a: ActivityModel): string {
  const code = a.targetCode ?? a.clauseRef;
  const parts = [
    code ? ctx.fill(TEXT.activityClause, { code }) : null,
    a.auditee ? ctx.fill(TEXT.activityAuditee, { name: personName(ctx.D, a.auditee) }) : null,
    a.auditor ? ctx.fill(TEXT.activityAuditor, { name: personName(ctx.D, a.auditor) }) : null,
    a.scheduledAt ? fmtDate(ctx, a.scheduledAt) : null,
  ].filter((p): p is string => Boolean(p));
  if (!a.auditee && !a.auditor) parts.splice(code ? 1 : 0, 0, ctx.li(TEXT.activityNoOne));
  return parts.join(', ');
}

/** The audit activities of a certification audit with "Generate activities" and "Edit activity". */
function Activities({ ctx, ms, event, adapter }: { ctx: HostContext; ms: MsId; event: EventModel; adapter: TimelineAdapter }) {
  const headId = useId();
  const org = orgKeyOf(ctx);
  useEffect(() => {
    void loadActivities(ctx, adapter, ms, event);
  }, [ms, org, event.id]);
  const entry = activitiesEntry(ctx, ms, event.id);
  const manage = mayManageEvents(ctx, ms);
  const generate = () => {
    ctx.track(adapter.generate(ms, event)).then((res) => {
      if (!res.ok) {
        ctx.toast(ctx.li(res.error.message));
        return;
      }
      const none = !res.data.count && !(entry?.data?.length);
      ctx.toast(none ? ctx.li(TEXT.noTemplates) : outcomeText(ctx, res.data, ctx.fill(TEXT.generated, { n: res.data.count ?? 0 })));
      void loadActivities(ctx, adapter, ms, event, true);
    }, () => ctx.toast(ctx.li(TEXT.loadFailed)));
  };
  const list: ActivityModel[] = entry?.data ?? [];
  return (
    <section className="mx-tl-box" aria-labelledby={headId} data-tl-activities={event.id}>
      <div className="mx-tl-head">
        <div style={{ minWidth: 0 }}>
          <h3 id={headId} className="mx-tl-title">{ctx.li(TEXT.activitiesTitle)}</h3>
          <span className="mx-tl-sub">{ctx.li(TEXT.activitiesSub)}</span>
        </div>
        {manage ? <Button onClick={generate}>{ctx.li(TEXT.generate)}</Button> : null}
      </div>
      {!entry || (entry.loading && !entry.data) ? <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div> : null}
      {entry && entry.error && !entry.data ? (
        <Alert tone="bad" title={TEXT.activitiesFailed}>
          <Button variant="link" onClick={() => void loadActivities(ctx, adapter, ms, event, true)}>{ctx.li(TEXT.tryAgain)}</Button>
        </Alert>
      ) : null}
      {entry?.data && !list.length ? <p className="mx-tl-text">{ctx.li(TEXT.noActivities)}</p> : null}
      {list.length ? (
        <div className="mx-tl-list" role="list">
          {list.map((a) => (
            <div key={a.id} className="mx-tl-row" role="listitem" data-activity={a.code}>
              <span style={{ minWidth: 0 }}>
                <span className="mx-tl-row-title"><span className="mx-tl-code">{a.code}</span>{a.title}</span>
                <span className="mx-tl-row-meta">{activityLine(ctx, a)}</span>
              </span>
              <span className="mx-tl-row-side">
                <Badge tone={ACTIVITY_STATUS_TONE[a.status]}>{ctx.li(ACTIVITY_STATUS_TEXT[a.status])}</Badge>
                {manage ? <button type="button" className="mx-tl-link" onClick={() => openForm({ type: 'activity', ms, event, activity: a })}>{ctx.li(TEXT.editActivity)}</button> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
