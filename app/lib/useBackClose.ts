import { useEffect, useRef, useState } from "react";
import { useIsDesktop } from "./useMediaQuery";

/**
 * Wire a mobile overlay (full-screen reader, drawer, dialog, confirm) into the
 * browser history so the hardware/browser Back button closes it instead of
 * leaving the app.
 *
 * Every open overlay is a layer on one shared list, and the app owns one
 * history entry per layer. A Back press (hardware gesture or browser button)
 * fires `popstate`, which closes the TOPMOST layer only — one Back, one layer.
 * Each overlay having its own listener meant a single Back closed every open
 * layer at once: with compose open over the reader, the reader went too.
 *
 * "Topmost" means what is drawn on top, which is not always what opened last:
 * a notification tap can open the reader BEHIND an open compose dialog. So
 * each layer carries a priority that mirrors visual stacking (BACK_LAYER), and
 * opening order only breaks ties within one priority (a dialog opened from a
 * dialog).
 *
 * Keeping history and layers in step (see reconcile):
 *  - Entries are counted, not tied to a particular layer. A layer closing and
 *    another opening in the same commit (the drawer handing over to a dialog)
 *    simply reuses the entry: no back(), no pushState.
 *  - A layer closed programmatically (in-app back arrow, a Close button,
 *    desktop crossover) leaves a surplus entry, popped with `history.back()`.
 *    That `popstate` is ours, not the user's, and is swallowed when it arrives
 *    — it must not close whichever layer is now on top.
 *  - Nothing is pushed while such an unwind is in flight. A pushState there
 *    cancels the pending traversal in some engines and not in others; waiting
 *    for it makes the outcome the same everywhere. A layer opened in that
 *    window gets its entry the moment the unwind lands.
 *
 * Desktop (`enabled === false`) is a strict no-op: nothing is pushed and no
 * layer is registered, so desktop navigation is unaffected.
 */

/** Visual stacking order of the things Back can close, lowest first. */
export const BACK_LAYER = {
  /** A full-screen pane of the app itself (the mobile reader). */
  pane: 0,
  /** A modal dialog or sheet. */
  dialog: 1,
  /** A confirm, which always sits above the dialog that raised it. */
  alert: 2,
} as const;

interface Layer {
  priority: number;
  close: () => void;
}

/** Open overlays, in opening order. Module-level: Back is one global gesture. */
const layers: Layer[] = [];
/** History entries the app has pushed and not yet seen popped. */
let owned = 0;
/** When our own history.back() was issued, while its popstate is outstanding. */
let unwindingSince = 0;
/** An unwind that produced no popstate within this window is forgotten, so a
 *  lost event can never make a later, real Back press disappear. */
const UNWIND_WINDOW_MS = 1000;
let listening = false;
let scheduled = false;

function unwinding(): boolean {
  if (unwindingSince && Date.now() - unwindingSince >= UNWIND_WINDOW_MS) unwindingSince = 0;
  return unwindingSince !== 0;
}

/** Bring the number of owned history entries in line with the open layers. */
function reconcile() {
  scheduled = false;
  if (typeof window === "undefined") return; // deferred call after teardown
  if (unwinding()) return; // resumes from onPopState when the unwind lands
  if (owned > layers.length) {
    // One at a time: each back() is answered by one popstate.
    unwindingSince = Date.now();
    window.history.back();
    return;
  }
  while (owned < layers.length) {
    window.history.pushState({ mailcoveOverlay: true }, "");
    owned++;
  }
}

function onPopState() {
  if (unwinding()) {
    // The unwind of our own history.back(); swallow it.
    unwindingSince = 0;
    owned = Math.max(0, owned - 1);
    reconcile();
    return;
  }
  if (owned === 0) return; // not one of ours
  // User pressed Back: an entry of ours is gone, so close what is on top.
  // Highest priority wins; among equals, the one opened last (>= keeps the
  // later entry, since the list is in opening order).
  owned--;
  let top: Layer | undefined;
  for (const layer of layers) {
    if (!top || layer.priority >= top.priority) top = layer;
  }
  if (!top) return;
  layers.splice(layers.indexOf(top), 1);
  top.close();
}

export function useBackClose(
  isOpen: boolean,
  onClose: () => void,
  enabled: boolean,
  priority: number = BACK_LAYER.dialog,
): void {
  // Keep the latest onClose without re-subscribing the effect each render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled || !isOpen) return;

    if (!listening) {
      window.addEventListener("popstate", onPopState);
      listening = true;
    }
    const layer: Layer = { priority, close: () => onCloseRef.current() };
    layers.push(layer);
    reconcile();

    return () => {
      const at = layers.indexOf(layer);
      if (at !== -1) layers.splice(at, 1);
      // Not now: a layer opening in this same commit should take over the
      // entry this one leaves behind, rather than pop one and push another.
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => {
          try {
            reconcile();
          } catch {
            // The page is being torn down; there is no history left to tidy.
            scheduled = false;
          }
        }, 0);
      }
    };
  }, [enabled, isOpen, priority]);
}

/**
 * Back-button wiring for a Radix dialog root, controlled or not.
 *
 * Lives in the ui wrappers (Dialog, Sheet, AlertDialog) rather than at each
 * call site, so every modal layer is registered by construction: a confirm
 * added somewhere new cannot be forgotten, which is how the "Delete forever?"
 * dialogs came to leave the app on Back. An uncontrolled root (most confirms:
 * a trigger and nothing else) has its open state held here, so that Back has
 * something to set.
 *
 * Returns the `open` / `onOpenChange` pair to pass to the Radix root.
 */
export function useModalBackLayer(
  openProp: boolean | undefined,
  defaultOpen: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
  priority: number,
): { open: boolean; onOpenChange: (open: boolean) => void } {
  const [inner, setInner] = useState(defaultOpen ?? false);
  const open = openProp ?? inner;
  const change = (next: boolean) => {
    if (openProp === undefined) setInner(next);
    onOpenChange?.(next);
  };
  const isDesktop = useIsDesktop();
  useBackClose(open, () => change(false), !isDesktop, priority);
  return { open, onOpenChange: change };
}
