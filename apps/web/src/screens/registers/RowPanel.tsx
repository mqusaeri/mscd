// The drawer of a register row (MILESTONE-2 M2-13): its facts by kind, "Edit", the linked systems with "Link to
// another system", "Make primary" and "Remove link" (integrated mode), "Record value" of a metric, the proof file of a
// competence record, and for a risk its treatments with the C.13 moves, "Add treatment" and "Accept residual risk".
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import type { HostContext, TextPair } from '../types';
import { Badge, Button, ConfirmDialog, Drawer, Facts, UI_TEXT } from '../ui';
import { settled } from './adapter';
import { LinkDialog, ResidualDialog, TreatmentDialog, ValueDialog } from './Forms';
import {
  KIND_DEFS, acceptBlock, acceptCandidates, canChangeLinks, canManageTreatments, canMove, canRecordValue, editScope, formatDate, linkTargets,
  linkedAfter, moveBlock, moveLabel, movesFrom, personName, scoreOf, scoreTone, systemName, validityOf, valueLabel,
} from './model';
import type { MoveTarget, Outcome, RegisterKind, RegistersAdapter, RowModel, TreatmentModel } from './model';
import { ErrorAlert, Warnings, problemText } from './parts';
import { KIND_TEXT, TEXT, VALUE_TEXT } from './text';

/** The facts of a row in the drawer, by kind. */
export function factsOf(ctx: HostContext, kind: RegisterKind, row: RowModel): { label: TextPair; value: ReactNode; mono?: boolean }[] {
  const d = (v: string | null | undefined) => formatDate(ctx, v);
  const t = (v: unknown) => (v === null || v === undefined || v === '' ? ctx.li(TEXT.noValue) : String(v));
  const v = (field: Parameters<typeof valueLabel>[0], value: unknown) => ctx.li(valueLabel(field, value));
  const owner = { label: TEXT.colOwner, value: personName(ctx, row.owner) };
  const status = row.status ? [{ label: TEXT.colStatus, value: <Badge tone={row.status === 'open' ? 'warn' : 'ok'}>{ctx.li(row.status === 'open' ? TEXT.stateOpen : TEXT.stateReady)}</Badge> }] : [];
  switch (kind) {
    case 'context-issues':
      return [{ label: TEXT.colId, value: row.code, mono: true }, { label: TEXT.fIssueType, value: v('issueType', row.issueType) }, owner, ...status, { label: TEXT.fDescription, value: t(row.description) }, { label: TEXT.fLastReviewed, value: d(row.lastReviewedAt) }];
    case 'interested-parties':
      return [{ label: TEXT.colId, value: row.code, mono: true }, owner, { label: TEXT.fRequirements, value: t(row.requirements) }, { label: TEXT.fLastReviewed, value: d(row.lastReviewedAt) }];
    case 'assets':
      return [{ label: TEXT.colId, value: row.code, mono: true }, owner, { label: TEXT.fAssetType, value: t(row.assetType) }, { label: TEXT.fClassification, value: v('classification', row.classification) }];
    case 'risks': {
      const inherent = scoreOf(row.likelihood, row.consequence);
      const residual = scoreOf(row.residualLikelihood, row.residualConsequence);
      const score = (s: number | null, l: unknown, c: unknown) => (s === null ? ctx.li(TEXT.noValue) : <Badge tone={scoreTone(s)}>{ctx.fill(TEXT.scoreOf, { score: s, l: String(l), c: String(c) })}</Badge>);
      const profile = row.riskProfileCode ? ctx.li((VALUE_TEXT.profile as Record<string, TextPair>)[row.riskProfileCode] ?? row.riskProfileCode) : ctx.li(TEXT.noValue);
      return [
        { label: TEXT.colId, value: row.code, mono: true }, owner, ...status, { label: TEXT.fProfile, value: profile },
        ...(row.isOpportunity ? [{ label: TEXT.colType, value: ctx.li(TEXT.opportunity) }] : []),
        { label: TEXT.fDescription, value: t(row.description) },
        { label: TEXT.colInherent, value: score(inherent, row.likelihood, row.consequence) },
        { label: TEXT.colResidual, value: score(residual, row.residualLikelihood, row.residualConsequence) },
        { label: TEXT.fTreatmentOption, value: v('treatmentOption', row.treatmentOption) },
        { label: TEXT.fAssessedAt, value: d(row.assessedAt) }, { label: TEXT.fNextReview, value: d(row.nextReviewAt) },
      ];
    }
    case 'metrics':
      return [
        { label: TEXT.colId, value: row.code, mono: true }, owner, ...status,
        { label: TEXT.fTargetValue, value: row.targetValue === null || row.targetValue === undefined ? ctx.li(TEXT.noValue) : `${row.targetValue}${row.unit ? ` ${row.unit}` : ''}` },
        { label: TEXT.fFrequency, value: row.frequencyCode ? (ctx.D?.FREQ?.[row.frequencyCode as never] ? ctx.li([ctx.D.FREQ[row.frequencyCode as never][0], ctx.D.FREQ[row.frequencyCode as never][1]]) : row.frequencyCode) : ctx.li(TEXT.noValue) },
        { label: TEXT.fLastMeasured, value: d(row.lastMeasuredAt) },
      ];
    case 'objectives':
      return [
        { label: TEXT.colId, value: row.code, mono: true }, owner, ...status, { label: TEXT.fStatement, value: t(row.statement) }, { label: TEXT.fTargetText, value: t(row.targetText) },
        { label: TEXT.fMetric, value: t(row.metricCode) }, { label: TEXT.fDueAt, value: d(row.dueAt) }, { label: TEXT.fResources, value: t(row.resources) },
        { label: TEXT.fEvaluation, value: t(row.evaluationMethod) }, { label: TEXT.fObjectiveStatus, value: v('objectiveStatus', row.objectiveStatus) },
        { label: TEXT.fResult, value: t(row.result) }, { label: TEXT.fAchievedAt, value: d(row.achievedAt) },
      ];
    case 'competence': {
      const validity = validityOf(row.validUntil, ctx.D?.today ?? ctx.D?.TODAY_S);
      return [
        { label: TEXT.colId, value: row.code, mono: true }, { label: TEXT.fPerson, value: personName(ctx, row.personHandle) }, { label: TEXT.roleField, value: row.title }, owner, ...status,
        { label: TEXT.fCompetence, value: t(row.competenceRequired) }, { label: TEXT.fProofType, value: v('proofType', row.proofType) },
        { label: TEXT.fProofFile, value: row.proofObjectId ? (row.proofName ?? ctx.li(TEXT.proofStored)) : ctx.li(TEXT.proofNone) },
        { label: TEXT.fAchievedAt, value: d(row.achievedAt) },
        { label: TEXT.fValidUntil, value: <>{d(row.validUntil)} {validity ? <Badge tone={validity === 'expired' ? 'bad' : 'warn'}>{ctx.li(validity === 'expired' ? TEXT.expired : TEXT.renewSoon)}</Badge> : null}</> },
        { label: TEXT.fVerifiedBy, value: row.verifiedByHandle ? personName(ctx, row.verifiedByHandle) : ctx.li(TEXT.noValue) },
      ];
    }
    default:
      return [];
  }
}

type Dialog =
  | { kind: 'value' }
  | { kind: 'treatment' }
  | { kind: 'residual' }
  | { kind: 'link' }
  | { kind: 'primary' | 'remove'; ms: MsId };

export interface RowPanelProps {
  ctx: HostContext;
  adapter: RegistersAdapter;
  ms: MsId;
  kind: RegisterKind;
  row: RowModel;
  onClose(): void;
  onEdit(): void;
  /** A write went through: the screen reloads its list and the systems the write changed. */
  onChanged(outcome: Outcome, message: string | null): void;
}

export function RowPanel({ ctx, adapter, ms, kind, row, onClose, onEdit, onChanged }: RowPanelProps) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [warnings, setWarnings] = useState<TextPair[]>([]);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<ApiError | null>(null);
  const [proofError, setProofError] = useState<ApiError | null>(null);
  const def = KIND_DEFS[kind];
  const scope = editScope(ctx, ms, kind, row);
  const targets = def.shared ? linkTargets(ctx, row) : [];
  const changeLinks = def.shared && canChangeLinks(ctx, ms, kind);
  const done = (outcome: Outcome, message: string | null) => {
    setDialog(null);
    setWarnings(outcome.warnings);
    onChanged(outcome, message);
  };
  const changeLink = (change: 'primary' | 'remove', system: MsId) => {
    setLinkBusy(true);
    setLinkError(null);
    void settled(adapter.update(ms, kind, row, { linkedMs: linkedAfter(row, system, change), confirm: true })).then((res) => {
      setLinkBusy(false);
      if (!res.ok) {
        setLinkError(res.error);
        setDialog(null);
        return;
      }
      const name = systemName(ctx, system);
      done(res.data, ctx.fill(change === 'primary' ? TEXT.primaryDone : TEXT.removeDone, { system: name, code: row.code }));
    });
  };
  const openProof = () => {
    setProofError(null);
    void settled(adapter.openProof(ms, row)).then((res) => {
      if (!res.ok) setProofError(res.error);
      else if (res.data && typeof window !== 'undefined') window.open(res.data, '_blank', 'noopener');
    });
  };
  const primary = row.ms[0];
  return (
    <>
      <Drawer
        open
        title={`${row.code}  ${row.title}`}
        crumb={KIND_TEXT[kind].one}
        onClose={onClose}
        footer={(
          <div className="mx-reg-foot-actions">
            <Button onClick={onClose}>{ctx.li(TEXT.close)}</Button>
            {scope ? <Button variant="primary" onClick={onEdit}>{ctx.li(TEXT.edit)}</Button> : null}
          </div>
        )}
      >
        {row.shared ? <div><Badge tone="info">{ctx.fill(TEXT.shared, { n: row.ms.length })}</Badge></div> : null}
        <Warnings ctx={ctx} warnings={warnings} />
        <Facts items={factsOf(ctx, kind, row)} />
        {kind === 'metrics' && canRecordValue(ctx, ms, row) ? (
          <div><Button variant="primary" onClick={() => setDialog({ kind: 'value' })}>{ctx.li(TEXT.recordValue)}</Button></div>
        ) : null}
        {kind === 'competence' && row.proofObjectId && !adapter.sample ? (
          <div className="mx-stack" style={{ gap: 8 }}>
            <div><Button onClick={openProof}>{ctx.li(TEXT.openProof)}</Button></div>
            <ErrorAlert ctx={ctx} error={proofError} />
          </div>
        ) : null}
        {kind === 'risks' ? <Treatments ctx={ctx} adapter={adapter} ms={ms} risk={row} onChanged={done} /> : null}
        {def.shared ? (
          <section className="mx-reg-section" aria-label={ctx.li(TEXT.linkedSystems)}>
            <h3 className="mx-reg-h">{ctx.li(TEXT.linkedSystems)}</h3>
            <div className="mx-small">{ctx.li(TEXT.linkedSystemsSub)}</div>
            <ul className="mx-reg-links">
              {row.ms.map((m) => (
                <li key={m}>
                  <span className="mx-reg-link-name">{systemName(ctx, m)}</span>
                  {m === primary ? <Badge tone="acc">{ctx.li(TEXT.primary)}</Badge> : null}
                  {m === ms ? <Badge tone="mute">{ctx.li(TEXT.thisSystem)}</Badge> : null}
                  {changeLinks && m !== primary ? (
                    <span className="mx-btn-group">
                      <Button onClick={() => setDialog({ kind: 'primary', ms: m })}>{ctx.li(TEXT.makePrimary)}</Button>
                      {m !== ms ? <Button variant="danger" onClick={() => setDialog({ kind: 'remove', ms: m })}>{ctx.li(TEXT.removeLink)}</Button> : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {targets.length ? (
              <div><Button onClick={() => setDialog({ kind: 'link' })}>{ctx.li(TEXT.linkOther)}</Button></div>
            ) : ctx.can(ms, 'entity_link.manage') && (ctx.D?.MS?.length ?? 0) > 1 ? <div className="mx-small">{ctx.li(TEXT.noOtherSystem)}</div> : null}
            <ErrorAlert ctx={ctx} error={linkError} />
          </section>
        ) : null}
      </Drawer>
      {dialog?.kind === 'value' ? (
        <ValueDialog ctx={ctx} adapter={adapter} ms={ms} row={row} onClose={() => setDialog(null)} onSaved={(o) => done(o, ctx.fill(TEXT.valueSaved, { code: row.code }))} />
      ) : null}
      {dialog?.kind === 'link' ? (
        <LinkDialog
          ctx={ctx}
          adapter={adapter}
          ms={ms}
          kind={kind}
          row={row}
          targets={targets}
          onClose={() => setDialog(null)}
          onSaved={(o, target) => done(o, ctx.fill(TEXT.linked, { code: row.code, system: systemName(ctx, target) }))}
        />
      ) : null}
      <ConfirmDialog
        open={dialog?.kind === 'primary' || dialog?.kind === 'remove'}
        title={dialog && 'ms' in dialog ? ctx.fill(dialog.kind === 'primary' ? TEXT.primaryTitle : TEXT.removeTitle, { system: systemName(ctx, dialog.ms) }) : TEXT.makePrimary}
        body={dialog && 'ms' in dialog ? ctx.fill(dialog.kind === 'primary' ? TEXT.primaryBody : TEXT.removeBody, { code: row.code, system: systemName(ctx, dialog.ms) }) : ''}
        confirmLabel={dialog?.kind === 'remove' ? TEXT.removeLink : TEXT.makePrimary}
        tone={dialog?.kind === 'remove' ? 'bad' : 'acc'}
        busy={linkBusy}
        onConfirm={() => dialog && 'ms' in dialog && changeLink(dialog.kind, dialog.ms)}
        onCancel={() => setDialog(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Treatments of a risk
// ---------------------------------------------------------------------------------------------------------------

const STATUS_TONE: Readonly<Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'mute' | 'acc'>> = {
  proposed: 'mute', approved: 'info', in_progress: 'info', delayed: 'bad', implemented: 'warn', residual_accepted: 'ok', closed: 'ok', open: 'info', done: 'mute',
};

function Treatments({ ctx, adapter, ms, risk, onChanged }: {
  ctx: HostContext;
  adapter: RegistersAdapter;
  ms: MsId;
  risk: RowModel;
  onChanged(outcome: Outcome, message: string | null): void;
}) {
  const [state, setState] = useState<{ list: TreatmentModel[] | null; error: ApiError | null }>({ list: null, error: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<ApiError | null>(null);
  const [dialog, setDialog] = useState<'add' | 'residual' | null>(null);
  const load = useCallback(() => {
    void settled(adapter.treatments(ms, risk)).then((res) => setState(res.ok ? { list: res.data, error: null } : { list: [], error: res.error }));
  }, [adapter, ms, risk]);
  useEffect(() => load(), [load]);
  const list = state.list ?? [];
  const candidates = acceptCandidates(list);
  const block = acceptBlock(ctx, ms, risk, candidates, null);
  const move = (t: TreatmentModel, to: MoveTarget) => {
    setBusy(`${t.id}:${to}`);
    setMoveError(null);
    void settled(adapter.moveTreatment(ms, risk, t, to)).then((res) => {
      setBusy(null);
      if (!res.ok) {
        setMoveError(res.error);
        return;
      }
      load();
      const label = ctx.li((VALUE_TEXT.treatmentStatus as Record<string, TextPair>)[to]);
      onChanged(res.data, ctx.fill(TEXT.moved, { code: t.code, status: label }));
    });
  };
  const after = (outcome: Outcome, message: string) => {
    setDialog(null);
    load();
    onChanged(outcome, message);
  };
  return (
    <section className="mx-reg-section" aria-label={ctx.li(TEXT.treatments)}>
      <h3 className="mx-reg-h">{ctx.li(TEXT.treatments)}</h3>
      <div className="mx-small">{ctx.li(TEXT.treatmentsSub)}</div>
      {risk.residualAcceptedAt ? <div><Badge tone="ok">{ctx.fill(TEXT.residualAccepted, { date: formatDate(ctx, risk.residualAcceptedAt) })}</Badge></div> : null}
      {state.list === null ? <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div> : null}
      <ErrorAlert ctx={ctx} error={state.error} title={TEXT.treatmentsFailed} />
      {state.list && !list.length && !state.error ? <div className="mx-small">{ctx.li(TEXT.noTreatments)}</div> : null}
      {list.length ? (
        <ul className="mx-reg-treatments">
          {list.map((t) => {
            const moves = movesFrom(t.status).filter((to) => canMove(ctx, ms, t, to));
            const statusLabel = (VALUE_TEXT.treatmentStatus as Record<string, TextPair>)[t.status];
            return (
              <li key={t.id} className="mx-reg-treatment" data-treatment={t.code}>
                <div className="mx-reg-treatment-head">
                  <span className="mx-mono" style={{ fontWeight: 600 }}>{t.code}</span>
                  <span className="mx-reg-wrap">{t.title}</span>
                  <Badge tone={STATUS_TONE[t.status] ?? 'mute'}>{ctx.li(statusLabel)}</Badge>
                </div>
                <div className="mx-small">
                  {ctx.li(TEXT.tOwner)}: {personName(ctx, t.owner)}
                  {t.due ? <>{', '}{ctx.li(TEXT.tDue)}: {formatDate(ctx, t.due)}</> : null}
                  {t.target ? <>{', '}{ctx.li(TEXT.tTarget)}: <span className="mx-mono">{t.target}</span></> : null}
                  {t.implementedBy ? <>{'. '}{ctx.fill(TEXT.tImplementedBy, { name: personName(ctx, t.implementedBy) })}</> : null}
                </div>
                {moves.length ? (
                  <div className="mx-btn-group">
                    {moves.map((to) => (
                      <Button
                        key={to}
                        busy={busy === `${t.id}:${to}`}
                        disabledReason={moveBlock(t, to)}
                        disabled={Boolean(busy)}
                        onClick={() => move(t, to)}
                      >
                        {ctx.li(moveLabel(t.status, to))}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {moveError ? <div className="mx-error" role="alert">{problemText(ctx, moveError)}</div> : null}
      <div className="mx-btn-group">
        {canManageTreatments(ctx, ms) ? <Button onClick={() => setDialog('add')}>{ctx.li(TEXT.addTreatment)}</Button> : null}
        {ctx.can(ms, 'risk.residual.accept') ? (
          <Button variant="primary" disabledReason={state.list === null ? null : block} disabled={state.list === null} onClick={() => setDialog('residual')}>
            {ctx.li(TEXT.acceptResidual)}
          </Button>
        ) : null}
      </div>
      {dialog === 'add' ? (
        <TreatmentDialog
          ctx={ctx}
          adapter={adapter}
          ms={ms}
          risk={risk}
          existing={list}
          onClose={() => setDialog(null)}
          onSaved={(o, code) => after(o, ctx.fill(TEXT.treatmentAdded, { code, risk: risk.code }))}
          onRiskChanged={(o) => onChanged(o, null)}
        />
      ) : null}
      {dialog === 'residual' ? (
        <ResidualDialog
          ctx={ctx}
          adapter={adapter}
          ms={ms}
          risk={risk}
          treatments={list}
          onClose={() => setDialog(null)}
          onSaved={(o) => after(o, ctx.fill(TEXT.residualDone, { code: risk.code }))}
        />
      ) : null}
    </section>
  );
}
