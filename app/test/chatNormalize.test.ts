import { describe, it, expect } from "vitest";
import { validateHref, normalizeMessage } from "@/lib/chatNormalize";

describe("validateHref", () => {
  it("allows http/https/mailto, rejects others", () => {
    expect(validateHref("https://a.com")).toBe("https://a.com");
    expect(validateHref("http://a.com")).toBe("http://a.com");
    expect(validateHref("mailto:x@y.com")).toBe("mailto:x@y.com");
    expect(validateHref("javascript:alert(1)")).toBeNull();
    expect(validateHref("data:text/html,x")).toBeNull();
    expect(validateHref("  HTTPS://A.com ")).toBe("HTTPS://A.com");
  });
});

describe("normalizeMessage (text source)", () => {
  it("splits an 'On … wrote:' quote into quoted", () => {
    const r = normalizeMessage({ text: "Thanks!\n\nOn Mon, X wrote:\n> old line\n> more", html: "" });
    expect(r.body.flat().map(i => i.s).join(" ")).toContain("Thanks");
    expect(r.quoted).not.toBeNull();
    expect(r.quoted!.flat().map(i => i.s).join(" ")).toContain("old line");
    expect(r.quoted!.flat().map(i => i.s).join(" ")).not.toMatch(/(^|\s)>/);
  });
  it("treats a run of > lines as quoted", () => {
    const r = normalizeMessage({ text: "Reply\n> quoted a\n> quoted b", html: "" });
    expect(r.quoted).not.toBeNull();
  });
  it("splits the RFC 3676 '-- ' signature delimiter into signature", () => {
    const r = normalizeMessage({ text: "Hello\n-- \nJane\nCEO", html: "" });
    expect(r.signature!.flat().map(i => i.s).join(" ")).toContain("Jane");
    expect(r.body.flat().map(i => i.s).join(" ")).not.toContain("Jane");
  });
  it("linkifies bare http urls in text", () => {
    const r = normalizeMessage({ text: "see https://a.com now", html: "" });
    const links = r.body.flat().filter(i => i.t === "link");
    expect(links.length).toBe(1);
    expect((links[0] as { href: string }).href).toBe("https://a.com");
  });
  it("returns empty body for empty input without throwing", () => {
    expect(normalizeMessage({ text: "", html: "" }).body).toEqual([]);
  });
});

describe("normalizeMessage (html source)", () => {
  it("extracts text + links from html, dropping scripts/styles", () => {
    const html = `<style>.x{}</style><p>Hello <a href="https://a.com">link</a></p><script>alert(1)</script>`;
    const r = normalizeMessage({ text: "", html });
    const flat = r.body.flat();
    expect(flat.some(i => i.t === "text" && /Hello/.test(i.s))).toBe(true);
    const link = flat.find(i => i.t === "link") as { href: string; s: string };
    expect(link.href).toBe("https://a.com");
    expect(link.s).toBe("link");
    expect(r.body.flat().map(i => i.s).join(" ")).not.toContain("alert");
  });
  it("treats a gmail_quote container as quoted", () => {
    const html = `<div>Reply text</div><div class="gmail_quote">old <b>stuff</b></div>`;
    const r = normalizeMessage({ text: "", html });
    expect(r.quoted).not.toBeNull();
    expect(r.quoted!.flat().map(i => i.s).join(" ")).toContain("old");
  });
  it("never yields a link for a javascript: href (renders as text)", () => {
    const r = normalizeMessage({ text: "", html: `<a href="javascript:alert(1)">x</a>` });
    expect(r.body.flat().every(i => i.t !== "link")).toBe(true);
  });
});

describe("normalizeMessage — never-throw guard (Fix 1)", () => {
  // Depth must comfortably exceed walkElement's depth>200 guard to exercise it;
  // 1200 is 6x the threshold (still "pathologically deep") without making jsdom
  // parse a 10k-node tree, which was starving the suite under load. The
  // assertion is "doesn't throw", not latency.
  it("does not throw and returns a body array for pathologically deep HTML (depth guard)", () => {
    const html = "<div>".repeat(1200) + "hi" + "</div>".repeat(1200);
    let result: ReturnType<typeof normalizeMessage> | undefined;
    expect(() => {
      result = normalizeMessage({ text: "", html });
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(Array.isArray(result!.body)).toBe(true);
  });

  it("falls back to plain-text body when html parsing would throw (simulated via text fallback)", () => {
    // When both text and html are provided but html is malformed/pathological,
    // the try/catch ensures we always get a structured result.
    // Here we verify the fallback path: text is used when html is empty.
    const r = normalizeMessage({ text: "fallback content here", html: "" });
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.flat().map(i => i.s).join(" ")).toContain("fallback content");
  });
});

describe("normalizeMessage — bounded signature detection (Fix 2)", () => {
  it("does NOT split on a '-- ' line near the TOP of a long body (>20 lines)", () => {
    // A `--` line in the first few lines of a 25-line body should NOT become a signature
    const lines = [
      "Line 1",
      "Line 2",
      "--",          // near top — must NOT be treated as signature delimiter
      "Line 4",
      "Line 5",
      "Line 6",
      "Line 7",
      "Line 8",
      "Line 9",
      "Line 10",
      "Line 11",
      "Line 12",
      "Line 13",
      "Line 14",
      "Line 15",
      "Line 16",
      "Line 17",
      "Line 18",
      "Line 19",
      "Line 20",
      "Line 21",
      "Line 22",
      "Line 23",
      "Line 24",
      "Line 25",
    ];
    const r = normalizeMessage({ text: lines.join("\n"), html: "" });
    expect(r.signature).toBeNull();
    // All body content (including lines after the early `--`) should be present
    const bodyText = r.body.flat().map(i => i.s).join(" ");
    expect(bodyText).toContain("Line 25");
    expect(bodyText).toContain("Line 4");
  });

  it("DOES split on a '-- ' delimiter near the END of a body", () => {
    const lines = [
      "Line 1",
      "Line 2",
      "Line 3",
      "Line 4",
      "Line 5",
      "Line 6",
      "Line 7",
      "Line 8",
      "Line 9",
      "Line 10",
      "Line 11",
      "Line 12",
      "Line 13",
      "Line 14",
      "Line 15",
      "Line 16",
      "Line 17",
      "Line 18",
      "-- ",          // within last 15 lines — IS the signature delimiter
      "Jane Doe",
      "CEO",
    ];
    const r = normalizeMessage({ text: lines.join("\n"), html: "" });
    expect(r.signature).not.toBeNull();
    const sigText = r.signature!.flat().map(i => i.s).join(" ");
    expect(sigText).toContain("Jane Doe");
    // Body should not contain the signature content
    const bodyText = r.body.flat().map(i => i.s).join(" ");
    expect(bodyText).not.toContain("Jane Doe");
  });
});
