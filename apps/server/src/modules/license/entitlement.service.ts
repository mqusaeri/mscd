// Per-organisation entitlements of the platform operator (Milestone 2 D.1, K.6, M2-S10), multi tenancy only (single
// tenancy answers 409 `conflict` with messageKey `single_tenancy`, J.6, and keeps the signed licence file):
// - `GET /ops/organizations/{org}/entitlements`: the `platform.entitlement` row with the current use (active members
//   without guests, systems that are not archived) and its ETag. An organisation with a signed licence installed
//   before M2-S10 gets its row from that licence on this first read (LicenceService); without a row the answer is 404.
// - `PUT /ops/organizations/{org}/entitlements`: a preset of `license.plans` or explicit limits. `If-Match` is
//   required (428 without it, 412 when it names another version; `*` replaces any row and creates a missing one). One
//   `ops.entitlements_changed` entry with the old and new values. A limit below the current use is accepted with a
//   warning (`LIC-USERS`, `LIC-MS`); new invitations then stop with `LIC-USERS`.
// - `GET /ops/plans`: the presets of `license.plans`.
// - `applyPreset(trx, orgId, preset)`: the row of a preset in the caller's transaction; M2-S09 calls it from
//   `ops.organizations.create` and `tenant onboard`.
// - The command line (`license entitlements show` and `set`) uses `show` and `change`.
// Every write runs in platform scope (EntitlementStore), sends the change notice and queues `license.check`, so the
// licence alerts and read-only repositories follow the new limits at once.
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ActorKind, Entitlement, EntitlementSet, EntitlementSetResult, PlanPreset, Warning } from '@mscd/shared';
import { Clock } from '../../common/clock';
import { isIsoDate } from '../../common/dates';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { ConflictError, PreconditionFailedError, ProblemError, ValidationError } from '../../common/problems';
import { SYSTEM_USER_ID, type Principal, type TenantInfo, type Trx } from '../../common/tokens';
import { acceptsAfterCommit, afterCommit } from '../../common/transaction-hooks';
import { MscdConfig } from '../../config/mscd-config';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope } from '../tenancy/tenant-scope';
import {
  entitlementEtag,
  entitlementView,
  ifMatchOf,
  planPresets,
  presetValues,
  readEntitlement,
  type EntitlementRecord,
  type EntitlementValues,
  type PlanPresetConfig,
} from './entitlement-row';
import { EntitlementStore, type EntitlementChange } from './entitlement-store';
import { LicenceService } from './licence.service';

/** 428: a change of the entitlement needs `If-Match` (Milestone 2 D.1 `ops.entitlements.set`). */
export class IfMatchRequiredError extends ProblemError {
  override readonly status = 428;

  constructor() {
    super('precondition-failed', {
      title: 'Precondition required',
      detail: 'Send the ETag of the entitlement you read in If-Match, or * to replace any entitlement',
      messageKey: 'if_match_required',
      messages: {
        en: 'Reload the entitlement and save again: the change must name the version it replaces.',
        id: 'Muat ulang hak pakai lalu simpan lagi: perubahan harus menyebut versi yang digantikannya.',
      },
    });
  }
}

/** 409 `conflict` with messageKey `single_tenancy` (J.6): single tenancy keeps the signed licence file. */
export function entitlementsSingleTenancy(): ConflictError {
  return new ConflictError('This installation runs one organisation (tenancy.mode single); its licence is the signed licence file', {
    messageKey: 'single_tenancy',
  });
}

/** 422 `business-rule` with messageKey `unknown_preset`: `license.plans` has no preset of this name. */
export function unknownPreset(name: string): ProblemError {
  const en = `There is no plan preset ${name} in license.plans`;
  return new ProblemError('business-rule', { detail: en, messageKey: 'unknown_preset', messages: { en, id: `Tidak ada preset paket ${name} di license.plans` } });
}

/** The entitlement of an organisation as the api shows it, with its ETag. */
export interface EntitlementRead {
  entitlement: Entitlement;
  etag: string;
}

/** The result of a change: the api result, its ETag and whether the row changed. */
export interface EntitlementWrite {
  result: EntitlementSetResult;
  etag: string;
  changed: boolean;
}

/** The new values of a change, from the current row (null: none yet) and the organisation's local date. */
export type EntitlementValuesOf = (current: EntitlementRecord | null, today: string) => { values: EntitlementValues; reason: string };

@Injectable()
export class EntitlementService {
  private readonly clock: Clock;

  constructor(
    private readonly config: MscdConfig,
    private readonly licences: LicenceService,
    private readonly store: EntitlementStore,
    @Optional() private readonly scope?: TenantScope,
    @Optional() private readonly tenants?: TenantResolver,
    @Optional() clock?: Clock,
    @Optional() @Inject(JOB_QUEUE) private readonly jobs?: JobQueue,
  ) {
    this.clock = clock ?? new Clock(config);
  }

  /** `GET /ops/plans`. */
  plans(): PlanPreset[] {
    this.assertMultiTenancy();
    return planPresets(this.config.profile.license.plans);
  }

  /** `GET /ops/organizations/{org}/entitlements` (404 when the organisation has no entitlement). */
  async get(principal: Principal | null, slug: string): Promise<EntitlementRead> {
    const found = await this.show(slug, principal?.user.id ?? SYSTEM_USER_ID);
    if (!found) {
      throw new ProblemError('not-found', {
        detail: `Organisation ${slug} has no entitlement yet: set a plan preset or limits`,
        messageKey: 'no_entitlement',
        messages: {
          en: 'This organisation has no plan yet. Choose a plan preset or set the limits.',
          id: 'Organisasi ini belum memiliki paket. Pilih preset paket atau tetapkan batasnya.',
        },
      });
    }
    return found;
  }

  /** The entitlement of an organisation with its current use, or null without one (also `license entitlements show`). */
  async show(slug: string, userId: string = SYSTEM_USER_ID): Promise<EntitlementRead | null> {
    this.assertMultiTenancy();
    const org = await this.organisation(slug);
    return this.requireScope().withTenant({ orgId: org.id, schema: org.schema, userId }, async (trx) => {
      // The licence read writes the row of a signed licence installed before M2-S10 (once).
      const evaluated = await this.licences.evaluate(trx, org.id, { reportRollback: false });
      const row = evaluated?.entitlement ?? (await readEntitlement(trx, org.id));
      if (!row) return null;
      return { entitlement: entitlementView(row, org.slug, await this.usage(trx, org.id)), etag: entitlementEtag(row) };
    });
  }

  /** `PUT /ops/organizations/{org}/entitlements`. */
  async set(principal: Principal, slug: string, body: EntitlementSet, ifMatch: string | undefined): Promise<EntitlementWrite> {
    this.assertMultiTenancy();
    const org = await this.organisation(slug);
    if (ifMatchOf(ifMatch, null) === 'missing') throw new IfMatchRequiredError();
    const valuesOf = this.valuesOfBody(body);
    return this.change(org, valuesOf, { userId: principal.user.id, kind: 'operator' }, ifMatch);
  }

  /**
   * Changes the entitlement of an organisation in one transaction: the backfill of an old signed licence first (so the
   * audit entry shows its values as the old ones), the `If-Match` check when `ifMatch` is given (null: no check, the
   * command line), the write, and warnings for limits below the current use.
   */
  async change(org: TenantInfo, valuesOf: EntitlementValuesOf, actor: { userId: string | null; kind: ActorKind }, ifMatch: string | null | undefined): Promise<EntitlementWrite> {
    this.assertMultiTenancy();
    const today = this.clock.todayIn(org.timeZone);
    return this.requireScope().withTenant({ orgId: org.id, schema: org.schema, userId: actor.userId ?? SYSTEM_USER_ID }, async (trx) => {
      await this.store.lock(trx, org.id);
      await this.licences.evaluate(trx, org.id, { reportRollback: false });
      const current = await readEntitlement(trx, org.id);
      if (ifMatch !== null && ifMatchOf(ifMatch, current) !== 'ok') throw new PreconditionFailedError(org.slug);
      const { values, reason } = valuesOf(current, today);
      const change: EntitlementChange = { actor, reason, slug: org.slug };
      const { row, changed } = await this.store.write(trx, org.id, values, change);
      if (changed) this.queueLicenceCheck(trx, org.id, row, actor.userId);
      const usage = await this.usage(trx, org.id);
      const warnings = warningsOf(row, usage);
      const result: EntitlementSetResult = {
        ok: true,
        changed: [],
        data: entitlementView(row, org.slug, usage),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      return { result, etag: entitlementEtag(row), changed };
    });
  }

  /**
   * Writes the entitlement of a preset of `license.plans` in the caller's transaction (platform scope or the
   * organisation's own transaction), starting on `validFrom` or today in the organisation's time zone. 422
   * `unknown_preset` when the profile has no such preset. M2-S09 calls it when an organisation is created.
   */
  async applyPreset(
    trx: Trx,
    orgId: string,
    preset: string,
    options: { validFrom?: string; actor?: { userId: string | null; kind: ActorKind }; slug?: string | null } = {},
  ): Promise<EntitlementRecord> {
    this.assertMultiTenancy();
    const config = this.preset(preset);
    if (options.validFrom !== undefined && !isIsoDate(options.validFrom)) {
      throw new ValidationError([{ path: 'validFrom', message: 'must be a date YYYY-MM-DD' }]);
    }
    let validFrom = options.validFrom;
    if (validFrom === undefined) {
      const org = await trx.selectFrom('platform.organization').select('time_zone').where('id', '=', orgId).executeTakeFirst();
      validFrom = this.clock.todayIn(org?.time_zone ?? 'Asia/Jakarta');
    }
    const { row, changed } = await this.store.write(trx, orgId, presetValues(preset, config, validFrom), {
      reason: 'preset',
      ...(options.actor ? { actor: options.actor } : {}),
      slug: options.slug ?? null,
    });
    if (changed) this.queueLicenceCheck(trx, orgId, row, options.actor?.userId ?? null);
    return row;
  }

  /** The preset of `license.plans` with this name; 422 `unknown_preset` when there is none. */
  preset(name: string): PlanPresetConfig {
    const plans = this.config.profile.license.plans;
    if (!Object.hasOwn(plans, name)) throw unknownPreset(name);
    return plans[name]!;
  }

  /** The organisation of a slug (not deleted); 404 when there is none. */
  async organisation(slug: string): Promise<TenantInfo> {
    const tenants = this.tenants;
    if (!tenants || !this.scope) throw new Error('Entitlements need the tenancy and database modules');
    const org = await tenants.resolveBySlug(slug);
    if (!org) throw new ProblemError('not-found', { detail: `Unknown organisation ${slug}`, messageKey: 'unknown_organisation' });
    return org;
  }

  /**
   * The values of a request body (also `license entitlements set`): a preset (from its `validFrom` or today) or
   * explicit limits (source `manual`). 422 `unknown_preset` and 400 for an end before the start are thrown here.
   */
  valuesOfBody(body: EntitlementSet): EntitlementValuesOf {
    if ('preset' in body) {
      const config = this.preset(body.preset);
      return (_current, today) => ({ values: presetValues(body.preset, config, body.validFrom ?? today), reason: 'preset' });
    }
    if (body.validUntil !== null && body.validUntil < body.validFrom) {
      throw new ValidationError([{ path: 'body.validUntil', message: 'must not be before validFrom' }]);
    }
    const values: EntitlementValues = {
      plan: body.plan ?? null,
      source: 'manual',
      maxUsers: body.maxUsers,
      maxManagementSystems: body.maxManagementSystems,
      frameworks: [...body.frameworks],
      storageAdapters: [...body.storageAdapters],
      features: [...body.features],
      rateUserPerMinute: body.rateUserPerMinute,
      rateOrgPerMinute: body.rateOrgPerMinute,
      validFrom: body.validFrom,
      validUntil: body.validUntil,
      graceDays: body.graceDays,
    };
    return () => ({ values, reason: 'limits' });
  }

  /** Current use: active members without guests (product decision 5) and systems that are not archived. */
  private async usage(trx: Trx, orgId: string): Promise<{ users: number; managementSystems: number }> {
    return { users: await this.licences.countActiveUsers(trx, orgId), managementSystems: await this.licences.countManagementSystems(trx) };
  }

  /** `license.check` after the commit, so the licence alerts and read-only repositories follow the change (E.2). */
  private queueLicenceCheck(trx: Trx, orgId: string, row: EntitlementRecord, requestedBy: string | null): void {
    const jobs = this.jobs;
    if (!jobs || !acceptsAfterCommit(trx)) return;
    afterCommit(trx, async () => {
      await jobs.send(
        'license.check',
        { orgId, ...(requestedBy ? { requestedBy } : {}), payload: {} },
        { singletonKey: `lc:${orgId}:e${row.version}`, retryLimit: 3 },
      );
    });
  }

  private assertMultiTenancy(): void {
    if (this.config.profile.tenancy.mode !== 'multi') throw entitlementsSingleTenancy();
  }

  private requireScope(): TenantScope {
    if (!this.scope) throw new Error('Entitlements need the tenancy and database modules');
    return this.scope;
  }
}

/** Warnings of limits below the current use (accepted, D.1 Warnings): new users or systems are then refused. */
export function warningsOf(row: EntitlementRecord, usage: { users: number; managementSystems: number }): Warning[] {
  const warnings: Warning[] = [];
  if (usage.users > row.maxUsers) {
    warnings.push({
      rule: 'LIC-USERS',
      messages: {
        en: `The organisation has ${usage.users} active members and the new limit is ${row.maxUsers}. Nobody loses access, but no one can be added or invited until the number is below the limit.`,
        id: `Organisasi ini memiliki ${usage.users} anggota aktif dan batas barunya ${row.maxUsers}. Tidak ada yang kehilangan akses, tetapi tidak ada yang dapat ditambahkan atau diundang sampai jumlahnya di bawah batas.`,
      },
    });
  }
  if (usage.managementSystems > row.maxManagementSystems) {
    warnings.push({
      rule: 'LIC-MS',
      messages: {
        en: `The organisation has ${usage.managementSystems} management systems and the new limit is ${row.maxManagementSystems}. The systems stay as they are, but no new one can be created.`,
        id: `Organisasi ini memiliki ${usage.managementSystems} sistem manajemen dan batas barunya ${row.maxManagementSystems}. Sistem yang ada tetap seperti semula, tetapi sistem baru tidak dapat dibuat.`,
      },
    });
  }
  return warnings;
}
