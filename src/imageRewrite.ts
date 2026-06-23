// Image policy applied to untrusted email HTML on read. Pure rewriting only —
// XSS is contained by the no-allow-scripts sandbox + default-src 'none' CSP.

export interface SrcsetCandidate { url: string; descriptor: string }

// Spec-compatible-enough srcset parser: split on commas that are followed by a
// new candidate, NOT commas inside a data: URL. A candidate is `url descriptor?`.
export function parseSrcset(value: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  for (const raw of splitCandidates(value)) {
    const t = raw.trim();
    if (!t) continue;
    const sp = t.search(/\s/);
    if (sp === -1) { out.push({ url: t, descriptor: "" }); continue; }
    out.push({ url: t.slice(0, sp), descriptor: t.slice(sp + 1).trim() });
  }
  return out;
}

function splitCandidates(value: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inData = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (!inData && value.slice(i).match(/^data:/i)) inData = true;
    if (c === "," && !inData) { parts.push(buf); buf = ""; continue; }
    if (/\s/.test(c) && inData) inData = false; // data URL ends at whitespace
    buf += c;
  }
  if (buf) parts.push(buf);
  return parts;
}

export function serializeSrcset(cands: SrcsetCandidate[]): string {
  return cands.map((c) => (c.descriptor ? `${c.url} ${c.descriptor}` : c.url)).join(", ");
}

// A valid srcset descriptor is empty, a density (e.g. "2x"), or a width (e.g. "320w").
// Anything else (a smuggled URL, extra tokens) means the candidate was mis-tokenized
// from an ambiguous srcset (e.g. a data: URL's commas) — drop it to fail safe.
export function isValidSrcsetDescriptor(d: string): boolean {
  return d === "" || /^\d+(\.\d+)?[wx]$/.test(d);
}

export interface RewriteCtx {
  // cid (already normalized, no angle brackets) → media URL, or null if unknown.
  cidToToken: (cid: string) => Promise<string | null>;
  // absolute remote URL → proxied media URL.
  remoteToToken: (url: string) => Promise<string>;
  showRemote: boolean;
  // cap on rewritten remote candidates per render (defense vs amplification).
  maxRemote?: number;
}

export interface RewriteResult { html: string; blockedRemoteCount: number }

// NOTE: DATA_RASTER must stay in sync with RASTER_TYPES in media.ts and INLINE_TYPES in index.ts.
const DATA_RASTER = /^data:image\/(png|jpe?g|gif|webp)[;,]/i;
const MAX_DATA_URI = 512 * 1024;

// Sentinel returned by resolveSrc when a remote image is BLOCKED (privacy or
// per-render budget) rather than genuinely dropped (unsafe/unknown). The <img>
// handler swaps this for a styled placeholder so the reader shows a tidy
// "image hidden" box instead of the browser's broken-image glyph. CSP allows
// img-src data:, so the placeholder renders; every other attribute (srcset,
// poster, SVG href) treats the sentinel as a plain drop.
const BLOCKED = "\x00blocked";
const BLOCKED_IMG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" role="img" aria-label="Image hidden for privacy">' +
      '<rect width="120" height="90" rx="6" fill="#f1f5f9"/>' +
      '<g fill="none" stroke="#94a3b8" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">' +
      '<rect x="30" y="28" width="60" height="40" rx="4"/><circle cx="46" cy="44" r="5"/>' +
      '<path d="M34 62l16-14 10 8 12-10 14 16"/></g></svg>',
  );

export type SrcAction =
  | { kind: "cid"; cid: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; value: string }
  | { kind: "drop" };

// Pure classification of one src/href value — no I/O, fully node-testable.
export function classifySrc(value: string): SrcAction {
  const s = value.trim();
  if (/^cid:/i.test(s)) return { kind: "cid", cid: normalizeCid(s.slice(4)) };
  if (/^https?:/i.test(s)) return { kind: "remote", url: s };
  if (/^data:/i.test(s)) {
    return DATA_RASTER.test(s) && s.length <= MAX_DATA_URI ? { kind: "data", value: s } : { kind: "drop" };
  }
  return { kind: "drop" };
}

export async function rewriteEmailImages(html: string, c: RewriteCtx): Promise<RewriteResult> {
  let blocked = 0;
  let remoteShown = 0;
  const maxRemote = c.maxRemote ?? 200;

  // Resolve one src value → replacement value, or "" to drop it.
  // Catches any callback throw so a single failing image can't crash the whole rewrite.
  async function resolveSrc(v: string): Promise<string> {
    const a = classifySrc(v);
    if (a.kind === "cid") {
      try { return (await c.cidToToken(a.cid)) ?? ""; } catch { return ""; }
    }
    if (a.kind === "data") return a.value;
    if (a.kind === "remote") {
      if (!c.showRemote || remoteShown >= maxRemote) { blocked++; return BLOCKED; }
      try {
        remoteShown++;
        return await c.remoteToToken(a.url);
      } catch { blocked++; remoteShown--; return BLOCKED; }
    }
    return ""; // drop
  }

  async function resolveSrcset(v: string): Promise<string> {
    const cands = parseSrcset(v);
    const out: SrcsetCandidate[] = [];
    for (const cand of cands) {
      // Drop candidates with invalid descriptors — guards against URL smuggling via
      // mis-tokenized data: URL commas producing bogus descriptor tokens.
      if (!isValidSrcsetDescriptor(cand.descriptor)) continue;
      const u = await resolveSrc(cand.url);
      if (u && u !== BLOCKED) out.push({ url: u, descriptor: cand.descriptor });
    }
    return serializeSrcset(out);
  }

  // Per-tag URL attribute mapping:
  //   img, input (type=image): src + srcset
  //   source: src + srcset
  //   video: poster (no srcset)
  //   image (SVG): href + xlink:href (no src — SVG <image> uses href; src is non-standard)
  //   base: always remove
  //
  // Note: @cloudflare/workers-types declares Element as an ambient global (not an
  // exported module symbol), so we use the global type directly rather than importing it.
  const handler = {
    async element(el: Element) {
      const tag = el.tagName.toLowerCase();
      if (tag === "base") { el.remove(); return; }

      if (tag === "image") {
        // SVG <image>: process href and xlink:href only (not src).
        // Process only the first one present to avoid double-charging the remote budget.
        const href = el.getAttribute("href");
        if (href !== null) {
          const r = await resolveSrc(href);
          if (r && r !== BLOCKED) el.setAttribute("href", r); else el.removeAttribute("href");
        }
        const xlinkHref = el.getAttribute("xlink:href");
        if (xlinkHref !== null) {
          const r = await resolveSrc(xlinkHref);
          if (r && r !== BLOCKED) el.setAttribute("xlink:href", r); else el.removeAttribute("xlink:href");
        }
        return;
      }

      if (tag === "video") {
        // <video poster> — strip/proxy the poster URL.
        const poster = el.getAttribute("poster");
        if (poster !== null) {
          const r = await resolveSrc(poster);
          if (r && r !== BLOCKED) el.setAttribute("poster", r); else el.removeAttribute("poster");
        }
        return;
      }

      // img, input (type=image), source — handle src + optional srcset.
      const src = el.getAttribute("src");
      if (src !== null) {
        const r = await resolveSrc(src);
        // Blocked remote image → styled placeholder (not the broken-image glyph).
        if (r === BLOCKED) el.setAttribute("src", BLOCKED_IMG);
        else if (r) el.setAttribute("src", r);
        else el.removeAttribute("src");
      }
      const srcset = el.getAttribute("srcset");
      if (srcset !== null) {
        const r = await resolveSrcset(srcset);
        if (r) el.setAttribute("srcset", r); else el.removeAttribute("srcset");
      }
    },
  };

  const res = new HTMLRewriter()
    .on("img", handler)
    .on("source", handler)
    .on("image", handler)
    .on("input", handler)
    .on("video", handler)
    .on("base", handler)
    .transform(new Response(html));
  const outHtml = await res.text();
  return { html: outHtml, blockedRemoteCount: blocked };
}

// Content-ID normalization: drop surrounding <>, percent-decode, case-fold.
export function normalizeCid(raw: string): string {
  let v = raw.trim();
  if (v.startsWith("<") && v.endsWith(">")) v = v.slice(1, -1);
  try { v = decodeURIComponent(v); } catch { /* keep as-is */ }
  return v.toLowerCase();
}
