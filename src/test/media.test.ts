import { describe, it, expect } from "vitest";
import { mintMediaToken, verifyMediaToken, type MediaPayload } from "../media";
import { validateRemoteUrl } from "../media";
import { proxyRemoteImage, RASTER_TYPES } from "../media";

const SECRET = "test-secret-0123456789";
const base: Omit<MediaPayload, "exp"> = { v: 1, kid: "k1", kind: "remote", m: "msg1", ref: "https://x.test/a.png" };

describe("media token", () => {
  it("round-trips a valid token", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const tok = await mintMediaToken(SECRET, { ...base, exp });
    const got = await verifyMediaToken(SECRET, tok);
    expect(got).toEqual({ ...base, exp });
  });

  it("rejects a tampered payload", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const tok = await mintMediaToken(SECRET, { ...base, exp });
    const [p, s] = tok.split(".");
    const forged = `${p}x.${s}`;
    expect(await verifyMediaToken(SECRET, forged)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const exp = Math.floor(Date.now() / 1000) - 1;
    const tok = await mintMediaToken(SECRET, { ...base, exp });
    expect(await verifyMediaToken(SECRET, tok)).toBeNull();
  });

  it("rejects a wrong-key signature", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const tok = await mintMediaToken(SECRET, { ...base, exp });
    expect(await verifyMediaToken("other-secret", tok)).toBeNull();
  });

  it("rejects an unknown kid", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const tok = await mintMediaToken(SECRET, { ...base, kid: "kX", exp });
    expect(await verifyMediaToken(SECRET, tok)).toBeNull();
  });

  it("rejects a token with no dot separator", async () => {
    expect(await verifyMediaToken(SECRET, "justonestring")).toBeNull();
  });

  it("rejects a token with wrong version (v: 2)", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const tok = await mintMediaToken(SECRET, { ...base, v: 2 as any, exp });
    expect(await verifyMediaToken(SECRET, tok)).toBeNull();
  });

  it("rejects a token with invalid kind", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const tok = await mintMediaToken(SECRET, { ...base, kind: "evil" as any, exp });
    expect(await verifyMediaToken(SECRET, tok)).toBeNull();
  });
});

describe("validateRemoteUrl", () => {
  it("accepts a normal public https URL", () => {
    expect(validateRemoteUrl("https://cdn.example.com/a.png")?.hostname).toBe("cdn.example.com");
  });
  it("accepts http", () => {
    expect(validateRemoteUrl("http://example.com/x")).not.toBeNull();
  });
  it.each([
    "ftp://example.com/x",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "https://user:pass@example.com/x",     // userinfo
    "https://127.0.0.1/x",
    "https://localhost/x",
    "https://10.0.0.5/x",
    "https://192.168.1.1/x",
    "https://172.16.0.1/x",
    "https://169.254.169.254/latest/meta-data", // cloud metadata
    "https://100.64.0.1/x",                // CGNAT
    "https://0.0.0.0/x",
    "https://[::1]/x",
    "https://[fe80::1]/x",
    "https://[fc00::1]/x",
    "https://2130706433/x",                // decimal IPv4 (127.0.0.1)
    "https://0x7f.0.0.1/x",                // hex octet
  ])("rejects %s", (u) => {
    expect(validateRemoteUrl(u)).toBeNull();
  });
});

function fetchReturning(status: number, headers: Record<string, string>, body: BodyInit = "") {
  return async () => new Response(body, { status, headers });
}

describe("proxyRemoteImage", () => {
  it("serves an allowed raster type with stripped headers + nosniff", async () => {
    const f = fetchReturning(200, { "content-type": "image/png", "set-cookie": "evil=1" }, new Uint8Array([1, 2, 3]));
    const res = await proxyRemoteImage("https://cdn.example.com/a.png", { fetchImpl: f });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a non-image content-type with 415", async () => {
    const f = fetchReturning(200, { "content-type": "text/html" }, "<script>");
    const res = await proxyRemoteImage("https://cdn.example.com/a", { fetchImpl: f });
    expect(res.status).toBe(415);
  });

  it("rejects svg", async () => {
    const f = fetchReturning(200, { "content-type": "image/svg+xml" }, "<svg/>");
    const res = await proxyRemoteImage("https://cdn.example.com/a.svg", { fetchImpl: f });
    expect(res.status).toBe(415);
  });

  it("returns 502 when upstream errors", async () => {
    const f = async () => { throw new Error("dns"); };
    const res = await proxyRemoteImage("https://cdn.example.com/a.png", { fetchImpl: f });
    expect(res.status).toBe(502);
  });

  it("revalidates redirects and blocks a redirect to a private host (502)", async () => {
    const f = async (input: string) =>
      input.includes("start")
        ? new Response("", { status: 302, headers: { location: "https://169.254.169.254/x" } })
        : new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png" } });
    const res = await proxyRemoteImage("https://cdn.example.com/start", { fetchImpl: f });
    expect(res.status).toBe(502);
  });

  it("rejects an over-cap body via declared content-length (502)", async () => {
    const f = fetchReturning(200, { "content-type": "image/png", "content-length": "11" }, new Uint8Array(11));
    const res = await proxyRemoteImage("https://cdn.example.com/a.png", { fetchImpl: f, maxBytes: 10 });
    expect(res.status).toBe(502);
  });

  it("caps an over-size STREAMED body with no content-length (502)", async () => {
    // No content-length header (streamed body) → the declared pre-check is
    // skipped, so this exercises the in-function buffered streaming cap (the
    // slow/oversize-body DoS guard), which must still 502.
    const f = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(new Uint8Array(20)); c.close(); },
        }),
        { status: 200, headers: { "content-type": "image/png" } },
      );
    const res = await proxyRemoteImage("https://cdn.example.com/a.png", { fetchImpl: f, maxBytes: 10 });
    expect(res.status).toBe(502);
  });
});
