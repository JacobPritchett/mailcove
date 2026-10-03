// Snooze arithmetic. Pinned to a zone with daylight saving so the boundary
// cases are real: the worker process reads TZ when a Date is first formatted.
// (The app's tsconfig has no Node types, hence the cast.)
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const ORIGINAL_TZ = env.TZ;
env.TZ = "America/New_York";

import { afterAll, describe, it, expect } from "vitest";
import { formatSnoozeTime, parseSnoozeInput, snoozeInputBounds, snoozePresets, toDateTimeInputValue } from "@/lib/snooze";

/** A local wall-clock time in the pinned zone. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const byId = (now: Date) => Object.fromEntries(snoozePresets(now).map((p) => [p.id, p]));
const HOUR = 3_600_000;

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete env.TZ;
  else env.TZ = ORIGINAL_TZ;
});

describe("the test zone", () => {
  it("is New York, with daylight saving", () => {
    // Otherwise every boundary case below would pass without testing anything.
    expect(local(2026, 1, 15, 12).getTimezoneOffset()).toBe(300);
    expect(local(2026, 7, 15, 12).getTimezoneOffset()).toBe(240);
  });
});

describe("snoozePresets on an ordinary weekday", () => {
  // Wednesday 14 October 2026, 10:15 in the morning.
  const now = local(2026, 10, 14, 10, 15);

  it("offers all four, soonest first", () => {
    expect(snoozePresets(now).map((p) => p.label)).toEqual(["Later today", "Tomorrow", "This weekend", "Next week"]);
  });

  it("Later today is three hours on", () => {
    expect(byId(now)["later-today"].at).toBe(local(2026, 10, 14, 13, 15).getTime());
    expect(byId(now)["later-today"].when).toBe("1:15 pm");
  });

  it("Tomorrow is 8:00 the next morning", () => {
    expect(byId(now).tomorrow.at).toBe(local(2026, 10, 15, 8).getTime());
    expect(byId(now).tomorrow.when).toBe("Thu 8:00 am");
  });

  it("This weekend is Saturday 8:00", () => {
    expect(byId(now)["this-weekend"].at).toBe(local(2026, 10, 17, 8).getTime());
    expect(byId(now)["this-weekend"].when).toBe("Sat 8:00 am");
  });

  it("Next week is the coming Monday 8:00", () => {
    expect(byId(now)["next-week"].at).toBe(local(2026, 10, 19, 8).getTime());
    expect(byId(now)["next-week"].when).toBe("Mon 8:00 am");
  });

  it("drops the seconds from Later today", () => {
    const at = snoozePresets(new Date(now.getTime() + 42_500))[0].at;
    expect(at % 60_000).toBe(0);
  });
});

describe("which presets are offered", () => {
  it("hides Later today from 9 pm", () => {
    expect(byId(local(2026, 10, 14, 20, 59))["later-today"]).toBeDefined();
    expect(byId(local(2026, 10, 14, 21, 0))["later-today"]).toBeUndefined();
    expect(byId(local(2026, 10, 14, 23, 30))["later-today"]).toBeUndefined();
  });

  it("hides This weekend on Saturday and Sunday", () => {
    expect(byId(local(2026, 10, 16, 12))["this-weekend"]).toBeDefined(); // Friday
    expect(byId(local(2026, 10, 17, 12))["this-weekend"]).toBeUndefined(); // Saturday
    expect(byId(local(2026, 10, 18, 12))["this-weekend"]).toBeUndefined(); // Sunday
  });

  it("on a Friday, Tomorrow and This weekend are the same Saturday morning", () => {
    const p = byId(local(2026, 10, 16, 12));
    expect(p["this-weekend"].at).toBe(p.tomorrow.at);
  });

  it("Next week from a Monday is the Monday after, and from a Sunday is tomorrow", () => {
    expect(byId(local(2026, 10, 19, 7))["next-week"].at).toBe(local(2026, 10, 26, 8).getTime());
    expect(byId(local(2026, 10, 18, 22))["next-week"].at).toBe(local(2026, 10, 19, 8).getTime());
    expect(byId(local(2026, 10, 17, 9))["next-week"].at).toBe(local(2026, 10, 19, 8).getTime()); // Saturday
  });

  it("every preset is in the future, at any hour of any day of a week", () => {
    for (let h = 0; h < 7 * 24; h++) {
      const now = new Date(local(2026, 10, 12).getTime() + h * HOUR + 59 * 60_000);
      for (const p of snoozePresets(now)) expect(p.at).toBeGreaterThan(now.getTime());
    }
  });
});

describe("month and year rollover", () => {
  it("Tomorrow from the last day of a month is the 1st", () => {
    expect(byId(local(2026, 9, 30, 15)).tomorrow.at).toBe(local(2026, 10, 1, 8).getTime());
  });

  it("Tomorrow from 31 December is 1 January", () => {
    const p = byId(local(2026, 12, 31, 15)); // a Thursday
    expect(p.tomorrow.at).toBe(local(2027, 1, 1, 8).getTime());
    expect(p["this-weekend"].at).toBe(local(2027, 1, 2, 8).getTime());
    expect(p["next-week"].at).toBe(local(2027, 1, 4, 8).getTime());
  });

  it("Tomorrow from 28 February in a leap year is the 29th", () => {
    expect(byId(local(2028, 2, 28, 15)).tomorrow.at).toBe(local(2028, 2, 29, 8).getTime());
    expect(byId(local(2027, 2, 28, 15)).tomorrow.at).toBe(local(2027, 3, 1, 8).getTime());
  });

  it("Later today late in the evening before the cutoff can cross midnight only by the clock", () => {
    const p = byId(local(2026, 12, 31, 20, 59));
    expect(p["later-today"].at).toBe(local(2026, 12, 31, 23, 59).getTime());
  });
});

describe("daylight saving", () => {
  // US clocks: forward on Sunday 8 March 2026 (2:00 -> 3:00), back on Sunday
  // 1 November 2026 (2:00 -> 1:00).
  it("Tomorrow across spring forward is 8:00 on the clock, 23 hours of day later", () => {
    const now = local(2026, 3, 7, 8); // Saturday 8:00 EST
    const at = byId(now).tomorrow.at;
    expect(at).toBe(Date.UTC(2026, 2, 8, 12, 0)); // 8:00 EDT
    expect(at - now.getTime()).toBe(23 * HOUR);
    expect(new Date(at).getHours()).toBe(8);
  });

  it("Tomorrow across fall back is 8:00 on the clock, 25 hours later", () => {
    const now = local(2026, 10, 31, 8); // Saturday 8:00 EDT
    const at = byId(now).tomorrow.at;
    expect(at).toBe(Date.UTC(2026, 10, 1, 13, 0)); // 8:00 EST
    expect(at - now.getTime()).toBe(25 * HOUR);
  });

  it("Next week and This weekend land on 8:00 across the change", () => {
    const now = local(2026, 3, 4, 10); // Wednesday before spring forward
    expect(new Date(byId(now)["this-weekend"].at).getHours()).toBe(8);
    expect(byId(now)["next-week"].at).toBe(Date.UTC(2026, 2, 9, 12, 0)); // Monday 8:00 EDT
  });

  it("Later today is three elapsed hours through the skipped hour", () => {
    const now = local(2026, 3, 8, 0, 30); // 12:30 am EST, clocks jump at 2:00
    const at = byId(now)["later-today"].at;
    expect(at - now.getTime()).toBe(3 * HOUR);
    expect(byId(now)["later-today"].when).toBe("4:30 am");
  });

  it("Later today is three elapsed hours through the repeated hour", () => {
    const now = local(2026, 11, 1, 0, 30); // 12:30 am EDT, 1:00 happens twice
    const at = byId(now)["later-today"].at;
    expect(at - now.getTime()).toBe(3 * HOUR);
    expect(byId(now)["later-today"].when).toBe("2:30 am");
  });

  it("names the right weekday across a 23-hour day", () => {
    const now = local(2026, 3, 7, 23, 30).getTime();
    expect(formatSnoozeTime(local(2026, 3, 8, 8).getTime(), now)).toBe("Sun 8:00 am");
    expect(formatSnoozeTime(local(2026, 3, 9, 8).getTime(), now)).toBe("Mon 8:00 am");
  });
});

describe("formatSnoozeTime", () => {
  const now = local(2026, 10, 14, 10, 15).getTime();

  it("is just the time today", () => {
    expect(formatSnoozeTime(local(2026, 10, 14, 17, 5).getTime(), now)).toBe("5:05 pm");
    expect(formatSnoozeTime(local(2026, 10, 14, 12, 0).getTime(), now)).toBe("12:00 pm");
  });

  it("names the weekday within the coming week", () => {
    expect(formatSnoozeTime(local(2026, 10, 15, 0, 0).getTime(), now)).toBe("Thu 12:00 am");
    expect(formatSnoozeTime(local(2026, 10, 20, 8).getTime(), now)).toBe("Tue 8:00 am");
  });

  it("gives the date from a week out, since the weekday alone would be ambiguous", () => {
    expect(formatSnoozeTime(local(2026, 10, 21, 8).getTime(), now)).toBe("Oct 21, 8:00 am");
  });

  it("adds the year when it differs", () => {
    expect(formatSnoozeTime(local(2027, 1, 4, 8).getTime(), now)).toBe("Jan 4, 2027, 8:00 am");
  });
});

describe("the custom date field", () => {
  const now = local(2026, 10, 14, 10, 15).getTime();

  it("reads the value as local time", () => {
    expect(parseSnoozeInput("2026-10-20T09:30", now)).toEqual({ at: local(2026, 10, 20, 9, 30).getTime() });
  });

  it("round-trips through the input format", () => {
    const at = local(2026, 12, 5, 7, 5).getTime();
    expect(toDateTimeInputValue(at)).toBe("2026-12-05T07:05");
    expect(parseSnoozeInput(toDateTimeInputValue(at), now)).toEqual({ at });
  });

  it("refuses the past and the present", () => {
    expect(parseSnoozeInput("2026-10-14T10:15", now)).toEqual({ error: "Pick a time in the future." });
    expect(parseSnoozeInput("2026-10-13T09:00", now)).toEqual({ error: "Pick a time in the future." });
  });

  it("refuses more than a year out, which the Worker would reject", () => {
    expect(parseSnoozeInput("2027-10-15T10:15", now)).toEqual({ error: "Pick a time within the next year." });
    expect("at" in parseSnoozeInput("2027-10-14T10:00", now)).toBe(true);
  });

  it("refuses an empty or malformed value", () => {
    expect(parseSnoozeInput("", now)).toEqual({ error: "Pick a date and time." });
    expect(parseSnoozeInput("tomorrow", now)).toEqual({ error: "Pick a date and time." });
  });

  it("bounds the field from a minute ahead to a year ahead", () => {
    expect(snoozeInputBounds(now)).toEqual({ min: "2026-10-14T10:16", max: "2027-10-14T10:15" });
  });
});
