// Bulk import routes (Milestone 2 D.1, D2-13, M2-08): the XLSX template of a kind, the upload with its dry run, the
// state of an import and its commit.
// - `imports.templates` (`ms.read`): the template of `import-template.ts`, as an attachment (F.13, audited).
// - `imports.create` (the kind's permission at the guard, `permissionBy` on the path member `kind`): reads one CSV or
//   XLSX file of at most 5 MB and 5,000 rows, refuses a file already committed to the system (409, by its SHA-256),
//   checks every row (`import-check.ts`), stores an `import_run` with the results and audits `import.validated`.
//   Applicability, documents and risks need the permission in full; evidence also takes holders of their own records,
//   who import evidence they own (F.6).
// - `imports.get` and `imports.commit` (`ms.read` at the guard): 404 to anyone but the creator. The commit checks the
//   kind's permission again, refuses an import that is not waiting for a commit, older than a day, with a row in
//   error or whose file was committed since (409 or 422), marks it `committing` and queues `import.run` with a
//   background task (202 with the task id); the worker applies every row in one transaction (`import-run.job.ts`).
//   It locks the import's row with NOWAIT, so a commit sent while the worker holds that row answers 409 at once.
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_IMPORT_BYTES, XLSX_MEDIA_TYPE, type CommandResult, type ImportKind, type ImportRowResult, type ImportRun, type ImportRunStatus, type Messages,
  type Permission, type RuleId,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { FileResponder, sanitiseFileName } from '../../common/file-response';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { ConflictError, ForbiddenError, NotFoundError, ProblemError, ValidationError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import {
  AUDIT_WRITER, LICENCE_GATE, PERMISSION_EVALUATOR, RECORD_RESOLVER, type AuditWriter, type AuthzState, type LicenceGate, type PermissionEvaluator,
  type Principal, type RecordResolver, type Trx,
} from '../../common/tokens';
import { RuleEngine } from '../rules';
import { tenantContextOf } from '../tenancy/tenant-scope';
import { checkRows, countsOf, type CheckContext, type PlannedRow } from './import-check';
import { KIND_NAMES, mapColumns } from './import-columns';
import { readImportFile } from './import-file';
import { loadLookups } from './import-lookups';
import { templateFileName, templateXlsx, type TemplateLang } from './import-template';
import { ImportTenantScope } from './import-tenant-scope';

/** The permission each import kind needs (Milestone 2 D.1, the `permissionBy` cases of `imports.create`). */
export const IMPORT_PERMISSIONS: Readonly<Record<ImportKind, Permission>> = {
  applicability: 'applicability.manage',
  documents: 'document.manage',
  risks: 'risk.manage',
  evidence: 'evidence.manage',
};

/** Hours a checked import waits for its commit; after that it is `expired` and the file is checked again. */
export const IMPORT_VALID_HOURS = 24;

/** The kinds a holder of the permission for own records may import (their own records only): evidence (F.6). */
const OWN_KINDS: ReadonlySet<ImportKind> = new Set(['evidence']);

function pair(en: string, id: string): Messages {
  return { en, id };
}

/** 422 with a message in both languages. */
function unprocessable(messageKey: string, messages: Messages): ProblemError {
  return new ProblemError('business-rule', { messageKey, messages, detail: messages.en });
}

/** 409 with a message in both languages. */
function conflict(messageKey: string, messages: Messages): ConflictError {
  return new ConflictError(messages.en, { messageKey, messages });
}

/** 409 for a commit of an import whose commit has started (its status is `committing`, or the worker holds its row). */
function beingCommitted(): ConflictError {
  return conflict('imports.not_waiting', pair('This import is being committed.', 'Impor ini sedang diproses.'));
}

/** SQLSTATE `lock_not_available`: a `for update nowait` found the row locked by another transaction. */
const LOCK_NOT_AVAILABLE = '55P03';

/** What the commit records on its background task (`background_task.result`). */
export interface ImportTaskResult {
  summary?: { created: number; updated: number; unchanged: number };
  changed?: string[];
  failure?: Messages;
}

/** An `import_run` row with its task, as the reads use it. */
interface RunRow {
  id: string;
  kind: ImportKind;
  file_name: string;
  file_sha256: string;
  status: ImportRunStatus;
  row_count: number;
  results: PlannedRow[];
  created_at: Date;
  committed_at: Date | null;
  background_task_id: string | null;
  task_progress: number | null;
  task_result: ImportTaskResult | null;
}

/** The ImportRun of the api (D.1) of a stored row: every row's result without the request the commit sends. */
export function importRunOf(row: RunRow, now: Date): ImportRun {
  const results: ImportRowResult[] = (row.results ?? []).map((r) => ({
    row: r.row,
    status: r.status,
    messages: r.messages,
    ...(r.code ? { code: r.code } : {}),
    ...(r.action ? { action: r.action } : {}),
  }));
  const status: ImportRunStatus = row.status === 'validated' && expired(row.created_at, now) ? 'expired' : row.status;
  const task = row.task_result ?? {};
  return {
    id: row.id,
    kind: row.kind,
    fileName: row.file_name,
    status,
    rowCount: row.row_count,
    counts: countsOf(row.results ?? []),
    results,
    createdAt: new Date(row.created_at).toISOString(),
    committedAt: row.committed_at ? new Date(row.committed_at).toISOString() : null,
    taskId: row.background_task_id,
    ...(row.task_progress !== null && row.task_progress !== undefined ? { progress: Number(row.task_progress) } : {}),
    ...(row.status === 'committed' && task.summary ? { summary: task.summary } : {}),
    ...(row.status === 'committed' && task.changed ? { changed: task.changed } : {}),
    ...(row.status === 'failed' && task.failure ? { failure: task.failure } : {}),
  };
}

function expired(createdAt: Date, now: Date): boolean {
  return now.getTime() - new Date(createdAt).getTime() > IMPORT_VALID_HOURS * 3600 * 1000;
}

/**
 * The language of a template: the `lang` query (the app language, which the screen sends), else Indonesian when
 * `Accept-Language` prefers it, else English (D.1).
 */
export function templateLanguage(request: FastifyRequest, lang?: TemplateLang): TemplateLang {
  if (lang) return lang;
  const header = String(request.headers['accept-language'] ?? '');
  const tags = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: (tag ?? '').toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((t) => t.tag && Number.isFinite(t.q) && t.q > 0)
    .sort((a, b) => b.q - a.q);
  return tags[0]?.tag.startsWith('id') ? 'id' : 'en';
}

/** Reads the upload form: one file part named `file` (at most 5 MB, else 413) and nothing else. */
async function readUpload(request: FastifyRequest): Promise<{ bytes: Buffer; fileName: string }> {
  if (!request.isMultipart()) {
    throw new ValidationError([{ path: 'body', message: 'Send the import as multipart/form-data with the file in the field file' }]);
  }
  const tooLarge = () => new ProblemError('payload-too-large', {
    messageKey: 'imports.too_large',
    messages: pair('The file is larger than 5 MB. Split it into several files.', 'Berkas lebih besar dari 5 MB. Bagi menjadi beberapa berkas.'),
    detail: 'The file is larger than 5 MB',
  });
  let bytes: Buffer | null = null;
  let fileName = '';
  const fields: string[] = [];
  try {
    for await (const part of request.parts({ limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 4, parts: 5 } })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') {
          await part.toBuffer().catch(() => undefined);
          throw new ValidationError([{ path: `body.${part.fieldname}`, message: 'Unknown file field: the import file goes in the field file' }]);
        }
        bytes = await part.toBuffer();
        if (part.file.truncated) throw tooLarge();
        fileName = part.filename ?? '';
      } else {
        fields.push(part.fieldname);
      }
    }
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
    if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') {
      throw new ValidationError([{ path: 'body', message: 'The import form has one file field, file' }]);
    }
    throw error;
  }
  if (fields.length > 0) throw new ValidationError(fields.map((name) => ({ path: `body.${name}`, message: 'Unknown form field: the import form has only the file field file' })));
  if (!bytes) throw new ValidationError([{ path: 'body.file', message: 'The file field file is missing' }]);
  return { bytes, fileName: sanitiseFileName(fileName || 'import').slice(0, 255) };
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly scope: ImportTenantScope,
    private readonly rules: RuleEngine,
    private readonly clock: Clock,
    private readonly files: FileResponder,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/imports/templates/{kind}
  // -------------------------------------------------------------------------------------------------------------

  async template(reply: FastifyReply, principal: Principal, ms: string, kind: ImportKind, lang: TemplateLang): Promise<FastifyReply> {
    const { lookups } = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      return { lookups: await loadLookups(trx, system.id, kind) };
    });
    const body = await templateXlsx(kind, lookups, lang, { creator: principal.user.displayName, created: this.clock.now() });
    const fileName = templateFileName(lookups.system.code, kind);
    return this.files.send(reply, {
      body,
      storedType: XLSX_MEDIA_TYPE,
      fileName,
      size: body.length,
      audit: { msId: lookups.system.id, entityType: 'import_template', entityCode: kind, after: { fileName, kind } },
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/imports/{kind}
  // -------------------------------------------------------------------------------------------------------------

  async upload(request: FastifyRequest, principal: Principal, authz: AuthzState | null, ms: string, kind: ImportKind): Promise<ImportRun> {
    const decision = authz?.granted.get(IMPORT_PERMISSIONS[kind]) ?? (await this.evaluator.evaluate(principal, IMPORT_PERMISSIONS[kind], { scope: 'ms', ms }));
    this.assertMayImport(kind, decision);
    const { bytes, fileName } = await readUpload(request);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const file = await readImportFile(bytes, fileName);
    const columns = mapColumns(kind, file.headers);
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      await this.assertNotImported(trx, system.id, kind, digest);
      const lookups = await loadLookups(trx, system.id, kind);
      const ctx = this.checkContext(trx, principal, kind, lookups, decision === 'own');
      const results = await checkRows(ctx, file, columns);
      const counts = countsOf(results);
      const actor = principal.user.id;
      const row = await trx
        .insertInto('import_run')
        .values({
          management_system_id: system.id, kind, file_name: fileName, file_sha256: digest, status: 'validated', row_count: results.length,
          results: JSON.stringify(results), created_by: actor, updated_by: actor,
        })
        .returning(['id', 'created_at'])
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        action: 'import.validated',
        msId: system.id,
        entityType: 'import_run',
        entityId: row.id,
        entityCode: fileName.slice(0, 80),
        after: { kind, file_name: fileName, file_sha256: digest, format: file.format, rows: results.length, ...counts },
      });
      return importRunOf({
        id: row.id, kind, file_name: fileName, file_sha256: digest, status: 'validated', row_count: results.length, results,
        created_at: row.created_at, committed_at: null, background_task_id: null, task_progress: null, task_result: null,
      }, this.clock.now());
    });
  }

  /** 403 unless the caller may import this kind: the permission in full, or for evidence also for own records. */
  private assertMayImport(kind: ImportKind, decision: 'full' | 'own' | null): void {
    if (decision === 'full' || (decision === 'own' && OWN_KINDS.has(kind))) return;
    const name = KIND_NAMES[kind];
    throw new ForbiddenError(`Importing ${name[0].toLowerCase()} needs ${IMPORT_PERMISSIONS[kind]} for every record of the system`, {
      messageKey: 'imports.permission',
      messages: pair(
        `Importing ${name[0].toLowerCase()} needs the right to manage every record of this kind in the system.`,
        `Mengimpor ${name[1].toLowerCase()} memerlukan hak mengelola setiap catatan jenis ini di sistem.`,
      ),
    });
  }

  /** 409 when the same file (by its SHA-256) was already committed to the system for this kind. */
  private async assertNotImported(trx: Trx, msId: string, kind: ImportKind, digest: string): Promise<void> {
    const { rows } = await sql<{ id: string; committed_at: Date }>`
      select id, committed_at from import_run
       where management_system_id = ${msId} and kind = ${kind} and file_sha256 = ${digest} and status = 'committed' and deleted_at is null
       limit 1`.execute(trx);
    if (rows.length > 0) {
      const day = new Date(rows[0]!.committed_at).toISOString().slice(0, 10);
      throw conflict('imports.already_imported', pair(
        `This file was already imported into this system on ${day}. A file is imported once; change it to import it again.`,
        `Berkas ini sudah diimpor ke sistem ini pada ${day}. Sebuah berkas diimpor sekali; ubah berkasnya untuk mengimpor lagi.`,
      ));
    }
  }

  /** The rule engine, permissions and licence of the check, inside the upload's transaction. */
  private checkContext(trx: Trx, principal: Principal, kind: ImportKind, lookups: CheckContext['lookups'], ownOnly: boolean): CheckContext {
    const findings = new Map<string, Messages | null>();
    const linkable = new Map<string, boolean>();
    let integrated: Messages | null | undefined;
    return {
      kind,
      lookups,
      caller: { handle: principal.user.handle, ownOnly },
      rule: async (rule: RuleId, input: unknown) => {
        const key = `${rule}\u0000${JSON.stringify(input)}`;
        if (!findings.has(key)) {
          const found = await this.rules.evaluate(trx, rule, input, { msIds: [lookups.system.id] });
          findings.set(key, found[0]?.messages ?? null);
        }
        return findings.get(key)!;
      },
      canLinkDocuments: async (slug: string) => {
        if (!linkable.has(slug)) linkable.set(slug, (await this.evaluator.evaluate(principal, 'document.manage', { scope: 'ms', ms: slug })) === 'full');
        return linkable.get(slug)!;
      },
      integratedMode: async () => {
        if (integrated === undefined) {
          try {
            await this.licence.assertFeature(principal.org!.id, 'integrated_mode', trx);
            integrated = null;
          } catch (error) {
            if (!(error instanceof ProblemError)) throw error;
            integrated = error.extras.messages ?? pair(error.message, error.message);
          }
        }
        return integrated;
      },
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/imports/{id}
  // -------------------------------------------------------------------------------------------------------------

  async get(principal: Principal, ms: string, id: string): Promise<ImportRun> {
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      return importRunOf(await this.runOf(trx, principal, system.id, id, false), this.clock.now());
    });
  }

  /**
   * The caller's import of the system; 404 for anyone but its creator (D.1). With `forUpdate` the row is locked
   * without waiting: the worker's transaction holds it while it applies the rows (up to minutes, longer than the
   * 30-second `statement_timeout` of the application role), so a commit sent meanwhile answers 409 at once.
   */
  private async runOf(trx: Trx, principal: Principal, msId: string, id: string, forUpdate: boolean): Promise<RunRow> {
    let rows: RunRow[];
    try {
      ({ rows } = await sql<RunRow>`
        select r.id, r.kind, r.file_name, r.file_sha256, r.status, r.row_count, r.results, r.created_at, r.committed_at, r.background_task_id,
               t.progress as task_progress, t.result as task_result
          from import_run r left join background_task t on t.id = r.background_task_id
         where r.id = ${id} and r.management_system_id = ${msId} and r.created_by = ${principal.user.id} and r.deleted_at is null
         ${forUpdate ? sql`for update of r nowait` : sql``}`.execute(trx));
    } catch (error) {
      if (forUpdate && (error as { code?: string }).code === LOCK_NOT_AVAILABLE) throw beingCommitted();
      throw error;
    }
    const row = rows[0];
    if (!row) throw new NotFoundError('No such import');
    return row;
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/imports/{id}/commit
  // -------------------------------------------------------------------------------------------------------------

  async commit(principal: Principal, ms: string, id: string): Promise<CommandResult> {
    const org = principal.org;
    if (!org) throw new NotFoundError('No organisation is selected');
    const actor = principal.user.id;
    const outcome = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const run = await this.runOf(trx, principal, system.id, id, true);
      // The guard checked ms.read only (J.1): the kind's permission is checked again here.
      this.assertMayImport(run.kind, await this.evaluator.evaluate(principal, IMPORT_PERMISSIONS[run.kind], { scope: 'ms', ms }));
      if (run.status === 'committing') throw beingCommitted();
      if (run.status !== 'validated') {
        throw conflict('imports.not_waiting', run.status === 'committed'
          ? pair('This import was already committed.', 'Impor ini sudah dikonfirmasi.')
          : pair('This import can no longer be committed. Check the file again.', 'Impor ini tidak dapat dikonfirmasi lagi. Periksa berkasnya lagi.'));
      }
      if (expired(run.created_at, this.clock.now())) {
        await trx.updateTable('import_run').set({ status: 'expired', updated_at: this.clock.now(), updated_by: actor }).where('id', '=', run.id).execute();
        return { expired: true as const };
      }
      const errors = (run.results ?? []).filter((r) => r.status === 'error').length;
      if (errors > 0) {
        throw unprocessable('imports.rows_with_errors', pair(
          `${errors} ${errors === 1 ? 'row has' : 'rows have'} an error. Correct the file and check it again; nothing is imported while a row has an error.`,
          `${errors} baris memiliki kesalahan. Perbaiki berkas dan periksa lagi; tidak ada yang diimpor selama ada baris yang salah.`,
        ));
      }
      await this.assertNotImported(trx, system.id, run.kind, run.file_sha256);
      const task = await trx
        .insertInto('background_task')
        .values({
          kind: 'import', management_system_id: system.id, status: 'queued', params: JSON.stringify({ importId: run.id }), created_by: actor, updated_by: actor,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const jobId = await this.queue.send(
        'import.run',
        { orgId: org.id, requestId: currentRequestId(), requestedBy: actor, payload: { importId: run.id, taskId: task.id } },
        { singletonKey: `im:${run.id}`, retryLimit: 1 },
        trx,
      );
      if (jobId) await trx.updateTable('background_task').set({ job_id: jobId.slice(0, 80) }).where('id', '=', task.id).execute();
      await trx
        .updateTable('import_run')
        .set({ status: 'committing', background_task_id: task.id, updated_at: this.clock.now(), updated_by: actor })
        .where('id', '=', run.id)
        .execute();
      const name = KIND_NAMES[run.kind];
      const applied = (run.results ?? []).filter((r) => r.apply).length;
      const result: CommandResult = {
        ok: true,
        changed: [],
        taskId: task.id,
        message: [
          `Importing ${applied} ${applied === 1 ? 'row' : 'rows'} of ${name[0].toLowerCase()}; you will get a notification when it is done`,
          `Mengimpor ${applied} baris ${name[1].toLowerCase()}; Anda akan menerima notifikasi setelah selesai`,
        ],
      };
      return { expired: false as const, result };
    });
    if (outcome.expired) {
      throw conflict('imports.expired', pair(
        `This check is older than ${IMPORT_VALID_HOURS} hours. Check the file again before importing it.`,
        `Pemeriksaan ini lebih lama dari ${IMPORT_VALID_HOURS} jam. Periksa berkasnya lagi sebelum mengimpor.`,
      ));
    }
    return outcome.result;
  }
}
