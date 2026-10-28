// The model of the activity forms (MILESTONE-2 M2-11): the activity a write is for, the gate items of the snapshot an
// activity can be blocked by (BR-39), the BR-46 count of the gate phase, the checks before Save, and the interface both
// adapters implement (api.ts in API builds, sample.ts in the sample build, chosen in adapter.ts).
import type { ActivityTransitionRequest } from '@mscd/shared';
import type { Activity, ControllerData, MsId, Phase } from '../../data/types';
import type { TextPair } from '../types';
import type { Outcome, Result } from '../controls-edit/common';
import { TEXT } from './text';

export type { ActivityTransitionRequest };

/** The activity a write is for: its system, record key and number, and its uuid and ETag from the snapshot refs. */
export interface ActivityRef {
  ms: MsId;
  key: string;
  no: string;
  uuid: string | null;
  etag: string | null;
}

export interface ActivityAdapter {
  /** `not_started` to `in_progress` (C.13; BR-12 refuses an activity behind an unverified critical gate). */
  start(activity: ActivityRef): Promise<Result<Outcome>>;
  /** To `blocked` with the gate item and the reason (BR-39). */
  block(activity: ActivityRef, gateItemRef: string, reason: string): Promise<Result<Outcome>>;
}

export const ADAPTER_METHODS: readonly (keyof ActivityAdapter)[] = ['start', 'block'];

/** A gate item an activity can be blocked by, with the activities it already blocks. */
export interface GateChoice {
  id: string;
  type: TextPair | string;
  why: TextPair | string;
  holder: string;
  blocks: string[];
}

const phasesOf = (D: ControllerData | null | undefined, ms: MsId): Phase[] => (D?.bundles?.[ms]?.phases ?? []) as Phase[];

/** The open gate items of a system (`bundle.gates`), each with the numbers of the activities it blocks. */
export function gateChoices(D: ControllerData | null | undefined, ms: MsId): GateChoice[] {
  const gates = (D?.bundles?.[ms]?.gates ?? []) as { id: string; type: TextPair | string; why: TextPair | string; h: string }[];
  const acts = phasesOf(D, ms).flatMap((p) => p.acts);
  return gates.map((g) => ({
    id: g.id,
    type: g.type,
    why: g.why,
    holder: g.h,
    blocks: acts.filter((a) => a.st === 'blocked' && a.blocker === g.id).map((a) => a.no),
  }));
}

/** The phase an activity belongs to. */
export function phaseOfActivity(D: ControllerData | null | undefined, ms: MsId, activity: Pick<Activity, 'key' | 'pno'>): Phase | null {
  const phases = phasesOf(D, ms);
  return phases.find((p) => p.acts.some((a) => a.key === activity.key)) ?? phases.find((p) => p.no === activity.pno) ?? null;
}

/**
 * The BR-46 comparison of the gate phase that matters for an activity: its own phase when that is a gate phase, else
 * the first gate phase that is not fully verified. Null when the system has no such phase.
 */
export function gateConsistency(D: ControllerData | null | undefined, ms: MsId, activity?: Pick<Activity, 'key' | 'pno'>): { phase: number; blocked: number; open: number } | null {
  const phases = phasesOf(D, ms);
  const own = activity ? phaseOfActivity(D, ms, activity) : null;
  const phase = own?.gate ? own : phases.find((p) => p.gate && p.c.verified < p.total);
  if (!phase) return null;
  return { phase: phase.no, blocked: phase.acts.filter((a) => a.st === 'blocked').length, open: ((D?.bundles?.[ms]?.gates ?? []) as unknown[]).length };
}

/** Field problems of Record blocker before Save. */
export function checkBlocker(gate: string, reason: string): Record<string, TextPair> {
  const out: Record<string, TextPair> = {};
  if (!gate) out.gate = TEXT.gateRequired;
  const n = reason.trim().length;
  if (n < 1 || n > 1000) out.reason = TEXT.reasonRequired;
  return out;
}

/** The transition bodies of D.2 (C.13). */
export const startBody = (): ActivityTransitionRequest => ({ to: 'in_progress' });
export const blockBody = (gateItemRef: string, reason: string): ActivityTransitionRequest => ({ to: 'blocked', blockerGateItemRef: gateItemRef.trim(), blockerReason: reason.trim() });
