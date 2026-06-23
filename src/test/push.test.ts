import { describe, it, expect } from "vitest";
import {
  encryptPayload,
  buildVapidJwt,
  bytesToB64url,
  b64urlToBytes,
  isAllowedPushEndpoint,
  validSubscriptionKeys,
  clampUtf8,
  type PushEnv,
} from "../push";

// RFC 8291 §5 "Push Message Encryption Example" — the authoritative test vector.
const VEC = {
  plaintext: "When I grow up, I want to be a watermelon",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  expected:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** Reconstruct the RFC's app-server ephemeral keypair for deterministic encryption. */
async function vectorEphemeral(): Promise<CryptoKeyPair> {
  const pub = b64urlToBytes(VEC.asPublic);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: VEC.asPrivate,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
    key_ops: ["deriveBits"],
  };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

describe("encryptPayload (RFC 8291 §5 vector)", () => {
  it("reproduces the published aes128gcm message body exactly", async () => {
    const body = await encryptPayload(
      new TextEncoder().encode(VEC.plaintext),
      VEC.uaPublic,
      VEC.authSecret,
      { salt: b64urlToBytes(VEC.salt), ephemeral: await vectorEphemeral() },
    );
    expect(bytesToB64url(body)).toBe(VEC.expected);
  });
});

describe("buildVapidJwt", () => {
  // A throwaway P-256 keypair so we can verify the JWT we produce.
  const env: PushEnv = {
    DB: {} as any,
    VAPID_SUBJECT: "mailto:test@example.com",
  };

  it("emits a verifiable ES256 JWT with aud/exp/sub", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwkPriv = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
    const rawPub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
    const e = { ...env, VAPID_PRIVATE: jwkPriv.d!, VAPID_PUBLIC: bytesToB64url(rawPub) };

    const jwt = await buildVapidJwt(e, "https://push.example.com", 1_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlToBytes(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    expect(payload.aud).toBe("https://push.example.com");
    expect(payload.sub).toBe("mailto:test@example.com");
    expect(payload.exp).toBe(1_000_000 + 12 * 60 * 60);

    // The signature verifies against our public key.
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      kp.publicKey,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("throws when VAPID keys are absent", async () => {
    await expect(buildVapidJwt(env, "https://x.com")).rejects.toThrow(/not configured/i);
  });
});

describe("base64url round-trip", () => {
  it("encodes and decodes bytes losslessly", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(b64urlToBytes(bytesToB64url(bytes))).toEqual(bytes);
  });
});

describe("isAllowedPushEndpoint (SSRF guard)", () => {
  it("accepts the major browser push hosts over https", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://abc.notify.windows.com/x")).toBe(true);
  });
  it("rejects unknown hosts, http, and junk", () => {
    expect(isAllowedPushEndpoint("https://evil.example.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
    expect(isAllowedPushEndpoint("https://" + "a".repeat(2000))).toBe(false);
  });
});

describe("validSubscriptionKeys", () => {
  it("requires a 65-byte p256dh and 16-byte auth", () => {
    const p = bytesToB64url(new Uint8Array(65));
    const a = bytesToB64url(new Uint8Array(16));
    expect(validSubscriptionKeys(p, a)).toBe(true);
    expect(validSubscriptionKeys(bytesToB64url(new Uint8Array(64)), a)).toBe(false);
    expect(validSubscriptionKeys(p, bytesToB64url(new Uint8Array(15)))).toBe(false);
    expect(validSubscriptionKeys("!!!", a)).toBe(false);
  });
});

describe("clampUtf8", () => {
  it("leaves short strings and truncates long ones by byte length", () => {
    expect(clampUtf8("hello", 100)).toBe("hello");
    expect(clampUtf8("abcdef", 3)).toBe("abc");
    expect(new TextEncoder().encode(clampUtf8("x".repeat(500), 100)).length).toBeLessThanOrEqual(100);
  });
});
