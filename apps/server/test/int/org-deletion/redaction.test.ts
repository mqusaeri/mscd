// The two database functions of platform/0008 (Milestone 3 D.5.4; M3-03), called as mscd_app as the application calls
// them: `platform.redact_audit_rows` redacts rows of the platform chain or of a tenant chain under one attestation, and
// the chain verifier accepts the redacted rows through it; it refuses the whole call when a row no longer matches its
// stored hash, a reused redaction id, an unknown chain, a wrong attestation action and a replacement that is no
// pseudonym, and changes nothing then.
// `platform.purge_organization` refuses an organisation that is not archived and a deletion that is not running or not
// due, and changes nothing. The append-only triggers still refuse every other change of an audit row.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { compiledAnchorKeys } from '../../../src/modules/audit/anchors';
import { AuditRedactor } from '../../../src/modules/audit/audit-redactor';
import { AuditChainVerifier } from '../../../src/modules/audit/chain-verifier';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { makeDue, schemaExists } from './helpers';

const PERSON = { email: 'dewi.lestari@example.test', handle: 'dewi.lestari', name: 'Dewi Lestari' };

describe('attested redaction and the purge function (Milestone 3 D.5.4; M3-03)', () => {
  const db = useTestDatabase('empty');
  let org: CreatedTenant;
  let other: CreatedTenant;
  let verifier: AuditChainVerifier;
  const redactor = new AuditRedactor();

  /** One platform audit entry of an organisation, written as mscd_app; returns its seq. */
  const platformEntry = async (orgId: string, values: { ip?: string | null; after?: Record<string, unknown>; code?: string | null }) =>
    inScope(db.app, { platformScope: true }, async (trx) => {
      const row = await trx
        .insertInto('platform.audit_log')
        .values({
          organization_id: orgId,
          actor_kind: 'user',
          action: 'membership.updated',
          entity_type: 'user',
          entity_code: values.code ?? null,
          after_data: values.after ? JSON.stringify(values.after) : null,
          source_ip: values.ip ?? null,
          user_agent: values.ip ? 'Test browser' : null,
        })
        .returning('seq')
        .executeTakeFirstOrThrow();
      return String(row.seq);
    });
  /** One entry of the tenant chain of an organisation, written as mscd_app; returns its seq. */
  const tenantEntry = async (tenant: CreatedTenant, after: Record<string, unknown>) =>
    inScope(db.app, { orgId: tenant.id, schema: tenant.schemaName }, async (trx) => {
      const row = await trx
        .insertInto('audit_trail')
        .values({ actor_kind: 'user', action: 'register.updated', entity_type: 'risk', entity_code: 'R-001', after_data: JSON.stringify(after), source_ip: '203.0.113.20', user_agent: 'Test browser' })
        .returning('seq')
        .executeTakeFirstOrThrow();
      return String(row.seq);
    });
  beforeAll(async () => {
    org = await createTenant(db, 'redact_a', { name: 'PT Redaksi' });
    other = await createTenant(db, 'redact_b', { name: 'PT Lain' });
    verifier = new AuditChainVerifier(new TenantScope(db.app as never), compiledAnchorKeys());
  });

  it('redacts rows of the platform chain under one attestation; the chain verifies and counts them', async () => {
    const seqs = [
      await platformEntry(org.id, { ip: '203.0.113.7', code: PERSON.handle, after: { email: PERSON.email, note: `Changed by ${PERSON.name}` } }),
      await platformEntry(org.id, { ip: '203.0.113.8', after: { members: [PERSON.email, 'someone.else@example.test'] } }),
      await platformEntry(org.id, { after: { plan: 'standard' } }),
    ];
    const kept = await platformEntry(other.id, { ip: '198.51.100.3', after: { email: PERSON.email } });
    const result = await inScope(db.app, { platformScope: true }, (trx) =>
      redactor.redact(trx, {
        chain: 'platform',
        seqs,
        replacements: { [PERSON.email]: 'erased-1a2b3c4d', [PERSON.handle]: 'erased-1a2b3c4d', [PERSON.name]: 'erased-1a2b3c4d', ab: 'erased-00000000' },
        attestation: { action: 'user.audit_redacted', reason: 'Erasure test', organizationId: org.id },
      }),
    );
    expect(result).toMatchObject({ chain: 'platform.audit_log', redacted: 2, unchanged: 1 });
    const rows = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.audit_log').selectAll().where('seq', 'in', [...seqs, kept]).orderBy('seq').execute(),
    );
    expect(rows[0]).toMatchObject({ source_ip: null, user_agent: null, entity_code: 'erased-1a2b3c4d', after_data: { email: 'erased-1a2b3c4d', note: 'Changed by erased-1a2b3c4d' } });
    expect(rows[1]!.after_data).toEqual({ members: ['erased-1a2b3c4d', 'someone.else@example.test'] });
    expect(rows[2]).toMatchObject({ redacted_at: null, redaction_id: null, after_data: { plan: 'standard' } });
    expect(rows[3]).toMatchObject({ source_ip: '198.51.100.3', redaction_id: null, after_data: { email: PERSON.email } });
    expect(rows[0]!.redaction_id).toBe(result.redactionId);

    const attestation = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.audit_log').selectAll().where('seq', '=', String(result.attestationSeq)).executeTakeFirstOrThrow(),
    );
    expect(attestation).toMatchObject({ action: 'user.audit_redacted', organization_id: org.id, actor_kind: 'system' });
    const listed = attestation.after_data as { redactionId: string; count: number; rows: { seq: number; rowHash: string; redactedHash: string }[] };
    expect(listed).toMatchObject({ redactionId: result.redactionId, count: 2 });
    expect(listed.rows.map((r) => String(r.seq))).toEqual(seqs.slice(0, 2));
    expect(listed.rows[0]!.rowHash).toBe(rows[0]!.row_hash.toString('hex'));

    // No anchor covers the attestation yet: the rows are accepted and counted apart until the next anchor run (D.5.4).
    const verified = await verifier.verifyPlatform();
    expect(verified).toMatchObject({ firstBrokenSeq: null, anchorOk: true, redacted: 2, redactedUnanchored: 2, redactionHeadSeq: result.attestationSeq });

    // A row redacted before is redacted again only when it still matches its attestation.
    const again = await inScope(db.app, { platformScope: true }, (trx) =>
      redactor.redact(trx, {
        chain: 'platform',
        seqs: [seqs[1]!],
        replacements: { 'someone.else@example.test': 'erased-99999999' },
        attestation: { action: 'tenant.audit_redacted', reason: 'Purge test', organizationId: org.id },
      }),
    );
    expect(again).toMatchObject({ redacted: 1 });
    expect(await verifier.verifyPlatform()).toMatchObject({ firstBrokenSeq: null, redacted: 2 });
  });

  it('refuses a reused redaction id, an unknown chain, a wrong action, a row of another organisation and a replacement that is no pseudonym, and changes nothing', async () => {
    const seq = await platformEntry(org.id, { ip: '203.0.113.9', after: { email: PERSON.email } });
    const used = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.audit_log').select('redaction_id').where('redaction_id', 'is not', null).limit(1).executeTakeFirstOrThrow(),
    );
    const attempt = (request: Parameters<AuditRedactor['redact']>[1]) => inScope(db.app, { platformScope: true }, (trx) => redactor.redact(trx, request));
    const base = { chain: 'platform' as const, seqs: [seq], replacements: { [PERSON.email]: 'erased-1a2b3c4d' }, attestation: { action: 'user.audit_redacted' as const, reason: 'Refusal test', organizationId: org.id } };
    await expect(attempt({ ...base, redactionId: used.redaction_id! })).rejects.toThrow(/already used/);
    await expect(attempt({ ...base, chain: { schema: 'org_nowhere' } })).rejects.toThrow(/No organisation schema/);
    await expect(attempt({ ...base, attestation: { ...base.attestation, action: 'privacy.audit_redacted' } })).rejects.toThrow(/platform chain takes/);
    await expect(attempt({ ...base, attestation: { ...base.attestation, organizationId: other.id } })).rejects.toThrow(/another organisation/);
    // Only pseudonyms replace values, so a call can never rewrite other text of a row ("approved" into "rejected").
    await expect(attempt({ ...base, replacements: { 'membership.updated': 'membership.removed' } })).rejects.toThrow(/must be a pseudonym/);
    await expect(attempt({ ...base, replacements: { [PERSON.email]: 'Former user' } })).rejects.toThrow(/must be a pseudonym/);
    await expect(attempt({ ...base, replacements: { [PERSON.email]: 'erased-1A2B3C4D ' } })).rejects.toThrow(/must be a pseudonym/);
    const row = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.audit_log').selectAll().where('seq', '=', seq).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ source_ip: '203.0.113.9', redaction_id: null, after_data: { email: PERSON.email } });
  });

  it('redacts a tenant chain with privacy.audit_redacted, and refuses the whole call when a row no longer matches its stored hash', async () => {
    const first = await tenantEntry(other, { holder: PERSON.name });
    const second = await tenantEntry(other, { holder: PERSON.name, note: 'second' });
    const done = await inScope(db.app, { orgId: other.id, schema: other.schemaName }, (trx) =>
      redactor.redact(trx, {
        chain: { schema: other.schemaName },
        seqs: [first],
        replacements: { [PERSON.name]: 'Former user 7F3A' },
        attestation: { action: 'privacy.audit_redacted', reason: 'Erasure of a person' },
      }),
    );
    expect(done).toMatchObject({ chain: `${other.schemaName}.audit_trail`, redacted: 1 });
    expect(await verifier.verifyTenant({ orgId: other.id, schema: other.schemaName })).toMatchObject({ firstBrokenSeq: null, redacted: 1 });

    // The database owner changes the second row behind the append-only trigger.
    await inScope(db.migrator, { orgId: other.id, schema: other.schemaName }, async (trx) => {
      await sql.raw(`alter table ${other.schemaName}.audit_trail disable trigger audit_trail_append_only`).execute(trx);
      await sql.raw(`update ${other.schemaName}.audit_trail set after_data = '{"holder":"Someone else"}'::jsonb where seq = ${second}`).execute(trx);
      await sql.raw(`alter table ${other.schemaName}.audit_trail enable trigger audit_trail_append_only`).execute(trx);
    });
    const third = await tenantEntry(other, { holder: PERSON.name, note: 'third' });
    const redactionId = randomUUID();
    await expect(
      inScope(db.app, { orgId: other.id, schema: other.schemaName }, (trx) =>
        redactor.redact(trx, {
          chain: { schema: other.schemaName },
          seqs: [third, second],
          replacements: { [PERSON.name]: 'Former user 7F3A' },
          attestation: { action: 'privacy.audit_redacted', reason: 'Erasure of a person' },
          redactionId,
        }),
      ),
    ).rejects.toThrow(/no longer matches its stored hash/);
    const rows = await inScope(db.migrator, { orgId: other.id, schema: other.schemaName }, (trx) =>
      trx.selectFrom('audit_trail').selectAll().where((eb) => eb.or([eb('seq', '=', third), eb('redaction_id', '=', redactionId)])).execute(),
    );
    expect(rows).toEqual([expect.objectContaining({ redaction_id: null, source_ip: '203.0.113.20', after_data: { holder: PERSON.name, note: 'third' } })]);
    expect((await verifier.verifyTenant({ orgId: other.id, schema: other.schemaName })).firstBrokenSeq).toBe(Number(second));
  });

  it('keeps every audit table append-only for the application and for the owner without a redaction', async () => {
    const seq = await platformEntry(org.id, { ip: '203.0.113.10' });
    await expect(inScope(db.app, { platformScope: true }, (trx) => sql`update platform.audit_log set user_agent = null where seq = ${seq}`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(inScope(db.app, { platformScope: true }, (trx) => sql`select platform.redact_audit_rows('platform.audit_log', ${[seq]}::bigint[], ${randomUUID()}::uuid, '{"values":{}}'::jsonb)`.execute(trx))).rejects.toThrow(/reason is required/);
    await expect(db.migrator.transaction().execute(async (trx) => {
      await sql`select set_config('app.platform_scope', 'on', true)`.execute(trx);
      await sql`update platform.audit_log set source_ip = null where seq = ${seq}`.execute(trx);
    })).rejects.toThrow(/append-only/);
    await expect(db.migrator.transaction().execute(async (trx) => {
      await sql`select set_config('app.platform_scope', 'on', true)`.execute(trx);
      await sql`delete from platform.audit_log where seq = ${seq}`.execute(trx);
    })).rejects.toThrow(/append-only/);
  });

  it('purge_organization refuses an organisation that is not archived and a deletion that is not running or not due, and changes nothing', async () => {
    const target = await createTenant(db, 'purge_refused', { name: 'PT Refused' });
    const purge = () => inScope(db.app, { platformScope: true }, (trx) => sql`select platform.purge_organization(${target.id}::uuid)`.execute(trx));
    await expect(purge()).rejects.toThrow(/is active; only an archived organisation can be purged/);
    await inScope(db.migrator, { platformScope: true }, (trx) => sql`update platform.organization set status = 'archived' where id = ${target.id}`.execute(trx));
    await expect(purge()).rejects.toThrow(/not running/);
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.organization_deletion').values({ organization_id: target.id, status: 'scheduled', scheduled_for: new Date(Date.now() + 3_600_000) }).execute(),
    );
    await expect(purge()).rejects.toThrow(/not running/);
    await inScope(db.migrator, { platformScope: true }, (trx) => sql`update platform.organization_deletion set status = 'running' where organization_id = ${target.id}`.execute(trx));
    await expect(purge()).rejects.toThrow(/runs from that date/);
    expect(await schemaExists(db, target.schemaName)).toBe(true);
    const key = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.tenant_key').select('organization_id').where('organization_id', '=', target.id).executeTakeFirst());
    expect(key).toBeDefined();
    // Due: the schema, the platform rows and the data key go.
    await makeDue(db, target.id);
    const { rows } = await purge();
    expect((rows[0] as { purge_organization: Record<string, unknown> }).purge_organization).toMatchObject({ schemaDropped: true, dataKeys: 1 });
    expect(await schemaExists(db, target.schemaName)).toBe(false);
    expect(await schemaExists(db, org.schemaName)).toBe(true);
  });
});
