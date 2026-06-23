import { useRef } from "react";
import { Archive, Inbox, PenSquare, RotateCcw, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { useThreads, useMutateThreads, INVERSE_ACTION } from "@/lib/queries";
import { actionLabel, isReversible } from "@/lib/actions";
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
  /** Empty-state CTA: start a new message (shown on an empty Inbox/All Mail). */
  onCompose?: () => void;
  /** Empty-state CTA: clear the active search (shown when a search has no hits). */
  onClearSearch?: () => void;
}

/** Callback each Row invokes on checkbox interaction. */
interface RowToggleHandler {
  (id: string, shiftKey: boolean): void;
}

const VIEW_LABELS: Record<View, string> = {
  inbox:   "Inbox",
  starred: "Starred",
  sent:    "Sent",
  all:     "All Mail",
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
  onCompose,
  onClearSearch,
}: MessageListProps) {
  const { data, isLoading, isError, error, refetch, isFetching } = useThreads(view, q, category, domain);
  const { mutate } = useMutateThreads(view, q, category, domain);
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

  let content: React.ReactNode;
  if (isLoading) {
    content = <ListSkeleton />;
  } else if (isError) {
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
            now={now}
            selected={t.thread_id === selectedThreadId}
            onSelect={onSelect}
            mutate={mutate}
            checkable={!!selectedIds}
            checked={selectedIds?.has(t.thread_id) ?? false}
            onToggle={handleRowToggle}
            showDomain={showDomain}
          />
        ))}
      </ul>
    );
  }

  return <ScrollArea className="flex-1">{content}</ScrollArea>;
}

function Row({
  thread,
  view,
  now,
  selected,
  onSelect,
  mutate,
  checkable,
  checked,
  onToggle,
  showDomain,
}: {
  thread: ThreadListRow;
  view: View;
  now: number;
  selected: boolean;
  onSelect: (threadId: string) => void;
  mutate: (args: { threadIds: string[]; action: MailAction }) => void;
  checkable: boolean;
  checked: boolean;
  onToggle?: RowToggleHandler;
  showDomain?: boolean;
}) {
  const unread = thread.anyUnread === 1;
  const who =
    view === "sent" ? `To: ${thread.msg_to}` : senderLabel(thread.msg_from);

  function handleAction(action: MailAction) {
    mutate({ threadIds: [thread.thread_id], action });
    const inv = INVERSE_ACTION[action];
    if (isReversible(action) && inv) {
      toast(actionLabel(action), {
        action: {
          label: "Undo",
          onClick: () => mutate({ threadIds: [thread.thread_id], action: inv }),
        },
      });
    } else {
      toast(actionLabel(action));
    }
  }

  function handleCheckboxClick(e: React.MouseEvent) {
    e.stopPropagation();
    onToggle?.(thread.thread_id, e.shiftKey);
  }

  const isTrash = view === "trash";
  const isStarred = thread.starred === 1;
  // Show an AI-label chip for inbound rows that aren't "primary" (primary =
  // unlabeled, to keep the list quiet). Hidden on the Sent view.
  const cat = categoryOf(thread.category);
  const showChip = view !== "sent" && cat !== "primary";

  return (
    <li>
      <div
        className={cn(
          "group relative flex w-full border-b border-border/60",
          checked && "bg-accent/50",
        )}
      >
        {/* Selection checkbox — always in DOM, visible on hover or when any
            selected. The wrapper is a full 44px tap target (the visual box is
            small); clicking anywhere in it toggles. handleCheckboxClick stops
            propagation, so a tap on the inner Checkbox doesn't double-fire via
            this wrapper. */}
        {checkable && (
          <div
            className="absolute top-1/2 left-0 z-10 flex size-11 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[checked=true]:opacity-100 max-md:opacity-100"
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
          onClick={() => onSelect(thread.thread_id)}
          aria-current={selected ? "true" : undefined}
          className={cn(
            // min-w-0 is essential: without it the flex item won't shrink below
            // its content width, so the truncate descendants overflow the pane.
            "flex w-full min-w-0 flex-col gap-1 border-b-0 px-4 py-3.5 text-left transition-[padding,background-color] duration-150 md:py-3",
            // Reserve the checkbox's 44px tap gutter so it never overlaps text.
            checkable ? "pl-11" : "pl-4",
            "outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            // Reserve room on the right (desktop) so the hover/focus action panel
            // never overlaps the date, subject, or category chip.
            "md:group-hover:pr-28 md:group-focus-within:pr-28",
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
              {view !== "sent" && view !== "trash" && (
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
              {formatDate(thread.date, now)}
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

        {/* Hover/focus action buttons — right side */}
        {/* Kept in the layout (not display:none) so keyboard focus-within can
            reveal + reach these actions. Invisible + pointer-events-none until
            hover/focus, so it doesn't swallow row clicks; opacity-0 elements stay
            keyboard-focusable, which is what re-enables them on Tab. */}
        <div className="absolute inset-y-0 right-0 z-10 flex items-center justify-end pr-2 pl-12 opacity-0 transition-opacity pointer-events-none bg-gradient-to-l from-accent from-65% to-transparent group-hover:opacity-100 group-focus-within:opacity-100 max-md:hidden">
          {/* The panel itself stays pointer-events-none (its transparent fade
              buffer must let row clicks through); only the buttons re-enable
              pointer events, and only once revealed. */}
          <div className="flex items-center gap-0.5 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto">
          {/* Interactive star */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title={isStarred ? "Unstar" : "Star"}
            aria-label={isStarred ? "Unstar" : "Star"}
            onClick={(e) => {
              e.stopPropagation();
              handleAction(isStarred ? "unstar" : "star");
            }}
          >
            <Star
              className={cn(
                "h-4 w-4",
                isStarred
                  ? "fill-yellow-400 text-yellow-400"
                  : "text-muted-foreground",
              )}
            />
          </Button>

          {isTrash ? (
            <>
              {/* Restore */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Restore"
                aria-label="Restore"
                onClick={(e) => {
                  e.stopPropagation();
                  handleAction("restore");
                }}
              >
                <RotateCcw className="h-4 w-4 text-muted-foreground" />
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
                      onClick={() => {
                        mutate({
                          threadIds: [thread.thread_id],
                          action: "delete",
                        });
                        toast("Deleted forever");
                      }}
                    >
                      Delete forever
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <>
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
            </>
          )}
          </div>
        </div>
      </div>
    </li>
  );
}

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
