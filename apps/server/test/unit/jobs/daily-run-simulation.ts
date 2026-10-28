// A randomised simulation of `scheduler.tick` and the daily jobs of one organisation (Milestone 2 D.2, risk table I),
// on the pure planner of the run ledger (`planDailyRuns`). It models what the database and the queue do around it:
// the ledger rows (`insert ... on conflict do nothing`), the E.1 singleton keys (a send is dropped while a job with
// the same key waits or works), the delay of a job to its local minute, and a job that starts after its delay and
// works on the date of its payload. Ticks come hourly at minute 5 with jitter (up to 5 minutes early, up to 40 minutes
// late), some twice, some not at all (single misses and an outage of hours); the clock may be set back one hour; the
// organisation changes its time zone once or twice, east or west, at any second (between minute 0 and 5 of an hour,
// late in the new zone's day, while a delayed job waits, or anywhere), with moves of 17 hours or more.
//
// Two queue models (`SimulationOptions.queue`):
// - instant: a job starts at its due instant and is done at once;
// - busy: a job starts up to 2 seconds after its due instant (3% of them up to 70 minutes late) and works up to
//   3 minutes, holding its singleton key from its send to its end; 5% of the ticks are retried 1 to 900 seconds
//   later, and 15% of the organisations also have an outage of 24 to 36 hours (two dates of a job to catch up).
// Two drivers (`SimulationOptions.driver`): pg-boss, whose dropped send resolves to null in the tick's transaction
// (the tick then deletes the row of a key `<prefix>:<org>:all`, scheduler-tick.job.ts), and the BullMQ outbox, whose
// drop the tick never sees.
//
// Oracle, per (job, local date):
// - double: worked on twice;
// - miss: not worked on although a tick that ran saw its local time passed, in the zone that tick read and on a date
//   that was the current or the previous local date at that tick (the catch-up window), and ticks went on after it;
// - mismatch: the date worked on differs from the date of the run's ledger row, or a ledger row got no job (a send
//   that a queued job with the same singleton key dropped).
import { addDays, instantOfLocal, localDate } from '../../../src/common/dates';
import { planDailyRuns, type LedgerRun, type PlannedRun } from '../../../src/modules/jobs/daily-run-planner';
import { DAILY_JOBS, localTimeOf, weekdayOfDate } from '../../../src/modules/jobs/schedules';

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

/**
 * The local date of an instant, for the simulation's own bookkeeping: the zone's offset is looked up once per quarter
 * hour (every offset change of the simulated zones falls on a quarter hour in UTC).
 */
const offsets = new Map<string, number>();
function simWallClock(instant: number, zone: string): string {
  const key = `${zone}|${Math.floor(instant / (15 * MINUTE))}`;
  let offset = offsets.get(key);
  if (offset === undefined) {
    const at = Math.floor(instant / (15 * MINUTE)) * 15 * MINUTE;
    const local = localTimeOf(new Date(at), zone);
    offset = Date.UTC(Number(local.date.slice(0, 4)), Number(local.date.slice(5, 7)) - 1, Number(local.date.slice(8, 10)), local.hour, local.minute, local.second) - at;
    if (offsets.size > 200_000) offsets.clear();
    offsets.set(key, offset);
  }
  // `YYYY-MM-DDTHH:MM`
  return new Date(instant + offset).toISOString().slice(0, 16);
}
const simLocalDate = (instant: number, zone: string) => simWallClock(instant, zone).slice(0, 10);

export interface SimulationOptions {
  /** The date a job works on: its payload (the ledger design) or the local date at its start (the design it replaces). */
  workOn?: 'payload' | 'date-at-start';
  /** How long jobs stay in the queue (see the file comment); instant by default. */
  queue?: 'instant' | 'busy';
  /** What the tick learns of a send the queue drops (see the file comment); pg-boss by default. */
  driver?: 'pgboss' | 'outbox';
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
  /** Sends the queue dropped (a queued job held the key); with pg-boss the tick deleted their rows. */
  dropped: number;
  /** Jobs that started up to 70 minutes after their due instant (busy queue). */
  lateStarts: number;
  /** Ticks retried within 15 minutes (busy queue). */
  retriedTicks: number;
  /** Whether an outage of 24 to 36 hours happened (busy queue). */
  longOutage: boolean;
}

interface QueuedJob {
  key: string;
  /** The instant the job is done and its singleton key is free. */
  endAt: number;
}

/** One simulated organisation over five days. */
export function simulate(seed: number, options: SimulationOptions = {}): SimulationResult {
  const random = generator(seed);
  const busy = options.queue === 'busy';
  // The busy queue draws from its own generator, so a seed gives the same organisation, zones and ticks in both models.
  const busyRandom = generator(seed * 7919 + 17);
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

  // Ticks: hourly at minute 5 with jitter, single misses, an outage, second ticks in an hour; with the busy queue also
  // retried ticks and a long outage.
  const ticks: number[] = [];
  const outage = random() < 0.3 ? { from: between(start + 6 * HOUR, end - 30 * HOUR), hours: 2 + random() * 8 } : null;
  const longOutage = busy && busyRandom() < 0.15 ? { from: start + 6 * HOUR + busyRandom() * 36 * HOUR, hours: 24 + busyRandom() * 12 } : null;
  let retriedTicks = 0;
  for (let k = 0; k < 5 * 24; k++) {
    const slot = start + k * HOUR + 5 * MINUTE;
    if (outage && slot >= outage.from && slot < outage.from + outage.hours * HOUR) continue;
    if (random() < 0.08) continue;
    const kind = random();
    const jitter = kind < 0.2 ? -random() * 5 * MINUTE : kind < 0.5 ? random() * 40 * MINUTE : (random() - 0.5) * MINUTE;
    const second = random() < 0.08 ? slot + between(-5 * MINUTE, 55 * MINUTE) : null;
    if (longOutage && slot >= longOutage.from && slot < longOutage.from + longOutage.hours * HOUR) continue;
    ticks.push(slot + jitter);
    if (second !== null) ticks.push(second);
    if (busy && busyRandom() < 0.05) {
      ticks.push(slot + jitter + (1 + busyRandom() * 899) * 1000);
      retriedTicks++;
    }
  }
  ticks.sort((a, b) => a - b);

  // The clock may be set back one hour once.
  const setBackAt = random() < 0.35 ? between(start + 12 * HOUR, end - DAY) : null;
  const clock = (instant: number) => (setBackAt !== null && instant >= setBackAt ? instant - HOUR : instant);

  // The ledger holds the runs of the three days before the start (a system that has been running).
  const ledger = new Map<string, LedgerRun>();
  let rows: LedgerRun[] = [];
  // What the tick reads: the rows from three days before the UTC date of its clock (scheduler-tick.job.ts).
  let recent: LedgerRun[] = [];
  let recentFrom = '';
  const add = (row: LedgerRun) => {
    ledger.set(`${row.job}@${row.localDate}`, row);
    rows.push(row);
    if (row.localDate >= recentFrom) recent.push(row);
  };
  const remove = (row: LedgerRun) => {
    ledger.delete(`${row.job}@${row.localDate}`);
    rows = rows.filter((r) => r !== row);
    recent = recent.filter((r) => r !== row);
  };
  const firstDate = localDate(new Date(start), firstZone);
  for (let d = -3; d <= -1; d++) {
    const date = addDays(firstDate, d);
    for (const job of DAILY_JOBS) {
      if (job.weekday !== undefined && weekdayOfDate(date) !== job.weekday) continue;
      const scheduledFor = instantOfLocal(date, job.at, firstZone);
      add({ job: job.name, localDate: date, scheduledFor, enqueuedAt: scheduledFor });
    }
  }
  const firstLocalDate = addDays(firstDate, -3);

  // Jobs in the queue (waiting or working) until their end; a job is played through when it is sent, because its
  // start and end follow from the send.
  let queued: QueuedJob[] = [];
  const worked = new Map<string, number>();
  const mismatches: string[] = [];
  const required = new Set<string>();
  let runs = 0;
  let startDateDiffers = 0;
  let dropped = 0;
  let lateStarts = 0;

  const send = (run: PlannedRun, tick: number) => {
    let startAt = tick + run.startAfterSeconds * 1000;
    let endAt = startAt;
    if (busy) {
      startAt += busyRandom() * 2000;
      if (busyRandom() < 0.03) {
        startAt += busyRandom() * 70 * MINUTE;
        lateStarts++;
      }
      endAt = startAt + busyRandom() * 3 * MINUTE;
    }
    queued.push({ key: run.singletonKey, endAt });
    runs++;
    const dateAtStart = simLocalDate(clock(startAt), zoneAt(startAt));
    if (dateAtStart !== run.localDate) startDateDiffers++;
    const date = options.workOn === 'date-at-start' ? dateAtStart : run.localDate;
    if (date !== run.localDate) mismatches.push(`${run.job.name} of ${run.localDate} worked on ${date}`);
    const key = `${run.job.name}@${date}`;
    worked.set(key, (worked.get(key) ?? 0) + 1);
  };

  for (const tick of ticks) {
    queued = queued.filter((q) => q.endAt > tick);
    const now = new Date(clock(tick));
    const zone = zoneAt(tick);
    const from = addDays(now.toISOString().slice(0, 10), -3);
    if (from !== recentFrom) {
      recentFrom = from;
      recent = rows.filter((r) => r.localDate >= from);
    }
    const planned = planDailyRuns({ orgId: ORG, now, timeZone: zone, createdAt, ledger: recent, firstLocalDate, jobs: DAILY_JOBS });
    for (const run of planned) {
      const key = `${run.job.name}@${run.localDate}`;
      // The database keeps the first row (`on conflict do nothing`); the tick sends nothing for an existing row.
      if (ledger.has(key)) continue;
      const row: LedgerRun = { job: run.job.name, localDate: run.localDate, scheduledFor: run.scheduledFor, enqueuedAt: now };
      add(row);
      if (queued.some((q) => q.key === run.singletonKey)) {
        dropped++;
        // pg-boss reports the drop: the tick deletes the row of a key `<prefix>:<org>:all`, and a later tick plans the
        // run again. A row of a key with its date stays (the job holding the key would be this run).
        if (options.driver !== 'outbox' && run.job.allSystems) remove(row);
        else mismatches.push(`${key}: the send was dropped by a queued job with the key ${run.singletonKey}`);
        continue;
      }
      send(run, tick);
    }
    // The oracle counts the ticks that later ticks follow (the last half day only runs what is due).
    if (tick > end - 12 * HOUR) continue;
    const wall = simWallClock(now.getTime(), zone);
    const [today, time] = [wall.slice(0, 10), wall.slice(11, 16)];
    for (const date of [addDays(today, -1), today]) {
      if (date < firstDate) continue; // the runs before the start are in the ledger
      for (const job of DAILY_JOBS) {
        if (job.weekday !== undefined && weekdayOfDate(date) !== job.weekday) continue;
        if (date < today || job.at <= time) required.add(`${job.name}@${date}`);
      }
    }
  }
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
    dropped,
    lateStarts,
    retriedTicks,
    longOutage: longOutage !== null,
  };
}
