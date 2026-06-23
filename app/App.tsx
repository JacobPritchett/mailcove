import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Menu, PenSquare, Search } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
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
import { Toaster } from "@/components/ui/sonner";
import { useThreads, useCounts, useMutateThreads, INVERSE_ACTION } from "@/lib/queries";
import { actionLabel, isReversible } from "@/lib/actions";
import { useIsDesktop } from "@/lib/useMediaQuery";
import { useBackClose } from "@/lib/useBackClose";
import { useKeyboardScrollReset } from "@/lib/useKeyboardScrollReset";
import { CATEGORY_FILTERS } from "@/lib/categories";
import { cn } from "@/lib/utils";
import { useKeyboardShortcuts } from "@/lib/useKeyboardShortcuts";
import type { MailAction, NavView, View, ViewCounts } from "@/lib/types";

const EMPTY_COUNTS: ViewCounts = {
  inbox: 0,
  starred: 0,
  sent: 0,
  all: 0,
  trash: 0,
  inboxUnread: 0,
};

const VIEW_TITLES: Record<NavView, string> = {
  inbox:   "Inbox",
  starred: "Starred",
  drafts:  "Drafts",
  sent:    "Sent",
  all:     "All Mail",
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
  // Identity-domain filter (null = all inboxes). Same plain-view scoping.
  const [domainFilter, setDomainFilter] = useState<string | null>(null);

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Mobile single-pane view state. Only consulted below `md` (the desktop layout
  // always shows both panes via responsive classes). Tapping a thread flips to
  // "reader"; the back arrow flips it to "list".
  const [mobileView, setMobileView] = useState<"list" | "reader">("list");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const isDesktop = useIsDesktop();

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

  // Tracks the last reversible action dispatched via keyboard, so `z` can undo it.
  const lastActionRef = useRef<{ threadIds: string[]; action: MailAction } | null>(null);

  const qc = useQueryClient();
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

  // ANY thread change closes the inline composer — including j/k keyboard
  // navigation, which doesn't go through handleSelectThread.
  useEffect(() => {
    setReplyOpen(false);
  }, [selectedThreadId]);

  // Belt-and-braces for the iOS keyboard scroll trap (see the hook): when a
  // composer closes, make sure the fixed shell is back at the top. The
  // scrollY guard keeps this a no-op in jsdom and on desktop.
  useEffect(() => {
    if (!replyOpen && !composeOpen && window.scrollY !== 0) window.scrollTo(0, 0);
  }, [replyOpen, composeOpen]);

  /** Open the full compose dialog with a prefill (inline composer hand-off). */
  function openComposeWith(initial: ComposeInitial) {
    setReplyOpen(false);
    setComposeInitial(initial);
    setComposeOpen(true);
  }

  // Selecting a thread: on mobile, navigate to the full-screen reader.
  function handleSelectThread(threadId: string) {
    setSelectedThreadId(threadId);
    setReplyOpen(false);
    setMobileView("reader");
  }

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
  const activeDomain = searching ? null : domainFilter;
  const active = useThreads(threadView, q, activeCategory, activeDomain, !isDraftsView);
  const counts = useCounts();

  // If the filtered domain disappears from the counts (e.g. its last thread was
  // deleted, or the setup went back to single-domain and the switcher hides),
  // clear the filter — otherwise an invisible stale filter empties every view.
  const countDomains = counts.data?.domains;
  useEffect(() => {
    if (domainFilter && countDomains && !countDomains.some((d) => d.domain === domainFilter)) {
      setDomainFilter(null);
    }
  }, [domainFilter, countDomains]);
  const { mutate: bulkMutate } = useMutateThreads(threadView, q, activeCategory, activeDomain);
  const debouncePending = searching && q !== search.trim();
  let searchHint: string | null = null;
  if (searching) {
    if (active.isFetching || debouncePending) {
      searchHint = "Searching…";
    } else if (active.data) {
      const n = active.data.threads.length;
      searchHint = n === 0 ? "No matches" : `${n} result${n === 1 ? "" : "s"}`;
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

  // Clear multi-select whenever the debounced search query OR the category
  // filter changes — selected threads may no longer be visible in the new set.
  useEffect(() => {
    clearSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category]);

  // Selection helpers for multi-select.
  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function selectAll() {
    setSelectedIds(new Set(threadOrder));
  }

  function selectRange(anchorId: string, id: string) {
    const anchorIdx = threadOrder.indexOf(anchorId);
    const targetIdx = threadOrder.indexOf(id);
    if (anchorIdx === -1 || targetIdx === -1) return;
    const start = Math.min(anchorIdx, targetIdx);
    const end = Math.max(anchorIdx, targetIdx);
    setSelectedIds(new Set(threadOrder.slice(start, end + 1)));
  }

  function handleBulkAction(action: MailAction) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    bulkMutate({ threadIds: ids, action });
    clearSelection();
    const label = `${ids.length} ${actionLabel(action).toLowerCase()}`;
    const inv = INVERSE_ACTION[action];
    if (isReversible(action) && inv) {
      toast(label, {
        action: {
          label: "Undo",
          onClick: () => bulkMutate({ threadIds: ids, action: inv }),
        },
      });
    } else {
      toast(label);
    }
  }

  /**
   * Execute a thread action via the bulk mutation, record it for undo,
   * and show an undo toast when the action is reversible.
   */
  function runThreadAction(threadIds: string[], action: MailAction) {
    bulkMutate({ threadIds, action });
    const inv = INVERSE_ACTION[action];
    if (isReversible(action) && inv) {
      lastActionRef.current = { threadIds, action };
      toast(actionLabel(action), {
        action: {
          label: "Undo",
          onClick: () => {
            bulkMutate({ threadIds, action: inv });
            lastActionRef.current = null;
          },
        },
      });
    } else {
      lastActionRef.current = null;
      toast(actionLabel(action));
    }
  }

  // Ordered list of thread_ids for j/k navigation.
  const threadOrder = useMemo(
    () =>
      active.data ? active.data.threads.map((t) => t.thread_id) : [],
    [active.data],
  );

  // Central keyboard shortcut handler. Suppressed while any dialog is open.
  useKeyboardShortcuts(
    {
      onNext() {
        if (threadOrder.length === 0) return;
        const idx = selectedThreadId ? threadOrder.indexOf(selectedThreadId) : -1;
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
        if (!selectedThreadId) return;
        const id = selectedThreadId;
        setSelectedThreadId(null);
        runThreadAction([id], "archive");
      },
      onTrash() {
        if (!selectedThreadId || view === "trash") return;
        const id = selectedThreadId;
        setSelectedThreadId(null);
        runThreadAction([id], "trash");
      },
      onStar() {
        if (!selectedThreadId) return;
        const threads = active.data?.threads ?? [];
        const row = threads.find((t) => t.thread_id === selectedThreadId);
        const action: MailAction = row?.starred === 1 ? "unstar" : "star";
        runThreadAction([selectedThreadId], action);
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
        if (selectedThreadId) setReplyOpen(true);
      },
      onCompose() {
        openCompose();
      },
      onFocusSearch() {
        focusSearch();
      },
      onUndo() {
        const last = lastActionRef.current;
        if (!last) return;
        const inv = INVERSE_ACTION[last.action];
        if (!inv) return;
        bulkMutate({ threadIds: last.threadIds, action: inv });
        lastActionRef.current = null;
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
    composeOpen || paletteOpen || helpOpen || domainsOpen || filtersOpen,
  );

  const viewTitle = VIEW_TITLES[view];
  // While searching, the result list spans all mail (global FTS), so the pane
  // header reflects that rather than the selected view.
  const listTitle = searching ? "Search results" : viewTitle;
  const sidebarCounts = counts.data ?? EMPTY_COUNTS;
  // On mobile, the reader fills the screen; the back arrow returns to the list.
  const mobileShowingReader = !isDesktop && mobileView === "reader";

  // Hardware/browser Back closes mobile overlays instead of leaving the app.
  // Drawer: Back closes the drawer. Reader: Back returns to the list. Both are
  // no-ops on desktop (enabled gated by !isDesktop), so desktop nav is intact.
  useBackClose(drawerOpen, () => setDrawerOpen(false), !isDesktop);
  useBackClose(mobileShowingReader, () => setMobileView("list"), !isDesktop);

  // Crossing to desktop (resize/rotate): close the drawer so a Sheet can't
  // linger over the three-pane desktop layout.
  useEffect(() => {
    if (isDesktop && drawerOpen) setDrawerOpen(false);
  }, [isDesktop, drawerOpen]);

  return (
    // Dynamic-viewport height (with a 100vh fallback for pre-dvh Safari): the
    // shell must shrink with the iOS keyboard (interactive-widget=
    // resizes-content) instead of letting the page scroll into a stuck offset.
    <div className="flex h-screen supports-[height:100dvh]:h-dvh w-full overflow-hidden bg-background text-foreground">
      <Sidebar
        view={view}
        onView={handleView}
        counts={sidebarCounts}
        domainFilter={domainFilter}
        onDomainFilter={setDomainFilter}
        onOpenDomains={openDomains}
        onOpenFilters={openFilters}
      />

      {/* Mobile drawer: view nav + theme + account. Selecting a view closes
          it (handleView sets drawerOpen=false). */}
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
            showBrand={false}
          />
        </SheetContent>
      </Sheet>

      {/* Message list pane.
          Desktop: fixed 320px column, always visible.
          Mobile: full width; hidden when the reader is showing. */}
      <section
        className={cn(
          "flex min-w-0 flex-1 flex-col border-r md:w-80 md:flex-none md:shrink-0",
          mobileShowingReader && "hidden md:flex",
        )}
      >
        {/* Mobile app bar — hamburger, view title, search, compose.
            Rendered only on mobile while the list view is active, so the DOM
            mirrors what's on screen (the desktop layout uses CSS classes; mobile
            view selection is JS-driven). pt safe-area for the notch. */}
        {!isDesktop && !mobileShowingReader && (
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
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchRef}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search all mail…"
                    aria-label="Search messages input"
                    autoFocus
                    className="h-11 pl-8"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Desktop search bar. */}
        <div className="hidden h-14 items-center gap-2 px-4 md:flex">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={isDesktop ? searchRef : undefined}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search all mail…"
              aria-label="Search messages"
              className="h-9 pl-8"
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
        {selectedIds.size > 0 && (
          <BulkActionBar
            count={selectedIds.size}
            view={threadView}
            onClear={clearSelection}
            onAction={handleBulkAction}
          />
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
            {/* Right-edge fade hinting the chip row scrolls horizontally on
                narrow screens. pointer-events-none so it never blocks a tap. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent md:hidden"
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
          onCompose={openCompose}
          onClearSearch={() => setSearch("")}
        />
        )}
      </section>

      {/* Reader pane.
          Desktop: fills the remaining space, always visible.
          Mobile: full-screen; hidden unless mobileView === "reader". */}
      <div
        className={cn(
          "min-w-0 flex-1 flex-col",
          mobileShowingReader ? "flex" : "hidden md:flex",
        )}
      >
        {/* Mobile reader app bar with a back arrow. Rendered only while the
            reader view is active on mobile. */}
        {mobileShowingReader && (
          <div className="flex h-14 items-center gap-1 border-b px-2 pt-[env(safe-area-inset-top)] md:hidden">
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
            <span className="flex-1 truncate text-base font-semibold">
              {viewTitle}
            </span>
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
        )}

        {/* Desktop top bar — command palette + compose. */}
        <div className="hidden h-14 items-center justify-end gap-2 px-4 md:flex">
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
        <Separator className="hidden md:block" />
        <Reader
          threadId={selectedThreadId}
          view={threadView}
          replyOpen={replyOpen}
          onReplyOpenChange={setReplyOpen}
          onOpenCompose={openComposeWith}
          onAction={(action) => {
            if (!selectedThreadId) return;
            const id = selectedThreadId;
            const inv = INVERSE_ACTION[action];
            bulkMutate({ threadIds: [id], action });
            // Navigate away from the thread for destructive/move actions
            const navigatesAway = ["archive", "unarchive", "trash", "restore", "delete"].includes(action);
            if (navigatesAway) {
              setSelectedThreadId(null);
              setMobileView("list");
            }
            if (isReversible(action) && inv) {
              toast(actionLabel(action), {
                action: {
                  label: "Undo",
                  onClick: () => bulkMutate({ threadIds: [id], action: inv }),
                },
              });
            } else {
              toast(actionLabel(action));
            }
          }}
        />
      </div>

      <ComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        initial={composeInitial}
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
      />
      <ShortcutHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <DomainsDialog open={domainsOpen} onOpenChange={setDomainsOpen} />
      <FiltersDialog open={filtersOpen} onOpenChange={setFiltersOpen} />
      <Toaster />
    </div>
  );
}
