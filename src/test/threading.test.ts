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
