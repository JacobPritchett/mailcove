// Snooze times: the presets offered, how a time is shown, and reading the
// custom date field. Pure, with `now` passed in, and written against the
// LOCAL calendar throughout: "tomorrow at 8" means 8 on the user's clock,
// whatever daylight saving does to the hours in between.

/** The hour (local) the day-based presets wake at. */
const MORNING_HOUR = 8;
/** "Later today" is this far ahead... */
const LATER_HOURS = 3;
/** ...and stops being offered at this hour: 9 pm plus three hours is tomorrow. */
const LATER_CUTOFF_HOUR = 21;
/** The Worker refuses a snooze further out than a year (src/store_mutations.ts). */
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export type SnoozePresetId = "later-today" | "tomorrow" | "this-weekend" | "next-week";

export interface SnoozePreset {
  id: SnoozePresetId;
  label: string;
  /** When the thread comes back, epoch ms. */
  at: number;
  /** The resolved day and time, shown beside the label: "Sat 8:00 am". */
  when: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Morning of the day `days` after `now`. The Date constructor does the
 * calendar work in local time, so day 32 of a month rolls into the next one
 * (and December into January), and a day that is 23 or 25 hours long because
 * the clocks changed still yields 8:00 on the clock.
 */
function morningAfter(now: Date, days: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, MORNING_HOUR, 0, 0, 0).getTime();
}

/** The presets to offer at `now`, soonest first. */
export function snoozePresets(now: Date): SnoozePreset[] {
  const out: { id: SnoozePresetId; label: string; at: number }[] = [];
  if (now.getHours() < LATER_CUTOFF_HOUR) {
    // Elapsed time, not clock arithmetic: "in three hours" is three hours.
    const later = new Date(now.getTime() + LATER_HOURS * 60 * 60 * 1000);
    later.setSeconds(0, 0);
    out.push({ id: "later-today", label: "Later today", at: later.getTime() });
  }
  out.push({ id: "tomorrow", label: "Tomorrow", at: morningAfter(now, 1) });
  const day = now.getDay(); // 0 Sunday .. 6 Saturday
  // On the weekend itself "this weekend" has nothing left to point at.
  if (day !== 6 && day !== 0) {
    out.push({ id: "this-weekend", label: "This weekend", at: morningAfter(now, 6 - day) });
  }
  // The coming Monday; on a Monday that is a week away, not today.
  out.push({ id: "next-week", label: "Next week", at: morningAfter(now, ((8 - day) % 7) || 7) });
  const nowMs = now.getTime();
  return out.map((p) => ({ ...p, when: formatSnoozeTime(p.at, nowMs) }));
}

function clockTime(d: Date): string {
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/**
 * A snooze time as the user thinks of it: just the time when it is today
 * ("5:30 pm"), the weekday inside the coming week ("Tue 8:00 am"), and the
 * date beyond that ("Oct 14, 8:00 am", with the year when it differs).
 */
export function formatSnoozeTime(ms: number, now: number): string {
  const d = new Date(ms);
  const ref = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  // Rounded: across a clock change two local midnights are 23 or 25 hours apart.
  const days = Math.round((startOf(d) - startOf(ref)) / 86_400_000);
  const time = clockTime(d);
  if (days === 0) return time;
  if (days > 0 && days < 7) return `${WEEKDAYS[d.getDay()]} ${time}`;
  const year = d.getFullYear() === ref.getFullYear() ? "" : `, ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}, ${time}`;
}

/** A local time in the `datetime-local` input's own format: "2026-10-03T08:00". */
export function toDateTimeInputValue(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The earliest and latest times the custom field accepts, in its own format. */
export function snoozeInputBounds(now: number): { min: string; max: string } {
  return { min: toDateTimeInputValue(now + 60_000), max: toDateTimeInputValue(now + MAX_AHEAD_MS) };
}

/**
 * Read the custom `datetime-local` field. The value has no zone and means the
 * user's local time. Returns the instant, or what is wrong with it in words.
 */
export function parseSnoozeInput(value: string, now: number): { at: number } | { error: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return { error: "Pick a date and time." };
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const at = new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  if (!Number.isFinite(at)) return { error: "Pick a date and time." };
  if (at <= now) return { error: "Pick a time in the future." };
  if (at > now + MAX_AHEAD_MS) return { error: "Pick a time within the next year." };
  return { at };
}
