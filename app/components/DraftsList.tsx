import { useRecoveryDrafts, clearRecovery, type RecoveryDraft } from "@/lib/draftRecovery";
// The Drafts view: autosaved compose sessions, newest first. Clicking a row
// resumes it in the full compose dialog (reply drafts keep their threading
// headers, so sending still joins the original conversation).
import { FileText, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDrafts, useDeleteDraft } from "@/lib/queries";
import { cancelHeldDraft } from "@/lib/outbox";
import { getDraft } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { ComposeInitial } from "@/components/ComposeDialog";
import type { DraftSummary } from "@/lib/types";

export interface DraftsListProps {
  /** Open the compose dialog seeded with this draft. */
  onOpen: (initial: ComposeInitial) => void;
}

/** Map a stored draft onto the compose dialog's prefill shape. */
export function draftToComposeInitial(d: {
  id: string;
  threadId: string | null;
  inReplyTo: string | null;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  bodyText: string;
  bodyJson: string;
  fromLocal: string;
  fromDomain: string;
  fromName: string;
}): ComposeInitial {
  return {
    draftId: d.id,
    to: d.to || undefined,
    cc: d.cc || undefined,
    bcc: d.bcc || undefined,
    subject: d.subject || undefined,
    text: d.bodyText || undefined,
    bodyJson: d.bodyJson || undefined,
    threadId: d.threadId || undefined,
    inReplyTo: d.inReplyTo || undefined,
    fromDomain: d.fromDomain || undefined,
    fromLocal: d.fromLocal || undefined,
    fromName: d.fromName || undefined,
  };
}

export default function DraftsList({ onOpen }: DraftsListProps) {
  const { data, isPending, isError } = useDrafts(true);
  const del = useDeleteDraft();
  const recovery = useRecoveryDrafts();

  function available(id: string): boolean {
    if (cancelHeldDraft(id)) return true;
    toast.error("This draft has a send in progress. Wait for it to finish before editing or deleting it.");
    return false;
  }

  async function openDraft(row: DraftSummary) {
    if (!available(row.id)) return;
    try {
      const full = await getDraft(row.id);
      if (!available(row.id)) return;
      onOpen(draftToComposeInitial(full));
    } catch {
      toast.error("Couldn't open this draft");
    }
  }

  function openRecovery(d: RecoveryDraft) {
    if (!available(d.id)) return;
    const p = d.payload;
    onOpen({ draftId: d.id, to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject,
      text: p.bodyText, bodyJson: p.bodyJson, threadId: p.threadId, inReplyTo: p.inReplyTo,
      fromLocal: p.fromLocal, fromDomain: p.fromDomain, fromName: p.fromName,
      signatureApplied: true, recoveryPendingAttachments: d.pendingAttachments, ...(d.attachments !== null ? { recoveryAttachments: d.attachments } : {}) });
  }
  if (isPending && !recovery.length) {
    return <p className="p-6 text-sm text-muted-foreground">Loading drafts…</p>;
  }
  if (isError && !recovery.length) {
    return <p className="p-6 text-sm text-muted-foreground">Couldn't load drafts.</p>;
  }
  const drafts = (data?.drafts ?? []).filter(d => !recovery.some(r => r.id === d.id));
  if (drafts.length === 0 && !recovery.length) {
    return (
      <div className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground">
        <FileText className="h-8 w-8 opacity-30" aria-hidden />
        <p className="text-sm">No drafts. Anything you compose autosaves here.</p>
      </div>
    );
  }

  return (
    <ul aria-label="Drafts" className="divide-y">
      {recovery.map(d => <li key={d.id} className="border-b p-4">
        <button type="button" onClick={() => openRecovery(d)} className="w-full text-left">
          <span className="block text-sm font-medium">{d.payload.subject || "(no subject)"}</span>
          <span className="block text-xs text-muted-foreground">Device recovery copy · {d.payload.to || "No recipients"}</span>
          <span className="block text-xs text-muted-foreground">Open to recover changes not yet saved to the server. Device copy: {formatDate(d.updated, Date.now())}.</span>
        </button>
        {d.attachments === null && <p className="mt-1 text-xs text-muted-foreground">Some attachments still need to be loaded from the server.</p>}
        <button type="button" className="mt-2 text-xs underline" onClick={() => { if (available(d.id)) clearRecovery(d.id); }}>Discard device copy</button>
      </li>)}
      {isError && <li className="p-4 text-sm">Couldn't load server drafts. Device copies are available above.</li>}
      {drafts.map((d) => (
        <li key={d.id} className="group relative">
          <button
            type="button"
            onClick={() => void openDraft(d)}
            className="block w-full px-4 py-3 pr-12 text-left transition-colors hover:bg-accent/50"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm font-medium">
                {d.to || "(no recipients)"}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatDate(d.updated, Date.now())}
              </span>
            </div>
            <div className="truncate text-sm">
              <span className="text-destructive/80">Draft · </span>
              {d.subject || "(no subject)"}
            </div>
            {d.snippet && (
              <div className="truncate text-xs text-muted-foreground">{d.snippet}</div>
            )}
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Delete draft ${d.subject || d.id}`}
            disabled={del.isPending}
            onClick={() =>
              available(d.id) && del.mutate(d.id, {
                onSuccess: () => toast.success("Draft deleted"),
                onError: () => toast.error("Couldn't delete draft"),
              })
            }
            className="absolute top-1/2 right-2 size-8 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
          >
            {del.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          </Button>
        </li>
      ))}
    </ul>
  );
}
