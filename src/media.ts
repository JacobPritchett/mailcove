// Media tokens: short-lived, message-bound capabilities that authorize a single
// image load from /api/media WITHOUT depending on the Access cookie (so they
// work from the opaque-origin sandboxed email iframe). The signed URL inside the
// payload IS the membership proof — the Worker only ever signs refs that were
// actually present in the message being served.

export interface MediaPayload {
  v: 1;
  kid: string;           // key id, for rotation
  kind: "cid" | "remote";
  m: string;             // messageId
  exp: number;           // unix seconds
  ref: string;           // cid: partId | remote: absolute URL
}

// Live key ids. v1 has one; rotation adds a second and retires the first after
// max token TTL. verify() rejects any kid not listed here.
const LIVE_KIDS = new Set(["k1"]);
export const MEDIA_KID = "k1";
export const MEDIA_TTL_SECONDS = 6 * 3600;

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  // length % 4 === 1 is structurally invalid base64 (the padding formula
  // produces "===", which atob rejects with a throw). That's intentional —
  // callers wrap this in try/catch and treat any throw as "reject".
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keyCache.set(secret, k);
  }
  return k;
}

export async function mintMediaToken(secret: string, payload: MediaPayload): Promise<string> {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

export async function verifyMediaToken(secret: string, token: string): Promise<MediaPayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let sigBytes: Uint8Array;
  try { sigBytes = b64urlDecode(sig); } catch { return null; }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(body));
  if (!ok) return null; // subtle.verify is constant-time
  let payload: MediaPayload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))); } catch { return null; }
  if (payload.v !== 1 || !LIVE_KIDS.has(payload.kid)) return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.kind !== "cid" && payload.kind !== "remote") return null;
  return payload;
}

// Returns a parsed URL only if it is an http(s) URL whose host is not an IP
// literal in a private/loopback/link-local/CGNAT range and is not localhost.
// NOTE: Workers fetch exposes no DNS resolution, so DNS-rebinding to a private
// address is NOT fully preventable here (documented limitation); redirect
// revalidation (Task 4) plus Cloudflare egress mitigate it.
export function validateRemoteUrl(raw: string): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  if (isBlockedIpLiteral(host)) return null;
  return url;
}

function isBlockedIpLiteral(host: string): boolean {
  // IPv6 literal — URL.hostname includes surrounding brackets e.g. "[::1]".
  // Strip brackets before inspecting the address.
  if (host.startsWith("[") && host.endsWith("]")) {
    const addr = host.slice(1, -1);
    if (addr === "::1" || addr === "::") return true;
    if (addr.startsWith("fe80") || addr.startsWith("fc") || addr.startsWith("fd")) return true;
    // Block all other IPv6 literals, including IPv4-mapped (::ffff:…) addresses,
    // which runtimes normalize to compressed hex groups rather than dotted-decimal.
    return true;
  }
  // Dotted-decimal IPv4 — note: new URL() normalises hex/decimal IP forms to
  // dotted decimal (e.g. 0x7f.0.0.1 → 127.0.0.1, 2130706433 → 127.0.0.1)
  // before we ever see the hostname, so we only need to handle canonical form.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isBlockedIpv4(host);
  return false; // treat as a DNS hostname
}

function isBlockedIpv4(ip: string): boolean {
  const o = ip.split(".").map((n) => Number(n));
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;           // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 168) return true;           // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                         // multicast/reserved
  return false;
}

export const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface ProxyOpts {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

// Fetches a remote image with manual-redirect SSRF revalidation, a streaming
// byte cap, raster-only content-type enforcement, and a fresh response carrying
// ONLY controlled headers. Never throws — returns a 4xx/5xx Response instead so
// the route can map it to a visible client placeholder.
export async function proxyRemoteImage(start: string, opts: ProxyOpts = {}): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const timeoutMs = opts.timeoutMs ?? 8000;

  const initialUrl = validateRemoteUrl(start);
  if (!initialUrl) return new Response("blocked", { status: 502 });

  let current: URL = initialUrl;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let upstream: Response | null = null;
    // Follow up to maxRedirects redirects (maxRedirects+1 fetches total), revalidating each hop.
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let r: Response;
      try {
        r = await doFetch(current.toString(), {
          redirect: "manual",
          signal: ac.signal,
          headers: { Accept: "image/webp,image/png,image/jpeg,image/gif,image/*;q=0.5", "User-Agent": "Mailcove-image-proxy" },
        });
      } catch {
        return new Response("upstream", { status: 502 });
      }
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        const resolved = loc ? validateRemoteUrl(new URL(loc, current.toString()).toString()) : null;
        if (!resolved) return new Response("blocked-redirect", { status: 502 });
        current = resolved;
        continue;
      }
      upstream = r;
      break;
    }
    if (!upstream) return new Response("too-many-redirects", { status: 502 });
    if (!upstream.ok) return new Response("upstream", { status: 502 });

    const type = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!RASTER_TYPES.has(type)) return new Response("unsupported", { status: 415 });

    const declared = Number(upstream.headers.get("content-length") || "0");
    if (declared && declared > maxBytes) return new Response("too-large", { status: 502 });

    if (!upstream.body) return new Response("empty", { status: 502 });

    // Buffer the size-capped body to completion HERE, while the abort deadline
    // is still active. If we returned a streaming Response and let the caller read
    // it AFTER this function's finally clears the timer, a slow-drip upstream could
    // hold the Worker request open indefinitely under the byte cap (a degraded-
    // dependency DoS). Reading here bounds BOTH bytes (capStream) AND time (the
    // shared AbortController fires mid-read on a slow body, rejecting the read).
    // Result is bounded to <= maxBytes in memory.
    let buf: ArrayBuffer;
    try {
      buf = await new Response(capStream(upstream.body, maxBytes).stream).arrayBuffer();
    } catch {
      return new Response("too-large-or-slow", { status: 502 });
    }
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
        "Cache-Control": `private, max-age=${MEDIA_TTL_SECONDS}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Wraps a body stream, aborting (erroring the stream -> 502 at the edge) if it
// exceeds maxBytes. Avoids buffering the whole body in memory.
function capStream(body: ReadableStream<Uint8Array> | null, maxBytes: number): { stream: ReadableStream<Uint8Array> } {
  if (!body) return { stream: new Response("").body as ReadableStream<Uint8Array> };
  let seen = 0;
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      seen += value.byteLength;
      if (seen > maxBytes) { controller.error(new Error("too-large")); return; }
      controller.enqueue(value);
    },
    cancel(reason) { void reader.cancel(reason); },
  });
  return { stream };
}
