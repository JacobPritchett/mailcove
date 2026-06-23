import { useMemo, useState } from "react";
import { Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { normalizeMessage } from "@/lib/chatNormalize";
import type { Block } from "@/lib/chatNormalize";
import { attachmentUrl } from "@/lib/api";
import type { ThreadResponse, ThreadMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// SafeBlocks — renders Block[] as plain <p> elements, never dangerouslySetInnerHTML
// ---------------------------------------------------------------------------

function SafeBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, bi) => (
        <p key={bi} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          {block.map((inline, ii) =>
            inline.t === "link" ? (
              <a
                key={ii}
                href={inline.href}
                target="_blank"
                rel="noopener noreferrer"
                className="underline [overflow-wrap:anywhere]"
              >
                {inline.s}
              </a>
            ) : (
              <span key={ii}>{inline.s}</span>
            ),
          )}
        </p>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// CollapsibleSection — "Show X" / "Hide X" toggle with muted bordered sub-box
// ---------------------------------------------------------------------------

function CollapsibleSection({
  label,
  blocks,
}: {
  label: string;
  blocks: Block[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto px-0 py-0 text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? `Hide ${label}` : `Show ${label}`}
      </Button>
      {open && (
        <div className="mt-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <SafeBlocks blocks={blocks} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageBubble — one message in the chat view
// ---------------------------------------------------------------------------

function MessageBubble({
  msg,
  single,
}: {
  msg: ThreadMessage;
  single: boolean;
}) {
  const n = useMemo(
    () => normalizeMessage({ text: msg.body.text, html: msg.body.html }),
    // Re-normalize if the body content changes (e.g. a refetch corrects it),
    // not just on a different message id.
    [msg.body.text, msg.body.html],
  );

  const isOut = msg.direction === "out";
  const initials = (msg.msg_from.trim()[0] ?? "?").toUpperCase();

  if (single) {
    // Full-width calm block for single-message threads
    return (
      <div className="w-full">
        {/* Header */}
        <div className="mb-2 space-y-0.5 text-sm text-muted-foreground">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-foreground [overflow-wrap:anywhere]">
              {msg.msg_from}
            </span>
            <span className="shrink-0 text-xs">
              {new Date(msg.date).toLocaleString()}
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="text-sm">
          <SafeBlocks blocks={n.body} />
          {n.quoted && <CollapsibleSection label="quoted text" blocks={n.quoted} />}
          {n.signature && <CollapsibleSection label="signature" blocks={n.signature} />}
        </div>

        {/* Attachments */}
        {msg.body.attachments.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {msg.body.attachments.map((a, ai) => (
              <a
                key={`${ai}-${a.name}`}
                href={attachmentUrl(msg.id, a.name)}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-foreground no-underline transition-colors hover:bg-accent"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Paperclip className="h-3.5 w-3.5" />
                {a.name}
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Multi-message layout: bubbles aligned left (in) or right (out)
  return (
    <div className={cn("flex flex-col gap-1", isOut ? "items-end" : "items-start")}>
      {/* Avatar + sender + date header */}
      <div
        className={cn(
          "flex items-center gap-2 text-xs text-muted-foreground",
          isOut ? "flex-row-reverse" : "flex-row",
        )}
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground"
          aria-hidden
        >
          {initials}
        </span>
        <span className="[overflow-wrap:anywhere] font-medium text-foreground">
          {msg.msg_from}
        </span>
        <span className="shrink-0">{new Date(msg.date).toLocaleString()}</span>
      </div>

      {/* Bubble */}
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-2 text-sm lg:max-w-lg",
          isOut
            ? "bg-primary text-primary-foreground rounded-tr-sm"
            : "bg-muted text-foreground rounded-tl-sm",
        )}
      >
        <SafeBlocks blocks={n.body} />
        {n.quoted && <CollapsibleSection label="quoted text" blocks={n.quoted} />}
        {n.signature && <CollapsibleSection label="signature" blocks={n.signature} />}
      </div>

      {/* Attachments */}
      {msg.body.attachments.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-2">
          {msg.body.attachments.map((a, ai) => (
            <a
              key={`${ai}-${a.name}`}
              href={attachmentUrl(msg.id, a.name)}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-foreground no-underline transition-colors hover:bg-accent"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Paperclip className="h-3.5 w-3.5" />
              {a.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatView — public component
// ---------------------------------------------------------------------------

export default function ChatView({ data }: { data: ThreadResponse }) {
  const single = data.messages.length === 1;

  return (
    <div className="flex flex-col gap-4">
      {data.messages.map((msg) => (
        <MessageBubble key={msg.id} msg={msg} single={single} />
      ))}
    </div>
  );
}
