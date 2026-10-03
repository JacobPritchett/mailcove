// Gmail-style inline reply, rendered at the bottom of the open thread.
// Collapsed it's a single "Reply to …" affordance; expanded it's the same rich
// body editor compose uses, seeded with the quoted history as a trimmable
// blockquote (visible — nothing is appended invisibly at send time). The full
// compose dialog stays reachable via the expand button for subject/recipient
// edits.
import { Suspense, lazy, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Maximize2, Reply, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDraftReply, useIdentities, useSend } from "@/lib/queries";
import { putDraft, deleteDraft } from "@/lib/api";
import { docHasVisibleContent } from "@/lib/editorDoc";
import { bodySeedWithSignature, sameBody } from "@/lib/replyContext";
import type { ComposeBodyHandle } from "@/components/EmailBodyEditor";
import type { ComposeInitial } from "@/components/ComposeDialog";
import { registerDraftFlush } from "@/lib/session";
import { composing } from "@/lib/keys";
import { useIsDesktop } from "@/lib/useMediaQuery";
import { sanitizeLocal } from "@/lib/identity";
import { stashReply, stashedReply, clearStashedReply } from "@/lib/replyStash";

const BodyEditor = lazy(() => import("@/components/EmailBodyEditor"));

/**
 * The header's two small icon buttons. They look 28px; on a touch screen an
 * invisible ::after extends the area that takes the tap to 44px.
 */
const HEADER_BUTTON =
  "relative size-7 text-muted-foreground [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']";

export interface InlineReplyProps {
  /** Reply context (to / Re: subject / quoted text / threading headers). */
  initial: ComposeInitial;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hand the current draft body off to the full compose dialog. */
  onOpenFull?: (initial: ComposeInitial) => void;
  /** Extra choices shown beside the collapsed stub (reply all, forward). */
  collapsedActions?: React.ReactNode;
  /**
   * The collapsed box was clicked. The owner starts a plain reply to the
   * default message; without this the box just opens with whatever `initial`
   * it was last given.
   */
  onStart?: () => void;
  /** Told whenever "the user has written something here" changes. */
  onDirtyChange?: (dirty: boolean) => void;
  ref?: React.Ref<InlineReplyHandle>;
}

export interface InlineReplyHandle {
  /** Throw the reply in progress away (its saved draft too), without closing. */
  discard(): void;
}

export default function InlineReply({
  initial,
  open,
  onOpenChange,
  onOpenFull,
  collapsedActions,
  onStart,
  onDirtyChange,
  ref,
}: InlineReplyProps) {
  // The slash-menu tip is for a keyboard; on a phone it only crowds the line.
  const isDesktop = useIsDesktop();
  const send = useSend();
  const aiDraft = useDraftReply();
  const qc = useQueryClient();
  // Plain-text mirror of the editor (open-full handoff, AI-draft quote keep).
  const [text, setText] = useState("");
  // What the editor mounts with — replaced when an AI draft lands before the
  // lazy editor chunk has mounted (the imperative setPlainText would no-op).
  const [bodySeed, setBodySeed] = useState(initial.text ?? "");
  // Rich-document seed, only when a locally kept reply is being restored.
  const [bodyJsonSeed, setBodyJsonSeed] = useState("");
  // Bumped to remount the editor: its seed props are only read on mount, and
  // by the time a kept reply is found the editor may already be up.
  const [editorKey, setEditorKey] = useState(0);
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
  // Set synchronously when a send starts. `send.isPending` only flips once
  // mutate() runs, after the body has been serialized (an await), so a second
  // Cmd+Enter or a double tap in that gap sent the reply twice. The unmount
  // flush reads it too: a reply that is on its way out is not a draft.
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  // A send can outlive this composer (it is keyed by thread, so switching
  // threads unmounts it). The outcome still has to be handled, but without
  // touching state or the reply-open flag, which by then belongs to whatever
  // thread is on screen.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Exactly what seeding last wrote — the bare quote until the signature for
   *  the resolved sending domain arrives, then quote + signature. Everything
   *  that asks "did the user actually write something?" compares against this,
   *  so a seeded sign-off never counts as a typed reply. */
  const seededRef = useRef(initial.text ?? "");
  /** Has a seed actually been written yet? Distinguishes "empty because we have
   *  not filled it" from "empty because the user cleared it". */
  const hasSeededRef = useRef(false);
  /** Set while WE write to the editor, so the resulting change event is not
   *  mistaken for the user typing. */
  const applyingSeedRef = useRef(false);
  /** The user has touched the body; seeding must never write over it again. */
  const userEditedRef = useRef(false);

  /** Typed anything beyond what we seeded? Compared through sameBody: the
   *  editor hands a seeded reply back WITHOUT its "> " markers, so raw equality
   *  reads every untouched reply as edited and autosaves a junk draft. */
  const replyDirty = text.trim() !== "" && !sameBody(text, seededRef.current);
  // The owner needs to know before it points this box at someone else: an
  // edited reply must not have its recipients changed under it.
  const dirtyNow = open && replyDirty;
  useEffect(() => {
    onDirtyChange?.(dirtyNow);
    // Only the value matters; the callback is not expected to be stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyNow]);

  // Reopening the inline composer starts a NEW reply, so every per-reply ref
  // has to go back to its initial state. This composer is keyed by THREAD, so
  // discarding or handing off to the dialog does not unmount it and the
  // previous reply's state survives. Two consequences, both silent:
  //   - skipDraftRef stayed set, so the next reply in that thread never
  //     autosaved, and because the unmount flush checks the same flag,
  //     switching threads threw the text away instead of saving it;
  //   - `text` still held the discarded body, ready to be written back out
  //     under a fresh draft id.
  // Declared BEFORE the signature seeding effect so the reset cannot wipe a
  // seed applied in the same commit - effects run in declaration order.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      skipDraftRef.current = false;
      // The previous row is either deleted or now owned by the dialog; a new
      // reply gets a new id rather than writing over either.
      draftIdRef.current = null;
      userEditedRef.current = false;
      hasSeededRef.current = false;
      seededRef.current = initial.text ?? "";
      latestRef.current.quote = initial.text ?? "";
      docJsonRef.current = "";
      setText("");
      setBodySeed(initial.text ?? "");
      setBodyJsonSeed("");
      // The editor mounted in this same commit, reading the seed left from
      // whatever this box last showed. When that was a reply to a different
      // message (one picked from a message's menu), its quote is the wrong
      // one: mount the editor again so it starts from this reply's.
      setEditorKey((k) => k + 1);
      // A reply that could be neither sent nor saved last time is waiting on
      // this device (see replyStash): put it back rather than start empty. It
      // is the user's own text, so seeding must not write over it.
      const kept = initial.threadId ? stashedReply(initial.threadId) : null;
      if (kept) {
        userEditedRef.current = true;
        hasSeededRef.current = true;
        docJsonRef.current = kept.json;
        latestRef.current.text = kept.text;
        setText(kept.text);
        setBodySeed(kept.text);
        setBodyJsonSeed(kept.json);
        setEditorKey((k) => k + 1);
      }
    } else if (!open && wasOpenRef.current) {
      // Closed: put the mount seeds back, so the next opening's editor (which
      // mounts before this effect can run again) does not start from a
      // restored reply that has since been sent or discarded.
      setBodySeed(initial.text ?? "");
      setBodyJsonSeed("");
    }
    wasOpenRef.current = open;
  }, [open, initial.text, initial.threadId]);

  // Autosave queue: saves chain (each starts after the previous settled) and
  // deletion joins the chain — no PUT can land after the DELETE.
  const savingRef = useRef<Promise<void>>(Promise.resolve());

  /** Resolves to whether the draft is now stored on the server. */
  async function saveReplyDraft(bodyText: string, bodyJson: string): Promise<boolean> {
    if (skipDraftRef.current) return false;
    const id = (draftIdRef.current ??= crypto.randomUUID());
    const payload = {
      to: initial.to ?? "",
      cc: initial.cc ?? "",
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
      return false; // best-effort; the caller decides whether that matters
    }
    // The server has it now, so a local fallback copy is no longer needed.
    if (initial.threadId) clearStashedReply(initial.threadId);
    return true;
  }

  function dropReplyDraft() {
    skipDraftRef.current = true;
    // Sent or discarded: either way there is nothing left to restore.
    if (initial.threadId) clearStashedReply(initial.threadId);
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

  useImperativeHandle(ref, () => ({ discard: dropReplyDraft }));

  // Debounced autosave while typing.
  useEffect(() => {
    if (!open || !replyDirty) return;
    const t = setTimeout(() => {
      void saveReplyDraft(text, docJsonRef.current);
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text]);

  /** Save the reply if the user wrote one and it is not already on its way out. */
  function flushReplyDraft() {
    const { text: t, quote } = latestRef.current;
    if (!skipDraftRef.current && !sendingRef.current && t.trim() && !sameBody(t, quote)) {
      return saveReplyDraft(t, docJsonRef.current);
    }
  }
  // Through a ref: cleanup and registration closures outlive their render.
  const flushRef = useRef(flushReplyDraft);
  flushRef.current = flushReplyDraft;

  // Thread switch unmounts this composer (keyed by thread) — flush the draft.
  useEffect(() => {
    return () => {
      void flushRef.current();
    };
  }, []);

  // If the session expires, Reload saves what is open first (best effort).
  useEffect(() => {
    if (!open) return;
    return registerDraftFlush(() => flushRef.current());
  }, [open]);

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
  // Reply as the address the mail was sent to when the reply context names
  // one (shop@, billing@), else the default local part.
  const ccList = (initial.cc ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  // Only on the domain it belongs to: when the reply domain cannot send and
  // the default stands in, "sales" from the original would go out as
  // sales@<default domain>, an address nobody wrote to.
  const domainSwapped = !!initial.fromDomain && fromDomain !== initial.fromDomain;
  const fromLocal =
    (!domainSwapped && sanitizeLocal(initial.fromLocal ?? "")) || identities?.defaultLocal || "hello";

  // Seed the signature only once identities resolve WHICH domain is sending.
  // The reply domain and the sending domain are not always the same — the
  // resolution above falls back to the server default when the original domain
  // cannot send — and seeding the wrong identity's sign-off is worse than
  // seeding none. Same reasoning, and the same value-comparison, as the
  // dialog's seeding effect.
  useEffect(() => {
    if (!open) return;
    const sig = identities?.identities.find((i) => i.domain === fromDomain)?.signature ?? "";
    const desired = bodySeedWithSignature(initial.text ?? "", sig);
    if (desired === seededRef.current) return;
    // Replace only our own seed, never text the user typed. Compared by VALUE
    // rather than a one-shot flag: the identities query is gated on `open`, so
    // the first run can read a stale cache and be corrected a moment later.
    if (userEditedRef.current) return;
    const body = latestRef.current.text;
    if (body.trim() !== "" && !sameBody(body, seededRef.current)) return;
    hasSeededRef.current = true;
    seededRef.current = desired;
    // The unmount flush reads this to tell a seeded body from a written one.
    latestRef.current.quote = desired;
    applyingSeedRef.current = true;
    setText(desired);
    setBodySeed(desired); // editor may not be mounted yet: initialText on mount
    editorRef.current?.setPlainText(desired);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, identities, fromDomain, initial.text]);

  if (!open) {
    return (
      <div className="flex flex-wrap items-stretch gap-2">
        <button
          type="button"
          onClick={() => (onStart ? onStart() : onOpenChange(true))}
          data-testid="inline-reply"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border/70 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 max-md:py-3.5"
        >
          <Reply className="h-4 w-4 shrink-0" />
          <span className="truncate">Reply to {initial.to || "sender"}…</span>
        </button>
        {collapsedActions}
      </div>
    );
  }

  async function doSend() {
    if (sendingRef.current || send.isPending) return;
    sendingRef.current = true;
    setSending(true);
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
    try {
      // mutateAsync, not mutate with per-call callbacks: those are dropped
      // when the component unmounts, which left a sent reply with no toast and
      // its draft row behind.
      await send.mutateAsync({
        from: `${fromLocal}@${fromDomain}`,
        fromLocal,
        to: initial.to ?? "",
        ...(ccList.length ? { cc: ccList } : {}),
        subject: initial.subject ?? "",
        text: bodyText,
        ...(bodyHtml && hasVisibleBody ? { html: bodyHtml } : {}),
        inReplyTo: initial.inReplyTo,
        threadId: initial.threadId,
      });
    } catch {
      sendingRef.current = false;
      if (mountedRef.current) {
        setSending(false);
        toast.error("Send failed");
      } else {
        // Nothing on screen holds the text any more, so keep it as a draft
        // (the unmount flush skipped it while the send was in flight). Say it
        // was saved only once it was: a send that failed for being offline
        // will usually fail to save for the same reason.
        const kept = { text: latestRef.current.text, json: docJsonRef.current };
        if (await saveReplyDraft(kept.text, kept.json)) {
          toast.error("Send failed. Your reply was saved to Drafts.");
        } else if (initial.threadId && stashReply(initial.threadId, kept)) {
          toast.error(
            "Send failed and the draft could not be saved. Your reply is kept on this device. Open the conversation and choose Reply to get it back.",
          );
        } else {
          toast.error("Send failed and your reply could not be saved.");
        }
      }
      return;
    }
    sendingRef.current = false;
    toast.success("Sent ✓");
    dropReplyDraft();
    if (mountedRef.current) {
      setSending(false);
      onOpenChange(false);
    }
  }

  function handleAiDraft() {
    const threadId = initial.threadId;
    if (!threadId) return;
    aiDraft.mutate(threadId, {
      onSuccess: (res) => {
        // A send started while the draft was being written: the body is
        // frozen and on its way out.
        if (sendingRef.current) return;
        // Rebuild from the SIGNED seed, not initial.text: the latter is the
        // bare prefill, so drafting with AI used to silently drop the
        // signature and nothing ever put it back (the seeding effect's deps
        // have not changed, and its guard now reads the body as user-written).
        const quote = initial.text ?? "";
        const sig = identities?.identities.find((i) => i.domain === fromDomain)?.signature ?? "";
        const rest = bodySeedWithSignature(quote, sig);
        const full = rest ? `${res.draft}${rest}` : res.draft;
        // Mirror + mount seed + snapshot reset, same as the dialog: covers the
        // editor chunk mounting after the draft lands, and stops a stale doc
        // snapshot from outliving the replaced body.
        setText(full);
        setBodySeed(full);
        docJsonRef.current = "";
        editorRef.current?.setPlainText(full);
      },
      onError: () => toast.error("Couldn't draft a reply. Try again."),
    });
  }

  const busy = sending || send.isPending;

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      // Not mid-composition (it would send half a word). defaultPrevented is
      // deliberately NOT checked: the editor binds Mod-Enter itself (a hard
      // break) and always prevents it, so honouring that would mean the
      // shortcut never sends from the one place it is used.
      if (composing(e)) return;
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
          Replying to <span className="text-foreground">{initial.to}</span>
          {ccList.length > 0 && (
            <>
              {" "}
              and <span className="text-foreground">{ccList.length} more</span>
            </>
          )}{" "}
          as {fromLocal}@{fromDomain}
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          {onOpenFull && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={HEADER_BUTTON}
              aria-label="Open in full composer"
              // Not mid-send: the dialog would take over the draft row this
              // send is about to delete, and its autosave could write the row
              // back afterwards (a sent mail with a resurrected draft).
              disabled={busy}
              onClick={() => {
                // The dialog takes over this draft row — stop writing to it
                // from here (but don't delete it).
                skipDraftRef.current = true;
                onOpenFull({
                  ...initial,
                  text: text || initial.text,
                  // The quote always travels; whether a signature may still be
                  // seeded is a separate fact. Dropping the quote to say "do
                  // not seed" left the dialog with no idea what the history
                  // was, so its AI draft rebuilt the body from the whole live
                  // text - stacking the user's own words under the draft.
                  replyQuote: initial.replyQuote,
                  signatureApplied: hasSeededRef.current,
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
            className={HEADER_BUTTON}
            aria-label="Discard reply"
            disabled={busy}
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
          key={editorKey}
          ref={editorRef}
          initialText={bodySeed}
          initialJson={bodyJsonSeed || undefined}
          // Frozen while sending: anything typed after Send was pressed is not
          // in the message that went out, and vanished when the send landed.
          readOnly={busy}
          placeholder={isDesktop ? "Write your reply… ( / for blocks, markdown works)" : "Write your reply…"}
          onTextChange={(t) => {
            if (sendingRef.current) return;
            // Any change we did not cause ourselves is the user editing. The
            // mirror alone cannot tell "empty because nothing is seeded yet"
            // from "empty because the user cleared it", and treating the second
            // as the first resurrects a quote they deliberately deleted.
            if (applyingSeedRef.current) applyingSeedRef.current = false;
            else userEditedRef.current = true;
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
          disabled={aiDraft.isPending || !initial.threadId || busy}
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
          disabled={busy}
          className="h-8 gap-1.5 max-md:h-10"
        >
          {busy ? (
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
