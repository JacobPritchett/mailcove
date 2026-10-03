import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { AlarmClock, AlarmClockOff, Archive, ArrowDown, Inbox, LoaderCircle, MailCheck, MailOpen, MoreHorizontal, OctagonAlert, PenSquare, RotateCcw, ShieldCheck, Star, Trash2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useThreads, removesFromView } from "@/lib/queries";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useRowGestures, type SwipeDirection } from "@/lib/rowGestures";
import { usePullToRefresh } from "@/lib/usePullToRefresh";
import { actionView } from "@/lib/actions";
import { useThreadActions, type ActionOptions } from "@/lib/useThreadActions";
import SnoozeMenu from "@/components/SnoozeMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatSnoozeTime } from "@/lib/snooze";
import { senderLabel, formatDate } from "@/lib/format";
import { categoryOf, CATEGORY_META } from "@/lib/categories";
import type { ThreadListRow, MailAction, View } from "@/lib/types";

export interface MessageListProps {
  view: View;
  q?: string;
  /** Active AI-label filter (null/undefined = all). */
  category?: string | null;
  /** Active identity-domain filter (null/undefined = all inboxes). */
  domain?: string | null;
  /** Show a per-row domain chip (while viewing all inboxes of a multi-domain setup). */
  showDomain?: boolean;
  /** The currently selected thread_id (null = nothing selected). */
  selectedThreadId: string | null;
  /** Selecting a row selects the whole thread. */
  onSelect: (threadId: string) => void;
  /** Multi-select state. */
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onSelectRange?: (anchorId: string, id: string) => void;
  /** Run a row action. App passes its own runner so row actions share undo
   *  tracking with the toolbar and keyboard; standalone, the list runs them itself. */
  onAction?: (threadIds: string[], action: MailAction, opts?: ActionOptions) => void;
  /** Empty-state CTA: start a new message (shown on an empty Inbox/All Mail). */
  onCompose?: () => void;
  /** Empty-state CTA: clear the active search (shown when a search has no hits). */
  onClearSearch?: () => void;
}

/** Callback each Row invokes on checkbox interaction. */
interface RowToggleHandler {
  (id: string, shiftKey: boolean): void;
}

/** Start loading the next page once the end of the list is this close. */
const LOAD_MORE_WITHIN_PX = 600;

const VIEW_LABELS: Record<View, string> = {
  inbox:   "Inbox",
  starred: "Starred",
  sent:    "Sent",
  all:     "All Mail",
  spam:    "Junk",
  snoozed: "Snoozed",
  trash:   "Trash",
};

export default function MessageList({
  view,
  q,
  category,
  domain,
  showDomain,
  selectedThreadId,
  onSelect,
  selectedIds,
  onToggleSelect,
  onSelectRange,
  onAction,
  onCompose,
  onClearSearch,
}: MessageListProps) {
  const { data, isLoading, isError, error, refetch, isFetching, hasMore, isFetchingMore, moreFailed, fetchMore } =
    useThreads(view, q, category, domain);
  const own = useThreadActions(view, q, category, domain);
  // A touch screen has no hover to reveal a checkbox with, and a column of
  // them costs every row 28px. There, a long press on a row starts selecting
  // (the checkboxes then show and a tap toggles), and rows can be swiped.
  const touch = useMediaQuery("(pointer: coarse)");
  const selecting = (selectedIds?.size ?? 0) > 0;
  const runAction = onAction ?? own.run;
  const searching = !!q;
  const viewLabel = VIEW_LABELS[view];

  // Shift-click anchor lives here so any row can read the previous anchor.
  const lastAnchorRef = useRef<string | null>(null);

  // Unified toggle handler passed to each Row. On shift-click, delegates to
  // onSelectRange using the stored anchor; on plain click, records a new anchor.
  const handleRowToggle: RowToggleHandler = (id, shiftKey) => {
    if (shiftKey && lastAnchorRef.current && onSelectRange) {
      onSelectRange(lastAnchorRef.current, id);
    } else {
      lastAnchorRef.current = id;
      onToggleSelect?.(id);
    }
  };

  // ---- Paging: load the next page as the end of the list comes near ----
  const viewportRef = useRef<HTMLDivElement>(null);
  const rowCount = data?.threads.length ?? 0;
  const maybeLoadMore = useCallback(() => {
    const el = viewportRef.current;
    // A failed page waits for its Retry button rather than being re-requested
    // on every scroll. clientHeight 0 is a hidden list (the mobile reader is
    // showing): nothing is "near the end" of a list nobody can see.
    if (!el || !hasMore || moreFailed || el.clientHeight === 0) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_WITHIN_PX) void fetchMore();
  }, [hasMore, moreFailed, fetchMore]);
  // Also after every change in length: a page that does not fill the viewport
  // never scrolls, so the scroll listener alone would stop there.
  useEffect(() => {
    maybeLoadMore();
  }, [maybeLoadMore, rowCount]);

  // ---- Scroll stability: new mail at the top must not move what is being read ----
  // The first visible row and where it sat, noted on scroll; after the list
  // changes, the scroll position is corrected so that row sits there again.
  // Done by hand (and native anchoring turned off) because Safari has none.
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  const noteAnchor = useCallback(() => {
    const el = viewportRef.current;
    anchorRef.current = null;
    if (!el || el.scrollTop <= 0) return; // at the top, new mail should show
    const rows = el.querySelectorAll<HTMLElement>("li[data-thread-id]");
    const top = el.getBoundingClientRect().top;
    // Rows are in document order, so the first one reaching below the top
    // edge is found by bisection.
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].getBoundingClientRect().bottom > top) hi = mid;
      else lo = mid + 1;
    }
    const first = rows[lo];
    if (first) anchorRef.current = { id: first.dataset.threadId ?? "", top: first.getBoundingClientRect().top - top };
  }, []);
  const threads = data?.threads;
  useLayoutEffect(() => {
    const el = viewportRef.current;
    const anchor = anchorRef.current;
    if (el && anchor) {
      for (const li of el.querySelectorAll<HTMLElement>("li[data-thread-id]")) {
        if (li.dataset.threadId !== anchor.id) continue;
        const delta = li.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.top;
        if (delta !== 0) el.scrollTop += delta;
        break;
      }
    }
    noteAnchor();
  }, [threads, noteAnchor]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      noteAnchor();
      maybeLoadMore();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [noteAnchor, maybeLoadMore]);

  // Keyboard navigation (j/k) can select a row that is off screen.
  useEffect(() => {
    if (!selectedThreadId) return;
    const el = viewportRef.current;
    if (!el) return;
    for (const li of el.querySelectorAll<HTMLElement>("li[data-thread-id]")) {
      if (li.dataset.threadId === selectedThreadId) {
        li.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  }, [selectedThreadId]);

  // ---- Pull down at the top to refresh (touch) ----
  const qc = useQueryClient();
  const pullRef = useRef<HTMLDivElement>(null);
  const refreshing = usePullToRefresh(viewportRef, pullRef, () =>
    // The list's first page (merged in, like any poll) and the sidebar counts.
    Promise.all([refetch(), qc.invalidateQueries({ queryKey: ["counts"] })]),
  );

  let content: React.ReactNode;
  if (isLoading) {
    content = <ListSkeleton />;
  } else if (isError && !data) {
    // Only when there is nothing to show. A poll or focus refetch that fails
    // keeps `data`; the rows stay and a notice goes above them instead.
    content = (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="text-sm text-destructive">
          Couldn't load messages
          {error instanceof Error ? `: ${error.message}` : "."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          {isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  } else if (!data || data.threads.length === 0) {
    const showCompose = !searching && (view === "inbox" || view === "all") && !!onCompose;
    content = (
      <div className="flex flex-col items-center gap-3 p-10 text-center text-muted-foreground">
        <Inbox className="h-8 w-8 opacity-40" aria-hidden />
        <p className="text-sm">
          {searching
            ? `No messages matching "${q}"`
            : view === "snoozed"
              ? "Nothing is snoozed"
              : `No messages in ${viewLabel}`}
        </p>
        {searching && onClearSearch ? (
          <Button type="button" variant="outline" size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        ) : showCompose ? (
          <Button type="button" size="sm" onClick={onCompose} className="gap-2">
            <PenSquare className="h-4 w-4" />
            Compose message
          </Button>
        ) : null}
      </div>
    );
  } else {
    const now = Date.now();
    content = (
      <ul className="flex flex-col">
        {data.threads.map((t) => (
          <Row
            key={t.thread_id}
            thread={t}
            view={view}
            actions={actionView(view, q)}
            now={now}
            selected={t.thread_id === selectedThreadId}
            onSelect={onSelect}
            runAction={runAction}
            checkable={!!selectedIds}
            touch={touch}
            selecting={selecting}
            checked={selectedIds?.has(t.thread_id) ?? false}
            onToggle={handleRowToggle}
            showDomain={showDomain}
          />
        ))}
        {isFetchingMore && (
          <li role="status" className="px-4 py-3 text-center text-xs text-muted-foreground">
            Loading more
          </li>
        )}
        {moreFailed && !isFetchingMore && (
          <li className="flex items-center justify-center gap-2 px-4 py-2 text-xs text-muted-foreground">
            <span role="status">Couldn't load more.</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs max-md:h-11"
              onClick={() => void fetchMore()}
            >
              Retry
            </Button>
          </li>
        )}
      </ul>
    );
  }

  // min-h-0: a flex child does not shrink below its content height without it,
  // so this grew to fit every row and never actually scrolled.
  return (
    <>
      {isError && data && (
        <div
          role="status"
          className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-1 text-xs text-muted-foreground"
        >
          <span>Couldn't refresh.</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs max-md:h-11"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}
      {view === "spam" && !searching && (
        <p role="note" className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          Mail in Junk is deleted after 30 days.
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* The pull-to-refresh indicator: parked just above the list, drawn
            down by the gesture (see usePullToRefresh, which moves it). */}
        <div
          ref={pullRef}
          aria-hidden
          className="group/pull pointer-events-none absolute -top-11 left-1/2 z-20 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-md"
        >
          {refreshing ? (
            <LoaderCircle className="size-4 motion-safe:animate-spin" />
          ) : (
            <ArrowDown className="size-4 transition-transform group-data-[armed=true]/pull:rotate-180 motion-reduce:transition-none" />
          )}
        </div>
        <span role="status" className="sr-only">
          {refreshing ? "Refreshing" : ""}
        </span>
        <ScrollArea
          className="min-h-0 flex-1"
          viewportRef={viewportRef}
          // overscroll-contain: the pull is ours, not the browser's own refresh.
          viewportClassName="[overflow-anchor:none] overscroll-y-contain"
        >
          {content}
        </ScrollArea>
      </div>
    </>
  );
}

function Row({
  thread,
  view,
  actions,
  now,
  selected,
  onSelect,
  runAction,
  checkable,
  touch,
  selecting,
  checked,
  onToggle,
  showDomain,
}: {
  thread: ThreadListRow;
  /** The selected view: how the row is DISPLAYED (e.g. "To:" in Sent). */
  view: View;
  /** The view whose ACTIONS apply to this row (All Mail while searching). */
  actions: View;
  now: number;
  selected: boolean;
  onSelect: (threadId: string) => void;
  runAction: (threadIds: string[], action: MailAction, opts?: ActionOptions) => void;
  checkable: boolean;
  /** A touch screen: checkboxes stay out of sight until something is selected. */
  touch: boolean;
  /** At least one thread is selected (on touch: taps toggle, swipes are off). */
  selecting: boolean;
  checked: boolean;
  onToggle?: RowToggleHandler;
  showDomain?: boolean;
}) {
  const unread = thread.anyUnread === 1;
  const who =
    view === "sent" ? `To: ${thread.msg_to}` : senderLabel(thread.msg_from);

  function handleAction(action: MailAction, opts?: ActionOptions) {
    if (opts) runAction([thread.thread_id], action, opts);
    else runAction([thread.thread_id], action);
  }

  function handleCheckboxClick(e: React.MouseEvent) {
    e.stopPropagation();
    onToggle?.(thread.thread_id, e.shiftKey);
  }

  const isTrash = actions === "trash";
  const isJunk = actions === "spam";
  const isSnoozed = actions === "snoozed";
  // Only mail in the inbox can be snoozed. A row does not say where its thread
  // is, so outside the Inbox the offer may be refused (the Worker says why and
  // the toast passes it on); it is left out only where it can never apply.
  const canSnooze = actions === "inbox" || actions === "starred" || actions === "all";
  const isStarred = thread.starred === 1;
  // Show an AI-label chip for inbound rows that aren't "primary" (primary =
  // unlabeled, to keep the list quiet). Hidden on the Sent view.
  const cat = categoryOf(thread.category);
  const showChip = view !== "sent" && cat !== "primary";

  // Touch: swipe right to archive, left to trash; in Trash and Junk either
  // way puts the thread back. Hold to select. (None of it reacts to a mouse.)
  const swipes = SWIPES[isTrash ? "trash" : isJunk ? "spam" : "other"];
  const slideRef = useRef<HTMLDivElement>(null);
  const underlayRef = useRef<HTMLDivElement>(null);
  const gestures = useRowGestures(slideRef, underlayRef, {
    swipeEnabled: !selecting,
    onSwipe(direction: SwipeDirection) {
      const { action } = swipes[direction];
      handleAction(action);
      // An action that leaves the row listed (archiving in All Mail) lets it
      // slide back; otherwise it slides away as the list drops it.
      return removesFromView(actions, action);
    },
    onLongPress() {
      if (checkable) onToggle?.(thread.thread_id, false);
    },
  });
  // The row slid away and then came back (the action failed, or was undone
  // while still mounted): put it where it belongs.
  useEffect(() => {
    const slide = slideRef.current;
    const underlay = underlayRef.current;
    if (slide) slide.style.transform = "";
    if (underlay) {
      delete underlay.dataset.dir;
      delete underlay.dataset.armed;
    }
  }, [thread]);
  // On touch the checkbox takes up room only while selecting.
  const showCheckbox = checkable && (!touch || selecting);
  const LeftIcon = swipes.right.icon;
  const RightIcon = swipes.left.icon;

  return (
    <li data-thread-id={thread.thread_id}>
      <div className="group relative overflow-hidden border-b border-border/60">
        {/* What a swipe uncovers: the colour and icon of the action it will
            take. Hidden until the row moves (the gesture sets data-dir), and
            decorative: the same actions are in the reader and the bulk bar. */}
        <div
          ref={underlayRef}
          aria-hidden
          className={cn(
            "group/swipe absolute inset-0 hidden items-center justify-between px-6 text-white data-[dir]:flex",
            swipes.className,
          )}
        >
          <LeftIcon className="size-5 transition-transform group-data-[armed=true]/swipe:scale-125 group-data-[dir=left]/swipe:invisible motion-reduce:transition-none" />
          <RightIcon className="size-5 transition-transform group-data-[armed=true]/swipe:scale-125 group-data-[dir=right]/swipe:invisible motion-reduce:transition-none" />
        </div>
      <div
        ref={slideRef}
        {...gestures}
        className={cn(
          // Opaque, so it covers the underlay at rest. pan-y: the browser
          // keeps vertical scrolling; sideways movement is ours. No text
          // selection or callout on touch, or a long press starts those too.
          "relative flex w-full bg-background [touch-action:pan-y] [@media(pointer:coarse)]:select-none [@media(pointer:coarse)]:[-webkit-touch-callout:none]",
        )}
      >
        {/* Selection checkbox — always in DOM, visible on hover or when any
            selected. The wrapper is a full 44px tap target (the visual box is
            small); clicking anywhere in it toggles. handleCheckboxClick stops
            propagation, so a tap on the inner Checkbox doesn't double-fire via
            this wrapper. */}
        {checkable && (
          <div
            className={
              touch && !selecting
                ? // Out of sight until selecting, but still there for a screen
                  // reader, for which a long press is not a given.
                  "sr-only"
                : cn(
                    "absolute top-1/2 left-0 z-10 flex size-11 -translate-y-1/2 items-center justify-center",
                    !touch &&
                      "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[checked=true]:opacity-100",
                  )
            }
            data-checked={checked}
            onClick={handleCheckboxClick}
          >
            <Checkbox
              checked={checked}
              aria-label={`Select thread: ${thread.subject}`}
              onClick={handleCheckboxClick}
            />
          </div>
        )}

        <button
          type="button"
          data-slot="thread-row"
          // While selecting on touch, a tap adds or removes the row.
          onClick={() => (touch && selecting && checkable ? onToggle?.(thread.thread_id, false) : onSelect(thread.thread_id))}
          aria-current={selected ? "true" : undefined}
          className={cn(
            // min-w-0 is essential: without it the flex item won't shrink below
            // its content width, so the truncate descendants overflow the pane.
            "flex w-full min-w-0 flex-col gap-1 border-b-0 px-4 py-3.5 text-left transition-colors duration-150 md:py-3",
            // Reserve the checkbox's 44px tap gutter so it never overlaps text.
            showCheckbox ? "pl-11" : "pl-4",
            checked && !selected && "bg-accent/50",
            "outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            selected && "bg-accent shadow-[inset_3px_0_var(--primary)]",
          )}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={cn(
                // Sender = secondary tier: bold + full contrast when unread,
                // stepped back once read so the subject reads as the anchor.
                "flex min-w-0 items-center gap-1.5 truncate text-sm",
                unread ? "font-semibold text-foreground" : "text-foreground/80",
              )}
            >
              {unread && <span className="sr-only">Unread. </span>}
              {view !== "sent" && view !== "trash" && view !== "spam" && (
                <span
                  aria-hidden
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full bg-primary",
                    !unread && "invisible",
                  )}
                />
              )}
              <span className="truncate">{who}</span>
              {thread.count > 1 && (
                <Badge
                  variant="secondary"
                  className="shrink-0 px-1.5 py-0 text-[0.7rem] leading-tight"
                  aria-label={`${thread.count} messages`}
                >
                  {thread.count}
                </Badge>
              )}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {/* In Snoozed, when it comes back matters more than when it came. */}
              {view === "snoozed" && thread.snoozedUntil
                ? `Until ${formatSnoozeTime(thread.snoozedUntil, now)}`
                : formatDate(thread.date, now)}
            </span>
          </div>
          <div
            className={cn(
              // Subject = primary tier: always full contrast and at least
              // medium weight, so subjects stay scannable even once read.
              "flex min-w-0 items-center gap-1 text-sm text-foreground",
              unread ? "font-semibold" : "font-medium",
            )}
          >
            {thread.hasAttachments === 1 && <span aria-hidden>📎</span>}
            <span className="min-w-0 flex-1 truncate">{thread.subject || "(no subject)"}</span>
            {showDomain && thread.domain && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[0.7rem] font-medium text-muted-foreground">
                {thread.domain}
              </span>
            )}
            {showChip && (
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0.5 text-[0.7rem] font-medium",
                  CATEGORY_META[cat].chip,
                )}
              >
                {CATEGORY_META[cat].label}
              </span>
            )}
          </div>
          {/* Snippet = tertiary tier: muted preview, below the subject. */}
          <div className="truncate text-xs text-foreground/55">
            {thread.snippet}
          </div>
        </button>

        {/* Hover/focus action buttons: a small opaque panel laid OVER the right
            edge of the row. The row's own layout never changes for it, so the
            sender, subject and date stay exactly where they were (making room
            for it instead squeezed all three every time the pointer passed).
            Kept in the DOM (not display:none) so keyboard focus can reach the
            buttons, which in turn reveals the panel; until then it is
            invisible and lets clicks through to the row. It stays up while one
            of its menus is open, when the pointer and focus are both elsewhere. */}
        <div className="pointer-events-none absolute top-1/2 right-2 z-10 -translate-y-1/2 rounded-md border bg-background p-0.5 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100 max-md:hidden">
          <div className="flex items-center gap-0.5 [&_button]:size-7">
          {isTrash || isJunk ? (
            <>
              {/* Back out of Trash or Junk, to wherever it was */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={isJunk ? "Not junk" : "Restore"}
                aria-label={isJunk ? "Not junk" : "Restore"}
                onClick={(e) => {
                  e.stopPropagation();
                  handleAction(isJunk ? "unspam" : "restore");
                }}
              >
                {isJunk ? (
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <RotateCcw className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>

              {/* Delete forever — requires confirmation */}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Delete forever"
                    aria-label="Delete forever"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete forever?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This message will be permanently deleted and cannot be
                      recovered.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-white hover:bg-destructive/90"
                      onClick={() => handleAction("delete")}
                    >
                      Delete forever
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <>
              {isSnoozed && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="Unsnooze"
                  aria-label="Unsnooze"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAction("unsnooze", { undoUntil: thread.snoozedUntil });
                  }}
                >
                  <AlarmClockOff className="h-4 w-4 text-muted-foreground" />
                </Button>
              )}

              {/* Archive */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Archive"
                aria-label="Archive"
                onClick={(e) => {
                  e.stopPropagation();
                  handleAction("archive");
                }}
              >
                <Archive className="h-4 w-4 text-muted-foreground" />
              </Button>

              {/* Trash */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Move to trash"
                aria-label="Move to trash"
                onClick={(e) => {
                  e.stopPropagation();
                  handleAction("trash");
                }}
              >
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>

              {canSnooze && (
                <SnoozeMenu onSnooze={(until) => handleAction("snooze", { until })}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Snooze"
                    aria-label="Snooze"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <AlarmClock className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </SnoozeMenu>
              )}

              {/* The less frequent ones. Three buttons and this keep the
                  panel narrow enough that most of the row stays readable (and
                  clickable) under the pointer. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="More actions"
                    aria-label={`More actions for ${thread.subject || "(no subject)"}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => handleAction(isStarred ? "unstar" : "star")}>
                    <Star className={cn(isStarred && "fill-yellow-400 !text-yellow-400")} />
                    {isStarred ? "Unstar" : "Star"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleAction(unread ? "read" : "unread")}>
                    {unread ? <MailCheck /> : <MailOpen />}
                    {unread ? "Mark as read" : "Mark as unread"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleAction("spam")}>
                    <OctagonAlert /> Report junk
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          </div>
        </div>
      </div>
      </div>
    </li>
  );
}

interface SwipeAction {
  action: MailAction;
  icon: LucideIcon;
}
/**
 * What a swipe does, by where the row is listed. The keys are the direction
 * the row travels: right uncovers its left edge, left its right edge.
 */
const SWIPES: Record<"other" | "trash" | "spam", Record<SwipeDirection, SwipeAction> & { className: string }> = {
  other: {
    right: { action: "archive", icon: Archive },
    left: { action: "trash", icon: Trash2 },
    className: "data-[dir=right]:bg-emerald-600 data-[dir=left]:bg-red-600",
  },
  trash: {
    right: { action: "restore", icon: RotateCcw },
    left: { action: "restore", icon: RotateCcw },
    className: "bg-sky-600",
  },
  spam: {
    right: { action: "unspam", icon: ShieldCheck },
    left: { action: "unspam", icon: ShieldCheck },
    className: "bg-sky-600",
  },
};

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
