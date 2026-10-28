import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import type { Command } from 'commander';
import { AUDIT_WRITER, type AuditWriter } from '../common/tokens';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { DiagnosticsService, type DiagnosticsArchive } from '../modules/ops/diagnostics.service';
import { createOpsCliContext, describeError } from './tenant';

/**
 * `diagnostics --out <file>` (Milestone 2 D.3, K.6, M2-S09; open follow-up of CLAUDE.md): the redacted archive of
 * `POST /ops/diagnostics`, written by the command line without the api, for example when the api does not start. It
 * holds the same files, built by the same `DiagnosticsService` in a process of run mode `cli`: the profile without
 * secrets, versions, migration state, queue statistics, installation health as this process sees it, its own log lines
 * (the api's ring buffer is in the api process) and its metrics. Every file is scrubbed by `SecretScrubber`.
 *
 * `--out -` writes the archive to standard output (saas-ops.sh stores it on the server that way, outside the
 * container). A file is written with mode 0600 through a temporary name, never over an existing file unless `--force`.
 * The export is audited `ops.diagnostics_exported` (actor kind `operator`, no user) like the route; when the database
 * cannot be reached the archive is still written, without the audit entry, and the command says so.
 */
export function register(program: Command): void {
  program
    .command('diagnostics')
    .description('Write the redacted diagnostics archive (profile without secrets, versions, migrations, queues, health, logs, metrics) without the api')
    .requiredOption('--out <file>', 'archive file to write (.tar.gz), or - for standard output')
    .option('--force', 'replace the file when it exists')
    .action(async (options: DiagnosticsOptions) => {
      const config = loadConfigOrExit('cli');
      try {
        const written = await writeDiagnostics(config, options);
        const lines = [
          options.out === '-'
            ? `diagnostics: archive ${written.archive.fileName} written to standard output`
            : `diagnostics: archive written to ${written.file}`,
          `Size: ${written.archive.data.length} bytes, SHA-256 ${written.archive.sha256}, ${written.archive.files.length} files, ${written.archive.logLines} log lines`,
          written.audited
            ? 'Audited as ops.diagnostics_exported.'
            : `No audit entry was written (${written.auditError ?? 'the database cannot be reached'}).`,
          'Review every file before you send the archive to support.',
        ];
        // With the archive on standard output, the report goes to standard error.
        (options.out === '-' ? process.stderr : process.stdout).write(`${lines.join('\n')}\n`);
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`diagnostics failed: ${describeError(error)}\n`);
        process.exit(1);
      }
    });
}

export interface DiagnosticsOptions {
  /** Archive file, or `-` for standard output. */
  out: string;
  force?: boolean;
}

export interface DiagnosticsWritten {
  archive: DiagnosticsArchive;
  /** The absolute path written; null for standard output. */
  file: string | null;
  audited: boolean;
  auditError: string | null;
}

/**
 * Builds the archive in a command context (`context` replaces it in tests), audits the export when the database
 * answers and writes the archive (`write` replaces standard output in tests).
 */
export async function writeDiagnostics(
  config: MscdConfig,
  options: DiagnosticsOptions,
  context?: INestApplicationContext,
  write: (data: Buffer) => Promise<void> = writeStdout,
): Promise<DiagnosticsWritten> {
  const target = options.out === '-' ? null : path.resolve(options.out);
  if (target) await assertWritable(target, options.force === true);
  const app = context ?? (await createOpsCliContext(config));
  try {
    const archive = await app.get(DiagnosticsService, { strict: false }).build();
    let audited = false;
    let auditError: string | null = null;
    try {
      await app.get<AuditWriter>(AUDIT_WRITER, { strict: false }).recordDetached({
        action: 'ops.diagnostics_exported',
        actor: { userId: null, kind: 'operator' },
        organizationId: null,
        entityType: 'diagnostics',
        entityCode: archive.fileName.slice(0, 80),
        after: { fileName: archive.fileName, sha256: archive.sha256, bytes: archive.data.length, files: archive.files.length, logLines: archive.logLines, via: 'cli' },
      });
      audited = true;
    } catch (error) {
      auditError = error instanceof Error ? error.message : String(error);
    }
    if (target) await writeFileAtomic(target, archive.data);
    else await write(archive.data);
    return { archive, file: target, audited, auditError };
  } finally {
    if (!context) await app.close();
  }
}

/** Refuses an existing file (unless `force`) and a folder that does not exist, before the archive is built. */
async function assertWritable(file: string, force: boolean): Promise<void> {
  const found = await stat(file).catch(() => null);
  if (found?.isDirectory()) throw new Error(`${file} is a folder; name the archive file, for example ${path.join(file, 'mscd-diagnostics.tar.gz')}`);
  if (found && !force) throw new Error(`${file} exists; choose another name or add --force`);
  const folder = await stat(path.dirname(file)).catch(() => null);
  if (!folder?.isDirectory()) throw new Error(`The folder ${path.dirname(file)} does not exist`);
}

/** Writes `data` to `file` with mode 0600 through a temporary name in the same folder. */
async function writeFileAtomic(file: string, data: Buffer): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(temporary, { mode: 0o600, flags: 'wx' });
      stream.on('error', reject);
      stream.end(data, () => resolve());
    });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Writes the archive to standard output and waits until it is flushed. */
function writeStdout(data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(data, (error) => (error ? reject(error) : resolve()));
  });
}
