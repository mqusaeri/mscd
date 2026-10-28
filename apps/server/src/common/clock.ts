import { Inject, Injectable, Optional } from '@nestjs/common';
import { MscdConfig } from '../config/mscd-config';
import { isIsoDate, localDate } from './dates';

/** Looks up the time zone of an organisation (`platform.organization.time_zone`); provided by the tenancy module. */
export interface OrgTimeZoneLookup {
  timeZoneOf(orgId: string): Promise<string>;
}

/** Injection token of the `OrgTimeZoneLookup` (the tenancy module binds it to `TenantResolver`). */
export const ORG_TIME_ZONE_LOOKUP = Symbol.for('mscd.orgTimeZoneLookup');

/** Default organisation time zone (C.4 `organization.time_zone` default). */
export const DEFAULT_TIME_ZONE = 'Asia/Jakarta';

/**
 * Time source of the server (D-07, A-22). `today(orgId)` is the organisation's local date; the profile key
 * `demo.fixed_today` (demo and test installs only, D-20) replaces it everywhere. Tests replace `now()` by
 * overriding the provider with `Clock.fixed(...)`.
 */
@Injectable()
export class Clock {
  constructor(
    private readonly config: MscdConfig,
    @Optional() @Inject(ORG_TIME_ZONE_LOOKUP) private readonly timeZones?: OrgTimeZoneLookup,
  ) {}

  /** A clock whose `now()` is always `at` (tests and commands that replay a date). */
  static fixed(config: MscdConfig, at: Date, timeZones?: OrgTimeZoneLookup): Clock {
    const clock = new Clock(config, timeZones);
    clock.now = () => new Date(at.getTime());
    return clock;
  }

  /** The current instant. */
  now(): Date {
    return new Date();
  }

  /** `demo.fixed_today` when demo mode sets it, else null. */
  get fixedToday(): string | null {
    const demo = this.config.profile.demo;
    return demo.enabled && demo.fixed_today ? demo.fixed_today : null;
  }

  /** Today in a time zone (IANA name), or `demo.fixed_today`. */
  todayIn(timeZone: string): string {
    return this.fixedToday ?? localDate(this.now(), timeZone);
  }

  /** Today in the organisation's time zone (D-07), or `demo.fixed_today`. */
  async today(orgId: string): Promise<string> {
    const fixed = this.fixedToday;
    if (fixed) return fixed;
    const timeZone = this.timeZones ? await this.timeZones.timeZoneOf(orgId) : DEFAULT_TIME_ZONE;
    return localDate(this.now(), timeZone);
  }

  /**
   * The local date a daily job works on (Milestone 2 D.2): `demo.fixed_today` when demo mode sets it, else the date of
   * its run (`localDate` of the payload, which `scheduler.tick` writes with the run's row in `platform.daily_job_run`),
   * else today in the organisation's time zone (a job sent another way, for example a manual run).
   */
  async runDate(orgId: string, runLocalDate?: string | null): Promise<string> {
    return this.fixedToday ?? checkedRunDate(runLocalDate) ?? (await this.today(orgId));
  }

  /** `runDate` for a caller that already knows the organisation's time zone. */
  runDateIn(timeZone: string, runLocalDate?: string | null): string {
    return this.fixedToday ?? checkedRunDate(runLocalDate) ?? localDate(this.now(), timeZone);
  }
}

/** The date of a daily run, or null without one; a malformed date fails the job instead of working on another day. */
export function checkedRunDate(runLocalDate: string | null | undefined): string | null {
  if (runLocalDate === undefined || runLocalDate === null) return null;
  if (!isIsoDate(runLocalDate)) throw new TypeError(`The localDate of a daily job must be a date YYYY-MM-DD, got ${JSON.stringify(runLocalDate)}`);
  return runLocalDate;
}
