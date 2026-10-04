// A small iCalendar (RFC 5545) reader for the invite card shown on a message
// with a .ics attachment. It pulls out the handful of fields the card needs
// from the first event and nothing else.
//
// The input is whatever a stranger chose to send, so the rules are: never
// throw, do a bounded amount of work, and only ever return plain strings and
// numbers. Nothing here builds markup. React escapes the strings on the way
// out, which is what keeps a SUMMARY full of tags inert.

export interface IcsEvent {
  /** SUMMARY, unescaped, at most 300 characters. "" when absent. */
  title: string;
  /** LOCATION, unescaped, at most 300 characters. "" when absent. */
  location: string;
  /** From ORGANIZER;CN=...:mailto:addr. Either part may be "". */
  organizer: { name: string; email: string } | null;
  /** METHOD of the calendar, upper-cased ("REQUEST", "CANCEL", "REPLY", ...), "" when absent. */
  method: string;
  /** STATUS:CANCELLED on the event, or METHOD:CANCEL. */
  cancelled: boolean;
  /** DTSTART is a date with no time. */
  allDay: boolean;
  /** Epoch ms. For all-day events: local midnight (the viewer's zone) of the first day. null when missing or unparseable. */
  start: number | null;
  /** Epoch ms. For all-day events: local midnight of the last day. For timed events null when absent. */
  end: number | null;
  /** The time had no zone (no Z, no usable TZID) and was read in the viewer's local zone. */
  floating: boolean;
  /** Has an RRULE. The card says "Repeats"; nothing is expanded. */
  recurring: boolean;
}

/** Largest .ics the client will fetch and parse. */
export const ICS_MAX_BYTES = 262_144;

// A real invite is a few dozen lines. The cap is far above that and exists so
// a file made of nothing but line breaks still costs a fixed amount.
const MAX_LINES = 5000;
const MAX_TEXT = 300;
const MAX_NAME = 200;
const MAX_EMAIL = 254;
// Parameters beyond this many on one line are parsed past but not kept.
const MAX_PARAMS = 32;
const DAY_MS = 86_400_000;
// The widest range a Date can hold. Anything outside it is not a time.
const MAX_DATE_MS = 8.64e15;

// C0 and C1 controls, DEL, and the bidi embedding, override and isolate
// characters. The bidi ones can reorder how a name or title reads on screen
// (the "gnp.exe" trick), so they go too.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const UNSAFE_CHAR = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

// The zone names Outlook and Exchange write instead of IANA ones. Keys are
// lower case because senders vary the capitals.
const WINDOWS_ZONES: Record<string, string> = {
  "utc": "UTC",
  "coordinated universal time": "UTC",
  "greenwich standard time": "Atlantic/Reykjavik",
  "gmt standard time": "Europe/London",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "central european standard time": "Europe/Warsaw",
  "romance standard time": "Europe/Paris",
  "e. europe standard time": "Europe/Chisinau",
  "fle standard time": "Europe/Kyiv",
  "gtb standard time": "Europe/Bucharest",
  "israel standard time": "Asia/Jerusalem",
  "south africa standard time": "Africa/Johannesburg",
  "russian standard time": "Europe/Moscow",
  "turkey standard time": "Europe/Istanbul",
  "arabian standard time": "Asia/Dubai",
  "arab standard time": "Asia/Riyadh",
  "india standard time": "Asia/Kolkata",
  "china standard time": "Asia/Shanghai",
  "singapore standard time": "Asia/Singapore",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "aus eastern standard time": "Australia/Sydney",
  "e. australia standard time": "Australia/Brisbane",
  "cen. australia standard time": "Australia/Adelaide",
  "w. australia standard time": "Australia/Perth",
  "new zealand standard time": "Pacific/Auckland",
  "hawaiian standard time": "Pacific/Honolulu",
  "alaskan standard time": "America/Anchorage",
  "pacific standard time": "America/Los_Angeles",
  "us mountain standard time": "America/Phoenix",
  "mountain standard time": "America/Denver",
  "central standard time": "America/Chicago",
  "canada central standard time": "America/Regina",
  "eastern standard time": "America/New_York",
  "us eastern standard time": "America/Indiana/Indianapolis",
  "atlantic standard time": "America/Halifax",
  "newfoundland standard time": "America/St_Johns",
  "e. south america standard time": "America/Sao_Paulo",
  "argentina standard time": "America/Argentina/Buenos_Aires",
  "central standard time (mexico)": "America/Mexico_City",
};

interface Property {
  /** Upper-cased, group prefix removed. */
  name: string;
  /** Upper-cased parameter names. A Map, so a name like __proto__ is only a key. */
  params: Map<string, string>;
  value: string;
}

/**
 * Hands out unfolded content lines one at a time, so the caller can stop at
 * the end of the first event without the rest of the text being touched.
 */
function lineReader(text: string): () => string | null {
  const n = text.length;
  let pos = 0;

  // One physical line, with the position left after its line end. CRLF, LF and
  // a lone CR all end a line.
  const physical = (): string => {
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13) break;
      i++;
    }
    const line = text.slice(pos, i);
    if (i < n) i += text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    pos = i;
    return line;
  };

  return () => {
    if (pos >= n) return null;
    let line = physical();
    // A line that starts with a space or tab continues the one before it. Only
    // that first character is dropped: the rest is content.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c !== 32 && c !== 9) break;
      pos++;
      line += physical();
    }
    return line;
  };
}

/** Splits `NAME;PARAM=value;PARAM="quoted:value":VALUE`. null when the line is not shaped like that. */
function parseProperty(line: string): Property | null {
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 59 || c === 58) break; // ; or :
    i++;
  }
  if (i >= n) return null;

  let name = line.slice(0, i);
  // "a.SUMMARY" is SUMMARY in group "a". Groups mean nothing to the card.
  const dot = name.lastIndexOf(".");
  if (dot >= 0) name = name.slice(dot + 1);
  if (name.length === 0 || name.length > 64 || !/^[A-Za-z0-9-]+$/.test(name)) return null;

  const params = new Map<string, string>();
  while (i < n && line.charCodeAt(i) === 59) {
    i++;
    let j = i;
    while (j < n) {
      const c = line.charCodeAt(j);
      if (c === 61 || c === 59 || c === 58) break; // = ; :
      j++;
    }
    const paramName = line.slice(i, j).toUpperCase();
    i = j;
    let paramValue = "";
    if (i < n && line.charCodeAt(i) === 61) {
      i++;
      // A value is one or more comma separated parts, each either quoted or
      // bare. Inside quotes a colon or semicolon is just a character.
      for (;;) {
        if (line.charCodeAt(i) === 34) {
          const close = line.indexOf('"', i + 1);
          if (close < 0) return null;
          paramValue += line.slice(i + 1, close);
          i = close + 1;
        } else {
          j = i;
          while (j < n) {
            const c = line.charCodeAt(j);
            if (c === 59 || c === 58 || c === 44) break; // ; : ,
            j++;
          }
          paramValue += line.slice(i, j);
          i = j;
        }
        if (i < n && line.charCodeAt(i) === 44) {
          paramValue += ",";
          i++;
          continue;
        }
        break;
      }
    }
    // The first of a repeated parameter wins, so a later one cannot override it.
    if (paramName && params.size < MAX_PARAMS && !params.has(paramName)) params.set(paramName, paramValue);
  }
  if (i >= n || line.charCodeAt(i) !== 58) return null;
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** Text safe to put on one line of the card: no line breaks, controls or bidi overrides, and not too long. */
function cleanText(raw: string, max: number): string {
  let s = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(UNSAFE_CHARS, "")
    .trim();
  if (s.length > max) {
    s = s.slice(0, max);
    // Do not leave half of a surrogate pair at the cut.
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  }
  return s;
}

/** Undoes RFC 5545 TEXT escaping in one pass, so "\\n" stays a backslash and an n. */
function unescapeText(raw: string): string {
  return raw.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

interface WallTime {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  dateOnly: boolean;
  utc: boolean;
}

/** Reads `YYYYMMDD` or `YYYYMMDDTHHMMSS[Z]`. null for anything else, including dates that do not exist. */
function parseWallTime(value: string): WallTime | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dateOnly = m[4] === undefined;
  const h = dateOnly ? 0 : Number(m[4]);
  const mi = dateOnly ? 0 : Number(m[5]);
  let s = dateOnly ? 0 : Number(m[6]);
  // Date treats years below 100 as 19xx, and nobody is invited to year 300.
  if (y < 1000) return null;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 60) return null;
  // Day 0 of the next month is the last day of this one.
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  // A leap second is valid iCalendar but Date would roll it into the next minute.
  if (s === 60) s = 59;
  return { y, mo, d, h, mi, s, dateOnly, utc: !dateOnly && m[7] !== "" };
}

/** A formatter for the zone, or null when the runtime does not know it. */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    return null;
  }
}

/** Maps a TZID to something Intl can use: an IANA name as is, or a Windows name translated. */
function resolveZone(tzid: string | undefined): Intl.DateTimeFormat | null {
  if (!tzid) return null;
  const id = tzid.trim();
  // No real zone name is anywhere near this long.
  if (id.length === 0 || id.length > 100) return null;
  const windows = Object.prototype.hasOwnProperty.call(WINDOWS_ZONES, id.toLowerCase()) ? WINDOWS_ZONES[id.toLowerCase()] : undefined;
  return zoneFormatter(windows ?? id);
}

/** How far the zone's wall clock is ahead of UTC at that instant, in ms. */
function zoneOffset(fmt: Intl.DateTimeFormat, at: number): number {
  const got: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(at))) {
    if (part.type !== "literal") got[part.type] = Number(part.value);
  }
  // Some engines write midnight as hour 24 even when asked for h23.
  const hour = got.hour === 24 ? 0 : got.hour;
  return Date.UTC(got.year, got.month - 1, got.day, hour, got.minute, got.second) - at;
}

/** The instant at which the zone's wall clock shows the given time. */
function wallTimeInZone(fmt: Intl.DateTimeFormat, w: WallTime): number {
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  // The offset depends on the instant, which is what we are looking for. Guess
  // with the offset at the wall time read as UTC, then correct with the offset
  // at that guess. The second pass is what settles a time near a daylight
  // saving change, where the first guess lands on the wrong side of it.
  const guess = asUtc - zoneOffset(fmt, asUtc);
  return asUtc - zoneOffset(fmt, guess);
}

interface ParsedTime {
  ms: number;
  allDay: boolean;
  floating: boolean;
}

function parseTime(prop: Property | undefined): ParsedTime | null {
  if (!prop) return null;
  const w = parseWallTime(prop.value);
  if (!w) return null;
  let parsed: ParsedTime;
  if (w.dateOnly || (prop.params.get("VALUE") ?? "").trim().toUpperCase() === "DATE") {
    // A date belongs to no zone: 5 January is 5 January wherever the viewer is.
    parsed = { ms: new Date(w.y, w.mo - 1, w.d).getTime(), allDay: true, floating: false };
  } else if (w.utc) {
    parsed = { ms: Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s), allDay: false, floating: false };
  } else {
    const zone = resolveZone(prop.params.get("TZID"));
    parsed = zone
      ? { ms: wallTimeInZone(zone, w), allDay: false, floating: false }
      : { ms: new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime(), allDay: false, floating: true };
  }
  return Number.isFinite(parsed.ms) ? parsed : null;
}

/** `PT1H30M`, `P1D`, `P1W` and so on, in ms. null when negative, empty or malformed. */
function parseDuration(value: string): number | null {
  const m = /^\+?P(?:(\d{1,6})W)?(?:(\d{1,6})D)?(?:T(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,6})S)?)?$/i.exec(value.trim());
  if (!m) return null;
  const [weeks, days, hours, minutes, seconds] = [m[1], m[2], m[3], m[4], m[5]];
  // "P" and "PT" match the pattern but say nothing.
  if ([weeks, days, hours, minutes, seconds].every((part) => part === undefined)) return null;
  const num = (part: string | undefined) => (part === undefined ? 0 : Number(part));
  return num(weeks) * 7 * DAY_MS + num(days) * DAY_MS + num(hours) * 3_600_000 + num(minutes) * 60_000 + num(seconds) * 1000;
}

function inDateRange(ms: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;
}

/** Local midnight a whole number of calendar days away. Calendar days, because a day is not always 24 hours. */
function addLocalDays(ms: number, days: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

function parseOrganizer(prop: Property | undefined): IcsEvent["organizer"] {
  if (!prop) return null;
  const name = cleanText(prop.params.get("CN") ?? "", MAX_NAME);
  let email = "";
  const m = /^mailto:(.*)$/i.exec(prop.value.trim());
  if (m) {
    // A mailto can carry "?subject=..." after the address.
    const addr = m[1].split("?", 1)[0].trim();
    // One address only: a list, a display name or anything with a control
    // character is not something to show as "the organizer's address".
    if (addr.length <= MAX_EMAIL && /^[^\s@,;<>"]+@[^\s@,;<>"]+$/.test(addr) && !UNSAFE_CHAR.test(addr)) email = addr;
  }
  return name || email ? { name, email } : null;
}

function buildEvent(props: Map<string, Property>, rawMethod: string): IcsEvent {
  const text = (name: string) => cleanText(unescapeText(props.get(name)?.value ?? ""), MAX_TEXT);

  const methodWord = rawMethod.trim().toUpperCase();
  // Only a plain word: the card shows or switches on it, so no free text.
  const method = /^[A-Z-]{1,32}$/.test(methodWord) ? methodWord : "";
  const status = (props.get("STATUS")?.value ?? "").trim().toUpperCase();

  const startTime = parseTime(props.get("DTSTART"));
  const endTime = startTime ? parseTime(props.get("DTEND")) : null;
  const duration = startTime && !endTime ? parseDuration(props.get("DURATION")?.value ?? "") : null;

  let start: number | null = null;
  let end: number | null = null;
  let allDay = false;
  let floating = false;

  if (startTime) {
    start = startTime.ms;
    allDay = startTime.allDay;
    floating = startTime.floating;
    if (allDay) {
      // DTEND is the day after the last day. A missing end is a one-day event.
      if (endTime?.allDay) end = addLocalDays(endTime.ms, -1);
      else if (duration !== null) end = addLocalDays(start, Math.floor(duration / DAY_MS) - 1);
      // Some senders repeat the start date as the end, which would otherwise
      // come out as ending the day before.
      if (end === null || !inDateRange(end) || end < start) end = start;
    } else {
      if (endTime && !endTime.allDay) end = endTime.ms;
      else if (duration !== null) end = start + duration;
      if (end !== null && (!inDateRange(end) || end < start)) end = null;
    }
  }

  return {
    title: text("SUMMARY"),
    location: text("LOCATION"),
    organizer: parseOrganizer(props.get("ORGANIZER")),
    method,
    cancelled: status === "CANCELLED" || method === "CANCEL",
    allDay,
    start,
    end,
    floating,
    recurring: (props.get("RRULE")?.value ?? "").trim() !== "",
  };
}

// The only event properties the card reads. Everything else is skipped before
// it is stored.
const WANTED = new Set(["SUMMARY", "LOCATION", "ORGANIZER", "STATUS", "DTSTART", "DTEND", "DURATION", "RRULE"]);

function parse(input: string): IcsEvent | null {
  if (typeof input !== "string") return null;
  const text = input.length > ICS_MAX_BYTES ? input.slice(0, ICS_MAX_BYTES) : input;
  const next = lineReader(text);

  // The open components, outermost first. An event counts only as a direct
  // child of the calendar, and a property only as a direct child of the event:
  // a VALARM inside it has a SUMMARY and DURATION of its own.
  const open: string[] = [];
  const props = new Map<string, Property>();
  let method = "";

  for (let count = 0; count < MAX_LINES; count++) {
    const line = next();
    if (line === null) return null;
    if (line.length === 0) continue;
    const prop = parseProperty(line);
    if (!prop) continue;

    if (prop.name === "BEGIN") {
      open.push(prop.value.trim().toUpperCase());
      continue;
    }
    if (prop.name === "END") {
      const closing = prop.value.trim().toUpperCase();
      // An END that matches nothing open is ignored instead of unbalancing the stack.
      if (open[open.length - 1] !== closing) continue;
      const inEvent = open.length === 2 && open[0] === "VCALENDAR" && closing === "VEVENT";
      open.pop();
      if (inEvent) return buildEvent(props, method);
      continue;
    }

    if (open.length === 1 && open[0] === "VCALENDAR") {
      if (prop.name === "METHOD" && method === "") method = prop.value;
    } else if (open.length === 2 && open[0] === "VCALENDAR" && open[1] === "VEVENT") {
      // First one wins, the same as for parameters.
      if (WANTED.has(prop.name) && !props.has(prop.name)) props.set(prop.name, prop);
    }
  }
  return null;
}

/** The first VEVENT in the text, or null when there is none or the text is not a calendar. */
export function parseIcs(text: string): IcsEvent | null {
  try {
    return parse(text);
  } catch {
    // Nothing above is expected to throw. This is the promise to the caller
    // that a hostile attachment can at worst produce no card.
    return null;
  }
}

function formatter(locale: string | undefined, timeZone: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone });
  } catch {
    // An unknown zone or locale: the viewer's own are better than no date.
    return new Intl.DateTimeFormat(undefined, options);
  }
}

/** Newer ICU puts narrow and no-break spaces before AM and PM. Plain spaces wrap and compare predictably. */
function plainSpaces(s: string): string {
  return s.replace(/[\u00a0\u2009\u202f]/g, " ");
}

function formatWhen(ev: IcsEvent, locale: string | undefined, timeZone: string | undefined): string {
  if (!ev || typeof ev.start !== "number" || !inDateRange(ev.start)) return "";
  const start = ev.start;
  const end = typeof ev.end === "number" && inDateRange(ev.end) && ev.end > start ? ev.end : null;
  const fmt = (options: Intl.DateTimeFormatOptions) => formatter(locale, timeZone, options);
  const fullDate = fmt({ weekday: "short", month: "short", day: "numeric", year: "numeric" });

  if (ev.allDay) {
    if (end === null || fullDate.format(start) === fullDate.format(end)) return fullDate.format(start);
    const year = fmt({ year: "numeric" });
    const withYear = fmt({ month: "short", day: "numeric", year: "numeric" });
    // The year is said once when both days share it.
    const first = year.format(start) === year.format(end) ? fmt({ month: "short", day: "numeric" }) : withYear;
    return `${first.format(start)} to ${withYear.format(end)}`;
  }

  const time = fmt({ hour: "numeric", minute: "2-digit" });
  if (end === null) return `${fullDate.format(start)}, ${time.format(start)}`;
  if (fullDate.format(start) !== fullDate.format(end)) {
    return `${fullDate.format(start)}, ${time.format(start)} to ${fullDate.format(end)}, ${time.format(end)}`;
  }

  // Same day: "3:00 to 4:00 PM" when both times share a day part, which only
  // reads right when the day part comes last, as it does in English.
  const startParts = time.formatToParts(start);
  const endParts = time.formatToParts(end);
  const lastStart = startParts[startParts.length - 1];
  const lastEnd = endParts[endParts.length - 1];
  let startText = time.format(start);
  if (lastStart?.type === "dayPeriod" && lastEnd?.type === "dayPeriod" && lastStart.value === lastEnd.value) {
    startText = startParts
      .slice(0, -1)
      .map((part) => part.value)
      .join("");
  }
  return `${fullDate.format(start)}, ${plainSpaces(startText).trim()} to ${time.format(end)}`;
}

/**
 * When the event is, as one plain line for the card: "Mon, Jan 5, 2026, 3:00
 * to 4:00 PM", or "Jan 5 to Jan 7, 2026" for an all-day event. "" when the
 * event has no start.
 *
 * An all-day event is stored as midnight in the viewer's zone, so pass a
 * `timeZone` for those only when it is the viewer's own. The options exist so
 * tests can pin the output.
 */
export function formatIcsWhen(ev: IcsEvent, opts?: { locale?: string; timeZone?: string }): string {
  try {
    return plainSpaces(formatWhen(ev, opts?.locale, opts?.timeZone));
  } catch {
    return "";
  }
}
