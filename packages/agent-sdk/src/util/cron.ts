/**
 * Minimal 5-field cron matcher (minute hour day-of-month month day-of-week)
 * with IANA-timezone wall-clock semantics.
 *
 * Supported field syntax: `*`, lists (`1,15`), ranges (`1-5`), steps
 * (`*\/15`, `10-50/10`). Day-of-week: 0–7 where 0 and 7 are Sunday.
 * Matching is literal wall-clock in the given timezone — nonexistent
 * spring-forward times are skipped, repeated fall-back times match twice
 * (standard cron behavior; schedule outside 1–3AM local or in UTC when
 * that matters).
 */

export interface CronParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number; // 1-12
  dayOfWeek: number; // 0-6, Sunday = 0
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (7 = Sunday alias)
];

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) return null;

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      lo = a;
      hi = b;
    } else {
      const v = Number(rangePart);
      if (!Number.isInteger(v)) return null;
      lo = v;
      hi = stepPart !== undefined ? max : v;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when day-of-month was `*` (affects dom/dow OR semantics). */
  domWildcard: boolean;
  dowWildcard: boolean;
}

/** Parse a cron expression; returns null when invalid. */
export function parseCron(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(fields[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1]);
    if (!s) return null;
    sets.push(s);
  }
  // Normalize day-of-week 7 → 0.
  const dow = new Set<number>([...sets[4]].map((v) => (v === 7 ? 0 : v)));
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

/** Does the parsed cron match the given wall-clock parts? */
export function cronMatches(cron: ParsedCron, parts: CronParts): boolean {
  if (!cron.minute.has(parts.minute)) return false;
  if (!cron.hour.has(parts.hour)) return false;
  if (!cron.month.has(parts.month)) return false;
  // Standard cron: when both dom and dow are restricted, either may match.
  const domOk = cron.dayOfMonth.has(parts.dayOfMonth);
  const dowOk = cron.dayOfWeek.has(parts.dayOfWeek);
  if (cron.domWildcard && cron.dowWildcard) return true;
  if (cron.domWildcard) return dowOk;
  if (cron.dowWildcard) return domOk;
  return domOk || dowOk;
}

const DOW_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Intl.DateTimeFormat construction is ~1ms; format calls are microseconds.
// nextRuns scans many thousands of minutes — cache one formatter per zone.
const partsFmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFmt(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    partsFmtCache.set(timeZone, fmt);
  }
  return fmt;
}

function zonedPartsFull(epochMs: number, timeZone: string): CronParts & { year: string } {
  const parts: Record<string, string> = {};
  for (const p of partsFmt(timeZone).formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24, // Intl can emit "24" for midnight
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: DOW_INDEX[parts.weekday] ?? 0,
    year: parts.year,
  };
}

/** Wall-clock parts of an instant in an IANA timezone. */
export function zonedParts(epochMs: number, timeZone: string): CronParts {
  return zonedPartsFull(epochMs, timeZone);
}

/** Dedupe key for "this wall-clock minute in this timezone". */
export function zonedMinuteKey(epochMs: number, timeZone: string): string {
  const p = zonedPartsFull(epochMs, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.dayOfMonth)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Next N matching fire times (epoch ms, minute resolution), scanning up to `horizonDays`. */
export function nextRuns(
  cron: ParsedCron,
  timeZone: string,
  fromMs: number,
  count = 3,
  horizonDays = 370,
): number[] {
  const out: number[] = [];
  const start = Math.ceil(fromMs / 60_000) * 60_000 + 60_000; // next whole minute
  const end = fromMs + horizonDays * 86_400_000;
  for (let t = start; t <= end && out.length < count; ) {
    const p = zonedParts(t, timeZone);
    if (cronMatches(cron, p)) {
      out.push(t);
      t += 60_000;
      continue;
    }
    if (!cron.minute.has(p.minute)) {
      // Jump to the next candidate minute (tz offsets are whole minutes,
      // so minute-of-hour advances 1:1 with epoch minutes).
      const deltas = [...cron.minute].map((m) => (m - p.minute + 60) % 60).filter((d) => d > 0);
      t += (deltas.length ? Math.min(...deltas) : 60 - p.minute) * 60_000;
      continue;
    }
    // Minute matches but hour/day/month didn't — skip a whole hour.
    t += 3_600_000;
  }
  return out;
}
