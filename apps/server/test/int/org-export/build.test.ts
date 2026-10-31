// The organisation export build (Milestone 3 D.4, J.3 `org-export.build`) on the demo organisation tst with a storage
// gateway on SeaweedFS: a build with a small part size gives several parts whose SHA-256 match the manifest; the row
// count of every table equals the database; a vault file comes back byte for byte (cut into pieces when it is larger
// than a part); none of a known password hash, TOTP secret, recovery code hash, session id, token hash, sealed
// credential or data key appears in any part; the network address and browser of a platform operator's audit entry
// are absent; a person listed in erased_person appears only under the pseudonym; another organisation's data is
// absent; `export verify` recomputes every audit hash from the canonical texts (an attested redaction included) and
// fails on a changed byte; the final export of the offboarding period has no expiry and goes to every Tenant Admin;
// and the expiry of `cleanup.expired` removes the vault content of the parts and of a 7-day export file.
import { createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OrganizationExportCreated } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import { AUDIT_WRITER, type AuditWriter } from '../../../src/common/tokens';
import { compiledAnchorKeys, signAnchor } from '../../../src/modules/audit/anchors';
import { CleanupExpiredJob } from '../../../src/modules/jobs/cleanup-expired.job';
import { BUILD_BUSY_RETRY_SECONDS, BUILD_LOCK_CLASS, BUILD_LOCK_KEY } from '../../../src/modules/org-export/build-lock';
import { ExportExpiry, STALE_BUILD_ERROR, STALE_BUILD_HOURS } from '../../../src/modules/org-export/expiry';
import type { ExportManifest } from '../../../src/modules/org-export/manifest';
import { verifyExportFolder } from '../../../src/modules/org-export/verify';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { useTestDatabase } from '../../setup/test-db';
import { demoSession, rowsIn, userIdOf, type Client, type FullApp } from '../contract/harness';
import { inScope } from '../db/helpers';
import { startStorageStack, type StorageStack } from '../files/helpers';
import {
  buildExport, clearExports, createExportApp, downloadExport, exportRow, ORG_IDS, putVaultFile, sha256, unpackParts, vaultHas,
} from './helpers';

const PART_BYTES = 1024 * 1024;
const OPERATOR_IP = '203.0.113.77';
const OPERATOR_AGENT = 'OperatorBrowser/9.9 (provider staff)';
const USER_IP = '198.51.100.23';
const ERASED = { handle: 'erased.export91', email: 'erased.export91@example.test', name: 'Wiryo Sasmito Export', pseudonym: 'Former user 7F3A' };
const TEXT_ENTRY = /^(README\.txt|data\/|audit\/|files\/external-files\.csv|manifest\.json)/;
const ANCHOR_KEY_FILE = path.resolve(__dirname, '../../fixtures/secrets/audit-anchor.key');

describe('organisation export build (D.4)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let full: FullApp;
  let rina: Client;
  let admin: Client;
  let work: string;
  const secrets: string[] = [];
  let bigFile: Buffer;
  let bigObjectId: string;
  let disposedObjectId: string;
  let erasedId: string;
  let exportId: string;
  /** Seq of the anchored head of the tst chain, and the public anchor key of the test profile. */
  let anchoredSeq: number;
  let anchorPem: string;
  let downloaded: { parts: string[]; manifest: string };
  let entries: Map<string, Buffer>;
  let manifest: ExportManifest;
  /** Rows of every tenant table right before the build. */
  const countsBefore = new Map<string, number>();

  const platform = <T>(fn: Parameters<typeof inScope<T>>[2]) => inScope<T>(db.migrator, { platformScope: true }, fn);

  beforeAll(async () => {
    stack = await startStorageStack();
    full = await createExportApp(db, stack.gateway.url);
    work = await mkdtemp(path.join(os.tmpdir(), 'mscd-m3-02-build-'));
    rina = await demoSession(full, db, 'rina', 'tst');
    admin = await demoSession(full, db, 'tenant.admin', 'tst');
    await clearExports(db, 'tst');

    // Files of the Managed Vault: one larger than a part (pieces), one small with a UTF-8 name, one disposed.
    bigFile = randomBytes(Math.floor(PART_BYTES * 1.6));
    bigObjectId = await putVaultFile(full, db, 'tst', 'Laporan audit internal Q3 (versi akhir) ü.pdf', bigFile);
    await putVaultFile(full, db, 'tst', 'Catatan rapat.txt', Buffer.from('Catatan rapat tinjauan manajemen\n'));
    disposedObjectId = await putVaultFile(full, db, 'tst', 'Old record.txt', Buffer.from('disposed content'));
    await rowsIn(db, 'tst', sql`update storage_object set content_disposed_at = now() where id = ${disposedObjectId}`);

    // Secrets that must never be exported.
    const rinaId = await userIdOf(db, 'rina');
    const idp = await platform((trx) =>
      trx
        .insertInto('platform.identity_provider')
        .values({
          organization_id: ORG_IDS.tst, slug: 'export-oidc', kind: 'oidc', display_name: 'Export test OIDC', oidc_issuer: 'https://idp.example.test',
          oidc_client_id: 'mscd-export-test', oidc_client_secret_sealed: `sealed-oidc-${randomUUID()}`,
        } as never)
        .returning(['id', 'oidc_client_secret_sealed'])
        .executeTakeFirstOrThrow(),
    );
    const recovery = randomBytes(32).toString('hex');
    await platform((trx) => trx.insertInto('platform.mfa_recovery_code').values({ user_id: rinaId, code_hash: recovery }).execute());
    const tokens = { invitation: randomBytes(32), reset: randomBytes(32), feed: randomBytes(32), domain: randomBytes(32) };
    await platform((trx) =>
      trx
        .insertInto('platform.invitation')
        .values({ token_hash: tokens.invitation, organization_id: ORG_IDS.tst, user_id: rinaId, email: 'rina@invited.test', created_by: rinaId, expires_at: new Date(Date.now() + 86_400_000) })
        .execute(),
    );
    await platform((trx) => trx.insertInto('platform.password_reset_token').values({ token_hash: tokens.reset, user_id: rinaId, expires_at: new Date(Date.now() + 86_400_000) }).execute());
    await platform((trx) =>
      trx
        .insertInto('platform.verified_domain')
        .values({ organization_id: ORG_IDS.tst, domain: 'export-test.example', status: 'pending', method: 'dns', txt_token_hash: tokens.domain, verified_at: null, verified_by: null } as never)
        .execute(),
    );
    const [repo] = await rowsIn<{ id: string }>(db, 'tst', sql`select id from storage_repository where adapter = 'managed_vault' order by position limit 1`);
    const sealedCredential = `sealed-credential-${randomUUID()}`;
    await rowsIn(db, 'tst', sql`insert into calendar_feed_token (user_id, management_system_id, token_hash)
      select ${rinaId}, id, ${tokens.feed} from management_system where slug = 'isms'`);
    await rowsIn(db, 'tst', sql`insert into storage_credential (storage_repository_id, credential_ref, kind, sealed_blob, key_id, config_sha256)
      values (${repo!.id}, ${`export-test-${randomUUID()}`}, 'oauth_refresh_token', ${sealedCredential}, 'k1', ${'a'.repeat(64)})`);
    secrets.push(idp.oidc_client_secret_sealed!, recovery, sealedCredential, ...Object.values(tokens).map((b) => b.toString('hex')));
    const hashes = await rowsIn<{ v: string }>(db, 'tst', sql`
      select u.password_hash as v from platform.app_user u join platform.org_membership m on m.user_id = u.id
        where m.organization_id = ${ORG_IDS.tst} and u.password_hash is not null
      union all select f.secret_sealed from platform.mfa_factor f join platform.org_membership m on m.user_id = f.user_id where m.organization_id = ${ORG_IDS.tst}
      union all select encode(token_hash, 'hex') from auditor_access_grant
      union all select wrapped_dek from platform.tenant_key where organization_id = ${ORG_IDS.tst}`);
    secrets.push(...hashes.map((h) => h.v));
    const sessions = await platform((trx) =>
      trx.selectFrom('platform.session').select(['id_hash', 'csrf_token_hash']).where('organization_id', '=', ORG_IDS.tst).execute(),
    );
    for (const s of sessions) secrets.push(s.id_hash.toString('hex'), s.csrf_token_hash.toString('hex'));
    expect(secrets.length).toBeGreaterThan(10);

    // Platform audit entries of tst: one by a platform operator (address and browser left out), one by a user (kept).
    const audit = full.get<AuditWriter>(AUDIT_WRITER);
    const opsId = await userIdOf(db, 'ops');
    await audit.recordDetached({
      action: 'ops.export_requested', actor: { userId: opsId, kind: 'operator' }, organizationId: ORG_IDS.tst, entityType: 'organization', entityCode: 'tst',
      after: { reason: 'Provider check' }, sourceIp: OPERATOR_IP, userAgent: OPERATOR_AGENT,
    });
    await audit.recordDetached({
      action: 'user.updated', actor: { userId: rinaId, kind: 'user' }, organizationId: ORG_IDS.tst, entityType: 'app_user', entityId: rinaId, entityCode: 'rina',
      after: { jobTitle: 'Head of Compliance' }, sourceIp: USER_IP, userAgent: 'UserBrowser/1.0',
    });

    // A person erased in tst: removed membership, a session, a linked sign-in and a platform audit entry naming them.
    erasedId = await platform(async (trx) => {
      const user = await trx.insertInto('platform.app_user').values({ handle: ERASED.handle, email: ERASED.email, display_name: ERASED.name, kind: 'person', status: 'active' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('platform.org_membership').values({ organization_id: ORG_IDS.tst, user_id: user.id, admin_roles: [], status: 'disabled', is_default: true, deleted_at: new Date() }).execute();
      await trx.insertInto('platform.user_identity').values({ identity_provider_id: idp.id, subject: 'erased-subject-91', user_id: user.id, email_at_link: ERASED.email, link_method: 'admin' } as never).execute();
      await trx
        .insertInto('platform.session')
        .values({ id_hash: randomBytes(32), user_id: user.id, organization_id: ORG_IDS.tst, state: 'active', auth_method: 'local', csrf_token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 3600_000), absolute_expires_at: new Date(Date.now() + 3600_000), ip: '198.51.100.99' } as never)
        .execute();
      return user.id;
    });
    await rowsIn(db, 'tst', sql`insert into erased_person (erased_user_id, pseudonym, erased_at) values (${erasedId}, ${ERASED.pseudonym}, now())`);
    await audit.recordDetached({
      action: 'user.updated', actor: { userId: erasedId, kind: 'user' }, organizationId: ORG_IDS.tst, entityType: 'app_user', entityId: erasedId, entityCode: ERASED.handle,
      after: { email: ERASED.email, displayName: ERASED.name }, sourceIp: '198.51.100.99',
    });

    // An attested redaction in the tenant chain (Milestone 3 D.5.4): one row changed, and a later entry that lists it.
    const redactionId = randomUUID();
    const scope = full.get<TenantScope>(TenantScope);
    const systemContext = { orgId: ORG_IDS.tst, schema: 'org_tst', userId: '00000000-0000-0000-0000-000000000001' };
    const target = await scope.withTenant(systemContext, (trx) =>
      audit.record(trx, { action: 'export.created', entityType: 'background_task', entityCode: ERASED.handle, after: { requestedBy: ERASED.email }, sourceIp: '198.51.100.99' }),
    );
    const seq = Number(target.seq);
    await rowsIn(db, 'tst', sql`alter table audit_trail disable trigger user`);
    await rowsIn(db, 'tst', sql`update audit_trail set entity_code = ${ERASED.pseudonym}, after_data = ${JSON.stringify({ requestedBy: ERASED.pseudonym })}::jsonb,
        source_ip = null, user_agent = null, redacted_at = now(), redaction_id = ${redactionId}
      where seq = ${seq}`);
    await rowsIn(db, 'tst', sql`alter table audit_trail enable trigger user`);
    const [hashesOfRow] = await rowsIn<{ row_hash: string; redacted_hash: string }>(db, 'tst', sql`
      select encode(row_hash, 'hex') as row_hash,
             encode(sha256(prev_hash || convert_to(platform.audit_canonical_text(seq, id, occurred_at, organization_id, management_system_id, actor_user_id,
               actor_kind, action, entity_type, entity_id, entity_code, before_data, after_data, edition, request_id, source_ip, user_agent), 'UTF8')), 'hex') as redacted_hash
      from audit_trail where seq = ${seq}`);
    // The attestation is written in SQL, as platform.redact_audit_rows writes it (the audit writer would redact its hashes).
    await rowsIn(db, 'tst', sql`insert into audit_trail (actor_kind, action, entity_type, entity_code, after_data)
      values ('system', 'privacy.audit_redacted', 'audit_trail', 'redaction',
              ${JSON.stringify({ redactionId, rows: [{ seq, rowHash: hashesOfRow!.row_hash, redactedHash: hashesOfRow!.redacted_hash }] })}::jsonb)`);

    // A signed anchor of the tst chain at its head (the anchor job's format, with the key of the test profile).
    const privateKey = createPrivateKey(await readFile(ANCHOR_KEY_FILE));
    const [head] = await rowsIn<{ seq: string; row_hash: string }>(db, 'tst', sql`select seq::text, encode(row_hash, 'hex') as row_hash from audit_trail order by seq desc limit 1`);
    const installation = await platform((trx) => trx.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow());
    const anchored = signAnchor(
      { chain: 'org_tst.audit_trail', seq: Number(head!.seq), rowHash: head!.row_hash, anchoredAt: new Date().toISOString(), installationId: installation.id },
      privateKey,
      createPublicKey(privateKey),
    );
    anchoredSeq = anchored.seq;
    anchorPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    await sql`insert into platform.audit_anchor (chain, seq, row_hash, payload, signature, key_id)
      values (${anchored.chain}, ${anchored.seq}, ${Buffer.from(anchored.rowHash, 'hex')},
              ${JSON.stringify({ chain: anchored.chain, seq: anchored.seq, rowHash: anchored.rowHash, anchoredAt: anchored.anchoredAt, installationId: anchored.installationId })},
              ${anchored.signature}, ${anchored.keyId})`.execute(db.migrator);

    // The export: requested by rina, approved by tenant.admin, built with 1 MiB parts and downloaded.
    const created = await rina.post<OrganizationExportCreated>('/api/v1/admin/organization/exports', {});
    exportId = created.body.data.id;
    expect((await admin.post(`/api/v1/admin/organization/exports/${exportId}/decision`, { approve: true })).status).toBe(200);
    for (const { table } of await rowsIn<{ table: string }>(db, 'tst', sql`select table_name as table from information_schema.tables
        where table_schema = 'org_tst' and table_type = 'BASE TABLE' and table_name not like 'kysely%'`)) {
      const [{ n }] = (await rowsIn<{ n: string }>(db, 'tst', sql`select count(*)::text as n from ${sql.table(table)}`)) as [{ n: string }];
      countsBefore.set(table, Number(n));
    }
    const built = await buildExport(full, 'tst', exportId, PART_BYTES);
    expect(built.status, built.error).toBe('ready');
    downloaded = await downloadExport(admin, exportId, path.join(work, 'download'));
    entries = await unpackParts(downloaded.parts);
    manifest = JSON.parse(await readFile(downloaded.manifest, 'utf8')) as ExportManifest;
  }, 600_000);

  afterAll(async () => {
    await full?.close();
    await stack?.close();
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('gives several parts whose SHA-256 and sizes match the manifest, the last one holding its copy', async () => {
    expect(downloaded.parts.length).toBeGreaterThanOrEqual(3);
    expect(manifest).toMatchObject({ format: 'mscd-organization-export', formatVersion: 1, copy: 'download', exportId, organization: { slug: 'tst' } });
    expect(manifest.requestedBy).toBe('rina');
    expect(manifest.approvedBy).toBe('tenant.admin');
    expect(manifest.parts).toHaveLength(downloaded.parts.length);
    for (const [index, file] of downloaded.parts.entries()) {
      const bytes = await readFile(file);
      expect(manifest.parts[index]).toEqual({ part: index + 1, name: path.basename(file), sizeBytes: bytes.length, sha256: sha256(bytes) });
      expect(bytes.length).toBeLessThanOrEqual(PART_BYTES);
    }
    const row = await exportRow(db, exportId);
    expect(row.manifest_sha256).toBe(sha256(await readFile(downloaded.manifest)));
    expect(row.part_count).toBe(downloaded.parts.length);
    // The copy in the last part is the same manifest, without the size and hash of its own part.
    const copy = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as ExportManifest;
    expect(copy.copy).toBe('last-part');
    expect(copy.parts.at(-1)).toEqual({ part: downloaded.parts.length, name: path.basename(downloaded.parts.at(-1)!), sizeBytes: null, sha256: null });
    expect(copy.entries).toEqual(manifest.entries);
    // Every entry of the manifest is in the parts with its hash.
    for (const entry of manifest.entries) expect(sha256(entries.get(entry.path)!), entry.path).toBe(entry.sha256);
    expect(manifest.tenantMigrations).toContain('0009_milestone3');
    // The application role may not read the schema's migration table, so the list is the build's and says so.
    expect(manifest.tenantMigrationsSource).toBe('build');
    expect(manifest.frameworkPacks.length).toBeGreaterThan(0);
    expect(manifest.excluded.map((e) => e.item)).toEqual(expect.arrayContaining(['platform.app_user.password_hash', 'platform.tenant_key', 'storage_credential.sealed_blob', 'platform.session.id_hash']));
    const readme = entries.get('README.txt')!.toString('utf8');
    expect(readme).toContain('sha256sum');
    expect(readme).toContain('Get-FileHash');
    expect(readme).toContain('=== Bahasa Indonesia ===');
  });

  it('holds every table with the row count of the database and the files byte for byte', async () => {
    const tables = manifest.entries.filter((e) => e.kind === 'table' && e.path.endsWith('.jsonl'));
    expect(tables.length).toBeGreaterThan(60);
    for (const entry of tables) {
      const table = /^data\/tenant\/(.+)\.jsonl$/.exec(entry.path)![1]!;
      expect(entry.rows, table).toBe(countsBefore.get(table));
      const lines = entries.get(entry.path)!.toString('utf8').split('\n').filter((l) => l !== '');
      expect(lines.length, table).toBe(entry.rows);
      const csvRows = entries.get(entry.path.replace(/\.jsonl$/, '.csv'))!.toString('utf8').replace(/^\uFEFF/, '').split('\r\n').filter((l) => l !== '');
      expect(csvRows.length - 1, `${table}.csv`).toBeGreaterThanOrEqual(Math.min(1, entry.rows ?? 0));
    }
    // A row marked deleted is exported with deleted_at; times are UTC.
    const risk = entries.get('data/tenant/risk.jsonl')!.toString('utf8').split('\n')[0]!;
    expect(JSON.parse(risk)).toHaveProperty('deleted_at');
    expect(JSON.parse(risk).created_at).toMatch(/\+00:00$/);
    // Every tenant row belongs to tst.
    for (const entry of tables) {
      for (const line of entries.get(entry.path)!.toString('utf8').split('\n')) {
        if (line === '') continue;
        const row = JSON.parse(line) as { organization_id?: string };
        if (row.organization_id !== undefined) expect(row.organization_id, entry.path).toBe(ORG_IDS.tst);
      }
    }
    // The large vault file came in pieces and joins to the upload; the small one keeps its UTF-8 name.
    const big = manifest.entries.find((e) => e.objectId === bigObjectId)!;
    expect(big.pieces!.length).toBeGreaterThanOrEqual(2);
    expect(entries.get(big.path)).toEqual(bigFile);
    expect(big.path).toMatch(/^files\/[a-z0-9-]+\/[0-9a-f-]{36}\/Laporan audit internal Q3 \(versi akhir\) ü\.pdf$/);
    expect([...entries.keys()].some((k) => k.endsWith('/Catatan rapat.txt'))).toBe(true);
    // The disposed file is listed without content.
    expect(manifest.filesWithoutContent).toEqual(expect.arrayContaining([expect.objectContaining({ objectId: disposedObjectId, reason: 'disposed' })]));
    expect([...entries.keys()].some((k) => k.includes(disposedObjectId))).toBe(false);
    // The export's own parts are not in the export.
    expect(entries.get('data/tenant/storage_object.jsonl')!.toString('utf8')).not.toContain(`exports/organization/${exportId}`);
    // Platform files.
    for (const name of ['organization', 'members', 'identity_providers', 'linked_sign_in', 'verified_domains', 'licences', 'entitlements', 'status_history', 'sessions', 'audit_log', 'exports', 'deletions']) {
      expect(entries.has(`data/platform/${name}.csv`), name).toBe(true);
      expect(entries.has(`data/platform/${name}.jsonl`), name).toBe(true);
    }
    expect(entries.has('files/external-files.csv')).toBe(true);
    // The audit folder names the installation's own anchor key (the public half of audit.anchor_key_file), which signed.
    expect(entries.get('audit/audit-anchor.pub')!.toString('utf8')).toBe(anchorPem);
    const anchorKeys = JSON.parse(entries.get('audit/anchor-keys.json')!.toString('utf8')) as { keyId: string; publicKeyPem: string | null }[];
    expect(anchorKeys).toHaveLength(1);
    expect(anchorKeys[0]!.publicKeyPem).toBe(anchorPem);
    expect(manifest.audit.anchorKeyIds).toEqual([anchorKeys[0]!.keyId]);
  });

  it('holds no secret, no address of provider staff, no erased identity and nothing of another organisation', async () => {
    const texts = [...entries].filter(([name]) => TEXT_ENTRY.test(name)).map(([name, body]) => [name, body.toString('utf8')] as const);
    for (const secret of secrets) {
      for (const [name, text] of texts) expect(text.includes(secret), `${name} holds a secret`).toBe(false);
    }
    for (const [name, text] of texts) {
      expect(text.includes(OPERATOR_IP), `${name} holds the operator's address`).toBe(false);
      expect(text.includes(OPERATOR_AGENT), `${name} holds the operator's browser`).toBe(false);
      for (const value of [ERASED.email, ERASED.handle, ERASED.name]) expect(text.includes(value), `${name} names the erased person`).toBe(false);
      expect(text.includes(ORG_IDS.ndt), `${name} holds an id of ndt`).toBe(false);
    }
    // The user's own entry keeps its address; the operator's entry is there without it.
    const auditLog = entries.get('data/platform/audit_log.jsonl')!.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(auditLog.find((r) => r.source_ip === USER_IP)).toBeTruthy();
    expect(auditLog.find((r) => r.actor_kind === 'operator' && r.action === 'ops.export_requested')).toMatchObject({ source_ip: null, user_agent: null });
    // The erased person is in members under the pseudonym only, with no session or linked sign-in.
    const members = entries.get('data/platform/members.jsonl')!.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(members.find((m) => m.user_id === erasedId)).toMatchObject({ handle: ERASED.pseudonym, display_name: ERASED.pseudonym, email: null, job_title: null });
    expect(entries.get('data/platform/sessions.jsonl')!.toString('utf8')).not.toContain(erasedId);
    expect(entries.get('data/platform/linked_sign_in.jsonl')!.toString('utf8')).not.toContain(erasedId);
    expect(auditLog.find((r) => r.actor_user_id === erasedId)).toMatchObject({ entity_code: ERASED.pseudonym, source_ip: null });
    // A few ids of ndt-only records are absent.
    const ndtIds = await rowsIn<{ id: string }>(db, 'ndt', sql`select id from risk order by id limit 5`);
    for (const { id } of ndtIds) for (const [name, text] of texts) expect(text.includes(id), `${name} holds ndt record ${id}`).toBe(false);
  });

  it('passes export verify, which recomputes every audit hash, and fails on a changed byte', async () => {
    const report = await verifyExportFolder(path.dirname(downloaded.parts[0]!), { trustedKeys: compiledAnchorKeys() });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.anchors).toBeGreaterThanOrEqual(1);
    expect(report.anchorKeysTrusted).toBe(true);
    expect(report.manifestSource).toBe('download');
    expect(report.auditRows).toBe(manifest.audit.rows);
    expect(report.auditRows).toBeGreaterThanOrEqual(4);
    expect(report.redactedRows).toBe(1);
    expect(report.parts).toBe(downloaded.parts.length);
    // The anchor proves the trail up to the head it signed; the request, decision and build came after it.
    expect(report.lastAnchoredSeq).toBe(anchoredSeq);
    expect(report.rowsAfterLastAnchor).toBe(report.auditRows - anchoredSeq);
    expect(report.rowsAfterLastAnchor).toBeGreaterThan(0);

    // Without the separate manifest, the copy in the last part is used.
    const partsOnly = path.join(work, 'parts-only');
    await rm(partsOnly, { recursive: true, force: true });
    await mkdir(partsOnly);
    for (const file of downloaded.parts) await copyFile(file, path.join(partsOnly, path.basename(file)));
    const fromPart = await verifyExportFolder(partsOnly);
    expect(fromPart.problems).toEqual([]);
    expect(fromPart.manifestSource).toBe('last-part');

    // One changed byte in the middle of part 2.
    const tampered = path.join(work, 'tampered');
    await mkdir(tampered);
    for (const file of await readdir(path.dirname(downloaded.parts[0]!))) await copyFile(path.join(path.dirname(downloaded.parts[0]!), file), path.join(tampered, file));
    const second = path.join(tampered, path.basename(downloaded.parts[1]!));
    const bytes = await readFile(second);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await writeFile(second, bytes);
    const bad = await verifyExportFolder(tampered);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join('\n')).toMatch(/Part 2/);
  });

  it('builds the final export of the offboarding period without expiry and tells every Tenant Admin', async () => {
    const id = await platform(async (trx) =>
      (await trx
        .insertInto('platform.organization_export')
        .values({ organization_id: ORG_IDS.tst, status: 'queued', requested_via: 'offboarding', is_final: true })
        .returning('id')
        .executeTakeFirstOrThrow()).id,
    );
    const built = await buildExport(full, 'tst', id, PART_BYTES);
    expect(built.status, built.error).toBe('ready');
    const row = await exportRow(db, id);
    expect(row).toMatchObject({ status: 'ready', is_final: true, expires_at: null });
    const ready = await rowsIn<{ handle: string }>(db, 'tst', sql`select u.handle from notification n join platform.app_user u on u.id = n.recipient_user_id
      where n.kind = 'organization_export_ready' and n.entity_ref ->> 'id' = ${id} order by u.handle`);
    expect(ready.map((r) => r.handle)).toEqual(['rina', 'tenant.admin']);

    // While the organisation is offboarding the final export stays; once it is closed the expiry removes its content.
    const cleanup = full.get<CleanupExpiredJob>(CleanupExpiredJob);
    await sql`update platform.organization set status = 'offboarding' where id = ${ORG_IDS.tst}`.execute(db.migrator);
    try {
      await cleanup.cleanup();
      expect((await exportRow(db, id)).status).toBe('ready');
      await sql`update platform.organization set status = 'archived' where id = ${ORG_IDS.tst}`.execute(db.migrator);
      await cleanup.cleanup();
      expect((await exportRow(db, id)).status).toBe('expired');
      const parts = (await exportRow(db, id)).parts ?? [];
      for (const part of parts) expect(await vaultHas(full, db, 'tst', part.storageObjectId)).toBe(false);
    } finally {
      await sql`update platform.organization set status = 'active' where id = ${ORG_IDS.tst}`.execute(db.migrator);
    }
  });

  it('removes the vault content of expired exports, export files and stale requests (cleanup.expired)', async () => {
    const row = await exportRow(db, exportId);
    const objects = [...(row.parts ?? []).map((p) => p.storageObjectId), row.manifest_object_id!];
    for (const objectId of objects) expect(await vaultHas(full, db, 'tst', objectId)).toBe(true);
    // A 7-day export file that has expired and one that has not.
    const oldObject = await putVaultFile(full, db, 'tst', 'ISMS-readiness-report.pdf', Buffer.from('%PDF old'), `exports/${randomUUID()}`);
    const newObject = await putVaultFile(full, db, 'tst', 'ISMS-readiness-report-new.pdf', Buffer.from('%PDF new'), `exports/${randomUUID()}`);
    await rowsIn(db, 'tst', sql`insert into export_file (kind, format, storage_object_id, file_name, expires_at) values
      ('readiness', 'pdf', ${oldObject}, 'old.pdf', now() - interval '1 hour'), ('readiness', 'pdf', ${newObject}, 'new.pdf', now() + interval '1 day')`);
    // The ready export expires; a request without a decision for 8 days expires too.
    const stale = await platform(async (trx) => {
      await trx.updateTable('platform.organization_export').set({ expires_at: new Date(Date.now() - 60_000) }).where('id', '=', exportId).execute();
      return (await trx
        .insertInto('platform.organization_export')
        .values({ organization_id: ORG_IDS.tst, status: 'requested', requested_via: 'tenant_admin', requested_by: await userIdOf(db, 'rina'), requested_at: new Date(Date.now() - 8 * 86_400_000) })
        .returning('id')
        .executeTakeFirstOrThrow()).id;
    });
    const result = await full.get<CleanupExpiredJob>(CleanupExpiredJob).cleanup();
    expect(result.failedOrganisations).toEqual([]);
    expect(result.tenantSteps.exportsExpired).toBeGreaterThanOrEqual(3);
    expect((await exportRow(db, exportId)).status).toBe('expired');
    expect((await exportRow(db, stale)).status).toBe('expired');
    for (const objectId of objects) expect(await vaultHas(full, db, 'tst', objectId)).toBe(false);
    expect(await vaultHas(full, db, 'tst', oldObject)).toBe(false);
    expect(await vaultHas(full, db, 'tst', newObject)).toBe(true);
    const marked = await rowsIn<{ id: string; deleted: boolean }>(db, 'tst', sql`select id, deleted_at is not null as deleted from storage_object where id in (${oldObject}, ${newObject}, ${objects[0]!})`);
    expect(Object.fromEntries(marked.map((m) => [m.id, m.deleted]))).toEqual({ [oldObject]: true, [newObject]: false, [objects[0]!]: true });
    // A download of the expired export: 409; a second run changes nothing.
    expect((await admin.get(`/api/v1/admin/organization/exports/${exportId}/parts/1`)).status).toBe(409);
    const again = await full.get<CleanupExpiredJob>(CleanupExpiredJob).cleanup();
    expect(again.tenantSteps.exportsExpired).toBe(0);
  });

  it('fails an export left building or queued for a day while no build runs, and deletes what it stored', async () => {
    const expiry = full.get<ExportExpiry>(ExportExpiry);
    const scope = full.get<TenantScope>(TenantScope);
    const context = { orgId: ORG_IDS.tst, schema: 'org_tst', userId: '00000000-0000-0000-0000-000000000001' };
    const later = () => new Date(Date.now() + (STALE_BUILD_HOURS + 1) * 3_600_000);
    const run = (now: Date) => scope.withTenant(context, (trx) => expiry.run(trx, ORG_IDS.tst, now));
    // A build whose worker died after it stored a part: the row stays building.
    const id = await platform(async (trx) =>
      (await trx
        .insertInto('platform.organization_export')
        .values({ organization_id: ORG_IDS.tst, status: 'building', requested_via: 'tenant_admin', requested_by: await userIdOf(db, 'rina') })
        .returning('id')
        .executeTakeFirstOrThrow()).id,
    );
    const leftover = await putVaultFile(full, db, 'tst', 'mscd-export-tst-part-1.tar.gz', randomBytes(2048), `exports/organization/${id}`);
    // A new request is refused while the row looks running.
    expect((await rina.post('/api/v1/admin/organization/exports', {})).status).toBe(409);
    // Within the day nothing changes; nor while a build holds the installation's lock.
    await run(new Date());
    expect((await exportRow(db, id)).status).toBe('building');
    await db.migrator.connection().execute(async (conn) => {
      await sql`select pg_advisory_lock(${BUILD_LOCK_CLASS}, ${BUILD_LOCK_KEY})`.execute(conn);
      try {
        await run(later());
      } finally {
        await sql`select pg_advisory_unlock(${BUILD_LOCK_CLASS}, ${BUILD_LOCK_KEY})`.execute(conn);
      }
    });
    expect((await exportRow(db, id)).status).toBe('building');
    // After a day with no build running, it fails with the reason, audited, and the part it stored is deleted.
    await run(later());
    expect(await exportRow(db, id)).toMatchObject({ status: 'failed', error: STALE_BUILD_ERROR });
    expect(await vaultHas(full, db, 'tst', leftover)).toBe(false);
    const [object] = await rowsIn<{ deleted: boolean }>(db, 'tst', sql`select deleted_at is not null as deleted from storage_object where id = ${leftover}`);
    expect(object!.deleted).toBe(true);
    const audited = await rowsIn<{ after_data: { status: string; error: string } }>(db, 'tst', sql`
      select after_data from audit_trail where action = 'organization_export.failed' and entity_id = ${id}`);
    expect(audited.map((a) => a.after_data)).toEqual([expect.objectContaining({ status: 'failed', error: STALE_BUILD_ERROR })]);
    // A queued row whose job was lost fails the same way.
    const queued = await platform(async (trx) =>
      (await trx
        .insertInto('platform.organization_export')
        .values({ organization_id: ORG_IDS.tst, status: 'queued', requested_via: 'operator' })
        .returning('id')
        .executeTakeFirstOrThrow()).id,
    );
    await run(later());
    expect((await exportRow(db, queued)).status).toBe('failed');
    // A new request goes through.
    const again = await rina.post<OrganizationExportCreated>('/api/v1/admin/organization/exports', {});
    expect(again.status, again.text).toBe(202);
    await clearExports(db, 'tst');
  });

  it('builds one export at a time in the installation and queues a busy build again for later', async () => {
    const id = await platform(async (trx) =>
      (await trx
        .insertInto('platform.organization_export')
        .values({ organization_id: ORG_IDS.tst, status: 'queued', requested_via: 'tenant_admin', requested_by: await userIdOf(db, 'rina') })
        .returning('id')
        .executeTakeFirstOrThrow()).id,
    );
    // Another build (another worker process) holds the installation's lock: nothing changes, and the job is sent again.
    const queue = full.get<InMemoryJobQueue>(JOB_QUEUE);
    const send = vi.spyOn(queue, 'send');
    const busy = await db.migrator.connection().execute(async (conn) => {
      await sql`select pg_advisory_lock(${BUILD_LOCK_CLASS}, ${BUILD_LOCK_KEY})`.execute(conn);
      try {
        return await buildExport(full, 'tst', id, PART_BYTES);
      } finally {
        await sql`select pg_advisory_unlock(${BUILD_LOCK_CLASS}, ${BUILD_LOCK_KEY})`.execute(conn);
      }
    });
    const calls = [...send.mock.calls];
    send.mockRestore();
    expect(busy).toEqual({ exportId: id, status: 'busy' });
    expect((await exportRow(db, id)).status).toBe('queued');
    expect(calls).toHaveLength(1);
    const [name, env, options] = calls[0]!;
    expect(name).toBe('org-export.build');
    expect(env).toMatchObject({ orgId: ORG_IDS.tst, payload: { exportId: id } });
    expect(options).toMatchObject({ startAfterSeconds: BUILD_BUSY_RETRY_SECONDS, retryLimit: 1 });
    expect(options!.singletonKey).toMatch(new RegExp(`^oe:${id}:wait:\\d+$`));
    expect(queue.waitingJobs('org-export.build').some((j) => (j.env.payload as { exportId: string }).exportId === id)).toBe(true);
    // Once the other build has finished, the export builds.
    const built = await buildExport(full, 'tst', id, PART_BYTES);
    expect(built.status, built.error).toBe('ready');
  });
});
