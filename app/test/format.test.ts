import { describe, it, expect } from "vitest";
import {
  formatDate,
  senderLabel,
  addressOf,
  splitAddressList,
  recipientSummary,
  initialsOf,
  avatarHue,
  avatarColor,
  formatFullDate,
  conversationSubject,
} from "@/lib/format";

describe("conversationSubject", () => {
  it("drops a leading reply or forward prefix, whatever its case", () => {
    expect(conversationSubject("Re: Lunch")).toBe("Lunch");
    expect(conversationSubject("RE: Lunch")).toBe("Lunch");
    expect(conversationSubject("Fwd: Lunch")).toBe("Lunch");
    expect(conversationSubject("FW: Lunch")).toBe("Lunch");
  });

  it("drops a whole chain of them", () => {
    expect(conversationSubject("Re: RE: Fwd: re:Lunch on Friday")).toBe("Lunch on Friday");
    expect(conversationSubject("  Re : Re[2]: Lunch")).toBe("Lunch");
  });

  it("leaves words that merely start like a prefix, and prefixes that are not leading", () => {
    expect(conversationSubject("Regarding lunch")).toBe("Regarding lunch");
    expect(conversationSubject("Fwd lunch")).toBe("Fwd lunch");
    expect(conversationSubject("Lunch re: Friday")).toBe("Lunch re: Friday");
    expect(conversationSubject("Reply: needed")).toBe("Reply: needed");
  });

  it("is empty for a subject that was only prefixes, or missing", () => {
    expect(conversationSubject("Re: ")).toBe("");
    expect(conversationSubject("")).toBe("");
    expect(conversationSubject(null)).toBe("");
  });

  it("reads a hostile subject once", () => {
    const start = performance.now();
    conversationSubject("re" + " ".repeat(200_000) + "x");
    conversationSubject("re: ".repeat(50_000) + "x");
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("formatDate", () => {
  // Fixed reference: 2026-06-03T15:30:00 local time.
  const now = new Date(2026, 5, 3, 15, 30, 0).getTime();

  it("renders a time for a message sent the same calendar day", () => {
    const sameDay = new Date(2026, 5, 3, 9, 41, 0).getTime();
    // e.g. "9:41 AM" — assert the locale time form, not an exact string.
    const out = formatDate(sameDay, now);
    expect(out).toMatch(/9:41/);
    expect(out).toMatch(/AM/i);
    expect(out).not.toMatch(/Jun/);
  });

  it("renders month + day for a message from another day", () => {
    const earlier = new Date(2026, 4, 20, 9, 41, 0).getTime(); // May 20
    expect(formatDate(earlier, now)).toBe("May 20");
  });

  it("renders month + day for a message later the same month, different day", () => {
    const otherDay = new Date(2026, 5, 1, 23, 0, 0).getTime(); // Jun 1
    expect(formatDate(otherDay, now)).toBe("Jun 1");
  });

  it("treats different years as not-same-day even on the same month/day", () => {
    const lastYear = new Date(2025, 5, 3, 9, 41, 0).getTime();
    expect(formatDate(lastYear, now)).toBe("Jun 3");
  });
});

describe("senderLabel", () => {
  it("returns the display name from \"Name <addr>\"", () => {
    expect(senderLabel("Alex Rivera <alex@example.com>")).toBe("Alex Rivera");
  });

  it("returns the bare address when there is no display name", () => {
    expect(senderLabel("alex@example.com")).toBe("alex@example.com");
  });

  it("returns an empty string for empty input", () => {
    expect(senderLabel("")).toBe("");
  });

  it("trims surrounding whitespace from the name", () => {
    expect(senderLabel("  Alex  <alex@x.com>")).toBe("Alex");
  });

  // Malformed: no closing ">". The angle regex doesn't match, so the whole
  // string is returned verbatim (documents current behavior).
  it("returns the whole string when the closing angle bracket is missing", () => {
    expect(senderLabel("Jane <j@x.com")).toBe("Jane <j@x.com");
  });

  // Quoted display name: the quotes are RFC 5322 syntax that lets a name carry
  // a comma, not part of the name. The reader shows the name, not the grammar.
  it("strips the quotes around a quoted display name", () => {
    expect(senderLabel("\"Doe, Jane\" <j@x.com>")).toBe("Doe, Jane");
  });

  it("unescapes a quoted name containing an escaped quote", () => {
    expect(senderLabel('"Bob \\" Smith" <b@x.com>')).toBe('Bob " Smith');
  });
});

describe("addressOf", () => {
  it("extracts the address from \"Name <addr>\"", () => {
    expect(addressOf("Alex Rivera <alex@example.com>")).toBe("alex@example.com");
  });

  it("returns the bare address unchanged", () => {
    expect(addressOf("alex@example.com")).toBe("alex@example.com");
  });

  it("trims a bare address", () => {
    expect(addressOf("  alex@example.com  ")).toBe("alex@example.com");
  });

  it("returns an empty string for empty input", () => {
    expect(addressOf("")).toBe("");
  });

  // Malformed: no closing ">". The angle regex doesn't match, so the whole
  // (trimmed) string is returned — acceptable per the format contract.
  it("returns the whole malformed string when the closing angle bracket is missing", () => {
    expect(addressOf("Jane <j@x.com")).toBe("Jane <j@x.com");
  });

  // Quoted display name: the address inside the angles is still extracted.
  it("extracts the address from a quoted display name", () => {
    expect(addressOf("\"Doe, Jane\" <j@x.com>")).toBe("j@x.com");
  });
});

describe("splitAddressList", () => {
  it("splits a plain comma-separated header", () => {
    expect(splitAddressList("a@x.com, b@y.com")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("does not split inside a quoted display name", () => {
    // The whole reason a naive split(",") is wrong: this is ONE recipient.
    expect(splitAddressList('"Doe, John" <j@x.com>, b@y.com')).toEqual([
      '"Doe, John" <j@x.com>',
      "b@y.com",
    ]);
  });

  it("does not split inside angle brackets, and handles semicolons", () => {
    expect(splitAddressList("A <a@x.com>; B <b@y.com>")).toEqual(["A <a@x.com>", "B <b@y.com>"]);
  });

  it("survives an escaped quote without swallowing the rest of the list", () => {
    expect(splitAddressList('"Bob \\" Smith" <b@x.com>, c@y.com')).toHaveLength(2);
  });

  it("stays linear on a pathological run of angle brackets", () => {
    // This runs over attacker-supplied header text on every render, so a
    // backtracking implementation would be a rendering-path DoS.
    const t0 = Date.now();
    splitAddressList("<".repeat(40000) + ", real@y.com");
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it("drops empty entries", () => {
    expect(splitAddressList(" , , ")).toEqual([]);
    expect(splitAddressList("")).toEqual([]);
  });
});

describe("recipientSummary", () => {
  it("names a single recipient", () => {
    expect(recipientSummary("Sam Rivera <sam@x.com>")).toBe("Sam Rivera");
  });

  it("collapses several into a count so the header stays one line", () => {
    expect(recipientSummary("Sam <sam@x.com>, b@y.com, c@z.com")).toBe("Sam and 2 others");
  });

  it("uses the singular for exactly one extra", () => {
    expect(recipientSummary("Sam <sam@x.com>, b@y.com")).toBe("Sam and 1 other");
  });

  it("counts Cc recipients too", () => {
    expect(recipientSummary("a@x.com", "b@y.com")).toBe("a@x.com and 1 other");
  });

  it("returns empty when there is nobody", () => {
    expect(recipientSummary("", null)).toBe("");
  });
});

describe("initialsOf", () => {
  it("takes two letters from a name", () => {
    expect(initialsOf("The Fastmail Team")).toBe("TF");
  });

  it("takes one letter from a single word or bare address", () => {
    expect(initialsOf("alice@example.com")).toBe("A");
  });

  it("skips a decorative prefix for the initial a reader recognises", () => {
    expect(initialsOf("\u{1F600} Smith")).toBe("S");
  });

  it("does not split a surrogate pair into half a character", () => {
    // Indexing with [0] here returns a lone high surrogate, which renders as a
    // replacement glyph rather than the sender's own character.
    expect(initialsOf("\u{1F600}")).toBe("\u{1F600}");
  });

  it("falls back rather than rendering nothing", () => {
    expect(initialsOf("")).toBe("?");
  });
});

describe("avatarHue", () => {
  it("is stable for the same sender and in range", () => {
    const h = avatarHue("alice@example.com");
    expect(h).toBe(avatarHue("alice@example.com"));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});

describe("formatFullDate", () => {
  const at = (y: number, m: number, d: number, hh = 12, mm = 0) =>
    new Date(y, m, d, hh, mm).getTime();

  it("shows just the time for today", () => {
    const now = at(2026, 6, 21, 15, 0);
    expect(formatFullDate(at(2026, 6, 21, 9, 41), now)).toMatch(/9:41/);
  });

  it("says yesterday", () => {
    expect(formatFullDate(at(2026, 6, 20), at(2026, 6, 21))).toMatch(/\(yesterday\)$/);
  });

  it("gives the date plus how long ago, like Fastmail", () => {
    expect(formatFullDate(at(2026, 6, 8), at(2026, 6, 21))).toMatch(/\(13 days ago\)$/);
  });

  it("counts CALENDAR days, not elapsed 24h periods", () => {
    // 23:59 last night is "yesterday" at 00:01, not "1 day ago" -> and it must
    // not flip to "2 days ago" a minute later. Dividing the epoch delta does.
    expect(formatFullDate(at(2026, 6, 20, 23, 59), at(2026, 6, 21, 0, 1))).toMatch(/yesterday/);
  });

  it("drops the relative part once it stops being useful", () => {
    expect(formatFullDate(at(2026, 4, 1), at(2026, 6, 21))).not.toMatch(/ago/);
  });

  it("includes the year only for another year", () => {
    expect(formatFullDate(at(2024, 6, 21), at(2026, 6, 21))).toMatch(/2024/);
    expect(formatFullDate(at(2026, 1, 3), at(2026, 6, 21))).not.toMatch(/2026/);
  });
});

describe("avatarColor", () => {
  // sRGB relative luminance, per WCAG 2.x.
  function luminance(r: number, g: number, b: number): number {
    const f = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] =
      h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  it("keeps WHITE initials above 4.5:1 on every hue it can produce", () => {
    // The hue rotates with the sender, so a single bad hue is a real sender
    // nobody can read. At 42% lightness the yellows were 2.94:1.
    const m = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(avatarColor("anything"));
    expect(m).not.toBeNull();
    const [sat, light] = [Number(m![2]) / 100, Number(m![3]) / 100];

    let worst = Infinity;
    for (let h = 0; h < 360; h++) {
      worst = Math.min(worst, 1.05 / (luminance(...hslToRgb(h, sat, light)) + 0.05));
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it("is stable for the same sender", () => {
    expect(avatarColor("alice@example.com")).toBe(avatarColor("alice@example.com"));
  });
});

describe("senderLabel hardening (adversarial review, 2026-08-03)", () => {
  it("stays fast on many angle brackets with no closing one", () => {
    // The old /^(.*?)<[^>]*>\s*$/ was O(n^2) on this shape: 147ms at 20k chars,
    // 9s at 160k. Reachable from one inbound message - postal-mime strips the
    // quotes around '"<<<<...<"@evil.example' and stores the run raw, and
    // recipientSummary now feeds To/Cc through here on every render.
    const nasty = "<".repeat(80000);
    const t0 = Date.now();
    senderLabel(nasty);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("does not eat backslashes in an unquoted name", () => {
    // Unescaping unconditionally turned an ordinary Windows-style name into
    // "DomainUser".
    expect(senderLabel("Domain\\User <a@x.com>")).toBe("Domain\\User");
    expect(senderLabel("C:\\path\\to <a@x.com>")).toBe("C:\\path\\to");
  });

  it("leaves a name alone when it is not one well-formed quoted string", () => {
    // Greedy ^"(.*)"$ turned this into 'a" and "b'.
    expect(senderLabel('"a" and "b" <a@x.com>')).toBe('"a" and "b"');
  });

  it("leaves an unterminated quote alone rather than reinterpreting it", () => {
    expect(senderLabel('"Doe, Jane <j@x.com>')).toBe('"Doe, Jane');
  });
});

describe("splitAddressList hardening (adversarial review, 2026-08-03)", () => {
  it("does not report forty recipients as one when a bracket is unpaired", () => {
    // depth never recovered, so a single stray "<" swallowed every later comma
    // and the summary claimed one recipient for a message sent to many.
    expect(splitAddressList("<a@x.com, b@y.com").length).toBe(2);
    expect(splitAddressList('"Doe, John <j@x.com>, real@y.com').length).toBeGreaterThan(1);
  });

  it("treats a backslash outside quotes as an ordinary character", () => {
    // RFC 5322 escapes only inside a quoted-string; honouring it outside merged
    // two recipients into one.
    expect(splitAddressList("a\\, b@y.com").length).toBe(2);
  });

  it("bounds the header it will parse", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `u${i}@x.com`).join(",");
    const t0 = Date.now();
    const out = splitAddressList(huge);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(out.length).toBeLessThan(5000);
  });

  it("still counts a normal long list correctly", () => {
    expect(splitAddressList("a@x.com, b@y.com, c@z.com").length).toBe(3);
  });
});
