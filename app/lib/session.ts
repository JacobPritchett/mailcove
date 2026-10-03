// What happens when the Cloudflare Access session runs out while the app is
// open. Kept apart from api.ts so component tests that mock the api client
// wholesale do not have to know about it.
import { toast } from "sonner";

type Flush = () => Promise<unknown> | void;

/** Open composers that have something worth saving before the page goes away. */
const flushers = new Set<Flush>();

/** Register a best-effort "save my draft now". Returns the unregister function. */
export function registerDraftFlush(fn: Flush): () => void {
  flushers.add(fn);
  return () => {
    flushers.delete(fn);
  };
}

/** How long Reload waits for drafts before going ahead anyway. */
const FLUSH_TIMEOUT_MS = 2000;

/** Indirection over location.reload so it can be observed under test. */
export const page = {
  reload: () => window.location.reload(),
};

/**
 * Save every open draft, then reload. Best effort by design: with the session
 * gone the saves will most likely be refused too, but a session that expired
 * between two requests, or a draft that only needed its last keystrokes
 * written, still gets its chance. Reload never waits on it for long.
 */
async function flushThenReload(): Promise<void> {
  const saves = Array.from(flushers, (fn) => {
    try {
      return Promise.resolve(fn()).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  });
  await Promise.race([
    Promise.all(saves),
    new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
  ]);
  page.reload();
}

/**
 * Tell the user their session is over. One toast, however many requests fail:
 * the fixed id makes every call after the first update the toast in place, and
 * it stays until they act on it (polling would otherwise re-raise it forever).
 */
export function sessionExpired(): void {
  toast.error("Session expired. Reload to sign in again.", {
    id: "session-expired",
    duration: Infinity,
    action: {
      label: "Reload",
      onClick: () => void flushThenReload(),
    },
  });
}
