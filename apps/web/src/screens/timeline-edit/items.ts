// The preparation tasks and cycle items of the timeline rows (MILESTONE-2 M2-15): the model of a row and whether the
// session gets its actions. Kept apart from ItemActions.tsx so actions.ts can decide visibility without loading it.
import type { ControllerData, MsId } from '../../data/types';
import type { DetailKind, DetailProps, HostContext } from '../types';
import { mayFinishItem, mayReassignItem } from './model';
import type { ItemModel } from './model';

type PrepRow = [string, string, string, 'done' | 'progress' | 'open'];
type CycleRow = [string, string, string, string, 'done' | 'progress' | 'open', string];

/** The date of the next audit of a system, which its preparation tasks belong to (G.5 PREP). */
export function nextAuditDate(D: ControllerData | null, ms: MsId): string | null {
  return (D?.EVENTS?.[ms] ?? []).find((e) => e.next)?.d ?? null;
}

/** The item a row of the timeline shows: a preparation task `[title, holder, due, status]` or a cycle item. */
export function itemOf(kind: DetailKind, ms: MsId, record: unknown, D: ControllerData | null): ItemModel | null {
  if (!Array.isArray(record)) return null;
  if (kind === 'prep') {
    const [title, owner, due, status] = record as PrepRow;
    return { kind: 'prep', ms, code: title, title, owner, due, status, auditDate: nextAuditDate(D, ms) };
  }
  if (kind === 'cycle') {
    const [code, title, owner, due, status] = record as CycleRow;
    return { kind: 'cycle', ms, code, title, owner, due, status, auditDate: null };
  }
  return null;
}

/** Shown for an item that is not done and that the session may finish or reassign. */
export function itemVisible(ctx: HostContext, props: Omit<DetailProps, 'ctx'>): boolean {
  const item = itemOf(props.kind, props.ms, props.record, ctx.D);
  return Boolean(item && item.status !== 'done' && (mayFinishItem(ctx, item) || mayReassignItem(ctx, item)));
}

