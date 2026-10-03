// TanStack Query hooks over the typed api client. Polling (15s) + refetch on
// focus keeps the inbox live.

import { useCallback } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
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
  listBlocked,
  addBlocked,
  removeBlocked,
} from "./api";
import type {
  ThreadListRow,
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
  BlockedResponse,
} from "./types";
import { actionView } from "./actions";
import { THREADS_PAGE_SIZE, appendPage, mergeFirstPage, reinsertRow, type ThreadListData } from "./threadPages";

interface ThreadListArgs {
  view: View;
  q?: string;
  category?: string | null;
  domain?: string | null;
}

/** The cache key of one list. Everything that reads or writes a list uses it. */
function threadsKey({ view, q, category, domain }: ThreadListArgs) {
  return ["threads", view, q ?? "", category ?? "", domain ?? ""];
}

/** "Load more" requests under way, by list and cursor, so one page is fetched once. */
const loadingMore = new Map<string, Promise<ThreadListRow[]>>();

/**
 * Fetch the page after the last loaded one and append it to the cached list.
 * Resolves to the rows it added (none at the end of the list, on failure, or
 * when the list was reset while the request was in flight). Safe to call
 * repeatedly: a second call for the same page joins the first.
 */
export function loadMoreThreads(qc: QueryClient, args: ThreadListArgs): Promise<ThreadListRow[]> {
  const key = threadsKey(args);
  const cursor = qc.getQueryData<ThreadListData>(key)?.nextCursor;
  if (!cursor) return Promise.resolve([]);
  const id = JSON.stringify([key, cursor]);
  const running = loadingMore.get(id);
  if (running) return running;

  qc.setQueryData<ThreadListData>(key, (d) => d && { ...d, loadingMore: true, moreFailed: false });
  const request = listThreads({ ...args, limit: THREADS_PAGE_SIZE, cursor })
    .then(
      (page) => {
        let added: ThreadListRow[] = [];
        qc.setQueryData<ThreadListData>(key, (d) => {
          if (!d) return d;
          const merged = appendPage(d, page, cursor);
          added = merged.added;
          return merged.data;
        });
        return added;
      },
      () => {
        qc.setQueryData<ThreadListData>(key, (d) => d && { ...d, loadingMore: false, moreFailed: true });
        return [];
      },
    )
    .finally(() => loadingMore.delete(id));
  loadingMore.set(id, request);
  return request;
}

/**
 * GET /api/messages?view=…[&q=…][&category=…][&domain=…], a page at a time,
 * with 15s polling + refetch on focus.
 *
 * The cache holds every page loaded so far as one flat list. Polling, focus
 * and post-action refetches fetch the FIRST page only and merge it in (see
 * lib/threadPages), so the cost of staying live does not grow with how far
 * the user has scrolled. `fetchMore` loads the next page.
 */
export function useThreads(
  view: View,
  q?: string,
  category?: string | null,
  domain?: string | null,
  enabled = true,
) {
  const qc = useQueryClient();
  const query = useQuery<ThreadListData>({
    queryKey: threadsKey({ view, q, category, domain }),
    queryFn: async () => {
      const fresh = await listThreads({ view, q, category, domain, limit: THREADS_PAGE_SIZE });
      // Read the cache AFTER the request: a page appended or an optimistic
      // change made while it was in flight must be what the merge builds on.
      return mergeFirstPage(
        qc.getQueryData<ThreadListData>(threadsKey({ view, q, category, domain })),
        fresh,
        !!q?.trim(),
      );
    },
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
    enabled,
  });
  const fetchMore = useCallback(
    () => loadMoreThreads(qc, { view, q, category, domain }),
    [qc, view, q, category, domain],
  );
  return {
    ...query,
    /** True while the server has rows beyond the ones loaded. */
    hasMore: !!query.data?.nextCursor,
    isFetchingMore: !!query.data?.loadingMore,
    moreFailed: !!query.data?.moreFailed,
    fetchMore,
  };
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
  inbox:   new Set(["archive", "trash", "spam", "snooze"]),
  starred: new Set(["unstar", "trash", "spam"]),
  sent:    new Set(["trash", "spam"]),
  all:     new Set(["trash", "spam"]),
  trash:   new Set(["restore", "delete", "spam"]),
  spam:    new Set(["unspam", "restore", "delete", "trash"]),
  // Snoozing again from here only moves the time; the thread stays listed.
  snoozed: new Set(["unsnooze", "archive", "trash", "spam"]),
};

/** Does `action` take a thread out of the list shown under `rules`? */
export function removesFromView(rules: View, action: MailAction): boolean {
  return REMOVES_FROM_VIEW[rules].has(action);
}

/**
 * Rows an action took out of a list, by list and thread. A refetch renews only
 * a list's first page, so undoing an archive further down would otherwise
 * leave the thread missing: the undo puts the remembered row back instead.
 */
const removedRows = new Map<string, { row: ThreadListRow; index: number; action: MailAction }>();
const REMEMBERED_MAX = 500;
const rememberKey = (key: readonly unknown[], threadId: string) => `${JSON.stringify(key)}\u0000${threadId}`;

/** A list as it will look once `action` has been applied to `threadIds`. */
function applyAction(
  list: ThreadListData,
  threadIds: string[],
  action: MailAction,
  rules: View,
  key: readonly unknown[],
  until?: number,
): ThreadListData {
  const ids = new Set(threadIds);
  const removes = removesFromView(rules, action);
  let threads = list.threads;
  if (removes) {
    threads.forEach((row, index) => {
      if (!ids.has(row.thread_id)) return;
      if (removedRows.size >= REMEMBERED_MAX) removedRows.clear();
      removedRows.set(rememberKey(key, row.thread_id), { row, index, action });
    });
  } else {
    // Put a row back only for the exact inverse of what took it out (the undo
    // of an archive is an unarchive). Any other action on that thread, a star
    // from All Mail say, has nothing to do with whether it belongs here.
    for (const id of threadIds) {
      const k = rememberKey(key, id);
      const was = removedRows.get(k);
      if (!was || INVERSE_ACTION[was.action] !== action) continue;
      removedRows.delete(k);
      threads = reinsertRow(threads, was.row, was.index, key[2] !== "");
    }
  }
  return {
    ...list,
    threads: threads
      .filter((t) => !(removes && ids.has(t.thread_id)))
      .map((t) => ids.has(t.thread_id)
        ? {
            ...t,
            starred: action === "star" ? 1 : action === "unstar" ? 0 : t.starred,
            anyUnread: action === "read" ? 0 : action === "unread" ? 1 : t.anyUnread,
            snoozedUntil: action === "snooze" ? (until ?? t.snoozedUntil) : t.snoozedUntil,
          }
        : t),
  };
}

/**
 * Undo an optimistic change for `threadIds` only, from the snapshot taken
 * before it. Restoring the whole snapshot would also undo every other action
 * made since (and bring back rows a later, successful action removed).
 */
function rollBack(cur: ThreadListData, prev: ThreadListData, threadIds: string[], key: readonly unknown[]): ThreadListData {
  let threads = cur.threads;
  for (const id of threadIds) {
    const index = prev.threads.findIndex((t) => t.thread_id === id);
    const at = threads.findIndex((t) => t.thread_id === id);
    if (index === -1) {
      // It was not listed before (the failed action was itself an undo).
      if (at !== -1) threads = threads.filter((t) => t.thread_id !== id);
      continue;
    }
    const row = prev.threads[index];
    if (at !== -1) {
      threads = threads.map((t, i) => (i === at ? row : t));
    } else {
      // Back in after the nearest row that preceded it and is still listed,
      // which is its old place whatever the list is ordered by.
      let after = -1;
      for (let i = index - 1; i >= 0 && after === -1; i--) {
        after = threads.findIndex((t) => t.thread_id === prev.threads[i].thread_id);
      }
      threads = [...threads.slice(0, after + 1), row, ...threads.slice(after + 1)];
    }
    removedRows.delete(rememberKey(key, id));
  }
  // (A "load more" caught mid-flight has its own ending and must not be left
  // looking permanently busy.)
  return { ...cur, threads, loadingMore: false };
}

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Change rows in every cached list at once (the reader marking a thread read).
 * Needed because a refetch renews only the first page of a list: a row further
 * down would otherwise keep its old state.
 */
export function patchThreadRows(qc: QueryClient, threadIds: string[], patch: Partial<ThreadListRow>) {
  const ids = new Set(threadIds);
  qc.setQueriesData<ThreadListData>({ queryKey: ["threads"] }, (d) =>
    d && { ...d, threads: d.threads.map((t) => (ids.has(t.thread_id) ? { ...t, ...patch } : t)) },
  );
}

/** The inverse action used to undo a mutation (for future Undo affordance). */
export const INVERSE_ACTION: Partial<Record<MailAction, MailAction>> = {
  archive: "unarchive", unarchive: "archive",
  trash: "restore", restore: "trash",
  star: "unstar", unstar: "star",
  read: "unread", unread: "read",
  spam: "unspam", unspam: "spam",
  // Undoing an unsnooze needs the time it had; see useThreadActions.
  snooze: "unsnooze", unsnooze: "snooze",
};

/**
 * Mutation hook for thread actions. Applies optimistic updates to the
 * thread list, rolls back on error, and invalidates threads + counts on settle.
 */
export function useMutateThreads(view: View, q?: string, category?: string | null, domain?: string | null) {
  const qc = useQueryClient();
  // Must mirror useThreads' queryKey exactly or optimistic updates miss the cache.
  const key = threadsKey({ view, q, category, domain });
  // Every OTHER cached list gets the same change. A refetch only renews a
  // list's first page, so without this a thread trashed from the Inbox would
  // stay listed further down a cached All Mail until it expired.
  function applyToOtherLists(threadIds: string[], action: MailAction, until: number | undefined, active: readonly unknown[]) {
    for (const query of qc.getQueryCache().findAll({ queryKey: ["threads"] })) {
      if (sameKey(query.queryKey, active)) continue;
      const [, otherView, otherQ] = query.queryKey as [string, View, string];
      qc.setQueryData<ThreadListData>(
        query.queryKey,
        (d) => d && applyAction(d, threadIds, action, actionView(otherView, otherQ), query.queryKey, until),
      );
    }
  }
  return useMutation({
    mutationFn: ({ threadIds, action, until }: { threadIds: string[]; action: MailAction; until?: number }) => {
      // `until` is passed only when there is one, so every other action makes
      // exactly the call it always made.
      const rest: [] | [number] = until === undefined ? [] : [until];
      return threadIds.length === 1
        ? apiMutateThread(threadIds[0], action, ...rest).then(() => undefined)
        : apiMutateThreads(threadIds, action, ...rest).then(() => undefined);
    },
    onMutate: async ({ threadIds, action, until }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ThreadListData>(key);
      if (prev) {
        // The key says where the list is cached; the rules come from what the
        // list actually holds (search results are All Mail, see actionView).
        qc.setQueryData<ThreadListData>(key, applyAction(prev, threadIds, action, actionView(view, q), key, until));
      }
      // The key travels with the snapshot. By the time this fails the hook
      // may have re-rendered for another view or search, and `key` would then
      // name a different list: the rollback wrote this view's rows into it.
      return { prev, key };
    },
    onError: (e, { threadIds, action, until }, ctx) => {
      // A bulk action sent in several requests can fail part way: only the
      // threads from the failing request onward were left unchanged.
      const failed = (e as { failedIds?: string[] } | null)?.failedIds ?? threadIds;
      if (ctx?.prev) {
        const { prev, key: listKey } = ctx;
        qc.setQueryData<ThreadListData>(listKey, (cur) => (cur ? rollBack(cur, prev, failed, listKey) : cur));
      }
      const done = threadIds.filter((id) => !failed.includes(id));
      if (done.length) applyToOtherLists(done, action, until, ctx?.key ?? key);
    },
    onSuccess: (_d, { threadIds, action, until }, ctx) => {
      applyToOtherLists(threadIds, action, until, ctx?.key ?? key);
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

/** GET /api/blocked — the block list; only fetched while the manager is open. */
export function useBlocked(enabled: boolean) {
  return useQuery<BlockedResponse>({
    queryKey: ["blocked"],
    queryFn: () => listBlocked(),
    enabled,
  });
}

/** Block or unblock a sender, refreshing the list on success. */
export function useBlockedMutations() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["blocked"] });
  const add = useMutation({ mutationFn: (address: string) => addBlocked(address), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (address: string) => removeBlocked(address), onSuccess: refresh });
  return { add, remove };
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
      // Both of these feed compose through GET /api/identities: the sender name
      // via the From prefill, the signature via the seeded body. Without this
      // the user saves a signature and the very next compose still seeds the
      // old one until a reload.
      if ("displayName" in patch || "signature" in patch) {
        void qc.invalidateQueries({ queryKey: ["identities"] });
      }
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
