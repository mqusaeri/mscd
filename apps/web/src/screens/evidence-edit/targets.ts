// The targets of an evidence record as the forms show them (MILESTONE-2 M2-11). The server's evidence list carries
// them with their ids (`targets` of each row) for whoever may change them; when a list has none (the sample build, or a
// reader without the rows' targets), the snapshot gives the first target of each system (the bundle of every system
// the record serves holds it once), and the targets added in this session keep the id `evidence.targets.create`
// answered, so they can be removed again. Learned targets are kept per build mode and organisation: evidence codes are
// unique within one organisation only, and the organisation switch does not reload the page.
import type { ControllerData, Evidence, MsId } from '../../data/types';
import type { HostContext } from '../types';
import type { EvidenceTarget, TargetList } from './model';
import { targetOfId } from './model';

const learned = new Map<string, EvidenceTarget[]>();

/** The scope of the learned targets: the build mode and the organisation of the host context. */
export function targetScopeOf(ctx: Pick<HostContext, 'mode' | 'org'>): string {
  return `${ctx.mode}:${ctx.org?.id ?? ''}`;
}

const keyOf = (scope: string, code: string) => `${scope}|${code}`;
const same = (a: EvidenceTarget, b: EvidenceTarget) => a.ms === b.ms && a.code === b.code && a.targetType === b.targetType;

/** Keeps a target added in this session with its id. */
export function learnTarget(scope: string, code: string, target: EvidenceTarget): void {
  const key = keyOf(scope, code);
  learned.set(key, [...(learned.get(key) ?? []).filter((t) => !same(t, target)), target]);
}

/** Forgets a removed target. */
export function forgetTarget(scope: string, code: string, target: EvidenceTarget): void {
  const key = keyOf(scope, code);
  learned.set(key, (learned.get(key) ?? []).filter((t) => !same(t, target)));
}

/** Forgets every learned target (unit tests). */
export function resetLearnedTargets(): void {
  learned.clear();
}

/** The first target of each system whose bundle holds the evidence (no ids). */
export function snapshotTargets(D: ControllerData | null | undefined, code: string): EvidenceTarget[] {
  const out: EvidenceTarget[] = [];
  for (const [ms, bundle] of Object.entries(D?.bundles ?? {})) {
    const e = ((bundle?.evs ?? []) as Evidence[]).find((x) => x.code === code);
    if (e?.ctrl) out.push({ id: null, ms: ms as MsId, ...targetOfId(e.ctrl) });
  }
  return out;
}

/**
 * The targets to show: the server's complete list when it has one, else the snapshot's first targets merged with the
 * targets learned in this session in the same organisation (a learned target gives its id to the same snapshot target).
 */
export function shownTargets(server: TargetList | null, D: ControllerData | null | undefined, scope: string, code: string): TargetList {
  if (server?.complete) return server;
  const out = snapshotTargets(D, code);
  for (const t of learned.get(keyOf(scope, code)) ?? []) {
    const at = out.findIndex((o) => same(o, t));
    if (at >= 0) out[at] = { ...out[at], id: t.id };
    else out.push(t);
  }
  return { targets: out, complete: false };
}
