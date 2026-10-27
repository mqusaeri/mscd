// Queueing of the jobs that recompute derived certification data after a command (Milestone 2 D.6, D.4, R-18):
// `readiness.recompute` (singleton `rr:<org>:<ms>`, 60 seconds after the command, so a burst of changes runs once;
// `packs/applicability-sync.service.ts` uses the same key) and `cycle.derive` (singleton `cd:<org>:<ms>` of E.2).
// Both are sent in the command's transaction, so they commit or roll back with the change they follow. The command
// helpers queue them next to `freshness.recompute`; findings and corrective actions queue them directly.
import type { JobQueue } from '../../../common/jobs/job-queue';
import { currentRequestId } from '../../../common/request-context';
import type { TenantInfo, Trx } from '../../../common/tokens';
import { cycleDeriveKey } from '../../audit-registers/cycle-derive.service';

/** D.6 delay of `readiness.recompute` after a command, in seconds. */
export const READINESS_DELAY_SECONDS = 60;

/** Singleton key of `readiness.recompute` for one system (D.6), or every system of the organisation (daily run). */
export function readinessRecomputeKey(orgId: string, msId?: string | null): string {
  return `rr:${orgId}:${msId ?? 'all'}`;
}

/** Queues `readiness.recompute` for a system in the command's transaction (D.6). */
export async function enqueueReadiness(queue: JobQueue, trx: Trx, org: Pick<TenantInfo, 'id'>, msId: string, requestedBy: string): Promise<void> {
  await queue.send(
    'readiness.recompute',
    { orgId: org.id, requestId: currentRequestId(), requestedBy, payload: { msId } },
    { singletonKey: readinessRecomputeKey(org.id, msId), startAfterSeconds: READINESS_DELAY_SECONDS, retryLimit: 3 },
    trx,
  );
}

/**
 * Queues `readiness.recompute` and `cycle.derive` for a system in the command's transaction (D.6, D.4): every command
 * that feeds clause readiness also feeds the derived cycle items (documents reviewed, evidence, metrics, findings,
 * corrective actions). `cycle.derive` waits as long as readiness, so a burst of changes derives once.
 */
export async function enqueueDerived(queue: JobQueue, trx: Trx, org: Pick<TenantInfo, 'id'>, msId: string, requestedBy: string): Promise<void> {
  await enqueueReadiness(queue, trx, org, msId, requestedBy);
  await queue.send(
    'cycle.derive',
    { orgId: org.id, requestId: currentRequestId(), requestedBy, payload: { msId } },
    { singletonKey: cycleDeriveKey(org.id, msId), startAfterSeconds: READINESS_DELAY_SECONDS, retryLimit: 3 },
    trx,
  );
}
