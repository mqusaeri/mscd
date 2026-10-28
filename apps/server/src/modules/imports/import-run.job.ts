// `import.run` (Milestone 2 J.3, D2-13, M2-08; payload `{importId, taskId}`, singleton key `im:<importId>`, one
// retry): applies every row of a checked import in one transaction through the existing command services, or none.
//
// 1. In a transaction of the system user: the import must still be `committing`; its background task becomes
//    `running`. The creator is rebuilt as a principal without a session and must still be an active member holding
//    the kind's permission (else the import fails without a retry).
// 2. In one tenant transaction of the creator (`ImportTenantScope.inOneTransaction`), with the creator as the actor of
//    the request context, so every audit entry names the person who imported: each row's request goes to its command
//    service (`applicability.create` and `.update`, `documents.create`, `registers.create` for risks,
//    `evidence.create`), which runs its business rules, writes its audit entry and queues its jobs as for a request;
//    an update carries the ETag of the entry as checked, so a change made since then fails the import. Progress is
//    written in transactions of its own every 5 percent. At the end the import becomes `committed` (the unique index
//    refuses a second commit of the same file), the task `succeeded` with the counts, `import.committed` is audited,
//    the creator gets `import_finished`, and `freshness.recompute` is queued for the whole system.
//    The rows run inside `ImportHold.run` (import-hold.ts): the audit entries and the per-system recompute jobs of the
//    commands are kept until every row is in, then written in the same transaction, so the organisation's audit chain
//    is locked only for the commit's last statements and other people's audited writes do not wait for the rows.
// 3. When a row fails, nothing of the import stays: the transaction rolls back, and in a transaction of its own the
//    import becomes `failed` with the row's message (also on the row's result), the task `failed`, and the creator gets
//    `import_finished` with the reason.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CommandResult, ImportKind, Messages, UserKind } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { ProblemError } from '../../common/problems';
import { currentRequestId, runWithRequestContext } from '../../common/request-context';
import {
  AUDIT_WRITER, NOTIFICATION_WRITER, PERMISSION_EVALUATOR, SYSTEM_USER_ID, type AuditWriter, type AuthzState, type NotificationWriter,
  type PermissionEvaluator, type Principal, type TenantInfo, type Trx,
} from '../../common/tokens';
import { ApplicabilityService } from '../implementation/applicability.service';
import { freshnessRecomputeKey } from '../freshness/freshness.jobs';
import { DocumentCommandsService } from '../registers/documents.service';
import { EvidenceService } from '../risk-registers/evidence.service';
import { RegistersService } from '../risk-registers/registers.service';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { systemContextOf, tenantContextOf } from '../tenancy/tenant-scope';
import type { PlannedRow, RowApply } from './import-check';
import { KIND_NAMES } from './import-columns';
import { ImportHold } from './import-hold';
import { ImportTenantScope } from './import-tenant-scope';
import { IMPORT_PERMISSIONS, type ImportTaskResult } from './imports.service';

export interface ImportRunResult {
  importId: string;
  status: 'committed' | 'failed' | 'skipped';
  summary?: { created: number; updated: number; unchanged: number };
  failure?: Messages;
}

/** A row whose command failed: the import fails with its message. */
class RowFailure extends Error {
  constructor(readonly row: PlannedRow, readonly messages: Messages) {
    super(messages.en);
  }
}

/** A reason the whole import fails (no row to blame). */
class ImportFailure extends Error {
  constructor(readonly messages: Messages) {
    super(messages.en);
  }
}

interface Prepared {
  run: { id: string; kind: ImportKind; fileName: string; msId: string; msSlug: string; results: PlannedRow[]; createdBy: string };
  principal: Principal | null;
}

/** The messages of a command's refusal, in both languages. */
export function refusalOf(error: unknown, code: string | undefined): Messages {
  if (error instanceof ProblemError) {
    if (error.slug === 'precondition-failed') {
      return {
        en: `${code ?? 'This record'} changed after the file was checked. Check the file again to import it.`,
        id: `${code ?? 'Catatan ini'} berubah setelah berkas diperiksa. Periksa berkasnya lagi untuk mengimpornya.`,
      };
    }
    if (error.extras.messages) return error.extras.messages;
    const fields = error.extras.errors?.map((e) => e.message).join('; ');
    const text = fields ? `${error.message}: ${fields}` : error.message;
    return { en: text, id: text };
  }
  return {
    en: 'The server could not apply this row. Nothing was imported; try again later or ask your administrator.',
    id: 'Server tidak dapat menerapkan baris ini. Tidak ada yang diimpor; coba lagi nanti atau hubungi administrator Anda.',
  };
}

@Injectable()
@JobHandler('import.run', { concurrency: 1, scope: 'tenant' })
export class ImportRunJob implements JobHandlerInstance<'import.run'> {
  private readonly logger = new Logger('import.run');

  constructor(
    private readonly scope: ImportTenantScope,
    private readonly tenants: TenantResolver,
    private readonly clock: Clock,
    private readonly applicability: ApplicabilityService,
    private readonly documents: DocumentCommandsService,
    private readonly registers: RegistersService,
    private readonly evidence: EvidenceService,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    private readonly hold: ImportHold,
  ) {}

  async handle(job: JobRun<'import.run'>): Promise<void> {
    const result = await this.run(job.env.orgId, job.env.payload.importId, job.env.payload.taskId, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, importId: result.importId, status: result.status }, 'import.run done');
  }

  /** Commits one import (steps 1 to 3 above). */
  async run(orgId: string | null, importId: string, taskId: string, requestId?: string): Promise<ImportRunResult> {
    if (!orgId) throw new Error('import.run needs the organisation of the job envelope');
    const org = await this.tenants.resolveById(orgId);
    if (!org || org.status !== 'active') return { importId, status: 'skipped' };
    const requestKey = requestId ?? currentRequestId() ?? randomUUID();
    const prepared = await this.scope.withTenant(systemContextOf(org, requestKey), (trx) => this.prepare(trx, org, importId, taskId));
    if (!prepared) return { importId, status: 'skipped' };
    const { run, principal } = prepared;
    try {
      if (!principal) {
        throw new ImportFailure({
          en: 'The person who checked the file is no longer an active member, so the import was not applied.',
          id: 'Orang yang memeriksa berkas bukan lagi anggota aktif, sehingga impor tidak diterapkan.',
        });
      }
      const decision = await this.evaluator.evaluate(principal, IMPORT_PERMISSIONS[run.kind], { scope: 'ms', ms: run.msSlug }).catch(() => null);
      if (!decision || (decision === 'own' && run.kind !== 'evidence')) {
        throw new ImportFailure({
          en: 'The person who checked the file no longer holds the right to import it, so the import was not applied.',
          id: 'Orang yang memeriksa berkas tidak lagi memiliki hak untuk mengimpornya, sehingga impor tidak diterapkan.',
        });
      }
      const authz: AuthzState = { ms: run.msSlug, granted: new Map([[IMPORT_PERMISSIONS[run.kind], decision]]), ownOnly: decision === 'own' };
      const context = {
        requestId: requestKey, ip: null, userAgent: null, userId: principal.user.id, actorKind: 'user' as const, orgId: org.id, orgSlug: org.slug,
        schema: org.schema, ms: run.msSlug, routeId: 'imports.commit',
      };
      const summary = await runWithRequestContext(context, () =>
        this.scope.inOneTransaction(tenantContextOf(principal, requestKey), (trx) => this.apply(trx, org, run, principal, authz, taskId, requestKey)),
      );
      return { importId, status: 'committed', summary };
    } catch (error) {
      const failure = error instanceof RowFailure
        ? {
            en: `Row ${error.row.row}${error.row.code ? ` (${error.row.code})` : ''}: ${error.messages.en}`,
            id: `Baris ${error.row.row}${error.row.code ? ` (${error.row.code})` : ''}: ${error.messages.id}`,
          }
        : error instanceof ImportFailure
          ? error.messages
          : refusalOf(error, undefined);
      if (!(error instanceof RowFailure) && !(error instanceof ImportFailure)) {
        this.logger.error({ orgId, importId, err: error instanceof Error ? error.message : String(error) }, 'import.run failed');
      }
      await this.scope.withTenant(systemContextOf(org, requestKey), (trx) =>
        this.fail(trx, run, taskId, failure, error instanceof RowFailure ? { row: error.row.row, messages: error.messages } : null),
      );
      return { importId, status: 'failed', failure };
    }
  }

  /** Step 1: the import and its task, the task running, the creator as a principal. */
  private async prepare(trx: Trx, org: TenantInfo, importId: string, taskId: string): Promise<Prepared | null> {
    const { rows } = await sql<{ id: string; kind: ImportKind; file_name: string; ms_id: string; ms_slug: string; status: string; results: PlannedRow[]; created_by: string | null }>`
      select r.id, r.kind, r.file_name, r.management_system_id as ms_id, m.slug as ms_slug, r.status, r.results, r.created_by
        from import_run r join management_system m on m.id = r.management_system_id
       where r.id = ${importId} and r.background_task_id = ${taskId} and r.deleted_at is null
       for update of r`.execute(trx);
    const row = rows[0];
    if (!row || row.status !== 'committing' || !row.created_by) {
      this.logger.warn({ orgId: org.id, importId }, 'import.run: no import waiting for this task');
      return null;
    }
    const now = this.clock.now();
    await trx
      .updateTable('background_task')
      .set({ status: 'running', progress: 0, started_at: now, error: null, updated_at: now, updated_by: SYSTEM_USER_ID })
      .where('id', '=', taskId)
      .execute();
    const { rows: users } = await sql<{ id: string; handle: string; email: string; display_name: string; job_title: string | null; kind: UserKind }>`
      select u.id, u.handle, u.email, u.display_name, u.job_title, u.kind from platform.org_membership m join platform.app_user u on u.id = m.user_id
       where m.organization_id = ${org.id} and m.user_id = ${row.created_by} and m.status = 'active' and m.deleted_at is null
         and u.status = 'active' and u.deleted_at is null`.execute(trx);
    const user = users[0];
    return {
      run: { id: row.id, kind: row.kind, fileName: row.file_name, msId: row.ms_id, msSlug: row.ms_slug, results: row.results ?? [], createdBy: row.created_by },
      principal: user
        ? { user: { id: user.id, handle: user.handle, email: user.email, displayName: user.display_name, jobTitle: user.job_title, kind: user.kind }, org, session: null }
        : null,
    };
  }

  /** Step 2: every row through its command service, then the outcome, in the one transaction `trx`. */
  private async apply(
    trx: Trx, org: TenantInfo, run: Prepared['run'], principal: Principal, authz: AuthzState, taskId: string, requestId: string,
  ): Promise<{ created: number; updated: number; unchanged: number }> {
    // The import's row stays locked until the commit ends: a second attempt of the job waits here, and
    // `imports.commit` (which locks with NOWAIT) answers 409 `imports.not_waiting` at once.
    await sql`select id from import_run where id = ${run.id} for update`.execute(trx);
    // The audit entries and the recompute jobs of the rows are written at the end of `run`, still in `trx`.
    return this.hold.run(trx, run.id, () => this.applyRows(trx, org, run, principal, authz, taskId, requestId));
  }

  /** The rows and the outcome of step 2, inside `ImportHold.run`. */
  private async applyRows(
    trx: Trx, org: TenantInfo, run: Prepared['run'], principal: Principal, authz: AuthzState, taskId: string, requestId: string,
  ): Promise<{ created: number; updated: number; unchanged: number }> {
    const work = run.results.filter((r) => r.apply);
    const summary = { created: 0, updated: 0, unchanged: run.results.filter((r) => r.status !== 'error' && r.action === 'unchanged').length };
    const changed = new Set<string>();
    const step = Math.max(1, Math.ceil(work.length / 20));
    for (const [index, row] of work.entries()) {
      let result: CommandResult;
      try {
        result = await this.applyRow(principal, authz, run.msSlug, row.apply!);
      } catch (error) {
        throw new RowFailure(row, refusalOf(error, row.code));
      }
      for (const slug of result.changed) changed.add(slug);
      if (row.action === 'update') summary.updated += 1;
      else summary.created += 1;
      if ((index + 1) % step === 0 && index + 1 < work.length) await this.progress(org, taskId, Math.floor(((index + 1) / work.length) * 95), requestId);
    }
    changed.add(run.msSlug);
    const now = this.clock.now();
    try {
      await trx
        .updateTable('import_run')
        .set({ status: 'committed', committed_at: now, updated_at: now, updated_by: principal.user.id })
        .where('id', '=', run.id)
        .execute();
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ImportFailure({ en: 'This file was already imported into this system.', id: 'Berkas ini sudah diimpor ke sistem ini.' });
      }
      throw error;
    }
    const result: ImportTaskResult = { summary, changed: [...changed] };
    await trx
      .updateTable('background_task')
      .set({ status: 'succeeded', progress: 100, result: JSON.stringify(result), error: null, finished_at: now, updated_at: now, updated_by: SYSTEM_USER_ID })
      .where('id', '=', taskId)
      .execute();
    await this.audit.record(trx, {
      action: 'import.committed',
      msId: run.msId,
      entityType: 'import_run',
      entityId: run.id,
      entityCode: run.fileName.slice(0, 80),
      after: { kind: run.kind, file_name: run.fileName, rows: run.results.length, ...summary, task_id: taskId },
    });
    const name = KIND_NAMES[run.kind];
    await this.notifications.create(trx, {
      recipientUserId: principal.user.id,
      kind: 'import_finished',
      msId: run.msId,
      title: { en: `Import finished: ${name[0]}`, id: `Impor selesai: ${name[1]}` },
      body: {
        en: `${run.fileName}: ${summary.created} created, ${summary.updated} changed, ${summary.unchanged} left as they were.`,
        id: `${run.fileName}: ${summary.created} dibuat, ${summary.updated} diubah, ${summary.unchanged} dibiarkan apa adanya.`,
      },
      ref: { module: 'implementation', entityType: 'import_run', id: run.id, code: run.fileName.slice(0, 80) },
      createdBy: principal.user.id,
    });
    if (run.kind === 'applicability' || run.kind === 'evidence') {
      // The whole system is recomputed once the import is in. `ImportHold` keeps one such job per system (a command's
      // if one queued it first) and queues it under the key of the import (`fr:<org>:<ms>:import:<id>`).
      await this.queue.send(
        'freshness.recompute',
        { orgId: org.id, requestId, requestedBy: principal.user.id, payload: { msId: run.msId } },
        { singletonKey: freshnessRecomputeKey(org.id, run.msId), startAfterSeconds: 5 },
        trx,
      );
    }
    return summary;
  }

  /** One row's request through the command service of its kind (the module's own instances, which join `trx`). */
  private async applyRow(principal: Principal, authz: AuthzState, ms: string, apply: RowApply): Promise<CommandResult> {
    switch (apply.op) {
      case 'applicability.create': {
        const created = await this.applicability.create(principal, ms, apply.body);
        if (!apply.then || !created.ref) return created;
        const then = await this.applicability.update(principal, ms, created.ref.id, apply.then, undefined);
        return { ...then, changed: [...new Set([...created.changed, ...then.changed])] };
      }
      case 'applicability.update':
        return this.applicability.update(principal, ms, apply.entryId, apply.patch, apply.etag);
      case 'documents.create':
        return this.documents.create(principal, ms, apply.body);
      case 'risks.create':
        return this.registers.create(principal, authz, ms, 'risks', apply.body);
      case 'evidence.create':
        return this.evidence.create(principal, authz, ms, apply.body);
    }
  }

  private async progress(org: TenantInfo, taskId: string, progress: number, requestId: string): Promise<void> {
    await this.scope.detached(systemContextOf(org, requestId), (trx) =>
      trx.updateTable('background_task').set({ progress, updated_at: this.clock.now() }).where('id', '=', taskId).where('status', '=', 'running').execute(),
    );
  }

  /** Step 3: the import failed; nothing of it was applied. */
  private async fail(trx: Trx, run: Prepared['run'], taskId: string, failure: Messages, failed: { row: number; messages: Messages } | null): Promise<void> {
    const now = this.clock.now();
    // The row that failed carries the reason in its result; the request it sent is dropped with its action.
    const results = failed === null
      ? run.results
      : run.results.map((r) => (r.row === failed.row ? { row: r.row, status: 'error' as const, messages: [failed.messages, ...r.messages], ...(r.code ? { code: r.code } : {}) } : r));
    await trx
      .updateTable('import_run')
      .set({ status: 'failed', results: JSON.stringify(results), updated_at: now, updated_by: SYSTEM_USER_ID })
      .where('id', '=', run.id)
      .where('status', '=', 'committing')
      .execute();
    const result: ImportTaskResult = { failure };
    await trx
      .updateTable('background_task')
      .set({ status: 'failed', result: JSON.stringify(result), error: failure.en.slice(0, 2000), finished_at: now, updated_at: now, updated_by: SYSTEM_USER_ID })
      .where('id', '=', taskId)
      .execute();
    const name = KIND_NAMES[run.kind];
    await this.notifications.create(trx, {
      recipientUserId: run.createdBy,
      kind: 'import_finished',
      msId: run.msId,
      title: { en: `Import failed: ${name[0]}`, id: `Impor gagal: ${name[1]}` },
      body: { en: `${run.fileName}: nothing was imported. ${failure.en}`, id: `${run.fileName}: tidak ada yang diimpor. ${failure.id}` },
      ref: { module: 'implementation', entityType: 'import_run', id: run.id, code: run.fileName.slice(0, 80) },
      createdBy: SYSTEM_USER_ID,
    });
  }
}
