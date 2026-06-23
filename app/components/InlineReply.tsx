// Gmail-style inline reply, rendered at the bottom of the open thread.
// Collapsed it's a single "Reply to …" affordance; expanded it's the same rich
// body editor compose uses, seeded with the quoted history as a trimmable
// blockquote (visible — nothing is appended invisibly at send time). The full
// compose dialog stays reachable via the expand button for subject/recipient
// edits.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Maximize2, Reply, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDraftReply, useIdentities, useSend } from "@/lib/queries";
import { putDraft, deleteDraft } from "@/lib/api";
import { docHasVisibleContent } from "@/lib/editorDoc";
import type { ComposeBodyHandle } from "@/components/EmailBodyEditor";
import type { ComposeInitial } from "@/components/ComposeDialog";

const BodyEditor = lazy(() => import("@/components/EmailBodyEditor"));

export interface InlineReplyProps {
  /** Reply context (to / Re: subject / quoted text / threading headers). */
  initial: ComposeInitial;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hand the current draft body off to the full compose dialog. */
  onOpenFull?: (initial: ComposeInitial) => void;
}

export default function InlineReply({ initial, open, onOpenChange, onOpenFull }: InlineReplyProps) {
  const send = useSend();
  const aiDraft = useDraftReply();
  const qc = useQueryClient();
  // Plain-text mirror of the editor (open-full handoff, AI-draft quote keep).
  const [text, setText] = useState("");
  // What the editor mounts with — replaced when an AI draft lands before the
  // lazy editor chunk has mounted (the imperative setPlainText would no-op).
  const [bodySeed, setBodySeed] = useState(initial.text ?? "");
  const editorRef = useRef<ComposeBodyHandle>(null);

  // ---- Draft autosave (reply drafts carry the thread id) ----
  const draftIdRef = useRef<string | null>(null);
  // Sent, discarded, or handed off to the dialog — stop touching the row.
  const skipDraftRef = useRef(false);
  // Latest doc snapshot, kept fresh on every editor change so the unmount
  // flush (thread switch) can persist without a live editor ref.
  const docJsonRef = useRef("");
  // Refs mirroring what the unmount flush needs (cleanup closures are stale).
  const latestRef = useRef({ text: "", quote: initial.text ?? "" });
  latestRef.current.text = text;

  /** Typed anything beyond the seeded quote? */
  const replyDirty = text.trim() !== "" && text !== (initial.text ?? "");

  // Autosave queue: saves chain (each starts after the previous settled) and
  // deletion joins the chain — no PUT can land after the DELETE.
  const savingRef = useRef<Promise<void>>(Promise.resolve());

  async function saveReplyDraft(bodyText: string, bodyJson: string) {
    if (skipDraftRef.current) return;
    const id = (draftIdRef.current ??= crypto.randomUUID());
    const payload = {
      to: initial.to ?? "",
      subject: initial.subject ?? "",
      bodyText,
      bodyJson,
      threadId: initial.threadId,
      inReplyTo: initial.inReplyTo,
      fromDomain: initial.fromDomain,
      // Persist the actual sending local-part so a dialog resume doesn't
      // silently fall back to "hello" on deployments with another default.
      fromLocal,
    };
    const save = savingRef.current.then(() =>
      putDraft(id, payload).then(() => {
        void qc.invalidateQueries({ queryKey: ["drafts"] });
      }),
    );
    savingRef.current = save.catch(() => {});
    try {
      await save;
    } catch {
      // best-effort
    }
  }

  function dropReplyDraft() {
    skipDraftRef.current = true;
    const id = draftIdRef.current;
    draftIdRef.current = null;
    if (!id) return;
    void savingRef.current
      .then(() => deleteDraft(id))
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["drafts"] });
        void qc.invalidateQueries({ queryKey: ["counts"] });
      })
      .catch(() => {});
  }

  // Debounced autosave while typing.
  useEffect(() => {
    if (!open || !replyDirty) return;
    const t = setTimeout(() => {
      void saveReplyDraft(text, docJsonRef.current);
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text]);

  // Thread switch unmounts this composer (keyed by thread) — flush the draft.
  useEffect(() => {
    return () => {
      const { text: t, quote } = latestRef.current;
      if (!skipDraftRef.current && t.trim() && t !== quote) {
        void saveReplyDraft(t, docJsonRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bring the expanded composer fully into view inside the thread scroller.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) cardRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  // Same identity resolution as the dialog, minus the explicit picker: reply
  // as the domain the original mail was addressed to when it can send, else
  // the server default. While identities load, trust the reply domain — the
  // server fails loudly (400) rather than re-routing the sender.
  const identities = useIdentities(open).data;
  const domains = identities?.identities.map((i) => i.domain) ?? [];
  const fromDomain =
    [initial.fromDomain, identities?.defaultDomain].find((d) => !!d && domains.includes(d)) ??
    initial.fromDomain ??
    identities?.defaultDomain ??
    "example.com";
  const fromLocal = identities?.defaultLocal || "hello";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        data-testid="inline-reply"
        className="flex w-full items-center gap-2 rounded-xl border border-border/70 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 max-md:py-3.5"
      >
        <Reply className="h-4 w-4 shrink-0" />
        Reply to {initial.to || "sender"}…
      </button>
    );
  }

  async function doSend() {
    if (send.isPending) return;
    let bodyText = text;
    let bodyHtml: string | undefined;
    let docJson = "";
    try {
      const email = await editorRef.current?.getEmail();
      if (email) {
        bodyText = email.text;
        bodyHtml = email.html;
        docJson = editorRef.current?.getDocJson() ?? "";
      }
    } catch {
      // mirror fallback
    }
    // Ship HTML for any visible body, incl. rich-only content (image/divider)
    // whose plaintext serialization is empty.
    const hasVisibleBody = bodyText.trim() !== "" || docHasVisibleContent(docJson);
    send.mutate(
      {
        from: `${fromLocal}@${fromDomain}`,
        fromLocal,
        to: initial.to ?? "",
        subject: initial.subject ?? "",
        text: bodyText,
        ...(bodyHtml && hasVisibleBody ? { html: bodyHtml } : {}),
        inReplyTo: initial.inReplyTo,
        threadId: initial.threadId,
      },
      {
        onSuccess: () => {
          toast.success("Sent ✓");
          dropReplyDraft();
          onOpenChange(false);
        },
        onError: () => toast.error("Send failed"),
      },
    );
  }

  function handleAiDraft() {
    const threadId = initial.threadId;
    if (!threadId) return;
    aiDraft.mutate(threadId, {
      onSuccess: (res) => {
        const quote = initial.text ?? "";
        const full = quote ? `${res.draft}\n\n${quote}` : res.draft;
        // Mirror + mount seed + snapshot reset, same as the dialog: covers the
        // editor chunk mounting after the draft lands, and stops a stale doc
        // snapshot from outliving the replaced body.
        setText(full);
        setBodySeed(full);
        docJsonRef.current = "";
        editorRef.current?.setPlainText(full);
      },
      onError: () => toast.error("Couldn't draft a reply — try again."),
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void doSend();
    }
  }

  return (
    <div
      ref={cardRef}
      className="rounded-xl border border-border/70 bg-background shadow-sm"
      onKeyDown={onKeyDown}
      data-testid="inline-reply"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
        <Reply className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          Replying to <span className="text-foreground">{initial.to}</span> as{" "}
          {fromLocal}@{fromDomain}
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          {onOpenFull && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label="Open in full composer"
              onClick={() => {
                // The dialog takes over this draft row — stop writing to it
                // from here (but don't delete it).
                skipDraftRef.current = true;
                onOpenFull({
                  ...initial,
                  text: text || initial.text,
                  bodyJson: docJsonRef.current || undefined,
                  draftId: draftIdRef.current ?? undefined,
                });
              }}
            >
              <Maximize2 className="size-3.5" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label="Discard reply"
            onClick={() => {
              dropReplyDraft();
              onOpenChange(false);
            }}
          >
            <X className="size-3.5" />
          </Button>
        </span>
      </div>

      {/* Body — quoted history is part of the document (trimmable blockquote). */}
      <Suspense
        fallback={
          <div className="min-h-28 px-4 py-3 text-sm text-muted-foreground/60">Loading editor…</div>
        }
      >
        <BodyEditor
          ref={editorRef}
          initialText={bodySeed}
          placeholder="Write your reply… ( / for blocks, markdown works)"
          onTextChange={(t) => {
            setText(t);
            // Keep the doc snapshot fresh for autosave + the unmount flush.
            try {
              docJsonRef.current = editorRef.current?.getDocJson() || docJsonRef.current;
            } catch {
              // keep the previous snapshot
            }
          }}
          autoFocus="start"
          className="min-h-28 max-h-[45vh] overflow-y-auto px-4 py-3 text-base leading-relaxed md:text-sm"
        />
      </Suspense>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleAiDraft}
          disabled={aiDraft.isPending || !initial.threadId}
          className="h-8 gap-1.5 text-xs text-muted-foreground max-md:h-10"
        >
          {aiDraft.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {aiDraft.isPending ? "Drafting…" : "Draft with AI"}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void doSend()}
          disabled={send.isPending}
          className="h-8 gap-1.5 max-md:h-10"
        >
          {send.isPending ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Sending…
            </>
          ) : (
            <>
              <Send className="size-3.5" /> Send
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
