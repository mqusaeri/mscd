// Open findings of a clause or control (MILESTONE-2 M2-14, detail extension of `req`): the findings whose stored
// `targetCode` is the code of the requirement in the drawer (`findings.list?targetCode=`), open or in progress, each
// with a link to its drawer in "Findings and actions".
import { useMemo, useRef } from 'react';
import type { Requirement } from '../../data/types';
import type { DetailProps } from '../types';
import { Button } from '../ui';
import { adapterFor } from './adapter';
import { isOpen } from './model';
import { ClassBadge, FindingStatusBadge, useLoad } from './parts';
import { codeOfRequirement } from './shared';
import { TEXT } from './text';

export default function OpenFindings({ ctx, ms, record, close }: DetailProps) {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(() => ctxRef.current), [client]);
  const code = codeOfRequirement((record as Partial<Requirement> | null)?.id);
  const loaded = useLoad(() => adapter.findings(ms, { targetCode: code }), `${ctx.org?.id ?? ''}:${ms}:${code}`, Boolean(code));
  if (!code || (loaded.loading && !loaded.data)) return null;
  const open = (loaded.data ?? []).filter(isOpen);
  const go = (id: string) => {
    close();
    ctx.go('findings', { params: { finding: id, at: Date.now() } });
  };
  return (
    <section className="mx-stack" style={{ gap: 8 }} aria-label={ctx.li(TEXT.extTitle)} data-findings-of={code}>
      <div style={{ fontWeight: 600 }}>{ctx.li(TEXT.extTitle)}</div>
      {loaded.error ? <span className="mx-small">{ctx.fill(TEXT.extFailed, { code })}</span> : null}
      {!loaded.error && !open.length ? <span className="mx-small">{ctx.fill(TEXT.extNone, { code })}</span> : null}
      {open.map((f) => (
        <div key={f.id} className="mx-row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <Button variant="link" onClick={() => go(f.id)} title={ctx.li(TEXT.extOpen)}>{f.code}</Button>
          <span style={{ flex: 1, minWidth: 0 }}>{f.title}</span>
          <ClassBadge ctx={ctx} value={f.classification} />
          <FindingStatusBadge ctx={ctx} value={f.status} />
        </div>
      ))}
    </section>
  );
}
