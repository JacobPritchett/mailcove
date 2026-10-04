// The invite card parser. Nothing here depends on the zone the tests run in:
// UTC and TZID events are checked by epoch milliseconds, floating and all-day
// events against a local Date built the same way, and formatting always gets
// an explicit zone.
import { describe, it, expect } from "vitest";
import { ICS_MAX_BYTES, formatIcsWhen, parseIcs, type IcsEvent } from "@/lib/ics";

/** A calendar with one event, CRLF line ends as the RFC asks. */
const cal = (eventLines: string[], calendarLines: string[] = []) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...calendarLines, "BEGIN:VEVENT", ...eventLines, "END:VEVENT", "END:VCALENDAR", ""].join(
    "\r\n",
  );

/** Local wall-clock time in whatever zone the tests run in. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime();
const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

/** The zone the tests run in, for formatting all-day and floating events. */
const HERE = new Intl.DateTimeFormat().resolvedOptions().timeZone;

const blank: IcsEvent = {
  title: "",
  location: "",
  organizer: null,
  method: "",
  cancelled: false,
  allDay: false,
  start: null,
  end: null,
  floating: false,
  recurring: false,
};

describe("parseIcs on an ordinary invite", () => {
  const text = cal(
    [
      "UID:abc-123",
      "DTSTAMP:20260101T000000Z",
      "DTSTART:20260105T200000Z",
      "DTEND:20260105T210000Z",
      "SUMMARY:Quarterly planning",
      "LOCATION:Room 4",
      'ORGANIZER;CN="Ada Lovelace":mailto:ada@example.com',
    ],
    ["METHOD:REQUEST"],
  );

  it("reads every field of the card", () => {
    expect(parseIcs(text)).toEqual({
      title: "Quarterly planning",
      location: "Room 4",
      organizer: { name: "Ada Lovelace", email: "ada@example.com" },
      method: "REQUEST",
      cancelled: false,
      allDay: false,
      start: utc(2026, 1, 5, 20),
      end: utc(2026, 1, 5, 21),
      floating: false,
      recurring: false,
    });
  });

  it("reads the same thing with LF or lone CR line ends", () => {
    expect(parseIcs(text.replace(/\r\n/g, "\n"))).toEqual(parseIcs(text));
    expect(parseIcs(text.replace(/\r\n/g, "\r"))).toEqual(parseIcs(text));
  });

  it("gives empty strings and nulls for what is absent", () => {
    expect(parseIcs(cal(["UID:1"]))).toEqual(blank);
  });

  it("treats names and parameter names as case-insensitive and ignores a group prefix", () => {
    const ev = parseIcs(
      [
        "begin:vcalendar",
        "method:request",
        "begin:vevent",
        "a.Summary:Lunch",
        "item1.dtstart;tzid=America/New_York:20260105T090000",
        "end:vevent",
        "end:vcalendar",
      ].join("\r\n"),
    );
    expect(ev?.title).toBe("Lunch");
    expect(ev?.method).toBe("REQUEST");
    expect(ev?.start).toBe(utc(2026, 1, 5, 14));
  });

  it("returns the first event when there are several", () => {
    const two = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:First",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "SUMMARY:Second",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(two)?.title).toBe("First");
  });
});

describe("line unfolding", () => {
  it("joins a line continued with a space or a tab", () => {
    const ev = parseIcs(cal(["SUMMARY:Quarterly pla", " nning with the wh", "\tole team", "LOCA", " TION:Room 4"]));
    expect(ev?.title).toBe("Quarterly planning with the whole team");
    expect(ev?.location).toBe("Room 4");
  });

  it("unfolds with LF line ends too", () => {
    const ev = parseIcs(cal(["SUMMARY:Quarterly pla", " nning"]).replace(/\r\n/g, "\n"));
    expect(ev?.title).toBe("Quarterly planning");
  });

  it("removes only one leading space, so a folded word break survives", () => {
    expect(parseIcs(cal(["SUMMARY:Board", "  meeting"]))?.title).toBe("Board meeting");
  });
});

describe("property parameters", () => {
  it("does not split on a colon or semicolon inside a quoted value", () => {
    const ev = parseIcs(
      cal(['ORGANIZER;CN="Lovelace: Ada; Countess";ROLE=CHAIR:mailto:ada@example.com', 'SUMMARY;ALTREP="cid:part1@example.com":Review']),
    );
    expect(ev?.organizer).toEqual({ name: "Lovelace: Ada; Countess", email: "ada@example.com" });
    expect(ev?.title).toBe("Review");
  });

  it("skips a line whose quoted value never closes", () => {
    const ev = parseIcs(cal(['SUMMARY;X="broken:Nope', "LOCATION:Room 4"]));
    expect(ev?.title).toBe("");
    expect(ev?.location).toBe("Room 4");
  });

  it("keeps colons that belong to the value", () => {
    expect(parseIcs(cal(["LOCATION:https://example.com/room:4"]))?.location).toBe("https://example.com/room:4");
  });
});

describe("text values", () => {
  it("unescapes commas, semicolons, backslashes and newlines", () => {
    const ev = parseIcs(cal(["SUMMARY:Lunch\\, then a walk\\; maybe \\\\o/", "LOCATION:1 Main St\\nSuite 5\\NPhoenix"]));
    expect(ev?.title).toBe("Lunch, then a walk; maybe \\o/");
    expect(ev?.location).toBe("1 Main St Suite 5 Phoenix");
  });

  it("strips control characters and bidi overrides", () => {
    const ev = parseIcs(cal(["SUMMARY:invoice\u202egnp\u0007.exe\u2066\u2069\u0085 ok", "LOCATION:Room\u00004"]));
    expect(ev?.title).toBe("invoicegnp.exe ok");
    expect(ev?.location).toBe("Room4");
  });

  it("caps the title and location at 300 characters", () => {
    const ev = parseIcs(cal([`SUMMARY:${"a".repeat(1000)}`, `LOCATION:${"b".repeat(1000)}`]));
    expect(ev?.title).toBe("a".repeat(300));
    expect(ev?.location).toBe("b".repeat(300));
  });

  it("returns markup as the same inert text", () => {
    const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script> &amp; {{7*7}}';
    const ev = parseIcs(cal([`SUMMARY:${markup}`, `LOCATION:${markup}`]));
    expect(ev?.title).toBe(markup);
    expect(ev?.location).toBe(markup);
  });
});

describe("timed events", () => {
  it("reads a Z time as UTC", () => {
    const ev = parseIcs(cal(["DTSTART:20260705T133000Z"]));
    expect(ev?.start).toBe(utc(2026, 7, 5, 13, 30));
    expect(ev?.end).toBeNull();
    expect(ev?.allDay).toBe(false);
    expect(ev?.floating).toBe(false);
  });

  it("resolves a TZID on both sides of a daylight saving change", () => {
    const summer = parseIcs(cal(["DTSTART;TZID=America/New_York:20260706T090000", "DTEND;TZID=America/New_York:20260706T100000"]));
    expect(summer?.start).toBe(utc(2026, 7, 6, 13));
    expect(summer?.end).toBe(utc(2026, 7, 6, 14));
    expect(summer?.floating).toBe(false);

    const winter = parseIcs(cal(["DTSTART;TZID=America/New_York:20260105T090000"]));
    expect(winter?.start).toBe(utc(2026, 1, 5, 14));
  });

  it("settles right at the edges of a daylight saving change", () => {
    // Clocks in New York go from 2:00 to 3:00 on 8 March 2026 and back from
    // 2:00 to 1:00 on 1 November 2026.
    expect(parseIcs(cal(["DTSTART;TZID=America/New_York:20260308T030000"]))?.start).toBe(utc(2026, 3, 8, 7));
    expect(parseIcs(cal(["DTSTART;TZID=America/New_York:20260308T015959"]))?.start).toBe(utc(2026, 3, 8, 6, 59, 59));
    expect(parseIcs(cal(["DTSTART;TZID=America/New_York:20261101T030000"]))?.start).toBe(utc(2026, 11, 1, 8));
  });

  it("resolves a zone east of UTC and one with a half hour offset", () => {
    expect(parseIcs(cal(["DTSTART;TZID=Asia/Tokyo:20260105T090000"]))?.start).toBe(utc(2026, 1, 5, 0));
    expect(parseIcs(cal(["DTSTART;TZID=Asia/Kolkata:20260105T090000"]))?.start).toBe(utc(2026, 1, 5, 3, 30));
  });

  it("accepts a quoted TZID", () => {
    expect(parseIcs(cal(['DTSTART;TZID="America/New_York":20260105T090000']))?.start).toBe(utc(2026, 1, 5, 14));
  });

  it("maps the Windows zone names Outlook writes", () => {
    const at = (tzid: string, value: string) => parseIcs(cal([`DTSTART;TZID=${tzid}:${value}`]));
    expect(at("Pacific Standard Time", "20260706T090000")?.start).toBe(utc(2026, 7, 6, 16));
    expect(at("Pacific Standard Time", "20260105T090000")?.start).toBe(utc(2026, 1, 5, 17));
    // Arizona keeps standard time all year.
    expect(at("US Mountain Standard Time", "20260706T090000")?.start).toBe(utc(2026, 7, 6, 16));
    expect(at("Mountain Standard Time", "20260706T090000")?.start).toBe(utc(2026, 7, 6, 15));
    expect(at("Central Standard Time", "20260105T090000")?.start).toBe(utc(2026, 1, 5, 15));
    expect(at("Eastern Standard Time", "20260105T090000")?.start).toBe(utc(2026, 1, 5, 14));
    expect(at("GMT Standard Time", "20260706T090000")?.start).toBe(utc(2026, 7, 6, 8));
    expect(at("W. Europe Standard Time", "20260105T090000")?.start).toBe(utc(2026, 1, 5, 8));
    expect(at("Central Europe Standard Time", "20260105T090000")?.start).toBe(utc(2026, 1, 5, 8));
    expect(at("Romance Standard Time", "20260105T090000")?.start).toBe(utc(2026, 1, 5, 8));
    expect(at("India Standard Time", "20260105T090000")?.start).toBe(utc(2026, 1, 5, 3, 30));
    expect(at("China Standard Time", "20260105T090000")?.start).toBe(utc(2026, 1, 5, 1));
    expect(at("Tokyo Standard Time", "20260105T090000")?.start).toBe(utc(2026, 1, 5, 0));
    expect(at("AUS Eastern Standard Time", "20260105T090000")?.start).toBe(utc(2026, 1, 4, 22));
    expect(at("UTC", "20260105T090000")?.start).toBe(utc(2026, 1, 5, 9));
    expect(at("Pacific Standard Time", "20260105T090000")?.floating).toBe(false);
  });

  it("reads an unknown TZID as floating instead of throwing", () => {
    const ev = parseIcs(cal(["DTSTART;TZID=Mars/Olympus Mons:20260706T090000", "DTEND;TZID=Mars/Olympus Mons:20260706T100000"]));
    expect(ev?.floating).toBe(true);
    expect(ev?.start).toBe(local(2026, 7, 6, 9));
    expect(ev?.end).toBe(local(2026, 7, 6, 10));
  });

  it("reads a time with no zone as floating, in the viewer's zone", () => {
    const ev = parseIcs(cal(["DTSTART:20260706T090000", "DTEND:20260706T103000"]));
    expect(ev?.floating).toBe(true);
    expect(ev?.allDay).toBe(false);
    expect(ev?.start).toBe(local(2026, 7, 6, 9));
    expect(ev?.end).toBe(local(2026, 7, 6, 10, 30));
  });

  it("rejects impossible dates instead of rolling them over", () => {
    for (const bad of [
      "20261305T090000Z", // month 13
      "20260132T090000Z", // day 32
      "20260230T090000Z", // 30 February
      "20260105T250000Z", // hour 25
      "20260105T096000Z", // minute 60
      "20260100T090000Z", // day 0
      "20260105T09Z",
      "tomorrow",
      "",
    ]) {
      const ev = parseIcs(cal([`DTSTART:${bad}`, "DTEND:20260105T100000Z"]));
      expect(ev, bad).not.toBeNull();
      expect(ev?.start, bad).toBeNull();
      expect(ev?.end, bad).toBeNull();
    }
    expect(parseIcs(cal(["DTSTART;VALUE=DATE:20260230"]))?.start).toBeNull();
    // 29 February exists in 2028 only.
    expect(parseIcs(cal(["DTSTART:20280229T000000Z"]))?.start).toBe(utc(2028, 2, 29));
    expect(parseIcs(cal(["DTSTART:20260229T000000Z"]))?.start).toBeNull();
  });

  it("drops an end that is unparseable or before the start", () => {
    expect(parseIcs(cal(["DTSTART:20260105T200000Z", "DTEND:20260105T990000Z"]))?.end).toBeNull();
    expect(parseIcs(cal(["DTSTART:20260105T200000Z", "DTEND:20260105T190000Z"]))?.end).toBeNull();
  });
});

describe("DURATION", () => {
  const withDuration = (d: string) => parseIcs(cal(["DTSTART:20260105T200000Z", `DURATION:${d}`]));

  it("derives the end of a timed event", () => {
    expect(withDuration("PT1H30M")?.end).toBe(utc(2026, 1, 5, 21, 30));
    expect(withDuration("P1D")?.end).toBe(utc(2026, 1, 6, 20));
    expect(withDuration("P1W")?.end).toBe(utc(2026, 1, 12, 20));
    expect(withDuration("P1DT2H3M4S")?.end).toBe(utc(2026, 1, 6, 22, 3, 4));
    expect(withDuration("PT45S")?.end).toBe(utc(2026, 1, 5, 20, 0, 45));
  });

  it("ignores a duration that is negative, empty or nonsense", () => {
    for (const bad of ["-PT1H", "P", "PT", "1H", "PT1H30", "P99999999999999999999D", "forever"]) {
      expect(withDuration(bad)?.end, bad).toBeNull();
    }
  });

  it("loses to an explicit DTEND", () => {
    const ev = parseIcs(cal(["DTSTART:20260105T200000Z", "DTEND:20260105T203000Z", "DURATION:PT5H"]));
    expect(ev?.end).toBe(utc(2026, 1, 5, 20, 30));
  });

  it("counts whole days for an all-day event", () => {
    expect(parseIcs(cal(["DTSTART;VALUE=DATE:20260105", "DURATION:P3D"]))?.end).toBe(local(2026, 1, 7));
    expect(parseIcs(cal(["DTSTART;VALUE=DATE:20260105", "DURATION:P1D"]))?.end).toBe(local(2026, 1, 5));
  });
});

describe("all-day events", () => {
  it("reads a single day, with the exclusive end pulled back", () => {
    const ev = parseIcs(cal(["DTSTART;VALUE=DATE:20260105", "DTEND;VALUE=DATE:20260106"]));
    expect(ev?.allDay).toBe(true);
    expect(ev?.floating).toBe(false);
    expect(ev?.start).toBe(local(2026, 1, 5));
    expect(ev?.end).toBe(local(2026, 1, 5));
  });

  it("treats a missing end as one day", () => {
    const ev = parseIcs(cal(["DTSTART;VALUE=DATE:20260105"]));
    expect(ev?.allDay).toBe(true);
    expect(ev?.start).toBe(local(2026, 1, 5));
    expect(ev?.end).toBe(local(2026, 1, 5));
  });

  it("reads several days, ending on the last day", () => {
    const ev = parseIcs(cal(["DTSTART;VALUE=DATE:20260105", "DTEND;VALUE=DATE:20260108"]));
    expect(ev?.start).toBe(local(2026, 1, 5));
    expect(ev?.end).toBe(local(2026, 1, 7));
  });

  it("pulls the end back across a month and a year", () => {
    const ev = parseIcs(cal(["DTSTART;VALUE=DATE:20261230", "DTEND;VALUE=DATE:20270101"]));
    expect(ev?.start).toBe(local(2026, 12, 30));
    expect(ev?.end).toBe(local(2026, 12, 31));
  });

  it("recognises a bare eight digit value without VALUE=DATE", () => {
    const ev = parseIcs(cal(["DTSTART:20260105", "DTEND:20260107"]));
    expect(ev?.allDay).toBe(true);
    expect(ev?.start).toBe(local(2026, 1, 5));
    expect(ev?.end).toBe(local(2026, 1, 6));
  });

  it("never ends before it starts", () => {
    // Some senders write the same date twice.
    const ev = parseIcs(cal(["DTSTART;VALUE=DATE:20260105", "DTEND;VALUE=DATE:20260105"]));
    expect(ev?.end).toBe(local(2026, 1, 5));
    const backwards = parseIcs(cal(["DTSTART;VALUE=DATE:20260105", "DTEND;VALUE=DATE:20250101"]));
    expect(backwards?.end).toBe(local(2026, 1, 5));
  });
});

describe("organizer", () => {
  const organizer = (line: string) => parseIcs(cal([line]))?.organizer;

  it("reads the name and address", () => {
    expect(organizer("ORGANIZER;CN=Ada Lovelace:mailto:ada@example.com")).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  it("matches the mailto scheme in any case", () => {
    expect(organizer("ORGANIZER:MAILTO:ada@example.com")).toEqual({ name: "", email: "ada@example.com" });
    expect(organizer("ORGANIZER:MailTo:ada@example.com")).toEqual({ name: "", email: "ada@example.com" });
  });

  it("keeps the name when the address is not usable", () => {
    expect(organizer("ORGANIZER;CN=Ada:https://example.com/ada")).toEqual({ name: "Ada", email: "" });
    expect(organizer("ORGANIZER;CN=Ada:mailto:ada@example.com, eve@example.com")).toEqual({ name: "Ada", email: "" });
    expect(organizer("ORGANIZER;CN=Ada:mailto:ada@@example.com")).toEqual({ name: "Ada", email: "" });
    expect(organizer("ORGANIZER;CN=Ada:mailto:ada")).toEqual({ name: "Ada", email: "" });
    expect(organizer(`ORGANIZER;CN=Ada:mailto:${"a".repeat(250)}@example.com`)).toEqual({ name: "Ada", email: "" });
  });

  it("is null when neither part is usable", () => {
    expect(organizer("ORGANIZER:https://example.com/ada")).toBeNull();
    expect(organizer("ORGANIZER;CN=:mailto:not an address")).toBeNull();
    expect(organizer("UID:1")).toBeNull();
  });

  it("cleans and caps the name", () => {
    expect(organizer('ORGANIZER;CN="Ada\u202e <b>Lovelace</b>":mailto:ada@example.com')?.name).toBe("Ada <b>Lovelace</b>");
    expect(organizer(`ORGANIZER;CN=${"n".repeat(500)}:mailto:ada@example.com`)?.name).toBe("n".repeat(200));
  });
});

describe("method, status and recurrence", () => {
  it("upper-cases the method", () => {
    expect(parseIcs(cal(["UID:1"], ["METHOD:reply"]))?.method).toBe("REPLY");
  });

  it("drops a method that is not a plain word", () => {
    expect(parseIcs(cal(["UID:1"], ["METHOD:<b>REQUEST</b>"]))?.method).toBe("");
  });

  it("is cancelled by STATUS:CANCELLED on the event", () => {
    const ev = parseIcs(cal(["STATUS:cancelled"], ["METHOD:REQUEST"]));
    expect(ev?.cancelled).toBe(true);
    expect(ev?.method).toBe("REQUEST");
  });

  it("is cancelled by METHOD:CANCEL", () => {
    expect(parseIcs(cal(["STATUS:CONFIRMED"], ["METHOD:CANCEL"]))?.cancelled).toBe(true);
  });

  it("is not cancelled otherwise", () => {
    expect(parseIcs(cal(["STATUS:TENTATIVE"], ["METHOD:REQUEST"]))?.cancelled).toBe(false);
  });

  it("notes a repeat rule without expanding it", () => {
    expect(parseIcs(cal(["DTSTART:20260105T200000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO"]))?.recurring).toBe(true);
    expect(parseIcs(cal(["DTSTART:20260105T200000Z"]))?.recurring).toBe(false);
  });
});

describe("nested and neighbouring components", () => {
  it("does not let a VALARM leak into the event", () => {
    const ev = parseIcs(
      cal([
        "DTSTART:20260105T200000Z",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "SUMMARY:Alarm title",
        "DESCRIPTION:Reminder",
        "LOCATION:Nowhere",
        "DURATION:PT15M",
        "TRIGGER:-PT15M",
        "STATUS:CANCELLED",
        "RRULE:FREQ=DAILY",
        "END:VALARM",
        "LOCATION:Room 4",
      ]),
    );
    expect(ev?.title).toBe("");
    expect(ev?.location).toBe("Room 4");
    expect(ev?.end).toBeNull();
    expect(ev?.cancelled).toBe(false);
    expect(ev?.recurring).toBe(false);
  });

  it("is not confused by a VTIMEZONE block before the event", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VTIMEZONE",
      "TZID:America/New_York",
      "BEGIN:STANDARD",
      "DTSTART:16011104T020000",
      "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11",
      "TZOFFSETFROM:-0400",
      "TZOFFSETTO:-0500",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:16010311T020000",
      "RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0400",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "SUMMARY:Standup",
      "DTSTART;TZID=America/New_York:20260706T090000",
      "DTEND;TZID=America/New_York:20260706T091500",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const ev = parseIcs(text);
    expect(ev?.title).toBe("Standup");
    expect(ev?.start).toBe(utc(2026, 7, 6, 13));
    expect(ev?.end).toBe(utc(2026, 7, 6, 13, 15));
    expect(ev?.recurring).toBe(false);
    expect(ev?.method).toBe("REQUEST");
  });

  it("ignores an event tucked inside another component", () => {
    const text = ["BEGIN:VCALENDAR", "BEGIN:VTODO", "BEGIN:VEVENT", "SUMMARY:Hidden", "END:VEVENT", "END:VTODO", "END:VCALENDAR"].join("\r\n");
    expect(parseIcs(text)).toBeNull();
  });

  it("does not read METHOD from inside a component", () => {
    expect(parseIcs(cal(["METHOD:CANCEL"]))?.method).toBe("");
  });
});

describe("input that is not a usable calendar", () => {
  it("is null when there is no event", () => {
    expect(parseIcs("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n")).toBeNull();
    expect(parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:Task\r\nEND:VTODO\r\nEND:VCALENDAR\r\n")).toBeNull();
  });

  it("is null for an event outside any calendar", () => {
    expect(parseIcs("BEGIN:VEVENT\r\nSUMMARY:Loose\r\nEND:VEVENT\r\n")).toBeNull();
  });

  it("is null for an event that never ends", () => {
    expect(parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Cut off")).toBeNull();
  });

  it("is null for empty text, prose and markup", () => {
    expect(parseIcs("")).toBeNull();
    expect(parseIcs("Hello, see you on Monday.")).toBeNull();
    expect(parseIcs("<html><body>BEGIN:VCALENDAR</body></html>")).toBeNull();
  });

  it("is null for values that are not strings at all", () => {
    for (const bad of [null, undefined, 42, {}, [], new Uint8Array(4)]) {
      expect(parseIcs(bad as unknown as string)).toBeNull();
    }
  });

  it("does not throw on binary noise", () => {
    // A fixed pseudo-random sequence so a failure can be reproduced.
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let round = 0; round < 20; round++) {
      let noise = "";
      for (let i = 0; i < 4000; i++) noise += String.fromCharCode(next() % (round % 2 ? 256 : 65536));
      expect(() => parseIcs(noise)).not.toThrow();
      // Noise inside a real event must not throw either.
      expect(() => parseIcs(cal([`SUMMARY:${noise}`, `DTSTART;TZID=${noise.slice(0, 40)}:${noise.slice(40, 60)}`]))).not.toThrow();
    }
  });

  it("does not throw on hostile property shapes", () => {
    for (const line of [
      "DTSTART;TZID=__proto__:20260105T090000",
      "DTSTART;TZID=constructor:20260105T090000",
      'DTSTART;TZID="":20260105T090000',
      "DTSTART;;;;:20260105T090000",
      "DTSTART;TZID:20260105T090000",
      "__proto__:1",
      ";:",
      ":",
      "ORGANIZER;CN=\uD800:mailto:\uDFFF@x",
      `DTSTART;TZID=${"A/".repeat(5000)}:20260105T090000`,
    ]) {
      expect(() => parseIcs(cal([line])), line).not.toThrow();
      expect(parseIcs(cal([line])), line).not.toBeNull();
    }
  });
});

describe("bounded work", () => {
  it("allows a quarter of a megabyte", () => {
    expect(ICS_MAX_BYTES).toBe(262_144);
  });

  it("returns quickly on two megabytes of junk", () => {
    const shapes = [
      "x".repeat(2_000_000),
      "JUNK:abc\r\n".repeat(200_000),
      "\r\n ".repeat(700_000),
      `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY${';A="b"'.repeat(300_000)}`,
      "BEGIN:VCALENDAR\r\n" + "BEGIN:VEVENT\r\n".repeat(150_000),
      '"'.repeat(2_000_000),
      "\\".repeat(2_000_000),
    ];
    for (const junk of shapes) {
      const began = performance.now();
      expect(parseIcs(junk)).toBeNull();
      // Generous: the work is a single pass over at most ICS_MAX_BYTES.
      expect(performance.now() - began).toBeLessThan(1000);
    }
  });

  it("does not look past the size limit", () => {
    const padding = `X-PAD:${"p".repeat(ICS_MAX_BYTES)}`;
    const text = ["BEGIN:VCALENDAR", padding, "BEGIN:VEVENT", "SUMMARY:Too far", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    expect(parseIcs(text)).toBeNull();
  });

  it("does not look past 5000 lines", () => {
    const filler = (count: number) => Array.from({ length: count }, (_, i) => `X-FILL:${i}`);
    const build = (count: number) =>
      ["BEGIN:VCALENDAR", ...filler(count), "BEGIN:VEVENT", "SUMMARY:Deep", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    expect(parseIcs(build(4000))?.title).toBe("Deep");
    expect(parseIcs(build(5000))).toBeNull();
  });
});

describe("formatIcsWhen", () => {
  const NY = { locale: "en-US", timeZone: "America/New_York" };
  const here = { locale: "en-US", timeZone: HERE };
  const timed = (start: number | null, end: number | null): IcsEvent => ({ ...blank, start, end });
  const allDay = (start: number, end: number): IcsEvent => ({ ...blank, allDay: true, start, end });

  it("shows a same-day range with the day part once", () => {
    expect(formatIcsWhen(timed(utc(2026, 1, 5, 20), utc(2026, 1, 5, 21)), NY)).toBe("Mon, Jan 5, 2026, 3:00 to 4:00 PM");
  });

  it("keeps both day parts when the range crosses noon", () => {
    expect(formatIcsWhen(timed(utc(2026, 1, 5, 16), utc(2026, 1, 5, 18)), NY)).toBe("Mon, Jan 5, 2026, 11:00 AM to 1:00 PM");
  });

  it("shows only the start when there is no end", () => {
    expect(formatIcsWhen(timed(utc(2026, 1, 5, 20), null), NY)).toBe("Mon, Jan 5, 2026, 3:00 PM");
    expect(formatIcsWhen(timed(utc(2026, 1, 5, 20), utc(2026, 1, 5, 20)), NY)).toBe("Mon, Jan 5, 2026, 3:00 PM");
  });

  it("names both days when the range crosses midnight", () => {
    expect(formatIcsWhen(timed(utc(2026, 1, 5, 20), utc(2026, 1, 6, 15)), NY)).toBe(
      "Mon, Jan 5, 2026, 3:00 PM to Tue, Jan 6, 2026, 10:00 AM",
    );
  });

  it("follows the zone it is given", () => {
    expect(formatIcsWhen(timed(utc(2026, 1, 5, 20), utc(2026, 1, 5, 21)), { locale: "en-US", timeZone: "Asia/Tokyo" })).toBe(
      "Tue, Jan 6, 2026, 5:00 to 6:00 AM",
    );
    expect(formatIcsWhen(timed(utc(2026, 7, 6, 13), utc(2026, 7, 6, 14)), NY)).toBe("Mon, Jul 6, 2026, 9:00 to 10:00 AM");
  });

  it("formats a parsed floating event in the viewer's zone", () => {
    const ev = parseIcs(cal(["DTSTART:20260706T090000", "DTEND:20260706T103000"]));
    expect(formatIcsWhen(ev!, here)).toBe("Mon, Jul 6, 2026, 9:00 to 10:30 AM");
  });

  it("says only the date for a single all-day event", () => {
    expect(formatIcsWhen(allDay(local(2026, 1, 5), local(2026, 1, 5)), here)).toBe("Mon, Jan 5, 2026");
    const parsed = parseIcs(cal(["DTSTART;VALUE=DATE:20260105", "DTEND;VALUE=DATE:20260106"]));
    expect(formatIcsWhen(parsed!, here)).toBe("Mon, Jan 5, 2026");
  });

  it("says the first and last day for several all-day days", () => {
    expect(formatIcsWhen(allDay(local(2026, 1, 5), local(2026, 1, 7)), here)).toBe("Jan 5 to Jan 7, 2026");
    const parsed = parseIcs(cal(["DTSTART;VALUE=DATE:20260105", "DTEND;VALUE=DATE:20260108"]));
    expect(formatIcsWhen(parsed!, here)).toBe("Jan 5 to Jan 7, 2026");
  });

  it("gives both years when an all-day range crosses the new year", () => {
    expect(formatIcsWhen(allDay(local(2026, 12, 31), local(2027, 1, 2)), here)).toBe("Dec 31, 2026 to Jan 2, 2027");
  });

  it("is empty when there is no start", () => {
    expect(formatIcsWhen(blank, NY)).toBe("");
    expect(formatIcsWhen(timed(Number.NaN, null), NY)).toBe("");
    expect(formatIcsWhen(timed(Number.POSITIVE_INFINITY, null), NY)).toBe("");
  });

  it("falls back instead of throwing on a bad zone or locale", () => {
    const ev = timed(utc(2026, 1, 5, 20), utc(2026, 1, 5, 21));
    expect(() => formatIcsWhen(ev, { locale: "en-US", timeZone: "Mars/Olympus" })).not.toThrow();
    expect(() => formatIcsWhen(ev, { locale: "not a locale", timeZone: "America/New_York" })).not.toThrow();
    expect(formatIcsWhen(ev, { locale: "en-US", timeZone: "Mars/Olympus" })).not.toBe("");
    expect(() => formatIcsWhen(null as unknown as IcsEvent)).not.toThrow();
  });

  it("works with no options", () => {
    expect(formatIcsWhen(timed(utc(2026, 1, 5, 20), utc(2026, 1, 5, 21)))).not.toBe("");
  });

  it("never uses a dash or an unusual space", () => {
    const outputs = [
      formatIcsWhen(timed(utc(2026, 1, 5, 20), utc(2026, 1, 5, 21)), NY),
      formatIcsWhen(timed(utc(2026, 1, 5, 20), utc(2026, 1, 6, 15)), NY),
      formatIcsWhen(allDay(local(2026, 1, 5), local(2026, 1, 7)), here),
    ];
    for (const out of outputs) expect(out).not.toMatch(/[-\u2012-\u2015\u00a0\u202f\u2009]/);
  });
});
