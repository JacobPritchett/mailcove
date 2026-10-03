import { useRef } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { blockSenderOfThread } from "@/lib/blockSender";
import { ApiError } from "@/lib/api";
import { useMutateThreads, INVERSE_ACTION } from "@/lib/queries";
import { actionLabel, actionFailedLabel, isReversible } from "@/lib/actions";
import { formatSnoozeTime } from "@/lib/snooze";
import type { MailAction, View } from "@/lib/types";

/** The most recent reversible action, held only while its toast is on screen. */
interface LastAction {
  /** The toast offering Undo for it. */
  toastId: string;
  /** Undo it. Safe to call more than once: only the first call does anything. */
  undo(): void;
}

export interface ActionOptions {
  /** Toast text, in place of the action's own. */
  label?: string;
  /** For `snooze`: when the threads come back (epoch ms). */
  until?: number;
  /** For `unsnooze`: the time the snooze had, so Undo can put it back. */
  undoUntil?: number | null;
}

export interface ThreadActions {
  /**
   * Apply an action to threads: optimistic update, a toast (with Undo when the
   * action is reversible), and an error toast in its place if the server says no.
   */
  run(threadIds: string[], action: MailAction, opts?: ActionOptions): void;
  /** Undo the latest action whose toast is still showing (the `z` shortcut). */
  undoLast(): void;
}

// Module-level so two hook instances never mint the same toast id.
let toastSeq = 0;

/**
 * The one path every thread action takes, wherever it starts (keyboard, reader
 * toolbar, list row, bulk bar). Sharing it is what makes `z` undo the action
 * the user actually just took rather than the last one made by keyboard.
 */
export function useThreadActions(
  view: View,
  q?: string,
  category?: string | null,
  domain?: string | null,
): ThreadActions {
  // mutateAsync, not mutate with per-call callbacks: those only fire for the
  // latest call on an observer, so a quick second action would silence the
  // failure of the first.
  const { mutateAsync } = useMutateThreads(view, q, category, domain);
  const qc = useQueryClient();
  const lastRef = useRef<LastAction | null>(null);

  function run(threadIds: string[], action: MailAction, opts?: ActionOptions) {
    const id = `thread-action-${++toastSeq}`;
    // The toast currently standing for this action (it is shown a second
    // time, under a new id, after "Block this sender too").
    let toastId = id;
    const inverse = INVERSE_ACTION[action];
    // Undoing an unsnooze is a snooze, which needs its time back. Without one
    // still in the future there is nothing to restore, so no Undo is offered.
    const inverseUntil = inverse === "snooze" ? (opts?.undoUntil ?? undefined) : undefined;
    const canUndo = inverse !== "snooze" || (inverseUntil !== undefined && inverseUntil > Date.now());
    const failed = (what: MailAction) => (err?: unknown) => {
      expire();
      // A refusal that says why (snoozing mail that is not in the inbox) is
      // not something trying again will change: pass the reason on instead.
      const why = err instanceof ApiError && err.status === 400 && err.message ? err.message.replace(/[.!?]$/, "") : "";
      const text = why ? `${actionFailedLabel(what)}: ${why}.` : `${actionFailedLabel(what)}. Try again.`;
      // Same id, so this takes the place of the "Archived" toast that was
      // shown optimistically. `action: undefined` drops its Undo button.
      toast.error(text, { id: toastId, action: undefined, cancel: undefined });
    };

    // Resolves to whether the server accepted the action. Undo waits on it.
    const settled = mutateAsync({ threadIds, action, until: opts?.until }).then(
      () => true,
      (err: unknown) => {
        failed(action)(err);
        return false;
      },
    );

    let undone = false;
    const entry: LastAction | null =
      isReversible(action) && inverse && canUndo
        ? {
            toastId: id,
            undo() {
              // One undo per action, whichever of `z` and the toast's button
              // gets there first; the other becomes a no-op.
              if (undone) return;
              undone = true;
              expire();
              // After the original has settled, never alongside it: two
              // requests in flight can arrive in either order, and if the
              // inverse lands first the original then wins. And if the
              // original failed there is nothing to undo.
              void settled.then((ok) => {
                if (ok) mutateAsync({ threadIds, action: inverse, until: inverseUntil }).catch(failed(inverse));
              });
            },
          }
        : null;
    lastRef.current = entry;
    // Identity check: an older toast closing must not expire a newer action
    // (nor the first showing of this one's toast expire its second).
    function expire(closing: string = toastId) {
      if (closing !== toastId) return;
      if (entry && lastRef.current === entry) lastRef.current = null;
    }
    function showToast(text: string, extra?: { label: string; onClick: () => void }) {
      const shown = toastId;
      if (!entry) return void toast(text, { id: shown });
      toast(text, {
        id: shown,
        action: { label: "Undo", onClick: () => entry.undo() },
        cancel: extra,
        // Undo is offered for as long as the toast is. After that `z` must not
        // reach back to an action the user can no longer see.
        onDismiss: () => expire(shown),
        onAutoClose: () => expire(shown),
      });
    }

    // A snooze says when the mail comes back: "Snoozed until Tue 8:00 am".
    const base = opts?.label ?? actionLabel(action);
    const label =
      action === "snooze" && opts?.until !== undefined
        ? `${base} until ${formatSnoozeTime(opts.until, Date.now())}`
        : base;
    // Reporting one conversation as junk offers the next step beside Undo:
    // keep this sender's future mail out of the inbox as well.
    const blockToo =
      action === "spam" && threadIds.length === 1
        ? {
            label: "Block this sender too",
            onClick: () => {
              void blockSenderOfThread(qc, threadIds[0]);
              // The toast closes with this button, and Undo would go with it.
              // Blocking the sender is not a reason to lose the way back from
              // "Moved to Junk", so the toast returns without the offer.
              if (!entry || undone) return;
              toastId = `${id}-kept`;
              entry.toastId = toastId;
              lastRef.current = entry;
              showToast(label);
            },
          }
        : undefined;
    showToast(label, blockToo);
  }

  function undoLast() {
    const last = lastRef.current;
    if (!last) return;
    last.undo();
    // Take the toast down with it, so its Undo button is not left on screen
    // offering something that has already happened.
    toast.dismiss(last.toastId);
  }

  return { run, undoLast };
}
