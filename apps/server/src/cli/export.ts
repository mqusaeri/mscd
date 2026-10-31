// Organisation export from the command line (Milestone 3 D.3, D.4):
// - `export organization --out <dir>` builds the parts and the manifest of an organisation export into a folder for
//   the customer's own IT, with the same builder as the worker job `org-export.build`. Single tenancy only: in multi
//   tenancy it refuses and names the web app, because a server folder would let the operator read tenant data. The
//   folder must be empty or new; the spool files go into a hidden working folder inside it and are removed at the end.
//   One build runs at a time in the installation (the worker's lock, `org-export/build-lock.ts`); the command refuses
//   while another one runs. Audited `organization_export.built` in the organisation's audit trail. The export names
//   the installation's public anchor key: the `cli` service has no private anchor key, so the operator passes the
//   public one with `--anchor-key <file>` (`secrets/audit-anchor.pub`); without it, a key the build does not know is
//   listed with a null PEM.
// - `export verify --dir <dir> [--anchor-key <file>]...` checks every part and entry against the manifest, every audit
//   hash, and every signed anchor with the anchor keys compiled into this build plus the public keys named with
//   `--anchor-key` (an on-premise installation signs with its own key) (`org-export/verify.ts`); a key the export brings
//   is never trusted. Exit 0 only when nothing is wrong, an anchor signed by a key that is not trusted included. The
//   output names the newest anchored row and the rows after it, which no signature covers.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Global, Module, type DynamicModule, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Command } from 'commander';
import { AUDIT_WRITER, GATEWAY_CLIENT, SYSTEM_USER_ID, type AuditWriter, type TenantInfo } from '../common/tokens';
import { Clock } from '../common/clock';
import { ConfigModule } from '../config/config.module';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { DATABASE, DatabaseModule, type AppDatabase } from '../db/database.module';
import { compiledAnchorKeys } from '../modules/audit/anchors';
import { AuditModule } from '../modules/audit/audit.module';
import { AuthzModule } from '../modules/authz/authz.module';
import { IdentityModule } from '../modules/identity/identity.module';
import { KeysModule } from '../modules/keys/keys.module';
import { LicenseModule } from '../modules/license/license.module';
import { BUILD_BUSY_MESSAGE, withBuildLock } from '../modules/org-export/build-lock';
import { checkFreeSpace, OrgExportBuilder, storedFileBytes, exportTooLarge } from '../modules/org-export/builder';
import { readAnchorKeyFile, verifyExportFolder, type VerifyReport } from '../modules/org-export/verify';
import { MetricsService } from '../modules/platform/metrics';
import { ReadinessService } from '../modules/platform/readiness.service';
import { HttpGatewayClient } from '../modules/storage/gateway-client';
import { StorageGatewayContext } from '../modules/storage/gateway-context';
import { TenancyModule } from '../modules/tenancy/tenancy.module';
import { TenantResolver } from '../modules/tenancy/tenant-resolver';
import { TenantScope, systemContextOf } from '../modules/tenancy/tenant-scope';

/** The refusal of `export organization` in multi tenancy. */
export const MULTI_TENANCY_REFUSAL =
  'In multi tenancy the organisation export is made in the web app: a Tenant Admin of the organisation opens Organisation export and requests it. ' +
  'A folder on this server would let the operator read the data of the organisation.';

/** Readiness and metrics services the database module expects, without the HTTP and metrics listeners. */
@Global()
@Module({ providers: [ReadinessService, MetricsService], exports: [ReadinessService, MetricsService] })
class ExportCliPlatformModule {}

/**
 * The modules the export command needs, as the user commands of `admin.ts` load them: database, tenancy (with the
 * common services, whose notification writer needs the membership service of authz, which needs identity and the
 * licence gate), audit (writer and anchor keys), keys, the storage gateway client and the builder.
 */
@Module({})
class ExportCliModule {
  static forRoot(config: MscdConfig): DynamicModule {
    return {
      module: ExportCliModule,
      imports: [ConfigModule.forRoot(config), ExportCliPlatformModule, DatabaseModule, TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule],
      providers: [HttpGatewayClient, { provide: GATEWAY_CLIENT, useExisting: HttpGatewayClient }, StorageGatewayContext, OrgExportBuilder],
    };
  }
}

/** A Nest application context for the export command (run mode `cli`, no listeners). */
export async function createExportContext(config: MscdConfig): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(ExportCliModule.forRoot(config), { logger: ['error'], abortOnError: false });
}

export interface ExportOrganizationOptions {
  out?: string;
  org?: string;
  /** The installation's public anchor key file (`secrets/audit-anchor.pub`), named in the export. */
  anchorKey?: string;
}

export interface ExportOrganizationResult {
  dir: string;
  orgSlug: string;
  exportId: string;
  parts: { name: string; sizeBytes: number; sha256: string }[];
  manifestFile: string;
  files: number;
  sizeBytes: number;
  /** Key ids of anchors whose public key the export could not carry (no `--anchor-key` and no key file). */
  anchorKeyIdsWithoutKey: string[];
}

async function emptyOrNew(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  if (entries.length > 0) throw new Error(`The folder ${dir} is not empty; give an empty or new folder`);
}

/**
 * `export organization` with a loaded configuration. Refuses in multi tenancy, and while another organisation export
 * is being built in the installation (one build at a time, the worker's included: `build-lock.ts`). `context`
 * replaces the application context the command builds, `partBytes` the part size of the profile (tests).
 */
export async function exportOrganization(
  config: MscdConfig,
  options: ExportOrganizationOptions,
  context?: INestApplicationContext,
  partBytes?: number,
): Promise<ExportOrganizationResult> {
  if (config.profile.tenancy.mode === 'multi') throw new Error(MULTI_TENANCY_REFUSAL);
  if (!options.out) throw new Error('Give the folder to write to with --out <dir>');
  const anchorPublicKeyPem = options.anchorKey ? (await readAnchorKeyFile(options.anchorKey)).publicKeyPem : undefined;
  const dir = path.resolve(options.out);
  await emptyOrNew(dir);
  const app = context ?? (await createExportContext(config));
  try {
    const scope = app.get(TenantScope, { strict: false });
    const org = await organisationOf(scope, app.get(TenantResolver, { strict: false }), options.org);
    const limit = config.profile.lifecycle.export_max_bytes;
    const bytes = await scope.withTenant(systemContextOf(org), (trx) => storedFileBytes(trx, org.id));
    if (bytes > limit) throw new Error(exportTooLarge(bytes, limit).message);
    const size = partBytes ?? config.profile.lifecycle.export_part_bytes;
    // The pool only pins the connection of the session lock (build-lock.ts).
    const pinned = app.get<AppDatabase>(DATABASE, { strict: false });
    const run = await withBuildLock(pinned, () => buildIntoFolder(app, org, dir, size, anchorPublicKeyPem));
    if (!run.locked) throw new Error(BUILD_BUSY_MESSAGE);
    return run.value;
  } finally {
    if (!context) await app.close();
  }
}

/** Builds the export of `org` into `dir` (spools in a hidden working folder inside it) and audits it. */
async function buildIntoFolder(
  app: INestApplicationContext,
  org: TenantInfo,
  dir: string,
  size: number,
  anchorPublicKeyPem: string | undefined,
): Promise<ExportOrganizationResult> {
  const scope = app.get(TenantScope, { strict: false });
  const clock = app.get(Clock, { strict: false });
  const builder = app.get(OrgExportBuilder, { strict: false });
  const audit = app.get<AuditWriter>(AUDIT_WRITER, { strict: false });
  const work = await mkdtemp(path.join(dir, '.mscd-export-work-'));
  const exportId = randomUUID();
  try {
    await checkFreeSpace(work, await builder.neededSpace(org, size));
    const now = clock.now();
    const result = await builder.build({
      org,
      exportId,
      requestedVia: 'cli',
      requestedBy: null,
      approvedBy: null,
      isFinal: false,
      workDir: work,
      partBytes: size,
      now,
      localDate: clock.todayIn(org.timeZone),
      ...(anchorPublicKeyPem ? { anchorPublicKeyPem } : {}),
      onPart: async (part) => {
        await rename(part.path, path.join(dir, part.name));
      },
    });
    const manifestFile = `${result.baseName}-manifest.json`;
    await writeFile(path.join(dir, manifestFile), result.manifestBytes, { flag: 'wx' });
    await scope.withTenant(systemContextOf(org), (trx) =>
      audit.record(trx, {
        action: 'organization_export.built',
        actor: { userId: SYSTEM_USER_ID, kind: 'system' },
        entityType: 'organization_export',
        entityId: exportId,
        entityCode: `export-${now.toISOString().slice(0, 10)}`,
        after: {
          status: 'ready',
          requestedVia: 'cli',
          parts: result.parts.map((p) => ({ part: p.part, name: p.name, sizeBytes: p.sizeBytes, sha256: p.sha256 })),
          files: result.fileCount,
          sizeBytes: result.sizeBytes,
        },
      }),
    );
    return {
      dir,
      orgSlug: org.slug,
      exportId,
      parts: result.parts.map((p) => ({ name: p.name, sizeBytes: p.sizeBytes, sha256: p.sha256 })),
      manifestFile,
      files: result.fileCount,
      sizeBytes: result.sizeBytes,
      anchorKeyIdsWithoutKey: result.anchorKeyIdsWithoutKey,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The organisation of the command: `--org`, or the only organisation of the installation. */
async function organisationOf(scope: TenantScope, tenants: TenantResolver, slug: string | undefined): Promise<TenantInfo> {
  if (slug) {
    const org = await tenants.resolveBySlug(slug);
    if (!org) throw new Error(`Unknown organisation ${slug}`);
    return org;
  }
  const rows = await scope.withPlatform(
    (trx) => trx.selectFrom('platform.organization').select(['slug']).where('deleted_at', 'is', null).where('status', '<>', 'deleted').orderBy('slug').execute(),
    { scope: 'cli' },
  );
  if (rows.length !== 1) throw new Error(`The installation has ${rows.length} organisations (${rows.map((r) => r.slug).join(', ')}); name one with --org <slug>`);
  const org = await tenants.resolveBySlug(rows[0]!.slug);
  if (!org) throw new Error(`Unknown organisation ${rows[0]!.slug}`);
  return org;
}

export interface ExportVerifyOptions {
  /** Public anchor key files to trust next to the compiled keys (`--anchor-key`, repeatable). */
  anchorKeys?: string[];
}

/** The result of `export verify` with the key ids that came from `--anchor-key`. */
export interface ExportVerifyResult extends VerifyReport {
  /** Key ids of the `--anchor-key` files, by file. */
  operatorKeys: { file: string; keyId: string }[];
}

/**
 * `export verify`: checks a folder against its manifest and its anchors, with the anchor keys compiled into this build
 * and the public keys of `--anchor-key` only (never a key of the export).
 */
export async function exportVerify(dir: string, options: ExportVerifyOptions = {}): Promise<ExportVerifyResult> {
  const operatorKeys: { file: string; keyId: string; publicKeyPem: string }[] = [];
  for (const file of options.anchorKeys ?? []) operatorKeys.push({ file, ...(await readAnchorKeyFile(file)) });
  const trustedKeys = [...compiledAnchorKeys(), ...operatorKeys.map((k) => ({ keyId: k.keyId, publicKeyPem: k.publicKeyPem }))];
  const report = await verifyExportFolder(path.resolve(dir), { trustedKeys });
  return { ...report, operatorKeys: operatorKeys.map((k) => ({ file: k.file, keyId: k.keyId })) };
}

/** The lines `export verify` prints: a summary, then OK with the anchor coverage, or the hint for an untrusted key. */
export function verifyLines(report: ExportVerifyResult): { out: string[]; err: string[] } {
  const keyLabel = (keyId: string) => {
    const file = report.operatorKeys.find((k) => k.keyId === keyId)?.file;
    return file ? `${keyId} from ${file}` : `${keyId} built into this release`;
  };
  const trust =
    report.anchorKeysTrusted === null
      ? 'no anchor to check'
      : report.anchorKeysTrusted
        ? `anchors checked with the anchor key ${report.anchorKeyIds.map(keyLabel).join(', ')}`
        : 'an anchor has NO valid signature by a trusted anchor key';
  const redacted =
    report.redactedUnanchored === 0
      ? `${report.redactedRows} redacted`
      : `${report.redactedRows + report.redactedUnanchored} redacted, ${report.redactedUnanchored} of them without an anchor over their attestation`;
  const head =
    `export verify: ${report.parts} part(s), ${report.entries} entries, ${report.files} file(s), ${report.auditRows} audit rows ` +
    `(${redacted}), ${report.anchors} anchor(s), ${trust}, manifest from the ${report.manifestSource === 'download' ? 'download' : 'last part'}`;
  // The anchors prove less than the newest anchor signs when a redacted row below it is explained only by a newer attestation.
  const cut = report.newestAnchoredSeq !== null && (report.lastAnchoredSeq ?? 0) < report.newestAnchoredSeq;
  const coverage =
    report.auditRows === 0
      ? 'The audit trail is empty.'
      : cut
        ? report.lastAnchoredSeq === null
          ? `No anchor proves the audit trail: the newest valid anchor signs seq ${report.newestAnchoredSeq}, but the content of the redacted row ` +
            `${report.redactedUnanchoredSeqs[0]} is explained only by an attestation entry written after that anchor.`
          : `The anchors prove the audit rows up to seq ${report.lastAnchoredSeq}: the newest valid anchor signs seq ${report.newestAnchoredSeq}, but the ` +
            `content of the redacted row ${report.redactedUnanchoredSeqs[0]} is explained only by an attestation entry written after that anchor.`
        : report.lastAnchoredSeq === null
          ? `No anchor: no signature proves any of the ${report.auditRows} audit row(s); the hashes only show that the rows match each other.`
          : report.rowsAfterLastAnchor === 0
            ? `The anchors prove every audit row up to seq ${report.lastAnchoredSeq}, the newest one.`
            : `The anchors prove the audit rows up to seq ${report.lastAnchoredSeq}; no signature covers the ${report.rowsAfterLastAnchor} newer row(s).`;
  const compare = 'Compare the newest anchor with the anchors kept outside MSCD (section 14 of the on-premise guide).';
  const shown = report.redactedUnanchoredSeqs.slice(0, 10).join(', ') + (report.redactedUnanchoredSeqs.length > 10 ? ', ...' : '');
  const unanchored =
    report.redactedUnanchored === 0
      ? []
      : [
          `Redacted rows without an anchor: ${report.redactedUnanchored} row(s) (seq ${shown}) are explained only by an attestation entry that no ` +
            'valid anchor covers, so no signature proves their content. A redaction made after the newest anchor of this export looks the ' +
            'same: export again after the next nightly anchor, whose signature then covers the attestation entry.',
        ];
  if (report.ok) {
    return {
      out: [head, 'OK: every part, entry and audit hash matches the manifest, and every anchor is signed by a trusted key.', `${coverage} ${compare}`, ...unanchored],
      err: [],
    };
  }
  const err = [`FAILED: ${report.problems.length} problem(s)`, ...report.problems.map((p) => `  ${p}`)];
  if (report.untrustedKeyIds.length > 0) {
    err.push(
      `The key ${report.untrustedKeyIds.join(', ')} is not trusted. An on-premise installation signs its anchors with its own key: ` +
        'pass its secrets/audit-anchor.pub with --anchor-key <file> (section 19.3 of the on-premise guide).',
    );
  }
  return { out: [head], err };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function register(program: Command): void {
  const exportCommand = program.command('export').description('Organisation export of single tenancy: build it into a folder, or check one');
  exportCommand
    .command('organization')
    .description('Build the organisation export (parts and manifest) into an empty folder; single tenancy only')
    .option('--out <dir>', 'empty or new folder to write the parts and the manifest to')
    .option('--org <slug>', 'organisation slug (default: the only organisation)')
    .option('--anchor-key <file>', "the installation's public anchor key (secrets/audit-anchor.pub), written into the export")
    .action(async (options: ExportOrganizationOptions) => {
      const config = loadConfigOrExit('cli');
      try {
        const result = await exportOrganization(config, options);
        const lines = [
          `export organization: ${result.orgSlug} written to ${result.dir}`,
          ...result.parts.map((p) => `  ${p.name}  ${p.sizeBytes} bytes  sha256 ${p.sha256}`),
          `  ${result.manifestFile}`,
          `${result.parts.length} part(s), ${result.files} file(s), ${result.sizeBytes} bytes. Check them with: mscd-server export verify --dir ${result.dir}`,
          ...(result.anchorKeyIdsWithoutKey.length > 0
            ? [
                `The anchors are signed with the key ${result.anchorKeyIdsWithoutKey.join(', ')}, whose public key this command could not read: ` +
                  'audit/anchor-keys.json lists it without a key and audit/audit-anchor.pub is empty. Run the export again with --anchor-key <secrets/audit-anchor.pub> to include it.',
              ]
            : []),
        ];
        process.stdout.write(`${lines.join('\n')}\n`);
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`export organization failed: ${describeError(error)}\n`);
        process.exit(1);
      }
    });
  exportCommand
    .command('verify')
    .description(
      'Check every part and entry of an organisation export against its manifest, and the audit chain against its anchors with the anchor keys of this build and of --anchor-key',
    )
    .option('--dir <dir>', 'folder that holds the parts and the manifest')
    .option(
      '--anchor-key <file>',
      "a public anchor key to trust next to the keys of this build, such as the installation's secrets/audit-anchor.pub (repeatable)",
      (file: string, files: string[]) => [...files, file],
      [] as string[],
    )
    .action(async (options: { dir?: string; anchorKey: string[] }) => {
      if (!options.dir) {
        process.stderr.write('export verify: give the folder with --dir <dir>\n');
        process.exit(1);
      }
      try {
        const report = await exportVerify(options.dir, { anchorKeys: options.anchorKey });
        const lines = verifyLines(report);
        process.stdout.write(`${lines.out.join('\n')}\n`);
        if (!report.ok) {
          process.stderr.write(`${lines.err.join('\n')}\n`);
          process.exit(1);
        }
      } catch (error) {
        process.stderr.write(`export verify failed: ${describeError(error)}\n`);
        process.exit(1);
      }
    });
}
