import { describe, it, expect } from "vitest";
import { formatDate, senderLabel, addressOf } from "@/lib/format";

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

  // Quoted display name: the quotes are part of m[1] and are kept verbatim.
  it("keeps quotes around a quoted display name", () => {
    expect(senderLabel("\"Doe, Jane\" <j@x.com>")).toBe("\"Doe, Jane\"");
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
