import { useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { AlarmClock, AlarmClockOff, Archive, Ban, ChevronDown, ChevronsDownUp, ChevronsUpDown, Download, ExternalLink, Forward, Mail, MailMinus, MailOpen, MoreHorizontal, OctagonAlert, Paperclip, Printer, Reply, ReplyAll, RotateCcw, ShieldAlert, ShieldCheck, Sparkles, Star, Trash2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { useThread, useSummarizeThread, useIdentities, patchThreadRows } from "@/lib/queries";
import { ApiError, mutateThread, attachmentUrl, showMessageImages, allowImagesFrom, unsubscribeFrom } from "@/lib/api";
import { blockAddress, failedCheckWarning } from "@/lib/blockSender";
import SnoozeMenu from "@/components/SnoozeMenu";
import { formatSnoozeTime } from "@/lib/snooze";
import type { ActionOptions } from "@/lib/useThreadActions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useReaderMode, type ReaderMode } from "@/lib/useReaderMode";
import { useIsDesktop } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";
import ChatView from "@/components/ChatView";
import RelativeTime from "@/components/RelativeTime";
import { linkifyText } from "@/lib/chatNormalize";
import {
  addressOf,
  avatarColor,
  initialsOf,
  asSentence,
  conversationSubject,
  recipientSummary,
  senderLabel,
} from "@/lib/format";
import InlineReply, { type InlineReplyHandle } from "@/components/InlineReply";
import InviteCard, { inviteAttachment } from "@/components/InviteCard";
import { defaultReplyTarget, forwardInitial, replyInitialForThread } from "@/lib/replyContext";
import { addressClaimedInName, hasReplyAll, ownDomains, type ReplyMode } from "@/lib/conversation";
import { IFRAME_SANDBOX, wrapHtml, autoSizeEmailFrame } from "@/lib/emailFrame";
import { enterPrintLayout, framesSettled, markKeepTogether } from "@/lib/print";
import type { ComposeInitial } from "@/components/ComposeDialog";
import type { MailAction, ThreadMessage, View } from "@/lib/types";

export interface ReaderProps {
  /** The selected thread_id (null = nothing selected). */
  threadId: string | null;
  /** Current mailbox view — affects which action buttons show. */
  view?: View;
  /** Inline reply composer visibility (controlled by App so the `r` shortcut
   *  can open it and thread switches close it). */
  replyOpen?: boolean;
  onReplyOpenChange?: (open: boolean) => void;
  /** Who the open reply goes to: the sender, or everyone on the message. */
  replyMode?: ReplyMode;
  /** Ask for a reply of this kind to be opened (the toolbar, a message menu). */
  onReplyRequest?: (mode: ReplyMode) => void;
  /** The `r` and `a` shortcuts: start a reply of this kind to the default
   *  message. A new `nonce` is a new press. */
  replyRequest?: { mode: ReplyMode; nonce: number; messageId?: string | null };
  /** Undo send on an inline reply: put it back (see App). */
  onUndoReplySend?: (u: { initial: ComposeInitial; mode: ReplyMode; messageId: string | null }) => void;
  /** Bumped by the `f` shortcut: forward the default message of this thread. */
  forwardNonce?: number;
  /** Escape hatch: open the full compose dialog with this prefill (used by the
   *  inline composer's expand button, carrying the in-progress body). */
  onOpenCompose?: (initial: ComposeInitial) => void;
  /** Action handler — called when the user clicks an action in the toolbar. */
  onAction?: (action: MailAction, opts?: ActionOptions) => void;
  /** Bumped by the `b` shortcut: open the snooze menu for this thread. */
  snoozeNonce?: number;
  /**
   * On a phone the reader fills the screen and owns its top bar, so the
   * thread's actions can share one row with Back instead of stacking under
   * the subject. App supplies the two ends of that bar. Absent on desktop.
   */
  mobileChrome?: { leading: React.ReactNode; trailing?: React.ReactNode };
}

/** A conversation longer than this opens with its earlier messages folded away. */
const LONG_THREAD = 3;

/**
 * Which messages of the open conversation are unfolded.
 *
 * A long conversation opens showing its last message and whatever is unread,
 * with the rest as one-line headers. That choice is made ONCE per opening:
 * opening a thread marks it read, and deciding again from the refetched data
 * would fold the unread messages away under the reader. After that only two
 * things change it: the user, and new mail, which arrives unfolded.
 *
 * Kept in a ref and settled during render rather than in an effect, so the
 * first paint of a thread is already folded and no message body (an iframe)
 * is mounted only to be torn down a moment later.
 */
function useFoldedThread(threadId: string | null, messages: ThreadMessage[] | undefined) {
  const ref = useRef<{ thread: string | null; known: Set<string>; open: Set<string> }>({
    thread: null,
    known: new Set(),
    open: new Set(),
  });
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const s = ref.current;
  if (s.thread !== threadId) {
    s.thread = threadId;
    s.known = new Set();
    s.open = new Set();
  }
  if (messages?.length) {
    const first = s.known.size === 0;
    const fresh = messages.filter((m) => !s.known.has(m.id));
    for (const m of fresh) {
      s.known.add(m.id);
      const last = m === messages[messages.length - 1];
      // A short conversation, or mail that arrived while it was open: shown.
      if (!first || messages.length <= LONG_THREAD || last || m.unread === 1) s.open.add(m.id);
    }
  }
  const long = (messages?.length ?? 0) > LONG_THREAD;
  return {
    /** Folding applies to this conversation at all. */
    long,
    isOpen: (id: string) => !long || s.open.has(id),
    allOpen: !long || (messages ?? []).every((m) => s.open.has(m.id)),
    open(id: string) {
      s.open.add(id);
      redraw();
    },
    openAll() {
      for (const m of messages ?? []) s.open.add(m.id);
      redraw();
    },
    /** Back to the last message alone. */
    foldEarlier() {
      const last = messages?.[messages.length - 1];
      s.open = new Set(last ? [last.id] : []);
      redraw();
    },
  };
}

export default function Reader({
  threadId,
  view = "inbox",
  replyOpen = false,
  onReplyOpenChange,
  replyMode = "reply",
  onReplyRequest,
  replyRequest,
  forwardNonce = 0,
  snoozeNonce = 0,
  onOpenCompose,
  onUndoReplySend,
  onAction,
  mobileChrome,
}: ReaderProps) {
  const isDesktop = useIsDesktop();
  // Every state of the reader sits under the phone's top bar (Back must work
  // while a thread is still loading); only a loaded thread puts actions in it.
  const frame = (body: React.ReactNode, actions?: React.ReactNode) =>
    mobileChrome ? (
      <main data-print-flow className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The safe-area padding is on an OUTER box and the 56px row inside
            it. On one box (border-box) the padding eats into the 56px, and in
            the installed app the buttons hung up into the status bar. */}
        <div data-print-hide className="shrink-0 border-b pt-[env(safe-area-inset-top)]">
          <div className="flex h-14 items-center px-2">
            {mobileChrome.leading}
            <div className="min-w-0 flex-1" />
            {actions}
            {mobileChrome.trailing}
          </div>
        </div>
        {body}
      </main>
    ) : (
      body
    );
  // With the bar around it the frame is the page's <main>; without, the body is.
  const Body = mobileChrome ? "div" : "main";
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch, isFetching } =
    useThread(threadId);
  const [mode, setMode] = useReaderMode();
  const summarize = useSummarizeThread();
  const fold = useFoldedThread(threadId, data?.messages);
  // Printing: the whole conversation (`only` null) or one message of it.
  // While set, the reader is in its print layout (see lib/print): every
  // message unfolded, or the one alone, with its addresses and date in full.
  const [printing, setPrinting] = useState<{ only: string | null } | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!printing) return;
    const leave = enterPrintLayout();
    let cancelled = false;
    const done = () => setPrinting(null);
    window.addEventListener("afterprint", done);
    // Once the frames have settled at the printed width, not before.
    void framesSettled(articleRef.current ?? document).then(() => {
      if (cancelled) return;
      markKeepTogether(articleRef.current ?? document);
      window.print();
    });
    return () => {
      cancelled = true;
      window.removeEventListener("afterprint", done);
      leave();
    };
  }, [printing]);
  useEffect(() => {
    setPrinting(null);
  }, [threadId]);
  // The browser's own Print (its menu, Cmd/Ctrl+P). The shortcut is taken
  // over so the conversation is prepared first; a print started any other way
  // still gets the layout, just without the unfolding.
  const hasThread = !!data?.messages.length;
  useEffect(() => {
    if (!hasThread) return;
    let leave: (() => void) | null = null;
    const before = () => {
      leave ??= enterPrintLayout();
    };
    const after = () => {
      leave?.();
      leave = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "p") return;
      // Something is open over the conversation: leave the browser to it.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      setPrinting((cur) => cur ?? { only: null });
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
      document.removeEventListener("keydown", onKey);
      after();
    };
  }, [hasThread]);

  // The message the user has just unfolded: it takes focus, which would
  // otherwise be dropped to the page when the header they pressed goes away.
  const [unfoldedId, setUnfoldedId] = useState<string | null>(null);
  // A long conversation opens on what there is to read, not on a column of
  // folded headers with the unfolded message somewhere below the screen.
  const scrolledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data || scrolledForRef.current === data.thread_id) return;
    scrolledForRef.current = data.thread_id;
    if (data.messages.length <= LONG_THREAD) return;
    const first = document.querySelector<HTMLElement>("[data-message-open]");
    const pane = first?.closest<HTMLElement>("[data-slot=scroll-area-viewport]");
    if (!first || !pane) return;
    // Only when it starts below the fold; a thread that fits stays at its top.
    if (first.getBoundingClientRect().top > pane.getBoundingClientRect().bottom - 160) {
      first.scrollIntoView({ block: "start" });
    }
  }, [data]);

  // Clear any prior AI summary when switching conversations so it never shows
  // under the wrong thread.
  useEffect(() => {
    summarize.reset();
    // summarize.reset is stable; only the thread change should clear it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Mark the thread read when it is opened, and again when a new message
  // arrives in it (if any message is unread). The guard remembers one opening
  // of one thread at one length, not "this thread, ever": remembering only the
  // id left a thread unread forever once it had been marked unread and
  // reopened. It is NOT re-marked while it simply stays open, or Mark unread
  // would be undone by its own refetch.
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    markedRef.current = null;
  }, [threadId]);
  useEffect(() => {
    if (!data) return;
    const opening = `${data.thread_id}:${data.messages.length}`;
    if (markedRef.current === opening) return;
    const hasUnread = data.messages.some((m) => m.unread === 1);
    if (!hasUnread) return;
    markedRef.current = opening;
    // Best-effort read marking. Fire-and-forget, but invalidate the list/counts
    // caches on success so the sidebar unread badge and row bolding update
    // promptly (not just on the next 15s poll). `.catch` keeps the rejection
    // from escaping — read marking is non-critical.
    const openedId = data.thread_id;
    mutateThread(openedId, "read")
      .then(() => {
        // In place first: the refetch below renews only the first page of a
        // list, and this thread may sit further down.
        patchThreadRows(qc, [openedId], { anyUnread: 0 });
        void qc.invalidateQueries({ queryKey: ["threads"] });
        void qc.invalidateQueries({ queryKey: ["counts"] });
      })
      .catch(() => {
        // ignore — best-effort
      });
  }, [threadId, data?.thread_id, data?.messages.length, qc]);

  // A reply answers the latest inbound message unless a message's own menu
  // picked another one. Per thread: the choice must not follow a thread switch.
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  useEffect(() => {
    setReplyTargetId(null);
  }, [threadId]);
  // And per reply: once it closes (sent, discarded, handed to the dialog) the
  // next one answers the default message again unless told otherwise.
  useEffect(() => {
    if (!replyOpen) setReplyTargetId(null);
  }, [replyOpen]);
  // The inline composer: whether it holds something the user wrote, a handle
  // to throw that away, and a counter that gives a retargeted reply a fresh
  // composer (so nothing of the previous one, quote included, carries over).
  const replyDirtyRef = useRef(false);
  const replyRef = useRef<InlineReplyHandle>(null);
  const [replyNonce, setReplyNonce] = useState(0);
  // A request to reply to someone else while an edited reply is open, waiting
  // on the user's answer.
  const [pendingReply, setPendingReply] = useState<{ mode: ReplyMode; messageId: string | null } | null>(null);
  useEffect(() => {
    setPendingReply(null);
  }, [threadId]);
  // My own domains, so reply all never copies another address of mine.
  const identities = useIdentities(!!threadId).data;

  // `r` and `a` live in App, which has no thread data. They arrive as a
  // request and take the same path as every button (startReply, below).
  const startReplyRef = useRef<((mode: ReplyMode, messageId?: string | null) => void) | null>(null);
  const replySeenRef = useRef(replyRequest?.nonce ?? 0);
  // A press made for one thread is never carried out on another.
  useEffect(() => {
    replySeenRef.current = replyRequest?.nonce ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
  const loaded = !!data;
  useEffect(() => {
    const nonce = replyRequest?.nonce ?? 0;
    if (nonce === replySeenRef.current) return;
    // Pressed while the thread was still loading: wait for it (this runs
    // again when it arrives) rather than drop the key.
    if (!loaded || !startReplyRef.current) return;
    replySeenRef.current = nonce;
    if (replyRequest) startReplyRef.current(replyRequest.mode, replyRequest.messageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyRequest?.nonce, loaded]);

  // The `f` shortcut lives in App, which has no thread data; it bumps a nonce
  // and the forward is built here. The ref keeps a remount or a thread switch
  // from replaying an old press.
  const forwardSeenRef = useRef(forwardNonce);
  useEffect(() => {
    if (forwardNonce === forwardSeenRef.current) return;
    forwardSeenRef.current = forwardNonce;
    const target = data ? defaultReplyTarget(data.messages) : null;
    if (target) onOpenCompose?.(forwardInitial(target));
    // Only a new press should fire this, not a refetch or a new callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forwardNonce]);

  // `b` works the same way, opening the toolbar's snooze menu.
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozeSeenRef = useRef(snoozeNonce);
  useEffect(() => {
    if (snoozeNonce === snoozeSeenRef.current) return;
    snoozeSeenRef.current = snoozeNonce;
    setSnoozeOpen(true);
  }, [snoozeNonce]);
  useEffect(() => {
    setSnoozeOpen(false);
  }, [threadId]);

  if (!threadId) {
    return frame(
      <Body className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <Mail className="h-10 w-10 opacity-30" aria-hidden />
        <p className="text-sm">Select a message to read it here</p>
      </Body>
    );
  }

  if (isLoading) {
    return frame(
      <Body className="flex min-w-0 flex-1 flex-col gap-3 p-8" aria-hidden>
        <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        <div className="mt-6 h-40 w-full animate-pulse rounded bg-muted" />
      </Body>
    );
  }

  // Only when there is nothing to show. A refetch that fails under a loaded
  // thread keeps `data`, and swapping the conversation for this screen would
  // also unmount a reply in progress.
  if (!data) {
    return frame(
      <Body className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-destructive">
          Couldn’t load this conversation
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
      </Body>
    );
  }

  if (data.messages.length === 0) {
    return frame(
      <Body className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <Mail className="h-10 w-10 opacity-30" aria-hidden />
        <p className="text-sm">This conversation has no messages.</p>
      </Body>
    );
  }

  const messages = data.messages; // oldest → newest (server ordered date ASC)
  const threadRootId = data.thread_id;
  const isThread = messages.length > 1;
  // The heading names the conversation, so the reply prefixes each message
  // accumulates ("Re: RE: Fwd:") are noise there.
  const subject = conversationSubject(messages[messages.length - 1].subject) || "(no subject)";

  // Reply targets the latest INBOUND message (fallback: latest message, which
  // makes a reply to our own sent mail a follow-up to the same people), and
  // carries the thread root id so the reply joins this conversation.
  const mine = ownDomains(identities?.identities.map((i) => i.domain) ?? [], messages);
  const defaultTarget = defaultReplyTarget(messages);
  // A closed reply box always describes, and opens as, a plain reply to the
  // default message. Who an OPEN one goes to is whatever was last asked for.
  const openTargetId = replyOpen ? replyTargetId : null;
  const openMode: ReplyMode = replyOpen ? replyMode : "reply";
  const replyTarget = (openTargetId && messages.find((m) => m.id === openTargetId)) || defaultTarget;
  const replyInitial = replyInitialForThread(threadRootId, messages, openMode, openTargetId, mine);
  const canReply = !!replyInitial?.to;
  // Offered for the default message: that is what the toolbar and the row of
  // buttons under the thread reply to.
  const canReplyAll = !!defaultTarget && hasReplyAll(defaultTarget, mine);

  const beginReply = (mode: ReplyMode, messageId: string | null) => {
    setReplyTargetId(messageId);
    // A fresh composer whenever an open one changes hands.
    if (replyOpen) setReplyNonce((n) => n + 1);
    if (onReplyRequest) onReplyRequest(mode);
    else onReplyOpenChange?.(true);
  };
  /**
   * The one way a reply starts: toolbar, a message's menu, the box under the
   * thread, and the keyboard all come through here. With no `messageId` it
   * answers the default message, never a leftover choice from an earlier reply.
   */
  const startReply = (wanted: ReplyMode, messageId: string | null = null) => {
    const target = (messageId && messages.find((m) => m.id === messageId)) || defaultTarget;
    // Reply all to a message with nobody else on it is just a reply.
    const mode: ReplyMode = wanted === "reply-all" && target && hasReplyAll(target, mine) ? "reply-all" : "reply";
    if (replyOpen) {
      const same = mode === openMode && target?.id === replyTarget?.id;
      // Already writing exactly that reply: nothing to do (a stray `r`).
      if (same) return;
      // Writing a different one: its text and quote were for other people, so
      // it is never silently pointed somewhere else.
      if (replyDirtyRef.current) return setPendingReply({ mode, messageId });
    }
    beginReply(mode, messageId);
  };
  startReplyRef.current = (mode, messageId) => {
    if (canReply && onReplyOpenChange) startReply(mode, messageId ?? null);
  };
  const startForward = (m: ThreadMessage) => onOpenCompose?.(forwardInitial(m));
  const total = data.total ?? messages.length;
  // What the thread itself says about where it is, which holds wherever it
  // was opened from (a search result, All Mail): junk gets the Junk actions,
  // and a snoozed thread says so and offers Unsnooze.
  const isJunk = messages.some((m) => m.spam === 1 && m.state === "trash");
  const allTrashed = messages.every((m) => m.state === "trash");
  const threadView: View = isJunk ? "spam" : allTrashed && view !== "spam" ? "trash" : view;
  const snoozedUntil = messages.reduce<number | null>((latest, m) => {
    const t = m.state === "inbox" ? (m.snoozed_until ?? 0) : 0;
    return t > Date.now() && t > (latest ?? 0) ? t : latest;
  }, null);
  // Only mail in the inbox can be snoozed (the Worker refuses anything else,
  // and its reason is shown). Not offered where it can never apply.
  const canSnooze =
    snoozedUntil === null &&
    threadView !== "trash" && threadView !== "spam" && threadView !== "sent" && threadView !== "snoozed" &&
    (messages.some((m) => m.state !== undefined) ? messages.some((m) => m.state === "inbox") : true);

  // On a phone Reply, Reply all and Forward live at the end of the thread (the
  // inline reply row). When that row is not shown, Forward has no other home.
  const hasReplyRow = canReply && !!replyInitial && !!onReplyOpenChange;
  const toolbar = onAction ? (
    <ReaderToolbar
      compact={!isDesktop}
      view={threadView}
      snoozedUntil={snoozedUntil}
      isStarred={data.messages.some((m) => m.starred === 1)}
      canSnooze={canSnooze}
      snoozeOpen={snoozeOpen}
      onSnoozeOpenChange={setSnoozeOpen}
      onAction={onAction}
      onReply={canReply && onReplyOpenChange ? () => startReply("reply") : undefined}
      onReplyAll={canReply && canReplyAll && onReplyOpenChange ? () => startReply("reply-all") : undefined}
      onForward={
        defaultTarget && onOpenCompose && (isDesktop || !hasReplyRow) ? () => startForward(defaultTarget) : undefined
      }
      onPrint={() => setPrinting({ only: null })}
      onSummarize={() => summarize.mutate(threadRootId)}
      summarizing={summarize.isPending}
      mode={mode}
      onMode={setMode}
    />
  ) : null;

  return frame(
    // min-h-0 on BOTH: a flex child will not shrink below its content height
    // without it, so the auto-sized message iframe inflated this container
    // instead of scrolling inside it - the ScrollArea reported
    // scrollHeight === clientHeight and the overflow escaped to the document,
    // which is why the thread could not be scrolled with a reply box open.
    // @container: the toolbar shows its labels by the width of THIS pane.
    <Body data-print-flow className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      {printing && (
        // Only seen if the browser's print dialog never came up, or never
        // reported closing: the way back to the app.
        <div data-print-hide role="status" className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2 text-sm">
          <span>Print view</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setPrinting(null)} className="max-md:h-11">
            Done
          </Button>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        {/* mx-auto + max-w caps the reading measure so a message doesn't sprawl
            to 150+ chars/line on a wide monitor (standard mail-client behavior). */}
        <article
          ref={articleRef}
          data-print-root
          className="mx-auto w-full max-w-3xl px-4 py-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-7 md:py-6"
        >
          {isError && (
            <div
              data-print-hide
              role="status"
              className="mb-3 flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
            >
              <span>Couldn't refresh this conversation.</span>
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
          <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">{subject}</h1>
          {isThread && (
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{total} messages</span>
              {fold.long && mode !== "chat" && (
                <Button
                  data-print-hide
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => (fold.allOpen ? fold.foldEarlier() : fold.openAll())}
                  className="h-6 gap-1 px-1.5 text-xs text-muted-foreground max-md:h-11 max-md:px-3"
                >
                  {fold.allOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
                  {fold.allOpen ? "Collapse earlier" : "Expand all"}
                </Button>
              )}
            </div>
          )}
          {snoozedUntil !== null && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <AlarmClock className="size-3.5" aria-hidden />
              Snoozed until {formatSnoozeTime(snoozedUntil, Date.now())}
            </p>
          )}
          {data.truncated && (
            <p role="note" className="mt-1 text-xs text-muted-foreground">
              Showing the latest {messages.length}. Search to find earlier messages in this conversation.
            </p>
          )}

          {/* Desktop action bar: one row that never wraps, and stays at the top
              of the pane while the conversation scrolls under it. On a phone
              the same actions sit in the top bar instead (see `frame`), so the
              first message starts right under the subject. */}
          {isDesktop && toolbar ? (
            <div data-print-hide className="sticky top-0 z-10 -mx-4 mt-3 mb-5 border-b bg-background px-4 py-2 md:-mx-7 md:px-7">
              {toolbar}
            </div>
          ) : (
            <Separator className="mt-4 mb-5" />
          )}

          {/* AI summary panel — appears once Summarize is clicked. */}
          {(summarize.isPending || summarize.data || summarize.error) && (
            <div data-print-hide className="mb-5 rounded-lg border bg-muted/40 p-3" role="status">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Sparkles className="size-3.5" />
                AI summary
              </div>
              {summarize.isPending ? (
                <p className="text-sm text-muted-foreground">
                  Reading the conversation…
                </p>
              ) : summarize.error ? (
                <p className="text-sm text-destructive">
                  Couldn't summarize this conversation. Please try again.
                </p>
              ) : (
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm">
                  {summarize.data?.summary}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-6">
            {mode === "chat" && !printing ? (
              <ChatView data={data} />
            ) : (
              // Runs of folded messages share one card, a line each. Printing
              // unfolds them all (or shows the one message being printed)
              // without touching what is folded on screen afterwards.
              groupFolded(
                printing?.only ? messages.filter((m) => m.id === printing.only) : messages,
                printing ? () => true : fold.isOpen,
              ).map((group) =>
                group.folded ? (
                  <div key={group.messages[0].id} className="divide-y overflow-hidden rounded-lg border bg-card">
                    {group.messages.map((m) => (
                      <FoldedMessage
                        key={m.id}
                        msg={m}
                        onOpen={() => {
                          fold.open(m.id);
                          setUnfoldedId(m.id);
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  group.messages.map((m) => (
                    <MessageEntry
                      key={m.id}
                      msg={m}
                      own={mine}
                      takeFocus={unfoldedId === m.id}
                      onPrint={() => setPrinting({ only: m.id })}
                      printing={!!printing}
                      onReply={onReplyOpenChange ? (mode) => startReply(mode, m.id) : undefined}
                      onForward={onOpenCompose ? () => startForward(m) : undefined}
                    />
                  ))
                ),
              )
            )}
          </div>

          {/* Inline reply, Gmail-style, at the end of the conversation. Keyed
              by thread so a thread switch never carries a draft across. */}
          {canReply && replyInitial && onReplyOpenChange && (
            <div data-print-hide className="mt-6">
              <InlineReply
                key={`${threadRootId}:${replyNonce}`}
                ref={replyRef}
                initial={replyInitial}
                open={replyOpen}
                onOpenChange={onReplyOpenChange}
                onStart={() => startReply("reply")}
                onDirtyChange={(dirty) => {
                  replyDirtyRef.current = dirty;
                }}
                onOpenFull={onOpenCompose}
                onUndoSend={
                  onUndoReplySend
                    ? (snapshot) => onUndoReplySend({ initial: snapshot, mode: openMode, messageId: openTargetId })
                    : undefined
                }
                collapsedActions={
                  <>
                    {canReplyAll && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => startReply("reply-all")}
                        className="h-auto gap-1.5 rounded-xl px-4 text-sm text-muted-foreground max-md:min-h-11"
                      >
                        <ReplyAll className="size-4" />
                        Reply all
                      </Button>
                    )}
                    {defaultTarget && onOpenCompose && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => startForward(defaultTarget)}
                        className="h-auto gap-1.5 rounded-xl px-4 text-sm text-muted-foreground max-md:min-h-11"
                      >
                        <Forward className="size-4" />
                        Forward
                      </Button>
                    )}
                  </>
                }
              />
            </div>
          )}
          <AlertDialog open={!!pendingReply} onOpenChange={(o) => !o && setPendingReply(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Discard this reply and start a new one?</AlertDialogTitle>
                <AlertDialogDescription>
                  The reply you are writing goes to different people. Starting a new one deletes what
                  you have written.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep writing</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (!pendingReply) return;
                    replyRef.current?.discard();
                    replyDirtyRef.current = false;
                    beginReply(pendingReply.mode, pendingReply.messageId);
                    setPendingReply(null);
                  }}
                >
                  Discard and start new
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </article>
      </ScrollArea>
    </Body>,
    // Desktop renders the toolbar inside the article, above.
    isDesktop ? null : toolbar,
  );
}

/** The URL when it is a well-formed https address, else null. */
function safeHttpsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** Split a conversation into runs of folded messages and runs of open ones. */
function groupFolded(messages: ThreadMessage[], isOpen: (id: string) => boolean) {
  const groups: { folded: boolean; messages: ThreadMessage[] }[] = [];
  for (const m of messages) {
    const folded = !isOpen(m.id);
    const last = groups[groups.length - 1];
    if (last && last.folded === folded) last.messages.push(m);
    else groups.push({ folded, messages: [m] });
  }
  return groups;
}

/**
 * A folded message: who, the start of what they said, and when, on one line.
 * The whole line is the button that unfolds it. Nothing of the body is
 * mounted (no iframe, no image banner) until then. What would be a warning or
 * a paperclip on the open message is still marked here, so folding never
 * hides the fact that a message has files or failed its sender check.
 */
function FoldedMessage({ msg, onOpen }: { msg: ThreadMessage; onOpen: () => void }) {
  const mine = msg.direction === "out";
  const fromLabel = senderLabel(msg.msg_from) || msg.msg_from;
  const sentName = mine ? msg.body.headers?.fromName : undefined;
  const fromName = mine ? (sentName ? `You · ${sentName}` : "You") : fromLabel;
  const fromAddr = msg.from_addr ?? addressOf(msg.msg_from);
  const flagged =
    msg.direction === "in" && (!!addressClaimedInName(fromLabel, fromAddr) || msg.body.headers?.auth?.dmarc === "fail");
  const files = msg.body.attachments.length;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={false}
      aria-label={`Expand message from ${fromName}`}
      className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
    >
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-full text-[0.65rem] font-semibold text-white"
        style={{ backgroundColor: avatarColor(fromAddr || fromLabel) }}
      >
        {initialsOf(fromLabel)}
      </span>
      <span className="max-w-[40%] min-w-0 truncate text-sm font-medium text-foreground">{fromName}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{msg.snippet}</span>
      {flagged && (
        <ShieldAlert className="size-4 shrink-0 text-destructive" aria-label="Sender warning" role="img" />
      )}
      {files > 0 && (
        <Paperclip
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-label={files === 1 ? "1 attachment" : `${files} attachments`}
          role="img"
        />
      )}
      <RelativeTime short date={msg.date} className="shrink-0 text-xs text-muted-foreground" />
    </button>
  );
}

/** One message within the conversation: header + sandboxed body. */
function MessageEntry({
  msg,
  own,
  takeFocus,
  onReply,
  onForward,
  onPrint,
  printing,
}: {
  msg: ThreadMessage;
  /** Print this message alone. */
  onPrint?: () => void;
  /** Being printed: show the full addresses and the exact date. */
  printing?: boolean;
  /** Just unfolded by the user: take focus, so the keyboard carries on from here. */
  takeFocus?: boolean;
  /** The user's own domains (see ownDomains), so Reply all is offered honestly. */
  own?: string[];
  onReply?: (mode: ReplyMode) => void;
  onForward?: () => void;
}) {
  const body = msg.body;
  const cc = msg.msg_cc?.trim();
  const qc = useQueryClient();
  const [shownHtml, setShownHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (takeFocus) rootRef.current?.focus({ preventScroll: true });
    // Once, as it appears: later renders must not pull focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const html = shownHtml ?? body.html;
  const blocked = shownHtml ? 0 : (msg.remoteShown ? 0 : msg.remoteImageCount ?? 0);

  async function handleShow() {
    setBusy(true);
    try { const r = await showMessageImages(msg.id); setShownHtml(r.html); }
    catch { toast.error("Couldn't load images. Please try again."); }
    finally { setBusy(false); }
  }
  async function handleAlways() {
    // Allowlist the AUTHENTICATED mailbox (from_addr), which is what the server
    // matches against — not the spoofable rendered msg_from. Fall back to
    // msg_from only for pre-existing rows that have no from_addr.
    try {
      await allowImagesFrom(msg.from_addr ?? msg.msg_from);
    } catch {
      toast.error("Couldn't save that. Images from this sender are still blocked.");
      return;
    }
    void qc.invalidateQueries({ queryKey: ["thread"] });
  }

  const mine = msg.direction === "out";
  const fromLabel = senderLabel(msg.msg_from) || msg.msg_from;
  // Our own messages read as "You"; the address beside it still says which
  // identity sent it.
  const sentName = mine ? msg.body.headers?.fromName : undefined;
  const fromName = mine ? (sentName ? `You · ${sentName}` : "You") : fromLabel;
  // The AUTHENTICATED mailbox where we have one; msg_from is the sender's own
  // unescaped text and a display name can contain anything, including a second
  // address. See showAddr below.
  const fromAddr = msg.from_addr ?? addressOf(msg.msg_from);
  // A display name is attacker-controlled, so showing it ALONE lets
  // `From: "Legit Corp <billing@legit.com>" <evil@attacker.example>` render
  // byte-identically to the real Legit Corp. Keeping the true address beside
  // the name is the one defence a mail client owes against that. Suppressed
  // only when the "name" already is the address.
  const showAddr = fromAddr && fromAddr !== fromName;
  const toSummary = recipientSummary(msg.msg_to, cc);
  const headers = body.headers;
  // Two cheap, honest signals. A name that itself claims an address on another
  // domain is the classic impersonation; a DMARC fail means the sending domain
  // disowned the message. Neither is shown for our own sent mail.
  const claimed = msg.direction === "in" ? addressClaimedInName(fromLabel, fromAddr) : null;
  const dmarcFailed = msg.direction === "in" && headers?.auth?.dmarc === "fail";
  const unsubscribe = msg.direction === "in" ? headers?.unsubscribe : undefined;
  const [unsubState, setUnsubState] = useState<"idle" | "busy" | "done">("idle");
  // A page the user has to visit themselves. Known up front when the list
  // offers a web address and nothing the Worker can act on; learned from the
  // Worker when it tried and the list sent it to a page instead. Either way it
  // is shown as a real link for the user to tap: opening a tab from code after
  // a request has come back is outside the tap, and Safari blocks it silently.
  const [unsubPage, setUnsubPage] = useState<string | null>(null);
  const pageOnly = unsubscribe?.url && !unsubscribe.oneClick && !unsubscribe.mailto ? unsubscribe.url : null;
  const unsubLink = safeHttpsUrl(unsubPage ?? pageOnly);
  async function handleUnsubscribe() {
    setUnsubState("busy");
    try {
      const r = await unsubscribeFrom(msg.id);
      if (r.method === "open") {
        setUnsubState("idle");
        if (safeHttpsUrl(r.url)) setUnsubPage(r.url);
        else toast.error("This list can only be left on its own page. Use the link in the message.");
        return;
      }
      setUnsubState("done");
      toast.success(r.method === "mailto" ? "Unsubscribe request sent" : "Unsubscribed");
    } catch (e) {
      setUnsubState("idle");
      // The Worker says why it could not (the list refused, the message could
      // not be verified): that is more use than "something went wrong".
      const why = e instanceof ApiError && (e.status === 409 || e.status === 502) && e.message ? asSentence(e.message) : "";
      toast.error(why ? `Couldn't unsubscribe. ${why}` : "Couldn't unsubscribe. Try the link in the message instead.");
    }
  }
  const bccList = headers?.bcc?.map((b) => b.address).join(", ");
  const invite = inviteAttachment(body.attachments);
  const replyToList = headers?.replyTo?.map((r) => r.address).join(", ");

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      data-message-open=""
      aria-label={`Message from ${fromName}`}
      // scroll-mt: clear of the sticky toolbar when scrolled to (see Reader).
      className="scroll-mt-16 overflow-hidden rounded-lg border bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {/* Header — all metadata rendered as escaped React text nodes. */}
      <div data-message-head className="flex items-start gap-3 px-4 pt-3 pb-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
          style={{ backgroundColor: avatarColor(fromAddr || fromLabel) }}
        >
          {initialsOf(fromLabel)}
        </span>

        <div className="min-w-0 flex-1">
          {/* Desktop: name, then the address in what is left of the line (never
              less than a few characters: it is the part that cannot be faked).
              Phone: one under the other. Side by side there, with the date
              also on the line, each got about three letters ("Ma…"). */}
          <div className="flex min-w-0 flex-col md:flex-row md:items-baseline md:gap-2" title={msg.msg_from}>
            <span className="truncate text-sm font-semibold text-foreground">{fromName}</span>
            {showAddr && (
              <span className="truncate text-xs text-muted-foreground md:min-w-16 md:flex-1">{fromAddr}</span>
            )}
          </div>
          <button
            data-print-hide
            type="button"
            aria-expanded={showDetail}
            onClick={() => setShowDetail((v) => !v)}
            // Padding grows the touch target to 44px on mobile; the matching
            // negative margin gives the space back to the layout, so the header
            // stays as compact as it looks. Without it this is a 16px-tall tap
            // target on a phone.
            className="-mx-1 flex max-w-full items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:text-foreground max-md:-my-3.5 max-md:py-3.5"
          >
            <span className="truncate">{toSummary ? `to ${toSummary}` : "to (nobody)"}</span>
            <ChevronDown
              className={cn("size-3 shrink-0 transition-transform", showDetail && "rotate-180")}
            />
          </button>

          {/* The full addresses, on request. Collapsed by default because they
              are the answer to "who exactly?", not the everyday reading need. */}
          {/* Always there when printing: a printed message that does not say
              who it went to, or when, is not a record of anything. */}
          {(showDetail || printing) && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <dt className="font-medium">From</dt>
              <dd className="[overflow-wrap:anywhere]">{sentName ? `${sentName} <${addressOf(msg.msg_from)}>` : msg.msg_from}</dd>
              <dt className="font-medium">To</dt>
              <dd className="[overflow-wrap:anywhere]">{msg.msg_to}</dd>
              {cc && (
                <>
                  <dt className="font-medium">Cc</dt>
                  <dd className="[overflow-wrap:anywhere]">{cc}</dd>
                </>
              )}
              {bccList && (
                <>
                  <dt className="font-medium">Bcc</dt>
                  <dd className="[overflow-wrap:anywhere]">{bccList}</dd>
                </>
              )}
              {replyToList && (
                <>
                  <dt className="font-medium">Reply to</dt>
                  <dd className="[overflow-wrap:anywhere]">{replyToList}</dd>
                </>
              )}
              {headers?.auth && msg.direction === "in" && (
                <>
                  <dt className="font-medium">Checks</dt>
                  <dd>
                    SPF {headers.auth.spf}, DKIM {headers.auth.dkim}, DMARC {headers.auth.dmarc}
                  </dd>
                </>
              )}
              {/* The header shows a relative date; the exact time lived only in
                  a title tooltip, which a touch device cannot reach at all. */}
              <dt className="font-medium">Date</dt>
              <dd>{new Date(msg.date).toLocaleString()}</dd>
            </dl>
          )}
        </div>

        <RelativeTime
          date={msg.date}
          className="shrink-0 pt-0.5 text-xs text-muted-foreground"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              data-print-hide
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Message actions"
              className="-mr-2 -mt-1 size-8 shrink-0 text-muted-foreground max-md:size-11"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onReply && (
              <DropdownMenuItem onSelect={() => onReply("reply")}>
                <Reply /> Reply
              </DropdownMenuItem>
            )}
            {onReply && hasReplyAll(msg, own) && (
              <DropdownMenuItem onSelect={() => onReply("reply-all")}>
                <ReplyAll /> Reply all
              </DropdownMenuItem>
            )}
            {onForward && (
              <DropdownMenuItem onSelect={onForward}>
                <Forward /> Forward
              </DropdownMenuItem>
            )}
            {onPrint && (
              <DropdownMenuItem onSelect={onPrint}>
                <Printer /> Print
              </DropdownMenuItem>
            )}
            {msg.direction === "in" && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href={`/api/messages/${encodeURIComponent(msg.id)}/raw`} download className="no-underline">
                    <Download /> Download original
                  </a>
                </DropdownMenuItem>
                {/* Only with an authenticated address to block: the rendered
                    From text is the sender's own and proves nothing. */}
                {msg.from_addr && (
                  <DropdownMenuItem onSelect={() => setConfirmBlock(true)}>
                    <Ban /> Block sender
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <AlertDialog open={confirmBlock} onOpenChange={setConfirmBlock}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Block {msg.from_addr}?</AlertDialogTitle>
              <AlertDialogDescription>
                {dmarcFailed && msg.from_addr ? `${failedCheckWarning(msg.from_addr)} ` : ""}
                New mail from this address will go straight to Junk. You can unblock it any time
                under Rules.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => msg.from_addr && void blockAddress(qc, msg.from_addr)}>
                Block sender
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {(claimed || dmarcFailed) && (
        // A note, not an alert: an alert is announced the moment it appears,
        // which here is once per flagged message on every opening of the thread.
        <div
          role="note"
          aria-label="Sender warning"
          className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-foreground"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span className="[overflow-wrap:anywhere]">
            {claimed
              ? `The sender name mentions ${claimed}, but this message came from ${fromAddr}.`
              : `This message failed the sender check for ${fromAddr.slice(fromAddr.lastIndexOf("@") + 1)}. It may not be from who it says.`}{" "}
            Be careful with links and attachments.
          </span>
        </div>
      )}

      {unsubscribe && (
        <div data-print-hide className="mx-4 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          <span>This is a mailing list.</span>
          {unsubLink ? (
            <a
              href={unsubLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-foreground no-underline hover:bg-accent max-md:h-11"
            >
              <ExternalLink className="size-3.5" />
              Open the unsubscribe page
            </a>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={unsubState !== "idle"}
              onClick={() => void handleUnsubscribe()}
              className="h-7 gap-1.5 px-2 text-xs text-foreground max-md:h-11"
            >
              <MailMinus className="size-3.5" />
              {unsubState === "done" ? "Unsubscribed" : unsubState === "busy" ? "Unsubscribing…" : "Unsubscribe"}
            </Button>
          )}
        </div>
      )}

      {/* Attachments — links to the download endpoint, shown as chips. */}
      {body.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {body.attachments.map((a, i) =>
            a.stored === false ? (
              // The bytes were never written, so a link here would just 404.
              // Show the name (it is real information) and say plainly that the
              // file is not available rather than offering a dead download.
              <span
                key={a.partId ?? i}
                title="This file was not stored with the message"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-sm text-muted-foreground md:min-h-0"
              >
                <Paperclip className="h-3.5 w-3.5" />
                {a.name}
                <span className="text-xs">(not stored)</span>
              </span>
            ) : (
              // Keyed and linked by MIME part, not name: two files called
              // "invoice.pdf" are two files.
              <a
                key={a.partId ?? i}
                href={attachmentUrl(msg.id, a.name, a.partId)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-foreground no-underline transition-colors hover:bg-accent md:min-h-0"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Paperclip className="h-3.5 w-3.5" />
                {a.name}
              </a>
            ),
          )}
        </div>
      )}

      {invite && <InviteCard messageId={msg.id} attachment={invite} />}

      {/* Body — identical sandboxed iframe + CSP for every message. It sits
          full-bleed against the card edge: senders style their own margins,
          and a second inset frame around that reads as a widget, not a
          letter. */}
      <div className="border-t">
        {html ? (
          <>
            <MessageImageBanner
              count={busy ? 0 : blocked}
              // The address that will actually be trusted (see handleAlways),
              // not the display name, which is the sender's own text.
              sender={msg.from_addr ?? msg.msg_from}
              onShow={handleShow}
              onAlways={handleAlways}
            />
            <EmailFrame html={html} title={`Message from ${msg.msg_from}`} />
          </>
        ) : (
          <pre className="m-0 rounded-md border bg-card p-4 font-sans text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
            {body.text
              ? linkifyText(body.text).map((tok, i) =>
                  tok.t === "link" ? (
                    <a
                      key={i}
                      href={tok.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2"
                    >
                      {tok.s}
                    </a>
                  ) : (
                    <span key={i}>{tok.s}</span>
                  ),
                )
              : "(empty)"}
          </pre>
        )}
      </div>
    </section>
  );
}

/**
 * Sandboxed email-body iframe that auto-sizes to its content height, so short
 * emails don't get a tall empty box and long emails don't get a nested inner
 * scrollbar (the whole reading pane scrolls instead). The sizing, and the
 * reasons behind the sandbox flags, live in lib/emailFrame.
 */
function EmailFrame({ html, title }: { html: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    return autoSizeEmailFrame(iframe);
  }, [html]);

  return (
    // The wrapper holds the frame's space while it is being measured (see
    // measureContentHeight); the height itself is written straight to the
    // iframe, outside React.
    <div data-email-frame-wrapper className="overflow-hidden rounded-md border bg-card p-4">
      <iframe
        ref={ref}
        title={title}
        sandbox={IFRAME_SANDBOX}
        srcDoc={wrapHtml(html)}
        scrolling="no"
        className="block min-h-24 w-full overflow-hidden border-0 bg-transparent"
      />
    </div>
  );
}

export function MessageImageBanner({
  count, sender, onShow, onAlways,
}: { count: number; sender: string; onShow: () => void; onAlways: () => void }) {
  if (!count) return null;
  return (
    <div data-print-hide className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span className="text-muted-foreground">
        {count} {count === 1 ? "image" : "images"} blocked for your privacy.
        Showing them lets the sender know you opened this message.
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onShow} className="max-md:h-11">
        Display images
      </Button>
      {/* The sender is the point of this button (it is a decision to trust
          them), so it wraps onto a second line rather than being cut off. */}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onAlways}
        className="h-auto min-h-8 max-w-full justify-start py-1 text-left whitespace-normal max-md:min-h-11"
      >
        <span className="[overflow-wrap:anywhere]">Always show from {sender}</span>
      </Button>
    </div>
  );
}

/**
 * One toolbar button. Desktop: outlined, icon plus a label that shows once
 * the reading pane is wide enough for the whole row (a container query, so it
 * follows the pane and not the window). Phone (`compact`): a bare 44px icon.
 * Either way the accessible name and tooltip are `name`.
 */
function ToolButton({
  icon: Icon,
  name,
  label,
  compact,
  className,
  iconClassName,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children"> & {
  icon: LucideIcon;
  /** Accessible name and tooltip. */
  name: string;
  /** Visible text on desktop; defaults to `name`. */
  label?: string;
  compact: boolean;
  iconClassName?: string;
}) {
  return (
    <Button
      type="button"
      variant={compact ? "ghost" : "outline"}
      size={compact ? "icon" : "sm"}
      aria-label={name}
      title={name}
      className={cn(compact && "size-11", className)}
      {...props}
    >
      <Icon className={cn(compact ? "size-5" : "size-4", iconClassName)} />
      {!compact && <span className="hidden @2xl:inline">{label ?? name}</span>}
    </Button>
  );
}

/**
 * The open conversation's actions, as one row that never wraps: the few used
 * constantly as buttons, everything else under More.
 */
function ReaderToolbar({
  compact,
  view,
  isStarred,
  canSnooze,
  snoozedUntil,
  snoozeOpen,
  onSnoozeOpenChange,
  onAction,
  onReply,
  onReplyAll,
  onForward,
  onPrint,
  onSummarize,
  summarizing,
  mode,
  onMode,
}: {
  /** Phone layout: icons only, 44px targets, no Reply (that is at the end of the thread). */
  compact: boolean;
  view: View;
  isStarred: boolean;
  canSnooze: boolean;
  /** When the open thread is snoozed until, or null. */
  snoozedUntil: number | null;
  snoozeOpen: boolean;
  onSnoozeOpenChange: (open: boolean) => void;
  onAction: (action: MailAction, opts?: ActionOptions) => void;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  /** Print the whole conversation. */
  onPrint?: () => void;
  onSummarize: () => void;
  summarizing: boolean;
  mode: ReaderMode;
  onMode: (mode: ReaderMode) => void;
}) {
  const isTrash = view === "trash";
  const isJunk = view === "spam";
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div
      role="toolbar"
      aria-label="Conversation actions"
      // One row at every width the layout produces (the narrowest reading
      // pane is about 390px, and the icons need 300). Wrapping is the last
      // resort for anything narrower still: it never scrolls sideways and
      // never hides an action off the edge.
      className={cn("flex items-center", compact ? "gap-0" : "flex-wrap gap-1 @2xl:gap-1.5")}
    >
      {/* Dropped in a very narrow pane, where the icons need the room; the
          reply box at the end of the thread is still there. */}
      {!compact && onReply && (
        <Button type="button" size="sm" onClick={onReply} className="hidden @sm:inline-flex @2xl:mr-1">
          Reply
        </Button>
      )}

      {isTrash || isJunk ? (
        <>
          {isJunk ? (
            <ToolButton compact={compact} icon={ShieldCheck} name="Not junk" onClick={() => onAction("unspam")} />
          ) : (
            <ToolButton compact={compact} icon={RotateCcw} name="Restore" onClick={() => onAction("restore")} />
          )}
          <ToolButton
            compact={compact}
            icon={Trash2}
            name="Delete forever"
            onClick={() => setConfirmDelete(true)}
            className="text-destructive hover:text-destructive"
          />
          <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete forever?</AlertDialogTitle>
                <AlertDialogDescription>
                  This conversation will be permanently deleted and cannot be
                  recovered.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-white hover:bg-destructive/90"
                  onClick={() => onAction("delete")}
                >
                  Delete forever
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        <>
          <ToolButton compact={compact} icon={Archive} name="Archive" onClick={() => onAction("archive")} />
          <ToolButton
            compact={compact}
            icon={Trash2}
            name="Move to trash"
            label="Trash"
            onClick={() => onAction("trash")}
          />
          <ToolButton
            compact={compact}
            icon={MailOpen}
            name="Mark as unread"
            label="Unread"
            onClick={() => onAction("unread")}
          />
          {canSnooze && (
            <SnoozeMenu
              open={snoozeOpen}
              onOpenChange={onSnoozeOpenChange}
              onSnooze={(until) => onAction("snooze", { until })}
              align={compact ? "end" : "start"}
            >
              <ToolButton compact={compact} icon={AlarmClock} name="Snooze" />
            </SnoozeMenu>
          )}
          {(snoozedUntil !== null || view === "snoozed") && (
            <ToolButton
              compact={compact}
              icon={AlarmClockOff}
              name="Unsnooze"
              // With the time it had, so Undo can put the snooze back.
              onClick={() => (snoozedUntil !== null ? onAction("unsnooze", { undoUntil: snoozedUntil }) : onAction("unsnooze"))}
            />
          )}
        </>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ToolButton compact={compact} icon={MoreHorizontal} name="More actions" label="More" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align={compact ? "end" : "start"} className="min-w-[13rem]">
          {!compact && onReplyAll && (
            <DropdownMenuItem onSelect={onReplyAll}>
              <ReplyAll /> Reply all
            </DropdownMenuItem>
          )}
          {onForward && (
            <DropdownMenuItem onSelect={onForward}>
              <Forward /> Forward
            </DropdownMenuItem>
          )}
          {((!compact && onReplyAll) || onForward) && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => onAction(isStarred ? "unstar" : "star")}>
            <Star className={cn(isStarred && "fill-yellow-400 !text-yellow-400")} />
            {isStarred ? "Unstar" : "Star"}
          </DropdownMenuItem>
          {!isTrash && !isJunk && (
            <DropdownMenuItem onSelect={() => onAction("spam")}>
              <OctagonAlert /> Report junk
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onSummarize} disabled={summarizing}>
            <Sparkles /> {summarizing ? "Summarizing…" : "Summarize"}
          </DropdownMenuItem>
          {onPrint && (
            <DropdownMenuItem onSelect={onPrint}>
              <Printer /> Print
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Reading mode</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={mode} onValueChange={(v) => onMode(v as ReaderMode)}>
            <DropdownMenuRadioItem value="rich" title="Read the formatted email">
              Rich
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="chat" title="Read the conversation as chat bubbles">
              Chat
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
