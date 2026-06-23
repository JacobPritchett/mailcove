import PostalMime from "postal-mime";
import { verifyAccess } from "./auth";
import { deriveThreadId, sanitizeMessageId } from "./threading";
import { getThread, findThreadIdByMessageIds } from "./store";
import { isMailAction, mutateThread, mutateThreads, purgeOldTrash } from "./store_mutations";
import { isView, isCategory, isDomainName, listThreadsByView, countsByView, countsByDomain } from "./store_views";
import { ftsUpsert, ftsRowFrom, bodyForIndex, searchThreads, reindexAll } from "./search";
import { summarizeThread, draftReply, suggestCompletion } from "./ai";
import { takeToken, type Bucket } from "./ratelimit";
import { applyFilters, isFilterField, isFilterOp, isFilterAction, MAX_FILTERS } from "./rules";
import {
  listDomains,
  getDomainDetail,
  setCatchAll,
  zoneInAccount,
  findZone,
  getRoutingStrict,
  getMxStrict,
  hasForeignApexMx,
  enableRouting,
  onboardSending,
  getSendingDns,
  ensureDnsRecords,
  createRule,
  setRuleEnabled,
  deleteRule,
  createDestination,
  CfNotConfigured,
} from "./cf_routing";
import {
  listIdentities,
  resolveSender,
  SenderError,
  upsertDomain,
  listReceivingDomains,
  getDomainRow,
  setDomainForwardCopy,
  setDomainDisplayName,
  sanitizeFromName,
  defaultDisplayName,
  forwardCopyFor,
} from "./domains";
import { classifyMessage } from "./categorize";
import { validateDraft, putDraft, listDrafts, getDraft, deleteDraft, countDrafts } from "./drafts";
import { sendPushToAll, isAllowedPushEndpoint, validSubscriptionKeys, clampUtf8, MAX_SUBSCRIPTIONS } from "./push";
import { normalizeCid, rewriteEmailImages } from "./imageRewrite";
import { verifyMediaToken, proxyRemoteImage, RASTER_TYPES, MEDIA_TTL_SECONDS, mintMediaToken, MEDIA_KID } from "./media";

export interface Env {
  DB: D1Database;
  MAILSTORE: R2Bucket;
  ASSETS: Fetcher; // Workers Assets binding (serves the Vite-built SPA)
  EMAIL: { send: (msg: unknown) => Promise<{ messageId?: string } | undefined> }; // send_email binding
  AI: { run: (model: string, input: Record<string, unknown>) => Promise<{ response?: string }> }; // Workers AI binding
  INBOX_DOMAIN: string;
  FROM_DOMAIN: string;
  DEFAULT_FROM_LOCAL: string;
  FORWARD_COPY_TO?: string;
  AUTH_TOKEN?: string; // secret — fallback auth for API/automation
  ACCESS_TEAM_DOMAIN: string; // Cloudflare Access team domain (JWT issuer)
  ACCESS_AUD: string; // Access application AUD tag (JWT audience)
  CF_API_TOKEN?: string; // secret — CF API token for the Domains admin dashboard + onboarding
  CF_ACCOUNT_ID?: string; // account id the zones live under (for the Domains dashboard)
  INBOX_WORKER_NAME?: string; // this Worker's name — the Email Routing catch-all target for "receive here"
  VAPID_PUBLIC?: string; // Web Push: base64url public key (non-secret, exposed to the client)
  VAPID_PRIVATE?: string; // Web Push: secret signing key
  VAPID_SUBJECT?: string; // Web Push: VAPID "sub" (mailto: or https URL)
  IMG_PROXY_SECRET?: string; // secret — HMAC key for media tokens (falls back to AUTH_TOKEN)
}

const uuid = () => crypto.randomUUID();

function mediaSecret(env: Env): string | null {
  return env.IMG_PROXY_SECRET || env.AUTH_TOKEN || null;
}

// Per-isolate token buckets for the (expensive) Smart Compose endpoint.
const suggestBuckets = new Map<string, Bucket>();
// …and for destination registration (each call emails a verification link).
const destinationBuckets = new Map<string, Bucket>();

// Inert types we trust to render inline. Everything else is forced to download
// with a generic content-type so a stored text/html (or SVG, etc.) attachment
// can't execute script in our same-origin context.
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Build a safe Response for a stored attachment. Allowlisted inert types are
 * served inline with their real content-type; anything else is downloaded as
 * application/octet-stream. `nosniff` is always set so the browser never
 * upgrades octet-stream back to an active type.
 */
export function serveAttachment(
  body: BodyInit,
  contentType: string | undefined | null,
  name: string,
): Response {
  const type = (contentType || "").toLowerCase();
  if (INLINE_TYPES.has(type)) {
    return new Response(body, {
      headers: {
        "Content-Type": type,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  // Strip characters that could break out of the quoted filename.
  const safeName = name.replace(/["\\\r\n]/g, "_");
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
/** DMARC verdict from a SINGLE Authentication-Results value: 1 only if dmarc=pass. */
export function parseAuthResults(header: string | null | undefined): 0 | 1 {
  return header && /\bdmarc=pass\b/i.test(header) ? 1 : 0;
}

/**
 * Trustworthy DMARC verdict from the message's ordered headers. ONLY the first
 * Authentication-Results header is honored — that is the one our boundary MX
 * (Cloudflare Email Routing) prepends on receipt. A spoofer can embed their own
 * `Authentication-Results: ...; dmarc=pass` lower in the message; those untrusted
 * copies must be ignored (reading the comma-joined Headers.get() value would let a
 * forged pass override a genuine fail). postal-mime returns headers top-to-bottom
 * with lowercased keys, so headers[0]-of-kind is the boundary-MX result.
 */
export function dmarcPassFromHeaders(
  headers: { key: string; value: string }[] | undefined,
): 0 | 1 {
  const first = (headers || []).find((h) => h.key.toLowerCase() === "authentication-results");
  return parseAuthResults(first?.value);
}

export interface AttachmentRecord {
  partId: string;
  name: string;
  mimeType: string;
  size: number;
  disposition: string;
  contentId: string | null;
}

/** Build the stored attachment record for one parsed part. partId is stable per
 *  message (index-based) and is the storage key suffix — never the filename. */
export function attachmentRecord(
  att: { filename?: string | null; mimeType?: string | null; size?: number; contentId?: string | null; disposition?: string | null },
  index: number,
): AttachmentRecord {
  return {
    partId: `p${index}`,
    name: att.filename || `attachment-${index + 1}`,
    mimeType: att.mimeType || "",
    size: att.size ?? 0,
    disposition: att.disposition || "",
    contentId: att.contentId ? normalizeCid(att.contentId) : null,
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Normalize a From value to a comparable mailbox: unwrap <...>, lowercase.
 *  WARNING: this parses a rendered display string and is therefore spoofable —
 *  a crafted display name can inject a second "<addr>". Safe for the user's own
 *  allowlist input, but NEVER use it to derive the trust identity of an inbound
 *  message; use the stored from_addr (normalizeFromAddress) for that. */
export function normalizeAddress(raw: string): string {
  const inner = raw.match(/<([^>]*)>/)?.[1] ?? raw;
  return inner.trim().toLowerCase();
}

/** The authenticated sender mailbox from postal-mime's structured parse,
 *  normalized. This is the image-allowlist key for inbound mail: unlike the
 *  rendered msg_from string, parsed.from.address cannot be poisoned by a crafted
 *  display name injecting a second "<addr>". Empty when From is unparseable. */
export function normalizeFromAddress(from: { address?: string | null } | null | undefined): string {
  return (from?.address || "").trim().toLowerCase();
}

export async function isSenderAllowed(env: Env, from: string): Promise<boolean> {
  const addr = normalizeAddress(from);
  const row = await env.DB.prepare(`SELECT 1 FROM image_senders WHERE address=?`).bind(addr).first();
  return !!row;
}

export function messageImagePolicy(p: { allowed: boolean; dmarcPass: 0 | 1 }): boolean {
  return p.allowed && p.dmarcPass === 1;
}

// Rewrite one message body's HTML under a show/block policy, minting media tokens.
// Returns rewritten html + blocked count. `attachments` come from the parsed body
// (carry partId + normalized contentId). No-op when there is no html or no secret.
async function rewriteMessageHtml(
  env: Env,
  messageId: string,
  html: string,
  attachments: { partId?: string; contentId?: string | null }[],
  showRemote: boolean,
): Promise<{ html: string; blockedRemoteCount: number }> {
  const secret = mediaSecret(env);
  if (!secret || !html) return { html, blockedRemoteCount: 0 };
  const exp = Math.floor(Date.now() / 1000) + MEDIA_TTL_SECONDS;
  const cidMap = new Map<string, string>();
  for (const a of attachments) if (a.contentId && a.partId) cidMap.set(a.contentId, a.partId);
  return rewriteEmailImages(html, {
    showRemote,
    cidToToken: async (cid) => {
      const partId = cidMap.get(normalizeCid(cid));
      if (!partId) return null;
      const t = await mintMediaToken(secret, { v: 1, kid: MEDIA_KID, kind: "cid", m: messageId, ref: partId, exp });
      return `/api/media?t=${encodeURIComponent(t)}`;
    },
    remoteToToken: async (u) => {
      const t = await mintMediaToken(secret, { v: 1, kid: MEDIA_KID, kind: "remote", m: messageId, ref: u, exp });
      return `/api/media?t=${encodeURIComponent(t)}`;
    },
  });
}

/**
 * Same-origin check for CSRF defense on mutations. Trusts the browser-set
 * Origin header (falling back to Referer); a missing one on a state-changing
 * request is treated as cross-origin and rejected.
 */
function isSameOrigin(request: Request, url: URL): boolean {
  for (const header of ["Origin", "Referer"]) {
    const value = request.headers.get(header);
    if (value) {
      try {
        // Compare full origin (scheme + host + port), not just host: a same-host
        // request over a different scheme is not same-origin and must be rejected.
        return new URL(value).origin === url.origin;
      } catch {
        return false;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- inbound
async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
  const id = uuid();
  const rawBuf = await new Response(message.raw).arrayBuffer();
  await env.MAILSTORE.put(`raw/${id}.eml`, rawBuf);

  const parsed = await PostalMime.parse(rawBuf);
  const subject = parsed.subject || "(no subject)";
  const from = parsed.from
    ? `${parsed.from.name || ""} <${parsed.from.address}>`.trim()
    : message.from;
  const to = (parsed.to || []).map((a) => a.address).join(", ") || message.to;
  const cc = (parsed.cc || []).map((a) => a.address).join(", ");
  const text = parsed.text || "";
  const html = parsed.html || "";
  const snippet = (text || html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const dateMs = parsed.date ? Date.parse(parsed.date) || Date.now() : Date.now();
  const messageId = parsed.messageId || "";
  const inReplyTo = parsed.inReplyTo || "";
  // postal-mime exposes References as a single space-separated string.
  const references = parsed.references;

  const attachments: AttachmentRecord[] = [];
  let idx = 0;
  for (const att of parsed.attachments || []) {
    const body = att.content as ArrayBuffer;
    const rec = attachmentRecord(
      { filename: att.filename, mimeType: att.mimeType, size: (body as ArrayBuffer).byteLength || 0, contentId: att.contentId, disposition: att.disposition },
      idx++,
    );
    await env.MAILSTORE.put(`att/${id}/${rec.partId}`, body, {
      httpMetadata: { contentType: rec.mimeType || "application/octet-stream" },
    });
    attachments.push(rec);
  }

  await env.MAILSTORE.put(
    `parsed/${id}.json`,
    JSON.stringify({ text, html, attachments, headers: { messageId, inReplyTo } }),
  );

  // Prefer linking this reply to an already-stored thread: gather every parent
  // candidate from References + In-Reply-To (sanitized to canonical <id@host>),
  // and look them up in the DB. If a parent (our own sent message OR an earlier
  // inbound) is already stored, join *its* thread_id — this fixes multi-level
  // chains that only carry In-Reply-To, and replies to mail we sent. Otherwise
  // fall back to header-derived grouping (References root → In-Reply-To →
  // Message-ID → our internal id).
  const refTokens = Array.isArray(references)
    ? references.flatMap((r) => r.split(/\s+/))
    : (references || "").split(/\s+/);
  const candidates = [...refTokens, inReplyTo]
    .map((v) => sanitizeMessageId(v))
    .filter((v): v is string => v !== null);
  const linked = await findThreadIdByMessageIds(env.DB, candidates);
  const threadId =
    linked ?? deriveThreadId({ references, inReplyTo, messageId }, id);
  // Derive the domain from the ENVELOPE recipient (RCPT TO) first — it's the
  // address Email Routing actually delivered to, and stays correct for BCC and
  // catch-all mail where the To header points elsewhere. Header To is the
  // fallback, then the default inbox domain. Angle-bracket paths are unwrapped
  // and the result must look like a hostname — junk never lands in the domain
  // column (it would poison counts/filters).
  const domainOf = (raw: string) => {
    const addr = raw.match(/<([^>]*)>/)?.[1] ?? raw;
    const at = addr.lastIndexOf("@");
    const d = at >= 0 ? addr.slice(at + 1).trim().toLowerCase() : "";
    return isDomainName(d) ? d : "";
  };
  const inboundDomain = domainOf(message.to || "") || domainOf(to || "") || env.INBOX_DOMAIN;
  // Trust ONLY the first (boundary-MX) Authentication-Results — not the
  // comma-joined Headers.get() value, which a spoofer could poison with a forged
  // dmarc=pass embedded lower in the message.
  const dmarcPass = dmarcPassFromHeaders(parsed.headers);
  // Authenticated sender mailbox — the image-allowlist key. Derived from the
  // structured parse (not the spoofable rendered `from` string).
  const fromAddr = normalizeFromAddress(parsed.from);

  // Store with the default category ("primary"); the AI auto-label is computed
  // AFTER delivery (see ctx.waitUntil below) so a slow/failed inference can never
  // delay or block mail storage + the forward-copy.
  await env.DB.prepare(
    `INSERT INTO messages
       (id, thread_id, direction, folder, msg_from, msg_to, msg_cc, subject, snippet, date, unread, has_attachments, message_id, in_reply_to, r2_raw_key, state, starred, domain, category, dmarc_pass, from_addr)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, threadId, "in", "inbox", from, to, cc, subject, snippet, dateMs, 1, attachments.length ? 1 : 0, messageId, inReplyTo, `raw/${id}.eml`, "inbox", 0, inboundDomain, "primary", dmarcPass, fromAddr)
    .run();

  // Index for full-text search (best-effort — never block delivery on this).
  await ftsUpsert(env, ftsRowFrom({ id, subject, from, to, cc, bodyText: bodyForIndex(text, html) }));

  // Non-destructive: keep delivering a copy to a real mailbox. Per-domain
  // override from the registry (NULL = global default, "" = off); best-effort.
  const copyTo = await forwardCopyFor(env, inboundDomain, env.FORWARD_COPY_TO);
  if (copyTo) {
    try {
      await message.forward(copyTo);
      console.log(`forwarded copy to ${copyTo}`);
    } catch (e) {
      console.error("forward failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }

  // AI auto-label, OFF the critical path: classify after delivery and update the
  // row only if it isn't the already-stored default. Best-effort — any failure
  // (incl. a missing AI binding) is swallowed so it never affects delivery.
  ctx.waitUntil(
    (async () => {
      try {
        const category = await classifyMessage(env, { from, subject, snippet });
        if (category !== "primary") {
          await env.DB.prepare(`UPDATE messages SET category=? WHERE id=?`).bind(category, id).run();
        }
      } catch (e) {
        console.error("classify failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    })(),
  );

  // Off the critical path: apply inbox filters, then notify — but skip the push
  // for mail a filter auto-filed (archived/trashed) so auto-sorted clutter is
  // silent. Best-effort; never affects delivery.
  ctx.waitUntil(
    (async () => {
      try {
        const { leftInbox } = await applyFilters(env, threadId, { from, to, subject }, Date.now());
        if (leftInbox) return;
        await sendPushToAll(env, {
          // Clamp attacker-controlled fields so the encrypted payload stays well
          // under push-service size limits (a single aes128gcm record).
          title: clampUtf8(senderName(from) || "New mail", 100),
          body: clampUtf8(subject, 300),
          url: "/",
          tag: threadId,
        });
      } catch (e) {
        console.error("filters/push failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    })(),
  );
}

/** Display name for a "Name <addr>" sender, falling back to the bare address. */
function senderName(from: string): string {
  const s = (from || "").trim();
  const m = s.match(/^(.*?)<[^>]*>\s*$/);
  const name = m?.[1].trim();
  if (name) return name;
  const addr = s.match(/<([^>]*)>/)?.[1];
  return addr || s;
}

// ---------------------------------------------------------------- HTTP API
export async function handleFetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // With run_worker_first: ["/api/*"], only /api/* reaches the Worker; every
  // other path is served by Workers Assets (SPA fallback to index.html). If a
  // non-/api path somehow arrives here, return a JSON 404 — never index.html.
  if (!path.startsWith("/api/")) return json({ error: "not found" }, 404);

  // /api/media — token-authorized image media for the sandboxed email iframe.
  // Intentionally handled BEFORE the Access gate: it carries no ambient
  // authority, only an unforgeable short-lived message-bound token. GET only.
  if (path === "/api/media" && request.method === "GET") {
    const secret = mediaSecret(env);
    if (!secret) return new Response("forbidden", { status: 403 });
    const token = url.searchParams.get("t") || "";
    const payload = await verifyMediaToken(secret, token);
    if (!payload) return new Response("forbidden", { status: 403 });
    if (payload.kind === "cid") {
      const obj = await env.MAILSTORE.get(`att/${payload.m}/${payload.ref}`);
      if (!obj) return new Response("not found", { status: 404 });
      const type = (obj.httpMetadata?.contentType || "").toLowerCase();
      if (!RASTER_TYPES.has(type)) return new Response("unsupported", { status: 415 });
      return new Response(obj.body, {
        headers: {
          "Content-Type": type,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'",
          "Cache-Control": `private, max-age=${MEDIA_TTL_SECONDS}`,
        },
      });
    }
    // remote: SSRF-guarded proxy. proxyRemoteImage already buffers the body under
    // its abort deadline + byte cap and returns controlled headers, so a slow or
    // oversized upstream is a clean 502 (never a half-sent or hanging body).
    return proxyRemoteImage(payload.ref);
  }

  const who = await verifyAccess(request, env);
  if (!who) return json({ error: "unauthorized" }, 401);

  // CSRF defense for cookie/Access-authenticated mutations. Access cookies are
  // SameSite=None, so a cross-origin form/fetch could otherwise ride the user's
  // session. Require a same-origin Origin/Referer on state-changing methods.
  // Bearer ("api-token") automation is exempt — it carries no ambient cookie, so
  // it isn't a CSRF vector, and non-browser clients send no Origin.
  if (who !== "api-token" && request.method !== "GET" && request.method !== "HEAD") {
    if (!isSameOrigin(request, url)) return json({ error: "bad origin" }, 403);
  }

  // GET /api/me — validated identity from the Access JWT (or "api-token" bearer).
  if (path === "/api/me" && request.method === "GET") {
    return json({ email: who === "api-token" ? null : who });
  }

  // POST /api/messages/mutate (bulk) — must be BEFORE the /api/messages/:id regex
  if (path === "/api/messages/mutate" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { threadIds?: unknown; action?: unknown };
    if (!isMailAction(b.action)) return json({ error: "invalid action" }, 400);
    if (!Array.isArray(b.threadIds) || b.threadIds.some((x) => typeof x !== "string")) {
      return json({ error: "threadIds must be string[]" }, 400);
    }
    if (b.threadIds.length > 200) return json({ error: "too many threadIds (max 200)" }, 400);
    try {
      const r = await mutateThreads(env, b.threadIds as string[], b.action, Date.now());
      return json({ ok: true, count: r.count });
    } catch (e) { return json({ error: e instanceof Error ? e.message : "mutate failed" }, 400); }
  }

  // GET /api/messages?view=inbox&q=
  // With a query, search is GLOBAL full-text (FTS5, relevance-ranked, across all
  // non-trash mail) and the view is ignored. Without one, it's the normal
  // per-view conversation list.
  if (path === "/api/messages" && request.method === "GET") {
    const viewParam = url.searchParams.get("view") || "inbox";
    if (!isView(viewParam)) return json({ error: "invalid view" }, 400);
    const q = url.searchParams.get("q")?.trim() || undefined;
    const categoryParam = url.searchParams.get("category") || undefined;
    const category = isCategory(categoryParam) ? categoryParam : undefined;
    // Optional per-domain narrowing (ignored while searching, like category).
    // A present-but-invalid domain is a 400, not a silent unfiltered list.
    const domainParam = url.searchParams.get("domain");
    if (domainParam !== null && !isDomainName(domainParam)) return json({ error: "invalid domain" }, 400);
    const domain = domainParam ?? undefined;
    const threads = q
      ? await searchThreads(env, q)
      : await listThreadsByView(
          env,
          viewParam,
          200,
          category,
          domain,
          // Legacy rows predate the domain column; they belong to the default
          // inbox domain, so filtering by it must include NULL.
          !!domain && domain.toLowerCase() === (env.INBOX_DOMAIN || "").toLowerCase(),
        );
    const counts = await countsByView(env);
    return json({ threads, user: who, unread: counts.inboxUnread });
  }

  // POST /api/admin/reindex — rebuild the full-text index from R2 bodies. Behind
  // Access like everything here; idempotent. Run once after the FTS migration to
  // backfill full body text for pre-existing mail.
  if (path === "/api/admin/reindex" && request.method === "POST") {
    const r = await reindexAll(env);
    return json({ ok: true, indexed: r.indexed });
  }

  // GET /api/messages/:id/body?images=1 — force-shown body variant (one-time
  // "Display images" click). Always no-store (embeds bearer media tokens).
  let mb = path.match(/^\/api\/messages\/([^/]+)\/body$/);
  if (mb && request.method === "GET") {
    const row = await env.DB.prepare(`SELECT id, msg_from, dmarc_pass FROM messages WHERE id=?`).bind(mb[1]).first<any>();
    if (!row) return json({ error: "not found" }, 404);
    const obj = await env.MAILSTORE.get(`parsed/${mb[1]}.json`);
    const body = obj ? ((await obj.json()) as any) : { html: "", text: "", attachments: [] };
    const show = url.searchParams.get("images") === "1";
    const { html, blockedRemoteCount } = await rewriteMessageHtml(env, String(row.id), body.html || "", body.attachments || [], show);
    return new Response(JSON.stringify({ html, remoteShown: show, remoteImageCount: blockedRemoteCount }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // GET /api/messages/:id
  let m = path.match(/^\/api\/messages\/([^/]+)$/);
  if (m && request.method === "GET") {
    const row = await env.DB.prepare(`SELECT * FROM messages WHERE id=?`).bind(m[1]).first();
    if (!row) return json({ error: "not found" }, 404);
    const obj = await env.MAILSTORE.get(`parsed/${m[1]}.json`);
    const body = obj ? await obj.json() : { text: "", html: "", attachments: [] };
    return json({ message: row, body });
  }

  // GET /api/threads/:id — all messages (inbox+sent) in the thread, ordered
  // oldest→newest, each with its body for the conversation reader.
  m = path.match(/^\/api\/threads\/([^/]+)$/);
  if (m && request.method === "GET") {
    let threadId: string;
    // thread_ids are RFC Message-IDs (<...@host>), so the client percent-encodes
    // them; decode before the DB lookup or every thread comes back empty.
    try {
      threadId = decodeURIComponent(m[1]);
    } catch {
      return json({ error: "bad request" }, 400);
    }
    const thread = await getThread(env, threadId);
    const allowCache = new Map<string, boolean>();
    const messages = await Promise.all(thread.messages.map(async (msg: any) => {
      const html = msg.body?.html || "";
      // Match the allowlist against the AUTHENTICATED sender mailbox (from_addr),
      // never the spoofable rendered msg_from. Pre-existing rows have no from_addr
      // → fail closed (not allowlisted, so remote images stay blocked).
      const fromAddr = String(msg.from_addr || "");
      const dmarcPass = (msg.dmarc_pass ?? 0) as 0 | 1;
      let allowed = allowCache.get(fromAddr);
      if (allowed === undefined) {
        allowed = fromAddr ? await isSenderAllowed(env, fromAddr) : false;
        allowCache.set(fromAddr, allowed);
      }
      const show = messageImagePolicy({ allowed, dmarcPass });
      const { html: rewritten, blockedRemoteCount } = await rewriteMessageHtml(env, String(msg.id), html, msg.body?.attachments || [], show);
      return { ...msg, body: { ...msg.body, html: rewritten }, remoteImageCount: blockedRemoteCount, remoteShown: show };
    }));
    return json({ thread_id: thread.thread_id, messages });
  }

  // POST /api/threads/:id/mutate
  m = path.match(/^\/api\/threads\/([^/]+)\/mutate$/);
  if (m && request.method === "POST") {
    let threadId: string;
    try { threadId = decodeURIComponent(m[1]); } catch { return json({ error: "bad request" }, 400); }
    const b = (await request.json().catch(() => ({}))) as { action?: unknown };
    if (!isMailAction(b.action)) return json({ error: "invalid action" }, 400);
    try { await mutateThread(env, threadId, b.action, Date.now()); }
    catch (e) { return json({ error: e instanceof Error ? e.message : "mutate failed" }, 400); }
    return json({ ok: true });
  }

  // POST /api/threads/:id/summarize — Workers AI summary of the conversation.
  m = path.match(/^\/api\/threads\/([^/]+)\/summarize$/);
  if (m && request.method === "POST") {
    let threadId: string;
    try { threadId = decodeURIComponent(m[1]); } catch { return json({ error: "bad request" }, 400); }
    const thread = await getThread(env, threadId);
    if (!thread.messages.length) return json({ error: "empty thread" }, 404);
    try {
      // getThread types rows loosely (spread of Record<string,unknown>); the rows
      // do carry direction/msg_from/subject/date/body at runtime.
      const messages = thread.messages as unknown as Parameters<typeof summarizeThread>[1];
      const subject = (thread.messages[0] as { subject?: string }).subject || "";
      const summary = await summarizeThread(env, messages, subject);
      return json({ ok: true, summary });
    } catch (e) {
      // Log the real error server-side; don't leak model/binding internals to the
      // client (the UI shows a generic retry message regardless).
      console.error("summarize failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "summary failed" }, 502);
    }
  }

  // POST /api/threads/:id/draft-reply — Workers AI drafts a reply to the thread.
  m = path.match(/^\/api\/threads\/([^/]+)\/draft-reply$/);
  if (m && request.method === "POST") {
    let threadId: string;
    try { threadId = decodeURIComponent(m[1]); } catch { return json({ error: "bad request" }, 400); }
    const thread = await getThread(env, threadId);
    if (!thread.messages.length) return json({ error: "empty thread" }, 404);
    try {
      const messages = thread.messages as unknown as Parameters<typeof draftReply>[1];
      const subject = (thread.messages[0] as { subject?: string }).subject || "";
      const draft = await draftReply(env, messages, subject);
      return json({ ok: true, draft });
    } catch (e) {
      console.error("draft-reply failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "draft failed" }, 502);
    }
  }

  // GET /api/domains — read-only list of the account's zones for the Domains
  // admin dashboard. Per-zone routing detail is fetched lazily (below).
  if (path === "/api/domains" && request.method === "GET") {
    try {
      const domains = await listDomains(env);
      // inboxWorker lets the UI recognize "catch-all → this inbox" without
      // hard-coding the Worker's name client-side.
      return json({ domains, inboxWorker: env.INBOX_WORKER_NAME || null });
    } catch (e) {
      if (e instanceof CfNotConfigured) return json({ error: "domains admin not configured" }, 503);
      console.error("list domains failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "failed to list domains" }, 502);
    }
  }

  // GET /api/domains/:zoneId?name= — read-only Email Routing detail for one zone
  // (settings, custom rules, catch-all, verified destinations, MX).
  m = path.match(/^\/api\/domains\/([A-Za-z0-9]+)$/);
  if (m && request.method === "GET") {
    const zoneId = m[1];
    const name = url.searchParams.get("name") || "";
    try {
      const detail = await getDomainDetail(env, zoneId, name);
      return json({ detail });
    } catch (e) {
      if (e instanceof CfNotConfigured) return json({ error: "domains admin not configured" }, 503);
      console.error("domain detail failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "failed to load domain" }, 502);
    }
  }

  // PUT /api/domains/:zoneId/catch-all {action:"forward"|"drop", forwardTo?} —
  // the catch-all is the ONLY routing write (no DNS changes). Forwarding target
  // must be a verified destination AND the zone must belong to this account
  // (both enforced server-side).
  m = path.match(/^\/api\/domains\/([A-Za-z0-9]+)\/catch-all$/);
  if (m && request.method === "PUT") {
    const b = (await request.json().catch(() => ({}))) as { action?: unknown; forwardTo?: unknown };
    if (b.action !== "forward" && b.action !== "drop") return json({ error: "invalid action" }, 400);
    const forwardTo = typeof b.forwardTo === "string" ? b.forwardTo : undefined;
    try {
      // Ownership guard: never mutate a zone outside this account's set, even
      // though the token could technically reach it.
      if (!(await zoneInAccount(env, m[1]))) return json({ error: "unknown domain" }, 404);
      const r = await setCatchAll(env, m[1], { action: b.action, forwardTo });
      return r.ok ? json({ ok: true }) : json({ error: r.error || "update failed" }, 400);
    } catch (e) {
      if (e instanceof CfNotConfigured) return json({ error: "domains admin not configured" }, 503);
      console.error("set catch-all failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "failed to update catch-all" }, 502);
    }
  }

  // POST /api/domains/:zoneId/receiving {mode:"inbox"|"forward"|"drop", forwardTo?}
  // One-click receiving onboarding. Enables Email Routing when needed — but ONLY
  // for zones with no foreign apex MX (we never displace a live mail provider;
  // those get a 409 and stay locked) — then points the catch-all at this Worker,
  // a verified forward destination, or drop, and records the mode in the
  // registry. Reversible: re-run with another mode.
  m = path.match(/^\/api\/domains\/([A-Za-z0-9]+)\/receiving$/);
  if (m && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { mode?: unknown; forwardTo?: unknown };
    const mode = b.mode;
    if (mode !== "inbox" && mode !== "forward" && mode !== "drop") return json({ error: "invalid mode" }, 400);
    const forwardTo = typeof b.forwardTo === "string" ? b.forwardTo : undefined;
    // Fail closed when this Worker's own name isn't configured — guessing a
    // catch-all target could silently black-hole a domain's mail.
    if (mode === "inbox" && !env.INBOX_WORKER_NAME) {
      return json({ error: "inbox worker name not configured" }, 503);
    }
    try {
      const zone = await findZone(env, m[1]);
      if (!zone) return json({ error: "unknown domain" }, 404);
      // STRICT reads before any mutation: a failed routing/MX read THROWS and we
      // bail with 502 — never "couldn't read, assume safe".
      const routing = await getRoutingStrict(env, m[1]);
      const routingActive = !!routing?.enabled && routing.status === "ready";
      if (!routingActive) {
        const mx = await getMxStrict(env, m[1]);
        if (hasForeignApexMx(mx, zone.name)) {
          return json(
            { error: `Mail for ${zone.name} is handled by another provider (its MX records point elsewhere). Receiving here is locked so that mail keeps working.` },
            409,
          );
        }
        // Only never-provisioned or cleanly-disabled zones are enable candidates.
        // Anything half-set-up (enabled-but-not-ready, misconfigured, unknown)
        // needs eyes in the Cloudflare dashboard, not another DNS mutation.
        const enableCandidate = routing === null || !routing.enabled;
        if (!enableCandidate) {
          return json(
            { error: `Email Routing for ${zone.name} is in state "${routing?.status}" — review it in the Cloudflare dashboard first.` },
            409,
          );
        }
        const en = await enableRouting(env, m[1]);
        if (!en.ok) return json({ error: en.error || "couldn't enable Email Routing" }, 502);
      }
      const r = await setCatchAll(
        env,
        m[1],
        mode === "inbox"
          ? { action: "worker", workerName: env.INBOX_WORKER_NAME }
          : mode === "forward"
            ? { action: "forward", forwardTo }
            : { action: "drop" },
      );
      if (!r.ok) return json({ error: r.error || "update failed" }, 400);
      await upsertDomain(
        env,
        { domain: zone.name, zoneId: zone.zoneId, receiveMode: mode === "drop" ? "off" : mode },
        Date.now(),
      );
      return json({ ok: true });
    } catch (e) {
      if (e instanceof CfNotConfigured) return json({ error: "domains admin not configured" }, 503);
      console.error("connect receiving failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "failed to update receiving" }, 502);
    }
  }

  // POST /api/domains/:zoneId/sending {variant?:"apex"|"subdomain"} — one-click
  // sending onboarding. Onboards the apex (default) or send.<apex> for Email
  // Sending (records live on cf-bounce.* / _dmarc — no apex MX involved, so this
  // is safe even for zones whose receiving is handled elsewhere), reconciles the
  // expected DNS records CREATE-only, and registers the identity so it appears
  // in the compose From picker. Idempotent.
  m = path.match(/^\/api\/domains\/([A-Za-z0-9]+)\/sending$/);
  if (m && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { variant?: unknown };
    const variant = b.variant === "subdomain" ? "subdomain" : "apex";
    try {
      const zone = await findZone(env, m[1]);
      if (!zone) return json({ error: "unknown domain" }, 404);
      const target = variant === "subdomain" ? `send.${zone.name}` : zone.name;
      // STRICT MX read up front: it decides the DMARC policy below, and a read
      // failure must abort before any mutation (fail closed).
      const externalMx = hasForeignApexMx(await getMxStrict(env, m[1]), zone.name);
      const ob = await onboardSending(env, m[1], target);
      if (!ob.ok) return json({ error: ob.error || "couldn't enable sending" }, 502);
      if (!ob.id) return json({ error: "couldn't resolve the sending domain — try again" }, 502);
      // Reconcile DNS. Any failure (list/read/create) means the domain is NOT
      // verified-sendable yet, so we do NOT register the identity — onboarding
      // is idempotent, re-running converges. For zones whose mail is hosted
      // elsewhere we never create a DMARC policy on their behalf.
      let dns: { created: number; skipped: number; errors: string[] };
      try {
        dns = await ensureDnsRecords(env, m[1], await getSendingDns(env, m[1], ob.id), {
          skipDmarc: externalMx,
        });
      } catch {
        return json(
          { error: "sending was onboarded but its DNS records couldn't be verified — try again" },
          502,
        );
      }
      if (dns.errors.length) {
        return json({ error: `some sending DNS records couldn't be created: ${dns.errors.join("; ")}`, dns }, 502);
      }
      await upsertDomain(env, { domain: zone.name, zoneId: zone.zoneId, sendingDomain: target }, Date.now());
      return json({ ok: true, sendingDomain: target, dns, dmarcSkipped: externalMx });
    } catch (e) {
      if (e instanceof CfNotConfigured) return json({ error: "domains admin not configured" }, 503);
      console.error("connect sending failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "failed to enable sending" }, 502);
    }
  }

  // ---- Per-address forwarding rules ----
  // POST /api/domains/:zoneId/rules {local, action:"forward"|"inbox"|"drop", forwardTo?}
  // Creates a rule matching local@<zone>. The matched address is built
  // server-side from the zone's own name, so a rule can never target another
  // domain; forward targets are re-validated against verified destinations.
  m = path.match(/^\/api\/domains\/([A-Za-z0-9]+)\/rules$/);
  if (m && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as {
      local?: unknown;
      action?: unknown;
      forwardTo?: unknown;
    };
    const local = typeof b.local === "string" ? b.local.trim().toLowerCase() : "";
    if (!/^[a-z0-9._+-]{1,64}$/.test(local)) return json({ error: "invalid address" }, 400);
    if (b.action !== "forward" && b.action !== "inbox" && b.action !== "drop") {
      return json({ error: "invalid action" }, 400);
    }
    if (b.action === "inbox" && !env.INBOX_WORKER_NAME) {
      return json({ error: "inbox worker name not configured" }, 503);
    }
    try {
      const zone = await findZone(env, m[1]);
      if (!zone) return json({ error: "unknown domain" }, 404);
      const r = await createRule(
        env,
        m[1],
        {
          to: `${local}@${zone.name}`,
          action: b.action === "inbox" ? "worker" : b.action,
          forwardTo: typeof b.forwardTo === "string" ? b.forwardTo : undefined,
          workerName: env.INBOX_WORKER_NAME,
        },
        Date.now(),
      );
      return r.ok ? json({ ok: true, id: r.id }) : json({ error: r.error || "rule create failed" }, 400);
    } catch (e) {
      if (e instanceof CfNotConfigured) return json({ error: "domains admin not configured" }, 503);
      console.error("create rule failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "failed to create rule" }, 502);
    }
  }

  // PATCH /api/domains/:zoneId/rules/:ruleId {enabled} · DELETE — toggle/remove a rule.
  m = path.match(/^\/api\/domains\/([A-Za-z0-9]+)\/rules\/([A-Za-z0-9]+)$/);
  if (m && (request.method === "PATCH" || request.method === "DELETE")) {
    try {
      const zone = await findZone(env, m[1]);
      if (!zone) return json({ error: "unknown domain" }, 404);
      if (request.method === "DELETE") {
        const r = await deleteRule(env, m[1], m[2], {
          zoneName: zone.name,
          workerName: env.INBOX_WORKER_NAME,
        });
        return r.ok ? json({ ok: true }) : json({ error: r.error || "rule delete failed" }, 400);
      }
      const b = (await request.json().catch(() => ({}))) as { enabled?: unknown };
      if (typeof b.enabled !== "boolean") return json({ error: "enabled must be boolean" }, 400);
      const r = await setRuleEnabled(env, m[1], m[2], b.enabled, {
        zoneName: zone.name,
        workerName: env.INBOX_WORKER_NAME,
      });
      return r.ok ? json({ ok: true }) : json({ error: r.error || "rule update failed" }, 400);
    } catch (e) {
      if (e instanceof CfNotConfigured) return json({ error: "domains admin not configured" }, 503);
      console.error("rule mutate failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "failed to update rule" }, 502);
    }
  }

  // POST /api/destinations {email} — register a forwarding destination;
  // Cloudflare emails it a verification link.
  if (path === "/api/destinations" && request.method === "POST") {
    // Each call makes Cloudflare email a verification link — rate-limit so the
    // endpoint can't be scripted into a verification-spam cannon.
    if (!takeToken(destinationBuckets, who, Date.now(), 5, 0.2)) {
      return json({ error: "too many destination requests — try again shortly" }, 429);
    }
    const b = (await request.json().catch(() => ({}))) as { email?: unknown };
    const email = typeof b.email === "string" ? b.email.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid email" }, 400);
    try {
      const r = await createDestination(env, email);
      return r.ok ? json({ ok: true }) : json({ error: r.error || "destination create failed" }, 400);
    } catch (e) {
      if (e instanceof CfNotConfigured) return json({ error: "domains admin not configured" }, 503);
      console.error("destination create failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "failed to add destination" }, 502);
    }
  }

  // GET (registry settings) / PATCH /api/domains/:zoneId/settings — per-domain
  // inbox settings. forwardCopyTo: null = global default, "" = off, address =
  // copy there (must be a VERIFIED destination — message.forward() refuses
  // anything else at delivery time, which would silently kill the copy).
  // displayName: the identity's From name on outgoing mail; null = derived
  // default. PATCH is partial — only the fields present in the body change.
  m = path.match(/^\/api\/domains\/([A-Za-z0-9]+)\/settings$/);
  if (m && request.method === "GET") {
    try {
      const zone = await findZone(env, m[1]);
      if (!zone) return json({ error: "unknown domain" }, 404);
      const row = await getDomainRow(env, zone.name);
      return json({
        forwardCopyTo: row?.forward_copy_to ?? null,
        forwardCopyDefault: env.FORWARD_COPY_TO || null,
        displayName: row?.display_name ?? null,
        displayNameDefault: defaultDisplayName(zone.name),
      });
    } catch (e) {
      if (e instanceof CfNotConfigured) return json({ error: "domains admin not configured" }, 503);
      console.error("settings read failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "failed to load settings" }, 502);
    }
  }
  if (m && request.method === "PATCH") {
    const b = (await request.json().catch(() => ({}))) as {
      forwardCopyTo?: unknown;
      displayName?: unknown;
    };
    const hasCopy = Object.prototype.hasOwnProperty.call(b, "forwardCopyTo");
    const hasName = Object.prototype.hasOwnProperty.call(b, "displayName");
    if (!hasCopy && !hasName) return json({ error: "no settings provided" }, 400);
    const v = b.forwardCopyTo;
    if (hasCopy && v !== null && typeof v !== "string") {
      return json({ error: "forwardCopyTo must be string or null" }, 400);
    }
    if (hasName && b.displayName !== null && typeof b.displayName !== "string") {
      return json({ error: "displayName must be string or null" }, 400);
    }
    try {
      const zone = await findZone(env, m[1]);
      if (!zone) return json({ error: "unknown domain" }, 404);
      if (hasCopy) {
        if (typeof v === "string" && v !== "") {
          // Must be a verified destination or the copy would silently fail.
          const detail = await getDomainDetail(env, m[1], zone.name);
          const ok = detail.destinations.some((d) => d.email.toLowerCase() === v.toLowerCase() && d.verified);
          if (!ok) return json({ error: "destination is not a verified address" }, 400);
        }
        await setDomainForwardCopy(env, zone.name, v as string | null, Date.now());
      }
      if (hasName) {
        // Stored pre-sanitized; "" (or a string that sanitizes away) clears the
        // profile back to the derived default.
        const name = typeof b.displayName === "string" ? sanitizeFromName(b.displayName) : "";
        await setDomainDisplayName(env, zone.name, name || null, Date.now());
      }
      return json({ ok: true });
    } catch (e) {
      if (e instanceof CfNotConfigured) return json({ error: "domains admin not configured" }, 503);
      console.error("settings update failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "failed to update settings" }, 502);
    }
  }

  // POST /api/compose/suggest {subject, text} — Smart Compose: a short AI
  // continuation of the draft. Returns { suggestion } ("" when none). Capped
  // input so a huge body can't blow the model context.
  if (path === "/api/compose/suggest" && request.method === "POST") {
    // Defense-in-depth rate limit (the frontend already debounces). On limit,
    // return an empty suggestion so the client just shows nothing.
    if (!takeToken(suggestBuckets, who, Date.now())) return json({ ok: true, suggestion: "" });
    const b = (await request.json().catch(() => ({}))) as { subject?: unknown; text?: unknown };
    const subject = typeof b.subject === "string" ? b.subject.slice(0, 300) : "";
    const text = typeof b.text === "string" ? b.text.slice(0, 4000) : "";
    try {
      const suggestion = await suggestCompletion(env, subject, text);
      return json({ ok: true, suggestion });
    } catch (e) {
      console.error("suggest failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      // Autocomplete is best-effort; a failure is just "no suggestion".
      return json({ ok: true, suggestion: "" });
    }
  }

  // GET /api/push/key — the VAPID public key the client subscribes with. Require
  // BOTH keys: with only the public key, subscriptions would succeed but no push
  // could ever be sent (sending needs the private key). 503 lets the UI hide the
  // toggle rather than show a false "Notifications on".
  if (path === "/api/push/key" && request.method === "GET") {
    if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return json({ error: "push not configured" }, 503);
    return json({ key: env.VAPID_PUBLIC });
  }

  // POST /api/push/subscribe {endpoint, keys:{p256dh, auth}} — store/refresh a
  // device subscription (idempotent on endpoint).
  if (path === "/api/push/subscribe" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    };
    const endpoint = typeof b.endpoint === "string" ? b.endpoint : "";
    const p256dh = typeof b.keys?.p256dh === "string" ? b.keys.p256dh : "";
    const auth = typeof b.keys?.auth === "string" ? b.keys.auth : "";
    if (!endpoint || !p256dh || !auth) return json({ error: "invalid subscription" }, 400);
    // Restrict to real browser push-service endpoints so this can't be used to
    // make the Worker POST to an arbitrary origin (the endpoint is later fetched
    // in sendPushToAll), and validate the key material is well-formed.
    if (!isAllowedPushEndpoint(endpoint)) return json({ error: "invalid endpoint" }, 400);
    if (!validSubscriptionKeys(p256dh, auth)) return json({ error: "invalid keys" }, 400);
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created) VALUES (?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`,
    )
      .bind(endpoint, p256dh, auth, Date.now())
      .run();
    // Bound table growth: keep only the newest MAX_SUBSCRIPTIONS rows.
    await env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE endpoint NOT IN
         (SELECT endpoint FROM push_subscriptions ORDER BY created DESC LIMIT ?)`,
    )
      .bind(MAX_SUBSCRIPTIONS)
      .run()
      .catch(() => {});
    return json({ ok: true });
  }

  // POST /api/push/unsubscribe {endpoint} — remove a device subscription.
  if (path === "/api/push/unsubscribe" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { endpoint?: unknown };
    const endpoint = typeof b.endpoint === "string" ? b.endpoint : "";
    if (!endpoint) return json({ error: "missing endpoint" }, 400);
    await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?`).bind(endpoint).run();
    return json({ ok: true });
  }

  // GET /api/counts — per-view counts plus per-domain inbox counts for the
  // sidebar's inbox switcher. Registry domains connected for receiving are
  // merged in at zero so a freshly connected domain appears immediately.
  if (path === "/api/counts" && request.method === "GET") {
    const [counts, byDomain, receiving, drafts] = await Promise.all([
      countsByView(env),
      countsByDomain(env),
      listReceivingDomains(env),
      countDrafts(env),
    ]);
    // Legacy rows with no domain ('' group) belong to the original inbox
    // domain — fold them in so those threads stay reachable from the switcher.
    const merged = new Map<string, { domain: string; threads: number; unread: number }>();
    for (const d of byDomain) {
      const key = d.domain || env.INBOX_DOMAIN;
      const cur = merged.get(key);
      merged.set(
        key,
        cur
          ? { domain: key, threads: cur.threads + d.threads, unread: cur.unread + d.unread }
          : { domain: key, threads: d.threads, unread: d.unread },
      );
    }
    for (const d of receiving) {
      if (!merged.has(d)) merged.set(d, { domain: d, threads: 0, unread: 0 });
    }
    const domains = [...merged.values()].sort((a, b) => a.domain.localeCompare(b.domain));
    return json({ ...counts, domains, drafts });
  }

  // ---- Drafts (autosaved compose state) ----
  // GET /api/drafts — newest-first summaries for the Drafts view.
  if (path === "/api/drafts" && request.method === "GET") {
    return json({ drafts: await listDrafts(env) });
  }

  // PUT /api/drafts/:id — idempotent autosave upsert (client-generated id).
  // GET /api/drafts/:id — full draft for resume. DELETE — sent or discarded.
  m = path.match(/^\/api\/drafts\/([A-Za-z0-9-]{8,64})$/);
  if (m && request.method === "PUT") {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const v = validateDraft({ ...b, id: m[1] });
    if ("error" in v) return json({ error: v.error }, 400);
    await putDraft(env, v.draft, Date.now());
    return json({ ok: true });
  }
  if (m && request.method === "GET") {
    const d = await getDraft(env, m[1]);
    if (!d) return json({ error: "not found" }, 404);
    return json({
      id: d.id,
      threadId: d.thread_id,
      inReplyTo: d.in_reply_to,
      to: d.msg_to ?? "",
      subject: d.subject ?? "",
      bodyText: d.body_text ?? "",
      bodyJson: d.body_json ?? "",
      fromLocal: d.from_local ?? "",
      fromDomain: d.from_domain ?? "",
      fromName: d.from_name ?? "",
      updated: d.updated,
    });
  }
  if (m && request.method === "DELETE") {
    await deleteDraft(env, m[1]);
    return json({ ok: true });
  }

  // ---- Per-sender image allowlist ----
  if (path === "/api/senders/images" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { address?: unknown };
    if (typeof b.address !== "string" || !b.address.includes("@")) return json({ error: "invalid address" }, 400);
    await env.DB.prepare(`INSERT INTO image_senders (address, created_at) VALUES (?,?) ON CONFLICT(address) DO NOTHING`)
      .bind(normalizeAddress(b.address), Date.now()).run();
    return json({ ok: true });
  }
  if (path === "/api/senders/images" && request.method === "DELETE") {
    const b = (await request.json().catch(() => ({}))) as { address?: unknown };
    if (typeof b.address !== "string") return json({ error: "invalid address" }, 400);
    await env.DB.prepare(`DELETE FROM image_senders WHERE address=?`).bind(normalizeAddress(b.address)).run();
    return json({ ok: true });
  }

  // ---- Inbox filters/rules ----
  // GET /api/filters — list rules (ordered, bounded).
  if (path === "/api/filters" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, field, op, value, action, enabled, position FROM filters ORDER BY position ASC, created ASC LIMIT ?`,
    )
      .bind(MAX_FILTERS)
      .all();
    return json({ filters: results ?? [] });
  }

  // POST /api/filters {field, op, value, action} — create a rule.
  if (path === "/api/filters" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const value = typeof b.value === "string" ? b.value.trim().slice(0, 200) : "";
    if (!isFilterField(b.field) || !isFilterOp(b.op) || !isFilterAction(b.action) || !value) {
      return json({ error: "invalid filter" }, 400);
    }
    // Cap total rules to bound per-email work.
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM filters`).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_FILTERS) return json({ error: `too many rules (max ${MAX_FILTERS})` }, 400);
    const id = uuid();
    await env.DB.prepare(
      `INSERT INTO filters (id, field, op, value, action, enabled, position, created) VALUES (?,?,?,?,?,1,0,?)`,
    )
      .bind(id, b.field, b.op, value, b.action, Date.now())
      .run();
    return json({ ok: true, id });
  }

  // PATCH /api/filters/:id {enabled} — enable/disable a rule.
  m = path.match(/^\/api\/filters\/([A-Za-z0-9-]+)$/);
  if (m && request.method === "PATCH") {
    const b = (await request.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof b.enabled !== "boolean") return json({ error: "enabled must be boolean" }, 400);
    await env.DB.prepare(`UPDATE filters SET enabled=? WHERE id=?`).bind(b.enabled ? 1 : 0, m[1]).run();
    return json({ ok: true });
  }

  // DELETE /api/filters/:id — remove a rule.
  if (m && request.method === "DELETE") {
    await env.DB.prepare(`DELETE FROM filters WHERE id=?`).bind(m[1]).run();
    return json({ ok: true });
  }

  // GET /api/attachments/:id/:name
  m = path.match(/^\/api\/attachments\/([^/]+)\/(.+)$/);
  if (m && request.method === "GET") {
    let name: string;
    try {
      name = decodeURIComponent(m[2]);
    } catch {
      return json({ error: "bad request" }, 400);
    }
    const parsedObj = await env.MAILSTORE.get(`parsed/${m[1]}.json`);
    const meta = parsedObj ? ((await parsedObj.json()) as { attachments?: { partId?: string; name: string }[] }) : null;
    const rec = meta?.attachments?.find((a) => a.name === name);
    const key = rec?.partId ? `att/${m[1]}/${rec.partId}` : `att/${m[1]}/${name}`; // legacy fallback
    const obj = await env.MAILSTORE.get(key);
    if (!obj) return new Response("not found", { status: 404 });
    return serveAttachment(obj.body, obj.httpMetadata?.contentType, name);
  }

  // GET /api/identities — the From identities compose can send as (registry-
  // backed, env fallback). `defaultDomain` picks the picker's initial selection.
  if (path === "/api/identities" && request.method === "GET") {
    const identities = await listIdentities(env);
    return json({
      identities,
      defaultLocal: env.DEFAULT_FROM_LOCAL || "hello",
      defaultDomain: env.INBOX_DOMAIN,
    });
  }

  // POST /api/send
  if (path === "/api/send" && request.method === "POST") {
    const b = (await request.json()) as Record<string, any>;
    if (!b.to) return json({ error: "missing 'to'" }, 400);
    const toList: string[] = Array.isArray(b.to) ? b.to : String(b.to).split(",").map((s) => s.trim());
    // Resolve the sender identity. The send_email binding only authorizes
    // onboarded Email Sending domains as outbound senders, so the transport From
    // must live on the identity's sending_domain (the apex itself when the apex
    // is onboarded, else send.<apex> with the apex identity on Reply-To — the
    // apex RECEIVES via Email Routing, so replies land back in this inbox).
    // `b.from` ("local@domain") picks a registry identity; absent → the legacy
    // env-default identity with b.fromLocal.
    let sender;
    try {
      sender = await resolveSender(env, b.from, b.fromLocal);
    } catch (e) {
      if (e instanceof SenderError) return json({ error: e.message }, 400);
      throw e;
    }
    const { fromAddr, identityAddr, replyTo } = sender;
    // Sanitize the caller-supplied parent id before it ever becomes an outbound
    // header — rejects CRLF header-injection and malformed values that would
    // fail delivery. Only thread when it survives sanitization.
    const irt = sanitizeMessageId(b.inReplyTo);
    // NOTE: the Workers send_email binding uses `from: { email }` (REST API uses `address`).
    // We do NOT set a Message-ID header: Cloudflare Email Sending treats it as a
    // platform-controlled header and auto-generates it. Setting our own is futile
    // (it's ignored/overridden) and risks the send being rejected. We capture the
    // real Message-ID from send()'s return value and store THAT (below) so a
    // recipient's reply — which references the real id — links back to this thread.
    const headers: Record<string, string> = {};
    if (irt) {
      // References mirrors In-Reply-To (we don't track the full ancestor chain
      // client-side; the root id is enough to thread). Use the sanitized value.
      headers["In-Reply-To"] = irt;
      headers["References"] = irt;
    }
    const msg: Record<string, unknown> = {
      // Per-send name override → identity's profile name → derived default.
      // Sanitized: a raw b.fromName must never carry CR/LF into a header.
      from: { email: fromAddr, name: sanitizeFromName(b.fromName) || sender.displayName },
      to: toList,
      subject: b.subject || "(no subject)",
      text: b.text || "",
      // The Workers send_email binding's structured builder overload accepts
      // `headers: Record<string,string>` (see @cloudflare/workers-types
      // SendEmail), so this is type-safe and won't break the send path.
      headers,
    };
    // Reply-To is only needed when the transport From differs from the identity
    // (send.* setups); apex-onboarded identities reply naturally to From.
    if (replyTo) msg.replyTo = replyTo;
    if (b.html) msg.html = b.html;
    let sendResult: { messageId?: string } | undefined;
    try {
      // send() resolves to an object carrying the platform-assigned messageId.
      sendResult = await env.EMAIL.send(msg);
      console.log(`SEND OK: ${fromAddr} -> ${toList.join(",")}`);
    } catch (e) {
      console.error("EMAIL.send failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "send failed", detail: e instanceof Error ? e.message : String(e) }, 502);
    }
    // Store the REAL Message-ID Cloudflare assigned so reply-linking works. If it's
    // absent at runtime, "" is the correct graceful fallback (this message just
    // won't be a reply-link target) — do NOT throw.
    const sentMessageId = sendResult?.messageId ?? "";
    const id = uuid();
    const snippet = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
    await env.MAILSTORE.put(`parsed/${id}.json`, JSON.stringify({ text: b.text || "", html: b.html || "", attachments: [] }));
    await env.DB.prepare(
      `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, snippet, date, unread, has_attachments, message_id, in_reply_to, state, starred, domain)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(id, b.threadId || id, "out", "sent", identityAddr, toList.join(", "), b.subject || "", snippet, Date.now(), 0, 0, sentMessageId, irt ?? "", "inbox", 0, sender.domain)
      .run();
    // Index the sent message for full-text search (best-effort).
    await ftsUpsert(env, ftsRowFrom({
      id,
      subject: b.subject || "",
      from: identityAddr,
      to: toList.join(", "),
      bodyText: bodyForIndex(b.text || "", b.html || ""),
    }));
    return json({ ok: true, id });
  }

  return json({ error: "not found" }, 404);
}

export default {
  fetch: handleFetch,
  email: handleEmail,
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const r = await purgeOldTrash(env, Date.now());
    console.log(`purge: removed ${r.purged} trashed message(s)`);
  },
};
