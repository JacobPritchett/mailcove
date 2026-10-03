// Blocking a sender: mail from a blocked address (or domain) goes straight to
// Junk. One place for the request and its toasts, shared by the message menu
// and the "Block this sender too" offer on the Report junk toast.
import { toast } from "sonner";
import type { QueryClient } from "@tanstack/react-query";
import { addBlocked, removeBlocked, getThread, ApiError } from "@/lib/api";
import type { ThreadMessage, ThreadResponse } from "@/lib/types";

/**
 * The address to block for a conversation: the AUTHENTICATED mailbox
 * (from_addr) of its latest inbound message. Never the rendered From text,
 * which is the sender's own and could name someone else. Null when no inbound
 * message carries one.
 */
export function senderToBlock(messages: Pick<ThreadMessage, "direction" | "from_addr">[]): string | null {
  return latestSender(messages)?.address ?? null;
}

/**
 * The same address, with whether that message failed the sender check (DMARC).
 * When it did, the address is only what the mail claimed: blocking it would
 * block whoever was impersonated, so the user is told before they do.
 */
export function latestSender(
  messages: (Pick<ThreadMessage, "direction" | "from_addr"> & { body?: ThreadMessage["body"] })[],
): { address: string; failedCheck: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction === "in" && m.from_addr) {
      return { address: m.from_addr, failedCheck: m.body?.headers?.auth?.dmarc === "fail" };
    }
  }
  return null;
}

/** What to say before blocking an address a failed message claimed to be from. */
export function failedCheckWarning(address: string): string {
  return `This message did not pass the sender check, so it may not really be from ${address}.`;
}

/** Block `address`, with a toast that names it and offers Undo. */
export async function blockAddress(qc: QueryClient, address: string): Promise<void> {
  try {
    const { address: entry } = await addBlocked(address);
    void qc.invalidateQueries({ queryKey: ["blocked"] });
    toast(`Blocked ${entry}`, {
      action: {
        label: "Undo",
        onClick: () => {
          removeBlocked(entry).then(
            () => void qc.invalidateQueries({ queryKey: ["blocked"] }),
            () => toast.error(`Couldn't unblock ${entry}. Remove it under Rules.`),
          );
        },
      },
    });
  } catch (e) {
    // A 400 says why (one of our own domains, a full list); pass that on.
    const why = e instanceof ApiError && e.status === 400 && e.message ? `: ${e.message}` : "";
    toast.error(`Couldn't block ${address}${why}.`);
  }
}

/** Block whoever sent the conversation, looking the thread up if it is not loaded. */
export async function blockSenderOfThread(qc: QueryClient, threadId: string): Promise<void> {
  let thread = qc.getQueryData<ThreadResponse>(["thread", threadId]);
  if (!thread) {
    try {
      thread = await getThread(threadId);
    } catch {
      thread = undefined;
    }
  }
  const sender = thread ? latestSender(thread.messages) : null;
  if (!sender) {
    toast.error("Couldn't find a sender to block.");
    return;
  }
  if (sender.failedCheck) {
    // Not blocked on this click: the address may be an innocent party's, so
    // going ahead is a second, deliberate step.
    toast(failedCheckWarning(sender.address), {
      duration: 15_000,
      action: { label: "Block anyway", onClick: () => void blockAddress(qc, sender.address) },
    });
    return;
  }
  await blockAddress(qc, sender.address);
}
