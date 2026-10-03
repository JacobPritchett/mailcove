// The Authentication-Results value our boundary MX writes still contains text
// the SENDER chose: the envelope sender appears in the SPF comment and in
// smtp.mailfrom=, and "=" is legal in a local part. A verdict must therefore be
// read from the structure of the header, never found by searching it.
import { describe, it, expect } from "vitest";
import { authVerdicts, trustedAuthVerdicts, TRUSTED_AUTHSERV_ID } from "../authResults";
import { parseAuthResults, dmarcPassFromHeaders } from "../index";
import { makeSqliteEnv, deliver } from "./sqlite_env";

const GENUINE_PASS =
  "mx.cloudflare.net; dkim=pass header.d=example.com header.s=sel header.b=abc123; " +
  "dmarc=pass header.from=example.com policy.dmarc=reject; " +
  "spf=pass (mx.cloudflare.net: domain of bounce@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@example.com smtp.helo=out.example.com";

const MAILFROM_FORGERY =
  "mx.cloudflare.net; dkim=none; dmarc=fail header.from=example.com policy.dmarc=reject; " +
  "spf=pass (mx.cloudflare.net: domain of dmarc=pass@evil.com designates 203.0.113.9 as permitted sender) smtp.mailfrom=dmarc=pass@evil.com";

describe("authVerdicts", () => {
  it("reads a genuine Cloudflare-style pass", () => {
    expect(authVerdicts(GENUINE_PASS)).toEqual({ authservId: "mx.cloudflare.net", spf: "pass", dkim: "pass", dmarc: "pass" });
  });

  it("is not fooled by an envelope sender named dmarc=pass@evil.com", () => {
    expect(authVerdicts(MAILFROM_FORGERY)).toMatchObject({ spf: "pass", dkim: "none", dmarc: "fail" });
    expect(parseAuthResults(MAILFROM_FORGERY)).toBe(0);
  });

  it("ignores a forged pass inside a comment, including a nested one", () => {
    expect(authVerdicts("mx; dmarc=fail (dmarc=pass) header.from=x.com").dmarc).toBe("fail");
    expect(authVerdicts("mx; spf=pass (a (b; dmarc=pass; c) d); dmarc=none").dmarc).toBe("none");
    expect(authVerdicts("mx; (dmarc=pass) dkim=fail").dmarc).toBe("none");
  });

  it("ignores a forged pass inside a quoted string, including an escaped quote", () => {
    expect(authVerdicts('mx; spf=pass smtp.mailfrom="a; dmarc=pass"@evil.com; dmarc=fail').dmarc).toBe("fail");
    expect(authVerdicts('mx; spf=pass smtp.mailfrom="a\\"; dmarc=pass; \\""@evil.com').dmarc).toBe("none");
  });

  it("reads the method only from the start of a segment", () => {
    expect(authVerdicts("mx; dmarc=fail header.from=x.com reason=dmarc=pass").dmarc).toBe("fail");
    expect(authVerdicts("mx; spf=pass smtp.mailfrom=dmarc=pass").dmarc).toBe("none");
    expect(authVerdicts("mx; x-dmarc=pass").dmarc).toBe("none");
    expect(authVerdicts("mx; notdmarc=pass").dmarc).toBe("none");
  });

  it("requires the result to end at a word boundary that is not part of an address", () => {
    // An unquoted ";" smuggled through smtp.mailfrom would start a new segment.
    expect(authVerdicts("mx; spf=pass smtp.mailfrom=a; dmarc=pass@evil.com").dmarc).toBe("none");
    expect(authVerdicts("mx; dmarc=passed").dmarc).toBe("none");
    expect(authVerdicts("mx; dmarc=pass.").dmarc).toBe("none");
  });

  it("does not let a second dmarc result upgrade the first", () => {
    expect(authVerdicts("mx; dmarc=fail; dmarc=pass").dmarc).toBe("fail");
    expect(authVerdicts("mx; dmarc=none; dmarc=pass").dmarc).toBe("none");
    expect(authVerdicts("mx; dmarc=pass; dmarc=pass").dmarc).toBe("pass");
  });

  it("never treats the authserv-id as a result", () => {
    expect(authVerdicts("dmarc=pass").dmarc).toBe("none");
    expect(authVerdicts("dmarc=pass; spf=fail").dmarc).toBe("none");
  });

  it("handles mixed case and odd whitespace", () => {
    expect(authVerdicts("MX.Example ;\r\n\t DMARC = Pass header.from=x.com ;\tSPF=SoftFail;  DKIM\t=\tPASS")).toEqual({
      authservId: "mx.example", spf: "fail", dkim: "pass", dmarc: "pass",
    });
  });

  it("maps results: pass, the failing family, and everything else to none", () => {
    for (const r of ["fail", "softfail", "permerror", "policy"]) expect(authVerdicts(`mx; spf=${r}`).spf).toBe("fail");
    for (const r of ["none", "neutral", "temperror", "bestguesspass", "unknown"]) expect(authVerdicts(`mx; spf=${r}`).spf).toBe("none");
    expect(authVerdicts("mx; spf=pass").spf).toBe("pass");
  });

  it("dkim passes when any signature passes", () => {
    expect(authVerdicts("mx; dkim=fail header.d=a.com; dkim=pass header.d=b.com; dkim=none").dkim).toBe("pass");
    expect(authVerdicts("mx; dkim=fail header.d=a.com; dkim=none").dkim).toBe("fail");
    expect(authVerdicts("mx; dkim=none").dkim).toBe("none");
  });

  it("is none across the board for missing or empty input", () => {
    const none = { spf: "none", dkim: "none", dmarc: "none" };
    expect(authVerdicts(null)).toEqual({ authservId: "", ...none });
    expect(authVerdicts(undefined)).toEqual({ authservId: "", ...none });
    expect(authVerdicts("")).toEqual({ authservId: "", ...none });
    expect(authVerdicts("mx.cloudflare.net; none")).toEqual({ authservId: "mx.cloudflare.net", ...none });
  });

  it("spf passes when any of several results passes (HELO and MAIL FROM)", () => {
    expect(authVerdicts("mx; spf=none smtp.helo=h.example; spf=pass smtp.mailfrom=a@b.example").spf).toBe("pass");
    expect(authVerdicts("mx; spf=none smtp.helo=h.example; spf=softfail smtp.mailfrom=a@b.example").spf).toBe("fail");
    expect(authVerdicts("mx; spf=none; spf=neutral").spf).toBe("none");
  });

  it("reports the authserv-id, lowercased, without its version", () => {
    expect(authVerdicts("MX.Cloudflare.NET; dmarc=pass").authservId).toBe("mx.cloudflare.net");
    expect(authVerdicts("mx.microsoft.com 1; dmarc=pass").authservId).toBe("mx.microsoft.com");
    expect(authVerdicts("  (comment) mx.google.com ; dmarc=pass").authservId).toBe("mx.google.com");
    expect(authVerdicts("; dmarc=pass").authservId).toBe("");
  });

  it("an unterminated comment or quote hides everything after it", () => {
    expect(authVerdicts("mx; spf=pass (never closed; dmarc=pass").dmarc).toBe("none");
    expect(authVerdicts('mx; spf=pass "never closed; dmarc=pass').dmarc).toBe("none");
  });

  it("handles a 1 MB hostile value quickly", () => {
    const MB = 1_000_000;
    const hostile = [
      "mx; " + "(".repeat(MB),
      "mx; " + "()".repeat(MB / 2),
      "mx; " + "(".repeat(MB / 2) + ")".repeat(MB / 2) + "; dmarc=pass",
      'mx; "' + "a".repeat(MB),
      "mx; " + '"\\'.repeat(MB / 2),
      "mx; " + ";".repeat(MB),
      "mx; " + "dmarc=".repeat(MB / 6),
      "mx; " + "dmarc = ".repeat(MB / 8),
      "mx;" + " ".repeat(MB) + "dmarc=pass",
      "\\".repeat(MB),
    ];
    const start = performance.now();
    for (const h of hostile) expect(authVerdicts(h).dmarc).toBe("none");
    expect(performance.now() - start).toBeLessThan(100);
  });
});

// The shape Cloudflare Email Routing actually stamps: several dkim results,
// SPF for both HELO and MAIL FROM, an arc result, a quoted property value.
const REAL_SHAPE =
  "mx.cloudflare.net; dkim=pass header.d=example.com header.s=s1 header.b=AbCdEf12; " +
  "dkim=fail header.d=list.example.net header.s=k2 header.b=Zz90Yy81; " +
  "dmarc=pass header.from=example.com policy.dmarc=quarantine; " +
  "spf=none (mx.cloudflare.net: no SPF records found for postmaster@out-7.example.com) smtp.helo=out-7.example.com; " +
  "spf=pass (mx.cloudflare.net: domain of bounces+42=me@example.com designates 198.51.100.7 as permitted sender) smtp.mailfrom=bounces+42=me@example.com; " +
  'arc=pass smtp.remote-ip="198.51.100.7"';
const GOOGLE = "mx.google.com; dkim=pass header.i=@example.com header.s=s1; spf=pass smtp.mailfrom=a@example.com; dmarc=pass (p=REJECT) header.from=example.com";
const MICROSOFT = "mx.microsoft.com 1; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass action=none header.from=example.com";

describe("trusting only the boundary MX", () => {
  it("reads the real Cloudflare shape", () => {
    expect(authVerdicts(REAL_SHAPE)).toEqual({ authservId: TRUSTED_AUTHSERV_ID, spf: "pass", dkim: "pass", dmarc: "pass" });
    expect(trustedAuthVerdicts(REAL_SHAPE).dmarc).toBe("pass");
    expect(parseAuthResults(REAL_SHAPE)).toBe(1);
  });

  it("gives another host's header no verdicts, whatever it says", () => {
    expect(authVerdicts(GOOGLE).dmarc).toBe("pass"); // that is what it says
    expect(trustedAuthVerdicts(GOOGLE)).toEqual({ authservId: "mx.google.com", spf: "none", dkim: "none", dmarc: "none" });
    expect(parseAuthResults(GOOGLE)).toBe(0);
    expect(parseAuthResults(MICROSOFT)).toBe(0);
    expect(parseAuthResults("mx.cloudflare.net.evil.example; dmarc=pass")).toBe(0);
    expect(parseAuthResults("evil.example mx.cloudflare.net; dmarc=pass")).toBe(0);
    expect(parseAuthResults("(mx.cloudflare.net) evil.example; dmarc=pass")).toBe(0);
  });

  it("does not trust the topmost header when the boundary one is absent", () => {
    expect(dmarcPassFromHeaders([{ key: "authentication-results", value: GOOGLE }])).toBe(0);
    expect(dmarcPassFromHeaders([
      { key: "authentication-results", value: GOOGLE },
      { key: "authentication-results", value: REAL_SHAPE }, // not first, so not ours either
    ])).toBe(0);
  });

  it("trusts the boundary header on forwarded mail that carries older ones below it", () => {
    expect(dmarcPassFromHeaders([
      { key: "received", value: "by mx.cloudflare.net" },
      { key: "authentication-results", value: REAL_SHAPE },
      { key: "authentication-results", value: GOOGLE },
      { key: "authentication-results", value: MICROSOFT },
    ])).toBe(1);
    expect(dmarcPassFromHeaders([
      { key: "authentication-results", value: "mx.cloudflare.net; dmarc=fail header.from=example.com; spf=pass smtp.mailfrom=x@fwd.example" },
      { key: "authentication-results", value: GOOGLE },
    ])).toBe(0);
  });
});

describe("dmarc_pass at ingest", () => {
  const raw = (auth: string[]) =>
    [
      ...auth.map((a) => `Authentication-Results: ${a}`),
      "From: Hello <hello@example.com>",
      "To: me@example.com",
      "Subject: s",
      "Message-ID: <x@evil.com>",
      "Content-Type: text/plain",
      "",
      "body",
      "",
    ].join("\r\n");
  const stored = async (auth: string[]) => {
    const t = await makeSqliteEnv();
    await deliver(t.env, raw(auth));
    return (t.db.prepare(`SELECT dmarc_pass FROM messages`).get() as { dmarc_pass: number }).dmarc_pass;
  };

  it("stores 0 for the mailfrom forgery, through the real handler", async () => {
    expect(await stored([MAILFROM_FORGERY])).toBe(0);
  });
  it("stores 1 for a genuine pass", async () => {
    expect(await stored([GENUINE_PASS])).toBe(1);
  });
  it("stores 0 when the only Authentication-Results header is another host's", async () => {
    expect(await stored([GOOGLE])).toBe(0);
  });
  it("stores 1 for the real Cloudflare shape above a forwarded Google header", async () => {
    expect(await stored([REAL_SHAPE, GOOGLE])).toBe(1);
  });
  it("honours only the first header", async () => {
    expect(await stored(["mx.cloudflare.net; dmarc=fail header.from=example.com", GENUINE_PASS])).toBe(0);
    expect(dmarcPassFromHeaders([
      { key: "authentication-results", value: "mx.cloudflare.net; dmarc=fail" },
      { key: "authentication-results", value: "mx.cloudflare.net; dmarc=pass" },
    ])).toBe(0);
  });
});
