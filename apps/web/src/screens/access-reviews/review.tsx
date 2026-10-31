// One access review on Access reviews (MILESTONE-3 M3-07, D.9), for the Tenant Admins: its facts and progress,
// "Complete" (disabled with what still waits), "Download report" and "Cancel review"; the status of each system part
// (a system nobody may review now is named, so the Tenant Admin assigns a reviewer or cancels the review);
// the revocations and changes to apply, with "Apply", "Mark as applied" and "Not applied" (a guest auditor grant is
// revoked by a Management System Manager on the system's page); and the organisation items with filters, a decision
// per item or for a selection, the session's own access (decided by another Tenant Admin) and the items that need a
// second reviewer.
import { useEffect, useState } from 'react';
import { formatInstant, saveFile } from '../auditor-access/shared';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Facts, Field, Meter, Modal, Select, Table, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import { adapterFor } from './adapter';
import type { ApplyBody, ItemKind, ItemRow, PartRow, ReviewDetail } from './model';
import {
  KIND_TEXT, ORG_KINDS, PART_STATUS_TEXT, PART_STATUS_TONE, STATUS_TEXT, STATUS_TONE, completionBlocks, formatDay, mayApplyOrg, noReviewerParts, noteError,
  settled,
} from './model';
import { AccessCell, ApplyNoteDialog, DecisionCell, DecisionDialog, ItemsTable, LoadState, PersonAt, PersonCell, Warnings, errorText, outcomeText, useLoad } from './parts';
import { noteAccessReviewsChanged } from './store';
import { TEXT } from './text';

type DecisionFilter = '' | 'undecided' | 'decided';

function CancelDialog({ ctx, review, onClose, onDone }: { ctx: HostContext; review: ReviewDetail; onClose(): void; onDone(): void }) {
  const adapter = adapterFor(ctx);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<TextPair | string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = () => {
    const found = noteError(reason);
    if (found) {
      setError(found);
      return;
    }
    setBusy(true);
    void ctx.track(settled(adapter.cancel(review.id, reason.trim()))).then((res) => {
      setBusy(false);
      if (!res.ok) setError(errorText(ctx, res.error));
      else {
        ctx.toast(outcomeText(ctx, res.data, ctx.li(TEXT.cancelled)));
        onDone();
      }
    });
  };
  return (
    <Modal
      open
      title={ctx.fill(TEXT.cancelTitle, { no: review.reviewNo })}
      sub={TEXT.cancelSub}
      onClose={onClose}
      layer={ctx.layer()}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="danger" busy={busy} onClick={submit}>{ctx.li(TEXT.cancelReview)}</Button>
        </>
      )}
    >
      <Field label={TEXT.fReason} error={typeof error === 'string' ? null : error} required>
        <Textarea name="reason" rows={3} maxLength={500} value={reason} onChange={(v) => { setReason(v); setError(null); }} />
      </Field>
      {typeof error === 'string' ? <div className="mx-error" role="alert">{error}</div> : null}
    </Modal>
  );
}

/** The parts of the systems: status, items decided, sign-off and the evidence item. */
function PartsCard({ ctx, review }: { ctx: HostContext; review: ReviewDetail }) {
  const columns: Column<PartRow>[] = [
    { key: 'ms', label: TEXT.colSystem, render: (p) => <strong>{(p.ms ?? '').toUpperCase()}</strong> },
    {
      key: 'status', label: TEXT.colStatus,
      render: (p) => (
        <span style={{ display: 'block' }}>
          <Badge tone={PART_STATUS_TONE[p.status]}>{ctx.li(PART_STATUS_TEXT[p.status])}</Badge>
          {p.noReviewer ? <> <Badge tone="bad">{ctx.li(TEXT.noReviewerBadge)}</Badge></> : null}
        </span>
      ),
    },
    {
      key: 'decided', label: TEXT.colDecided,
      render: (p) => (
        <span style={{ display: 'block' }}>
          {ctx.fill(TEXT.decidedOf, { n: p.decided, total: p.items })}
          {p.needsSecondReviewer ? <span className="mx-small" style={{ display: 'block' }}>{ctx.fill(TEXT.secondCount, { n: p.needsSecondReviewer })}</span> : null}
        </span>
      ),
    },
    { key: 'signed', label: TEXT.colSignedOff, render: (p) => <PersonAt ctx={ctx} who={p.signedOffBy} at={p.signedOffAt} /> },
    {
      key: 'evidence', label: TEXT.colEvidence,
      render: (p) => (p.evidenceCode
        ? (
          <span style={{ display: 'block' }}>
            <span className="mx-mono">{p.evidenceCode}</span>
            <span className="mx-small" style={{ display: 'block' }}>{p.evidenceFiledAt ? ctx.fill(TEXT.filedAt, { at: formatInstant(p.evidenceFiledAt, ctx.lang) }) : ctx.li(TEXT.filedOnCompletion)}</span>
          </span>
        )
        : <span className="mx-muted">{ctx.li(TEXT.noEvidence)}</span>),
    },
  ];
  return (
    <Card title={TEXT.partsTitle} sub={TEXT.partsSub} flush>
      <Table columns={columns} rows={review.parts} rowKey={(p) => p.id} empty={<div className="mx-small" style={{ padding: 12 }}>{ctx.li(TEXT.noSystems)}</div>} />
    </Card>
  );
}

/** The decided revocations and changes still to apply or explain. */
function ApplicationsCard({ ctx, review }: { ctx: HostContext; review: ReviewDetail }) {
  const adapter = adapterFor(ctx);
  const canApply = mayApplyOrg(ctx) && review.status === 'open';
  const [noteFor, setNoteFor] = useState<{ row: ItemRow; kind: 'not_applied' | 'mark_applied' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const run = (row: ItemRow, body: ApplyBody) => adapter.apply(review.id, row.id, body);
  const apply = (row: ItemRow) => {
    setBusy(row.id);
    setFailure(null);
    void ctx.track(settled(run(row, { action: 'apply' }))).then((res) => {
      setBusy(null);
      if (!res.ok) {
        setFailure(errorText(ctx, res.error));
        return;
      }
      ctx.toast(outcomeText(ctx, res.data, ctx.li(TEXT.applied)));
      if (res.data.changed.length) ctx.reload(res.data.changed).catch(() => undefined);
      noteAccessReviewsChanged();
    });
  };
  const columns: Column<ItemRow>[] = [
    { key: 'person', label: TEXT.colPerson, render: (r) => <PersonCell ctx={ctx} row={r} /> },
    { key: 'access', label: TEXT.colAccess, render: (r) => <AccessCell ctx={ctx} row={r} /> },
    { key: 'decision', label: TEXT.colDecision, render: (r) => <DecisionCell ctx={ctx} row={r} /> },
    {
      key: 'actions', label: TEXT.colActions,
      render: (r) => {
        if (r.kind === 'auditor_access') return <span className="mx-small">{ctx.fill(TEXT.guestOnSystemShort, { ms: (r.ms ?? '').toUpperCase() })}</span>;
        if (!canApply) return <span className="mx-small">{ctx.li(TEXT.applyNeedsRight)}</span>;
        return (
          <span className="mx-btn-group">
            {r.decision === 'revoke' ? <Button variant="primary" busy={busy === r.id} disabled={busy !== null} onClick={() => apply(r)}>{ctx.li(TEXT.apply)}</Button> : null}
            <Button onClick={() => setNoteFor({ row: r, kind: 'mark_applied' })}>{ctx.li(TEXT.markApplied)}</Button>
            <Button variant="link" onClick={() => setNoteFor({ row: r, kind: 'not_applied' })}>{ctx.li(TEXT.notApplied)}</Button>
          </span>
        );
      },
    },
  ];
  return (
    <Card title={TEXT.applyTitle} sub={TEXT.applySub} flush>
      {failure ? <div style={{ padding: 12 }}><Alert tone="bad">{failure}</Alert></div> : null}
      <Table
        columns={columns}
        rows={review.pendingApplications}
        rowKey={(r) => r.id}
        empty={<div className="mx-small" style={{ padding: 12 }}>{ctx.li(TEXT.nothingToApplyNow)}</div>}
      />
      {noteFor ? (
        <ApplyNoteDialog
          ctx={ctx}
          row={noteFor.row}
          kind={noteFor.kind}
          run={(body) => run(noteFor.row, body)}
          onClose={() => setNoteFor(null)}
          onDone={(outcome) => {
            ctx.toast(outcomeText(ctx, outcome, ctx.li(TEXT.applied)));
            setNoteFor(null);
            noteAccessReviewsChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

/** The organisation items: filters, selection and the decision form. */
function OrganisationCard({ ctx, review }: { ctx: HostContext; review: ReviewDetail }) {
  const adapter = adapterFor(ctx);
  const open = review.status === 'open';
  const [kind, setKind] = useState<ItemKind | ''>('');
  const [decided, setDecided] = useState<DecisionFilter>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deciding, setDeciding] = useState<ItemRow[] | null>(null);
  useEffect(() => setSelected(new Set()), [review.id, kind, decided]);
  const decidable = (r: ItemRow) => open && !r.ownAccess && r.appliedAt === null && r.notAppliedReason === null;
  const rows = review.organisationPart.rows.filter((r) => (!kind || r.kind === kind) && (decided === '' || (decided === 'undecided' ? r.decision === null : r.decision !== null)));
  const chosen = rows.filter((r) => selected.has(r.id));
  const toggle = (id: string, on: boolean) => setSelected((s) => {
    const next = new Set(s);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  const decidableRows = rows.filter(decidable);
  const allOn = decidableRows.length > 0 && decidableRows.every((r) => selected.has(r.id));
  const part = review.organisationPart;
  return (
    <Card
      title={TEXT.orgTitle}
      sub={ctx.fill(TEXT.orgSub, { n: part.decided, total: part.items })}
      flush
      actions={open ? (
        <Button variant="primary" disabledReason={chosen.length ? null : TEXT.selectFirst} onClick={() => setDeciding(chosen)}>
          {chosen.length ? ctx.fill(TEXT.decideSelected, { n: chosen.length }) : ctx.li(TEXT.decide)}
        </Button>
      ) : null}
    >
      <div className="mx-row" style={{ padding: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 200 }}>
          <Field label={TEXT.filterKind}>
            <Select name="kind" value={kind} onChange={(v) => setKind(v as ItemKind | '')} empty={TEXT.allKinds} options={ORG_KINDS.map((k) => ({ value: k, label: KIND_TEXT[k] }))} />
          </Field>
        </div>
        <div style={{ minWidth: 200 }}>
          <Field label={TEXT.filterDecision}>
            <Select name="decided" value={decided} onChange={(v) => setDecided(v as DecisionFilter)} empty={TEXT.allItems} options={[{ value: 'undecided', label: TEXT.undecidedOnly }, { value: 'decided', label: TEXT.decidedOnly }]} />
          </Field>
        </div>
        {open && decidableRows.length > 0 ? (
          <Checkbox name="select-all" checked={allOn} onChange={(on) => setSelected(on ? new Set(decidableRows.map((r) => r.id)) : new Set())} label={TEXT.selectAll} />
        ) : null}
      </div>
      <ItemsTable
        ctx={ctx}
        rows={rows}
        selection={open ? { selected, toggle, can: decidable } : undefined}
        actions={open ? (r) => (decidable(r) ? <Button variant="link" onClick={() => setDeciding([r])}>{ctx.li(r.decision ? TEXT.changeDecision : TEXT.decide)}</Button> : null) : undefined}
        empty={<EmptyState title={TEXT.noItems} text={decided === 'undecided' ? TEXT.allDecidedText : TEXT.noItemsText} illustration={<Illustration scene="all-done" size="sm" decorative />} />}
      />
      {deciding && deciding.length ? (
        <DecisionDialog
          ctx={ctx}
          rows={deciding}
          run={(row, body) => adapter.decide(review.id, row.id, body)}
          onClose={() => setDeciding(null)}
          onDone={(n) => {
            if (n > 0) {
              ctx.toast(ctx.fill(TEXT.decided, { n }));
              setDeciding(null);
              setSelected(new Set());
            }
            noteAccessReviewsChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

export function ReviewPage({ ctx, id, onBack }: { ctx: HostContext; id: string; onBack(): void }) {
  const adapter = adapterFor(ctx);
  const loaded = useLoad(() => adapter.get(id), [id]);
  const [cancelling, setCancelling] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const review = loaded.data;
  const blocks = review ? completionBlocks(review, ctx.li, ctx.fill) : [];
  const unreviewable = review ? noReviewerParts(review) : [];
  const complete = () => {
    if (!review) return;
    setCompleting(true);
    setFailure(null);
    void ctx.track(settled(adapter.complete(review.id))).then((res) => {
      setCompleting(false);
      if (!res.ok) {
        setFailure(errorText(ctx, res.error));
        return;
      }
      ctx.toast(outcomeText(ctx, res.data, ctx.li(TEXT.completed)));
      if (res.data.changed.length) ctx.reload(res.data.changed).catch(() => undefined);
      noteAccessReviewsChanged();
    });
  };
  const download = () => {
    if (!review) return;
    void settled(adapter.report(review)).then((res) => {
      if (res.ok) saveFile(res.data);
      else setFailure(errorText(ctx, res.error));
    });
  };
  return (
    <div className="mx-stack" data-review={id}>
      <div>
        <Button variant="link" onClick={onBack}>{ctx.li(TEXT.backToReviews)}</Button>
      </div>
      <LoadState ctx={ctx} list={loaded} />
      {review ? (
        <>
          <Card
            title={ctx.fill(TEXT.reviewTitle, { no: review.reviewNo })}
            sub={TEXT.reviewSub}
            actions={(
              <>
                <Button onClick={download}>{ctx.li(TEXT.downloadReport)}</Button>
                {review.status === 'open' ? <Button variant="link" onClick={() => setCancelling(true)}>{ctx.li(TEXT.cancelReview)}</Button> : null}
                {review.status === 'open' ? (
                  <Button variant="primary" busy={completing} disabledReason={blocks.length ? TEXT.completeWaits : null} onClick={complete}>{ctx.li(TEXT.complete)}</Button>
                ) : null}
              </>
            )}
          >
            {failure ? <Alert tone="bad">{failure}</Alert> : null}
            <Facts
              items={[
                { label: TEXT.colStatus, value: <Badge tone={STATUS_TONE[review.status]}>{ctx.li(STATUS_TEXT[review.status])}</Badge> },
                { label: TEXT.colOpened, value: `${formatDay(review.openedOn, ctx.lang)} (${review.openedBy ? review.openedBy.displayName : ctx.li(TEXT.bySchedule)})` },
                { label: TEXT.colDue, value: formatDay(review.dueOn, ctx.lang) },
                {
                  label: TEXT.colProgress,
                  value: (
                    <span style={{ display: 'block' }}>
                      <Meter used={review.progress.decided} limit={Math.max(1, review.progress.items)} />
                      <span className="mx-small" style={{ display: 'block' }}>{ctx.fill(TEXT.progressText, { decided: review.progress.decided, items: review.progress.items, signed: review.progress.signedOff, parts: review.progress.parts, applied: review.progress.applied, revocations: review.progress.revocations })}</span>
                    </span>
                  ),
                },
                ...(review.completedAt ? [{ label: TEXT.colCompleted, value: `${formatInstant(review.completedAt, ctx.lang)} (${review.completedBy?.displayName ?? '-'})` }] : []),
                ...(review.cancelReason ? [{ label: TEXT.cancelReason, value: review.cancelReason }] : []),
              ]}
            />
            {review.status === 'open' && blocks.length ? (
              <div className="mx-small" style={{ marginTop: 8 }} data-complete-waits="">
                {blocks.map((b) => <span key={b} style={{ display: 'block' }}>{b}</span>)}
              </div>
            ) : null}
          </Card>
          {unreviewable.length ? (
            <Alert tone="bad" title={TEXT.noReviewerTitle}>
              {ctx.fill(TEXT.noReviewerText, { systems: unreviewable.map((p) => (p.ms ?? '').toUpperCase()).join(', ') })}
            </Alert>
          ) : null}
          <Warnings ctx={ctx} warnings={review.warnings} />
          <PartsCard ctx={ctx} review={review} />
          {review.status === 'open' ? <ApplicationsCard ctx={ctx} review={review} /> : null}
          <OrganisationCard ctx={ctx} review={review} />
          {cancelling ? (
            <CancelDialog
              ctx={ctx}
              review={review}
              onClose={() => setCancelling(false)}
              onDone={() => {
                setCancelling(false);
                noteAccessReviewsChanged();
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
