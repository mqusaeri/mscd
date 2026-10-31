// Access review of this system (MILESTONE-3 M3-07, C.2, D.9), for the Management System Managers and Programme Owners
// of the selected system (`access_review.decide`): the system's part of the open review (or of an earlier one), its
// items with filters, a decision per item or for a selection (never on one's own access), "Revoke guest access" for a
// guest auditor grant decided "revoke" (Management System Managers, `auditor_access.grant`), and "Sign off" with the
// evidence item that receives the system's rows when the review completes (for ISO/IEC 27001 the item of control
// A.5.18 is proposed).
import { useEffect, useState } from 'react';
import type { MsId } from '../../data/types';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Facts, Field, Modal, RecordPicker, Select, UI_TEXT } from '../ui';
import { Illustration } from '../../illustrations';
import { adapterFor } from '../access-reviews/adapter';
import type { ItemKind, ItemRow, PartDetail } from '../access-reviews/model';
import {
  KIND_TEXT, PART_STATUS_TEXT, PART_STATUS_TONE, STATUS_TEXT, SYSTEM_KINDS, formatDay, mayDecide, mayRevokeGuest, settled, signOffBlock,
} from '../access-reviews/model';
import { ApplyNoteDialog, DecisionDialog, ItemsTable, LoadState, PersonAt, errorText, outcomeText, useLoad } from '../access-reviews/parts';
import { noteAccessReviewsChanged } from '../access-reviews/store';
import { TEXT as SHARED } from '../access-reviews/text';
import { TEXT } from './text';

type DecisionFilter = '' | 'undecided' | 'decided';

/** "Sign off": the evidence item for the system's rows (the A.5.18 item proposed), or none. */
export function SignOffDialog({ ctx, ms, part, onClose, onDone }: { ctx: HostContext; ms: MsId; part: PartDetail; onClose(): void; onDone(): void }) {
  const adapter = adapterFor(ctx);
  const items = adapter.evidence(ms);
  const proposed = part.suggestedEvidence && items.some((e) => e.code === part.suggestedEvidence!.code) ? part.suggestedEvidence.code : '';
  const [code, setCode] = useState(proposed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    setBusy(true);
    setError(null);
    const evidenceId = code ? items.find((e) => e.code === code)?.id ?? null : null;
    void ctx.track(settled(adapter.signOff(ms, part.reviewId, evidenceId))).then((res) => {
      setBusy(false);
      if (!res.ok) {
        setError(errorText(ctx, res.error));
        return;
      }
      ctx.toast(outcomeText(ctx, res.data, ctx.li(TEXT.signedOff)));
      onDone();
    });
  };
  return (
    <Modal
      open
      title={ctx.fill(TEXT.signOffTitle, { ms: ms.toUpperCase(), no: part.reviewNo })}
      sub={TEXT.signOffSub}
      onClose={onClose}
      layer={ctx.layer()}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={busy} onClick={submit}>{ctx.li(TEXT.signOff)}</Button>
        </>
      )}
    >
      {error ? <Alert tone="bad">{error}</Alert> : null}
      {part.needsSecondReviewer ? <Alert tone="warn">{ctx.fill(TEXT.signOffSecond, { n: part.needsSecondReviewer })}</Alert> : null}
      {items.length ? (
        <Field label={TEXT.fEvidence} hint={part.suggestedEvidence ? ctx.fill(TEXT.fEvidenceProposed, { code: part.suggestedEvidence.code }) : TEXT.fEvidenceHint}>
          <RecordPicker value={code} onChange={setCode} records={items.map((e) => ({ id: e.code, title: e.title }))} limit={60} />
        </Field>
      ) : <Alert tone="info">{ctx.li(TEXT.noEvidenceItems)}</Alert>}
      {code ? (
        <div className="mx-row" style={{ alignItems: 'center' }}>
          <span className="mx-small">{ctx.fill(TEXT.evidenceChosen, { code })}</span>
          <Button variant="link" onClick={() => setCode('')}>{ctx.li(TEXT.chooseNone)}</Button>
        </div>
      ) : <p className="mx-small">{ctx.li(TEXT.noEvidenceChosen)}</p>}
    </Modal>
  );
}

export function PartPage({ ctx, ms, part }: { ctx: HostContext; ms: MsId; part: PartDetail }) {
  const adapter = adapterFor(ctx);
  const open = part.reviewStatus === 'open' && part.status === 'open';
  const canRevoke = mayRevokeGuest(ctx, ms) && part.reviewStatus === 'open';
  const [kind, setKind] = useState<ItemKind | ''>('');
  const [decided, setDecided] = useState<DecisionFilter>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deciding, setDeciding] = useState<ItemRow[] | null>(null);
  const [noteFor, setNoteFor] = useState<{ row: ItemRow; kind: 'not_applied' | 'mark_applied' } | null>(null);
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => setSelected(new Set()), [part.id, kind, decided]);
  const decidable = (r: ItemRow) => open && !r.ownAccess && r.appliedAt === null && r.notAppliedReason === null;
  const rows = part.rows.filter((r) => (!kind || r.kind === kind) && (decided === '' || (decided === 'undecided' ? r.decision === null : r.decision !== null)));
  const chosen = rows.filter((r) => selected.has(r.id));
  const decidableRows = rows.filter(decidable);
  const allOn = decidableRows.length > 0 && decidableRows.every((r) => selected.has(r.id));
  const toggle = (id: string, on: boolean) => setSelected((s) => {
    const next = new Set(s);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  const block: TextPair | null = signOffBlock(part);
  const revoke = (row: ItemRow) => {
    setBusy(row.id);
    setFailure(null);
    void ctx.track(settled(adapter.msApply(ms, part.reviewId, row.id, { action: 'apply' }))).then((res) => {
      setBusy(null);
      if (!res.ok) {
        setFailure(errorText(ctx, res.error));
        return;
      }
      ctx.toast(outcomeText(ctx, res.data, ctx.li(TEXT.guestRevoked)));
      noteAccessReviewsChanged();
    });
  };
  const guestActions = (r: ItemRow) => {
    if (r.kind !== 'auditor_access' || !canRevoke || r.appliedAt !== null || r.notAppliedReason !== null) return null;
    if (r.decision === 'revoke') {
      return (
        <span className="mx-btn-group">
          <Button variant="danger" busy={busy === r.id} disabled={busy !== null} onClick={() => revoke(r)}>{ctx.li(TEXT.revokeGuest)}</Button>
          <Button variant="link" onClick={() => setNoteFor({ row: r, kind: 'not_applied' })}>{ctx.li(SHARED.notApplied)}</Button>
        </span>
      );
    }
    if (r.decision === 'change') {
      return (
        <span className="mx-btn-group">
          <Button onClick={() => setNoteFor({ row: r, kind: 'mark_applied' })}>{ctx.li(SHARED.markApplied)}</Button>
          <Button variant="link" onClick={() => setNoteFor({ row: r, kind: 'not_applied' })}>{ctx.li(SHARED.notApplied)}</Button>
        </span>
      );
    }
    return null;
  };
  const actions = (r: ItemRow) => (
    <span className="mx-btn-group">
      {decidable(r) ? <Button variant="link" onClick={() => setDeciding([r])}>{ctx.li(r.decision ? SHARED.changeDecision : SHARED.decide)}</Button> : null}
      {guestActions(r)}
    </span>
  );
  return (
    <div className="mx-stack" data-part={part.id}>
      <Card
        title={ctx.fill(TEXT.partTitle, { ms: ms.toUpperCase(), no: part.reviewNo })}
        sub={TEXT.partSub}
        actions={part.reviewStatus === 'open' && part.status === 'open'
          ? <Button variant="primary" disabledReason={block} onClick={() => setSigning(true)}>{ctx.li(TEXT.signOff)}</Button>
          : null}
      >
        {failure ? <Alert tone="bad">{failure}</Alert> : null}
        <Facts
          items={[
            { label: SHARED.colStatus, value: <Badge tone={PART_STATUS_TONE[part.status]}>{ctx.li(PART_STATUS_TEXT[part.status])}</Badge> },
            { label: TEXT.reviewStatus, value: ctx.li(STATUS_TEXT[part.reviewStatus]) },
            { label: SHARED.colDue, value: formatDay(part.dueOn, ctx.lang) },
            { label: SHARED.colDecided, value: ctx.fill(SHARED.decidedOf, { n: part.decided, total: part.items }) },
            ...(part.signedOffBy ? [{ label: SHARED.colSignedOff, value: <PersonAt ctx={ctx} who={part.signedOffBy} at={part.signedOffAt} /> }] : []),
            ...(part.evidenceCode ? [{ label: SHARED.colEvidence, value: <span className="mx-mono">{part.evidenceCode}</span> }] : []),
          ]}
        />
      </Card>
      {part.needsSecondReviewer && part.status === 'open' ? (
        <Alert tone="warn" title={SHARED.secondReviewerTitle}>{ctx.fill(TEXT.secondHere, { n: part.needsSecondReviewer })}</Alert>
      ) : null}
      <Card
        title={TEXT.itemsTitle}
        sub={TEXT.itemsSub}
        flush
        actions={open ? (
          <Button variant="primary" disabledReason={chosen.length ? null : SHARED.selectFirst} onClick={() => setDeciding(chosen)}>
            {chosen.length ? ctx.fill(SHARED.decideSelected, { n: chosen.length }) : ctx.li(SHARED.decide)}
          </Button>
        ) : null}
      >
        <div className="mx-row" style={{ padding: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 200 }}>
            <Field label={SHARED.filterKind}>
              <Select name="kind" value={kind} onChange={(v) => setKind(v as ItemKind | '')} empty={SHARED.allKinds} options={SYSTEM_KINDS.map((k) => ({ value: k, label: KIND_TEXT[k] }))} />
            </Field>
          </div>
          <div style={{ minWidth: 200 }}>
            <Field label={SHARED.filterDecision}>
              <Select name="decided" value={decided} onChange={(v) => setDecided(v as DecisionFilter)} empty={SHARED.allItems} options={[{ value: 'undecided', label: SHARED.undecidedOnly }, { value: 'decided', label: SHARED.decidedOnly }]} />
            </Field>
          </div>
          {open && decidableRows.length > 0 ? (
            <Checkbox name="select-all" checked={allOn} onChange={(on) => setSelected(on ? new Set(decidableRows.map((r) => r.id)) : new Set())} label={SHARED.selectAll} />
          ) : null}
        </div>
        <ItemsTable
          ctx={ctx}
          rows={rows}
          selection={open ? { selected, toggle, can: decidable } : undefined}
          actions={actions}
          empty={<EmptyState title={SHARED.noItems} text={decided === 'undecided' ? SHARED.allDecidedText : SHARED.noItemsText} illustration={<Illustration scene="all-done" size="sm" decorative />} />}
        />
      </Card>
      {deciding && deciding.length ? (
        <DecisionDialog
          ctx={ctx}
          rows={deciding}
          run={(row, body) => adapter.msDecide(ms, part.reviewId, row.id, body)}
          onClose={() => setDeciding(null)}
          onDone={(n) => {
            if (n > 0) {
              ctx.toast(ctx.fill(SHARED.decided, { n }));
              setDeciding(null);
              setSelected(new Set());
            }
            noteAccessReviewsChanged();
          }}
        />
      ) : null}
      {noteFor ? (
        <ApplyNoteDialog
          ctx={ctx}
          row={noteFor.row}
          kind={noteFor.kind}
          run={(body) => adapter.msApply(ms, part.reviewId, noteFor.row.id, body)}
          onClose={() => setNoteFor(null)}
          onDone={(outcome) => {
            ctx.toast(outcomeText(ctx, outcome, ctx.li(SHARED.applied)));
            setNoteFor(null);
            noteAccessReviewsChanged();
          }}
        />
      ) : null}
      {signing ? (
        <SignOffDialog
          ctx={ctx}
          ms={ms}
          part={part}
          onClose={() => setSigning(false)}
          onDone={() => {
            setSigning(false);
            noteAccessReviewsChanged();
          }}
        />
      ) : null}
    </div>
  );
}

export default function AccessReviewScreen({ ctx }: ScreenProps) {
  const ms = ctx.msObj?.id ?? null;
  const adapter = adapterFor(ctx);
  const parts = useLoad(() => (ms ? adapter.msList(ms) : Promise.resolve({ ok: true as const, data: [] })), [ms]);
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(null), [ms]);
  const list = parts.data ?? [];
  const current = chosen ?? list[0]?.reviewId ?? null;
  const part = useLoad(() => (ms && current ? adapter.msGet(ms, current) : Promise.resolve({ ok: true as const, data: null })), [ms, current]);
  if (!ms) return null;
  if (!mayDecide(ctx, ms)) return <Alert tone="info">{ctx.li(TEXT.noRight)}</Alert>;
  return (
    <div className="mx-stack">
      <LoadState ctx={ctx} list={parts} />
      {parts.data && !list.length ? (
        <Card title={ctx.fill(TEXT.noneTitle, { ms: ms.toUpperCase() })}>
          <EmptyState title={TEXT.noneYet} text={TEXT.noneYetText} illustration={<Illustration scene="all-done" size="sm" decorative />} />
        </Card>
      ) : null}
      {list.length > 1 ? (
        <div style={{ maxWidth: 320 }}>
          <Field label={TEXT.chooseReview}>
            <Select
              name="review"
              value={current ?? ''}
              onChange={(v) => setChosen(v || null)}
              options={list.map((p) => ({ value: p.reviewId, label: `${p.reviewNo} (${ctx.li(STATUS_TEXT[p.reviewStatus])})` }))}
            />
          </Field>
        </div>
      ) : null}
      {current ? <LoadState ctx={ctx} list={part} /> : null}
      {part.data ? <PartPage key={part.data.id} ctx={ctx} ms={ms} part={part.data} /> : null}
    </div>
  );
}
