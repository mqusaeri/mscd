// A randomised simulation of `scheduler.tick` and the daily jobs of one organisation (Milestone 2 D.2, risk table I),
// on the pure planner of the run ledger (`planDailyRuns`). It models what the database and the queue do around it:
// the ledger rows (`insert ... on conflict do nothing`), the E.1 singleton keys (a send is dropped while a job with
// the same key waits), the delay of a job to its local minute, and a job that starts after its delay and works on the
// date of its payload. Ticks come hourly at minute 5 with jitter (up to 5 minutes early, up to 40 minutes late), some
// twice, some not at all (single misses and an outage of hours); the clock may be set back one hour; the organisation
// changes its time zone once or twice, east or west, at any second (between minute 0 and 5 of an hour, late in the new
// zone's day, while a delayed job waits, or anywhere), with moves of 17 hours or more.
//
// Oracle, per (job, local date):
// - double: worked on twice;
// - miss: not worked on although a tick that ran saw its local time passed, in the zone that tick read and on a date
//   that was the current or the previous local date at that tick (the catch-up window), and ticks went on after it;
// - mismatch: the date worked on differs from the date of the run's ledger row, or a ledger row got no job (a send
//   that a waiting job with the same singleton key dropped).
import { addDays, instantOfLocal, localDate } from '../../../src/common/dates';
import { planDailyRuns, type LedgerRun } from '../../../src/modules/jobs/daily-run-planner';
import { DAILY_JOBS, localTimeOf, weekdayOfDate, type DailyJob } from '../../../src/modules/jobs/schedules';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ORG = '00000000-0000-4000-8000-0000000000aa';

/** Zones with whole, half and three-quarter hour offsets, daylight saving, and the far east and west (UTC+14 to UTC-12). */
export const SIM_ZONES: readonly string[] = [
  'Asia/Jakarta', 'Asia/Tokyo', 'Asia/Jayapura', 'America/New_York', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Kolkata',
  'Asia/Kathmandu', 'Australia/Adelaide', 'Pacific/Chatham', 'America/St_Johns', 'Pacific/Kiritimati', 'Pacific/Pago_Pago',
  'Etc/GMT+12', 'Pacific/Honolulu',
];
/** A move between these two groups is 16 to 26 hours. */
const FAR_WEST: readonly string[] = ['Etc/GMT+12', 'Pacific/Pago_Pago', 'Pacific/Honolulu', 'America/Los_Angeles'];
const FAR_EAST: readonly string[] = ['Pacific/Kiritimati', 'Pacific/Chatham', 'Asia/Tokyo', 'Asia/Jayapura'];

/** Local hours and minute ranges in which a job of the tick of that hour waits for its minute. */
const DELAY_WINDOWS: readonly [hour: number, from: number, to: number][] = [[0, 6, 29], [2, 6, 44], [3, 6, 14], [6, 6, 29]];

/** mulberry32: a small seeded generator, so every run of the simulation is reproducible. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hhmm = (hour: number, minute: number) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

export interface SimulationOptions {
  /** The date a job works on: its payload (the ledger design) or the local date at its start (the design it replaces). */
  workOn?: 'payload' | 'date-at-start';
}

export interface SimulationResult {
  seed: number;
  ticks: number;
  /** `<zone> -> <zone> at <instant>` per change. */
  zoneChanges: string[];
  clockSetBack: boolean;
  /** Jobs started. */
  runs: number;
  doubles: string[];
  misses: string[];
  mismatches: string[];
  /** Runs whose local date at their start differs from their payload date (what the payload date protects against). */
  startDateDiffers: number;
}

interface WaitingJob {
  job: DailyJob;
  localDate: string;
  key: string;
  startAt: number;
}

/** One simulated organisation over five days. */
export function simulate(seed: number, options: SimulationOptions = {}): SimulationResult {
  const random = generator(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const between = (from: number, to: number) => from + random() * (to - from);

  const start = Date.UTC(2030, 0, 1) + Math.floor(random() * 365) * DAY;
  const end = start + 5 * DAY;
  const createdAt = new Date(start - 30 * DAY);

  // The time zones: the first, then one or two changes from the second day on.
  let firstZone = pick(SIM_ZONES);
  const changes: { at: number; zone: string }[] = [];
  const changeCount = random() < 0.5 ? 1 : 2;
  let current = firstZone;
  let earliest = start + DAY;
  for (let i = 0; i < changeCount; i++) {
    let to: string;
    if (random() < 0.4) {
      // A move of 16 to 26 hours across the date line, east or west.
      if (FAR_WEST.includes(current)) to = pick(FAR_EAST);
      else if (FAR_EAST.includes(current)) to = pick(FAR_WEST);
      else if (i === 0) {
        const east = random() < 0.5;
        firstZone = current = pick(east ? FAR_WEST : FAR_EAST);
        to = pick(east ? FAR_EAST : FAR_WEST);
      } else to = pick([...FAR_EAST, ...FAR_WEST]);
    } else {
      to = pick(SIM_ZONES.filter((z) => z !== current));
    }
    const base = between(earliest, earliest + DAY);
    let at = base;
    const mode = Math.floor(random() * 4);
    if (mode === 1) {
      // Between minute 0 and minute 5 of a UTC hour, before the tick of that hour.
      at = Math.floor(base / HOUR) * HOUR + random() * 5 * MINUTE;
    } else if (mode === 2) {
      // Late in the new zone's day: 20:00 to 23:59 there.
      const date = localDate(new Date(base), to);
      const time = hhmm(20 + Math.floor(random() * 4), Math.floor(random() * 60));
      at = instantOfLocal(date, time, to).getTime();
      if (at < earliest) at = instantOfLocal(addDays(date, 1), time, to).getTime();
    } else if (mode === 3) {
      // While a delayed job of the current zone waits for its minute.
      const [hour, from, until] = pick(DELAY_WINDOWS);
      const date = localDate(new Date(base), current);
      const time = hhmm(hour, from + Math.floor(random() * (until - from + 1)));
      at = instantOfLocal(date, time, current).getTime() + Math.floor(random() * 60) * 1000;
      if (at < earliest) at = instantOfLocal(addDays(date, 1), time, current).getTime();
    }
    changes.push({ at, zone: to });
    current = to;
    earliest = at + HOUR;
  }
  const zoneAt = (instant: number): string => {
    let zone = firstZone;
    for (const change of changes) if (change.at <= instant) zone = change.zone;
    return zone;
  };

  // Ticks: hourly at minute 5 with jitter, single misses, an outage, second ticks in an hour.
  const ticks: number[] = [];
  const outage = random() < 0.3 ? { from: between(start + 6 * HOUR, end - 30 * HOUR), hours: 2 + random() * 8 } : null;
  for (let k = 0; k < 5 * 24; k++) {
    const slot = start + k * HOUR + 5 * MINUTE;
    if (outage && slot >= outage.from && slot < outage.from + outage.hours * HOUR) continue;
    if (random() < 0.08) continue;
    const kind = random();
    const jitter = kind < 0.2 ? -random() * 5 * MINUTE : kind < 0.5 ? random() * 40 * MINUTE : (random() - 0.5) * MINUTE;
    ticks.push(slot + jitter);
    if (random() < 0.08) ticks.push(slot + between(-5 * MINUTE, 55 * MINUTE));
  }
  ticks.sort((a, b) => a - b);

  // The clock may be set back one hour once.
  const setBackAt = random() < 0.35 ? between(start + 12 * HOUR, end - DAY) : null;
  const clock = (instant: number) => (setBackAt !== null && instant >= setBackAt ? instant - HOUR : instant);

  // The ledger holds the runs of the three days before the start (a system that has been running).
  const ledger = new Map<string, LedgerRun>();
  const firstDate = localDate(new Date(start), firstZone);
  for (let d = -3; d <= -1; d++) {
    const date = addDays(firstDate, d);
    for (const job of DAILY_JOBS) {
      if (job.weekday !== undefined && weekdayOfDate(date) !== job.weekday) continue;
      ledger.set(`${job.name}@${date}`, { job: job.name, localDate: date, scheduledFor: instantOfLocal(date, job.at, firstZone) });
    }
  }
  const firstLocalDate = addDays(firstDate, -3);

  const waiting: WaitingJob[] = [];
  const worked = new Map<string, number>();
  const mismatches: string[] = [];
  const required = new Set<string>();
  let runs = 0;
  let startDateDiffers = 0;

  const startJobsUntil = (instant: number) => {
    waiting.sort((a, b) => a.startAt - b.startAt);
    while (waiting.length > 0 && waiting[0]!.startAt <= instant) {
      const job = waiting.shift()!;
      runs++;
      const dateAtStart = localDate(new Date(clock(job.startAt)), zoneAt(job.startAt));
      if (dateAtStart !== job.localDate) startDateDiffers++;
      const date = options.workOn === 'date-at-start' ? dateAtStart : job.localDate;
      if (date !== job.localDate) mismatches.push(`${job.job.name} of ${job.localDate} worked on ${date}`);
      const key = `${job.job.name}@${date}`;
      worked.set(key, (worked.get(key) ?? 0) + 1);
    }
  };

  for (const tick of ticks) {
    startJobsUntil(tick);
    const now = new Date(clock(tick));
    const zone = zoneAt(tick);
    const planned = planDailyRuns({ orgId: ORG, now, timeZone: zone, createdAt, ledger: [...ledger.values()], firstLocalDate, jobs: DAILY_JOBS });
    for (const run of planned) {
      const key = `${run.job.name}@${run.localDate}`;
      // The database keeps the first row (`on conflict do nothing`); the tick sends nothing for an existing row.
      if (ledger.has(key)) continue;
      ledger.set(key, { job: run.job.name, localDate: run.localDate, scheduledFor: run.scheduledFor });
      if (waiting.some((w) => w.key === run.singletonKey)) {
        mismatches.push(`${key}: the send was dropped by a waiting job with the key ${run.singletonKey}`);
        continue;
      }
      waiting.push({ job: run.job, localDate: run.localDate, key: run.singletonKey, startAt: tick + run.startAfterSeconds * 1000 });
    }
    // The oracle counts the ticks that later ticks follow (the last half day only runs what is due).
    if (tick > end - 12 * HOUR) continue;
    const local = localTimeOf(now, zone);
    const time = hhmm(local.hour, local.minute);
    for (const date of [addDays(local.date, -1), local.date]) {
      if (date < firstDate) continue; // the runs before the start are in the ledger
      for (const job of DAILY_JOBS) {
        if (job.weekday !== undefined && weekdayOfDate(date) !== job.weekday) continue;
        if (date < local.date || job.at <= time) required.add(`${job.name}@${date}`);
      }
    }
  }
  startJobsUntil(Number.POSITIVE_INFINITY);

  return {
    seed,
    ticks: ticks.length,
    zoneChanges: changes.map((c, i) => `${i === 0 ? firstZone : changes[i - 1]!.zone} -> ${c.zone} at ${new Date(c.at).toISOString()}`),
    clockSetBack: setBackAt !== null,
    runs,
    doubles: [...worked].filter(([, n]) => n > 1).map(([key, n]) => `${key} x${n}`),
    misses: [...required].filter((key) => !worked.has(key)),
    mismatches,
    startDateDiffers,
  };
}
