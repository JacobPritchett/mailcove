import { useEffect, useRef } from "react";

/**
 * Wire a mobile overlay (drawer, full-screen reader) into the browser history
 * so the hardware/browser Back button closes it instead of leaving the app.
 *
 * When `isOpen` flips true (and we're on mobile), we push a single history entry
 * and listen for `popstate`. A Back press (hardware gesture or browser button)
 * fires `popstate`, which we treat as a request to close — we call `onClose`
 * instead of letting the navigation unwind out of the app.
 *
 * Duplicate-entry / stuck-state avoidance:
 *  - We push exactly once per open, tracked by `pushedRef`. Re-renders while
 *    open never push again.
 *  - When the overlay is closed programmatically (folder select, in-app back
 *    arrow, desktop crossover), the effect cleanup runs with `pushedRef` still
 *    set; we call `history.back()` to pop the entry we added, keeping the
 *    history stack and the React state in sync. A `closingRef` guard ensures the
 *    `popstate` that results from our own `history.back()` does NOT re-invoke
 *    `onClose` (which is already false), so there's no double-handling and no
 *    trapped entry that would require two Back taps to leave the list view.
 *
 * Desktop (`enabled === false`) is a strict no-op: nothing is pushed and no
 * listener is attached, so desktop navigation is unaffected.
 */
export function useBackClose(
  isOpen: boolean,
  onClose: () => void,
  enabled: boolean,
): void {
  // Keep the latest onClose without re-subscribing the effect each render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // True while we hold a pushed history entry for this open overlay.
  const pushedRef = useRef(false);
  // True while we're unwinding our own pushed entry, so the resulting popstate
  // is ignored rather than treated as a user Back press.
  const closingRef = useRef(false);

  useEffect(() => {
    if (!enabled || !isOpen) return;

    pushedRef.current = true;
    closingRef.current = false;
    window.history.pushState({ mailcoveOverlay: true }, "");

    const onPopState = () => {
      if (closingRef.current) {
        // This popstate is the unwind of our own history.back(); swallow it.
        closingRef.current = false;
        return;
      }
      // User pressed Back: the entry we pushed is already gone, so just close.
      pushedRef.current = false;
      onCloseRef.current();
    };

    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("popstate", onPopState);
      // Closed programmatically while our entry is still on the stack → pop it
      // so history stays consistent and we don't trap an extra entry.
      if (pushedRef.current) {
        pushedRef.current = false;
        closingRef.current = true;
        window.history.back();
      }
    };
  }, [enabled, isOpen]);
}
