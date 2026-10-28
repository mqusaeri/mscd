// API adapter of the Getting started screen: `GET /admin/onboarding` through the host's client (R-17).
import type { OnboardingStep } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import { STEP_KEYS } from './model';
import type { OnboardingAdapter, StepKey, StepModel } from './model';
import { ROUTES } from './routes';

/** The screen's model of one step; an unknown key (a newer server) is dropped. */
export function fromStep(step: OnboardingStep): StepModel | null {
  if (!(STEP_KEYS as readonly string[]).includes(step.key)) return null;
  return {
    key: step.key as StepKey,
    state: step.state,
    screen: step.screen,
    ...(typeof step.count === 'number' ? { count: step.count } : {}),
    ...(typeof step.limit === 'number' ? { limit: step.limit } : {}),
    ...(step.ms ? { ms: step.ms } : {}),
    ...(step.doneBy ? { doneBy: step.doneBy } : {}),
    ...(step.assignee !== undefined ? { assignee: step.assignee } : {}),
  };
}

export function createApiAdapter(client: ApiClient | null): OnboardingAdapter {
  return {
    async load() {
      const res = await call<OnboardingStep[]>(client, ROUTES.onboarding);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, steps: res.data.map(fromStep).filter((s): s is StepModel => s !== null) };
    },
  };
}
