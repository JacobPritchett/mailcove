import { describe, it, expect } from "vitest";
import { handleFetch, type Env } from "../index";
import { mintMediaToken } from "../media";

const SECRET = "media-secret";
function makeEnv(r2Get?: (key: string) => any) {
  const r2 = { get: async (k: string) => (r2Get ? r2Get(k) : null) };
  return {
    DB: {} as unknown,
    MAILSTORE: r2 as unknown,
    IMG_PROXY_SECRET: SECRET,
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
  } as unknown as Env;
}
const ctx = {} as ExecutionContext;
const now = () => Math.floor(Date.now() / 1000);

describe("/api/media", () => {
  it("403s an invalid token WITHOUT needing an Access cookie", async () => {
    const env = makeEnv();
    const req = new Request("https://inbox.example.com/api/media?t=garbage");
    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(403);
  });

  it("serves a cid image from R2 (raster only)", async () => {
    const env = makeEnv((k) =>
      k === "att/msg1/p0" ? { body: new Uint8Array([1, 2]), httpMetadata: { contentType: "image/png" } } : null,
    );
    const t = await mintMediaToken(SECRET, { v: 1, kid: "k1", kind: "cid", m: "msg1", ref: "p0", exp: now() + 600 });
    const res = await handleFetch(new Request(`https://inbox.example.com/api/media?t=${t}`), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("415s a cid part that is not a raster type", async () => {
    const env = makeEnv((k) =>
      k === "att/msg1/p0" ? { body: "<svg/>", httpMetadata: { contentType: "image/svg+xml" } } : null,
    );
    const t = await mintMediaToken(SECRET, { v: 1, kid: "k1", kind: "cid", m: "msg1", ref: "p0", exp: now() + 600 });
    const res = await handleFetch(new Request(`https://inbox.example.com/api/media?t=${t}`), env, ctx);
    expect(res.status).toBe(415);
  });
});
