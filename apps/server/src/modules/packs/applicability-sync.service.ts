// `applicability.sync` (Milestone 2 E.3, J.3; M2-03). After a pack installation updates an edition in use, every
// system on that edition gets the content of the new version: applicability entries for new catalogue items and leaf
// requirements (`seedApplicability`, `not_started`, unassigned), cycle items for new cycle requirements in its open
// cycles, and nothing is ever deleted. The MS Managers get one `pack_content_updated` notice with the codes added,
// retitled and retired, and the run is audited as `pack.content_synced` (platform audit log, with the system).
//
// Which systems wait for a sync is read from the database, so a run is idempotent: an update installation of the
// system's edition after the system was created, newer than the last installation synced for it. The change summary
// of each installation is the one its `pack.installed` audit entry keeps (pack-content-diff.ts).
//
// The worker's `pack.install` queues the job right after an update. Installations outside the worker (`migrate` step 5,
// `mscd-server packs install`) are picked up when the worker starts and by the daily `packs.lifecycle`. Demo
// organisations (`demo_deploy_label` set) are skipped, so an upgraded demo keeps matching the sample.
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import {
  AUDIT_WRITER,
  NOTIFICATION_WRITER,
  SYSTEM_USER_ID,
  type AuditWriter,
  type NotificationWriter,
  type TenantInfo,
  type Trx,
} from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { seedApplicability } from '../implementation/applicability-seed';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';
import { parseContentChanges, type PackContentChanges } from './pack-content-diff';
import { msManagers } from './pack-lifecycle.service';

/** Delay of the reconciliation after the worker starts, so the job queue is up first. */
export const SYNC_AFTER_WORKER_START_MS = 15_000;
/** Codes listed per kind in a notice; the count is always given. */
const NOTICE_CODES = 10;
/** Codes kept per kind in the audit entry. */
const AUDIT_CODES = 500;

/** One installation of a framework version, as the sync reads it. */
export interface EditionInstall {
  id: string;
  packId: string;
  version: string;
  frameworkVersionId: string;
  installedAt: Date;
  /** False for the first installation of the edition: systems are only created on an installed edition. */
  update: boolean;
  /** The change summary of the `pack.installed` entry (null for installations of an earlier build). */
  changes: PackContentChanges | null;
}

interface SystemRow {
  id: string;
  slug: string;
  code: string;
  created_at: Date;
  framework_version_id: string;
}

/** A system and the update installations not synced for it yet (oldest first). */
export interface PendingSystem {
  system: SystemRow;
  installs: EditionInstall[];
}

/** What one system's sync did. */
export interface SystemSyncResult {
  msId: string;
  slug: string;
  packId: string;
  version: string;
  entriesAdded: string[];
  cycleItemsAdded: string[];
  retitled: string[];
  retired: string[];
  restored: string[];
  notified: number;
}

export interface SyncResult {
  /** Why nothing ran: the organisation is gone or inactive, or a demo organisation. */
  skipped?: 'inactive' | 'demo';
  systems: SystemSyncResult[];
}

/** Codes in first-seen order without repeats. */
function unite(lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
}

/** `a, b, c and 4 more` */
function codeList(codes: readonly string[], more: (n: number) => string): string {
  const shown = codes.slice(0, NOTICE_CODES).join(', ');
  return codes.length > NOTICE_CODES ? `${shown} ${more(codes.length - NOTICE_CODES)}` : shown;
}

/** Singleton key of a sync job: one waiting job per organisation and set of versions. */
export function syncJobKey(orgId: string, frameworkVersionIds: readonly string[]): string {
  const versions = createHash('sha256').update([...frameworkVersionIds].sort().join(',')).digest('hex').slice(0, 16);
  return `as:${orgId}:${versions}`;
}

@Injectable()
export class ApplicabilitySyncService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('applicability.sync');
  private startTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly clock: Clock,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  /** In the worker: reconciles once after the start, for installations made by `migrate` or the command line. */
  onApplicationBootstrap(): void {
    if (this.config.runMode !== 'worker') return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.queuePending().catch((error: unknown) =>
        this.logger.warn(`applicability.sync: the reconciliation after the worker start failed: ${(error as Error).message}`),
      );
    }, SYNC_AFTER_WORKER_START_MS);
    this.startTimer.unref();
  }

  onApplicationShutdown(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  /**
   * Installations of framework versions (every version, or `frameworkVersionIds`), oldest first per version, with
   * the change summary of each update (platform scope: `pack.installed` entries have no organisation).
   */
  async editionInstalls(frameworkVersionIds?: readonly string[], requestId?: string): Promise<EditionInstall[]> {
    return this.scope.withPlatform(
      async (trx) => {
        let query = trx
          .selectFrom('platform.pack_install')
          .select(['id', 'pack_id', 'pack_version', 'framework_version_id', 'installed_at'])
          .where('status', 'in', ['installed', 'superseded'])
          .where('framework_version_id', 'is not', null)
          .where('installed_at', 'is not', null);
        if (frameworkVersionIds) {
          if (frameworkVersionIds.length === 0) return [];
          query = query.where('framework_version_id', 'in', [...frameworkVersionIds]);
        }
        const rows = await query.orderBy('framework_version_id').orderBy('installed_at').orderBy('created_at').execute();
        const seen = new Set<string>();
        const installs: EditionInstall[] = rows.map((r) => {
          const update = seen.has(r.framework_version_id!);
          seen.add(r.framework_version_id!);
          return {
            id: r.id,
            packId: r.pack_id,
            version: r.pack_version,
            frameworkVersionId: r.framework_version_id!,
            installedAt: r.installed_at!,
            update,
            changes: null,
          };
        });
        const updates = installs.filter((i) => i.update);
        if (updates.length > 0) {
          const { rows: entries } = await sql<{ entity_id: string; changes: unknown }>`
            select entity_id, after_data -> 'changes' as changes from platform.audit_log
             where action = 'pack.installed' and entity_id = any(${updates.map((i) => i.id)}::uuid[])`.execute(trx);
          for (const entry of entries) {
            const install = updates.find((i) => i.id === entry.entity_id);
            if (install) install.changes = parseContentChanges(entry.changes);
          }
        }
        return installs;
      },
      { scope: 'job', requestId },
    );
  }

  /** Systems of the organisation of `trx` with update installations not synced yet (`frameworkVersionIds` narrows). */
  async pendingSystems(trx: Trx, installs: readonly EditionInstall[], frameworkVersionIds?: readonly string[]): Promise<PendingSystem[]> {
    const updates = installs.filter((i) => i.update);
    if (updates.length === 0) return [];
    let query = trx
      .selectFrom('management_system')
      .select(['id', 'slug', 'code', 'created_at', 'framework_version_id'])
      .where('deleted_at', 'is', null)
      .where('status', '<>', 'archived')
      .where('framework_version_id', 'in', [...new Set(updates.map((i) => i.frameworkVersionId))]);
    if (frameworkVersionIds) {
      if (frameworkVersionIds.length === 0) return [];
      query = query.where('framework_version_id', 'in', [...frameworkVersionIds]);
    }
    const systems = await query.orderBy('position').orderBy('created_at').execute();
    if (systems.length === 0) return [];
    // The organisation's own `platform.audit_log` rows are visible in its transaction.
    const { rows: synced } = await sql<{ ms: string; install: string | null }>`
      select management_system_id as ms, after_data ->> 'pack_install_id' as install from platform.audit_log
       where action = 'pack.content_synced' and management_system_id = any(${systems.map((s) => s.id)}::uuid[])`.execute(trx);
    const pending: PendingSystem[] = [];
    for (const system of systems) {
      const candidates = updates.filter((i) => i.frameworkVersionId === system.framework_version_id && i.installedAt > system.created_at);
      if (candidates.length === 0) continue;
      const done = new Set(synced.filter((s) => s.ms === system.id && s.install).map((s) => s.install as string));
      let last = -1;
      candidates.forEach((install, index) => {
        if (done.has(install.id)) last = index;
      });
      const open = candidates.slice(last + 1);
      if (open.length > 0) pending.push({ system, installs: open });
    }
    return pending;
  }

  /**
   * Queues `applicability.sync` for every active organisation that is not a demo and has a system waiting for the
   * content of an update (every version, or `frameworkVersionIds`). Returns the organisations queued.
   */
  async queuePending(options: { frameworkVersionIds?: readonly string[]; packInstallId?: string; requestId?: string } = {}): Promise<{ organisations: string[] }> {
    const installs = await this.editionInstalls(options.frameworkVersionIds, options.requestId);
    if (!installs.some((i) => i.update)) return { organisations: [] };
    const organisations = await this.scope.withPlatform(
      (trx) =>
        trx
          .selectFrom('platform.organization')
          .select('id')
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .where('demo_deploy_label', 'is', null)
          .orderBy('position')
          .execute(),
      { scope: 'job', requestId: options.requestId },
    );
    const queued: string[] = [];
    for (const { id } of organisations) {
      const org = await this.tenants.resolveById(id);
      if (!org || org.status !== 'active' || org.demoDeployLabel) continue;
      const pending = await this.scope.withTenant(systemContextOf(org, options.requestId), (trx) =>
        this.pendingSystems(trx, installs, options.frameworkVersionIds),
      );
      if (pending.length === 0) continue;
      const frameworkVersionIds = [...new Set(pending.map((p) => p.system.framework_version_id))].sort();
      await this.jobs.send(
        'applicability.sync',
        {
          orgId: org.id,
          ...(options.requestId ? { requestId: options.requestId } : {}),
          payload: { frameworkVersionIds, ...(options.packInstallId ? { packInstallId: options.packInstallId } : {}) },
        },
        { singletonKey: syncJobKey(org.id, frameworkVersionIds), retryLimit: 3 },
      );
      queued.push(org.id);
    }
    if (queued.length > 0) this.logger.log({ organisations: queued.length, packInstallId: options.packInstallId ?? null }, 'applicability.sync queued');
    return { organisations: queued };
  }

  /** The job: syncs every waiting system of the organisation on the job's framework versions. */
  async sync(orgId: string | null, payload: { frameworkVersionIds: readonly string[] }, requestId?: string): Promise<SyncResult> {
    if (!orgId) throw new Error('applicability.sync needs the organisation of the job envelope');
    const org = await this.tenants.resolveById(orgId);
    if (!org || org.status !== 'active') return { skipped: 'inactive', systems: [] };
    if (org.demoDeployLabel) return { skipped: 'demo', systems: [] };
    const versions = payload.frameworkVersionIds.length > 0 ? payload.frameworkVersionIds : undefined;
    const installs = await this.editionInstalls(versions, requestId);
    const today = await this.clock.today(org.id);
    return this.scope.withTenant(systemContextOf(org, requestId), async (trx) => {
      const pending = await this.pendingSystems(trx, installs, versions);
      const systems: SystemSyncResult[] = [];
      for (const item of pending) systems.push(await this.syncSystem(trx, org, item, today));
      return { systems };
    });
  }

  /** One system: entries, cycle items, the audit entry, the notice and the recomputations. */
  private async syncSystem(trx: Trx, org: TenantInfo, item: PendingSystem, today: string): Promise<SystemSyncResult> {
    const { system, installs } = item;
    const latest = installs[installs.length - 1]!;
    const seeded = await seedApplicability(trx, system.id, { actorUserId: SYSTEM_USER_ID });
    const changes = installs.map((i) => i.changes).filter((c): c is PackContentChanges => c !== null);
    // The cycle requirements new in the waiting installations; every one of the edition when a change summary is missing.
    const newCycleCodes = changes.length === installs.length ? new Set(changes.flatMap((c) => c.cycleRequirementsAdded)) : null;
    const cycleItems = await this.addCycleItems(trx, system, today, newCycleCodes);
    const retitled = unite(changes.map((c) => c.retitled));
    const retired = unite(changes.map((c) => c.retired));
    const restored = unite(changes.map((c) => c.restored));
    const entriesAdded = seeded.added.map((e) => e.code);

    await this.audit.record(trx, {
      action: 'pack.content_synced',
      actor: { userId: SYSTEM_USER_ID, kind: 'system' },
      msId: system.id,
      entityType: 'management_system',
      entityId: system.id,
      entityCode: system.code,
      after: {
        framework_version_id: system.framework_version_id,
        pack_id: latest.packId,
        pack_version: latest.version,
        pack_install_id: latest.id,
        pack_install_ids: installs.map((i) => i.id),
        entries_added: entriesAdded.length,
        added: entriesAdded.slice(0, AUDIT_CODES),
        cycle_items_added: cycleItems.slice(0, AUDIT_CODES),
        retitled: retitled.slice(0, AUDIT_CODES),
        retired: retired.slice(0, AUDIT_CODES),
        restored: restored.slice(0, AUDIT_CODES),
      },
      edition: `${latest.packId} ${latest.version}`,
    });

    let notified = 0;
    const changed = entriesAdded.length + cycleItems.length + retitled.length + retired.length + restored.length > 0;
    if (changed) {
      const notice = noticeText(system.code, latest, { entriesAdded, cycleItems, retitled, retired, restored });
      for (const userId of await msManagers(trx, system.id)) {
        const id = await this.notifications.create(trx, {
          recipientUserId: userId,
          kind: 'pack_content_updated',
          msId: system.id,
          title: notice.title,
          body: notice.body,
          createdBy: SYSTEM_USER_ID,
        });
        if (id) notified += 1;
      }
    }
    if (entriesAdded.length > 0) {
      // New entries feed freshness and clause readiness (R-18); both jobs are debounced per system.
      await this.jobs.send(
        'freshness.recompute',
        { orgId: org.id, requestedBy: SYSTEM_USER_ID, payload: { msId: system.id, entryIds: seeded.added.map((e) => e.id) } },
        { singletonKey: `fr:${org.id}:${system.id}`, startAfterSeconds: 5 },
        trx,
      );
      await this.jobs.send(
        'readiness.recompute',
        { orgId: org.id, requestedBy: SYSTEM_USER_ID, payload: { msId: system.id } },
        { singletonKey: `rr:${org.id}:${system.id}`, startAfterSeconds: 60 },
        trx,
      );
    }
    this.logger.log(
      { orgId: org.id, msId: system.id, version: latest.version, entries: entriesAdded.length, cycleItems: cycleItems.length, notified },
      'applicability.sync: system synced',
    );
    return { msId: system.id, slug: system.slug, packId: latest.packId, version: latest.version, entriesAdded, cycleItemsAdded: cycleItems, retitled, retired, restored, notified };
  }

  /**
   * Cycle items for the new cycle requirements (`codes`; null: every one of the edition) that an open cycle (`planned`
   * or `active`) has never held: owner the primary MS Manager, due on the next audit event of the system, else at the
   * cycle end (D.4). An item the team removed from a cycle is not added again. Returns the codes added.
   */
  private async addCycleItems(trx: Trx, system: SystemRow, today: string, codes: ReadonlySet<string> | null): Promise<string[]> {
    if (codes && codes.size === 0) return [];
    const cycles = await trx
      .selectFrom('certification_cycle')
      .select(['id', 'cycle_end'])
      .where('management_system_id', '=', system.id)
      .where('status', 'in', ['planned', 'active'])
      .where('deleted_at', 'is', null)
      .orderBy('cycle_start')
      .execute();
    if (cycles.length === 0) return [];
    const defs = await trx
      .selectFrom('ref.cycle_requirement_def')
      .select(['id', 'code', 'requirement_code', 'title'])
      .where('framework_version_id', '=', system.framework_version_id)
      .orderBy('sort_order')
      .orderBy('code')
      .execute()
      .then((rows) => (codes ? rows.filter((d) => codes.has(d.code)) : rows));
    if (defs.length === 0) return [];
    // Removed items count as held, so the sync never brings back an item the team deleted.
    const held = await trx
      .selectFrom('cycle_requirement_status')
      .select(['certification_cycle_id', 'cycle_requirement_def_id'])
      .where('management_system_id', '=', system.id)
      .where('cycle_requirement_def_id', 'is not', null)
      .execute();
    const have = new Set(held.map((h) => `${h.certification_cycle_id} ${h.cycle_requirement_def_id}`));
    const owner = await trx
      .selectFrom('user_ms_role')
      .select('user_id')
      .where('management_system_id', '=', system.id)
      .where('role', '=', 'ms_manager')
      .where('is_primary', '=', true)
      .where('approval_status', '=', 'active')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const next = await sql<{ position: number }>`
      select coalesce(max(position), -1)::int + 1 as position from cycle_requirement_status where management_system_id = ${system.id}`.execute(trx);
    let position = next.rows[0]?.position ?? 0;
    const added: string[] = [];
    for (const cycle of cycles) {
      const missing = defs.filter((d) => !have.has(`${cycle.id} ${d.id}`));
      if (missing.length === 0) continue;
      const event = await sql<{ due: string | null }>`
        select min(scheduled_at)::text as due from audit_event
         where management_system_id = ${system.id} and deleted_at is null and scheduled_at >= ${today}::date
           and (certification_cycle_id = ${cycle.id} or certification_cycle_id is null)`.execute(trx);
      const due = event.rows[0]?.due ?? cycle.cycle_end;
      await trx
        .insertInto('cycle_requirement_status')
        .values(
          missing.map((d) => ({
            management_system_id: system.id,
            certification_cycle_id: cycle.id,
            cycle_requirement_def_id: d.id,
            requirement_code: d.requirement_code ?? '-',
            title: d.title,
            owner_user_id: owner?.user_id ?? null,
            status: 'not_started' as const,
            due_at: due,
            position: position++,
            created_by: SYSTEM_USER_ID,
            updated_by: SYSTEM_USER_ID,
          })),
        )
        .execute();
      added.push(...missing.map((d) => d.code));
    }
    return unite([added]);
  }
}

/** The `pack_content_updated` notice in both languages. */
export function noticeText(
  systemCode: string,
  install: Pick<EditionInstall, 'packId' | 'version'>,
  change: { entriesAdded: readonly string[]; cycleItems: readonly string[]; retitled: readonly string[]; retired: readonly string[]; restored: readonly string[] },
): { title: { en: string; id: string }; body: { en: string; id: string } } {
  const en: string[] = [];
  const id: string[] = [];
  const moreEn = (n: number) => `and ${n} more`;
  const moreId = (n: number) => `dan ${n} lainnya`;
  if (change.entriesAdded.length > 0) {
    en.push(`${change.entriesAdded.length} new ${change.entriesAdded.length === 1 ? 'entry' : 'entries'}: ${codeList(change.entriesAdded, moreEn)}.`);
    id.push(`${change.entriesAdded.length} entri baru: ${codeList(change.entriesAdded, moreId)}.`);
  }
  if (change.retitled.length > 0) {
    en.push(`New titles: ${codeList(change.retitled, moreEn)}.`);
    id.push(`Judul baru: ${codeList(change.retitled, moreId)}.`);
  }
  if (change.retired.length > 0) {
    en.push(`No longer in the standard: ${codeList(change.retired, moreEn)}. Their entries stay and are marked as such.`);
    id.push(`Tidak lagi ada dalam standar: ${codeList(change.retired, moreId)}. Entrinya tetap ada dan diberi tanda tersebut.`);
  }
  if (change.restored.length > 0) {
    en.push(`Back in the standard: ${codeList(change.restored, moreEn)}.`);
    id.push(`Kembali ada dalam standar: ${codeList(change.restored, moreId)}.`);
  }
  if (change.cycleItems.length > 0) {
    en.push(`New certification cycle items: ${codeList(change.cycleItems, moreEn)}.`);
    id.push(`Butir siklus sertifikasi baru: ${codeList(change.cycleItems, moreId)}.`);
  }
  if (change.entriesAdded.length > 0) {
    en.push('New entries start as not started and without an owner.');
    id.push('Entri baru dimulai dengan status belum dimulai dan tanpa pemilik.');
  }
  return {
    title: {
      en: `${systemCode}: framework content updated to ${install.packId} ${install.version}`,
      id: `${systemCode}: konten kerangka diperbarui ke ${install.packId} ${install.version}`,
    },
    body: { en: en.join(' '), id: id.join(' ') },
  };
}
