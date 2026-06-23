// TanStack Query hooks over the typed api client. Polling (15s) + refetch on
// focus keeps the inbox live.

import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  listThreads,
  getCounts,
  mutateThread as apiMutateThread,
  mutateThreads as apiMutateThreads,
  getMessage,
  getMe,
  getIdentities,
  send,
  getThread,
  summarizeThread,
  draftReply,
  listDomains,
  getDomainDetail,
  setDomainCatchAll,
  connectReceiving,
  connectSending,
  createDomainRule,
  toggleDomainRule,
  deleteDomainRule,
  addDestination,
  getDomainSettings,
  setDomainSettings,
  listFilters,
  createFilter,
  toggleFilter,
  deleteFilter,
  listDrafts,
  deleteDraft,
} from "./api";
import type {
  ThreadsResponse,
  ViewCounts,
  View,
  MailAction,
  MessageDetail,
  Me,
  SendPayload,
  ThreadResponse,
  DomainsResponse,
  DomainDetailResponse,
  FiltersResponse,
  NewFilter,
  IdentitiesResponse,
  ReceivingMode,
  RuleActionKind,
  DomainSettings,
  DomainSettingsPatch,
  DraftsResponse,
} from "./types";

/** GET /api/messages?view=…[&q=…][&category=…][&domain=…] with 15s polling + refetch on focus. */
export function useThreads(
  view: View,
  q?: string,
  category?: string | null,
  domain?: string | null,
  enabled = true,
) {
  return useQuery<ThreadsResponse>({
    queryKey: ["threads", view, q ?? "", category ?? "", domain ?? ""],
    queryFn: () => listThreads({ view, q, category, domain }),
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
    enabled,
  });
}

// ---- Drafts ----

/** GET /api/drafts (Drafts view list). */
export function useDrafts(enabled: boolean) {
  return useQuery<DraftsResponse>({
    queryKey: ["drafts"],
    queryFn: listDrafts,
    enabled,
    refetchInterval: 15000,
  });
}

/** DELETE /api/drafts/:id — refreshes the list + sidebar count. */
export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteDraft(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["drafts"] });
      void qc.invalidateQueries({ queryKey: ["counts"] });
    },
  });
}

/** GET /api/counts with 15s polling. */
export function useCounts() {
  return useQuery<ViewCounts>({
    queryKey: ["counts"],
    queryFn: getCounts,
    refetchInterval: 15000,
  });
}

/**
 * Which actions remove a thread from a given view's list (for optimistic UI).
 * e.g. archiving removes from "inbox" but not from "all".
 */
const REMOVES_FROM_VIEW: Record<View, Set<MailAction>> = {
  inbox:   new Set(["archive", "trash"]),
  starred: new Set(["unstar", "trash"]),
  sent:    new Set(["trash"]),
  all:     new Set(["trash"]),
  trash:   new Set(["restore", "delete"]),
};

/** The inverse action used to undo a mutation (for future Undo affordance). */
export const INVERSE_ACTION: Partial<Record<MailAction, MailAction>> = {
  archive: "unarchive", unarchive: "archive",
  trash: "restore", restore: "trash",
  star: "unstar", unstar: "star",
  read: "unread", unread: "read",
};

/**
 * Mutation hook for thread actions. Applies optimistic updates to the
 * thread list, rolls back on error, and invalidates threads + counts on settle.
 */
export function useMutateThreads(view: View, q?: string, category?: string | null, domain?: string | null) {
  const qc = useQueryClient();
  // Must mirror useThreads' queryKey exactly or optimistic updates miss the cache.
  const key = ["threads", view, q ?? "", category ?? "", domain ?? ""];
  return useMutation({
    mutationFn: ({ threadIds, action }: { threadIds: string[]; action: MailAction }) =>
      threadIds.length === 1
        ? apiMutateThread(threadIds[0], action).then(() => undefined)
        : apiMutateThreads(threadIds, action).then(() => undefined),
    onMutate: async ({ threadIds, action }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ThreadsResponse>(key);
      if (prev) {
        const ids = new Set(threadIds);
        const removes = REMOVES_FROM_VIEW[view].has(action);
        qc.setQueryData<ThreadsResponse>(key, {
          ...prev,
          threads: prev.threads
            .filter((t) => !(removes && ids.has(t.thread_id)))
            .map((t) => ids.has(t.thread_id)
              ? {
                  ...t,
                  starred: action === "star" ? 1 : action === "unstar" ? 0 : t.starred,
                  anyUnread: action === "read" ? 0 : action === "unread" ? 1 : t.anyUnread,
                }
              : t),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["threads"] });
      void qc.invalidateQueries({ queryKey: ["counts"] });
      void qc.invalidateQueries({ queryKey: ["thread"] });
    },
  });
}

/** GET /api/messages/:id — only runs when an id is selected. */
export function useMessage(id: string | null) {
  return useQuery<MessageDetail>({
    queryKey: ["message", id],
    queryFn: () => getMessage(id as string),
    enabled: !!id,
  });
}

/** GET /api/threads/:id — the full conversation; only runs when a thread is selected. */
export function useThread(id: string | null) {
  return useQuery<ThreadResponse>({
    queryKey: ["thread", id],
    queryFn: () => getThread(id as string),
    enabled: !!id,
  });
}

/**
 * POST /api/send — sends a message (compose or reply). On success invalidates
 * the thread lists (and any thread queries) so the new Sent row shows up.
 * Exposes `isPending` / `error` for the dialog's submit + error UI.
 */
export function useSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SendPayload) => send(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["threads"] });
      void qc.invalidateQueries({ queryKey: ["thread"] });
    },
  });
}

/**
 * POST /api/threads/:id/summarize — Workers AI conversation summary. A plain
 * mutation: the result (summary text) is read from the mutation state, not
 * cached, so re-summarizing always re-runs the model.
 */
export function useSummarizeThread() {
  return useMutation({
    mutationFn: (threadId: string) => summarizeThread(threadId),
  });
}

/** POST /api/threads/:id/draft-reply — Workers AI reply draft (mutation). */
export function useDraftReply() {
  return useMutation({
    mutationFn: (threadId: string) => draftReply(threadId),
  });
}

/**
 * GET /api/identities — sendable From identities for the compose picker. Only
 * fetched while compose is open; cached for the session (the list changes only
 * when a domain is connected). A failure degrades to `undefined` and the dialog
 * falls back to its static default identity.
 */
export function useIdentities(enabled: boolean) {
  return useQuery<IdentitiesResponse>({
    queryKey: ["identities"],
    queryFn: () => getIdentities(),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** GET /api/me — the signed-in email (validated server-side). */
export function useMe() {
  return useQuery<Me>({
    queryKey: ["me"],
    queryFn: () => getMe(),
  });
}

/** GET /api/filters — inbox rules; only fetched while the manager is open. */
export function useFilters(enabled: boolean) {
  return useQuery<FiltersResponse>({
    queryKey: ["filters"],
    queryFn: () => listFilters(),
    enabled,
  });
}

/** Create/toggle/delete a rule, refreshing the list on success. */
export function useFilterMutations() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["filters"] });
  const create = useMutation({ mutationFn: (f: NewFilter) => createFilter(f), onSuccess: refresh });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => toggleFilter(id, enabled),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteFilter(id), onSuccess: refresh });
  return { create, toggle, remove };
}

/**
 * GET /api/domains — read-only zone list for the Domains dashboard. Only runs
 * when `enabled` (the dialog is open) so we don't hit the CF API on every load.
 */
export function useDomains(enabled: boolean) {
  return useQuery<DomainsResponse>({
    queryKey: ["domains"],
    queryFn: () => listDomains(),
    enabled,
    staleTime: 60_000,
  });
}

/** GET /api/domains/:zoneId — routing detail for the selected zone (lazy). */
export function useDomainDetail(zoneId: string | null, name: string) {
  return useQuery<DomainDetailResponse>({
    queryKey: ["domain", zoneId],
    queryFn: () => getDomainDetail(zoneId as string, name),
    enabled: !!zoneId,
    staleTime: 30_000,
  });
}

/** Refresh the affected domain + the list after a routing/catch-all write. */
function invalidateDomain(qc: ReturnType<typeof useQueryClient>, zoneId: string) {
  void qc.invalidateQueries({ queryKey: ["domain", zoneId] });
  void qc.invalidateQueries({ queryKey: ["domains"] });
}

/** PUT /api/domains/:zoneId/catch-all — set forward/drop. */
export function useSetDomainCatchAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ zoneId, action, forwardTo }: { zoneId: string; action: "forward" | "drop"; forwardTo?: string }) =>
      setDomainCatchAll(zoneId, action, forwardTo),
    onSuccess: (_d, { zoneId }) => invalidateDomain(qc, zoneId),
  });
}

/** POST /api/domains/:zoneId/receiving — one-click receiving onboarding. */
export function useConnectReceiving() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ zoneId, mode, forwardTo }: { zoneId: string; mode: ReceivingMode; forwardTo?: string }) =>
      connectReceiving(zoneId, mode, forwardTo),
    onSuccess: (_d, { zoneId }) => invalidateDomain(qc, zoneId),
  });
}

/** Per-address rule mutations for one zone; refresh that domain on success. */
export function useDomainRules() {
  const qc = useQueryClient();
  const done = (zoneId: string) => invalidateDomain(qc, zoneId);
  const create = useMutation({
    mutationFn: ({ zoneId, local, action, forwardTo }: { zoneId: string; local: string; action: RuleActionKind; forwardTo?: string }) =>
      createDomainRule(zoneId, { local, action, forwardTo }),
    onSuccess: (_d, { zoneId }) => done(zoneId),
  });
  const toggle = useMutation({
    mutationFn: ({ zoneId, ruleId, enabled }: { zoneId: string; ruleId: string; enabled: boolean }) =>
      toggleDomainRule(zoneId, ruleId, enabled),
    onSuccess: (_d, { zoneId }) => done(zoneId),
  });
  const remove = useMutation({
    mutationFn: ({ zoneId, ruleId }: { zoneId: string; ruleId: string }) => deleteDomainRule(zoneId, ruleId),
    onSuccess: (_d, { zoneId }) => done(zoneId),
  });
  return { create, toggle, remove };
}

/** POST /api/destinations — refreshes the open domain so the pending address shows. */
export function useAddDestination(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => addDestination(email),
    onSuccess: () => {
      if (zoneId) invalidateDomain(qc, zoneId);
    },
  });
}

/** GET /api/domains/:zoneId/settings — fetched lazily with the detail pane. */
export function useDomainSettings(zoneId: string | null) {
  return useQuery<DomainSettings>({
    queryKey: ["domain-settings", zoneId],
    queryFn: () => getDomainSettings(zoneId as string),
    enabled: !!zoneId,
    staleTime: 30_000,
  });
}

/** PATCH /api/domains/:zoneId/settings — partial (forward copy and/or sender name). */
export function useSetDomainSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ zoneId, patch }: { zoneId: string; patch: DomainSettingsPatch }) =>
      setDomainSettings(zoneId, patch),
    onSuccess: (_d, { zoneId, patch }) => {
      void qc.invalidateQueries({ queryKey: ["domain-settings", zoneId] });
      // A sender-name change shows up in the compose From prefill.
      if ("displayName" in patch) void qc.invalidateQueries({ queryKey: ["identities"] });
    },
  });
}

/**
 * POST /api/domains/:zoneId/sending — one-click sending onboarding. Also
 * refreshes the compose identities, since a new From domain just appeared.
 */
export function useConnectSending() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ zoneId, variant }: { zoneId: string; variant?: "apex" | "subdomain" }) =>
      connectSending(zoneId, variant ?? "apex"),
    onSuccess: (_d, { zoneId }) => {
      invalidateDomain(qc, zoneId);
      void qc.invalidateQueries({ queryKey: ["identities"] });
    },
  });
}
