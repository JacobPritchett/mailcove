import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, base64url } from "jose";
import { verifyAccess, resetJwksCacheForTest } from "../auth";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const env: any = { ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com", ACCESS_AUD: "AUD123", AUTH_TOKEN: "secret" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))));
  const sign = (claims: any, key = privateKey, kid = "k1", exp = "1h") =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`)
      .setExpirationTime(exp)
      .sign(key);
  return { env, sign, otherKey: (await generateKeyPair("RS256")).privateKey };
}

describe("verifyAccess", () => {
  // Each test stubs its own JWKS; reset the module cache so the wrong-key /
  // wrong-aud cases exercise the real verification path, not a stale key.
  beforeEach(() => resetJwksCacheForTest());

  it("accepts a valid Access JWT and returns the email", async () => {
    const { env, sign } = await setup();
    const jwt = await sign({ email: "alex@example.com", aud: ["AUD123"] });
    const req = new Request("https://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    expect(await verifyAccess(req, env)).toBe("alex@example.com");
  });
  it("rejects a token signed by the wrong key", async () => {
    const { env, sign, otherKey } = await setup();
    const jwt = await sign({ email: "x@y.com", aud: ["AUD123"] }, otherKey);
    const req = new Request("https://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    expect(await verifyAccess(req, env)).toBeNull();
  });
  it("rejects a token with the wrong aud", async () => {
    const { env, sign } = await setup();
    const jwt = await sign({ email: "x@y.com", aud: ["OTHER"] });
    const req = new Request("https://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    expect(await verifyAccess(req, env)).toBeNull();
  });
  it("accepts a valid bearer AUTH_TOKEN fallback", async () => {
    const { env } = await setup();
    const req = new Request("https://x/api/me", { headers: { Authorization: "Bearer secret" } });
    expect(await verifyAccess(req, env)).toBe("api-token");
  });
  it("rejects when nothing is provided", async () => {
    const { env } = await setup();
    expect(await verifyAccess(new Request("https://x/api/me"), env)).toBeNull();
  });
  it("rejects an expired token", async () => {
    const { env, sign } = await setup();
    const jwt = await sign({ email: "alex@example.com", aud: ["AUD123"] }, undefined, "k1", "-1h");
    const req = new Request("https://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    expect(await verifyAccess(req, env)).toBeNull();
  });
  it("rejects an HS256 alg-confusion token", async () => {
    const { env } = await setup();
    // Attacker signs HS256 with a symmetric key instead of the RS256 keypair.
    const jwt = await new SignJWT({ email: "evil@y.com", aud: ["AUD123"] })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuedAt()
      .setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("secret-symmetric-key"));
    const req = new Request("https://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    expect(await verifyAccess(req, env)).toBeNull();
  });
  it("rejects an alg:none unsigned token", async () => {
    const { env } = await setup();
    // Hand-craft a JWT with alg:"none" and an empty signature.
    const header = base64url.encode(new TextEncoder().encode(JSON.stringify({ alg: "none", kid: "k1" })));
    const payload = base64url.encode(
      new TextEncoder().encode(
        JSON.stringify({
          email: "evil@y.com",
          aud: ["AUD123"],
          iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    );
    const jwt = `${header}.${payload}.`;
    const req = new Request("https://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    expect(await verifyAccess(req, env)).toBeNull();
  });
});
