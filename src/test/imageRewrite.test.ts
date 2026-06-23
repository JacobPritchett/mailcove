import { describe, it, expect } from "vitest";
import { parseSrcset, serializeSrcset, classifySrc, isValidSrcsetDescriptor, rewriteEmailImages, type RewriteCtx } from "../imageRewrite";

describe("parseSrcset", () => {
  it("parses url + descriptor candidates", () => {
    expect(parseSrcset("a.png 1x, b.png 2x")).toEqual([
      { url: "a.png", descriptor: "1x" },
      { url: "b.png", descriptor: "2x" },
    ]);
  });
  it("handles width descriptors and extra whitespace", () => {
    expect(parseSrcset("  https://x/a.png 320w ,  https://x/b.png 640w ")).toEqual([
      { url: "https://x/a.png", descriptor: "320w" },
      { url: "https://x/b.png", descriptor: "640w" },
    ]);
  });
  it("keeps commas inside data URLs intact", () => {
    const out = parseSrcset("data:image/png;base64,AAA,BBB 1x");
    expect(out).toEqual([{ url: "data:image/png;base64,AAA,BBB", descriptor: "1x" }]);
  });
  it("round-trips via serializeSrcset", () => {
    const s = "a.png 1x, b.png 2x";
    expect(serializeSrcset(parseSrcset(s))).toBe(s);
  });
  it("ends a data URL at a tab and splits the next candidate", () => {
    expect(parseSrcset("data:image/png;base64,ABC\t1x, next.png 2x")).toEqual([
      { url: "data:image/png;base64,ABC", descriptor: "1x" },
      { url: "next.png", descriptor: "2x" },
    ]);
  });
});

describe("isValidSrcsetDescriptor", () => {
  it("accepts empty string", () => expect(isValidSrcsetDescriptor("")).toBe(true));
  it("accepts density descriptors like '2x' and '1.5x'", () => {
    expect(isValidSrcsetDescriptor("2x")).toBe(true);
    expect(isValidSrcsetDescriptor("1.5x")).toBe(true);
  });
  it("accepts width descriptor like '320w'", () => expect(isValidSrcsetDescriptor("320w")).toBe(true));
  it("rejects a smuggled URL token", () =>
    expect(isValidSrcsetDescriptor("https://x 2x")).toBe(false));
  it("rejects multiple dimension descriptors like '100w 200h'", () =>
    expect(isValidSrcsetDescriptor("100w 200h")).toBe(false));
  it("rejects arbitrary junk", () => expect(isValidSrcsetDescriptor("junk")).toBe(false));
});

describe("classifySrc", () => {
  it("classifies cid (normalized)", () => {
    expect(classifySrc("cid:<Logo@X>")).toEqual({ kind: "cid", cid: "logo@x" });
  });
  it("classifies http(s) as remote", () => {
    expect(classifySrc("https://cdn.test/a.png")).toEqual({ kind: "remote", url: "https://cdn.test/a.png" });
  });
  it("keeps data:image/png, drops data:image/svg+xml", () => {
    expect(classifySrc("data:image/png;base64,AAAA").kind).toBe("data");
    expect(classifySrc("data:image/svg+xml;base64,PHN2Zz4=").kind).toBe("drop");
  });
  it("drops relative/unknown schemes", () => {
    expect(classifySrc("/local.png").kind).toBe("drop");
    expect(classifySrc("javascript:alert(1)").kind).toBe("drop");
  });
});

function ctx(over: Partial<RewriteCtx> = {}): RewriteCtx {
  return {
    cidToToken: async (cid) => (cid === "logo" ? "/api/media?t=CIDTOK" : null),
    remoteToToken: async (url) => `/api/media?t=R(${url})`,
    showRemote: false,
    ...over,
  };
}

// [skipIf-gated] HTMLRewriter is workerd-only; node reports these as skipped.
describe.skipIf(typeof HTMLRewriter === "undefined")("rewriteEmailImages", () => {
  it("resolves a cid: image to its media token", async () => {
    const r = await rewriteEmailImages(`<img src="cid:logo">`, ctx());
    expect(r.html).toContain(`src="/api/media?t=CIDTOK"`);
    expect(r.blockedRemoteCount).toBe(0);
  });

  it("strips a remote image when blocked and counts it", async () => {
    const r = await rewriteEmailImages(`<img src="https://t.test/p.gif">`, ctx({ showRemote: false }));
    expect(r.html).not.toContain("t.test");
    expect(r.blockedRemoteCount).toBe(1);
  });

  it("proxies a remote image when shown", async () => {
    const r = await rewriteEmailImages(`<img src="https://cdn.test/a.png">`, ctx({ showRemote: true }));
    expect(r.html).toContain(`/api/media?t=R(https://cdn.test/a.png)`);
    expect(r.blockedRemoteCount).toBe(0);
  });

  it("rewrites every srcset candidate and strips <base>", async () => {
    const r = await rewriteEmailImages(
      `<base href="https://evil.test/"><img srcset="https://cdn.test/a.png 1x, https://cdn.test/b.png 2x">`,
      ctx({ showRemote: true }),
    );
    expect(r.html).not.toContain("<base");
    expect(r.html).toContain("R(https://cdn.test/a.png)");
    expect(r.html).toContain("R(https://cdn.test/b.png)");
  });

  it("strips a data:image/svg+xml src but keeps data:image/png", async () => {
    const png = await rewriteEmailImages(`<img src="data:image/png;base64,AAAA">`, ctx());
    expect(png.html).toContain("data:image/png;base64,AAAA");
    const svg = await rewriteEmailImages(`<img src="data:image/svg+xml;base64,PHN2Zz4=">`, ctx());
    expect(svg.html).not.toContain("svg+xml");
  });
});
