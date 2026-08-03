// Replies went out unsigned while new messages were signed - the seeding effect
// bailed on `if (initial) return`. These pin the seed's SHAPE; the components'
// "do not overwrite what the user typed" behaviour is pinned separately.
import { describe, it, expect } from "vitest";
import { bodySeedWithSignature, sameBody } from "../lib/replyContext";

const QUOTE = "\n\n> On Jun 9, 2026 at 2:30 PM, Alice wrote:\n> hello";
const SIG = "Sam Rivera\nExample Co";

describe("bodySeedWithSignature", () => {
  it("puts the signature above the quoted history", () => {
    const out = bodySeedWithSignature(QUOTE, SIG);
    expect(out.indexOf(SIG)).toBeLessThan(out.indexOf("> On Jun 9"));
  });

  it("keeps a leading empty paragraph for the caret", () => {
    expect(bodySeedWithSignature(QUOTE, SIG).startsWith("\n\n")).toBe(true);
  });

  it("does not disturb the quote block itself", () => {
    // The quote is trimmable in the editor; reflowing it would break that.
    expect(bodySeedWithSignature(QUOTE, SIG)).toContain(QUOTE);
  });

  it("separates the signature from the quote with a blank line", () => {
    expect(bodySeedWithSignature(QUOTE, SIG)).toBe(`\n\n${SIG}${QUOTE}`);
  });

  it("returns the quote untouched when there is no signature", () => {
    expect(bodySeedWithSignature(QUOTE, "")).toBe(QUOTE);
  });

  it("matches the new-message shape when there is no quote", () => {
    // Compose already seeded `\n\n${sig}`; one helper has to serve both so the
    // two paths cannot drift apart again.
    expect(bodySeedWithSignature("", SIG)).toBe(`\n\n${SIG}`);
  });

  it("is empty when there is neither", () => {
    expect(bodySeedWithSignature("", "")).toBe("");
  });
});

describe("sameBody", () => {
  // The editor round-trips a seed through TipTap: "> " lines become a
  // <blockquote> and getText() returns them WITHOUT the markers. Comparing raw
  // strings therefore reports "the user edited this" the instant we seed.
  const ROUNDTRIPPED = "\n\nSam Rivera\nExample Co\n\n\n\nOn Jun 9, 2026 at 2:30 PM, Alice wrote:\nhello";

  it("sees a seed and its round-tripped form as the same body", () => {
    expect(sameBody(bodySeedWithSignature(QUOTE, SIG), ROUNDTRIPPED)).toBe(true);
  });

  it("still notices text the user actually typed", () => {
    expect(sameBody(`thanks!${ROUNDTRIPPED}`, bodySeedWithSignature(QUOTE, SIG))).toBe(false);
  });

  it("treats an empty body as different from a seeded one", () => {
    expect(sameBody("", bodySeedWithSignature(QUOTE, SIG))).toBe(false);
  });

  it("ignores pure whitespace differences", () => {
    expect(sameBody("a\n\n\nb", "a b")).toBe(true);
  });
});

describe("sameBody with a nested quote (replying inside a conversation)", () => {
  // buildReplyInitial prefixes "> " to EVERY line of the inbound body, and an
  // inbound message that is itself a reply already contains "> " lines. So the
  // seed carries "> > ..." while the editor's blockquote absorbs one level and
  // hands back "> ...". This is the common case, not an edge case.
  const NESTED_SEED = "\n\nSam\n\n> On Jun 3, Alice wrote:\n> Sounds good.\n> \n> > On Jun 1, Sam wrote:\n> > here is my question";
  const NESTED_MIRROR = "\n\nSam\n\n\n\nOn Jun 3, Alice wrote:\nSounds good.\n\n> On Jun 1, Sam wrote:\n> here is my question";

  it("recognises the round-tripped nested quote as the same body", () => {
    expect(sameBody(NESTED_SEED, NESTED_MIRROR)).toBe(true);
  });

  it("still notices real text typed above a nested quote", () => {
    expect(sameBody(`thanks!${NESTED_MIRROR}`, NESTED_SEED)).toBe(false);
  });
});
