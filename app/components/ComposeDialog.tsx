import { DraftSaveStatus, SendTiming, type SaveState } from "@/components/ComposeFeedback";
import { keepRecovery, clearRecovery } from "@/lib/draftRecovery";
import { sendFeedback } from "@/lib/sendFeedback";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Send, X, AlertCircle, Loader2, Sparkles, Trash2, Paperclip } from "lucide-react";
import type { ComposeBodyHandle } from "@/components/EmailBodyEditor";
import {
  checkAttachmentLimits,
  fileToBase64,
  formatBytes,
  MAX_ATTACHMENTS,
  planForward,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
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
import {
  putDraft,
  deleteDraft,
  getContacts,
  putDraftAttachments,
  getDraftAttachments,
  getAttachmentBase64,
} from "@/lib/api";
import { commitRecipients } from "@/lib/recipients";
import { RecipientField, type RecipientFieldHandle } from "@/components/RecipientField";
import type { Contact, SendPayload } from "@/lib/types";
import { docHasVisibleContent } from "@/lib/editorDoc";
import { bodySeedWithSignature, sameBody } from "@/lib/replyContext";
import AnchoredListbox from "@/components/AnchoredListbox";
import { useComposeSuggestion } from "@/lib/useComposeSuggestion";
import { cn } from "@/lib/utils";
import { registerDraftFlush } from "@/lib/session";
import { useIsDesktop } from "@/lib/useMediaQuery";
import { sanitizeLocal } from "@/lib/identity";
import type { ForwardPart } from "@/lib/conversation";
import { composing, keyIsSpokenFor } from "@/lib/keys";
import { canHold, holdSend, undoSendSeconds } from "@/lib/outbox";

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


/** Reply/forward/draft context used to prefill the form. */
export interface ComposeInitial {
  to?: string;
  /** Comma-joined, like `to`. Either one present opens its row. */
  cc?: string;
  bcc?: string;
  /** Files of a forwarded message, fetched and staged when the dialog opens,
   *  and the names of the ones that were never stored and so cannot travel. */
  forward?: { messageId: string; parts: ForwardPart[]; notStored?: string[] };
  /** Everything in this prefill was generated (a forward, a mailto: link):
   *  closed without the user changing anything, it is not worth keeping as a
   *  draft. */
  generated?: boolean;
  subject?: string;
  text?: string;
  inReplyTo?: string;
  threadId?: string;
  /** Identity domain to reply as (the domain the original mail was sent to). */
  fromDomain?: string;
  /** The quoted history, whenever this prefill is a reply — including one
   *  handed over from the inline composer. `text` is NOT a substitute: on a
   *  handoff it is the whole live body (the user's words, their signature and
   *  the quote), and on a resumed draft it is everything they ever wrote.
   *  Anything that wants "just the history" has to read this. */
  replyQuote?: string;
  /** The signature is already in `text`. Separate from `replyQuote` because
   *  they answer different questions — "what is the quoted history?" and "may a
   *  signature still be seeded into this body?" — and conflating them meant the
   *  only way to say no to the second was to lie about the first, which is what
   *  starved the AI-draft path of the quote.
   *
   *  Not load-bearing today: the "untouched" check below independently refuses
   *  to seed over a body that differs from the seed, and a handed-off body
   *  always does. Kept because it states the intent directly rather than
   *  leaving it to a coincidence of that comparison. */
  signatureApplied?: boolean;
  /** Resume state (opening a saved draft). */
  draftId?: string;
  /** Stringified TipTap document — wins over `text` for the body seed. */
  bodyJson?: string;
  fromLocal?: string;
  fromName?: string;
  recoveryAttachments?: StagedAttachment[];
  recoveryPendingAttachments?: StagedAttachment[];
}

export interface ComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional prefill for reply context; absent → blank compose. */
  initial?: ComposeInitial;
  /**
   * Open this dialog again with a prefill, after it has closed. Undo send
   * needs it to put a held message back; without it nothing is held and Send
   * goes out at once.
   */
  onReopen?: (initial: ComposeInitial) => void;
}

/**
 * Shared borderless-field styling so rows read as one calm surface. Body text is
 * 16px on mobile (text-base) so iOS Safari doesn't auto-zoom the viewport when a
 * field is focused; it drops to 14px (text-sm) at ≥md. Mirrors the shadcn
 * Input/Textarea convention.
 */
const FIELD =
  "w-full bg-transparent text-base md:text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none";

/** State owned by one opening of the dialog; see sessionRef. */
interface Session {
  /** The draft row this session writes to (created lazily on first save). */
  draftId: string | null;
  /** True once the message was sent or the draft explicitly discarded — the
   *  close-flush must not resurrect the deleted row. */
  skip: boolean;
  /** Autosave queue: saves are CHAINED (each starts only after the previous
   *  settled) and deletion joins the same chain — so no PUT, however slow, can
   *  land after the DELETE and resurrect the row. */
  saving: Promise<void>;
  /** Set synchronously when a send is accepted. `send.isPending` only flips
   *  once mutate() runs, which is after the body has been serialized (an
   *  await), so a second Cmd+Enter or a double tap in that gap sent twice. */
  sending: boolean;
  /** Signature of the attachment set last written to R2, so an unchanged set
   *  is never re-uploaded on an ordinary body autosave. */
  syncedAtt: string;
  /** The user chose to discard stored files that could not be loaded: the next
   *  save writes the staged set even if it looks unchanged (or is empty). */
  forceAttSync: boolean;
  /** Opened from a saved draft, whose stored files must be read before the
   *  set may be written (a forward has nothing stored to protect). */
  resumed: boolean;
  /** A forward's files on their way down. Resolves, never rejects, to the ones
   *  that arrived. A draft saved before then waits on this for its files. */
  forwardLoad: Promise<StagedAttachment[]> | null;
  /** The user added or removed a file themselves. */
  filesTouched: boolean;
  saveRevision?: string;
}

function newSession(draftId: string | null): Session {
  return {
    draftId,
    skip: false,
    saving: Promise.resolve(),
    sending: false,
    syncedAtt: "",
    forceAttSync: false,
    resumed: draftId !== null,
    forwardLoad: null,
    filesTouched: false,
  };
}

export default function ComposeDialog({
  open,
  onOpenChange,
  initial,
  onReopen,
}: ComposeDialogProps) {
  // The slash-menu tip in the body placeholder is for a keyboard; on a phone
  // it only crowds the line.
  const wideEnoughForTip = useIsDesktop();
  const [needsImmediate, setNeedsImmediate] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
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
  // Cc and Bcc stay out of the way until asked for (or until a reply-all or a
  // resumed draft brings recipients for them).
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [ccPending, setCcPending] = useState("");
  const [bccPending, setBccPending] = useState("");
  const ccRef = useRef<RecipientFieldHandle>(null);
  const bccRef = useRef<RecipientFieldHandle>(null);
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
  // A resumed draft's files come back in a separate fetch. Until it settles the
  // staged list is NOT the whole set, so sending would ship without them (and
  // then delete the draft that held them) and syncing would overwrite them.
  // "failed" stays blocking for the same reason: the stored files are still
  // there, we just could not read them.
  const [attLoad, setAttLoadState] = useState<"idle" | "loading" | "failed">("idle");
  // Mirror for the async paths (autosave chain, close-flush) whose closures
  // were created before the fetch settled.
  const attLoadRef = useRef<"idle" | "loading" | "failed">("idle");
  function setAttLoad(next: "idle" | "loading" | "failed") {
    attLoadRef.current = next;
    setAttLoadState(next);
  }

  /** Pull a resumed draft's stored files back into the staged list. Scoped to
   *  the session that asked: a fetch from an earlier opening of this
   *  (permanently mounted) dialog must never stage files into, or release the
   *  loading gate of, a later one. The draft id cannot tell them apart, since
   *  the same draft can be closed and reopened mid-fetch. */
  function loadDraftAttachments(resumeId: string, s: Session) {
    setAttLoad("loading");
    getDraftAttachments(resumeId)
      .then(({ attachments: got }) => {
        if (sessionRef.current !== s) return; // dialog moved on
        // Merge, never replace: anything already staged was added while this
        // fetch was in flight and must survive it.
        setAttachments((prev) => [...got, ...prev]);
        // Mark only the fetched files as already stored, so an unchanged set
        // is not re-uploaded but one the user added to still is.
        s.syncedAtt = got.map((a) => `${a.name}:${a.size}`).join("|");
        setAttLoad("idle");
      })
      .catch(() => {
        if (sessionRef.current !== s) return;
        setAttLoad("failed");
      });
  }

  // What a forward could not bring along, each reason in its own words, and
  // the files whose download failed (those can be retried).
  const [fwdNotes, setFwdNotes] = useState<string[]>([]);
  const [fwdFailed, setFwdFailed] = useState<ForwardPart[]>([]);

  /**
   * Fetch a forwarded message's files and stage them. Each file stands alone:
   * one that fails to download is reported (and can be retried) while the
   * others are attached. `only` retries just the failed ones.
   */
  function loadForwardAttachments(fwd: NonNullable<ComposeInitial["forward"]>, s: Session, only?: ForwardPart[]) {
    let wanted = only;
    if (!wanted) {
      // Decide what fits BEFORE fetching: a file that cannot be sent is not
      // worth downloading, and the user should be told it was left behind.
      const plan = planForward(fwd.parts);
      wanted = plan.fits;
      const list = (names: string[]) => names.join(", ");
      setFwdNotes([
        ...(fwd.notStored?.length ? [`Not stored with the original, so not forwarded: ${list(fwd.notStored)}`] : []),
        ...(plan.tooLarge.length
          ? [`Too large to send (${formatBytes(MAX_ATTACHMENT_BYTES)} a file, ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} in all), so not forwarded: ${list(plan.tooLarge)}`]
          : []),
        ...(plan.tooMany.length ? [`Over the limit of ${MAX_ATTACHMENTS} files, so not forwarded: ${list(plan.tooMany)}`] : []),
      ]);
    }
    setFwdFailed([]);
    if (!wanted.length) return setAttLoad("idle");
    setAttLoad("loading");
    const parts = wanted;
    const settled = Promise.allSettled(
      parts.map(async (part) => ({
        name: part.name,
        type: part.type || "application/octet-stream",
        size: part.size,
        data: await getAttachmentBase64(fwd.messageId, part.name, part.partId),
      })),
    );
    const got = settled.then((results) =>
      results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
    );
    // A draft saved while this is in flight waits on it for its files (see
    // the close-flush). Chained, so a retry adds to what an earlier load got.
    const before = only ? (s.forwardLoad ?? Promise.resolve([])) : Promise.resolve([]);
    s.forwardLoad = before.then(async (earlier) => [...earlier, ...(await got)]);
    void settled.then((results) => {
      if (sessionRef.current !== s) return; // dialog moved on
      const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = parts.filter((_, i) => results[i].status === "rejected");
      if (ok.length) setAttachments((prev) => [...ok, ...prev]);
      setFwdFailed(failed);
      setAttLoad(failed.length ? "failed" : "idle");
    });
  }

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
      sessionRef.current.filesTouched = true;
      setAttachments((prev) => [...prev, ...staged]);
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : "Could not read that file.");
    }
  }

  function removeAttachment(index: number) {
    sessionRef.current.filesTouched = true;
    setAttachError(null);
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  // ---- Draft autosave ----
  const qc = useQueryClient();
  // Everything that belongs to ONE opening of the dialog lives on a session
  // object, replaced on every open. The dialog is permanently mounted and a
  // send, a save or a fetch can outlive the opening that started it; when
  // these were plain refs, a send finishing after the next draft had been
  // opened read the NEW draft's id and deleted it. Async work captures its
  // session up front and acts on that, and touches the UI only if it is still
  // the active one.
  const sessionRef = useRef<Session>(newSession(null));
  // Last serialized editor document. The editor unmounts with the dialog, so
  // the close-flush can't re-serialize — it reuses the last good snapshot
  // instead of clobbering the stored rich doc with "".
  const docJsonRef = useRef("");

  const send = useSend();
  // Mirrors session.sending for rendering.
  const [sending, setSending] = useState(false);
  // Why this session's last send failed. Held here rather than read from the
  // mutation, which would also report a failure of an earlier session's send.
  const [sendError, setSendError] = useState<string | null>(null);
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
  // A prefilled local part belongs to the domain it came with ("sales" on a
  // domain that only receives). Once the identities show that domain cannot
  // send and another stands in, the local part goes back to the default too:
  // otherwise the message leaves as sales@<some other domain>, an address
  // nobody wrote to. Left alone if the user has already typed their own.
  useEffect(() => {
    if (!open || !identities || !initial?.fromDomain || !initial.fromLocal) return;
    if (identities.identities.some((i) => i.domain === initial.fromDomain)) return;
    const prefilled = sanitizeLocal(initial.fromLocal) || FROM_DEFAULT_LOCAL;
    setFromLocal((cur) => (cur === prefilled ? sanitizeLocal(identities.defaultLocal) || FROM_DEFAULT_LOCAL : cur));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, identities]);

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
    setSaveState("idle");
    setNeedsImmediate(false);
    setFromDomainPick(null);
    setFromName(initial?.fromName ? initial.fromName : null);
    const seeded = commitRecipients([], initial?.to ?? "");
    setRecipients(seeded.recipients);
    setToInput("");
    setToError(null);
    const seededCc = commitRecipients([], initial?.cc ?? "").recipients;
    const seededBcc = commitRecipients([], initial?.bcc ?? "").recipients;
    setCc(seededCc);
    setBcc(seededBcc);
    setShowCc(seededCc.length > 0);
    setShowBcc(seededBcc.length > 0);
    setCcPending("");
    setBccPending("");
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
    setAttachments(initial?.recoveryPendingAttachments ?? []);
    setAttachError(null);
    setFwdNotes([]);
    setFwdFailed([]);
    clearSuggestion();
    const session = newSession(initial?.draftId ?? null);
    sessionRef.current = session;
    // Resume: pull the bytes back so the files are really there to send, not
    // just listed. The draft still opens if this fails, but Send and the
    // attachment sync wait on it (see attLoad).
    const resumeId = initial?.draftId;
    if (initial?.recoveryAttachments) {
      setAttachments(initial.recoveryAttachments);
      session.forceAttSync = true;
      setAttLoad("idle");
    } else if (resumeId) loadDraftAttachments(resumeId, session);
    // A forward brings the original's files. Only on a fresh forward: once it
    // has been saved as a draft, the draft holds them.
    else if (initial?.forward) loadForwardAttachments(initial.forward, session);
    else setAttLoad("idle");
    docJsonRef.current = initial?.bodyJson ?? "";
    setSending(false);
    setSendError(null);
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
    if (initial && (initial.replyQuote === undefined || initial.signatureApplied)) return;
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

  /**
   * A generated prefill (a forward) exactly as it was opened: the original's
   * text, its subject and its files, with nothing added by the user.
   */
  function untouchedPrefill() {
    if (!initial?.generated || sessionRef.current.resumed || sessionRef.current.filesTouched) return false;
    const opened = (list?: string) => commitRecipients([], list ?? "").recipients.join(",");
    return (
      // As opened, or as opened plus the signature seeded into an empty body.
      (sameBody(text, initial.text ?? "") || (!initial.text && sameBody(text, seededSigRef.current))) &&
      subject === (initial.subject ?? "") &&
      recipients.join(",") === opened(initial.to) &&
      !toInput.trim() &&
      // The copies it was opened with (a mailto: link can name some), no more.
      cc.join(",") === opened(initial.cc) &&
      bcc.join(",") === opened(initial.bcc) &&
      !ccPending.trim() &&
      !bccPending.trim()
    );
  }

  /** Anything worth persisting as a draft? */
  function draftHasContent() {
    // Opening a forward and closing it again is not writing a message.
    if (untouchedPrefill()) return false;
    // A seeded signature is not content the user wrote. Counting it meant every
    // opened-and-abandoned compose saved a draft containing nothing but the
    // signature, and toasted "Draft saved" for it.
    // Compare trimmed: when the editor is already mounted the seed goes through
    // its serializer and comes back with different surrounding whitespace, so
    // exact equality misses it and the junk draft is saved anyway.
    const written = sameBody(text, seededSigRef.current) ? "" : text;
    // A staged file is content too: without this, attaching one and closing
    // saved no draft, so the file had nowhere to be stored and was lost.
    return !!(
      written.trim() ||
      subject.trim() ||
      recipients.length ||
      toInput.trim() ||
      cc.length ||
      bcc.length ||
      ccPending.trim() ||
      bccPending.trim() ||
      attachments.length
    );
  }

  /**
   * Draft upsert with a local recovery copy and visible save state. Resolves
   * to whether this save reached the server, for the one caller that cannot
   * go on without it (holding a sent message, see submitTo).
   */
  async function saveDraftNow(opts: { waitForForward?: boolean } = {}): Promise<boolean> {
    const s = sessionRef.current;
    // Closing while a forward's files are still downloading: the draft is
    // written now and its files follow when they arrive, rather than a draft
    // that has quietly lost them.
    const lateFiles = opts.waitForForward && attLoadRef.current === "loading" ? s.forwardLoad : null;
    // A pending "discard the stored files" still has to be written even when
    // nothing else is left in the draft.
    if (s.skip || (!draftHasContent() && !s.forceAttSync)) return false;
    const id = (s.draftId ??= crypto.randomUUID());
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
      cc: [...cc, ccPending.trim()].filter(Boolean).join(", "),
      bcc: [...bcc, bccPending.trim()].filter(Boolean).join(", "),
      subject,
      bodyText: text,
      bodyJson,
      fromLocal: sanitizeLocal(fromLocal) || FROM_DEFAULT_LOCAL,
      fromDomain,
      ...(fromName !== null ? { fromName: fromName.trim() } : {}),
      threadId: initial?.threadId,
      inReplyTo: initial?.inReplyTo,
    };
    // Signature of the staged set. The bytes ride only when this changes, so
    // the 1.5s autosave stays a small JSON PUT no matter what is attached.
    const attSig = attachments.map((a) => `${a.name}:${a.size}`).join("|");
    // Never while the stored set is unread: the staged list is missing those
    // files, and this PUT replaces the whole set.
    // (A forward whose download partly failed has nothing stored to protect:
    // what did arrive is the set.)
    const readable = attLoadRef.current === "idle" || (attLoadRef.current === "failed" && !s.resumed);
    const attChanged = !lateFiles && readable && (s.forceAttSync || attSig !== s.syncedAtt);
    const attSnapshot = attachments.map((a) => ({ name: a.name, type: a.type, data: a.data }));

    const revision = crypto.randomUUID();
    s.saveRevision = revision;
    setSaveState("saving");
    const local = keepRecovery({ id, revision, updated: Date.now(), payload,
      attachments: readable && !lateFiles ? [...attachments] : null,
      ...(!readable || lateFiles ? { pendingAttachments: [...attachments] } : {}) });
    const save = s.saving.then(() =>
      putDraft(id, payload)
        .then(async () => {
          // After the row exists: a draft row with no attachments is merely
          // incomplete, whereas R2 bytes with no row are an orphan nobody will
          // ever collect.
          if (attChanged) {
            await putDraftAttachments(id, attSnapshot);
            s.syncedAtt = attSig;
            s.forceAttSync = false;
          } else if (lateFiles) {
            const late = await lateFiles;
            // Deleted meanwhile (sent or discarded from another opening)?
            if (s.skip) return;
            const all = [...late.map((a) => ({ name: a.name, type: a.type, data: a.data })), ...attSnapshot];
            if (all.length) await putDraftAttachments(id, all);
            s.syncedAtt = [...late, ...attachments].map((a) => `${a.name}:${a.size}`).join("|");
          }
        })
        .then(() => {
          void qc.invalidateQueries({ queryKey: ["drafts"] });
        }),
    );
    s.saving = save.catch(() => {});
    try {
      await save;
      if (!readable && !lateFiles) {
        if (sessionRef.current === s && s.saveRevision === revision && !s.skip) setSaveState("partial");
        return false;
      }
      clearRecovery(id, revision);
      if (sessionRef.current === s && s.saveRevision === revision && !s.skip) setSaveState("saved");
      return true;
    } catch {
      if (sessionRef.current === s && s.saveRevision === revision && !s.skip) setSaveState(local ? "local" : "failed");
      return false;
    }
  }

  /** Delete a session's backing draft row (sent or discarded) and refresh views. */
  function dropDraft(s: Session = sessionRef.current) {
    s.skip = true;
    const id = s.draftId;
    if (id) clearRecovery(id);
    s.draftId = null;
    if (!id) return;
    // Join the autosave chain so the DELETE is ordered after EVERY queued PUT.
    void s.saving
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
    sessionRef.current.saveRevision = crypto.randomUUID();
    setSaveState("unsaved");
    const t = setTimeout(() => void saveDraftNow(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text, subject, recipients, toInput, cc, bcc, ccPending, bccPending, fromLocal, fromName, fromDomain, attachments, attLoad]);

  // If the session expires, Reload saves what is open first (best effort).
  // Through a ref: the registration outlives the render that made it.
  const saveDraftRef = useRef(saveDraftNow);
  saveDraftRef.current = saveDraftNow;
  useEffect(() => {
    if (!open) return;
    return registerDraftFlush(() => saveDraftRef.current());
  }, [open]);

  // Closing the dialog (any way except send/discard) keeps the draft: flush a
  // final save so nothing typed after the last debounce tick is lost.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      // Closing via X / Close / Escape keeps the draft — surface that so the
      // saved draft isn't a surprise. Not shown on send/discard (they toast
      // their own outcome) or when there's nothing worth saving.
      const keptDraft = draftHasContent() && !sessionRef.current.skip;
      void saveDraftNow({ waitForForward: true }).then(saved => {
        if (!keptDraft) return;
        if (saved) toast.success("Draft saved");
        else toast.error("Couldn't save the draft to the server. Check Drafts on this device for a recovery copy.");
      });
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
    if (keyIsSpokenFor(e)) return;
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

  function handleSubmit(e: React.FormEvent, allowImmediate = false) {
    e.preventDefault();
    const s = sessionRef.current;
    if (s.sending || send.isPending) return;
    // A resumed draft's files are not all here yet (or could not be read).
    // The disabled Send button says so; this covers Cmd+Enter.
    if (attLoadRef.current !== "idle") return;
    // Commit any trailing typed text (fully validated — a half-typed address
    // must not silently ship) before deciding whether we can send.
    const r = flushToInput(toInput, false);
    if (r.invalid.length) return; // notice already shown; let them fix it
    if (r.recipients.length === 0) {
      setToError("Add at least one recipient");
      toInputRef.current?.focus();
      return;
    }
    // Same rule for the copies: a half-typed address must not silently drop.
    const ccResult = showCc ? ccRef.current?.flush() : undefined;
    const bccResult = showBcc ? bccRef.current?.flush() : undefined;
    if (ccResult?.invalid.length) return void ccRef.current?.focus();
    if (bccResult?.invalid.length) return void bccRef.current?.focus();
    const copies = { cc: ccResult?.recipients ?? cc, bcc: bccResult?.recipients ?? bcc };
    s.sending = true;
    setSending(true);
    void submitTo(s, r.recipients, copies, allowImmediate).finally(() => {
      s.sending = false;
      // Only this session's own Send button: by now another message may be
      // open, and possibly sending.
      if (sessionRef.current === s) setSending(false);
    });
  }

  async function submitTo(s: Session, recipients: string[], copies: { cc: string[]; bcc: string[] }, allowImmediate = false) {
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
    setSendError(null);
    const payload: SendPayload = {
      // Full identity address; the Worker resolves it against the registry.
      // fromLocal rides along for back-compat with the legacy default path.
      from: `${cleanedLocal}@${fromDomain}`,
      fromLocal: cleanedLocal,
      ...(cleanedName ? { fromName: cleanedName } : {}),
      to: recipients,
      ...(copies.cc.length ? { cc: copies.cc } : {}),
      ...(copies.bcc.length ? { bcc: copies.bcc } : {}),
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
    };
    // Undo send: hold the message instead of sending it now. Only once its
    // draft is on the server, because the draft is what is left if the held
    // send fails with nobody watching. A failed save keeps the dialog open;
    // it must not silently bypass the promised undo period.
    setNeedsImmediate(false);
    if (onReopen && undoSendSeconds() > 0 && !payload.attachments?.length && !canHold(payload) && !allowImmediate) {
      if (sessionRef.current === s) {
        setNeedsImmediate(true);
        setSendError("This message is too large for Undo send. You can send it immediately, without an undo period.");
      }
      return;
    }
    const shouldHold = sessionRef.current === s && onReopen && canHold(payload);
    if (shouldHold && !(await saveDraftNow())) {
      if (sessionRef.current === s) setSendError("Message not sent. The draft must be saved before Undo send can protect it. Retry saving, then send again.");
      return;
    }
    if (shouldHold && s.draftId) {
      const draftId = s.draftId;
      // Everything Undo needs to put this dialog back as it is now.
      const snapshot: ComposeInitial = {
        to: recipients.join(", "),
        cc: copies.cc.join(", ") || undefined,
        bcc: copies.bcc.join(", ") || undefined,
        subject,
        text,
        bodyJson: docJson || undefined,
        inReplyTo: initial?.inReplyTo,
        threadId: initial?.threadId,
        fromDomain,
        fromLocal: cleanedLocal,
        ...(fromName !== null ? { fromName } : {}),
        replyQuote: initial?.replyQuote,
        // The body is the user's now, signature and all: nothing may be
        // seeded into it when it comes back.
        signatureApplied: true,
        draftId,
      };
      // The held send owns the draft row from here: this session must not
      // write it again (the close-flush) or delete it (the Worker does that
      // when it accepts the message).
      s.skip = true;
      holdSend({
        payload,
        draftId,
        restore: () => onReopen(snapshot),
        onSettled: () => {
          void qc.invalidateQueries({ queryKey: ["threads"] });
          void qc.invalidateQueries({ queryKey: ["thread"] });
          void qc.invalidateQueries({ queryKey: ["drafts"] });
          void qc.invalidateQueries({ queryKey: ["counts"] });
        },
      });
      if (sessionRef.current === s) onOpenChange(false);
      return;
    }
    try {
      await send.mutateAsync(payload);
    } catch (err) {
      // The draft is kept. The reason renders in the dialog, if it is still
      // this message's dialog.
      if (sessionRef.current === s) setSendError(sendFeedback(err));
      toast.error("Send failed");
      return;
    }
    toast.success("Sent ✓");
    // The draft of the message that was SENT, which is not necessarily the one
    // on screen now: the dialog can have been closed and another opened.
    dropDraft(s);
    if (sessionRef.current === s) onOpenChange(false);
  }

  // Ask Workers AI to draft a reply, then place it above the quoted original —
  // read from `replyQuote`, never from `text`. Re-drafting must not stack the
  // quote, and after a handoff `text` is the whole live body, so using it put
  // the user's own words and their signature back under the AI draft.
  function handleAiDraft() {
    const threadId = initial?.threadId;
    if (!threadId) return;
    aiDraft.mutate(threadId, {
      onSuccess: (res) => {
        const quote = initial?.replyQuote ?? "";
        const full = quote ? `${res.draft}${quote}` : res.draft;
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
      onError: () => toast.error("Couldn't draft a reply. Try again."),
    });
  }

  // ⌘/Ctrl+Enter sends from anywhere in the form (including the body textarea).
  function onFormKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if (e.key !== "Enter") return;
    // Committing an IME composition is typing, not a command.
    if (composing(e)) return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      handleSubmit(e);
      return;
    }
    // Plain Enter in a single-line field would implicitly submit the form,
    // which here means sending the mail. Swallow it; from Subject, carry on
    // into the body the way a mail client does.
    // (A recipient field has already handled, and prevented, its own Enter.)
    if (e.target instanceof HTMLInputElement && !e.defaultPrevented) {
      e.preventDefault();
      if (e.target.id === "compose-subject") editorRef.current?.focus();
    }
  }

  const errorMsg = sendError;

  const isReply = !!initial?.inReplyTo || !!initial?.threadId;
  // A reply or resumed draft that already has its recipients is opened to be
  // written in; a new message starts at To.
  const focusBody = !!initial && commitRecipients([], initial.to ?? "").recipients.length > 0;
  const blocked = sending || send.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // Radix would focus the first tabbable element, which is the header's
        // Close button: typing went nowhere and Enter closed the dialog.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          if (!focusBody) {
            toInputRef.current?.focus();
          } else if (editorRef.current) {
            editorRef.current.focus();
          } else {
            // The editor chunk has not mounted yet; it takes focus itself when
            // it does (autoFocus below). Park focus on the dialog meanwhile so
            // it is at least inside the focus trap.
            (e.currentTarget as HTMLElement | null)?.focus();
          }
        }}
        // Radix registers its Escape handler on `document` with capture, so a
        // React onKeyDown (bubble, on #root) can never preventDefault in time.
        // Escape used to close the whole compose window instead of the dropdown.
        onEscapeKeyDown={(e) => {
          if (contactHits.length) {
            e.preventDefault();
            setContactHits([]);
          } else if (document.querySelector('[role="listbox"][aria-label$=" suggestions"]')) {
            // A Cc/Bcc suggestion list is open: Escape closes that (the field
            // handles it), not the whole compose window.
            e.preventDefault();
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
              // min-w-0: without it one long address makes this wider than the
              // row, which pushed the Cc and Bcc buttons off a phone's screen.
              className="flex min-w-0 flex-1 cursor-text flex-wrap items-center gap-1.5"
              onClick={() => toInputRef.current?.focus()}
            >
              {recipients.map((addr) => (
                <span
                  key={addr}
                  title={addr}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pl-2.5 pr-1 text-xs font-medium text-foreground"
                >
                  <span className="min-w-0 truncate">{addr}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecipient(addr);
                    }}
                    aria-label={`Remove ${addr}`}
                    // Looks 16px; on a touch screen an invisible ::after takes taps
                    // over a 44px square around it.
                    className="relative flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3.5 [@media(pointer:coarse)]:after:content-['']"
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
            {(!showCc || !showBcc) && (
              <div className="flex shrink-0 items-center gap-1 pt-0.5">
                {!showCc && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowCc(true);
                      requestAnimationFrame(() => ccRef.current?.focus());
                    }}
                    className="rounded px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground max-md:min-h-11 max-md:px-2.5"
                  >
                    Cc
                  </button>
                )}
                {!showBcc && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowBcc(true);
                      requestAnimationFrame(() => bccRef.current?.focus());
                    }}
                    className="rounded px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground max-md:min-h-11 max-md:px-2.5"
                  >
                    Bcc
                  </button>
                )}
              </div>
            )}
          </div>
          {showCc && (
            <RecipientField
              ref={ccRef}
              label="Cc"
              value={cc}
              onChange={setCc}
              exclude={[...recipients, ...bcc]}
              onPendingChange={setCcPending}
            />
          )}
          {showBcc && (
            <RecipientField
              ref={bccRef}
              label="Bcc"
              value={bcc}
              onChange={setBcc}
              exclude={[...recipients, ...cc]}
              onPendingChange={setBccPending}
            />
          )}

          {/* From — editable local part + readonly identity suffix */}
          <div className="flex items-center gap-3 border-b border-border/60 px-5 py-3">
            <label
              htmlFor="compose-from"
              className="w-12 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              From
            </label>
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2 md:flex-nowrap">
              {/* Display name — prefilled from the identity's sending profile;
                  editable per message. Empty falls back server-side. */}
              <input
                id="compose-from-name"
                disabled={blocked}
                value={fromNameValue}
                onChange={(e) => setFromName(e.target.value)}
                placeholder="Name"
                aria-label="From name"
                size={Math.min(Math.max(fromNameValue.length, 4), 20)}
                className={cn(FIELD, "w-auto min-w-0 shrink max-md:basis-full")}
              />
              <input
                id="compose-from"
                disabled={blocked}
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
                  disabled={blocked}
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

          {initial?.fromDomain && fromDomain !== initial.fromDomain && !fromDomainPick && (
            <p role="status" className="px-5 py-2 text-sm text-foreground">{initial.fromDomain} cannot send. This message will use {fromLocal}@{fromDomain}. Review the From fields before sending.</p>
          )}
          <p className="px-5 py-2 text-xs text-muted-foreground">{signatureFor(fromDomain) ? "Signature is included in the message below and can be edited there." : "No signature configured for this address."}</p>

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
                autoFocus={focusBody ? "end" : undefined}
                placeholder={
                  wideEnoughForTip ? "Write your message… ( / for blocks, markdown works)" : "Write your message…"
                }
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

          {(attachments.length > 0 || attachError || attLoad !== "idle" || fwdNotes.length > 0) && (
            <div className="mx-5 mb-3 space-y-2">
              {fwdNotes.length > 0 && (
                <ul role="status" className="space-y-1 text-xs text-muted-foreground">
                  {fwdNotes.map((note) => (
                    <li key={note} className="[overflow-wrap:anywhere]">
                      {note}
                    </li>
                  ))}
                </ul>
              )}
              {attLoad === "loading" && (
                <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  Loading attachments…
                </p>
              )}
              {attLoad === "failed" && (
                <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="size-3.5 shrink-0" />
                  <span>
                    {initial?.draftId
                      ? "Couldn't load the files saved with this draft."
                      : `Couldn't load from the forwarded message: ${fwdFailed.map((p) => p.name).join(", ")}`}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs text-foreground max-md:h-11"
                    onClick={() => {
                      const s = sessionRef.current;
                      if (initial?.draftId && s.draftId) loadDraftAttachments(s.draftId, s);
                      else if (initial?.forward) loadForwardAttachments(initial.forward, s, fwdFailed);
                    }}
                  >
                    Retry
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground max-md:h-11"
                    onClick={() => {
                      if (initial?.draftId) {
                        // The stored files are being given up, and that is a
                        // decision, so it is recorded and written at once:
                        // the staged list (possibly empty) becomes the draft's
                        // set whether or not anything else changes. Leaving it
                        // to the next autosave made the outcome depend on
                        // whether a new file happened to be staged.
                        sessionRef.current.forceAttSync = true;
                        setAttLoad("idle");
                        void saveDraftNow();
                      } else {
                        // A forward has nothing stored to give up, and the
                        // files that did download stay attached.
                        setFwdFailed([]);
                        setAttLoad("idle");
                      }
                    }}
                  >
                    {initial?.draftId ? "Discard saved files" : "Continue without them"}
                  </Button>
                </div>
              )}
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
                        // Thumb-sized on touch: an 18px X is a miss waiting to
                        // happen. Negative margin keeps the chip from growing.
                        className="-my-1.5 -mr-1 flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground max-md:-my-2.5 max-md:size-11"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {attachments.length > 0 && (
                <p className="text-xs text-muted-foreground/70">
                  Files are included when this draft saves successfully and when you send.
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

          {needsImmediate && <Button type="button" disabled={blocked} onClick={e => handleSubmit(e, true)} className="mx-4">Send immediately</Button>}
          <DraftSaveStatus state={saveState} retry={() => void saveDraftNow()} disabled={blocked} />
          <SendTiming attachments={attachments.length > 0} available={!!onReopen} />
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
                disabled={blocked}
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
              {(draftHasContent() || sessionRef.current.draftId) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={discardDraft}
                  disabled={blocked}
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
                disabled={blocked}
                className="max-md:h-11"
              >
                Close
              </Button>
              <Button
                type="submit"
                disabled={blocked || attLoad !== "idle"}
                className="gap-2 bg-gradient-to-b from-primary to-primary/90 shadow-sm max-md:h-11"
              >
                {blocked ? (
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
