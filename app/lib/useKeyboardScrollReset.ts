import { useEffect } from "react";

/**
 * iOS keyboard scroll-trap recovery. Focusing an input near the BOTTOM of the
 * screen (the inline reply composer) makes iOS scroll the page itself to
 * clear the keyboard. The app shell is a fixed full-height overflow-hidden
 * layout that never expects window scroll — when the keyboard dismisses, iOS
 * can leave that offset behind, cutting off the top of the app (including
 * the back arrow) with no way to scroll back.
 *
 * "Keyboard closed" is judged against the LARGEST visual-viewport height seen
 * at the current width (not window.innerHeight: under
 * interactive-widget=resizes-content the layout viewport shrinks WITH the
 * keyboard, which would make an innerHeight comparison read "closed" while
 * it's open). Width changes (rotation) reset the baseline. Never corrects
 * while the keyboard is open — that would yank the focused field out of view.
 */
export function useKeyboardScrollReset() {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    let baseWidth = 0;
    let maxHeight = 0;

    const keyboardClosed = () => {
      const vv = window.visualViewport;
      if (!vv) return true;
      if (vv.width !== baseWidth) {
        // New orientation/size class — start a fresh baseline.
        baseWidth = vv.width;
        maxHeight = vv.height;
      } else if (vv.height > maxHeight) {
        maxHeight = vv.height;
      }
      return vv.height >= maxHeight - 50;
    };

    const reset = () => {
      if (keyboardClosed() && window.scrollY !== 0) window.scrollTo(0, 0);
    };
    const onResize = () => reset();
    // focusout fires before iOS finishes collapsing the keyboard; defer — and
    // cancel if focus lands on another field (field-to-field moves must not
    // jolt the page mid-typing).
    const onFocusOut = () => {
      clearTimeout(t);
      t = setTimeout(reset, 120);
    };
    const onFocusIn = () => clearTimeout(t);

    keyboardClosed(); // seed the baseline before any keyboard appears
    window.visualViewport?.addEventListener("resize", onResize);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      clearTimeout(t);
      window.visualViewport?.removeEventListener("resize", onResize);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);
}
