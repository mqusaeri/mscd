// `withTenant` with `{ snapshot: true }` (Milestone 3 M3-12): a REPEATABLE READ, READ ONLY transaction whose first
// statement takes the snapshot, so a row another transaction commits afterwards stays invisible to every later
// statement; writes are refused; the idle timeout option applies to that transaction only; callers without options keep
// READ COMMITTED with writes. `holdSnapshot` (the organisation export): short transactions that import the held snapshot
// all see its instant, each keeps its table locks only until it ends (an ALTER TABLE waits for none of them, while it
// waits for one long snapshot transaction), a table rewritten after the snapshot fails the transaction that read it
// instead of showing it empty, and a snapshot can no longer be read once the holder has ended.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Trx } from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { HeldSnapshot, SnapshotTableRewrittenError, TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addUser, inScope } from '../db/helpers';
import { createIntApp, type IntApp } from './helpers';

describe('tenant snapshot transactions (M3-12)', () => {
  const db = useTestDatabase('empty');
  let ndt: CreatedTenant;
  let rina: string;
  let ctx: IntApp;
  let scope: TenantScope;

  const context = () => ({ orgId: ndt.id, schema: ndt.schemaName, userId: rina });
  const settings = sql<{ isolation: string; readOnly: string; idle: string }>`
    select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as "readOnly",
           current_setting('idle_in_transaction_session_timeout') as idle`;
  /** Commits a register row in a transaction of its own (another connection). */
  const commitParty = (code: string) =>
    inScope(db.migrator, { orgId: ndt.id, schema: ndt.schemaName }, (trx) => sql`insert into interested_party (code, title) values (${code}, 'Written by another transaction')`.execute(trx));
  const parties = (trx: Trx) =>
    sql<{ code: string }>`select code from interested_party where code like 'SNAP-%' order by code`.execute(trx).then((r) => r.rows.map((row) => row.code));
  const heldParties = (trx: Trx) =>
    sql<{ code: string }>`select code from interested_party where code like 'HELD-%' order by code`.execute(trx).then((r) => r.rows.map((row) => row.code));
  /** Runs DDL on the tenant's register table as the migrator, giving up after `lockTimeout` when another session holds a lock on it. */
  const alterParties = (statement: string, lockTimeout = '2s') =>
    db.migrator.transaction().execute(async (trx) => {
      await sql`select set_config('lock_timeout', ${lockTimeout}, true)`.execute(trx);
      await sql.raw(`alter table "${ndt.schemaName}".interested_party ${statement}`).execute(trx);
    });

  beforeAll(async () => {
    ndt = await createTenant(db, 'snap');
    rina = await addUser(db.migrator, 'rina.snap', [ndt.id]);
    ctx = await createIntApp(db);
    scope = ctx.moduleRef.get(TenantScope);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('runs REPEATABLE READ and READ ONLY, set before the scope settings, with the tenant scope as usual', async () => {
    const inside = await scope.withTenant(
      context(),
      async (trx) => {
        const { rows } = await sql<{ isolation: string; readOnly: string; idle: string; org: string; sp: string }>`
          select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as "readOnly",
                 current_setting('idle_in_transaction_session_timeout') as idle, current_setting('app.org_id') as org,
                 current_setting('search_path') as sp`.execute(trx);
        return rows[0]!;
      },
      { snapshot: true, idleTimeoutSeconds: 3600 },
    );
    expect(inside).toEqual({ isolation: 'repeatable read', readOnly: 'on', idle: '1h', org: ndt.id, sp: `"${ndt.schemaName}", ext` });
  });

  it('reads one snapshot taken by the first statement: a row committed elsewhere afterwards stays invisible', async () => {
    await commitParty('SNAP-1');
    const seen = await scope.withTenant(
      context(),
      async (trx) => {
        const before = await parties(trx);
        await commitParty('SNAP-2');
        const after = await parties(trx);
        return { before, after };
      },
      { snapshot: true },
    );
    expect(seen).toEqual({ before: ['SNAP-1'], after: ['SNAP-1'] });
    // A transaction without options reads committed rows statement by statement, as before.
    const plain = await scope.withTenant(context(), async (trx) => {
      const before = await parties(trx);
      await commitParty('SNAP-3');
      return { before, after: await parties(trx) };
    });
    expect(plain).toEqual({ before: ['SNAP-1', 'SNAP-2'], after: ['SNAP-1', 'SNAP-2', 'SNAP-3'] });
  });

  it('refuses a write in a snapshot transaction (25006) and leaves the defaults to every other transaction', async () => {
    await expect(
      scope.withTenant(context(), (trx) => sql`insert into interested_party (code, title) values ('SNAP-W', 'Write in a snapshot')`.execute(trx), { snapshot: true }),
    ).rejects.toMatchObject({ code: '25006' });
    const plain = await scope.withTenant(context(), async (trx) => (await settings.execute(trx)).rows[0]!);
    expect(plain).toEqual({ isolation: 'read committed', readOnly: 'off', idle: expect.any(String) });
    expect(plain.idle).not.toBe('1h');
    await scope.withTenant(context(), (trx) => sql`insert into interested_party (code, title) values ('SNAP-W', 'Write without options')`.execute(trx));
    expect(await scope.withTenant(context(), parties)).toContain('SNAP-W');
  });

  it('refuses an idle timeout that is no whole number of seconds from 0 to a day', async () => {
    for (const idleTimeoutSeconds of [-1, 1.5, 86_401]) {
      await expect(scope.withTenant(context(), async () => 1, { snapshot: true, idleTimeoutSeconds })).rejects.toThrow('bad idle timeout');
      await expect(scope.holdSnapshot(async () => 1, { idleTimeoutSeconds })).rejects.toThrow('bad idle timeout');
    }
    expect(await scope.withTenant(context(), async (trx) => (await settings.execute(trx)).rows[0]!.idle, { idleTimeoutSeconds: 0 })).toBe('0');
  });

  it('holds one snapshot for several short transactions: each sees the instant the holder exported, with the tenant scope', async () => {
    await commitParty('HELD-1');
    const seen = await scope.holdSnapshot(
      async (held) => {
        expect(held).toBeInstanceOf(HeldSnapshot);
        await commitParty('HELD-2');
        const first = await scope.withTenant(context(), heldParties, { snapshot: held });
        await commitParty('HELD-3');
        const second = await scope.withTenant(
          context(),
          async (trx) => ({ codes: await heldParties(trx), settings: (await settings.execute(trx)).rows[0]!, org: (await sql<{ org: string }>`select current_setting('app.org_id') as org`.execute(trx)).rows[0]!.org }),
          { snapshot: held },
        );
        return { first, second };
      },
      { idleTimeoutSeconds: 3600 },
    );
    expect(seen.first).toEqual(['HELD-1']);
    expect(seen.second.codes).toEqual(['HELD-1']);
    // Each short transaction is REPEATABLE READ and READ ONLY with the role's idle limit; the holder's limit is its own.
    expect(seen.second.settings).toMatchObject({ isolation: 'repeatable read', readOnly: 'on' });
    expect(seen.second.settings.idle).not.toBe('1h');
    expect(seen.second.org).toBe(ndt.id);
    // A write in a transaction of a held snapshot is refused like in any snapshot transaction.
    await expect(
      scope.holdSnapshot((held) => scope.withTenant(context(), (trx) => sql`insert into interested_party (code, title) values ('HELD-W', 'Write')`.execute(trx), { snapshot: held })),
    ).rejects.toMatchObject({ code: '25006' });
    expect(await scope.withTenant(context(), heldParties)).toEqual(['HELD-1', 'HELD-2', 'HELD-3']);
  });

  it('keeps table locks per short transaction: an ALTER TABLE waits for none of them while the snapshot is held, and for a long snapshot transaction it does', async () => {
    await scope.holdSnapshot(async (held) => {
      expect(await scope.withTenant(context(), heldParties, { snapshot: held })).toEqual(['HELD-1', 'HELD-2', 'HELD-3']);
      // The register table was read, but by a transaction that has ended: the migrator gets its lock at once.
      await alterParties('add column snapshot_probe text');
      await alterParties('drop column snapshot_probe');
      // A column added without rewriting the table changes nothing for the held snapshot.
      expect(await scope.withTenant(context(), heldParties, { snapshot: held })).toEqual(['HELD-1', 'HELD-2', 'HELD-3']);
    });
    // One long snapshot transaction keeps its lock on every table it read until it ends.
    await scope.withTenant(
      context(),
      async (trx) => {
        await heldParties(trx);
        await expect(alterParties('add column snapshot_probe text', '500ms')).rejects.toMatchObject({ code: '55P03' });
      },
      { snapshot: true },
    );
  });

  it('fails a transaction of a held snapshot that read a table rewritten after the snapshot, which would show it empty', async () => {
    const seen: { read: string[] | null } = { read: null };
    await scope.holdSnapshot(async (held) => {
      expect(await scope.withTenant(context(), heldParties, { snapshot: held })).toEqual(['HELD-1', 'HELD-2', 'HELD-3']);
      // A volatile default rewrites the table (as some upgrade migrations do); the rows get the migrator's transaction.
      await alterParties('add column snapshot_probe timestamptz default clock_timestamp()');
      const failed = scope.withTenant(
        context(),
        async (trx) => {
          seen.read = await heldParties(trx);
          return seen.read;
        },
        { snapshot: held },
      );
      await expect(failed).rejects.toBeInstanceOf(SnapshotTableRewrittenError);
      await expect(failed).rejects.toThrow(`${ndt.schemaName}.interested_party`);
    });
    // The old snapshot saw the rewritten table without rows; the check refused to hand that on.
    expect(seen.read).toEqual([]);
    await alterParties('drop column snapshot_probe');
    expect(await scope.withTenant(context(), heldParties)).toEqual(['HELD-1', 'HELD-2', 'HELD-3']);
  });

  it('refuses to read a held snapshot once the holder has ended', async () => {
    const kept = await scope.holdSnapshot(async (held) => held);
    expect(kept.isEnded).toBe(true);
    await expect(scope.withTenant(context(), heldParties, { snapshot: kept })).rejects.toThrow('The held snapshot has ended');
  });
});
