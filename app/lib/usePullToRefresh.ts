// Pull down at the top of a scrolling list to refresh it.
//
// Touch events rather than pointer events: the pull has to stop the browser's
// own overscroll, and only a non-passive touchmove can do that. The gesture
// claims a drag only when the list is already at the top and the drag is
// clearly downward; anything else is left alone as an ordinary scroll.
import { useEffect, useRef, useState } from "react";

/** Pull this far (after damping) and letting go refreshes. */
export const PULL_THRESHOLD_PX = 64;
/** The indicator stops following the finger here. */
const PULL_MAX_PX = 96;
/** Finger travel is halved, so the pull has some weight to it. */
const DAMPING = 0.5;
const SLOP_PX = 10;
/** Keep the spinner up at least this long; a refresh that flashes by reads as nothing having happened. */
const MIN_SPIN_MS = 500;

/** Indicator travel for a finger that has moved `dy` down since the pull began. */
export function pullDistance(dy: number): number {
  return Math.max(0, Math.min(PULL_MAX_PX, (dy - SLOP_PX) * DAMPING));
}

/**
 * Attach pull-to-refresh to `scroller`. `indicator` is moved as the finger
 * moves (written to the DOM directly, no render per touchmove) and marked
 * `data-armed` once letting go would refresh. Returns whether a refresh is in
 * progress, for the spinner and the screen reader announcement.
 */
export function usePullToRefresh(
  scroller: React.RefObject<HTMLElement | null>,
  indicator: React.RefObject<HTMLElement | null>,
  onRefresh: () => Promise<unknown>,
): boolean {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const busy = useRef(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let tracking = false;
    let pulling = false;
    let startX = 0;
    let startY = 0;
    let dist = 0;

    const show = (d: number, animate: boolean) => {
      const ind = indicator.current;
      if (!ind) return;
      const reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      ind.style.transition = animate && !reduce ? "transform 200ms ease-out, opacity 200ms ease-out" : "none";
      ind.style.transform = `translate3d(-50%, ${d}px, 0)`;
      ind.style.opacity = d > 0 ? "1" : "0";
      ind.dataset.armed = String(d >= PULL_THRESHOLD_PX);
    };

    const onStart = (e: TouchEvent) => {
      tracking = !busy.current && e.touches.length === 1 && el.scrollTop <= 0;
      pulling = false;
      dist = 0;
      if (!tracking) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!pulling) {
        // Up, or sideways (a row swipe): not ours, for the rest of this touch.
        if (dy < -SLOP_PX || Math.abs(dx) > SLOP_PX) {
          tracking = false;
          return;
        }
        if (dy <= SLOP_PX || el.scrollTop > 0) return;
        pulling = true;
      }
      // Ours now: keep the browser from scrolling or overscrolling with it.
      if (e.cancelable) e.preventDefault();
      dist = pullDistance(dy);
      show(dist, false);
    };
    const onEnd = () => {
      if (!tracking || !pulling) {
        tracking = false;
        return;
      }
      tracking = false;
      pulling = false;
      if (dist < PULL_THRESHOLD_PX) {
        show(0, true);
        return;
      }
      busy.current = true;
      setRefreshing(true);
      show(PULL_THRESHOLD_PX, true);
      const started = Date.now();
      void refresh.current()
        .catch(() => {
          // The list shows its own "Couldn't refresh" notice.
        })
        .then(() => new Promise((r) => setTimeout(r, Math.max(0, MIN_SPIN_MS - (Date.now() - started)))))
        .then(() => {
          busy.current = false;
          setRefreshing(false);
          show(0, true);
        });
    };

    // The system took the touch away (a notification, a gesture of its own):
    // that is not the user letting go, so nothing is refreshed.
    const onCancel = () => {
      const was = pulling;
      tracking = false;
      pulling = false;
      if (was) show(0, true);
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onCancel);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
    };
  }, [scroller, indicator]);

  return refreshing;
}
