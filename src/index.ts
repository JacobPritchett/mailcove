import PostalMime from "postal-mime";
import { verifyAccess, API_TOKEN_PRINCIPAL } from "./auth";
import { suggestContacts, splitAddressList, parseAddressList, formatMailbox, cleanDisplayName } from "./contacts";
import { deriveThreadId, sanitizeMessageId } from "./threading";
import { parseRecipients, recipientText, RecipientError, type Recipient } from "./recipients";
import { storedHeadersFrom, referencesForReply, type StoredHeaders } from "./mailHeaders";
import { getThread, findThreadIdByMessageIds, findSentByMessageId } from "./store";
import { isMailAction, isSnoozeTime, mutateMessage, mutateThread, mutateThreads, purgeOldTrash, drainPendingDeletes, wakeSnoozed } from "./store_mutations";
import {
  isView, isCategory, isDomainName, listThreadsByView, countsByView, countsByDomain,
  parsePageSize, parseCursor, encodeDateCursor, encodeOffsetCursor, listThreadIdsByView, IDS_PAGE_SIZE, type View, type Category, type PageCursor,
} from "./store_views";
import { ftsUpsert, ftsRowFrom, bodyForIndex, searchThreads, searchThreadIds, reindexAll } from "./search";
import { summarizeThread, draftReply, suggestCompletion } from "./ai";
import {
  parseOutboundAttachments,
  AttachmentError,
  storeInboundAttachments,
  type OutboundAttachment,
  type InboundPart,
} from "./attachments";
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
  setDomainSignature,
  sanitizeSignature,
} from "./domains";
import { classifyWithJunk } from "./categorize";
import { addBlocked, blockEntryDomain, countBlocked, isBlocked, shouldAutoJunk, listBlocked, normalizeBlockEntry, isOwnDomain, ownDomains, removeBlocked, MAX_BLOCKED } from "./junk";
import { validateDraft, putDraft, listDrafts, getDraft, deleteDraft, countDrafts, isDraftId } from "./drafts";
import {
  parseDraftAttachments,
  putDraftAttachments,
  getDraftAttachments,
  deleteDraftAttachments,
  parseManifest,
  manifestOf,
  purgeOrphanedDraftAttachments,
} from "./draftAttachments";
import { sendPushToAll, isAllowedPushEndpoint, validSubscriptionKeys, clampUtf8, MAX_SUBSCRIPTIONS } from "./push";
import { normalizeCid, rewriteEmailImages } from "./imageRewrite";
import { htmlToText } from "./htmlText";
import { boundAddressHeaders, rawHeader } from "./rawGuard";
import { trustedAuthVerdicts } from "./authResults";
import { verifyMediaToken, proxyRemoteImage, RASTER_TYPES, MEDIA_TTL_SECONDS, mintMediaToken, MEDIA_KID, validateRemoteUrl } from "./media";

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
  AUTH_TOKEN?: string; // secret — fallback auth for API/automation (FULL access)
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
// …and for recipient suggestions (one query pair per keystroke).
const contactBuckets = new Map<string, Bucket>();
// …and for outbound send. The bearer automation credential drives /api/send
// unattended, so blunt the burst a leaked or looping caller can produce: 20 at
// once, refilling 12/min, keyed per caller and sized well above human compose
// rates. Like the other buckets this is PER-ISOLATE and therefore best-effort —
// a caller spread across cold starts or PoPs gets a fresh allowance each time,
// so treat it as damage limiting, not a guaranteed global send rate. A hard
// ceiling needs durable state (a Durable Object or the rate-limiting binding).
const sendBuckets = new Map<string, Bucket>();
/** Upper bound on recipients per send, so one call cannot fan out to a list. */
const MAX_RECIPIENTS = 50;

/** What a list request asks for, once validated. */
interface ListQuery {
  view: View;
  q: string | undefined;
  category: Category | undefined;
  domain: string | undefined;
  domainIncludesNull: boolean;
  cursor: PageCursor | null;
  offset: number;
  tzOffsetMin: number;
}

/**
 * Read and validate the parameters GET /api/messages and GET /api/messages/ids
 * share. One parser for both, because the ids route promises the same threads
 * as the list: a rule that lived in two places would let them drift.
 */
function parseListQuery(url: URL, env: Env): ListQuery | { error: string } {
  const viewParam = url.searchParams.get("view") || "inbox";
  if (!isView(viewParam)) return { error: "invalid view" };
  const q = url.searchParams.get("q")?.trim() || undefined;
  const categoryParam = url.searchParams.get("category") || undefined;
  const category = isCategory(categoryParam) ? categoryParam : undefined;
  // Optional per-domain narrowing. Search honours it too (the view and the
  // category are ignored while searching; `in:` covers the view).
  // A present-but-invalid domain is a 400, not a silent unfiltered list.
  const domainParam = url.searchParams.get("domain");
  if (domainParam !== null && !isDomainName(domainParam)) return { error: "invalid domain" };
  const domain = domainParam ?? undefined;
  // Legacy rows predate the domain column; they belong to the default inbox
  // domain, so filtering by it must include NULL.
  const domainIncludesNull = !!domain && domain.toLowerCase() === (env.INBOX_DOMAIN || "").toLowerCase();
  // `cursor` is whatever the previous page returned as nextCursor.
  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam ? parseCursor(cursorParam) : null;
  if (cursorParam && (!cursor || (q ? cursor.kind !== "offset" : cursor.kind !== "date"))) {
    return { error: "invalid cursor" };
  }
  const offset = cursor?.kind === "offset" ? cursor.offset : 0;
  // The browser's timezone offset, so before:/after: mean the user's days.
  // Bounded to real offsets (UTC-14..UTC+14); anything else is ignored.
  const tzRaw = url.searchParams.get("tz");
  const tzOffsetMin = tzRaw !== null && /^-?\d{1,3}$/.test(tzRaw) && Math.abs(Number(tzRaw)) <= 840 ? Number(tzRaw) : 0;
  return { view: viewParam, q, category, domain, domainIncludesNull, cursor, offset, tzOffsetMin };
}



/** Test-only: clear the send limiter so each test starts with a full bucket. */
export function resetSendBucketsForTest() {
  sendBuckets.clear();
}

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
 * Content-Disposition for a download. The quoted `filename` is an ASCII
 * fallback with anything that could break out of the quotes replaced; a name
 * with non-ASCII characters also gets RFC 5987 `filename*`, which every current
 * browser prefers. A raw non-ASCII byte in a header is invalid and gets the
 * response rejected by some intermediaries.
 */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  if (ascii === name.replace(/["\\\r\n]/g, "_")) return `attachment; filename="${ascii}"`;
  // encodeURIComponent leaves a few characters RFC 5987 does not allow bare.
  // A lone surrogate makes encodeURIComponent throw, so replace those first.
  const wellFormed = name.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
  const encoded = encodeURIComponent(wellFormed.replace(/[\r\n]/g, "_")).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

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
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": attachmentDisposition(name),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
/** DMARC verdict from a SINGLE Authentication-Results value: 1 only if it was
 *  written by our boundary MX and its own dmarc result is "pass". Parsed
 *  structurally (see authResults.ts); the value also carries sender-chosen text
 *  such as the envelope address, so a search for "dmarc=pass" can be satisfied
 *  by the sender. */
export function parseAuthResults(header: string | null | undefined): 0 | 1 {
  return trustedAuthVerdicts(header).dmarc === "pass" ? 1 : 0;
}

/**
 * Trustworthy DMARC verdict from the message's ordered headers. ONLY the first
 * Authentication-Results header is honored, and only if its authserv-id is our
 * boundary MX (Cloudflare Email Routing), which prepends its result on receipt.
 * A spoofer can embed their own `Authentication-Results: ...; dmarc=pass`, and
 * forwarded mail carries older ones from other hosts lower down; those must be
 * ignored (reading the comma-joined Headers.get() value would let a forged pass
 * override a genuine fail). And if the boundary header is ever absent, the
 * topmost one is the sender's, so the authserv-id check is what keeps it from
 * being believed. postal-mime returns headers top-to-bottom with lowercased
 * keys, so headers[0]-of-kind is the boundary-MX result.
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

function normalizeEnvelopeRecipient(raw: string | null | undefined): string {
  const addr = (raw || "").match(/<([^>]*)>/)?.[1] ?? (raw || "");
  const normalized = addr.trim().toLowerCase();
  return isEmailAddress(normalized) ? normalized : "";
}

function isEmailAddress(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

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

/** How far ahead of our clock a Date header may be before we stop believing it. */
const DATE_SKEW_MS = 5 * 60 * 1000;
/** Characters of body text examined to build the 200-character list snippet. */
const SNIPPET_SCAN_CHARS = 4000;

/**
 * The timestamp to store for an inbound message. The Date header is the
 * sender's claim and every view sorts on this value, so a message dated 2099
 * would sit at the top of the mailbox forever. A date in the future (beyond
 * ordinary clock skew) is replaced by the receipt time. Past dates are kept as
 * sent: late delivery of old mail is normal. Missing or unparseable → receipt.
 */
export function clampInboundDate(headerDate: string | null | undefined, receivedAt: number): number {
  const sent = headerDate ? Date.parse(headerDate) : NaN;
  if (!sent) return receivedAt; // NaN, or the epoch itself
  return sent > receivedAt + DATE_SKEW_MS ? receivedAt : sent;
}

/**
 * Vet a sender-supplied one-click unsubscribe URL before the Worker POSTs to
 * it: https on the default port, a public host (same guard as the image
 * proxy), and never this app itself, so mail cannot make the inbox call its
 * own API.
 */
export function unsubscribeTarget(raw: string, ownHost: string): URL | null {
  const target = validateRemoteUrl(raw);
  if (!target || target.protocol !== "https:" || target.port !== "") return null;
  const host = target.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return null;
  const own = ownHost.toLowerCase();
  if (host === own || host.endsWith(`.${own}`)) return null;
  return target;
}

/**
 * The References header for a reply to `parentId`: the parent's stored ancestor
 * chain plus the parent. Best-effort: any failure degrades to the parent alone,
 * which is what every reply carried before the chain was stored.
 *
 * A Message-ID is chosen by whoever sends the mail, so a stranger can send a
 * message that reuses a real one. The lookup therefore stays inside the thread
 * being replied to, skips trashed mail, and prefers our own sent copy, then a
 * DMARC-passing message, then the newest: a duplicate cannot outrank the
 * message the user is actually answering just by claiming an old date.
 */
async function replyReferences(env: Env, parentId: string, threadId: string): Promise<string> {
  if (!threadId) return parentId;
  try {
    const row = await env.DB.prepare(
      `SELECT id FROM messages
        WHERE message_id=? AND thread_id=? AND state!='trash'
        ORDER BY (direction='out') DESC, dmarc_pass DESC, date DESC LIMIT 1`,
    )
      .bind(parentId, threadId)
      .first<{ id: string }>();
    if (!row) return parentId;
    const obj = await env.MAILSTORE.get(`parsed/${row.id}.json`);
    const body = obj ? ((await obj.json()) as { headers?: StoredHeaders }) : null;
    return referencesForReply(body?.headers?.references, parentId) || parentId;
  } catch {
    return parentId;
  }
}

// ---------------------------------------------------------------- inbound
/** Domain of an envelope or header address. Angle-bracket paths are unwrapped
 *  and the result must look like a hostname — junk never lands in the domain
 *  column (it would poison counts/filters). "" when there is none. */
function domainOfAddress(raw: string): string {
  const addr = raw.match(/<([^>]*)>/)?.[1] ?? raw;
  const at = addr.lastIndexOf("@");
  const d = at >= 0 ? addr.slice(at + 1).trim().toLowerCase() : "";
  return isDomainName(d) ? d : "";
}

/**
 * Non-destructive safety net: keep delivering a copy to a real mailbox.
 * Per-domain override from the registry (NULL = global default, "" = off).
 * Best-effort and never throws — a failed copy must not affect storage, and
 * this runs in a `finally`, where a throw would mask the real error.
 */
/** Pause before the one forward retry. */
const FORWARD_RETRY_DELAY_MS = 400;

async function forwardCopy(message: ForwardableEmailMessage, env: Env, domain: string): Promise<void> {
  try {
    const copyTo = await forwardCopyFor(env, domain, env.FORWARD_COPY_TO);
    if (!copyTo) return;
    // One retry: the copy is the safety net, and the platform sometimes answers
    // a forward with a transient 4xx ("421 ... transient error") that succeeds
    // a moment later.
    try {
      await message.forward(copyTo);
    } catch (e) {
      console.error("forward failed, retrying once:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      await new Promise((r) => setTimeout(r, FORWARD_RETRY_DELAY_MS));
      await message.forward(copyTo);
    }
    console.log(`forwarded copy to ${copyTo}`);
  } catch (e) {
    console.error("forward failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
}

/** What the deferred (post-delivery) work needs to know about a stored message. */
interface StoredInbound {
  threadId: string;
  from: string;
  fromLabel: string;
  /** The From mailbox from the structured parse; "" when unparseable. It is
   *  what the message CLAIMS, not a verified identity. */
  fromAddr: string;
  /** SPF, DKIM or DMARC passed at the boundary MX (and DMARC did not fail). */
  vouchedFor: boolean;
  to: string;
  subject: string;
  snippet: string;
  inboundDomain: string;
}

/** Pause before the one insert retry: long enough for a D1 blip to pass. */
const INSERT_RETRY_DELAY_MS = 50;

async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
  const id = uuid();
  const rawBuf = await new Response(message.raw).arrayBuffer();

  // The forward copy exists for the case where THIS inbox fails to keep the
  // mail, so it must not sit behind the storage it backs up: it used to run
  // after the D1 insert, and a failed insert lost the message AND the copy.
  // Once the raw message is in hand the copy is always attempted, whatever
  // storeInbound does; a throw from it still propagates afterwards.
  let domain = domainOfAddress(message.to || "") || env.INBOX_DOMAIN;
  let stored: StoredInbound;
  try {
    stored = await storeInbound(message, env, id, rawBuf);
    domain = stored.inboundDomain;
  } finally {
    await forwardCopy(message, env, domain);
  }
  const { threadId, from, fromLabel, fromAddr, vouchedFor, to, subject, snippet } = stored;

  // Everything below is off the critical path: the message is stored and the
  // forward copy sent. Best-effort; none of it can affect delivery.
  ctx.waitUntil(
    (async () => {
      const now = Date.now();
      // AI auto-label and junk hint. Started first so it runs alongside the
      // lookups below; any failure (incl. a missing AI binding) leaves the
      // stored default and no hint.
      const verdict = classifyWithJunk(env, { from, subject, snippet }).catch((e: unknown) => {
        console.error("classify failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        return null;
      });
      const logged = (what: string) => (e: unknown) => {
        console.error(`${what} failed:`, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        return null;
      };
      try {
        // Each step fails on its own. A lookup error here must not take the
        // user's rules or the notification for real mail down with it.
        // 1. A blocked sender goes to Junk, no questions asked.
        let filed = false;
        if (fromAddr && (await isBlocked(env, fromAddr).catch(logged("block lookup")))) {
          await mutateMessage(env, id, "spam", now);
          filed = true;
        }
        // 2. The user's own rules. A rule that matched is the user's decision
        //    about this mail, so the automatic verdict below stands aside.
        let ruled = false;
        if (!filed) {
          const { applied, leftInbox } = await applyFilters(env, id, { from, to, subject }, now);
          ruled = applied.length > 0;
          filed = leftInbox;
        }
        // 3. The label, and the junk hint (see src/junk.ts for why acting on
        //    it is this conservative).
        const v = await verdict;
        if (v && v.category !== "primary") {
          await env.DB.prepare(`UPDATE messages SET category=? WHERE id=?`).bind(v.category, id).run().catch(logged("category update"));
        }
        if (!filed && !ruled && v?.junk && (await shouldAutoJunk(env, { vouchedFor, threadId }))) {
          await mutateMessage(env, id, "spam", now);
          filed = true;
        }
        // Auto-filed mail (junk, or archived/trashed by a rule) is silent, and
        // it does not disturb a snooze: only mail that stays in the inbox is a
        // reason to bring the conversation back early.
        if (filed) return;
        await env.DB.prepare(`UPDATE messages SET snoozed_until=NULL, woke_at=? WHERE thread_id=? AND snoozed_until IS NOT NULL`)
          .bind(now, threadId)
          .run()
          .catch(logged("unsnooze on new mail"));
        // Clamp attacker-controlled fields so the encrypted payload stays well
        // under push-service size limits (a single aes128gcm record).
        const payload: Record<string, string> = {
          title: clampUtf8(fromLabel || "New mail", 100),
          body: clampUtf8(subject, 300),
          url: "/",
          tag: clampUtf8(threadId, MAX_PUSH_THREAD_ID_BYTES),
        };
        // The deep-link target. A truncated id opens nothing, so an oversized
        // one (only possible for threads stored before ids were capped) is
        // left out and the notification falls back to opening the inbox.
        if (clampUtf8(threadId, MAX_PUSH_THREAD_ID_BYTES) === threadId) payload.threadId = threadId;
        await sendPushToAll(env, payload);
      } catch (e) {
        console.error("filters/push failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    })(),
  );
}

/**
 * The thread of the SENT copy of an inbound message, when that message is our
 * own mail coming back: something sent from here to one of our own addresses
 * arrives carrying the Message-ID the platform assigned on the way out, which
 * is stored on the sent row. Without this the inbound copy starts a second
 * thread beside the sent one.
 *
 * A Message-ID is not a secret (every recipient of that mail has it), so the
 * id alone must not admit a message to the thread. The caller requires a DMARC
 * pass, and here the authenticated From has to be the address that sent the
 * stored row: its identity, or that identity's transport address (send.*
 * setups put the transport address in From and the identity in Reply-To).
 * Only OUTBOUND rows are considered.
 */
async function ownSentThreadId(env: Env, messageId: string | null, fromAddr: string): Promise<string | null> {
  if (!messageId || !fromAddr) return null;
  for (const row of await findSentByMessageId(env.DB, messageId)) {
    const identity = normalizeAddress(row.msg_from || "");
    if (!identity) continue;
    if (identity === fromAddr) return row.thread_id;
    try {
      const sender = await resolveSender(env, identity, undefined);
      if (sender.fromAddr.toLowerCase() === fromAddr) return row.thread_id;
    } catch {
      // identity no longer registered for sending: not a match
    }
  }
  return null;
}

/**
 * The delivery-critical half of ingest: store the raw message, parse it, store
 * body and attachments, insert the row, index it. A raw-write or parse failure
 * throws (the caller still sends the forward copy).
 */
async function storeInbound(
  message: ForwardableEmailMessage,
  env: Env,
  id: string,
  rawBuf: ArrayBuffer,
): Promise<StoredInbound> {
  await env.MAILSTORE.put(`raw/${id}.eml`, rawBuf);

  // Parse a copy whose address headers are bounded (rawGuard.ts): the parser
  // is quadratic in them. And if it still cannot read the message, file it
  // anyway. The original is stored above and can be downloaded, which beats a
  // message that exists in R2 and nowhere the user can see.
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  let unreadable = false;
  try {
    parsed = await PostalMime.parse(boundAddressHeaders(rawBuf));
  } catch (e) {
    console.error(`inbound ${id}: could not parse, filing as unreadable:`, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    unreadable = true;
    parsed = {
      subject: rawHeader(rawBuf, "subject"),
      text: "This message could not be read. Download the original to see it.",
      headers: [],
      attachments: [],
    } as unknown as Awaited<ReturnType<typeof PostalMime.parse>>;
  }
  const subject = parsed.subject || (unreadable ? "(unreadable message)" : "(no subject)");
  // A display name carrying a comma or other RFC 5322 special is stored quoted
  // (see formatMailbox); bare, `Doe, John <addr>` parses downstream as two
  // entries and the sender shows up as "John".
  const from = parsed.from?.address
    ? formatMailbox(parsed.from.name, parsed.from.address)
    : message.from;
  // The notification title, taken from the structured parse rather than
  // re-parsed out of the rendered string above.
  const fromLabel = cleanDisplayName(parsed.from?.name) || parsed.from?.address || message.from;
  const to = (parsed.to || []).map((a) => a.address).join(", ") || message.to;
  const cc = (parsed.cc || []).map((a) => a.address).join(", ");
  const html = parsed.html || "";
  // postal-mime yields no text for a message whose only body is text/html, and
  // most commercial mail is exactly that. Derive it (linear and bounded, see
  // htmlToText) so the snippet, the search index, the AI transcript and reply
  // quoting all see the words rather than nothing or the stylesheet.
  const hasTextPart = !!(parsed.text && parsed.text.trim());
  const text = hasTextPart ? (parsed.text as string) : htmlToText(html);
  // Flag text we derived. It carries link TEXT but not link destinations, so a
  // client choosing between `text` and `html` must not mistake it for a text
  // part the sender wrote.
  const textDerived = !hasTextPart && text !== "";
  const snippet = text.trimStart().slice(0, SNIPPET_SCAN_CHARS).replace(/\s+/g, " ").trim().slice(0, 200);
  const dateMs = clampInboundDate(parsed.date, Date.now());
  const messageId = parsed.messageId || "";
  const inReplyTo = parsed.inReplyTo || "";
  // postal-mime exposes References as a single space-separated string.
  const references = parsed.references;

  // Bounded and best-effort: the message row is inserted BELOW, so anything that
  // throws here would leave the mail in R2 but invisible in the inbox. A crafted
  // message with thousands of parts previously meant that many sequential object
  // writes on the delivery path.
  const stored = await storeInboundAttachments(
    (key, body, opts) => env.MAILSTORE.put(key, body as ArrayBuffer, opts),
    id,
    (parsed.attachments || []) as InboundPart[],
    (att, i) =>
      attachmentRecord(
        {
          filename: att.filename,
          mimeType: att.mimeType,
          size: (att.content as ArrayBuffer)?.byteLength || 0,
          contentId: att.contentId,
          disposition: att.disposition,
        },
        i,
      ),
  );
  const attachments: AttachmentRecord[] = stored.records;
  if (stored.skipped) {
    console.error(`inbound ${id}: ${stored.skipped} attachment(s) not stored (cap or write failure)`);
  }

  // Same reasoning as the attachments above: the row is inserted below, so a
  // failure here must not abort ingest. The message still shows up with subject,
  // sender and date; only the body is unavailable until it is re-fetched.
  try {
    await env.MAILSTORE.put(
      `parsed/${id}.json`,
      // Reply-To, the References chain, List-Unsubscribe and the auth verdicts
      // ride along with the body so the reader can act on them (mailHeaders.ts).
      JSON.stringify({ text, html, attachments, headers: storedHeadersFrom(parsed), ...(textDerived ? { textDerived: true } : {}) }),
    );
  } catch (e) {
    console.error(`inbound ${id}: storing parsed body failed:`, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }

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
  // Trust ONLY the first (boundary-MX) Authentication-Results — not the
  // comma-joined Headers.get() value, which a spoofer could poison with a forged
  // dmarc=pass embedded lower in the message.
  const dmarcPass = dmarcPassFromHeaders(parsed.headers);
  // Did ANY mechanism vouch for this mail at the boundary? Used only to decide
  // whether a junk verdict may act (see shouldAutoJunk): plenty of honest
  // domains publish no DMARC record, so "no DMARC pass" alone proves nothing.
  const auth = trustedAuthVerdicts((parsed.headers || []).find((h) => h.key.toLowerCase() === "authentication-results")?.value);
  const vouchedFor = auth.dmarc === "pass" || (auth.dmarc !== "fail" && (auth.spf === "pass" || auth.dkim === "pass"));
  // Authenticated sender mailbox — the image-allowlist key. Derived from the
  // structured parse (not the spoofable rendered `from` string).
  const fromAddr = normalizeFromAddress(parsed.from);
  // Threading is a nicety; delivery is not. A transient read failure should cost
  // this message its thread link, not its place in the inbox.
  const linked = await (async () => {
    const parent = await findThreadIdByMessageIds(env.DB, candidates);
    if (parent) return parent;
    return dmarcPass === 1 ? await ownSentThreadId(env, sanitizeMessageId(messageId), fromAddr) : null;
  })().catch((e: unknown) => {
    console.error(`inbound ${id}: thread lookup failed:`, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    return null;
  });
  const threadId =
    linked ?? deriveThreadId({ references, inReplyTo, messageId }, id);
  // Derive the domain from the ENVELOPE recipient (RCPT TO) first — it's the
  // address Email Routing actually delivered to, and stays correct for BCC and
  // catch-all mail where the To header points elsewhere. Header To is the
  // fallback, then the default inbox domain.
  const inboundDomain = domainOfAddress(message.to || "") || domainOfAddress(to || "") || env.INBOX_DOMAIN;
  const envelopeTo = normalizeEnvelopeRecipient(message.to);

  // Store with the default category ("primary"); the AI auto-label is computed
  // AFTER delivery (see handleEmail) so a slow/failed inference can never delay
  // or block mail storage + the forward-copy.
  // `envelope_to` arrives in migrations/0019-envelope-to.sql. A Worker deployed
  // ahead of that migration must still file the mail: losing the delivery
  // address is far better than losing the message, so on that one error the
  // row is stored in the older shape (apply the migration to get the column).
  let withEnvelope = true;
  const insertRow = () =>
    env.DB.prepare(
      withEnvelope
        ? `INSERT INTO messages
     (id, thread_id, direction, folder, msg_from, msg_to, msg_cc, subject, snippet, date, unread, has_attachments, message_id, in_reply_to, r2_raw_key, state, starred, domain, envelope_to, category, dmarc_pass, from_addr)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        : `INSERT INTO messages
     (id, thread_id, direction, folder, msg_from, msg_to, msg_cc, subject, snippet, date, unread, has_attachments, message_id, in_reply_to, r2_raw_key, state, starred, domain, category, dmarc_pass, from_addr)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(id, threadId, "in", "inbox", from, to, cc, subject, snippet, dateMs, 1, attachments.length ? 1 : 0, messageId, inReplyTo, `raw/${id}.eml`, "inbox", 0, inboundDomain, ...(withEnvelope ? [envelopeTo] : []), "primary", dmarcPass, fromAddr)
      .run();
  const insert = async () => {
    try {
      return await insertRow();
    } catch (e) {
      if (!withEnvelope || !/no (such )?column( named)?:? *envelope_to/i.test(e instanceof Error ? e.message : String(e))) throw e;
      console.error(`inbound ${id}: messages.envelope_to is missing (migration 0019 not applied); storing without it`);
      withEnvelope = false;
      return await insertRow();
    }
  };
  // This row is the only thing that makes the mail visible, and D1 does drop
  // the odd request. Retry once; a second failure is a real outage and throws.
  try {
    await insert();
  } catch (first) {
    console.error(`inbound ${id}: message insert failed, retrying once:`, first instanceof Error ? `${first.name}: ${first.message}` : String(first));
    await new Promise((resolve) => setTimeout(resolve, INSERT_RETRY_DELAY_MS));
    try {
      await insert();
    } catch (second) {
      // The first attempt may have committed before its response was lost; the
      // retry then collides with the row it wrote, which means it IS stored.
      const reason = second instanceof Error ? second.message : String(second);
      if (!/UNIQUE constraint failed: messages\.id/i.test(reason)) throw second;
    }
  }

  // Index for full-text search (best-effort — never block delivery on this).
  await ftsUpsert(env, ftsRowFrom({ id, subject, from, to, cc, bodyText: bodyForIndex(text, html) }));

  return { threadId, from, fromLabel, fromAddr, vouchedFor, to, subject, snippet, inboundDomain };
}

/** The frequent cron (wrangler.jsonc): wakes snoozed mail, nothing else. */
const SNOOZE_CRON = "*/5 * * * *";

/** Longest thread id (UTF-8 bytes) carried in a push payload; see handleEmail. */
const MAX_PUSH_THREAD_ID_BYTES = 512;

// ---------------------------------------------------------------- HTTP API
export async function handleFetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  // Keep the original per-domain API for service-token automation. The browser
  // uses a separate path under the owner's normal Access application, because
  // a more-specific service-auth application can cover /api/domains/*.
  // Normalize before dispatch so both paths share authentication, CSRF checks,
  // ownership guards, and exactly the same handlers.
  const path = url.pathname.replace(/^\/api\/domain-routing\//, "/api/domains/");

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

  const isBearer = who === API_TOKEN_PRINCIPAL;

  // CSRF defense for cookie/Access-authenticated mutations. Access cookies are
  // SameSite=None, so a cross-origin form/fetch could otherwise ride the user's
  // session. Require a same-origin Origin/Referer on state-changing methods.
  // Bearer automation is exempt — it carries no ambient cookie, so it isn't a
  // CSRF vector, and non-browser clients send no Origin.
  if (!isBearer && request.method !== "GET" && request.method !== "HEAD") {
    if (!isSameOrigin(request, url)) return json({ error: "bad origin" }, 403);
  }

  // GET /api/me — validated identity from the Access JWT (or the bearer principal).
  if (path === "/api/me" && request.method === "GET") {
    return json({ email: isBearer ? null : who });
  }

  // POST /api/messages/mutate (bulk) — must be BEFORE the /api/messages/:id regex
  if (path === "/api/messages/mutate" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { threadIds?: unknown; action?: unknown; until?: unknown };
    if (!isMailAction(b.action)) return json({ error: "invalid action" }, 400);
    if (b.action === "snooze" && !isSnoozeTime(b.until, Date.now())) return json({ error: "snooze needs a time in the future" }, 400);
    if (!Array.isArray(b.threadIds) || b.threadIds.some((x) => typeof x !== "string")) {
      return json({ error: "threadIds must be string[]" }, 400);
    }
    if (b.threadIds.length > 200) return json({ error: "too many threadIds (max 200)" }, 400);
    try {
      const r = await mutateThreads(env, b.threadIds as string[], b.action, Date.now(), b.action === "snooze" ? (b.until as number) : undefined);
      return json({ ok: true, count: r.count });
    } catch (e) { return json({ error: e instanceof Error ? e.message : "mutate failed" }, 400); }
  }

  // GET /api/messages/ids?view=inbox&q= : the thread ids of a whole view or
  // search, for "select all N" across pages. Must be BEFORE the
  // /api/messages/:id regex, which would otherwise read "ids" as a message id.
  // Same parameters and the same order as the list below, so the ids are
  // exactly the threads paging the list would show; what it skips is the
  // display row per thread and the counts query per page. Read-only, and the
  // page size is fixed so one request cannot be asked for the whole mailbox.
  if (path === "/api/messages/ids" && request.method === "GET") {
    const lq = parseListQuery(url, env);
    if ("error" in lq) return json({ error: lq.error }, 400);
    const { view, q, category, domain, domainIncludesNull, cursor, offset, tzOffsetMin } = lq;
    if (q) {
      const ids = await searchThreadIds(env, q, IDS_PAGE_SIZE, { domain, domainIncludesNull, offset, tzOffsetMin });
      return json({ ids, nextCursor: ids.length < IDS_PAGE_SIZE ? null : encodeOffsetCursor(offset + ids.length) });
    }
    const rows = await listThreadIdsByView(env, view, IDS_PAGE_SIZE, category, domain, domainIncludesNull, cursor?.kind === "date" ? cursor.after : undefined);
    const last = rows[rows.length - 1];
    return json({
      ids: rows.map((r) => r.thread_id),
      // A full page means there may be more, as on the list route.
      nextCursor: rows.length < IDS_PAGE_SIZE || !last ? null : encodeDateCursor({ date: last.sort_date, thread_id: last.thread_id }),
    });
  }

  // GET /api/messages?view=inbox&q=
  // With a query, search is GLOBAL full-text (FTS5, relevance-ranked, across all
  // non-trash mail) and the view is ignored. Without one, it's the normal
  // per-view conversation list.
  if (path === "/api/messages" && request.method === "GET") {
    const lq = parseListQuery(url, env);
    if ("error" in lq) return json({ error: lq.error }, 400);
    const { view, q, category, domain, domainIncludesNull, cursor, offset, tzOffsetMin } = lq;
    // Paging. `limit` sizes the page. Without it or a cursor this is the first
    // page at the default size, exactly as before paging existed.
    const limit = parsePageSize(url.searchParams.get("limit"));
    const threads = q
      ? await searchThreads(env, q, limit, { domain, domainIncludesNull, offset, tzOffsetMin })
      : await listThreadsByView(env, view, limit, category, domain, domainIncludesNull, cursor?.kind === "date" ? cursor.after : undefined);
    // A full page means there may be more. An empty next page is the cheap,
    // honest way to find out there was not, rather than a COUNT per request.
    const last = threads[threads.length - 1];
    const nextCursor =
      threads.length < limit || !last ? null : q ? encodeOffsetCursor(offset + threads.length) : encodeDateCursor(last);
    const counts = await countsByView(env);
    return json({ threads, user: who, unread: counts.inboxUnread, nextCursor });
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

  // GET /api/messages/:id/raw: the original message as received, for "show
  // original" and for keeping a copy. Always a download: raw mail is hostile
  // markup, and rendering it same-origin would be an XSS. Sent mail has no raw
  // copy (the platform assembles it), so that is a 404.
  const mr = path.match(/^\/api\/messages\/([^/]+)\/raw$/);
  if (mr && request.method === "GET") {
    const row = await env.DB.prepare(`SELECT id, r2_raw_key FROM messages WHERE id=?`).bind(mr[1]).first<{ id: string; r2_raw_key: string | null }>();
    if (!row?.r2_raw_key) return json({ error: "not found" }, 404);
    const obj = await env.MAILSTORE.get(row.r2_raw_key);
    if (!obj) return json({ error: "not found" }, 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${String(row.id).replace(/[^A-Za-z0-9-]/g, "")}.eml"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  }

  // POST /api/messages/:id/unsubscribe: act on the message's List-Unsubscribe.
  // One-click (RFC 8058) is POSTed from here, so the list never sees the
  // reader's IP or browser. A mailto target gets a mail from the address the
  // list wrote to. Otherwise the link is handed back for the user to open.
  //
  // The header is the sender's own text, so the two automatic paths are only
  // taken for mail that passed DMARC (RFC 8058 asks for as much): without it
  // anyone could make this inbox POST to, or send mail to, a target of their
  // choosing under a forged sender's name. Unauthenticated mail still gets the
  // link, which the user opens knowingly.
  const mu = path.match(/^\/api\/messages\/([^/]+)\/unsubscribe$/);
  if (mu && request.method === "POST") {
    if (!takeToken(sendBuckets, who, Date.now(), 20, 0.2)) return json({ error: "rate limited" }, 429);
    const row = await env.DB.prepare(`SELECT id, envelope_to, domain, dmarc_pass FROM messages WHERE id=? AND direction='in'`)
      .bind(mu[1])
      .first<{ id: string; envelope_to: string | null; domain: string | null; dmarc_pass: number | null }>();
    if (!row) return json({ error: "not found" }, 404);
    const obj = await env.MAILSTORE.get(`parsed/${row.id}.json`);
    const info = obj ? ((await obj.json()) as { headers?: StoredHeaders }).headers?.unsubscribe : undefined;
    if (!info) return json({ error: "this message has no unsubscribe option" }, 404);
    const authenticated = row.dmarc_pass === 1;
    const open = () => (info.url ? json({ ok: true, method: "open", url: info.url }) : null);

    if (authenticated && info.url && info.oneClick) {
      const target = unsubscribeTarget(info.url, url.hostname);
      if (!target) return json({ error: "unsafe unsubscribe address" }, 400);
      try {
        const res = await fetch(target.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
          // Never follow: the guard above only vetted this one URL.
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        void res.body?.cancel();
        if (res.status >= 200 && res.status < 300) return json({ ok: true, method: "one-click" });
        // A redirect is a page to visit (a login, a confirmation), not a done
        // deal. Say so rather than claim the address was removed.
        if (res.status >= 300 && res.status < 400) return open()!;
        return json({ error: `the list refused the request (${res.status})` }, 502);
      } catch (e) {
        console.error("unsubscribe failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        return json({ error: "could not reach the list" }, 502);
      }
    }
    if (authenticated && info.mailto) {
      // Unsubscribe as the address the list actually wrote to; a request from
      // any other address is one the list has no reason to honour. If that
      // address cannot send, do not quietly use a different identity (it would
      // both fail to unsubscribe and tie the two addresses together).
      let sender;
      try {
        if (!row.envelope_to) throw new SenderError("no delivery address on record");
        sender = await resolveSender(env, row.envelope_to, undefined);
      } catch (e) {
        if (!(e instanceof SenderError)) throw e;
        return open() ?? json({ error: "this address cannot send mail, so the unsubscribe request was not sent" }, 409);
      }
      try {
        await env.EMAIL.send({
          from: { email: sender.fromAddr, name: sender.displayName },
          to: info.mailto.address,
          subject: info.mailto.subject,
          text: "unsubscribe",
          ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
        });
        console.log(`UNSUBSCRIBE MAIL: ${sender.identityAddr} -> ${info.mailto.address}`);
        return json({ ok: true, method: "mailto" });
      } catch (e) {
        console.error("unsubscribe mail failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        return json({ error: "could not send the unsubscribe request" }, 502);
      }
    }
    return open() ?? json({ error: "this message could not be verified, so it was not unsubscribed automatically" }, 409);
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
    return json({ thread_id: thread.thread_id, messages, total: thread.total, truncated: thread.truncated });
  }

  // POST /api/threads/:id/mutate
  m = path.match(/^\/api\/threads\/([^/]+)\/mutate$/);
  if (m && request.method === "POST") {
    let threadId: string;
    try { threadId = decodeURIComponent(m[1]); } catch { return json({ error: "bad request" }, 400); }
    const b = (await request.json().catch(() => ({}))) as { action?: unknown; until?: unknown };
    if (!isMailAction(b.action)) return json({ error: "invalid action" }, 400);
    if (b.action === "snooze" && !isSnoozeTime(b.until, Date.now())) return json({ error: "snooze needs a time in the future" }, 400);
    try { await mutateThread(env, threadId, b.action, Date.now(), b.action === "snooze" ? (b.until as number) : undefined); }
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
        signature: row?.signature ?? null,
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
      signature?: unknown;
    };
    const hasCopy = Object.prototype.hasOwnProperty.call(b, "forwardCopyTo");
    const hasName = Object.prototype.hasOwnProperty.call(b, "displayName");
    const hasSig = Object.prototype.hasOwnProperty.call(b, "signature");
    if (!hasCopy && !hasName && !hasSig) return json({ error: "no settings provided" }, 400);
    const v = b.forwardCopyTo;
    if (hasCopy && v !== null && typeof v !== "string") {
      return json({ error: "forwardCopyTo must be string or null" }, 400);
    }
    if (hasName && b.displayName !== null && typeof b.displayName !== "string") {
      return json({ error: "displayName must be string or null" }, 400);
    }
    if (hasSig && b.signature !== null && typeof b.signature !== "string") {
      return json({ error: "signature must be string or null" }, 400);
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
      if (hasSig) {
        // Stored pre-sanitized and plain text; "" clears it.
        const sig = typeof b.signature === "string" ? sanitizeSignature(b.signature) : "";
        await setDomainSignature(env, zone.name, sig || null, Date.now());
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
      cc: d.msg_cc ?? "",
      bcc: d.msg_bcc ?? "",
      subject: d.subject ?? "",
      bodyText: d.body_text ?? "",
      bodyJson: d.body_json ?? "",
      fromLocal: d.from_local ?? "",
      fromDomain: d.from_domain ?? "",
      fromName: d.from_name ?? "",
      attachments: parseManifest(d.attachments),
      updated: d.updated,
    });
  }
  if (m && request.method === "DELETE") {
    // Best-effort on the bytes, unconditional on the row. Discarding a draft
    // must never be blocked by R2 being unavailable - a draft the user cannot
    // get rid of is a worse failure than bytes nobody collects, and deleting an
    // absent key is a no-op so a later retry still converges.
    try {
      await deleteDraftAttachments(env, m[1]);
    } catch {
      // orphaned blob; the row goes regardless
    }
    await deleteDraft(env, m[1]);
    return json({ ok: true });
  }

  // PUT /api/drafts/:id/attachments — replaces the whole staged set.
  // GET  — the same set with bytes, for restoring compose on resume.
  //
  // Separate from the draft row on purpose: the body autosaves every 1.5s while
  // the user types, and re-uploading 10MB of base64 on every keystroke would be
  // absurd. This is called only when a file is added or removed.
  m = path.match(/^\/api\/drafts\/([A-Za-z0-9-]{8,64})\/attachments$/);
  if (m && request.method === "PUT") {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    let items;
    try {
      items = parseDraftAttachments(b.attachments);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "invalid attachments" }, 400);
    }
    await putDraftAttachments(env, m[1], items);
    // The manifest is what the drafts list reads; keep it in step with R2.
    // Tolerated failure: before migration 0013 this column does not exist, and
    // the bytes are already safely in R2 - a missing paperclip in the list is
    // not a reason to fail the upload.
    try {
      await env.DB.prepare(`UPDATE drafts SET attachments = ? WHERE id = ?`)
        .bind(items.length ? JSON.stringify(manifestOf(items)) : null, m[1])
        .run();
    } catch {
      // pre-0013 database; the manifest appears once the migration runs
    }
    return json({ ok: true, attachments: manifestOf(items) });
  }
  if (m && request.method === "GET") {
    return json({ attachments: await getDraftAttachments(env, m[1]) });
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

  // ---- Blocked senders: mail from these goes straight to Junk ----
  if (path === "/api/blocked" && request.method === "GET") {
    return json({ blocked: await listBlocked(env) });
  }
  if (path === "/api/blocked" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const entry = normalizeBlockEntry(b.address);
    if (!entry) return json({ error: "enter an email address, or a domain written as @example.com" }, 400);
    // Blocking one of our own domains would junk every message we send
    // ourselves, and every self-addressed note.
    if (isOwnDomain(blockEntryDomain(entry), await ownDomains(env))) {
      return json({ error: "that is one of your own domains" }, 400);
    }
    if ((await countBlocked(env)) >= MAX_BLOCKED) return json({ error: `block list is full (max ${MAX_BLOCKED})` }, 400);
    await addBlocked(env, entry, Date.now());
    return json({ ok: true, address: entry });
  }
  m = path.match(/^\/api\/blocked\/([^/]{1,400})$/);
  if (m && request.method === "DELETE") {
    let entry: string | null = null;
    try {
      entry = normalizeBlockEntry(decodeURIComponent(m[1]));
    } catch {
      entry = null;
    }
    if (!entry) return json({ error: "bad request" }, 400);
    await removeBlocked(env, entry);
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

  // GET /api/attachments/:id/:name[?part=<partId>]
  // Without `part` the attachment is resolved by filename. Filenames are not
  // unique within a message ("image.png" twice is routine), and then every
  // link returns the first match, so a client that knows the partId passes it
  // and gets exactly that part.
  m = path.match(/^\/api\/attachments\/([^/]+)\/(.+)$/);
  if (m && request.method === "GET") {
    let name: string;
    try {
      name = decodeURIComponent(m[2]);
    } catch {
      return json({ error: "bad request" }, 400);
    }
    // partId becomes part of an R2 key, so accept only the shape attachmentRecord
    // mints (p<index>) — never a caller-chosen path segment.
    const part = url.searchParams.get("part");
    if (part !== null && !/^p\d{1,4}$/.test(part)) return json({ error: "invalid part" }, 400);
    const parsedObj = await env.MAILSTORE.get(`parsed/${m[1]}.json`);
    const meta = parsedObj ? ((await parsedObj.json()) as { attachments?: { partId?: string; name: string }[] }) : null;
    if (part !== null) {
      const obj = await env.MAILSTORE.get(`att/${m[1]}/${part}`);
      if (!obj) return new Response("not found", { status: 404 });
      // Prefer the stored filename; the path's name is only a fallback for a
      // message whose parsed body never made it to R2.
      const stored = meta?.attachments?.find((a) => a.partId === part);
      return serveAttachment(obj.body, obj.httpMetadata?.contentType, stored?.name || name);
    }
    const rec = meta?.attachments?.find((a) => a.name === name);
    const key = rec?.partId ? `att/${m[1]}/${rec.partId}` : `att/${m[1]}/${name}`; // legacy fallback
    const obj = await env.MAILSTORE.get(key);
    if (!obj) return new Response("not found", { status: 404 });
    return serveAttachment(obj.body, obj.httpMetadata?.contentType, name);
  }

  // GET /api/contacts?q= — recipient suggestions from mail already exchanged.
  // Read-only and derived; no contact store to keep in sync.
  if (path === "/api/contacts" && request.method === "GET") {
    // Same defense-in-depth as /api/compose/suggest: the debounce is client
    // side and enforces nothing on its own.
    if (!takeToken(contactBuckets, who, Date.now())) return json({ contacts: [] });
    const q = (url.searchParams.get("q") || "").slice(0, 100);
    // Enforce the 2-char minimum server side too: without it a bare
    // GET /api/contacts is a one-call dump of the whole address book.
    if (q.trim().length < 2) return json({ contacts: [] });
    try {
      return json({ contacts: await suggestContacts(env, q) });
    } catch (e) {
      // Suggestions are a convenience: degrade to none rather than failing the
      // compose flow if the lookup errors.
      console.error("contacts lookup failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ contacts: [] });
    }
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
    if (!takeToken(sendBuckets, who, Date.now(), 20, 0.2)) {
      return json({ error: "rate limited" }, 429);
    }
    const b = (await request.json().catch(() => ({}))) as Record<string, any>;
    if (!b.to) return json({ error: "missing 'to'" }, 400);
    // Every field is normalized to one address per entry (see recipients.ts),
    // so the cap below counts people, however the caller packed them.
    let toList: Recipient[], ccList: Recipient[], bccList: Recipient[];
    try {
      toList = parseRecipients(b.to);
      ccList = parseRecipients(b.cc);
      bccList = parseRecipients(b.bcc);
    } catch (e) {
      if (e instanceof RecipientError) return json({ error: e.message }, 400);
      throw e;
    }
    if (!toList.length) return json({ error: "missing 'to'" }, 400);
    // The cap covers every recipient field together, or Cc would be a second 50.
    if (toList.length + ccList.length + bccList.length > MAX_RECIPIENTS) {
      return json({ error: `too many recipients (max ${MAX_RECIPIENTS})` }, 400);
    }
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
    let references = "";
    if (irt) {
      // References carries the parent's own ancestor chain plus the parent, so
      // a recipient's client can thread the reply even when it never saw the
      // messages in between. Falls back to the parent alone when the chain is
      // unknown (mail stored before it was captured, or a lookup failure).
      references = await replyReferences(env, irt, typeof b.threadId === "string" ? b.threadId : "");
      headers["In-Reply-To"] = irt;
      headers["References"] = references;
    }
    // Decode and validate BEFORE sending: an oversized or corrupt attachment has
    // to fail the whole request rather than deliver a message the sender believes
    // carries a file it does not.
    let attachments: OutboundAttachment[];
    try {
      attachments = parseOutboundAttachments(b.attachments);
    } catch (e) {
      if (e instanceof AttachmentError) return json({ error: e.message }, 400);
      throw e;
    }
    const msg: Record<string, unknown> = {
      // Per-send name override → identity's profile name → derived default.
      // Sanitized: a raw b.fromName must never carry CR/LF into a header.
      from: { email: fromAddr, name: sanitizeFromName(b.fromName) || sender.displayName },
      to: toList,
      ...(ccList.length ? { cc: ccList } : {}),
      ...(bccList.length ? { bcc: bccList } : {}),
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
    if (attachments.length) {
      msg.attachments = attachments.map((a) => ({
        disposition: "attachment" as const,
        filename: a.filename,
        type: a.type,
        content: a.content,
      }));
    }
    let sendResult: { messageId?: string } | undefined;
    try {
      // send() resolves to an object carrying the platform-assigned messageId.
      sendResult = await env.EMAIL.send(msg);
      // Bcc stays out of the logs: it is the one field meant to be seen by nobody.
      console.log(`SEND OK: ${fromAddr} -> ${[...toList, ...ccList].map(recipientText).join(",")}${bccList.length ? ` (+${bccList.length} bcc)` : ""}`);
    } catch (e) {
      console.error("EMAIL.send failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "send failed", detail: e instanceof Error ? e.message : String(e) }, 502);
    }
    // Store the REAL Message-ID Cloudflare assigned so reply-linking works. If it's
    // absent at runtime, "" is the correct graceful fallback (this message just
    // won't be a reply-link target) — do NOT throw.
    const sentMessageId = sendResult?.messageId ?? "";
    // The message this was the draft of has been accepted: the draft goes, and
    // it goes HERE rather than on a later request from the client. A message
    // held for Undo send can go out as its page is closing (a keepalive
    // request nobody reads the answer to), and the client's only way to tell
    // on its next visit whether recovery may be needed is the surviving draft.
    // Cleanup can fail after acceptance, so the client must not infer that the
    // message was not sent. Never make a cleanup error a send failure.
    if (isDraftId(b.draftId)) {
      try {
        await deleteDraftAttachments(env, b.draftId).catch(() => {
          // orphaned blob; the row goes regardless (as in DELETE /api/drafts/:id)
        });
        await deleteDraft(env, b.draftId);
      } catch (e) {
        console.error("send: deleting the sent draft failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    }
    const id = uuid();
    const snippet = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
    // Store attachments the same way inbound mail does (att/<id>/p<n> in R2 plus
    // a record in the parsed body), so the Sent view, the download route and the
    // reader all work on sent mail with no special-casing.
    const attachmentRecords = attachments.map((a, i) => ({
      partId: `p${i}`,
      name: a.filename,
      mimeType: a.type,
      size: a.content.byteLength,
      disposition: "attachment",
      contentId: null,
    }));
    const ccText = ccList.map(recipientText).join(", ");
    // Bcc is recorded on OUR copy only (it is never a header on the wire), so
    // the Sent view can show who was blind-copied.
    const mailboxRefs = (list: Recipient[]) =>
      parseAddressList(list.map(recipientText).join(", ")).map((c) => ({ name: c.name, address: c.email }));
    const sentHeaders: StoredHeaders = {
      messageId: sentMessageId,
      inReplyTo: irt ?? "",
      ...(references ? { references: references.split(" ") } : {}),
      ...(bccList.length ? { bcc: mailboxRefs(bccList) } : {}),
    };
    // The mail is already delivered by this point, so persistence must not be
    // able to report failure: a thrown error here shows the user "Send failed"
    // for a message the recipient HAS, and the natural response is to send it
    // again. Log and continue instead — a missing Sent row is recoverable, a
    // duplicate delivery is not.
    try {
      await Promise.all(
        attachments.map((a, i) =>
          env.MAILSTORE.put(`att/${id}/p${i}`, a.content, {
            httpMetadata: { contentType: a.type },
          }),
        ),
      );
      await env.MAILSTORE.put(
        `parsed/${id}.json`,
        JSON.stringify({
          text: b.text || "",
          html: b.html || "",
          attachments: attachmentRecords,
          headers: sentHeaders,
        }),
      );
    } catch (e) {
      console.error("send: storing body/attachments failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    await env.DB.prepare(
      `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, snippet, date, unread, has_attachments, message_id, in_reply_to, state, starred, domain, msg_cc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(id, b.threadId || id, "out", "sent", identityAddr, toList.map(recipientText).join(", "), b.subject || "", snippet, Date.now(), 0, attachments.length ? 1 : 0, sentMessageId, irt ?? "", "inbox", 0, sender.domain, ccText || null)
      .run()
      .catch((e: unknown) => {
        console.error("send: sent-row insert failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      });
    // Index the sent message for full-text search (best-effort).
    await ftsUpsert(env, ftsRowFrom({
      id,
      subject: b.subject || "",
      from: identityAddr,
      to: toList.map(recipientText).join(", "),
      // Not Bcc: a reindex rebuilds from the row, which has no Bcc, so indexing
      // it here would only make search results change after one.
      cc: ccText,
      bodyText: bodyForIndex(b.text || "", b.html || ""),
    }));
    return json({ ok: true, id });
  }

  return json({ error: "not found" }, 404);
}

export default {
  fetch: handleFetch,
  email: handleEmail,
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const now = Date.now();
    // Every tick: end snoozes that are due. The inbox already shows them (its
    // predicate reads the clock); this marks them unread and says so.
    try {
      const woken = await wakeSnoozed(env, now);
      // A notification per thread, capped: a pile of snoozes ending together
      // should not become a pile of buzzes.
      for (const w of woken.slice(0, 5)) {
        const payload: Record<string, string> = {
          title: "Snoozed mail is back",
          body: clampUtf8(w.subject || "(no subject)", 300),
          url: "/",
          tag: clampUtf8(w.thread_id, MAX_PUSH_THREAD_ID_BYTES),
        };
        if (clampUtf8(w.thread_id, MAX_PUSH_THREAD_ID_BYTES) === w.thread_id) payload.threadId = w.thread_id;
        await sendPushToAll(env, payload).catch((e: unknown) => {
          console.error(`snooze: push failed: ${e instanceof Error ? e.message : e}`);
        });
      }
    } catch (e) {
      console.error(`snooze: wake failed: ${e instanceof Error ? e.message : e}`);
    }
    // The frequent tick stops here. Housekeeping runs once a day (and whenever
    // the trigger is not identified, so a manual run still does everything).
    if (event?.cron === SNOOZE_CRON) return;
    // The sweeps are independent best-effort housekeeping: a failure in one
    // must not skip the others, so each has its own try/catch.
    try {
      const r = await purgeOldTrash(env, now);
      console.log(`purge: removed ${r.purged} trashed message(s)${r.pending ? `, ${r.pending} with cleanup still pending` : ""}`);
    } catch (e) {
      console.error(`purge: trash purge failed: ${e instanceof Error ? e.message : e}`);
    }
    // Finish any permanent deletes an earlier run (or a delete-forever) left
    // half-done: their rows are gone, their tombstones say what remains.
    try {
      const d = await drainPendingDeletes(env, now);
      if (d.drained || d.failed) console.log(`purge: finished ${d.drained} pending delete(s), ${d.failed} still failing`);
    } catch (e) {
      console.error(`purge: pending-delete drain failed: ${e instanceof Error ? e.message : e}`);
    }
    try {
      const a = await purgeOrphanedDraftAttachments(env, now);
      if (a.purged) console.log(`purge: removed ${a.purged} orphaned draft attachment blob(s)`);
    } catch (e) {
      console.error(`purge: draft-attachment sweep failed: ${e instanceof Error ? e.message : e}`);
    }
  },
};
