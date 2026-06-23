import { describe, it, expect } from "vitest";
import { isValidEmail, splitRecipientTokens, commitRecipients } from "@/lib/recipients";

describe("isValidEmail", () => {
  it("accepts ordinary addresses (case/space-insensitive)", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail("  First.Last+tag@sub.example.co  ")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    for (const bad of ["", "a@", "@b.com", "a b@c.com", "no-at", "a@b", "a@@b.com"]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });
});

describe("splitRecipientTokens", () => {
  it("splits on comma, semicolon, and whitespace and drops empties", () => {
    expect(splitRecipientTokens("a@b.com, c@d.com;e@f.com\n g@h.com")).toEqual([
      "a@b.com",
      "c@d.com",
      "e@f.com",
      "g@h.com",
    ]);
  });
  it("returns [] for blank input", () => {
    expect(splitRecipientTokens("   ,; \n")).toEqual([]);
  });
});

describe("commitRecipients", () => {
  it("appends valid tokens, lowercased+trimmed, deduped against existing", () => {
    const r = commitRecipients(["a@b.com"], "C@D.com,  a@b.com , x@y.com");
    expect(r.recipients).toEqual(["a@b.com", "c@d.com", "x@y.com"]);
    expect(r.invalid).toEqual([]);
    expect(r.remainder).toBe("");
  });

  it("collects invalid tokens separately and keeps valid ones", () => {
    const r = commitRecipients([], "good@x.com, nope, also@bad");
    expect(r.recipients).toEqual(["good@x.com"]);
    expect(r.invalid).toEqual(["nope", "also@bad"]);
  });

  it("dedupes case-insensitively within the same input", () => {
    const r = commitRecipients([], "a@b.com, A@B.com");
    expect(r.recipients).toEqual(["a@b.com"]);
  });

  it("treats a trailing fragment with no delimiter as the remainder, not a recipient", () => {
    // While the user is mid-typing 'x@y' (no terminating delimiter), keep it in
    // the input rather than committing it. Only delimiter-terminated tokens commit.
    const r = commitRecipients([], "a@b.com, x@y", { keepTrailing: true });
    expect(r.recipients).toEqual(["a@b.com"]);
    expect(r.remainder).toBe("x@y");
    expect(r.invalid).toEqual([]);
  });

  it("with keepTrailing, a delimiter-terminated input leaves an empty remainder", () => {
    const r = commitRecipients([], "a@b.com, ", { keepTrailing: true });
    expect(r.recipients).toEqual(["a@b.com"]);
    expect(r.remainder).toBe("");
  });
});
