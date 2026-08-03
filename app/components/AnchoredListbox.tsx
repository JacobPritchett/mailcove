// A listbox that escapes its clipping ancestors.
//
// The recipient suggestions were absolutely positioned inside the compose form,
// which is `overflow-y-auto` inside an `overflow-hidden` dialog, with a fixed
// max-height. Whatever did not fit was cut off: measured at 390 wide, 21px lost
// at 320 tall and 81px at 260 tall.
//
// It renders in a portal on `document.body`, positioned against the anchor,
// clamped to the visible band on both axes, and flipped above the anchor when
// below is cramped and above is usable.
//
// Two things here are load-bearing, and each was got wrong once:
//
//   * The host MUST be document.body, not the dialog. `position: fixed`
//     resolves against the nearest ancestor carrying a transform/translate, NOT
//     the viewport — and the dialog is centred with `translate: -50% -50%`.
//     Hosting inside it made every coordinate relative to the dialog's own box:
//     353px of horizontal error at 1280x800, with the list sheared off the
//     dialog's edge. It measured perfect at 390 wide only because the dialog is
//     full-bleed below `sm`, where that error happens to be exactly zero.
//
//   * Radix modal dialogs set `pointer-events: none` on the body, which is
//     inherited here, so the list has to ask for it back or every click on an
//     option is swallowed. (Radix's `hideOthers` is NOT a problem: it hides the
//     body children that existed when the dialog opened, and this portal is
//     appended afterwards.)
//
// Sizing reads `visualViewport` where it exists: an on-screen keyboard shrinks
// THAT, while window.innerHeight often does not change at all.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Gap between the anchor and the list, and the margin kept off the edge. */
const GAP = 4;
const EDGE = 8;
/** Below this there is no point opening downward; prefer flipping. */
const MIN_USEFUL = 96;

export interface Pos {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

export interface PlacementInput {
  /** Anchor rect, in layout-viewport coordinates (getBoundingClientRect). */
  anchor: { left: number; width: number; top: number; bottom: number };
  /** The visible band. An on-screen keyboard changes these, not innerHeight. */
  viewTop: number;
  viewLeft: number;
  viewWidth: number;
  viewHeight: number;
  /** Layout viewport height, for expressing a bottom-anchored position. */
  windowHeight: number;
  /** Never grow past this even when there is room. */
  preferredMaxHeight: number;
}

/**
 * Where to put the list, as pure arithmetic so the flip, the clamps and the
 * out-of-view case are testable — jsdom reports every rect as zero, so a DOM
 * test here would assert nothing at all.
 *
 * Returns null when the anchor is not in the visible band: the compose form
 * scrolls, and a list still pinned to a field that has scrolled away covers the
 * rest of the dialog instead.
 */
export function computePlacement({
  anchor,
  viewTop,
  viewLeft,
  viewWidth,
  viewHeight,
  windowHeight,
  preferredMaxHeight,
}: PlacementInput): Pos | null {
  if (viewHeight <= 0 || viewWidth <= 0) return null;
  const viewBottom = viewTop + viewHeight;
  // Only judge visibility once the anchor has actually been laid out. An
  // all-zero rect means "not measured yet" (the first paint, and every rect in
  // jsdom) - reading that as "scrolled out of view" would hide the list on
  // mount and make it untestable outside a real browser.
  const measured = anchor.width > 0 || anchor.bottom > anchor.top;
  if (measured && (anchor.bottom <= viewTop || anchor.top >= viewBottom)) return null;

  const below = viewBottom - anchor.bottom - GAP - EDGE;
  const above = anchor.top - viewTop - GAP - EDGE;
  // Flip only when below is cramped AND above is actually usable. "Above is 2px
  // roomier" is no reason to jump the list over the field.
  const flip = below < MIN_USEFUL && above >= MIN_USEFUL;

  // No floor. A minimum height sounds kind but simply reinstates the overflow
  // this component exists to prevent: forcing 64px into a 43px gap clips 21px,
  // which is the exact number the original bug was measured at.
  const room = Math.floor(Math.max(0, flip ? above : below));

  const width = Math.min(anchor.width, Math.max(0, viewWidth - EDGE * 2));
  const left = Math.round(
    Math.min(Math.max(anchor.left, viewLeft + EDGE), viewLeft + viewWidth - width - EDGE),
  );

  return {
    left,
    width,
    maxHeight: Math.min(room, preferredMaxHeight),
    ...(flip
      ? { bottom: Math.round(windowHeight - anchor.top + GAP) }
      : { top: Math.round(anchor.bottom + GAP) }),
  };
}

export interface AnchoredListboxProps extends React.ComponentPropsWithoutRef<"ul"> {
  /** The element to position against — usually the input wrapper. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Upper bound on height even when there is room (default: the old max-h-56). */
  preferredMaxHeight?: number;
  children: React.ReactNode;
}

export default function AnchoredListbox({
  anchorRef,
  preferredMaxHeight = 224,
  children,
  style,
  ...props
}: AnchoredListboxProps) {
  const [pos, setPos] = useState<Pos | null>(null);
  const placeRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const place = () => {
      const r = anchor.getBoundingClientRect();
      const vv = window.visualViewport;
      setPos(
        computePlacement({
          anchor: { left: r.left, width: r.width, top: r.top, bottom: r.bottom },
          viewTop: vv ? vv.offsetTop : 0,
          viewLeft: vv ? vv.offsetLeft : 0,
          viewWidth: vv ? vv.width : window.innerWidth,
          viewHeight: vv ? vv.height : window.innerHeight,
          windowHeight: window.innerHeight,
          preferredMaxHeight,
        }),
      );
    };
    placeRef.current = place;
    place();

    // `true` for capture: the anchor moves when ANY ancestor scrolls, including
    // the compose form, and scroll does not bubble.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", place);
    vv?.addEventListener("scroll", place);
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : undefined;
    ro?.observe(anchor);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      vv?.removeEventListener("resize", place);
      vv?.removeEventListener("scroll", place);
      ro?.disconnect();
    };
    // Deliberately NOT depending on `children`: that is a fresh array on every
    // parent render, so including it tore down and rebuilt four listeners and a
    // ResizeObserver on every keystroke in the dialog.
  }, [anchorRef, preferredMaxHeight]);

  // Re-place when the options change instead. A shrinking list must not stay
  // where the longer one ended, and when flipped its height IS its position.
  useLayoutEffect(() => {
    placeRef.current();
  }, [children]);

  if (!pos) return null;

  return createPortal(
    <ul
      {...props}
      style={{
        position: "fixed",
        left: pos.left,
        width: pos.width,
        maxHeight: pos.maxHeight,
        // Radix sets pointer-events:none on the body while a modal is open.
        pointerEvents: "auto",
        ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
        ...style,
      }}
    >
      {children}
    </ul>,
    document.body,
  );
}
