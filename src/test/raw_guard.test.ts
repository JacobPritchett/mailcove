import { describe, it, expect } from "vitest";
import PostalMime from "postal-mime";
import { boundAddressHeaders, rawHeader, MAX_ADDRESS_HEADER_BYTES } from "../rawGuard";
import { makeSqliteEnv, deliver, api } from "./sqlite_env";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);
const many = (n: number) => Array.from({ length: n }, (_, i) => `user${i}@example.com`).join(", ");

describe("boundAddressHeaders", () => {
  it("returns the same buffer when nothing is over the cap", () => {
    const raw = enc(`From: a@example.com\r\nTo: ${many(20)}\r\nSubject: hi\r\n\r\nbody`);
    expect(boundAddressHeaders(raw)).toBe(raw);
  });

  it("cuts an over-long address header at a comma and leaves everything else alone", () => {
    const raw = enc(`From: a@example.com\r\nTo: ${many(20_000)}\r\nSubject: kept\r\nX-Long: ${"x".repeat(50_000)}\r\n\r\nbody, with, commas`);
    const out = dec(boundAddressHeaders(raw));
    const to = out.split("\r\n").find((l) => l.startsWith("To:"))!;
    expect(to.length).toBeLessThanOrEqual(MAX_ADDRESS_HEADER_BYTES);
    expect(to.endsWith("@example.com")).toBe(true);
    expect(out).toContain("\r\nSubject: kept\r\n");
    expect(out).toContain(`X-Long: ${"x".repeat(50_000)}`);
    expect(out.endsWith("\r\n\r\nbody, with, commas")).toBe(true);
  });

  it("handles folded headers, bare LF line endings and several long fields", () => {
    const folded = Array.from({ length: 4000 }, (_, i) => `u${i}@example.com`).join(",\n ");
    const raw = enc(`From: a@example.com\nCc: ${folded}\nReply-To: ${many(5000)}\nSubject: s\n\nbody`);
    const out = dec(boundAddressHeaders(raw));
    expect(out.length).toBeLessThan(3 * MAX_ADDRESS_HEADER_BYTES);
    expect(out).toContain("\nSubject: s\n\nbody");
  });

  it("never touches the body, however it looks", () => {
    const body = `To: ${many(5000)}`;
    const raw = enc(`From: a@example.com\r\nSubject: s\r\n\r\n${body}`);
    expect(boundAddressHeaders(raw)).toBe(raw);
  });

  it("is linear on a hostile header block", () => {
    const t0 = performance.now();
    boundAddressHeaders(enc(`To: ${",".repeat(400_000)}\r\n\r\nx`));
    boundAddressHeaders(enc(`To:${"\r\n ".repeat(100_000)}\r\n\r\nx`));
    boundAddressHeaders(enc("\n".repeat(400_000)));
    boundAddressHeaders(enc("To: " + "a".repeat(600_000)));
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("makes a pathological recipient list cheap to parse", async () => {
    // Address-less entries are the slow shape: unbounded, 100 KB of them costs
    // the parser about a second and 200 KB several (quadratic).
    const hostile = "a, ".repeat(70_000);
    const raw = enc(`From: a@example.com\r\nTo: ${hostile}\r\nCc: ${"g:;".repeat(70_000)}\r\nSubject: s\r\n\r\nbody`);
    const t0 = performance.now();
    const parsed = await PostalMime.parse(boundAddressHeaders(raw));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(parsed.subject).toBe("s");
  });

  it("keeps a long but ordinary recipient list readable", async () => {
    const raw = enc(`From: a@example.com\r\nTo: ${many(12_000)}\r\nSubject: s\r\n\r\nbody`);
    const parsed = await PostalMime.parse(boundAddressHeaders(raw));
    expect((parsed.to || []).length).toBeGreaterThan(100);
  });
});

describe("rawHeader", () => {
  it("reads an unfolded ASCII header and ignores the body", () => {
    const raw = enc("From: a@example.com\r\nSubject: hello\r\n there\r\n\r\nSubject: not this");
    expect(rawHeader(raw, "subject")).toBe("hello there");
    expect(rawHeader(raw, "x-missing")).toBe("");
  });
});

describe("a message the parser cannot read", () => {
  it("is still filed, labelled, and downloadable as the original", async () => {
    const t = await makeSqliteEnv();
    const raw = "From: Odd <odd@example.com>\r\nTo: me@example.com\r\nSubject: Broken thing\r\n\r\nbody";
    const original = PostalMime.parse;
    PostalMime.parse = (async () => { throw new Error("parser exploded"); }) as typeof PostalMime.parse;
    try {
      await deliver(t.env, raw);
    } finally {
      PostalMime.parse = original;
    }
    const row = t.db.prepare(`SELECT * FROM messages`).get() as Record<string, any>;
    expect(row).toBeDefined();
    expect(row.state).toBe("inbox");
    expect(row.subject).toBe("Broken thing");
    expect(row.snippet).toMatch(/could not be read/i);
    const thread = await api(t.env, "GET", `/api/threads/${encodeURIComponent(row.thread_id)}`);
    expect(thread.body.messages[0].body.text).toMatch(/Download the original/);
    const dl = await api(t.env, "GET", `/api/messages/${row.id}/raw`);
    expect(dl.body).toBe(raw);
  });
});
