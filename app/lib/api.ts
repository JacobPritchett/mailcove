import type { StagedAttachment } from "@/lib/attachments";
// Typed fetch client for the Worker /api/* contract (see src/index.ts).
// Every request rides with credentials:"same-origin" so the Cloudflare Access
// cookie is sent. Non-OK responses throw a typed ApiError carrying the status.

import type {
  Contact,
  ThreadsResponse,
  ViewCounts,
  View,
  MailAction,
  MessageDetail,
  SendPayload,
  ThreadResponse,
  Me,
  DomainsResponse,
  DomainDetailResponse,
  FiltersResponse,
  NewFilter,
  IdentitiesResponse,
  ReceivingMode,
  ConnectSendingResponse,
  RuleActionKind,
  DomainSettings,
  DomainSettingsPatch,
  DraftsResponse,
  DraftFull,
  DraftPut,
  BodyImagesResponse,
  BlockedResponse,
} from "./types";
import { sessionExpired } from "./session";

/** Thrown on any non-2xx API response. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Best-effort error message from a non-OK response body. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.clone().json()) as { error?: unknown; detail?: unknown };
    if (typeof data?.error === "string") return data.error;
    if (typeof data?.detail === "string") return data.detail;
  } catch {
    // not JSON — fall through
  }
  return res.statusText || `HTTP ${res.status}`;
}

/**
 * Is this 401 "you are not signed in", as opposed to a route's own refusal?
 *
 * Two things say so. Cloudflare Access answering for itself, which is never
 * our JSON error shape (HTML, or an empty body). And the Worker's auth gate,
 * which is the one place it returns 401: `{ "error": "unauthorized" }`
 * (src/index.ts, after verifyAccess). Any other JSON error with a 401 is some
 * route's answer and surfaces as an ordinary ApiError.
 */
async function isAuthRejection(res: Response): Promise<boolean> {
  try {
    const data = (await res.clone().json()) as { error?: unknown } | null;
    if (typeof data?.error !== "string") return true;
    return data.error === "unauthorized";
  } catch {
    return true; // not JSON: not ours
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: "same-origin",
      // An expired Access session answers an API call with a redirect to its
      // login page on another origin. Followed, that is a CORS failure
      // indistinguishable from being offline; left unfollowed it is something
      // we can recognise below.
      redirect: "manual",
      ...init,
      // Marks the call as script-initiated, which makes Access answer 401
      // instead of redirecting in the first place.
      headers: { ...(init?.headers as Record<string, string> | undefined), "X-Requested-With": "XMLHttpRequest" },
    });
  } catch (err) {
    // Network failure / abort: fetch() rejects with no Response. Surface a
    // typed ApiError (status 0) so callers handle it like any other API error.
    const detail = err instanceof Error && err.message ? err.message : "network error";
    throw new ApiError(0, `network error: ${detail}`);
  }
  if (res.type === "opaqueredirect" || (res.status === 401 && (await isAuthRejection(res)))) {
    // The session is gone (the API itself never redirects). Offline errors
    // never get here: fetch rejects for those, above.
    sessionExpired();
    throw new ApiError(401, "Session expired. Reload to sign in again.");
  }
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res));
  }
  return (await res.json()) as T;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface ListThreadsArgs {
  view: View;
  q?: string;
  category?: string | null;
  domain?: string | null;
  /** Page size (the Worker defaults to its maximum when absent). */
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string | null;
}

/** GET /api/messages?view=…[&q=…][&category=…][&domain=…][&limit=…][&cursor=…] — one page of the server-collapsed thread list. */
export function listThreads({ view, q, category, domain, limit, cursor }: ListThreadsArgs): Promise<ThreadsResponse> {
  const params = new URLSearchParams({ view });
  const trimmed = q?.trim();
  if (trimmed) {
    params.set("q", trimmed);
    // Minutes behind UTC, so before: and after: mean the user's days, not UTC's.
    params.set("tz", String(new Date().getTimezoneOffset()));
  }
  // Category narrows a plain view only (search ignores it). The domain
  // narrows both: a search stays inside the inbox being looked at.
  if (category && !trimmed) params.set("category", category);
  if (domain) params.set("domain", domain);
  if (limit) params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  return request<ThreadsResponse>(`/api/messages?${params.toString()}`);
}

/**
 * GET /api/messages/ids — one page (up to 500) of the thread ids of a view or
 * a search, in list order, with the list route's parameters and cursors. For
 * acting on a whole view without loading it (see lib/selectAll).
 */
export function listThreadIds({ view, q, category, domain, cursor }: Omit<ListThreadsArgs, "limit">): Promise<{
  ids: string[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams({ view });
  const trimmed = q?.trim();
  if (trimmed) {
    params.set("q", trimmed);
    params.set("tz", String(new Date().getTimezoneOffset()));
  }
  if (category && !trimmed) params.set("category", category);
  if (domain) params.set("domain", domain);
  if (cursor) params.set("cursor", cursor);
  return request(`/api/messages/ids?${params.toString()}`);
}

/** GET /api/counts — per-view thread/unread counts. */
export function getCounts(): Promise<ViewCounts> {
  return request<ViewCounts>(`/api/counts`);
}

/**
 * POST /api/threads/:id/mutate {action[, until]} — single-thread mutation.
 * `until` (epoch ms) belongs to `snooze` and is required by it.
 */
export function mutateThread(threadId: string, action: MailAction, until?: number): Promise<{ ok: true }> {
  return postJson(`/api/threads/${encodeURIComponent(threadId)}/mutate`, { action, until });
}

/** Most thread ids the Worker takes in one bulk mutation. */
const BULK_MAX = 200;

/**
 * POST /api/messages/mutate {threadIds, action} — bulk mutation. A selection
 * larger than the Worker's per-request cap (possible once several pages are
 * loaded and everything is selected) goes in consecutive requests.
 *
 * On failure the error carries `failedIds`: the threads from the failing
 * request onward. Any before them were changed.
 */
export async function mutateThreads(
  threadIds: string[],
  action: MailAction,
  until?: number,
): Promise<{ ok: true; count: number }> {
  let count = 0;
  for (let i = 0; i < threadIds.length; i += BULK_MAX) {
    try {
      const r = await postJson<{ ok: true; count: number }>(`/api/messages/mutate`, {
        threadIds: threadIds.slice(i, i + BULK_MAX),
        action,
        until,
      });
      count += r.count;
    } catch (e) {
      // Earlier requests went through: say which threads did NOT, so the
      // caller undoes its optimistic change for those and no others.
      if (e instanceof Error) (e as Error & { failedIds?: string[] }).failedIds = threadIds.slice(i);
      throw e;
    }
  }
  return { ok: true, count };
}

/** GET /api/messages/:id */
export function getMessage(id: string): Promise<MessageDetail> {
  return request<MessageDetail>(`/api/messages/${encodeURIComponent(id)}`);
}

/**
 * POST /api/send. `keepalive` is for a send made as the page goes away (see
 * lib/outbox): the browser finishes the request after the page is gone, at
 * the price of a body limited to about 64 KB.
 */
export function send(
  payload: SendPayload & { draftId?: string },
  opts: { keepalive?: boolean } = {},
): Promise<{ ok: true; id: string }> {
  return request<{ ok: true; id: string }>(`/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    ...(opts.keepalive ? { keepalive: true } : {}),
  });
}

/** GET /api/identities — the From identities compose can send as. */
export function getIdentities(): Promise<IdentitiesResponse> {
  return request<IdentitiesResponse>(`/api/identities`);
}

/** GET /api/contacts — recipient suggestions derived from past mail. */
export function getContacts(q: string): Promise<{ contacts: Contact[] }> {
  return request<{ contacts: Contact[] }>(`/api/contacts?q=${encodeURIComponent(q)}`);
}

/** POST /api/threads/:id/summarize — Workers AI conversation summary. */
export function summarizeThread(threadId: string): Promise<{ ok: true; summary: string }> {
  return postJson<{ ok: true; summary: string }>(
    `/api/threads/${encodeURIComponent(threadId)}/summarize`,
    {},
  );
}

/** POST /api/threads/:id/draft-reply — Workers AI drafts a reply body. */
export function draftReply(threadId: string): Promise<{ ok: true; draft: string }> {
  return postJson<{ ok: true; draft: string }>(
    `/api/threads/${encodeURIComponent(threadId)}/draft-reply`,
    {},
  );
}

/** GET /api/threads/:id — all messages in the conversation, oldest→newest, with bodies. */
export function getThread(id: string): Promise<ThreadResponse> {
  return request<ThreadResponse>(`/api/threads/${encodeURIComponent(id)}`);
}

/** GET /api/messages/:id/body?images=1 — re-fetch body with remote images force-shown. */
export function showMessageImages(id: string): Promise<BodyImagesResponse> {
  return request<BodyImagesResponse>(`/api/messages/${encodeURIComponent(id)}/body?images=1`);
}

/** POST /api/senders/images — add sender address to the remote-images allowlist. */
export function allowImagesFrom(address: string): Promise<{ ok: true }> {
  return postJson(`/api/senders/images`, { address });
}

/** GET /api/blocked — senders whose mail goes straight to Junk. */
export function listBlocked(): Promise<BlockedResponse> {
  return request<BlockedResponse>(`/api/blocked`);
}

/**
 * POST /api/blocked — block an address, or a whole domain written
 * "@example.com". Resolves to the entry as the Worker normalized it; a 400
 * carries a message worth showing (not an address, one of our own domains).
 */
export function addBlocked(address: string): Promise<{ ok: true; address: string }> {
  return postJson(`/api/blocked`, { address });
}

/** DELETE /api/blocked/:address */
export function removeBlocked(address: string): Promise<{ ok: true }> {
  return request(`/api/blocked/${encodeURIComponent(address)}`, { method: "DELETE" });
}

/** GET /api/me */
export function getMe(): Promise<Me> {
  return request<Me>(`/api/me`);
}

/** GET /api/filters — list inbox rules. */
export function listFilters(): Promise<FiltersResponse> {
  return request<FiltersResponse>(`/api/filters`);
}

/** POST /api/filters — create a rule. */
export function createFilter(filter: NewFilter): Promise<{ ok: true; id: string }> {
  return postJson<{ ok: true; id: string }>(`/api/filters`, filter);
}

/** PATCH /api/filters/:id — enable/disable a rule. */
export function toggleFilter(id: string, enabled: boolean): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/filters/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

/** DELETE /api/filters/:id — remove a rule. */
export function deleteFilter(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/filters/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** POST /api/compose/suggest — Smart Compose continuation for the current draft. */
export function suggestCompletion(
  subject: string,
  text: string,
  signal?: AbortSignal,
): Promise<{ suggestion: string }> {
  return request<{ suggestion: string }>(`/api/compose/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, text }),
    signal,
  });
}

/** GET /api/push/key — the VAPID public key (503 when push isn't configured). */
export function getPushKey(): Promise<{ key: string }> {
  return request<{ key: string }>(`/api/push/key`);
}

/** POST /api/push/subscribe — register this device's push subscription. */
export function pushSubscribe(endpoint: string, keys: { p256dh: string; auth: string }): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/push/subscribe`, { endpoint, keys });
}

/** POST /api/push/unsubscribe — drop this device's push subscription. */
export function pushUnsubscribe(endpoint: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/push/unsubscribe`, { endpoint });
}

/** GET /api/domains — read-only list of the account's zones. */
export function listDomains(): Promise<DomainsResponse> {
  return request<DomainsResponse>(`/api/domains`);
}

/** GET /api/domains/:zoneId — read-only Email Routing detail for one zone. */
export function getDomainDetail(zoneId: string, name: string): Promise<DomainDetailResponse> {
  const params = new URLSearchParams({ name });
  return request<DomainDetailResponse>(
    `/api/domain-routing/${encodeURIComponent(zoneId)}?${params.toString()}`,
  );
}

/** PUT /api/domains/:zoneId/catch-all — set the catch-all to forward/drop. */
export function setDomainCatchAll(
  zoneId: string,
  action: "forward" | "drop",
  forwardTo?: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/domain-routing/${encodeURIComponent(zoneId)}/catch-all`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, forwardTo }),
  });
}

/** POST /api/domains/:zoneId/receiving — one-click receiving onboarding. */
export function connectReceiving(
  zoneId: string,
  mode: ReceivingMode,
  forwardTo?: string,
): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/domain-routing/${encodeURIComponent(zoneId)}/receiving`, {
    mode,
    forwardTo,
  });
}

/** POST /api/domains/:zoneId/sending — one-click sending onboarding. */
export function connectSending(
  zoneId: string,
  variant: "apex" | "subdomain" = "apex",
): Promise<ConnectSendingResponse> {
  return postJson<ConnectSendingResponse>(`/api/domain-routing/${encodeURIComponent(zoneId)}/sending`, {
    variant,
  });
}

/** POST /api/domains/:zoneId/rules — create a per-address forwarding rule. */
export function createDomainRule(
  zoneId: string,
  rule: { local: string; action: RuleActionKind; forwardTo?: string },
): Promise<{ ok: true; id: string }> {
  return postJson<{ ok: true; id: string }>(`/api/domain-routing/${encodeURIComponent(zoneId)}/rules`, rule);
}

/** PATCH /api/domains/:zoneId/rules/:ruleId — enable/disable a rule. */
export function toggleDomainRule(zoneId: string, ruleId: string, enabled: boolean): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/domain-routing/${encodeURIComponent(zoneId)}/rules/${encodeURIComponent(ruleId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
}

/** DELETE /api/domains/:zoneId/rules/:ruleId — remove a rule. */
export function deleteDomainRule(zoneId: string, ruleId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/domain-routing/${encodeURIComponent(zoneId)}/rules/${encodeURIComponent(ruleId)}`,
    { method: "DELETE" },
  );
}

/** POST /api/destinations — register a forwarding destination (sends a verification email). */
export function addDestination(email: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/destinations`, { email });
}

/** GET /api/domains/:zoneId/settings — per-domain inbox settings. */
export function getDomainSettings(zoneId: string): Promise<DomainSettings> {
  return request<DomainSettings>(`/api/domain-routing/${encodeURIComponent(zoneId)}/settings`);
}

/** PATCH /api/domains/:zoneId/settings — partial update (forward copy and/or sender name). */
export function setDomainSettings(zoneId: string, patch: DomainSettingsPatch): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/domain-routing/${encodeURIComponent(zoneId)}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// ---- Drafts ----

/** GET /api/drafts — newest-first draft summaries. */
export function listDrafts(): Promise<DraftsResponse> {
  return request<DraftsResponse>(`/api/drafts`);
}

/**
 * PUT /api/drafts/:id/attachments — replaces the whole staged set.
 *
 * Separate from putDraft because the body autosaves every 1.5s while the user
 * types while the file set changes only when they add or remove one; sending
 * the bytes on the autosave path would re-upload everything per keystroke.
 */
export function putDraftAttachments(
  id: string,
  attachments: readonly { name: string; type: string; data: string }[],
): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/drafts/${encodeURIComponent(id)}/attachments`, {
    method: "PUT",
    body: JSON.stringify({ attachments }),
  });
}

/** GET /api/drafts/:id/attachments — the staged set WITH bytes, for resume. */
export function getDraftAttachments(id: string): Promise<{ attachments: StagedAttachment[] }> {
  return request<{ attachments: StagedAttachment[] }>(
    `/api/drafts/${encodeURIComponent(id)}/attachments`,
  );
}

/** GET /api/drafts/:id — full draft for resume. */
export function getDraft(id: string): Promise<DraftFull> {
  return request<DraftFull>(`/api/drafts/${encodeURIComponent(id)}`);
}

/** PUT /api/drafts/:id — idempotent autosave upsert. */
export function putDraft(id: string, body: DraftPut): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/drafts/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** DELETE /api/drafts/:id — sent or discarded. */
export function deleteDraft(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Pure URL builder for the binary attachment endpoint. `partId` picks one MIME
 * part when a message carries several files with the same name; without it the
 * endpoint resolves by name alone.
 */
export function attachmentUrl(id: string, name: string, partId?: string): string {
  const base = `/api/attachments/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
  return partId ? `${base}?part=${encodeURIComponent(partId)}` : base;
}

/**
 * Fetch one stored attachment as base64 (no data: prefix), for carrying a
 * forwarded message's files into a new one.
 */
export async function getAttachmentBase64(id: string, name: string, partId?: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(attachmentUrl(id, name, partId), { credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network error");
  }
  if (!res.ok) throw new ApiError(res.status, `Could not fetch ${name}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Chunked: String.fromCharCode(...bytes) overflows the stack on a large file.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export type UnsubscribeResult =
  | { ok: true; method: "one-click" | "mailto" }
  | { ok: true; method: "open"; url: string };

/** Act on a message's List-Unsubscribe header (see the Worker route). */
export const unsubscribeFrom = (id: string) =>
  request<UnsubscribeResult>(`/api/messages/${encodeURIComponent(id)}/unsubscribe`, { method: "POST" });

/**
 * Fetch one stored attachment as text, for a file the client reads itself (a
 * calendar invite). `maxBytes` bounds what is decoded: the caller is about to
 * parse something a stranger sent.
 */
export async function getAttachmentText(id: string, name: string, partId: string | undefined, maxBytes: number): Promise<string> {
  let res: Response;
  try {
    res = await fetch(attachmentUrl(id, name, partId), { credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network error");
  }
  if (!res.ok) throw new ApiError(res.status, `Could not fetch ${name}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Not fatal: a calendar file in another encoding still has ASCII property
  // names, and a mangled title is better than no card.
  return new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes));
}
