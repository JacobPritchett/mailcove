import { describe, it, expect } from "vitest";
import { deriveThreadId, sanitizeMessageId } from "../threading";

describe("sanitizeMessageId", () => {
  it("rejects a value containing CR/LF (header injection)", () => {
    expect(sanitizeMessageId("<a>\r\nBcc: evil@x")).toBeNull();
  });

  it("rejects empty / whitespace-only values", () => {
    expect(sanitizeMessageId("")).toBeNull();
    expect(sanitizeMessageId("   ")).toBeNull();
    expect(sanitizeMessageId(undefined)).toBeNull();
    expect(sanitizeMessageId(null)).toBeNull();
  });

  it("accepts a well-formed <id@host> token", () => {
    expect(sanitizeMessageId("<id@host>")).toBe("<id@host>");
  });

  it("wraps a bare token in angle brackets", () => {
    expect(sanitizeMessageId("id@host")).toBe("<id@host>");
  });

  it("rejects a value with internal spaces", () => {
    expect(sanitizeMessageId("<id @host>")).toBeNull();
    expect(sanitizeMessageId("<a> <b>")).toBeNull();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(sanitizeMessageId("  <id@host>  ")).toBe("<id@host>");
  });

  it("rejects other control characters (tab, NUL)", () => {
    expect(sanitizeMessageId("<id\thost>")).toBeNull();
    expect(sanitizeMessageId("<id@host >")).toBeNull();
  });
});

describe("deriveThreadId", () => {
  it("returns the FIRST message-id from References (the thread root)", () => {
    expect(
      deriveThreadId(
        { references: "<root@a.com> <mid2@a.com>" },
        "fallback",
      ),
    ).toBe("root@a.com");
  });

  it("accepts References as a string array", () => {
    expect(
      deriveThreadId(
        { references: ["<root@a.com>", "<mid2@a.com>"] },
        "fallback",
      ),
    ).toBe("root@a.com");
  });

  it("splits whitespace-joined ids inside an array element (root first)", () => {
    expect(
      deriveThreadId(
        { references: ["<root@a.com> <mid@a.com>"] },
        "fallback",
      ),
    ).toBe("root@a.com");
  });

  it("strips angle brackets and whitespace from the References root", () => {
    expect(
      deriveThreadId({ references: "  <root@a.com>  " }, "fallback"),
    ).toBe("root@a.com");
  });

  it("falls back to In-Reply-To when References is absent", () => {
    expect(
      deriveThreadId({ inReplyTo: "<parent@a.com>" }, "fallback"),
    ).toBe("parent@a.com");
  });

  it("falls back to Message-ID when neither References nor In-Reply-To present", () => {
    expect(
      deriveThreadId({ messageId: "<self@a.com>" }, "fallback"),
    ).toBe("self@a.com");
  });

  it("uses the fallback id when nothing is present", () => {
    expect(deriveThreadId({}, "fallback-uuid")).toBe("fallback-uuid");
  });

  it("uses the fallback id when fields are empty strings", () => {
    expect(
      deriveThreadId(
        { references: "", inReplyTo: "", messageId: "" },
        "fallback-uuid",
      ),
    ).toBe("fallback-uuid");
  });

  it("prefers References root over In-Reply-To and Message-ID", () => {
    expect(
      deriveThreadId(
        {
          references: "<root@a.com> <p@a.com>",
          inReplyTo: "<p@a.com>",
          messageId: "<self@a.com>",
        },
        "fallback",
      ),
    ).toBe("root@a.com");
  });
});

// A thread id becomes a path segment (/api/threads/:id) and a push tag, and it
// comes straight from headers the sender wrote.
describe("deriveThreadId rejects ids that cannot be addressed", () => {
  it("skips a dot-only References root (URL normalization would eat it)", () => {
    expect(deriveThreadId({ references: "<.> <real@a.com>" }, "fallback")).toBe("real@a.com");
    expect(deriveThreadId({ references: "<..>", inReplyTo: "<parent@a.com>" }, "fallback")).toBe("parent@a.com");
    expect(deriveThreadId({ messageId: "<..>" }, "fallback-uuid")).toBe("fallback-uuid");
    expect(deriveThreadId({ messageId: "..." }, "fallback-uuid")).toBe("fallback-uuid");
  });

  it("keeps ids containing a slash or backslash (real Message-IDs have them)", () => {
    // Rejecting these would split every later reply off threads already stored
    // under such an id; percent-encoding carries them through the route intact.
    expect(deriveThreadId({ references: "<a/b@x.com> <ok@x.com>" }, "fallback")).toBe("a/b@x.com");
    expect(deriveThreadId({ messageId: "<a\\b@x.com>" }, "fallback-uuid")).toBe("a\\b@x.com");
    expect(deriveThreadId({ inReplyTo: "<../../api/me>", messageId: "<self@x.com>" }, "fallback")).toBe("../../api/me");
  });

  it("skips ids containing control characters or whitespace", () => {
    expect(deriveThreadId({ inReplyTo: "<a\u0000b@x.com>", messageId: "<self@x.com>" }, "fallback")).toBe("self@x.com");
    expect(deriveThreadId({ inReplyTo: "<a b@x.com>", messageId: "<self@x.com>" }, "fallback")).toBe("self@x.com");
    expect(deriveThreadId({ messageId: "<a\u007fb@x.com>" }, "fallback-uuid")).toBe("fallback-uuid");
    expect(deriveThreadId({ messageId: "<a\u0085b@x.com>" }, "fallback-uuid")).toBe("fallback-uuid");
  });

  it("skips an id that is too long to be a real Message-ID", () => {
    const long = `<${"a".repeat(2000)}@x.com>`;
    expect(deriveThreadId({ references: `${long} <ok@x.com>` }, "fallback")).toBe("ok@x.com");
    expect(deriveThreadId({ messageId: long }, "fallback-uuid")).toBe("fallback-uuid");
  });

  it("skips an id that cannot survive encodeURIComponent (lone surrogate)", () => {
    expect(deriveThreadId({ messageId: "<a\ud800b@x.com>" }, "fallback-uuid")).toBe("fallback-uuid");
  });

  it("every id it returns round-trips through a URL path segment", () => {
    for (const messageId of ["<simple@a.com>", "<we?ird#id%2F+x=@a.com>", "<é中@a.com>", "<a.b..c@a.com>"]) {
      const id = deriveThreadId({ messageId }, "fallback");
      expect(id).not.toBe("fallback");
      const url = new URL(`https://inbox.example/api/threads/${encodeURIComponent(id)}`);
      const segment = url.pathname.match(/^\/api\/threads\/([^/]+)$/)?.[1];
      expect(segment && decodeURIComponent(segment)).toBe(id);
    }
  });

  it("stays fast on a hostile header", () => {
    const hostile = [">".repeat(200_000) + "x", "<".repeat(200_000), " ".repeat(200_000), "<a@b> ".repeat(40_000)];
    const start = performance.now();
    for (const h of hostile) {
      deriveThreadId({ references: h, inReplyTo: h, messageId: h }, "fallback");
    }
    expect(performance.now() - start).toBeLessThan(500);
  });
});
