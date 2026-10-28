// The actions of a preparation task of the next audit and of a certification cycle item on the timeline (detail
// extensions of kinds `prep` and `cycle`, MILESTONE-2 M2-15, C.5): "Mark done" for the MS Manager or the holder, and
// "Reassign or change due date" for the MS Manager. A done item shows none, so its row stays as the design draws it.
import { useState } from 'react';
import type { DetailProps } from '../types';
import { UI_TEXT } from '../ui';
import { adapterFor } from './adapter';
import { isConflict, mayFinishItem, mayReassignItem, outcomeText } from './model';
import { itemOf } from './items';
import { loadCycles, openForm } from './store';
import { TEXT } from './text';

export default function ItemActions({ ctx, kind, ms, record }: DetailProps) {
  const [busy, setBusy] = useState(false);
  const item = itemOf(kind, ms, record, ctx.D);
  if (!item || item.status === 'done') return null;
  const finish = mayFinishItem(ctx, item);
  const reassign = mayReassignItem(ctx, item);
  const done = () => {
    setBusy(true);
    const adapter = adapterFor(ctx);
    ctx.track(adapter.markDone(ms, item)).then(async (res) => {
      if (!res.ok) {
        ctx.toast(ctx.li(isConflict(res.error) ? TEXT.conflict : res.error.message));
        if (isConflict(res.error)) await ctx.reload([ms]);
        setBusy(false);
        return;
      }
      ctx.toast(outcomeText(ctx, res.data, ctx.fill(TEXT.markedDone, { title: item.title })));
      await ctx.reload(res.data.changed.length ? res.data.changed : [ms]);
      void loadCycles(ctx, adapter, ms, true);
      setBusy(false);
    }, () => {
      ctx.toast(ctx.li(TEXT.loadFailed));
      setBusy(false);
    });
  };
  if (busy) return <span className="mx-tl-busy" role="status">{ctx.li(UI_TEXT.saving)}</span>;
  return (
    <span className="mx-tl-item-actions" data-tl-item={item.code}>
      {finish ? <button type="button" className="mx-tl-link" onClick={done}>{ctx.li(TEXT.markDone)}</button> : null}
      {reassign ? <button type="button" className="mx-tl-link" onClick={() => openForm({ type: 'item', ms, item })}>{ctx.li(TEXT.reassign)}</button> : null}
    </span>
  );
}
