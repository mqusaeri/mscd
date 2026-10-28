// Detail extension of an applicability entry for evidence (MILESTONE-2 M2-11, C.5 kind `req`): "Define evidence" opens
// New evidence with the entry as its first target, for whoever may add evidence in the system (`evidence.manage`).
import type { DetailProps } from '../types';
import { Button } from '../ui';
import type { EntryRecord } from '../controls-edit/common';
import { requestEvidence } from './store';
import { TEXT } from './text';

export function DefinePanel({ ctx, ms, record }: DetailProps) {
  const entry = record as EntryRecord;
  if (!entry || typeof entry.id !== 'string' || entry.st === 'na' || entry.retired || !ctx.can(ms, 'evidence.manage')) return null;
  return (
    <div className="mx-m11-panel" data-m11="define">
      <div className="mx-btn-group">
        <Button onClick={() => requestEvidence({ kind: 'new', ms, target: entry.id, at: Date.now() })}>{ctx.li(TEXT.defineEvidence)}</Button>
        <span className="mx-small">{ctx.li(TEXT.defineHint)}</span>
      </div>
    </div>
  );
}
