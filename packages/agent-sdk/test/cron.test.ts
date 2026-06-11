/**
 * Unit tests for the POSIX cron parser and timezone-aware fire-time
 * computation (util/cron.ts).
 */
import { describe, it, expect } from "vitest";
import { parseCronExpression, nextFireTimes, assertValidTimezone } from "../src/util/cron";

const utc = (s: string) => new Date(s).getTime();

describe("parseCronExpression", () => {
  it("parses a simple expression", () => {
    const s = parseCronExpression("0 20 * * 5");
    expect([...s.minute]).toEqual([0]);
    expect([...s.hour]).toEqual([20]);
    expect(s.dayOfMonth.size).toBe(31);
    expect(s.month.size).toBe(12);
    expect([...s.dayOfWeek]).toEqual([5]);
  });

  it("parses lists, ranges, and steps", () => {
    const s = parseCronExpression("0,30 9-17 * * 1-5");
    expect([...s.minute]).toEqual([0, 30]);
    expect([...s.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...s.dayOfWeek]).toEqual([1, 2, 3, 4, 5]);

    const steps = parseCronExpression("*/15 */6 * * *");
    expect([...steps.minute]).toEqual([0, 15, 30, 45]);
    expect([...steps.hour]).toEqual([0, 6, 12, 18]);
  });

  it("treats day-of-week 7 as Sunday", () => {
    const s = parseCronExpression("0 0 * * 7");
    expect(s.dayOfWeek.has(0)).toBe(true);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCronExpression("0 20 * *")).toThrow(/5 fields/);
    expect(() => parseCronExpression("60 * * * *")).toThrow(/minute/);
    expect(() => parseCronExpression("* 24 * * *")).toThrow(/hour/);
    expect(() => parseCronExpression("* * 0 * *")).toThrow(/day-of-month/);
    expect(() => parseCronExpression("* * * 13 *")).toThrow(/month/);
    expect(() => parseCronExpression("* * * * 8")).toThrow(/day-of-week/);
    expect(() => parseCronExpression("*/0 * * * *")).toThrow(/step/);
    expect(() => parseCronExpression("a b c d e")).toThrow();
  });
});

describe("assertValidTimezone", () => {
  it("accepts IANA zones and rejects junk", () => {
    expect(() => assertValidTimezone("America/New_York")).not.toThrow();
    expect(() => assertValidTimezone("UTC")).not.toThrow();
    expect(() => assertValidTimezone("Mars/Olympus_Mons")).toThrow(/invalid IANA timezone/);
  });
});

describe("nextFireTimes", () => {
  it("computes the next minute boundary in UTC", () => {
    const s = parseCronExpression("*/5 * * * *");
    const [next] = nextFireTimes(s, "UTC", utc("2026-06-10T12:02:30Z"));
    expect(next).toBe(utc("2026-06-10T12:05:00Z"));
  });

  it("is strictly after the reference time", () => {
    const s = parseCronExpression("0 12 * * *");
    const [next] = nextFireTimes(s, "UTC", utc("2026-06-10T12:00:00Z"));
    expect(next).toBe(utc("2026-06-11T12:00:00Z"));
  });

  it("returns multiple upcoming occurrences", () => {
    const s = parseCronExpression("0 20 * * 5"); // Fridays 8pm
    const times = nextFireTimes(s, "America/New_York", utc("2026-05-04T00:00:00Z"), 3);
    // 2026-05-08, -15, -22 are Fridays; 8pm EDT == 00:00Z next day
    expect(times.map((t) => new Date(t).toISOString())).toEqual([
      "2026-05-09T00:00:00.000Z",
      "2026-05-16T00:00:00.000Z",
      "2026-05-23T00:00:00.000Z",
    ]);
  });

  it("matches wall-clock time across DST (8pm local in both EST and EDT)", () => {
    const s = parseCronExpression("0 20 * * *");
    // Winter (EST, UTC-5): 8pm local on Jan 10 == 01:00Z Jan 11
    const [winter] = nextFireTimes(s, "America/New_York", utc("2026-01-10T02:00:00Z"));
    expect(new Date(winter).toISOString()).toBe("2026-01-11T01:00:00.000Z");
    // Summer (EDT, UTC-4): 8pm local == 00:00Z next day
    const [summer] = nextFireTimes(s, "America/New_York", utc("2026-06-10T01:00:00Z"));
    expect(new Date(summer).toISOString()).toBe("2026-06-11T00:00:00.000Z");
  });

  it("skips wall-clock times that do not exist on spring-forward day", () => {
    // US DST 2026: clocks jump 2:00 -> 3:00 on March 8.
    const s = parseCronExpression("30 2 * * *");
    const [next] = nextFireTimes(s, "America/New_York", utc("2026-03-08T00:00:00Z"));
    // 2:30am does not exist on Mar 8; next occurrence is Mar 9, 2:30 EDT (06:30Z)
    expect(new Date(next).toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });

  it("fires twice for wall-clock times repeated on fall-back day", () => {
    // US DST 2026: clocks fall back 2:00 -> 1:00 on November 1.
    const s = parseCronExpression("30 1 * * *");
    const times = nextFireTimes(s, "America/New_York", utc("2026-11-01T00:00:00Z"), 2);
    // 1:30 EDT == 05:30Z, then 1:30 EST == 06:30Z — same wall clock, twice.
    expect(times.map((t) => new Date(t).toISOString())).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
  });

  it("applies POSIX dom/dow OR semantics when both are restricted", () => {
    // Fires on the 15th OR on Mondays.
    const s = parseCronExpression("0 0 15 * 1");
    const times = nextFireTimes(s, "UTC", utc("2026-06-10T00:00:00Z"), 3);
    // June 15 2026 is a Monday (both match once); next Mondays are 22, 29.
    expect(times.map((t) => new Date(t).toISOString())).toEqual([
      "2026-06-15T00:00:00.000Z",
      "2026-06-22T00:00:00.000Z",
      "2026-06-29T00:00:00.000Z",
    ]);
  });

  it("returns empty for unsatisfiable schedules", () => {
    const s = parseCronExpression("0 0 30 2 *"); // Feb 30
    expect(nextFireTimes(s, "UTC", utc("2026-01-01T00:00:00Z"))).toEqual([]);
  });
});
