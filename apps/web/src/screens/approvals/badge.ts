// The sidebar badge of Pending approvals (MILESTONE-2 M2-10): the number of role grants and routing changes waiting for
// a second approval. `count()` of the screen definition is synchronous, so the number is kept here: the layer item of
// actions.ts loads it when the app starts, when the organisation changes and when the person moves between screens
// (at most every 30 seconds, at once on People and roles and on Pending approvals), and the Pending approvals screen
// sets it after each load and decision. In API builds one request reads the `pending_grants` step of the onboarding
// checklist (`ms.admin`) and one the routing rules (`storage.repository.read`); the sample build counts the sample
// grants and rules of this browser session.
import type { OnboardingStep, RoutingRuleView } from '@mscd/shared';
import { call } from '../api';
import type { HostContext } from '../types';
import { ROUTES } from './routes';

/** The permissions that open Pending approvals: role grants or routing rules. */
export const APPROVAL_PERMS = ['user.manage', 'storage.routing.manage'] as const;

let count = 0;
const listeners = new Set<(n: number) => void>();

export function badgeCount(): number {
  return count;
}

/** Sets the badge; true when the number changed. */
export function setBadgeCount(n: number): boolean {
  const next = Math.max(0, Math.floor(n) || 0);
  if (next === count) return false;
  count = next;
  for (const l of [...listeners]) l(count);
  return true;
}

export function onBadgeCount(listener: (n: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The pending grants (onboarding `pending_grants`) and routing changes of the organisation, from the api. */
export async function apiPendingCount(ctx: HostContext): Promise<number | null> {
  const [steps, rules] = await Promise.all([
    ctx.orgCan('ms.admin') ? call<OnboardingStep[]>(ctx.client, ROUTES.onboarding) : Promise.resolve(null),
    ctx.orgCan('storage.repository.read') ? call<RoutingRuleView[]>(ctx.client, ROUTES.rulesList) : Promise.resolve(null),
  ]);
  if ((steps && !steps.ok) && (rules && !rules.ok)) return null;
  const grants = steps && steps.ok ? steps.data.find((s) => s.key === 'pending_grants')?.count ?? 0 : 0;
  const changes = rules && rules.ok ? rules.data.filter((r) => r.approvalStatus === 'pending_approval').length : 0;
  return grants + changes;
}

/** The pending grants and routing changes of the sample organisation in this browser session. */
async function samplePendingCount(ctx: HostContext): Promise<number | null> {
  const [users, routing] = await Promise.all([import('../users/sample'), import('../routing/sample')]);
  const me = () => ctx.me?.user.handle ?? ctx.person.handle;
  const [members, rules] = await Promise.all([
    users.createSampleAdapter(() => ctx.D, me).members(),
    routing.createSampleAdapter(() => ctx.D, me).load(),
  ]);
  const grants = members.ok ? members.data.reduce((n, m) => n + m.roles.filter((g) => g.approvalStatus === 'pending_approval').length, 0) : 0;
  const changes = rules.ok ? rules.data.rules.filter((r) => r.approvalStatus === 'pending_approval').length : 0;
  return grants + changes;
}

/** The number of waiting approvals for the session; null when it could not be read. */
export function loadPendingCount(ctx: HostContext): Promise<number | null> {
  const run = import.meta.env.VITE_DATA_SOURCE === 'api' ? apiPendingCount(ctx) : samplePendingCount(ctx);
  return run.catch(() => null);
}

/** Reads the number again and renders the shell when it changed (after a change on People and roles). */
export function refreshBadge(ctx: HostContext): void {
  loadPendingCount(ctx).then((n) => {
    if (n !== null && setBadgeCount(n)) ctx.track(Promise.resolve()).catch(() => undefined);
  });
}
