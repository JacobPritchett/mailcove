// Touch gestures on a list row: swipe sideways to act on it, hold to select.
//
// Built on pointer events with `touch-action: pan-y` on the row, so the
// browser keeps vertical scrolling to itself (and tells us with pointercancel
// when it has taken a gesture) while sideways movement comes to us. The axis
// is decided once, early, and never revisited: a scroll that drifts sideways
// stays a scroll, and a swipe that drifts up or down stays a swipe.
import { useEffect, useRef } from "react";

/** Movement before the gesture is judged at all (finger wobble on a tap). */
export const SLOP_PX = 10;
/** A hold this long, without moving, is a long press. */
export const LONG_PRESS_MS = 500;
/** A swipe that starts this close to a screen edge is the browser's (its
 *  back and forward gestures live there), so it is not also ours. */
export const EDGE_PX = 20;
/** How long after a touch ends its click may still arrive (and be swallowed). */
const CLICK_WINDOW_MS = 400;
/** Slide duration for the snap back and the slide away. */
const SLIDE_MS = 180;

export type SwipeDirection = "left" | "right";

/**
 * Which way a gesture is going, judged from its first movement past the slop.
 * Sideways has to clearly win: at 45 degrees the user is more likely scrolling
 * with a tilted thumb than swiping, so that goes to the scroll.
 */
export function decideAxis(dx: number, dy: number): "horizontal" | "vertical" | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < SLOP_PX && ay < SLOP_PX) return null;
  return ax > ay * 1.5 ? "horizontal" : "vertical";
}

/** How far a row must travel for letting go to commit: a third of it, capped. */
export function commitThreshold(rowWidth: number): number {
  return Math.min(120, Math.max(56, rowWidth * 0.35));
}

/** What releasing at `dx` does. */
export function swipeOutcome(dx: number, rowWidth: number): SwipeDirection | null {
  if (Math.abs(dx) < commitThreshold(rowWidth)) return null;
  return dx > 0 ? "right" : "left";
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export interface RowGestureOptions {
  /** Swiping is off in selection mode, where a tap toggles and nothing else moves. */
  swipeEnabled: boolean;
  /**
   * A swipe was released past the threshold. Return true when the row will
   * leave the list, so it slides away; false and it slides back.
   */
  onSwipe: (direction: SwipeDirection) => boolean;
  onLongPress: () => void;
}

type Phase = "idle" | "pending" | "swiping" | "scrolling" | "held";

/**
 * Wire the gestures to a row. `slide` is the element that moves; `underlay`
 * sits beneath it and is told which way the row is going (`data-dir`) and
 * whether letting go would commit (`data-armed`), so it can show the right
 * colour and icon. Positions are written straight to the DOM: a re-render per
 * touchmove across a long list is exactly what makes a swipe feel sticky.
 *
 * Mouse and pen are ignored; desktop has its own row actions.
 */
export function useRowGestures(
  slide: React.RefObject<HTMLElement | null>,
  underlay: React.RefObject<HTMLElement | null>,
  options: RowGestureOptions,
) {
  const opts = useRef(options);
  opts.current = options;
  const g = useRef({
    phase: "idle" as Phase,
    id: -1,
    x: 0,
    y: 0,
    dx: 0,
    timer: 0,
    resetTimer: 0,
    edge: false,
    suppressClick: false,
    touched: false,
  });

  useEffect(
    () => () => {
      window.clearTimeout(g.current.timer);
      window.clearTimeout(g.current.resetTimer);
    },
    [],
  );

  /**
   * Is this event the row's own? React delivers events from a portalled child
   * (a row's snooze menu, its confirm dialog) to the row's handlers as if they
   * had happened inside it. A drag inside one of those is not a swipe on the row.
   */
  const ours = (e: React.SyntheticEvent) => e.target instanceof Node && e.currentTarget.contains(e.target);

  function place(dx: number, animate: boolean) {
    const el = slide.current;
    if (!el) return;
    el.style.transition = animate && !prefersReducedMotion() ? `transform ${SLIDE_MS}ms ease-out` : "none";
    el.style.transform = dx === 0 ? "" : `translate3d(${dx}px,0,0)`;
  }
  function mark(dx: number) {
    const u = underlay.current;
    const el = slide.current;
    if (!u || !el) return;
    if (dx === 0) {
      delete u.dataset.dir;
      delete u.dataset.armed;
      return;
    }
    u.dataset.dir = dx > 0 ? "right" : "left";
    u.dataset.armed = String(swipeOutcome(dx, el.offsetWidth) !== null);
  }
  /** Back to rest, clearing the underlay once the row has covered it again. */
  function settle() {
    place(0, true);
    const u = underlay.current;
    window.setTimeout(() => {
      if (g.current.phase === "idle" || g.current.phase === "pending") {
        if (u) {
          delete u.dataset.dir;
          delete u.dataset.armed;
        }
      }
    }, prefersReducedMotion() ? 0 : SLIDE_MS);
  }
  function end() {
    const s = g.current;
    window.clearTimeout(s.timer);
    s.phase = "idle";
    // The touch is over. Its click (if any) follows within moments; after
    // that these must not linger, or the next mouse click or key press on the
    // row is swallowed and the context menu stays blocked.
    window.clearTimeout(s.resetTimer);
    s.resetTimer = window.setTimeout(() => {
      s.suppressClick = false;
      s.touched = false;
    }, CLICK_WINDOW_MS);
  }

  return {
    onPointerDown(e: React.PointerEvent) {
      const s = g.current;
      if (e.pointerType !== "touch" || !e.isPrimary || !ours(e)) {
        // Not a gesture on this row: forget any pointer we were following, so
        // this one's moves are not taken for the last one's.
        s.id = -1;
        return;
      }
      window.clearTimeout(s.resetTimer);
      s.edge = e.clientX < EDGE_PX || e.clientX > window.innerWidth - EDGE_PX;
      s.touched = true;
      s.suppressClick = false;
      s.phase = "pending";
      s.id = e.pointerId;
      s.x = e.clientX;
      s.y = e.clientY;
      s.dx = 0;
      window.clearTimeout(s.timer);
      s.timer = window.setTimeout(() => {
        if (s.phase !== "pending") return;
        s.phase = "held";
        // The finger is still down; the click its release produces must not
        // also open (or re-toggle) the row.
        s.suppressClick = true;
        try {
          navigator.vibrate?.(10);
        } catch {
          // No haptics here; the selection itself is the feedback.
        }
        opts.current.onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove(e: React.PointerEvent) {
      const s = g.current;
      if (e.pointerId !== s.id) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (s.phase === "pending") {
        const axis = decideAxis(dx, dy);
        if (!axis) return;
        window.clearTimeout(s.timer);
        if (axis === "vertical" || !opts.current.swipeEnabled || s.edge) {
          s.phase = "scrolling";
          return;
        }
        s.phase = "swiping";
        s.suppressClick = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Capture is a nicety (keeps the gesture if the finger leaves the row).
        }
      }
      if (s.phase !== "swiping") return;
      s.dx = dx;
      place(dx, false);
      mark(dx);
    },
    onPointerUp(e: React.PointerEvent) {
      const s = g.current;
      if (e.pointerId !== s.id) return;
      const wasSwiping = s.phase === "swiping";
      end();
      if (!wasSwiping) return;
      const el = slide.current;
      const width = el?.offsetWidth ?? 0;
      const outcome = swipeOutcome(s.dx, width);
      if (!outcome) {
        settle();
        return;
      }
      const leaves = opts.current.onSwipe(outcome);
      if (leaves) place(outcome === "right" ? width : -width, true);
      else settle();
      // (If the row then stays after all, its owner resets it; see Row.)
    },
    onPointerCancel(e: React.PointerEvent) {
      const s = g.current;
      if (e.pointerId !== s.id) return;
      const wasSwiping = s.phase === "swiping";
      end();
      if (wasSwiping) settle();
    },
    /** Swallow the click that ends a swipe or a long press. */
    onClickCapture(e: React.MouseEvent) {
      const s = g.current;
      if (!s.suppressClick || !ours(e)) return;
      s.suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    /** A long press must not also raise the browser's own menu. */
    onContextMenu(e: React.MouseEvent) {
      if (g.current.touched && ours(e)) e.preventDefault();
    },
  };
}
