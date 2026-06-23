// Web Push (RFC 8291 "aes128gcm" + VAPID/RFC 8292) implemented on Web Crypto so
// the Worker can notify subscribed devices of new mail with no third-party SDK.
//
// The encryption is exercised against the RFC 8291 §5 test vector in
// src/test/push.test.ts — that's the only way to be confident a hand-rolled
// content-encryption is correct without a live push service.

export interface PushEnv {
  DB: D1Database;
  VAPID_PUBLIC?: string; // base64url, 65-byte uncompressed P-256 point (non-secret)
  VAPID_PRIVATE?: string; // base64url, 32-byte private scalar (secret)
  VAPID_SUBJECT?: string; // "mailto:you@example.com" or an https URL
}

export interface StoredSubscription { endpoint: string; p256dh: string; auth: string; }

// ---- base64url <-> bytes ----
export function bytesToB64url(b: ArrayBuffer | Uint8Array): string {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();

// ---- Subscription validation (SSRF + junk defense) ----

// Hosts the major browsers' push services use. We only ever POST to stored
// endpoints, so restricting to these prevents /api/push/subscribe from being
// used to make the Worker fetch arbitrary attacker-chosen origins.
const ALLOWED_PUSH_HOSTS = new Set(["fcm.googleapis.com", "android.googleapis.com"]);
const ALLOWED_PUSH_SUFFIXES = [
  ".push.services.mozilla.com", // Firefox
  ".push.apple.com", // Safari / Apple
  ".notify.windows.com", // Windows / legacy Edge (WNS)
  ".push.microsoft.com", // newer Edge
];
const MAX_ENDPOINT_LEN = 1024;

/** True only for an https URL on a known browser push-service host. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT_LEN) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_PUSH_HOSTS.has(host) || ALLOWED_PUSH_SUFFIXES.some((s) => host.endsWith(s));
}

/** Validate the client key material: p256dh is a 65-byte point, auth is 16 bytes. */
export function validSubscriptionKeys(p256dh: string, auth: string): boolean {
  try {
    return b64urlToBytes(p256dh).length === 65 && b64urlToBytes(auth).length === 16;
  } catch {
    return false;
  }
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes (notification payloads are capped). */
export function clampUtf8(s: string, maxBytes: number): string {
  let out = s ?? "";
  while (enc.encode(out).length > maxBytes) out = out.slice(0, -1);
  return out;
}

/** Max subscriptions we keep / fan out to (personal-scale; bounds per-email work). */
export const MAX_SUBSCRIPTIONS = 50;

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---- VAPID (RFC 8292): a signed JWT proving the app server identity ----

/** Import the VAPID private scalar (+ matching public point) as an ES256 key. */
async function importVapidKey(privateB64url: string, publicB64url: string): Promise<CryptoKey> {
  const pub = b64urlToBytes(publicB64url); // 0x04 || X(32) || Y(32)
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: privateB64url,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/**
 * Build a VAPID JWT for a given audience (the push endpoint's origin). `nowSec`
 * is injectable for deterministic tests.
 */
export async function buildVapidJwt(env: PushEnv, audience: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) throw new Error("VAPID keys not configured");
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: nowSec + 12 * 60 * 60, // 12h, within the 24h spec ceiling
    sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
  };
  const signingInput = `${bytesToB64url(enc.encode(JSON.stringify(header)))}.${bytesToB64url(enc.encode(JSON.stringify(payload)))}`;
  const key = await importVapidKey(env.VAPID_PRIVATE, env.VAPID_PUBLIC);
  // Web Crypto ECDSA produces the raw r||s (64 bytes) JOSE signature directly.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `${signingInput}.${bytesToB64url(sig)}`;
}

// ---- Content encryption (RFC 8291 over RFC 8188 aes128gcm) ----

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** Test seam: inject the salt + ephemeral keypair to reproduce the RFC vector. */
export interface EncryptTestKeys { salt: Uint8Array; ephemeral: CryptoKeyPair; }

/**
 * Encrypt `payload` for a subscription's keys, producing the aes128gcm message
 * body (salt | rs | idlen | as_public | ciphertext) ready to POST.
 */
export async function encryptPayload(
  payload: Uint8Array,
  p256dhB64: string,
  authB64: string,
  testKeys?: EncryptTestKeys,
): Promise<Uint8Array> {
  const clientPub = b64urlToBytes(p256dhB64); // ua_public (65)
  const authSecret = b64urlToBytes(authB64); // (16)

  const ephemeral =
    testKeys?.ephemeral ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer,
  ); // (65)

  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPub,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // workers-types doesn't export EcdhKeyDeriveParams by name; the shape is
      // correct ({ name, public }).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { name: "ECDH", public: clientKey } as any,
      ephemeral.privateKey,
      256,
    ),
  ); // (32)

  const salt = testKeys?.salt ?? crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291 §3.4: combine ECDH secret + auth into the input keying material.
  const keyInfo = concat(enc.encode("WebPush: info"), new Uint8Array([0]), clientPub, asPublic);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  // RFC 8188 §2.2/2.3: derive the content-encryption key + nonce from the salt.
  const cek = await hkdf(ikm, salt, concat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(ikm, salt, concat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  // Single record: plaintext || 0x02 (last-record padding delimiter).
  const record = concat(payload, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record),
  );

  // aes128gcm header: salt(16) | rs(4, BE) | idlen(1)=65 | keyid(as_public, 65)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = 65;
  header.set(asPublic, 21);

  return concat(header, ciphertext);
}

// ---- Sending ----

export interface SendResult { status: number; ok: boolean; gone: boolean; }

/** Send one push. `gone` (404/410) tells the caller to drop the subscription. */
export async function sendPush(env: PushEnv, sub: StoredSubscription, message: unknown): Promise<SendResult> {
  const payload = enc.encode(JSON.stringify(message));
  const body = await encryptPayload(payload, sub.p256dh, sub.auth);
  const audience = new URL(sub.endpoint).origin;
  const jwt = await buildVapidJwt(env, audience);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body,
  });
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410 };
}

/**
 * Push `message` to every stored subscription. Best-effort: per-subscription
 * failures are swallowed, and subscriptions the push service reports as gone
 * (404/410) are deleted so the table self-heals. No-op without VAPID config.
 */
export async function sendPushToAll(env: PushEnv, message: unknown): Promise<{ sent: number; removed: number }> {
  if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return { sent: 0, removed: 0 };
  // Hard LIMIT bounds the per-email background work regardless of row count.
  const { results } = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created DESC LIMIT ?`,
  )
    .bind(MAX_SUBSCRIPTIONS)
    .all<StoredSubscription>();
  const subs = results ?? [];
  let sent = 0;
  const gone: string[] = [];
  for (const sub of subs) {
    try {
      const r = await sendPush(env, sub, message);
      if (r.ok) sent++;
      else if (r.gone) gone.push(sub.endpoint);
    } catch (e) {
      console.error("push send failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }
  for (const endpoint of gone) {
    await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?`).bind(endpoint).run().catch(() => {});
  }
  return { sent, removed: gone.length };
}
