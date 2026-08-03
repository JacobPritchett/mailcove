// The recipient suggestions were absolutely positioned inside the compose form,
// which is overflow-y-auto inside an overflow-hidden dialog. Measured in a real
// browser at 390 wide: 21px of the list was cut off at 320 tall and 81px at 260
// tall. A phone in landscape with the keyboard up is shorter than either.
//
// The placement is arithmetic on rects precisely so it can be tested — jsdom
// reports every getBoundingClientRect as zero, so a DOM test here would assert
// nothing.
import { describe, it, expect } from "vitest";
import { computePlacement } from "../components/AnchoredListbox";

/** A "To" field near the top of a tall-enough viewport. */
const ROOMY = {
  anchor: { left: 16, width: 358, top: 90, bottom: 113 },
  viewTop: 0,
  viewLeft: 0,
  viewWidth: 390,
  viewHeight: 800,
  windowHeight: 800,
  preferredMaxHeight: 224,
};

describe("computePlacement", () => {
  it("opens below the anchor when there is room", () => {
    const p = computePlacement(ROOMY)!;
    expect(p.top).toBe(117);
    expect(p.bottom).toBeUndefined();
  });

  it("tracks the anchor's horizontal box", () => {
    const p = computePlacement(ROOMY)!;
    expect(p.left).toBe(16);
    expect(p.width).toBe(358);
  });

  it("never grows past the preferred height even in a tall viewport", () => {
    expect(computePlacement(ROOMY)!.maxHeight).toBe(224);
  });

  it("clamps its height to the space actually below", () => {
    // 260-tall viewport: 260 - 113 - 4 - 8 = 135px left under the field.
    const p = computePlacement({ ...ROOMY, viewHeight: 260, windowHeight: 260 })!;
    expect(p.maxHeight).toBe(135);
    expect(p.top).toBe(117);
  });

  it("flips above the anchor when below is cramped and above is roomier", () => {
    // Field near the bottom: 40px below, 500px above.
    const p = computePlacement({
      ...ROOMY,
      anchor: { ...ROOMY.anchor, top: 520, bottom: 552 },
      viewHeight: 600,
      windowHeight: 600,
    })!;
    expect(p.bottom).toBe(600 - 520 + 4);
    expect(p.top).toBeUndefined();
    expect(p.maxHeight).toBe(224);
  });

  it("does NOT flip when above is barely roomier than below", () => {
    // 48px above vs 46px below. Jumping the list over the field to gain 2px is
    // pure churn, and near the tipping point it would flip on every keystroke.
    const p = computePlacement({
      ...ROOMY,
      anchor: { ...ROOMY.anchor, top: 60, bottom: 92 },
      viewHeight: 150,
      windowHeight: 150,
    })!;
    expect(p.top).toBe(96);
    expect(p.bottom).toBeUndefined();
  });

  it("never sizes itself past the space it has, however little that is", () => {
    // A minimum height sounds kind and is the bug: an earlier version floored
    // this at 64px, which put 64px into a 43px gap and clipped 21px - the exact
    // overflow this component exists to prevent, reintroduced by the guard.
    for (const viewHeight of [185, 170, 140, 125]) {
      const p = computePlacement({
        ...ROOMY,
        anchor: { ...ROOMY.anchor, top: 90, bottom: 113 },
        viewHeight,
        windowHeight: viewHeight,
      })!;
      expect(p.top! + p.maxHeight).toBeLessThanOrEqual(viewHeight);
    }
  });

  it("still places an unmeasured anchor rather than hiding on first paint", () => {
    // An all-zero rect is "not laid out yet", not "off screen".
    expect(
      computePlacement({ ...ROOMY, anchor: { left: 0, width: 0, top: 0, bottom: 0 } }),
    ).not.toBeNull();
  });

  it("returns nothing when the anchor has scrolled out of the visible band", () => {
    // The compose form scrolls. A list still pinned to a field that has
    // scrolled away covers the header, the subject and most of the editor.
    expect(
      computePlacement({ ...ROOMY, anchor: { ...ROOMY.anchor, top: -80, bottom: -40 } }),
    ).toBeNull();
    expect(
      computePlacement({ ...ROOMY, anchor: { ...ROOMY.anchor, top: 900, bottom: 940 } }),
    ).toBeNull();
  });

  it("returns nothing for a degenerate band rather than a plausible-looking answer", () => {
    // viewTop/viewBottom are intersections, so they can cross over.
    expect(computePlacement({ ...ROOMY, viewTop: 500, viewHeight: -100 })).toBeNull();
  });

  it("keeps the list inside the viewport horizontally", () => {
    // The anchor can sit near the right edge on a narrow screen.
    const p = computePlacement({
      ...ROOMY,
      anchor: { ...ROOMY.anchor, left: 320, width: 358 },
    })!;
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.left + p.width).toBeLessThanOrEqual(390);
  });

  it("measures against the VISUAL viewport, which is what a keyboard shrinks", () => {
    // window.innerHeight often does not change when the on-screen keyboard
    // opens; visualViewport.height does. Sizing from the former is exactly the
    // case that was broken, so the same anchor must yield less room when the
    // visual viewport is short.
    const keyboardUp = computePlacement({
      ...ROOMY,
      viewHeight: 300,
      windowHeight: 800,
    })!;
    expect(keyboardUp.maxHeight).toBeLessThan(computePlacement(ROOMY)!.maxHeight);
  });

  it("accounts for a visual viewport that is scrolled down the page", () => {
    // Pinch-zoomed or keyboard-scrolled: the visible band starts at viewTop, so
    // the room above the anchor is measured from there, not from 0.
    const p = computePlacement({
      ...ROOMY,
      anchor: { ...ROOMY.anchor, top: 420, bottom: 452 },
      viewTop: 400,
      viewHeight: 200,
      windowHeight: 800,
    })!;
    // Below is 600-452-12 = 136; above is only 420-400-12 = 8. Must not flip.
    expect(p.top).toBe(456);
    expect(p.maxHeight).toBe(136);
  });
});
