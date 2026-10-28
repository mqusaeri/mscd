// Detail extension of an applicability entry (MILESTONE-2 M2-11, C.5 kind `req`): the badges of its target row
// (Written record required, Always applicable, No longer in the standard) for every reader, and for MS Managers "Edit
// entry", "Mark not applicable" (disabled with the APPL-ASSESS reason on clause rows) and "Delete entry"; verifiers
// get "Reject" on an entry that waits for verification. Each opens its form in the host layer (store.ts), so the form
// and its warnings stay when the drawer closes because the entry left the list after a save.
import { useId } from 'react';
import type { DetailProps } from '../types';
import { Alert, Badge, Button } from '../ui';
import { adapterFor } from './adapter';
import { holdsInFull } from './common';
import type { EntryRecord } from './common';
import { assessableOf, targetOf } from './model';
import { useAdapterOf } from './parts';
import { requestControls } from './store';
import { useTargets } from './targets';
import { TEXT } from './text';

export default function EntryPanel({ ctx, ms, record }: DetailProps) {
  const entry = record as EntryRecord;
  const headingId = useId();
  const adapter = useAdapterOf(ctx, adapterFor);
  const targets = useTargets(adapter, `${ctx.mode}:${ctx.org?.id ?? ''}`, ms);
  if (!entry || typeof entry.id !== 'string') return null;

  const target = targetOf(targets, entry);
  const assessable = assessableOf(target, entry);
  const retired = Boolean(entry.retired || target?.retired);
  const canManage = holdsInFull(ctx, ms, 'applicability.manage');
  const canReject = entry.st === 'complete' && holdsInFull(ctx, ms, 'applicability.verify');
  const canExclude = canManage && entry.st !== 'na';
  const canDelete = holdsInFull(ctx, ms, 'record.delete');
  const actions = canManage || canReject || canDelete;
  const badges: { label: readonly [string, string]; tone: 'info' | 'mute' | 'warn'; hint?: readonly [string, string] }[] = [];
  if (target?.documentedInfo) badges.push({ label: TEXT.badgeWritten, tone: 'info', hint: TEXT.badgeWrittenHint });
  if (target && !target.assessable) badges.push({ label: TEXT.badgeAlways, tone: 'mute' });
  if (retired) badges.push({ label: TEXT.badgeRetired, tone: 'warn' });
  if (!actions && !badges.length) return null;

  const open = (kind: 'edit' | 'reject' | 'na' | 'delete') => requestControls({ kind, ms, entry, assessable, at: Date.now() });
  return (
    <section className="mx-m11-panel" aria-labelledby={actions ? headingId : undefined} data-m11="entry">
      {actions ? <h3 id={headingId} className="mx-m11-panel-title">{ctx.li(TEXT.panelTitle)}</h3> : null}
      {badges.length ? (
        <div className="mx-row">
          {badges.map((b) => <Badge key={b.label[0]} tone={b.tone} title={b.hint ? ctx.li(b.hint) : undefined}>{ctx.li(b.label)}</Badge>)}
        </div>
      ) : null}
      {retired ? <Alert tone="warn">{ctx.li(TEXT.retiredText)}</Alert> : null}
      {actions ? (
        <div className="mx-btn-group">
          {canManage ? <Button onClick={() => open('edit')}>{ctx.li(TEXT.edit)}</Button> : null}
          {canReject ? <Button onClick={() => open('reject')}>{ctx.li(TEXT.reject)}</Button> : null}
          {canExclude ? (
            <Button onClick={() => open('na')} disabledReason={assessable ? null : TEXT.alwaysApplicableReason}>{ctx.li(TEXT.notApplicable)}</Button>
          ) : null}
          {canDelete ? <Button variant="danger" onClick={() => open('delete')}>{ctx.li(TEXT.deleteEntry)}</Button> : null}
        </div>
      ) : null}
    </section>
  );
}
