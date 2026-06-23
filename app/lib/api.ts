// Typed fetch client for the Worker /api/* contract (see src/index.ts).
// Every request rides with credentials:"same-origin" so the Cloudflare Access
// cookie is sent. Non-OK responses throw a typed ApiError carrying the status.

import type {
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
} from "./types";

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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...init });
  } catch (err) {
    // Network failure / abort: fetch() rejects with no Response. Surface a
    // typed ApiError (status 0) so callers handle it like any other API error.
    const detail = err instanceof Error && err.message ? err.message : "network error";
    throw new ApiError(0, `network error: ${detail}`);
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

export interface ListThreadsArgs { view: View; q?: string; category?: string | null; domain?: string | null; }

/** GET /api/messages?view=…[&q=…][&category=…][&domain=…] — server-collapsed thread list. */
export function listThreads({ view, q, category, domain }: ListThreadsArgs): Promise<ThreadsResponse> {
  const params = new URLSearchParams({ view });
  const trimmed = q?.trim();
  if (trimmed) params.set("q", trimmed);
  // Category/domain narrow a plain view; both are ignored server-side while searching.
  if (category && !trimmed) params.set("category", category);
  if (domain && !trimmed) params.set("domain", domain);
  return request<ThreadsResponse>(`/api/messages?${params.toString()}`);
}

/** GET /api/counts — per-view thread/unread counts. */
export function getCounts(): Promise<ViewCounts> {
  return request<ViewCounts>(`/api/counts`);
}

/** POST /api/threads/:id/mutate {action} — single-thread mutation. */
export function mutateThread(threadId: string, action: MailAction): Promise<{ ok: true }> {
  return postJson(`/api/threads/${encodeURIComponent(threadId)}/mutate`, { action });
}

/** POST /api/messages/mutate {threadIds, action} — bulk mutation. */
export function mutateThreads(threadIds: string[], action: MailAction): Promise<{ ok: true; count: number }> {
  return postJson(`/api/messages/mutate`, { threadIds, action });
}

/** GET /api/messages/:id */
export function getMessage(id: string): Promise<MessageDetail> {
  return request<MessageDetail>(`/api/messages/${encodeURIComponent(id)}`);
}

/** POST /api/send */
export function send(payload: SendPayload): Promise<{ ok: true; id: string }> {
  return postJson<{ ok: true; id: string }>(`/api/send`, payload);
}

/** GET /api/identities — the From identities compose can send as. */
export function getIdentities(): Promise<IdentitiesResponse> {
  return request<IdentitiesResponse>(`/api/identities`);
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
    `/api/domains/${encodeURIComponent(zoneId)}?${params.toString()}`,
  );
}

/** PUT /api/domains/:zoneId/catch-all — set the catch-all to forward/drop. */
export function setDomainCatchAll(
  zoneId: string,
  action: "forward" | "drop",
  forwardTo?: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/domains/${encodeURIComponent(zoneId)}/catch-all`, {
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
  return postJson<{ ok: true }>(`/api/domains/${encodeURIComponent(zoneId)}/receiving`, {
    mode,
    forwardTo,
  });
}

/** POST /api/domains/:zoneId/sending — one-click sending onboarding. */
export function connectSending(
  zoneId: string,
  variant: "apex" | "subdomain" = "apex",
): Promise<ConnectSendingResponse> {
  return postJson<ConnectSendingResponse>(`/api/domains/${encodeURIComponent(zoneId)}/sending`, {
    variant,
  });
}

/** POST /api/domains/:zoneId/rules — create a per-address forwarding rule. */
export function createDomainRule(
  zoneId: string,
  rule: { local: string; action: RuleActionKind; forwardTo?: string },
): Promise<{ ok: true; id: string }> {
  return postJson<{ ok: true; id: string }>(`/api/domains/${encodeURIComponent(zoneId)}/rules`, rule);
}

/** PATCH /api/domains/:zoneId/rules/:ruleId — enable/disable a rule. */
export function toggleDomainRule(zoneId: string, ruleId: string, enabled: boolean): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/domains/${encodeURIComponent(zoneId)}/rules/${encodeURIComponent(ruleId)}`,
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
    `/api/domains/${encodeURIComponent(zoneId)}/rules/${encodeURIComponent(ruleId)}`,
    { method: "DELETE" },
  );
}

/** POST /api/destinations — register a forwarding destination (sends a verification email). */
export function addDestination(email: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/destinations`, { email });
}

/** GET /api/domains/:zoneId/settings — per-domain inbox settings. */
export function getDomainSettings(zoneId: string): Promise<DomainSettings> {
  return request<DomainSettings>(`/api/domains/${encodeURIComponent(zoneId)}/settings`);
}

/** PATCH /api/domains/:zoneId/settings — partial update (forward copy and/or sender name). */
export function setDomainSettings(zoneId: string, patch: DomainSettingsPatch): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/domains/${encodeURIComponent(zoneId)}/settings`, {
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

/** Pure URL builder for the binary attachment endpoint. */
export function attachmentUrl(id: string, name: string): string {
  return `/api/attachments/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
}
