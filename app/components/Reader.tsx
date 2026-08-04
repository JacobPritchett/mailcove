import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronDown, Mail, MailOpen, Paperclip, RotateCcw, Sparkles, Star, Trash2 } from "lucide-react";
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
import { useThread, useSummarizeThread } from "@/lib/queries";
import { mutateThread, attachmentUrl, showMessageImages, allowImagesFrom } from "@/lib/api";
import { useReaderMode } from "@/lib/useReaderMode";
import { cn } from "@/lib/utils";
import {
  addressOf,
  avatarColor,
  initialsOf,
  recipientSummary,
  senderLabel,
} from "@/lib/format";
import ChatView from "@/components/ChatView";
import { linkifyText } from "@/lib/chatNormalize";
import RelativeTime from "@/components/RelativeTime";
import InlineReply from "@/components/InlineReply";
import { replyInitialForThread } from "@/lib/replyContext";
import type { ComposeInitial } from "@/components/ComposeDialog";
import type { MailAction, ThreadMessage, View } from "@/lib/types";

/**
 * Strict CSP applied to every email-body iframe. `default-src 'none'` blocks ALL
 * remote subresource loads (scripts, remote images/tracking pixels, fonts,
 * frames). Inline styles and data:-URI images/fonts are allowed so legit HTML
 * email still renders. The iframe itself is sandboxed with allow-popups only —
 * NO allow-scripts, NO allow-popups-to-escape-sandbox. Reused unchanged for
 * every message in a multi-message conversation.
 */
// `allow-same-origin` lets the PARENT read the frame's contentDocument to
// auto-size it to its content (see EmailFrame). It is safe ONLY because
// `allow-scripts` is deliberately absent: the sandbox blocks all script
// execution in the frame, so the email can never run code to abuse the
// same-origin grant. Removing allow-scripts is the load-bearing guarantee here.
const IFRAME_SANDBOX = "allow-popups allow-same-origin";
const MEDIA_ORIGIN = typeof location !== "undefined" ? location.origin : "";
const CSP =
  `default-src 'none'; img-src data: ${MEDIA_ORIGIN}/api/media; style-src 'unsafe-inline'; font-src data:; base-uri 'none'`;

// Injected into every email document: a viewport so fixed-width (e.g. 600px
// table) newsletters don't overflow on mobile, theme-aware defaults for simple
// rich messages, and a small reset so images/tables never exceed the reading
// column. Email HTML that brings its own backgrounds still wins; plain HTML
// messages inherit an app-theme surface instead of a forced white body.
const BASE_STYLE =
  "html{color-scheme:light}html[data-app-theme='dark']{color-scheme:dark}body{box-sizing:border-box;margin:0;background:#fff;color:#1a1a1a;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}a{color:#2563eb}html[data-app-theme='dark'] body:not([data-email-background='true']){background:#0f172a;color:#e5e7eb}html[data-app-theme='dark'] body:not([data-email-background='true']) a{color:#93c5fd!important}html[data-app-theme='dark'] body:not([data-email-background='true']) :where(p,div,span,font,td,th,li,strong,em,b,i,h1,h2,h3,h4,h5,h6,blockquote){color:inherit!important;background-color:transparent!important}img{max-width:100%;height:auto}table{max-width:100%}";

function emailDeclaresBackground(html: string): boolean {
  return /(?:style\s*=\s*["'][^"']*background(?:-[a-z]+)?\s*:|\bbgcolor\s*=|\bbackground\s*=)/i.test(html);
}

function currentAppTheme(): "dark" | "light" {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) return "dark";
  return "light";
}

/** Wrap untrusted email HTML so the CSP meta is the first thing in <head>. */
function wrapHtml(html: string): string {
  const theme = currentAppTheme();
  const hasBackground = emailDeclaresBackground(html) ? "true" : "false";
  return `<!doctype html><html data-app-theme="${theme}"><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><style>${BASE_STYLE}</style></head><body data-email-background="${hasBackground}">${html}</body></html>`;
}

export interface ReaderProps {
  /** The selected thread_id (null = nothing selected). */
  threadId: string | null;
  /** Current mailbox view — affects which action buttons show. */
  view?: View;
  /** Inline reply composer visibility (controlled by App so the `r` shortcut
   *  can open it and thread switches close it). */
  replyOpen?: boolean;
  onReplyOpenChange?: (open: boolean) => void;
  /** Escape hatch: open the full compose dialog with this prefill (used by the
   *  inline composer's expand button, carrying the in-progress body). */
  onOpenCompose?: (initial: ComposeInitial) => void;
  /** Action handler — called when the user clicks an action in the toolbar. */
  onAction?: (action: MailAction) => void;
}

export default function Reader({
  threadId,
  view = "inbox",
  replyOpen = false,
  onReplyOpenChange,
  onOpenCompose,
  onAction,
}: ReaderProps) {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch, isFetching } =
    useThread(threadId);
  const [mode, setMode] = useReaderMode();
  const summarize = useSummarizeThread();

  // Clear any prior AI summary when switching conversations so it never shows
  // under the wrong thread.
  useEffect(() => {
    summarize.reset();
    // summarize.reset is stable; only the thread change should clear it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Mark the thread read once when it first loads (if any message is unread).
  const markedThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    if (markedThreadRef.current === data.thread_id) return;
    const hasUnread = data.messages.some((m) => m.unread === 1);
    if (!hasUnread) return;
    markedThreadRef.current = data.thread_id;
    // Best-effort read marking. Fire-and-forget, but invalidate the list/counts
    // caches on success so the sidebar unread badge and row bolding update
    // promptly (not just on the next 15s poll). `.catch` keeps the rejection
    // from escaping — read marking is non-critical.
    mutateThread(data.thread_id, "read")
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["threads"] });
        void qc.invalidateQueries({ queryKey: ["counts"] });
      })
      .catch(() => {
        // ignore — best-effort
      });
  }, [data?.thread_id, data?.messages.length, qc]);

  if (!threadId) {
    return (
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <Mail className="h-10 w-10 opacity-30" aria-hidden />
        <p className="text-sm">Select a message to read it here</p>
      </main>
    );
  }

  if (isLoading) {
    return (
      <main className="flex min-w-0 flex-1 flex-col gap-3 p-8" aria-hidden>
        <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        <div className="mt-6 h-40 w-full animate-pulse rounded bg-muted" />
      </main>
    );
  }

  if (isError || !data) {
    return (
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
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
      </main>
    );
  }

  if (data.messages.length === 0) {
    return (
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <Mail className="h-10 w-10 opacity-30" aria-hidden />
        <p className="text-sm">This conversation has no messages.</p>
      </main>
    );
  }

  const messages = data.messages; // oldest → newest (server ordered date ASC)
  const threadRootId = data.thread_id;
  const isThread = messages.length > 1;
  const subject = messages[messages.length - 1].subject || "(no subject)";

  // Reply targets the latest INBOUND message (fallback: latest message), and
  // carries the thread root id so the reply joins this conversation.
  const replyInitial = replyInitialForThread(threadRootId, messages);
  const canReply = messages.some((m) => m.direction === "in") && !!replyInitial;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        {/* mx-auto + max-w caps the reading measure so a message doesn't sprawl
            to 150+ chars/line on a wide monitor (standard mail-client behavior). */}
        <article className="mx-auto w-full max-w-3xl px-4 py-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-7 md:py-6">
          <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">{subject}</h1>
          {isThread && (
            <p className="mt-1 text-xs text-muted-foreground">
              {messages.length} messages
            </p>
          )}

          {/* Action bar — left action cluster + a pinned Rich/Chat toggle. The
              toggle is a flex sibling (not ml-auto) so it stays right-aligned and
              wraps cleanly instead of orphaning when the cluster gets wide. */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {canReply && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onReplyOpenChange?.(true)}
                  disabled={!onReplyOpenChange}
                  className="max-md:h-11 max-md:px-5"
                >
                  Reply
                </Button>
              )}

              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => summarize.mutate(threadRootId)}
                disabled={summarize.isPending}
                className="gap-1.5 max-md:h-11"
              >
                <Sparkles className="size-3.5" />
                {summarize.isPending ? "Summarizing…" : "Summarize"}
              </Button>

              {onAction && (
                <ReaderToolbar
                  view={view}
                  isStarred={data.messages.some((m) => m.starred === 1)}
                  onAction={onAction}
                />
              )}
            </div>

            {/* Rich / Chat segmented toggle */}
            <div
              className="flex items-center rounded-md border bg-background"
              role="group"
              aria-label="Reading mode"
            >
              <Button
                type="button"
                size="sm"
                variant={mode === "rich" ? "default" : "ghost"}
                aria-pressed={mode === "rich"}
                title="Read the formatted email"
                className="rounded-r-none border-r px-3 h-8 text-xs max-md:h-10"
                onClick={() => setMode("rich")}
              >
                Rich
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "chat" ? "default" : "ghost"}
                aria-pressed={mode === "chat"}
                title="Ask AI questions about this conversation"
                className="rounded-l-none px-3 h-8 text-xs max-md:h-10"
                onClick={() => setMode("chat")}
              >
                Chat
              </Button>
            </div>
          </div>

          {/* AI summary panel — appears once Summarize is clicked. */}
          {(summarize.isPending || summarize.data || summarize.error) && (
            <div className="mt-3 rounded-lg border bg-muted/40 p-3">
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

          <Separator className="my-5" />

          <div className="flex flex-col gap-6">
            {mode === "chat" ? (
              <ChatView data={data} />
            ) : (
              messages.map((m) => (
                <MessageEntry key={m.id} msg={m} />
              ))
            )}
          </div>

          {/* Inline reply, Gmail-style, at the end of the conversation. Keyed
              by thread so a thread switch never carries a draft across. */}
          {canReply && replyInitial && onReplyOpenChange && (
            <div className="mt-6">
              <InlineReply
                key={threadRootId}
                initial={replyInitial}
                open={replyOpen}
                onOpenChange={onReplyOpenChange}
                onOpenFull={onOpenCompose}
              />
            </div>
          )}
        </article>
      </ScrollArea>
    </main>
  );
}

/** One message within the conversation: header + sandboxed body. */
function MessageEntry({ msg }: { msg: ThreadMessage }) {
  const body = msg.body;
  const cc = msg.msg_cc?.trim();
  const qc = useQueryClient();
  const [shownHtml, setShownHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  const html = shownHtml ?? body.html;
  const blocked = shownHtml ? 0 : (msg.remoteShown ? 0 : msg.remoteImageCount ?? 0);

  async function handleShow() {
    setBusy(true);
    try { const r = await showMessageImages(msg.id); setShownHtml(r.html); }
    catch { toast.error("Couldn't load images — please try again."); }
    finally { setBusy(false); }
  }
  async function handleAlways() {
    // Allowlist the AUTHENTICATED mailbox (from_addr), which is what the server
    // matches against — not the spoofable rendered msg_from. Fall back to
    // msg_from only for pre-existing rows that have no from_addr.
    await allowImagesFrom(msg.from_addr ?? msg.msg_from);
    void qc.invalidateQueries({ queryKey: ["thread"] });
  }

  const fromLabel = senderLabel(msg.msg_from) || msg.msg_from;
  // The AUTHENTICATED mailbox where we have one; msg_from is the sender's own
  // unescaped text and a display name can contain anything, including a second
  // address. See showAddr below.
  const fromAddr = msg.from_addr ?? addressOf(msg.msg_from);
  // A display name is attacker-controlled, so showing it ALONE lets
  // `From: "Legit Corp <billing@legit.com>" <evil@attacker.example>` render
  // byte-identically to the real Legit Corp. Keeping the true address beside
  // the name is the one defence a mail client owes against that. Suppressed
  // only when the "name" already is the address.
  const showAddr = fromAddr && fromAddr !== fromLabel;
  const toSummary = recipientSummary(msg.msg_to, cc);

  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      {/* Header — all metadata rendered as escaped React text nodes. */}
      <div className="flex items-start gap-3 px-4 pt-3 pb-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
          style={{ backgroundColor: avatarColor(fromAddr || fromLabel) }}
        >
          {initialsOf(fromLabel)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2" title={msg.msg_from}>
            <span className="truncate text-sm font-semibold text-foreground">{fromLabel}</span>
            {showAddr && (
              <span className="truncate text-xs text-muted-foreground">{fromAddr}</span>
            )}
          </div>
          <button
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
          {showDetail && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <dt className="font-medium">From</dt>
              <dd className="[overflow-wrap:anywhere]">{msg.msg_from}</dd>
              <dt className="font-medium">To</dt>
              <dd className="[overflow-wrap:anywhere]">{msg.msg_to}</dd>
              {cc && (
                <>
                  <dt className="font-medium">Cc</dt>
                  <dd className="[overflow-wrap:anywhere]">{cc}</dd>
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
      </div>

      {/* Attachments — links to the download endpoint, shown as chips. */}
      {body.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {body.attachments.map((a) =>
            a.stored === false ? (
              // The bytes were never written, so a link here would just 404.
              // Show the name (it is real information) and say plainly that the
              // file is unavailable rather than offering a dead download.
              <span
                key={a.name}
                title="This file was not stored with the message"
                className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-sm text-muted-foreground"
              >
                <Paperclip className="h-3.5 w-3.5" />
                {a.name}
                <span className="text-xs">(not stored)</span>
              </span>
            ) : (
            <a
              key={a.name}
              href={attachmentUrl(msg.id, a.name)}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-foreground no-underline transition-colors hover:bg-accent"
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

      {/* Body — identical sandboxed iframe + CSP for every message. It sits
          full-bleed against the card edge: senders style their own margins,
          and a second inset frame around that reads as a widget, not a
          letter. */}
      <div className="border-t">

        {html ? (
          <>
            <MessageImageBanner
              count={busy ? 0 : blocked}
              sender={msg.msg_from}
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
 * scrollbar (the whole reading pane scrolls instead). Height is measured from
 * the frame's own document via a ResizeObserver — possible because the sandbox
 * includes `allow-same-origin` (and never `allow-scripts`; see IFRAME_SANDBOX).
 */
/**
 * Decide whether an email needs breathing room inside its card.
 *
 * A newsletter ships its own full-width coloured canvas and must stay flush to
 * the card edge, or a gutter appears around a design that was meant to bleed.
 * An ordinary reply arrives as a bare `<div dir="ltr">` with no margins at all
 * and would otherwise sit jammed against the border. Decided by measuring the
 * rendered document rather than pattern-matching the HTML, because "does this
 * paint to the edge" is a layout question and only layout can answer it.
 */
function applyBodyPadding(doc: Document) {
  const body = doc.body;
  const view = doc.defaultView;
  if (!body || !view) return;
  // Writing an unchanged value would still be a style mutation, and this runs
  // from a ResizeObserver-adjacent path — assign only on a real change so it
  // cannot feed itself.
  const set = (v: string) => {
    if (body.style.padding !== v) body.style.padding = v;
  };
  const bleeds = Array.from(body.children).some((el) => {
    const bg = view.getComputedStyle(el).backgroundColor;
    // rgba(...,0) and "transparent" both mean nothing is painted.
    if (!bg || bg === "transparent" || /,\s*0\s*\)$/.test(bg)) return false;
    return el.getBoundingClientRect().width >= body.clientWidth - 2;
  });
  set(bleeds ? "0px" : "16px");
}

function EmailFrame({ html, title }: { html: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let ro: ResizeObserver | undefined;
    const syncTheme = () => {
      try {
        const doc = iframe.contentDocument;
        if (doc?.documentElement) {
          doc.documentElement.dataset.appTheme = document.documentElement.classList.contains("dark") ? "dark" : "light";
        }
      } catch {
        /* ignore */
      }
    };
    const measure = () => {
      try {
        const doc = iframe.contentDocument;
        if (doc?.documentElement) {
          setHeight(Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0));
        }
      } catch {
        // Opaque-origin frame (shouldn't happen with allow-same-origin) — keep
        // the CSS fallback height.
      }
    };
    const onLoad = () => {
      syncTheme();
      try {
        if (iframe.contentDocument) applyBodyPadding(iframe.contentDocument);
      } catch {
        /* ignore - padding is cosmetic, never worth failing the render for */
      }
      measure();
      try {
        const doc = iframe.contentDocument;
        if (doc && typeof ResizeObserver !== "undefined") {
          ro = new ResizeObserver(measure);
          ro.observe(doc.documentElement);
          if (doc.body) ro.observe(doc.body);
        }
      } catch {
        /* ignore */
      }
    };
    iframe.addEventListener("load", onLoad);
    if (iframe.contentDocument?.readyState === "complete") onLoad();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    syncTheme();

    // Whether an email paints to the edge is a LAYOUT answer, so it can change
    // when the viewport does: a newsletter whose fixed-width table stops
    // spanning the frame at a narrow width needs the padding a wide one does
    // not. Deciding it once on load left that stale for the rest of the read.
    const onResize = () => {
      try {
        if (iframe.contentDocument) applyBodyPadding(iframe.contentDocument);
      } catch {
        /* cosmetic */
      }
      measure();
    };
    window.addEventListener("resize", onResize);
    return () => {
      iframe.removeEventListener("load", onLoad);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      themeObserver.disconnect();
    };
  }, [html]);

  return (
    <div className="overflow-hidden rounded-md border bg-card p-4">
      <iframe
        ref={ref}
        title={title}
        sandbox={IFRAME_SANDBOX}
        srcDoc={wrapHtml(html)}
        scrolling="no"
        style={height ? { height: `${height}px` } : undefined}
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
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span className="text-muted-foreground">
        {count} {count === 1 ? "image" : "images"} blocked for your privacy.
        Showing them lets the sender know you opened this message.
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onShow}>Display images</Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onAlways}
        title={`Always show images from ${sender}`}
        className="max-w-full gap-1"
      >
        <span className="shrink-0">Always show from</span>
        <span className="min-w-0 truncate">{sender}</span>
      </Button>
    </div>
  );
}

/** Toolbar with archive/trash/star/unread actions for the open conversation. */
function ReaderToolbar({
  view,
  isStarred,
  onAction,
}: {
  view: View;
  isStarred: boolean;
  onAction: (action: MailAction) => void;
}) {
  const isTrash = view === "trash";
  return (
    <div className="flex items-center gap-1">
      {isTrash ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onAction("restore")}
            className="max-md:h-11"
          aria-label="Restore"
          >
            <RotateCcw className="h-4 w-4" />
            Restore
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Delete forever"
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Delete forever
              </Button>
            </AlertDialogTrigger>
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onAction("archive")}
          className="max-md:h-11"
          aria-label="Archive"
        >
          <Archive className="h-4 w-4" />
          Archive
        </Button>
      )}

      {/* Star toggle */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onAction(isStarred ? "unstar" : "star")}
        className="max-md:h-11"
        aria-label={isStarred ? "Unstar" : "Star"}
      >
        <Star
          className={cn(
            "h-4 w-4",
            isStarred ? "fill-yellow-400 text-yellow-400" : "",
          )}
        />
        {isStarred ? "Unstar" : "Star"}
      </Button>

      {/* Mark unread */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onAction("unread")}
        className="max-md:h-11"
          aria-label="Mark as unread"
      >
        <MailOpen className="h-4 w-4" />
        Unread
      </Button>

      {/* Destructive Trash isolated at the end (separator + de-emphasized) so it
          isn't fired by accident next to the benign toggles. Reversible via the
          undo toast App shows; the irreversible "Delete forever" lives in the
          trash view behind a confirm dialog. */}
      {!isTrash && (
        <>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onAction("trash")}
            aria-label="Move to trash"
            className="text-muted-foreground hover:text-destructive max-md:h-11"
          >
            <Trash2 className="h-4 w-4" />
            Trash
          </Button>
        </>
      )}
    </div>
  );
}
