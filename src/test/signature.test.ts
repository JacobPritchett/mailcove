import { describe, it, expect } from "vitest";
import { sanitizeSignature, MAX_SIGNATURE_CHARS, DOMAINS_DDL, getDomainRow } from "../domains";

describe("sanitizeSignature", () => {
  it("keeps an ordinary multi-line sign-off intact", () => {
    const sig = "Alex Rivera\nExample Co\nhttps://example.com";
    expect(sanitizeSignature(sig)).toBe(sig);
  });

  it("normalizes CRLF so the stored value is consistent", () => {
    expect(sanitizeSignature("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("strips control characters but keeps newlines and tabs", () => {
    // A signature is inherently multi-line, so newlines survive; NUL and the
    // other controls have no business in one.
    expect(sanitizeSignature("a\u0000b\u001fc\td\ne")).toBe("abc\td\ne");
  });

  it("collapses runaway blank lines", () => {
    expect(sanitizeSignature("a\n\n\n\n\n\nb")).toBe("a\n\n\nb");
  });

  it("trims trailing whitespace, which is invisible and accumulates", () => {
    expect(sanitizeSignature("Alex\n\n   ")).toBe("Alex");
  });

  it("caps the length", () => {
    expect(sanitizeSignature("x".repeat(5000))).toHaveLength(MAX_SIGNATURE_CHARS);
  });

  it("returns empty for nothing", () => {
    expect(sanitizeSignature("")).toBe("");
    expect(sanitizeSignature(null)).toBe("");
    expect(sanitizeSignature(undefined)).toBe("");
  });

  it("does not interpret markup - the value stays plain text", () => {
    // Seeded into the compose body; keeping it text means a stray tag can never
    // alter every message sent from the identity.
    const raw = '<b>bold</b> & <script>alert(1)</script>';
    expect(sanitizeSignature(raw)).toBe(raw);
  });
});

describe("the lazy-create DDL", () => {
  // ensureDomainsTable runs CREATE TABLE IF NOT EXISTS on a database with no
  // `domains` table. A column missing HERE means a fresh deployment builds the
  // old shape and every query naming that column fails - and IF NOT EXISTS will
  // never repair it afterwards. Migrations only fix databases that already
  // exist, so the two have to be kept in step by hand; this is that check.
  const required = [
    "domain",
    "zone_id",
    "sending_domain",
    "receive_mode",
    "forward_copy_to",
    "display_name",
    "signature",
    "created",
  ];

  for (const col of required) {
    it(`declares ${col}`, () => {
      expect(DOMAINS_DDL).toContain(col);
    });
  }
});

describe("getDomainRow reads the signature column", () => {
  it("names signature in its SELECT list", async () => {
    // The settings route returns row?.signature. If the projection omits it the
    // value is always undefined -> the UI shows an empty field and saving the
    // form clears a signature the user had already set. The existing settings
    // test cannot see this: its fake D1 returns the whole seeded object no
    // matter what the query asked for.
    let sql = "";
    const db = {
      prepare(q: string) {
        sql = q;
        return { bind: () => ({ first: async () => null }) };
      },
    } as unknown as D1Database;

    await getDomainRow({ DB: db }, "example.com");

    expect(sql).toContain("signature");
  });
});
