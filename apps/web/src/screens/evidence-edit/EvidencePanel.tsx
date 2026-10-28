// Detail extension of an evidence record (MILESTONE-2 M2-11, C.5 kind `ev`): the controls and requirements it serves
// with "Remove target" (never the last one), "Edit evidence", "Add target" and the freshness limits of the system. The
// forms open in the host layer (store.ts), so they stay when the drawer closes after a save.
import { useEffect, useId, useState } from 'react';
import type { Evidence, MsId } from '../../data/types';
import type { DetailProps } from '../types';
import { Button } from '../ui';
import { holdsInFull, mayActOn } from '../controls-edit/common';
import { useAdapterOf } from '../controls-edit/parts';
import { adapterFor } from './adapter';
import { evidenceRefOf } from './dialogs';
import { idOfTarget } from './model';
import type { TargetList } from './model';
import { requestEvidence, useTargetsVersion } from './store';
import { shownTargets, targetScopeOf } from './targets';
import { TEXT } from './text';

export function EvidencePanel({ ctx, ms, record }: DetailProps) {
  const evidence = record as Evidence;
  const headingId = useId();
  const adapter = useAdapterOf(ctx, adapterFor);
  // The server's list is kept with the organisation, system and record it belongs to, so a list read for another
  // record or another organisation is never shown while the next one loads.
  const [server, setServer] = useState<{ key: string; list: TargetList | null }>({ key: '', list: null });
  const tick = useTargetsVersion();
  const code = evidence?.code;
  const scope = targetScopeOf(ctx);
  const key = `${scope}|${ms}|${code ?? ''}`;
  const may = Boolean(code) && mayActOn(ctx, ms, 'evidence.manage', evidence?.owner);
  useEffect(() => {
    if (!code || !may) return undefined;
    let live = true;
    void adapter.targets(evidenceRefOf(ctx, ms, code)).then((res) => {
      if (live) setServer({ key, list: res.ok ? res.data : null });
    });
    return () => {
      live = false;
    };
    // Read when the organisation, the record or the list changes; the snapshot ref is read at the time of the call.
  }, [adapter, key, ms, code, may, tick]);
  if (!code || !may) return null;

  const list = shownTargets(server.key === key ? server.list : null, ctx.D, scope, code);
  const single = list.targets.length <= 1;
  const shortOf = (id: MsId) => ctx.D?.MS?.find((m) => m.id === id)?.short ?? id;
  const at = Date.now;
  return (
    <section className="mx-m11-panel" aria-labelledby={headingId} data-m11="evidence">
      <h3 id={headingId} className="mx-m11-panel-title">{ctx.li(TEXT.panelTitle)}</h3>
      <div className="mx-btn-group">
        <Button onClick={() => requestEvidence({ kind: 'edit', ms, at: at(), evidence })}>{ctx.li(TEXT.edit)}</Button>
        <Button onClick={() => requestEvidence({ kind: 'addTarget', ms, at: at(), evidence, existing: list.targets })}>{ctx.li(TEXT.addTarget)}</Button>
        {holdsInFull(ctx, ms, 'applicability.manage') ? (
          <Button onClick={() => requestEvidence({ kind: 'limits', ms, at: Date.now() })}>{ctx.li(TEXT.freshnessLimits)}</Button>
        ) : null}
      </div>
      <span className="mx-label">{ctx.li(TEXT.targets)}</span>
      <ul className="mx-m11-codes">
        {list.targets.map((t) => {
          const id = idOfTarget(t);
          const reason = single ? TEXT.lastTarget : t.id ? null : TEXT.noTargetId;
          return (
            <li key={`${t.ms}:${id}`}>
              <span className="mx-mono mx-m11-code">{ctx.fill(TEXT.inSystem, { code: id, system: shortOf(t.ms) })}</span>
              <span className="mx-m11-code-title" />
              <Button variant="link" disabledReason={reason} onClick={() => requestEvidence({ kind: 'removeTarget', ms, at: at(), evidence, target: t })}>
                {ctx.fill(TEXT.removeTargetOf, { code: id })}
              </Button>
            </li>
          );
        })}
      </ul>
      {!list.complete ? <span className="mx-small">{ctx.li(TEXT.targetsPartial)}</span> : null}
    </section>
  );
}

export default EvidencePanel;
