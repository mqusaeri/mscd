// The tenant scope of the bulk import (Milestone 2 D2-13): the import applies every row "in one transaction through
// the existing services". Those services open their own transaction with `TenantScope.withTenant`, so the imports
// module gives its own instances of them this scope instead (imports.module.ts): inside `inOneTransaction`, every
// `withTenant` of the same organisation joins the one transaction (its after-commit hooks, such as the in-memory job
// queue, run when that transaction commits), and outside it the scope behaves exactly as `TenantScope`.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import type { Trx } from '../../common/tokens';
import { DATABASE, type AppDatabase } from '../../db/database.module';
import { TenantScope, type TenantContext } from '../tenancy/tenant-scope';

interface Joined {
  trx: Trx;
  ctx: TenantContext;
}

@Injectable()
export class ImportTenantScope extends TenantScope {
  private readonly joined = new AsyncLocalStorage<Joined>();

  // The pool goes to `TenantScope` only, which opens every transaction of this scope (F.10).
  constructor(@Inject(DATABASE) pool: AppDatabase) {
    super(pool);
  }

  /**
   * Runs `fn` in one tenant transaction; every `withTenant` of the same organisation called while `fn` runs (also
   * from the command services of this module) runs in that transaction instead of opening its own.
   */
  inOneTransaction<T>(ctx: TenantContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return super.withTenant(ctx, (trx) => this.joined.run({ trx, ctx }, () => fn(trx)));
  }

  /** True while `inOneTransaction` runs in this call chain. */
  get inTransaction(): boolean {
    return this.joined.getStore() !== undefined;
  }

  /**
   * Runs `fn` in a transaction of its own, also while `inOneTransaction` runs (the progress of a commit, which others
   * must see before the commit's transaction ends).
   */
  detached<T>(ctx: TenantContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.joined.exit(() => super.withTenant(ctx, fn));
  }

  override withTenant<T>(ctx: TenantContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
    const current = this.joined.getStore();
    if (!current) return super.withTenant(ctx, fn);
    // A transaction of another organisation or schema never joins: that would be a cross-tenant write.
    if (current.ctx.orgId !== ctx.orgId || current.ctx.schema !== ctx.schema) {
      return Promise.reject(new Error('An import transaction cannot be joined by another organisation'));
    }
    return fn(current.trx);
  }
}
