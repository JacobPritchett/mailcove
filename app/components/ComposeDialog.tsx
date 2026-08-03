import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Send, X, AlertCircle, Loader2, Sparkles, Trash2, Paperclip } from "lucide-react";
import type { ComposeBodyHandle } from "@/components/EmailBodyEditor";
import {
  checkAttachmentLimits,
  fileToBase64,
  formatBytes,
  type StagedAttachment,
} from "@/lib/attachments";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { useSend, useDraftReply, useIdentities } from "@/lib/queries";
import { ApiError, putDraft, deleteDraft, getContacts } from "@/lib/api";
import { commitRecipients } from "@/lib/recipients";
import type { Contact } from "@/lib/types";
import { docHasVisibleContent } from "@/lib/editorDoc";
import { bodySeedWithSignature, sameBody } from "@/lib/replyContext";
import AnchoredListbox from "@/components/AnchoredListbox";
import { useComposeSuggestion } from "@/lib/useComposeSuggestion";
import { cn } from "@/lib/utils";

/** Default local-part for the From field. */
const FROM_DEFAULT_LOCAL = "hello";
/**
 * Static fallback identity domain, used only until GET /api/identities resolves
 * (or when it fails). The real list of sendable identity domains comes from the
 * server's domain registry; the Worker maps each identity to its authorized
 * Email Sending transport (apex or send.<apex>) — the picker only ever deals in
 * clean apex identities.
 */
const IDENTITY_DOMAIN = "example.com";

// The rich body editor (TipTap-based, with markdown input rules and slash
// commands) rides its own chunk — composing is a deliberate act, so the main
// bundle shouldn't pay for ProseMirror.
const BodyEditor = lazy(() => import("@/components/EmailBodyEditor"));

/**
 * Mirror the Worker's fromLocal sanitization (src/index.ts):
 * `String(b.fromLocal).replace(/[^a-z0-9._-]/gi, "")`. Keep it identical so what
 * the user sees is what the server will actually use.
 */
function sanitizeLocal(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "");
}

/** Reply/forward/draft context used to prefill the form. */
export interface ComposeInitial {
  to?: string;
  subject?: string;
  text?: string;
  inReplyTo?: string;
  threadId?: string;
  /** Identity domain to reply as (the domain the original mail was sent to). */
  fromDomain?: string;
  /** The quoted history, when this prefill IS a reply built by
   *  buildReplyInitial. Absent on a resumed draft or a handoff from the inline
   *  composer, whose `text` is a whole body the user may already have written -
   *  seeding into that would duplicate the signature and, because seeding goes
   *  through setPlainText, replace the rich document with flattened text. */
  replyQuote?: string;
  /** Resume state (opening a saved draft). */
  draftId?: string;
  /** Stringified TipTap document — wins over `text` for the body seed. */
  bodyJson?: string;
  fromLocal?: string;
  fromName?: string;
}

export interface ComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional prefill for reply context; absent → blank compose. */
  initial?: ComposeInitial;
}

/**
 * Shared borderless-field styling so rows read as one calm surface. Body text is
 * 16px on mobile (text-base) so iOS Safari doesn't auto-zoom the viewport when a
 * field is focused; it drops to 14px (text-sm) at ≥md. Mirrors the shadcn
 * Input/Textarea convention.
 */
const FIELD =
  "w-full bg-transparent text-base md:text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none";

export default function ComposeDialog({
  open,
  onOpenChange,
  initial,
}: ComposeDialogProps) {
  const [fromLocal, setFromLocal] = useState(FROM_DEFAULT_LOCAL);
  // null = no explicit pick yet → defaults to the reply context's domain, then
  // the server default. Stored separately so an explicit pick survives re-renders.
  const [fromDomainPick, setFromDomainPick] = useState<string | null>(null);
  // From display name. null = untouched → the selected identity's profile name
  // (so switching domains keeps tracking each identity's saved name until the
  // user types their own).
  const [fromName, setFromName] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [toInput, setToInput] = useState("");
  const [toError, setToError] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  // Plain-text MIRROR of the rich body (kept in sync by the editor's
  // onTextChange) — feeds Smart Compose and the AI-draft quote stacking. The
  // editor document itself is the source of truth at send time.
  const [text, setText] = useState("");
  // What the editor mounts with. Tracked as state (not just initial?.text)
  // because the lazy editor chunk may mount AFTER a body replacement (e.g. an
  // instant AI draft) — the imperative setPlainText would hit a null ref, so
  // the seed must already carry the new body.
  const [bodySeed, setBodySeed] = useState("");
  // Rich-doc seed for draft resume (cleared when an AI draft replaces the body).
  const [bodyJsonSeed, setBodyJsonSeed] = useState("");
  const [bodyFocused, setBodyFocused] = useState(false);
  // Suggestions only make sense (and only append correctly) when the caret is at
  // the very end of the draft — track that so we don't offer/accept mid-edit.
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  const toInputRef = useRef<HTMLInputElement>(null);
  /** Measurement anchor for the portalled suggestion list. */
  const toFieldRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ComposeBodyHandle>(null);

  // Files staged for this message. Held in memory as base64 and shipped in the
  // send body; nothing is uploaded until the message is actually sent, so
  // closing the dialog costs nothing.
  // Recipient suggestions from mail already exchanged. Fetched on demand while
  // typing; failures are silent because this is a convenience, not a dependency.
  const [contactHits, setContactHits] = useState<Contact[]>([]);
  const [contactIndex, setContactIndex] = useState(0);
  const contactSeq = useRef(0);

  useEffect(() => {
    if (!open) {
      setContactHits([]);
      return;
    }
    const q = toInput.trim();
    if (q.length < 2) {
      setContactHits([]);
      return;
    }
    const seq = ++contactSeq.current;
    const t = setTimeout(() => {
      getContacts(q)
        .then((r) => {
          // Ignore a response that a newer keystroke has already superseded.
          if (seq !== contactSeq.current) return;
          setContactHits(r.contacts.filter((c) => !recipients.includes(c.email)));
          setContactIndex(0);
        })
        .catch(() => {
          // Guard the failure path too: an older request that errors after a
          // newer one succeeded would otherwise clear fresh suggestions.
          if (seq === contactSeq.current) setContactHits([]);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [toInput, open, recipients]);

  /** Turn a suggested contact into a recipient chip. */
  function acceptContact(c: Contact) {
    const r = commitRecipients(recipients, c.email, { keepTrailing: false });
    setRecipients(r.recipients);
    setToInput("");
    setToError(null);
    setContactHits([]);
    toInputRef.current?.focus();
  }

  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function addFiles(files: FileList | null) {
    setAttachError(null);
    const picked = Array.from(files ?? []);
    if (!picked.length) return;
    const problem = checkAttachmentLimits(attachments, picked);
    if (problem) {
      setAttachError(problem);
      return;
    }
    try {
      const staged = await Promise.all(
        picked.map(async (f) => ({
          name: f.name,
          type: f.type || "application/octet-stream",
          size: f.size,
          data: await fileToBase64(f),
        })),
      );
      setAttachments((prev) => [...prev, ...staged]);
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : "Could not read that file.");
    }
  }

  function removeAttachment(index: number) {
    setAttachError(null);
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  // ---- Draft autosave ----
  const qc = useQueryClient();
  // The draft row this compose session writes to (created lazily on first save).
  const draftIdRef = useRef<string | null>(null);
  // True once the message was sent or the draft explicitly discarded — the
  // close-flush must not resurrect the deleted row.
  const skipDraftRef = useRef(false);
  // Last serialized editor document. The editor unmounts with the dialog, so
  // the close-flush can't re-serialize — it reuses the last good snapshot
  // instead of clobbering the stored rich doc with "".
  const docJsonRef = useRef("");
  // Autosave queue: saves are CHAINED (each starts only after the previous
  // settled) and deletion joins the same chain — so no PUT, however slow, can
  // land after the DELETE and resurrect the row.
  const savingRef = useRef<Promise<void>>(Promise.resolve());

  const send = useSend();
  const aiDraft = useDraftReply();
  // Only repliable conversations (carry a threadId) can be AI-drafted.
  const canAiDraft = !!initial?.threadId;

  /** Saved signature for a domain, "" when none or identities have not loaded. */
  function signatureFor(domain: string | undefined): string {
    if (!domain) return "";
    return identities?.identities.find((i) => i.domain === domain)?.signature ?? "";
  }

  // Sendable From identities (registry-backed). While the fetch is loading or
  // failed, fall back to the reply context's intended domain (the server still
  // validates, so a non-sendable domain fails loudly with a 400 instead of the
  // mail silently going out under a different identity) or the static default.
  const identities = useIdentities(open).data;
  const domainOptions = identities?.identities.length
    ? identities.identities.map((i) => i.domain)
    : [initial?.fromDomain ?? IDENTITY_DOMAIN];
  // Precedence: explicit pick → reply context's domain → server default → first
  // option. Anything not in the live option list is ignored (e.g. a reply to a
  // domain that can't send).
  const fromDomain =
    [fromDomainPick, initial?.fromDomain, identities?.defaultDomain]
      .find((d) => !!d && domainOptions.includes(d)) ?? domainOptions[0];
  // The selected identity's saved sender name — what recipients see unless the
  // user overrides it for this message.
  const identityName =
    identities?.identities.find((i) => i.domain === fromDomain)?.displayName ?? "";
  const fromNameValue = fromName ?? identityName;

  // Smart Compose: a short AI continuation, offered while the body is focused.
  const { suggestion, clear: clearSuggestion } = useComposeSuggestion(
    subject,
    text,
    open && bodyFocused && caretAtEnd,
  );

  /** Accept the current suggestion, appending it to the draft. */
  function acceptSuggestion() {
    if (!suggestion) return;
    // appendPlainText focuses the document end and syncs the text mirror.
    editorRef.current?.appendPlainText(suggestion);
    clearSuggestion();
  }

  function onBodyKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Tab accepts the suggestion. Capture phase so this wins over the editor's
    // own Tab handling (list indent); Escape is left to the dialog (close).
    if (suggestion && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      acceptSuggestion();
    }
  }

  // Reset fields from `initial` each time the dialog opens. Keyed on open so a
  // re-open with a new reply context refreshes the prefill.
  useEffect(() => {
    if (!open) return;
    setFromLocal(initial?.fromLocal ? sanitizeLocal(initial.fromLocal) || FROM_DEFAULT_LOCAL : FROM_DEFAULT_LOCAL);
    setFromDomainPick(null);
    setFromName(initial?.fromName ? initial.fromName : null);
    const seeded = commitRecipients([], initial?.to ?? "");
    setRecipients(seeded.recipients);
    setToInput("");
    setToError(null);
    setSubject(initial?.subject ?? "");
    setText(initial?.text ?? "");
    textRef.current = initial?.text ?? "";
    seededSigRef.current = "";
    setBodySeed(initial?.text ?? "");
    setBodyJsonSeed(initial?.bodyJson ?? "");
    setBodyFocused(false);
    setCaretAtEnd(true);
    // The dialog stays mounted between sessions, so staged files MUST be cleared
    // here. Otherwise a file attached to one message is still staged when the
    // next compose opens, and would be sent to a recipient the user never chose
    // it for. Clearing only after a successful send would miss the far more
    // common close-without-sending path.
    setAttachments([]);
    setAttachError(null);
    clearSuggestion();
    draftIdRef.current = initial?.draftId ?? null;
    skipDraftRef.current = false;
    docJsonRef.current = initial?.bodyJson ?? "";
    send.reset();
    aiDraft.reset();
    // send is stable; initial only matters at open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Signature seeding lives in its own effect, declared AFTER the [open] reset
  // above, and that ordering is load-bearing twice over:
  //   - the identity list is fetched WHEN the dialog opens, so it is always
  //     undefined during the [open] effect and the signature never appeared;
  //   - on reopen this must run after `text` is cleared, or the "do not
  //     overwrite what the user typed" guard reads the PREVIOUS signature and
  //     bails, so the signature came back only once per page load.
  // In practice this dialog only ever seeds NEW messages: every reply path
  // (the r key, the menu, the reader toolbar) opens the inline composer, and
  // the inline handoff arrives already signed. The reply branch below is kept
  // because `replyQuote` is part of the prefill contract, not because anything
  // currently reaches it - do not read it as live behaviour.
  // Mirrors `text`. An effect sees the render-time value of state, so the
  // [open] reset above is NOT visible to the seeding effect in the same commit
  // - guarding on `text` read the PREVIOUS session's signature and bailed.
  const textRef = useRef("");
  /** Exactly what seeding last wrote: distinguishes our own seed from anything
   *  the user typed, AND lets a stale seed be replaced by a corrected one. */
  const seededSigRef = useRef("");
  useEffect(() => {
    // Deliberately does NOT clear seededSigRef on close: the close-flush reads
    // it to tell "only a signature" from real content, and clearing here made
    // every abandoned compose save a junk draft again. The [open] effect above
    // resets it on the way back in.
    if (!open) return;
    // A prefill that is not a reply carries a body the USER owns (resumed
    // draft, inline handoff). Never seed into that.
    if (initial && initial.replyQuote === undefined) return;
    const quote = initial?.replyQuote ?? "";
    const sig = signatureFor(fromDomain);
    const desired = bodySeedWithSignature(quote, sig);
    if (!desired || desired === seededSigRef.current) return;
    // Compare VALUES rather than using a one-shot flag. The identities query is
    // gated on `open`, so the first run after reopening reads the STALE cache
    // and the refetch lands a moment later; a flag would seed the old signature
    // and then refuse to correct it. Replace only our own seed, never typed text.
    // Compared through sameBody, not string equality: the editor returns a
    // seeded reply WITHOUT its "> " markers, so a raw comparison reads every
    // seeded body as "the user typed this".
    const body = textRef.current;
    const untouched =
      body.trim() === "" ||
      sameBody(body, seededSigRef.current) ||
      // A reply opens holding the bare quote block; that is our seed too, not
      // something the user wrote, so it may be replaced by the signed version.
      sameBody(body, quote);
    if (!untouched) return;
    seededSigRef.current = desired;
    setText(desired);
    textRef.current = desired;
    setBodySeed(desired); // editor not mounted yet: initialText is read on mount
    if (editorRef.current) editorRef.current.setPlainText(desired);
    else {
      // Lazy chunk: on reopen it can mount a tick later still carrying the
      // previous session's text, which the seed prop alone will not replace.
      const t = setTimeout(() => editorRef.current?.setPlainText(desired), 0);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, identities, fromDomain, initial?.replyQuote]);

  /** Anything worth persisting as a draft? */
  function draftHasContent() {
    // A seeded signature is not content the user wrote. Counting it meant every
    // opened-and-abandoned compose saved a draft containing nothing but the
    // signature, and toasted "Draft saved" for it.
    // Compare trimmed: when the editor is already mounted the seed goes through
    // its serializer and comes back with different surrounding whitespace, so
    // exact equality misses it and the junk draft is saved anyway.
    const written = sameBody(text, seededSigRef.current) ? "" : text;
    return !!(written.trim() || subject.trim() || recipients.length || toInput.trim());
  }

  /** Best-effort draft upsert (autosave path — failures stay silent). */
  async function saveDraftNow() {
    if (skipDraftRef.current || !draftHasContent()) return;
    const id = (draftIdRef.current ??= crypto.randomUUID());
    let live = "";
    try {
      live = editorRef.current?.getDocJson() ?? "";
    } catch {
      // editor not mounted — fall back to the last snapshot below
    }
    const bodyJson = live || docJsonRef.current;
    docJsonRef.current = bodyJson;
    // Snapshot the payload now; the chained PUT may start later.
    const payload = {
      to: [...recipients, toInput.trim()].filter(Boolean).join(", "),
      subject,
      bodyText: text,
      bodyJson,
      fromLocal: sanitizeLocal(fromLocal) || FROM_DEFAULT_LOCAL,
      fromDomain,
      ...(fromName !== null ? { fromName: fromName.trim() } : {}),
      threadId: initial?.threadId,
      inReplyTo: initial?.inReplyTo,
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
      // autosave is best-effort; the next tick retries
    }
  }

  /** Delete the backing draft row (sent or discarded) and refresh views. */
  function dropDraft() {
    skipDraftRef.current = true;
    const id = draftIdRef.current;
    draftIdRef.current = null;
    if (!id) return;
    // Join the autosave chain so the DELETE is ordered after EVERY queued PUT.
    void savingRef.current
      .then(() => deleteDraft(id))
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["drafts"] });
        void qc.invalidateQueries({ queryKey: ["counts"] });
      })
      .catch(() => {
        // orphaned row at worst; harmless
      });
  }

  // Debounced autosave while composing.
  useEffect(() => {
    if (!open || !draftHasContent()) return;
    const t = setTimeout(() => void saveDraftNow(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text, subject, recipients, toInput, fromLocal, fromName, fromDomain]);

  // Closing the dialog (any way except send/discard) keeps the draft: flush a
  // final save so nothing typed after the last debounce tick is lost.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      // Closing via X / Close / Escape keeps the draft — surface that so the
      // saved draft isn't a surprise. Not shown on send/discard (they toast
      // their own outcome) or when there's nothing worth saving.
      const keptDraft = draftHasContent() && !skipDraftRef.current;
      void saveDraftNow();
      if (keptDraft) toast.success("Draft saved");
    }
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function discardDraft() {
    dropDraft();
    toast.success("Draft discarded");
    onOpenChange(false);
  }

  /** Fold whatever is typed in the To input into chips. */
  function flushToInput(raw: string, keepTrailing: boolean) {
    const r = commitRecipients(recipients, raw, { keepTrailing });
    setRecipients(r.recipients);
    setToInput(keepTrailing ? r.remainder : "");
    setToError(
      r.invalid.length ? `Not a valid email: ${r.invalid.join(", ")}` : null,
    );
    return r;
  }

  function onToChange(e: React.ChangeEvent<HTMLInputElement>) {
    // Live parse: commit delimiter-terminated tokens, keep the trailing fragment
    // in the field so the user can keep typing.
    flushToInput(e.target.value, true);
  }

  function onToKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Let the form-level ⌘/Ctrl+Enter handler send instead of adding a chip.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") return;
    // Suggestion navigation takes precedence while the list is open, so Enter
    // accepts the highlighted contact instead of committing the raw fragment.
    if (contactHits.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setContactIndex((i) => (i + 1) % contactHits.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setContactIndex((i) => (i - 1 + contactHits.length) % contactHits.length);
        return;
      }
      if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        acceptContact(contactHits[contactIndex]);
        return;
      }
    }
    if (e.key === "Enter" || e.key === ";" || e.key === ",") {
      e.preventDefault();
      flushToInput(toInput, false);
    } else if (e.key === "Backspace" && toInput === "" && recipients.length) {
      e.preventDefault();
      setRecipients((r) => r.slice(0, -1));
    }
  }

  function removeRecipient(addr: string) {
    setRecipients((r) => r.filter((a) => a !== addr));
    toInputRef.current?.focus();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (send.isPending) return;
    // Commit any trailing typed text (fully validated — a half-typed address
    // must not silently ship) before deciding whether we can send.
    const r = flushToInput(toInput, false);
    if (r.invalid.length) return; // notice already shown; let them fix it
    if (r.recipients.length === 0) {
      setToError("Add at least one recipient");
      toInputRef.current?.focus();
      return;
    }
    void submitTo(r.recipients);
  }

  async function submitTo(recipients: string[]) {
    const cleanedLocal = sanitizeLocal(fromLocal) || FROM_DEFAULT_LOCAL;
    // Only an explicit edit ships as an override. Untouched (or cleared) →
    // omit, so the Worker resolves the identity's CURRENT profile name rather
    // than freezing a possibly-stale cached prefill into the message.
    const cleanedName = fromName === null ? "" : fromName.trim();
    // Serialize the rich document to email-ready HTML + plaintext. If the
    // editor chunk isn't mounted (still loading / failed), fall back to the
    // plain mirror — sending must never be blocked by the editor.
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
    // Ship HTML when the body has visible content — including rich bodies
    // whose PLAINTEXT serialization is empty (an image, a divider, a button).
    // An actually-empty doc still serializes to a full blank template; that
    // one we drop.
    const hasVisibleBody = bodyText.trim() !== "" || docHasVisibleContent(docJson);
    send.mutate(
      {
        // Full identity address; the Worker resolves it against the registry.
        // fromLocal rides along for back-compat with the legacy default path.
        from: `${cleanedLocal}@${fromDomain}`,
        fromLocal: cleanedLocal,
        ...(cleanedName ? { fromName: cleanedName } : {}),
        to: recipients,
        subject,
        text: bodyText,
        ...(bodyHtml && hasVisibleBody ? { html: bodyHtml } : {}),
        inReplyTo: initial?.inReplyTo,
        threadId: initial?.threadId,
        ...(attachments.length
          ? {
              attachments: attachments.map((a) => ({
                filename: a.name,
                type: a.type,
                data: a.data,
              })),
            }
          : {}),
      },
      {
        onSuccess: () => {
          toast.success("Sent ✓");
          dropDraft();
          onOpenChange(false);
        },
        onError: () => {
          toast.error("Send failed");
        },
      },
    );
  }

  // Ask Workers AI to draft a reply, then place it above the quoted original
  // (kept from `initial.text` so re-drafting never stacks the quote).
  function handleAiDraft() {
    const threadId = initial?.threadId;
    if (!threadId) return;
    aiDraft.mutate(threadId, {
      onSuccess: (res) => {
        const quote = initial?.text ?? "";
        const full = quote ? `${res.draft}\n\n${quote}` : res.draft;
        // Replace everywhere: the mounted editor (setPlainText), the mirror,
        // and the mount seed (covers the editor chunk mounting later). The
        // rich-doc seed AND the autosave snapshot are now stale — drop both so
        // neither a remount nor a close-flush resurrects the old body.
        // (If the editor is mounted, setPlainText → onTextChange re-snapshots.)
        setText(full);
        setBodySeed(full);
        setBodyJsonSeed("");
        docJsonRef.current = "";
        editorRef.current?.setPlainText(full);
      },
      onError: () => toast.error("Couldn't draft a reply — try again."),
    });
  }

  // ⌘/Ctrl+Enter sends from anywhere in the form (including the body textarea).
  function onFormKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  const errorMsg =
    send.error instanceof ApiError
      ? send.error.message
      : send.error instanceof Error
        ? send.error.message
        : null;

  const isReply = !!initial?.inReplyTo || !!initial?.threadId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // Radix registers its Escape handler on `document` with capture, so a
        // React onKeyDown (bubble, on #root) can never preventDefault in time.
        // Escape used to close the whole compose window instead of the dropdown.
        onEscapeKeyDown={(e) => {
          if (contactHits.length) {
            e.preventDefault();
            setContactHits([]);
          }
        }}
        className="flex max-h-[100dvh] flex-col gap-0 overflow-hidden rounded-2xl border-border/70 p-0 shadow-2xl max-md:h-[100dvh] max-md:max-w-full max-md:rounded-none max-md:border-0 sm:max-w-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
          <div className="flex items-center gap-3">
            <span
              className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-sm"
              aria-hidden
            >
              <Send className="size-4" />
            </span>
            <div className="leading-tight">
              <DialogTitle className="text-base font-semibold">
                {isReply ? "Reply" : "New message"}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Replies come back to your inbox
              </DialogDescription>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="size-8 text-muted-foreground"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* Subtle gradient hairline */}
        <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />

        <form
          onSubmit={handleSubmit}
          onKeyDown={onFormKeyDown}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {/* To — recipient chips */}
          <div className="flex items-start gap-3 border-b border-border/60 px-5 py-3">
            <label
              htmlFor="compose-to"
              className="w-12 shrink-0 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              To
            </label>
            <div
              ref={toFieldRef}
              // The suggestion list is portalled out of this subtree (two
              // clipping ancestors would cut it off), so this is its
              // measurement anchor rather than a positioning context.
              className="flex flex-1 cursor-text flex-wrap items-center gap-1.5"
              onClick={() => toInputRef.current?.focus()}
            >
              {recipients.map((addr) => (
                <span
                  key={addr}
                  className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pl-2.5 pr-1 text-xs font-medium text-foreground"
                >
                  {addr}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecipient(addr);
                    }}
                    aria-label={`Remove ${addr}`}
                    className="flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <input
                ref={toInputRef}
                id="compose-to"
                value={toInput}
                onChange={onToChange}
                onKeyDown={onToKeyDown}
                onBlur={() => flushToInput(toInput, false)}
                type="text"
                inputMode="email"
                autoComplete="off"
                placeholder={recipients.length ? "" : "someone@example.com"}
                aria-label="Add recipient"
                // Combobox wiring: without aria-activedescendant, arrowing the
                // list moves a visual highlight only and a screen reader
                // announces nothing, so a blind user would press Enter on an
                // address they were never told.
                role="combobox"
                aria-expanded={contactHits.length > 0}
                aria-controls="contact-suggestions"
                aria-autocomplete="list"
                aria-activedescendant={
                  contactHits.length ? `contact-option-${contactIndex}` : undefined
                }
                aria-invalid={!!toError}
                aria-describedby={toError ? "compose-to-error" : undefined}
                className={cn(FIELD, "min-w-[8rem] flex-1 py-1")}
              />
              {contactHits.length > 0 && (
                <AnchoredListbox
                  anchorRef={toFieldRef}
                  id="contact-suggestions"
                  role="listbox"
                  aria-label="Recipient suggestions"
                  className="z-50 overflow-y-auto rounded-lg border border-border/60 bg-popover py-1 shadow-md"
                >
                  {contactHits.map((c, i) => (
                    // role=option sits on the li so the listbox owns its
                    // options directly. Focus stays in the input; selection is
                    // conveyed by aria-activedescendant.
                    <li
                      key={c.email}
                      id={`contact-option-${i}`}
                      role="option"
                      aria-selected={i === contactIndex}
                      // Commit on mouseDown: blur would otherwise flush the
                      // typed fragment into a chip before the click lands.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptContact(c);
                      }}
                      onMouseEnter={() => setContactIndex(i)}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-sm",
                        i === contactIndex ? "bg-accent" : "bg-transparent",
                      )}
                    >
                      {c.name && <span className="truncate font-medium">{c.name}</span>}
                      <span className="truncate text-muted-foreground">{c.email}</span>
                    </li>
                  ))}
                </AnchoredListbox>
              )}

              {/* Recipient validation lives right under the field it's about,
                  not in the shared error block by the footer. */}
              {toError && (
                <p
                  id="compose-to-error"
                  role="alert"
                  className="flex w-full items-center gap-1.5 pt-1 text-xs text-destructive"
                >
                  <AlertCircle className="size-3.5 shrink-0" />
                  {toError}
                </p>
              )}
            </div>
          </div>

          {/* From — editable local part + readonly identity suffix */}
          <div className="flex items-center gap-3 border-b border-border/60 px-5 py-3">
            <label
              htmlFor="compose-from"
              className="w-12 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              From
            </label>
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              {/* Display name — prefilled from the identity's sending profile;
                  editable per message. Empty falls back server-side. */}
              <input
                id="compose-from-name"
                value={fromNameValue}
                onChange={(e) => setFromName(e.target.value)}
                placeholder="Name"
                aria-label="From name"
                size={Math.min(Math.max(fromNameValue.length, 4), 20)}
                className={cn(FIELD, "w-auto min-w-0 shrink")}
              />
              <input
                id="compose-from"
                value={fromLocal}
                onChange={(e) => setFromLocal(e.target.value)}
                onBlur={() =>
                  setFromLocal((v) => sanitizeLocal(v) || FROM_DEFAULT_LOCAL)
                }
                aria-label="From local part"
                // Content-sized (via size) for the natural "name@domain" read, but
                // min-w-0 with default flex-shrink lets a long/pasted local part
                // shrink into the row instead of pushing it past the @domain suffix.
                size={Math.min(Math.max(fromLocal.length, 4), 24)}
                className={cn(FIELD, "w-auto min-w-0 text-right font-medium")}
              />
              {domainOptions.length > 1 ? (
                <select
                  value={fromDomain}
                  onChange={(e) => setFromDomainPick(e.target.value)}
                  aria-label="From domain"
                  // Borderless like the rest of the row; shrink (not shrink-0) so a
                  // long domain can't push the row past the dialog edge.
                  className="min-w-0 shrink cursor-pointer appearance-none bg-transparent text-base text-muted-foreground focus:outline-none md:text-sm"
                >
                  {domainOptions.map((d) => (
                    <option key={d} value={d}>
                      @{d}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="shrink-0 text-sm text-muted-foreground">
                  @{fromDomain}
                </span>
              )}
            </div>
          </div>

          {/* Subject */}
          <div className="flex items-center gap-3 border-b border-border/60 px-5 py-3">
            <label
              htmlFor="compose-subject"
              className="w-12 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Subj
            </label>
            <input
              id="compose-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              aria-label="Subject"
              className={cn(FIELD, "py-0.5 font-medium")}
            />
          </div>

          {/* Body — rich editor (markdown input rules, "/" slash commands). */}
          <div className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={onBodyKeyDown}>
            {canAiDraft && (
              <div className="flex items-center justify-end px-3 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleAiDraft}
                  disabled={aiDraft.isPending}
                  className="h-7 gap-1.5 text-xs text-muted-foreground"
                >
                  {aiDraft.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                  {aiDraft.isPending ? "Drafting…" : "Draft with AI"}
                </Button>
              </div>
            )}
            <Suspense
              fallback={
                <div className="min-h-48 flex-1 px-5 py-4 text-sm text-muted-foreground/60">
                  Loading editor…
                </div>
              }
            >
              <BodyEditor
                ref={editorRef}
                initialText={bodySeed}
                initialJson={bodyJsonSeed || undefined}
                placeholder="Write your message… ( / for blocks, markdown works)"
                onTextChange={(t) => {
                  setText(t);
                  textRef.current = t;
                  // Keep the doc snapshot fresh — the close-flush persists it
                  // after the editor has unmounted.
                  try {
                    docJsonRef.current = editorRef.current?.getDocJson() || docJsonRef.current;
                  } catch {
                    // keep the previous snapshot
                  }
                }}
                onFocusChange={(focused) => {
                  setBodyFocused(focused);
                  if (!focused) clearSuggestion();
                }}
                onCaretAtEndChange={setCaretAtEnd}
                className="min-h-48 flex-1 overflow-y-auto px-5 py-4 text-base leading-relaxed md:text-sm"
              />
            </Suspense>
            {suggestion && (
              <div className="mx-5 mb-3 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm">
                <Sparkles className="size-3.5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  <span className="text-foreground/90">…{suggestion.trim()}</span>
                </span>
                {/* onMouseDown + preventDefault keeps textarea focus so the blur
                    handler doesn't clear the suggestion before the click lands. */}
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptSuggestion();
                  }}
                  className="shrink-0 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20"
                >
                  Tab
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    clearSuggestion();
                  }}
                  aria-label="Dismiss suggestion"
                  className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* Send error (recipient errors render inline under the To field).
              Suppressed while a recipient error is showing so only one alert
              announces at a time — the inline To error is the actionable one,
              since a bad recipient blocks sending anyway. */}
          {errorMsg && !toError && (
            <div
              role="alert"
              className="mx-5 mb-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {(attachments.length > 0 || attachError) && (
            <div className="mx-5 mb-3 space-y-2">
              {attachments.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {attachments.map((a, i) => (
                    <li
                      key={`${a.name}-${i}`}
                      className="flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs"
                    >
                      <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate" title={a.name}>{a.name}</span>
                      <span className="shrink-0 text-muted-foreground">{formatBytes(a.size)}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(i)}
                        aria-label={`Remove ${a.name}`}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {attachments.length > 0 && (
                // Draft autosave persists text and recipients, not files. Say so
                // rather than letting someone reopen a draft and find them gone.
                <p className="text-xs text-muted-foreground/70">
                  Files are sent with this message but are not saved in drafts.
                </p>
              )}
              {attachError && (
                <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{attachError}</span>
                </p>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <span className="flex items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  void addFiles(e.target.files);
                  // Reset so picking the same file twice still fires onChange.
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={send.isPending}
                aria-label="Attach files"
                className="gap-1.5 text-xs text-muted-foreground max-md:h-11"
              >
                <Paperclip className="size-3.5" />
                Attach
              </Button>
              <span className="flex items-center gap-1 text-xs text-muted-foreground max-md:hidden">
                <Kbd>⌘</Kbd>
                <Kbd>↵</Kbd>
                <span className="ml-1">to send</span>
              </span>
              {(draftHasContent() || draftIdRef.current) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={discardDraft}
                  disabled={send.isPending}
                  className="gap-1.5 text-xs text-muted-foreground max-md:h-11"
                >
                  <Trash2 className="size-3.5" />
                  Discard
                </Button>
              )}
            </span>
            <div className="flex items-center gap-2 max-md:w-full max-md:justify-end">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={send.isPending}
                className="max-md:h-11"
              >
                Close
              </Button>
              <Button
                type="submit"
                disabled={send.isPending}
                className="gap-2 bg-gradient-to-b from-primary to-primary/90 shadow-sm max-md:h-11"
              >
                {send.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  <>
                    <Send className="size-4" />
                    Send
                  </>
                )}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Small keycap for the keyboard hint. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.25rem] items-center justify-center rounded border border-border bg-muted px-1 py-0.5 font-sans text-[0.7rem] leading-none text-muted-foreground">
      {children}
    </kbd>
  );
}
