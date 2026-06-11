/**
 * POSIX cron schedule evaluation with IANA timezone support.
 *
 * Five fields: minute hour day-of-month month day-of-week.
 * Supports `*`, lists (`1,15`), ranges (`1-5`), and steps (`0-59/N`).
 * Matching is wall-clock in the given timezone (literal DST semantics:
 * times skipped by spring-forward never fire; times repeated by fall-back
 * fire twice). Day-of-month and day-of-week are OR-ed when both are
 * restricted, per POSIX.
 *
 * `nextFireTimes` walks forward minute-by-minute. Worst case (a yearly
 * schedule) is ~500k iterations against a cached Intl formatter — tens of
 * milliseconds, and only paid when (re)computing `next_run_at`.
 */

export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the field was `*` (needed for POSIX dom/dow OR semantics). */
  domWildcard: boolean;
  dowWildcard: boolean;
}

const FIELD_RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

function parseField(spec: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    let body = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      body = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`invalid step in cron ${name} field: "${part}"`);
      }
    }
    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = hi = Number(body);
      if (slash !== -1) hi = max; // "N/step" means "N-max/step"
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`invalid cron ${name} field: "${part}" (allowed ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const sets = fields.map((f, i) =>
    parseField(f, FIELD_RANGES[i].min, FIELD_RANGES[i].max, FIELD_RANGES[i].name),
  );
  const dow = sets[4];
  if (dow.has(7)) dow.add(0); // 7 == Sunday == 0
  return {
    minute: sets[0],
    hour: sets[1],
    dayOfMonth: sets[2],
    month: sets[3],
    dayOfWeek: dow,
    domWildcard: fields[2] === "*",
    dowWildcard: fields[4] === "*",
  };
}

/** Validate an IANA timezone identifier. Throws on unknown zones. */
export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`invalid IANA timezone: "${timezone}"`);
  }
}

interface WallClock {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function makeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "numeric",
    hour: "numeric",
    hourCycle: "h23",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  });
}

function wallClockAt(fmt: Intl.DateTimeFormat, epochMs: number): WallClock {
  const parts = fmt.formatToParts(epochMs);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    day: Number(get("day")),
    month: Number(get("month")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

function matches(s: CronSchedule, w: WallClock): boolean {
  if (!s.minute.has(w.minute)) return false;
  if (!s.hour.has(w.hour)) return false;
  if (!s.month.has(w.month)) return false;
  // POSIX: if both dom and dow are restricted, a time matches when EITHER
  // matches; if only one is restricted, that one must match.
  const domOk = s.dayOfMonth.has(w.day);
  const dowOk = s.dayOfWeek.has(w.weekday);
  if (!s.domWildcard && !s.dowWildcard) return domOk || dowOk;
  if (!s.domWildcard) return domOk;
  if (!s.dowWildcard) return dowOk;
  return true;
}

const MINUTE_MS = 60_000;
/** Search horizon: ~400 days covers any satisfiable yearly schedule. */
const MAX_SEARCH_MINUTES = 400 * 24 * 60;

/**
 * Compute the next `count` fire times (epoch ms, minute-aligned) strictly
 * after `afterMs`. Returns fewer than `count` only when the schedule has no
 * occurrence within the search horizon (e.g. Feb 30).
 */
export function nextFireTimes(
  schedule: CronSchedule,
  timezone: string,
  afterMs: number,
  count = 1,
): number[] {
  const fmt = makeFormatter(timezone);
  const out: number[] = [];
  let t = (Math.floor(afterMs / MINUTE_MS) + 1) * MINUTE_MS;
  for (let i = 0; i < MAX_SEARCH_MINUTES && out.length < count; i++, t += MINUTE_MS) {
    if (matches(schedule, wallClockAt(fmt, t))) out.push(t);
  }
  return out;
}
