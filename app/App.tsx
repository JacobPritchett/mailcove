import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Menu, PenSquare, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import Sidebar, { SidebarContent } from "@/components/Sidebar";
import MessageList from "@/components/MessageList";
import SearchField from "@/components/SearchField";
import BulkActionBar from "@/components/BulkActionBar";
import Reader from "@/components/Reader";
import DraftsList from "@/components/DraftsList";
import ComposeDialog, {
  type ComposeInitial,
} from "@/components/ComposeDialog";
import CommandPalette from "@/components/CommandPalette";
import ShortcutHelpDialog from "@/components/ShortcutHelpDialog";
import DomainsDialog from "@/components/DomainsDialog";
import FiltersDialog from "@/components/FiltersDialog";
import SettingsDialog from "@/components/SettingsDialog";
import { Toaster } from "@/components/ui/sonner";
import { useThreads, useCounts } from "@/lib/queries";
import { actionLabel, actionView } from "@/lib/actions";
import { useThreadActions, type ActionOptions } from "@/lib/useThreadActions";
import { useIsDesktop, useIsWide } from "@/lib/useMediaQuery";
import { useBackClose, BACK_LAYER } from "@/lib/useBackClose";
import { useKeyboardScrollReset } from "@/lib/useKeyboardScrollReset";
import { useUnreadBadge } from "@/lib/useUnreadBadge";
import { CATEGORY_FILTERS } from "@/lib/categories";
import { cn } from "@/lib/utils";
import { useKeyboardShortcuts } from "@/lib/useKeyboardShortcuts";
import type { MailAction, NavView, View, ViewCounts } from "@/lib/types";
import type { ReplyMode } from "@/lib/conversation";
import { nextUnsentCheck, reportUnsent, undoLastHeld } from "@/lib/outbox";
import { stashReply } from "@/lib/replyStash";
import { getDraft, listDrafts } from "@/lib/api";
import { draftToComposeInitial } from "@/components/DraftsList";
import { toast } from "sonner";
import { collectViewIds, SELECT_ALL_MAX } from "@/lib/selectAll";
import { mailtoFromSearch, type MailtoFields } from "@/lib/mailto";
import { openMailto, setMailtoComposer } from "@/lib/mailtoHandler";

const EMPTY_COUNTS: ViewCounts = {
  inbox: 0,
  starred: 0,
  sent: 0,
  all: 0,
  trash: 0,
  spam: 0,
  snoozed: 0,
  inboxUnread: 0,
};

const VIEW_TITLES: Record<NavView, string> = {
  inbox:   "Inbox",
  starred: "Starred",
  snoozed: "Snoozed",
  drafts:  "Drafts",
  sent:    "Sent",
  all:     "All Mail",
  spam:    "Junk",
  trash:   "Trash",
};

export default function App() {
  const [view, setView] = useState<NavView>("inbox");
  // Drafts is its own store — every server-backed thread surface keeps using a
  // real thread view (and the threads query is disabled while in Drafts).
  const isDraftsView = view === "drafts";
  const threadView: View = isDraftsView ? "inbox" : view;
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  // AI-label filter (null = All). Applies to plain views only — ignored while
  // searching (search is global FTS server-side).
  const [category, setCategory] = useState<string | null>(null);
  // Identity-domain filter (null = all inboxes). Unlike the category it also
  // applies while searching.
  const [domainFilter, setDomainFilter] = useState<string | null>(null);

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // "Select all N in this view": the selection stands for the whole view,
  // loaded or not (see lib/selectAll). Any change to the selection ends it.
  const [wholeView, setWholeView] = useState(false);

  // Mobile single-pane view state. Only consulted below `md` (the desktop layout
  // always shows both panes via responsive classes). Tapping a thread flips to
  // "reader"; the back arrow flips it to "list".
  const [mobileView, setMobileView] = useState<"list" | "reader">("list");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const isDesktop = useIsDesktop();
  // Wide enough for the full sidebar; below it the sidebar is an icon rail
  // whose first button opens the drawer.
  const isWide = useIsWide();

  // Single ComposeDialog instance: `composeOpen` toggles it, `composeInitial`
  // carries reply prefill (undefined → blank compose).
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInitial, setComposeInitial] = useState<
    ComposeInitial | undefined
  >(undefined);

  // ⌘K command palette.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // ? keyboard-shortcut help dialog.
  const [helpOpen, setHelpOpen] = useState(false);

  // Read-only Domains (Email Routing) admin dashboard.
  const [domainsOpen, setDomainsOpen] = useState(false);

  // Open the Domains dashboard (and close the mobile drawer if it was open).
  function openDomains() {
    setDrawerOpen(false);
    setDomainsOpen(true);
  }

  // Inbox rules manager.
  const [filtersOpen, setFiltersOpen] = useState(false);
  function openFilters() {
    setDrawerOpen(false);
    setFiltersOpen(true);
  }

  // Per-browser settings (undo send, email links).
  const [settingsOpen, setSettingsOpen] = useState(false);
  function openSettings() {
    setDrawerOpen(false);
    setSettingsOpen(true);
  }

  useKeyboardScrollReset();

  function openCompose() {
    setComposeInitial(undefined);
    setComposeOpen(true);
  }

  function focusSearch() {
    // On mobile the search input is conditionally rendered, so the ref is null
    // until `mobileSearchOpen` flips and React commits the input. Just request
    // the open here; the effect below focuses/selects once the input exists.
    // On desktop the input is always mounted, so focus immediately.
    if (isDesktop) {
      searchRef.current?.focus();
      searchRef.current?.select();
    } else {
      setMobileSearchOpen(true);
    }
  }

  // Focus the mobile search input after it renders. Runs whenever the mobile
  // search opens (incl. via the ⌘K "Focus search" action), guarding for null in
  // case the input isn't mounted (e.g. desktop, where focusSearch handles it).
  useEffect(() => {
    if (!mobileSearchOpen) return;
    const id = requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [mobileSearchOpen]);

  // Replies happen INLINE at the bottom of the open thread (Gmail-style). App
  // owns the open flag so the `r` shortcut can flip it and thread switches
  // reset it; the dialog remains the escape hatch (expand button) for
  // recipient/subject edits.
  const [replyOpen, setReplyOpen] = useState(false);
  // Who the open reply goes to. Reset to a plain reply whenever one is opened
  // without saying otherwise, so reply all is always a deliberate choice.
  const [replyMode, setReplyMode] = useState<ReplyMode>("reply");
  // `r` and `a`: a request the reader carries out, since only it knows who the
  // thread's default reply goes to (and whether a reply is already being written).
  // `messageId` names the message to answer when it is not the default one
  // (a reply put back by Undo send goes back to the message it answered).
  const [replyRequest, setReplyRequest] = useState<{ mode: ReplyMode; nonce: number; messageId?: string | null }>({
    mode: "reply",
    nonce: 0,
  });
  const [forwardNonce, setForwardNonce] = useState(0);
  // Same idea for `b`: the snooze menu belongs to the reader's toolbar.
  const [snoozeNonce, setSnoozeNonce] = useState(0);

  // ANY thread change closes the inline composer — including j/k keyboard
  // navigation, which doesn't go through handleSelectThread.
  useEffect(() => {
    setReplyOpen(false);
    setReplyMode("reply");
  }, [selectedThreadId]);
  // A reply that has closed (sent, discarded) leaves nothing behind: the next
  // one is a plain reply again unless it is asked for as reply all.
  useEffect(() => {
    if (!replyOpen) setReplyMode("reply");
  }, [replyOpen]);

  // Belt-and-braces for the iOS keyboard scroll trap (see the hook): when a
  // composer closes, make sure the fixed shell is back at the top. The
  // scrollY guard keeps this a no-op in jsdom and on desktop.
  useEffect(() => {
    if (!replyOpen && !composeOpen && window.scrollY !== 0) window.scrollTo(0, 0);
  }, [replyOpen, composeOpen]);

  /** Open the full compose dialog with a prefill (inline composer hand-off). */
  function openComposeWith(initial: ComposeInitial) {
    setReplyOpen(false);
    // Already open on another message (Undo send pressed while writing the
    // next one): the dialog only reads its prefill as it opens, so close it
    // first. Closing keeps what was being written as a draft.
    if (composeOpenRef.current) {
      setComposeOpen(false);
      setTimeout(() => {
        setComposeInitial(initial);
        setComposeOpen(true);
      }, 0);
      return;
    }
    setComposeInitial(initial);
    setComposeOpen(true);
  }

  // What the handlers below need to know NOW. They are called from toasts and
  // timers long after the render that created them.
  const composeOpenRef = useRef(composeOpen);
  composeOpenRef.current = composeOpen;
  const hereRef = useRef({ selectedThreadId, replyOpen, readerShowing: true });

  /**
   * Undo send on an inline reply. Back where it was written when that
   * conversation is still open and no other reply has been started in it;
   * otherwise in the full composer, which holds the same recipients, quote
   * and draft.
   */
  function undoReplySend(u: { initial: ComposeInitial; mode: ReplyMode; messageId: string | null }) {
    const threadId = u.initial.threadId;
    const here = hereRef.current;
    const text = u.initial.text ?? "";
    if (
      threadId &&
      here.selectedThreadId === threadId &&
      here.readerShowing &&
      !here.replyOpen &&
      // The inline composer picks a reply up from this local copy as it opens.
      stashReply(threadId, { text, json: u.initial.bodyJson ?? "", draftId: u.initial.draftId })
    ) {
      setReplyRequest((r) => ({ mode: u.mode, messageId: u.messageId, nonce: r.nonce + 1 }));
      return;
    }
    openComposeWith(u.initial);
  }

  /** Open a saved draft in the compose dialog (the "Open draft" of a toast). */
  async function openDraftById(id: string) {
    try {
      openComposeWith(draftToComposeInitial(await getDraft(id)));
    } catch {
      handleView("drafts");
    }
  }
  const openDraftRef = useRef(openDraftById);
  openDraftRef.current = openDraftById;

  // mailto: links. Three ways in, one way through (openMailto): the browser
  // handing us a link from another site (/?compose=mailto:..., see
  // lib/mailtoHandler), a link inside a message frame (lib/emailFrame), and a
  // link anywhere in the app's own markup (a plain-text body, chat mode).
  // Each only opens the composer filled in. Sending stays the user's act.
  const openComposeRef = useRef(openComposeWith);
  openComposeRef.current = openComposeWith;
  useEffect(() => {
    const withdraw = setMailtoComposer((f: MailtoFields) =>
      openComposeRef.current({
        to: f.to || undefined,
        cc: f.cc || undefined,
        bcc: f.bcc || undefined,
        subject: f.subject || undefined,
        text: f.body || undefined,
        // A new message, so the signature may still be seeded (into an empty
        // body only), and one closed untouched is not worth a draft.
        replyQuote: "",
        generated: true,
      }),
    );
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      const href = link?.getAttribute("href") ?? "";
      if (/^\s*mailto:/i.test(href) && openMailto(href)) e.preventDefault();
    };
    document.addEventListener("click", onClick);
    const params = new URLSearchParams(window.location.search);
    const handed = mailtoFromSearch(window.location.search);
    if (params.has("compose")) {
      if (handed) openMailto(handed);
      // Gone from the address bar either way: a reload must not reopen it.
      params.delete("compose");
      const rest = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash,
      );
    }
    return () => {
      withdraw();
      document.removeEventListener("click", onClick);
    };
  }, []);

  // A message sent as an earlier page went away may not have made it. Ask
  // once the Worker has had time to answer, now or when that time comes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const at = nextUnsentCheck();
      if (at === null) return;
      const wait = at - Date.now();
      if (wait > 0) {
        timer = setTimeout(check, wait + 50);
        return;
      }
      void reportUnsent(
        async () => (await listDrafts()).drafts.map((d) => d.id),
        (id) => void openDraftRef.current(id),
      );
    };
    check();
    return () => clearTimeout(timer);
  }, []);

  // Selecting a thread: on mobile, navigate to the full-screen reader.
  function handleSelectThread(threadId: string) {
    setSelectedThreadId(threadId);
    setReplyOpen(false);
    setMobileView("reader");
  }

  // Escape in the search box: clear a query first, and only leave the field
  // once it is already empty (the reverse of `/`, which focuses it).
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (search) setSearch("");
    else e.currentTarget.blur();
  }

  // A thread can be opened from outside the app's own UI: a notification tap
  // on an open window arrives as a service-worker message, and a cold start
  // from one arrives as /?thread=<id> (see public/sw.js). Either way it is just
  // a selection — nothing here navigates or reloads, so an open compose stays.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("thread");
    if (fromUrl) {
      handleSelectThread(fromUrl);
      // Strip it, or a later reload would reopen a thread the user has since
      // left. replaceState: this must not add a Back entry.
      params.delete("thread");
      const rest = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash,
      );
    }
    const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!sw) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; threadId?: unknown } | null;
      if (data?.type === "open-thread" && typeof data.threadId === "string" && data.threadId) {
        handleSelectThread(data.threadId);
      }
    };
    sw.addEventListener("message", onMessage);
    return () => sw.removeEventListener("message", onMessage);
    // handleSelectThread only calls state setters; mount-only on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce the search input (~250ms) before it drives the messages query.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer.current);
  }, [search]);

  // Active view/search results — drives the subtle search hint under the box.
  // Category narrows plain views; while searching it's not applied (passed null).
  const searching = q.length > 0;
  const activeCategory = searching ? null : category;
  // The domain filter stays on while searching (the Worker honours it there).
  const activeDomain = domainFilter;
  const active = useThreads(threadView, q, activeCategory, activeDomain, !isDraftsView);
  const counts = useCounts();
  // "(3) Inbox" in the tab, and the badge on the installed app's icon.
  useUnreadBadge(counts.data?.inboxUnread);

  // If the filtered domain disappears from the counts (e.g. its last thread was
  // deleted, or the setup went back to single-domain and the switcher hides),
  // clear the filter — otherwise an invisible stale filter empties every view.
  const countDomains = counts.data?.domains;
  useEffect(() => {
    if (domainFilter && countDomains && !countDomains.some((d) => d.domain === domainFilter)) {
      setDomainFilter(null);
    }
  }, [domainFilter, countDomains]);
  // Every thread action (keyboard, reader toolbar, list rows, bulk bar) goes
  // through this one runner, so `z` undoes whichever came last.
  const threadActions = useThreadActions(threadView, q, activeCategory, activeDomain);
  // Which actions apply to what is listed: All Mail rules while searching.
  const actionsView = actionView(threadView, q);
  const debouncePending = searching && q !== search.trim();
  let searchHint: string | null = null;
  if (searching) {
    if (active.isFetching || debouncePending) {
      searchHint = "Searching…";
    } else if (active.data) {
      const n = active.data.threads.length;
      // More pages to come: the loaded count is a floor, not the total.
      const count = `${n}${active.hasMore ? "+" : ""}`;
      // Say so when the results are narrowed to one domain: a search that
      // quietly leaves out the other inboxes looks like missing mail.
      const where = activeDomain ? ` in ${activeDomain}` : "";
      searchHint = n === 0 ? `No matches${where}` : `${count} result${n === 1 ? "" : "s"}${where}`;
    }
  }

  function handleView(next: NavView) {
    setView(next);
    setSelectedThreadId(null);
    setMobileView("list");
    setDrawerOpen(false);
    setCategory(null);
    clearSelection();
  }

  // Clear multi-select whenever the debounced search query, the category
  // filter OR the domain filter changes — selected threads may no longer be
  // visible in the new set, and the bulk bar would act on rows nobody can see.
  useEffect(() => {
    clearSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, domainFilter]);

  // Selection helpers for multi-select.
  function toggleSelect(id: string) {
    setWholeView(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setWholeView(false);
    setSelectedIds(new Set());
  }

  function selectAll() {
    setWholeView(false);
    setSelectedIds(new Set(threadOrder));
  }

  function selectRange(anchorId: string, id: string) {
    const anchorIdx = threadOrder.indexOf(anchorId);
    const targetIdx = threadOrder.indexOf(id);
    if (anchorIdx === -1 || targetIdx === -1) return;
    const start = Math.min(anchorIdx, targetIdx);
    const end = Math.max(anchorIdx, targetIdx);
    setWholeView(false);
    setSelectedIds(new Set(threadOrder.slice(start, end + 1)));
  }

  function handleBulkAction(action: MailAction, opts?: ActionOptions) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (wholeView) {
      clearSelection();
      void runOnWholeView(action, opts);
      return;
    }
    clearSelection();
    threadActions.run(ids, action, {
      ...opts,
      undoUntil: action === "unsnooze" ? sharedSnoozeTime(ids) : undefined,
      label: `${ids.length} ${actionLabel(action).toLowerCase()}`,
    });
  }

  /**
   * A bulk action on the whole view. The ids are collected first, then it is
   * the same action as any other: one toast, one Undo, the same optimistic
   * update for the rows that are loaded.
   */
  async function runOnWholeView(action: MailAction, opts?: ActionOptions) {
    const toastId = "select-all";
    toast.loading("Finding every conversation in this view\u2026", { id: toastId, duration: Infinity });
    let found;
    try {
      found = await collectViewIds({ view: threadView, q, category: activeCategory, domain: activeDomain });
    } catch {
      toast.error("Couldn't read the whole view. Nothing was changed.", { id: toastId, duration: 6000 });
      return;
    }
    toast.dismiss(toastId);
    if (found.ids.length === 0) return;
    threadActions.run(found.ids, action, {
      ...opts,
      label: `${found.ids.length.toLocaleString()} ${actionLabel(action).toLowerCase()}`,
    });
    if (found.capped) {
      toast(`That was the first ${SELECT_ALL_MAX.toLocaleString()}. Select all again for the rest.`, { duration: 10_000 });
    }
  }

  /**
   * The time these threads are snoozed until, when they all share one. Undoing
   * an unsnooze has a single time to put back; with several it offers no Undo.
   */
  function sharedSnoozeTime(ids: string[]): number | null {
    const rows = active.data?.threads ?? [];
    const times = new Set(ids.map((id) => rows.find((t) => t.thread_id === id)?.snoozedUntil ?? null));
    const [only] = times;
    return times.size === 1 ? (only ?? null) : null;
  }

  /**
   * After a keyboard archive/trash: carry on to the next thread on desktop
   * (the previous one when it was the last), so `j` continues from where the
   * user was instead of jumping back to the top. On mobile there is one pane,
   * and leaving it on a now-empty reader is a dead end, so go back to the list.
   */
  function leaveThread(id: string) {
    if (!isDesktop) {
      setSelectedThreadId(null);
      setMobileView("list");
      return;
    }
    const idx = threadOrder.indexOf(id);
    setSelectedThreadId(idx === -1 ? null : (threadOrder[idx + 1] ?? threadOrder[idx - 1] ?? null));
  }

  // Ordered list of thread_ids for j/k navigation. Empty in Drafts: the
  // threads query is disabled there but still holds the cached inbox, and the
  // shortcuts would select and trash threads that are not on screen.
  const threadOrder = useMemo(
    () =>
      active.data && !isDraftsView ? active.data.threads.map((t) => t.thread_id) : [],
    [active.data, isDraftsView],
  );

  // Central keyboard shortcut handler. Suppressed while any dialog is open
  // (the hook also bails for keys typed inside ANY dialog, which covers the
  // confirm dialogs and the mobile drawer that are not listed here).
  useKeyboardShortcuts(
    {
      onNext() {
        if (threadOrder.length === 0) return;
        const idx = selectedThreadId ? threadOrder.indexOf(selectedThreadId) : -1;
        // On the last loaded row with more on the server: fetch the next page
        // and step onto its first row, unless the selection moved meanwhile.
        if (idx === threadOrder.length - 1 && active.hasMore) {
          const from = selectedThreadId;
          void active.fetchMore().then((added) => {
            if (added.length > 0) setSelectedThreadId((cur) => (cur === from ? added[0].thread_id : cur));
          });
          return;
        }
        const next = Math.min(idx + 1, threadOrder.length - 1);
        setSelectedThreadId(threadOrder[next < 0 ? 0 : next]);
        setMobileView("reader");
      },
      onPrev() {
        if (threadOrder.length === 0) return;
        const idx = selectedThreadId ? threadOrder.indexOf(selectedThreadId) : -1;
        const prev = Math.max(idx - 1, 0);
        setSelectedThreadId(threadOrder[prev < 0 ? 0 : prev]);
        setMobileView("reader");
      },
      onOpen() {
        if (!selectedThreadId) return; // nothing selected → don't open an empty reader
        setMobileView("reader");
      },
      onBackToList() {
        setMobileView("list");
      },
      onArchive() {
        // Trash and Junk have nothing to archive (the Worker ignores it there).
        if (!selectedThreadId || actionsView === "trash" || actionsView === "spam") return;
        const id = selectedThreadId;
        leaveThread(id);
        threadActions.run([id], "archive");
      },
      onTrash() {
        if (!selectedThreadId || actionsView === "trash") return;
        const id = selectedThreadId;
        leaveThread(id);
        threadActions.run([id], "trash");
      },
      onSpam() {
        // Nothing to report in Junk itself, and Trash offers Restore instead.
        if (!selectedThreadId || actionsView === "trash" || actionsView === "spam") return;
        const id = selectedThreadId;
        leaveThread(id);
        threadActions.run([id], "spam");
      },
      onSnooze() {
        if (selectedThreadId) setSnoozeNonce((n) => n + 1);
      },
      onStar() {
        if (!selectedThreadId) return;
        const threads = active.data?.threads ?? [];
        const row = threads.find((t) => t.thread_id === selectedThreadId);
        const action: MailAction = row?.starred === 1 ? "unstar" : "star";
        threadActions.run([selectedThreadId], action);
      },
      onSelect() {
        if (selectedThreadId) toggleSelect(selectedThreadId);
      },
      onSelectAll() {
        selectAll();
      },
      onSelectNone() {
        clearSelection();
      },
      onReply() {
        // `r` opens the INLINE reply at the bottom of the open thread.
        if (selectedThreadId) setReplyRequest((r) => ({ mode: "reply", nonce: r.nonce + 1 }));
      },
      onReplyAll() {
        if (selectedThreadId) setReplyRequest((r) => ({ mode: "reply-all", nonce: r.nonce + 1 }));
      },
      onForward() {
        if (selectedThreadId) setForwardNonce((n) => n + 1);
      },
      onCompose() {
        openCompose();
      },
      onFocusSearch() {
        focusSearch();
      },
      onUndo() {
        // A message still being held comes first: it is the one thing here
        // that cannot be taken back a moment later.
        if (!undoLastHeld()) threadActions.undoLast();
      },
      onHelp() {
        setHelpOpen(true);
      },
      onEscape() {
        if (selectedIds.size > 0) {
          clearSelection();
        } else {
          setMobileView("list");
        }
      },
      onGoView(v: View) {
        handleView(v);
      },
    },
    composeOpen || paletteOpen || helpOpen || domainsOpen || filtersOpen || settingsOpen,
  );

  const viewTitle = VIEW_TITLES[view];
  // While searching, the result list spans all mail (global FTS), so the pane
  // header reflects that rather than the selected view.
  const listTitle = searching ? "Search results" : viewTitle;
  const sidebarCounts = counts.data ?? EMPTY_COUNTS;
  // On mobile, the reader fills the screen; the back arrow returns to the list.
  const mobileShowingReader = !isDesktop && mobileView === "reader";
  // Every loaded row is selected and the server has more: offer the rest.
  const allLoadedSelected = threadOrder.length > 0 && selectedIds.size === threadOrder.length;
  // How many that is, where the counts say (a plain view: no search, label
  // or domain narrowing it). Otherwise the offer is made without a number.
  const viewTotal =
    !searching && !activeCategory && !activeDomain && !isDraftsView ? (sidebarCounts[threadView] ?? 0) : 0;
  const selectAllOffer =
    allLoadedSelected && (wholeView || active.hasMore) ? (
      <SelectAllBanner
        loaded={threadOrder.length}
        total={viewTotal}
        wholeView={wholeView}
        onSelectAll={() => setWholeView(true)}
        onClear={clearSelection}
      />
    ) : null;
  hereRef.current = { selectedThreadId, replyOpen, readerShowing: isDesktop || mobileShowingReader };

  // Hardware/browser Back closes mobile overlays instead of leaving the app.
  // Reader: Back returns to the list. A no-op on desktop (enabled is gated by
  // !isDesktop), so desktop nav is intact. The drawer and every dialog register
  // themselves (see the ui Dialog/Sheet/AlertDialog wrappers) at a higher
  // priority, so Back always closes what is on top of the reader first.
  useBackClose(mobileShowingReader, () => setMobileView("list"), !isDesktop, BACK_LAYER.pane);
  // Selection mode on a phone is a state the user entered (a long press) and
  // expects Back to leave, like any other.
  useBackClose(!mobileShowingReader && selectedIds.size > 0, clearSelection, !isDesktop, BACK_LAYER.pane);

  // Crossing to a width with the full sidebar (resize/rotate): close the
  // drawer so a Sheet can't linger over a layout that already shows it all.
  useEffect(() => {
    if (isDesktop && isWide && drawerOpen) setDrawerOpen(false);
  }, [isDesktop, isWide, drawerOpen]);

  return (
    // Dynamic-viewport height (with a 100vh fallback for pre-dvh Safari): the
    // shell must shrink with the iOS keyboard (interactive-widget=
    // resizes-content) instead of letting the page scroll into a stuck offset.
    <div data-print-flow className="flex h-screen supports-[height:100dvh]:h-dvh w-full overflow-hidden bg-background text-foreground">
      <Sidebar
        view={view}
        onView={handleView}
        counts={sidebarCounts}
        domainFilter={domainFilter}
        onDomainFilter={setDomainFilter}
        onOpenDomains={openDomains}
        onOpenFilters={openFilters}
        onOpenSettings={openSettings}
        onOpenMenu={() => setDrawerOpen(true)}
      />

      {/* The drawer: view nav + theme + account, on a phone and behind the
          rail's menu button. Selecting a view closes it (handleView sets
          drawerOpen=false). */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="left"
          className="w-72 p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="pb-0">
            <SheetTitle className="flex items-center gap-2 text-lg">
              <span aria-hidden>📨</span> Mailcove
            </SheetTitle>
            <SheetDescription className="sr-only">
              Folders and account
            </SheetDescription>
          </SheetHeader>
          <SidebarContent
            view={view}
            onView={handleView}
            counts={sidebarCounts}
            domainFilter={domainFilter}
            onDomainFilter={(d) => {
              setDomainFilter(d);
              setDrawerOpen(false);
            }}
            onOpenDomains={openDomains}
            onOpenFilters={openFilters}
            onOpenSettings={openSettings}
            showBrand={false}
          />
        </SheetContent>
      </Sheet>

      {/* Message list pane.
          Desktop: fixed 320px column, always visible.
          Mobile: full width; hidden when the reader is showing. */}
      <section
        // Printing shows the open conversation alone (see lib/print).
        data-print-hide
        className={cn(
          // min-h-0 for the same reason as the reader column: without it this
          // grows to its content height and the list's ScrollArea never scrolls.
          // The same 320px at every desktop width, a tablet included: a row's
          // hover actions are sized for it, and any narrower they sit over
          // the middle of the subject, where a click to open the thread lands.
          "flex min-w-0 flex-1 flex-col border-r md:w-80 md:flex-none md:shrink-0",
          mobileShowingReader && "hidden md:flex",
        )}
      >
        {/* Mobile app bar — hamburger, view title, search, compose.
            Rendered only on mobile while the list view is active, so the DOM
            mirrors what's on screen (the desktop layout uses CSS classes; mobile
            view selection is JS-driven). pt safe-area for the notch. */}
        {/* While threads are selected on a phone, the selection's own bar takes
            the app bar's place: its actions, and the way out of selecting. */}
        {!isDesktop && !mobileShowingReader && selectedIds.size > 0 && (
          <div className="bg-accent/30 pt-[env(safe-area-inset-top)] md:hidden">
            <BulkActionBar
              count={wholeView ? viewTotal : selectedIds.size}
              wholeView={wholeView}
              view={actionsView}
              onClear={clearSelection}
              onAction={handleBulkAction}
              className="min-h-14 bg-transparent"
            />
            {selectAllOffer}
          </div>
        )}
        {!isDesktop && !mobileShowingReader && selectedIds.size === 0 && (
          <div className="flex flex-col border-b pt-[env(safe-area-inset-top)] md:hidden">
            <div className="flex h-14 items-center gap-1 px-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </Button>
              <h1 className="flex-1 truncate text-base font-semibold">
                {listTitle}
              </h1>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11"
                onClick={() => setMobileSearchOpen((v) => !v)}
                aria-label="Search messages"
                aria-pressed={mobileSearchOpen}
              >
                <Search className="h-5 w-5" />
              </Button>
              <Button
                type="button"
                size="icon"
                className="size-11"
                onClick={openCompose}
                aria-label="Compose"
              >
                <PenSquare className="h-5 w-5" />
              </Button>
            </div>
            {mobileSearchOpen && (
              <div className="px-2 pb-2">
                <SearchField
                  inputRef={searchRef}
                  value={search}
                  onChange={setSearch}
                  onKeyDown={onSearchKeyDown}
                  label="Search messages input"
                  autoFocus
                  inputClassName="h-11"
                />
              </div>
            )}
          </div>
        )}

        {/* Desktop search bar. */}
        <div className="hidden h-14 items-center gap-2 px-4 md:flex">
          <div className="flex-1">
            <SearchField
              inputRef={isDesktop ? searchRef : undefined}
              value={search}
              onChange={setSearch}
              onKeyDown={onSearchKeyDown}
              label="Search messages"
              inputClassName="h-9"
            />
          </div>
        </div>
        {searchHint && (
          <p
            className="px-4 pb-1 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {searchHint}
          </p>
        )}
        <Separator className="hidden md:block" />
        {isDesktop && selectedIds.size > 0 && (
          <>
            <BulkActionBar
              count={wholeView ? viewTotal : selectedIds.size}
              wholeView={wholeView}
              view={actionsView}
              onClear={clearSelection}
              onAction={handleBulkAction}
            />
            {selectAllOffer}
          </>
        )}
        {/* AI-label filter bar — plain inbound views only, hidden while searching
            (search is global). */}
        {!searching && (view === "inbox" || view === "all") && (
          <div className="relative">
            <div className="flex items-center gap-1.5 overflow-x-auto px-4 py-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {CATEGORY_FILTERS.map((f) => {
              const activeF = (f.value ?? null) === (category ?? null);
              return (
                <button
                  key={f.label}
                  type="button"
                  onClick={() => setCategory(f.value)}
                  aria-pressed={activeF}
                  className={cn(
                    // Comfortable 44px tap target on touch; compact on desktop.
                    "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors max-md:min-h-11 max-md:px-4 max-md:text-sm",
                    activeF
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {f.label}
                </button>
              );
            })}
            </div>
            {/* Right-edge fade hinting the chip row scrolls horizontally. At
                every width: the desktop list column is no wider than a phone,
                and the last chips are off its edge there too.
                pointer-events-none so it never blocks a tap. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent"
            />
          </div>
        )}
        {isDraftsView ? (
          <DraftsList onOpen={openComposeWith} />
        ) : (
        <MessageList
          view={threadView}
          q={q}
          category={activeCategory}
          domain={activeDomain}
          showDomain={!activeDomain && (sidebarCounts.domains?.length ?? 0) > 1}
          selectedThreadId={selectedThreadId}
          onSelect={handleSelectThread}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectRange={selectRange}
          onAction={threadActions.run}
          onCompose={openCompose}
          onClearSearch={() => setSearch("")}
        />
        )}
      </section>

      {/* Reader pane.
          Desktop: fills the remaining space, always visible.
          Mobile: full-screen; hidden unless mobileView === "reader". */}
      <div
        data-print-flow
        className={cn(
          // min-h-0: without it this column grows to its content height and the
          // reader's internal ScrollArea never becomes the scroller.
          "min-w-0 flex-1 flex-col",
          mobileShowingReader ? "flex" : "hidden md:flex",
        )}
      >
        {/* Desktop top bar — command palette + compose. */}
        <div data-print-hide className="hidden h-14 items-center justify-end gap-2 px-4 md:flex">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPaletteOpen(true)}
            title="Command palette"
            aria-label="Open command palette"
            className="gap-2 text-muted-foreground"
          >
            <Search className="h-4 w-4" />
            <span className="hidden sm:inline">Search</span>
            <kbd className="pointer-events-none hidden h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[0.65rem] font-medium sm:inline-flex">
              <span className="text-xs">⌘</span>K
            </kbd>
          </Button>
          <Button type="button" size="sm" onClick={openCompose} title="Compose">
            <PenSquare className="h-4 w-4" />
            Compose
          </Button>
        </div>
        <Separator data-print-hide className="hidden md:block" />
        <Reader
          threadId={selectedThreadId}
          view={actionsView}
          replyOpen={replyOpen}
          onReplyOpenChange={setReplyOpen}
          replyMode={replyMode}
          onReplyRequest={(mode) => {
            setReplyMode(mode);
            setReplyOpen(true);
          }}
          replyRequest={replyRequest}
          forwardNonce={forwardNonce}
          snoozeNonce={snoozeNonce}
          // Phone: the reader draws its own top bar, Back at one end and
          // Compose at the other, with the thread's actions between them.
          mobileChrome={
            mobileShowingReader
              ? {
                  leading: (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11"
                      onClick={() => setMobileView("list")}
                      aria-label="Back to list"
                    >
                      <ArrowLeft className="h-5 w-5" />
                    </Button>
                  ),
                  trailing: (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      // The narrowest phones have room for the actions or for
                      // this, not both; compose is one Back away on those.
                      className="size-11 max-[340px]:hidden"
                      onClick={openCompose}
                      aria-label="Compose"
                    >
                      <PenSquare className="h-5 w-5" />
                    </Button>
                  ),
                }
              : undefined
          }
          onOpenCompose={openComposeWith}
          onUndoReplySend={undoReplySend}
          onAction={(action, opts) => {
            if (!selectedThreadId) return;
            const id = selectedThreadId;
            // Snoozing is triage, usually from the keyboard (`b`): carry on to
            // the next thread, as the keyboard archive does.
            if (action === "snooze" || action === "unsnooze") {
              const undoUntil = action === "unsnooze" ? (opts?.undoUntil ?? sharedSnoozeTime([id])) : undefined;
              leaveThread(id);
              threadActions.run([id], action, { ...opts, undoUntil });
              return;
            }
            threadActions.run([id], action, opts);
            // Navigate away from the thread for destructive/move actions
            const navigatesAway = ["archive", "unarchive", "trash", "restore", "delete", "spam", "unspam"].includes(action);
            if (navigatesAway) {
              setSelectedThreadId(null);
              setMobileView("list");
            }
          }}
        />
      </div>

      <ComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        initial={composeInitial}
        onReopen={openComposeWith}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onCompose={openCompose}
        onGoView={handleView}
        onFocusSearch={focusSearch}
        onShowShortcuts={() => setHelpOpen(true)}
        onOpenDomains={openDomains}
        onOpenFilters={openFilters}
        onOpenSettings={openSettings}
      />
      <ShortcutHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <DomainsDialog open={domainsOpen} onOpenChange={setDomainsOpen} />
      <FiltersDialog open={filtersOpen} onOpenChange={setFiltersOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <Toaster />
    </div>
  );
}

/**
 * Shown under the bulk bar once every loaded row is selected and the view has
 * more: the selection is only what is loaded, and here is the way to mean
 * all of it. After that it says so, and offers the way back.
 */
function SelectAllBanner({
  loaded,
  total,
  wholeView,
  onSelectAll,
  onClear,
}: {
  loaded: number;
  /** Size of the view, or 0 when it is not known. */
  total: number;
  wholeView: boolean;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const link =
    "rounded px-1 font-medium text-primary underline underline-offset-2 hover:bg-accent max-md:inline-flex max-md:min-h-11 max-md:items-center";
  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-x-1 border-b bg-accent/20 px-4 py-1.5 text-xs text-muted-foreground"
    >
      {wholeView ? (
        <>
          <span>{total ? `All ${total.toLocaleString()} conversations in this view are selected.` : "Every conversation in this view is selected."}</span>
          <button type="button" onClick={onClear} className={link}>
            Clear selection
          </button>
        </>
      ) : (
        <>
          <span>The {loaded.toLocaleString()} loaded so far are selected.</span>
          <button type="button" onClick={onSelectAll} className={link}>
            {total ? `Select all ${total.toLocaleString()} in this view` : "Select all in this view"}
          </button>
        </>
      )}
    </p>
  );
}
