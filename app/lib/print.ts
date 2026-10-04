// Printing a conversation. The message bodies stay exactly where they are:
// each in its own sandboxed, script-less iframe under the same CSP as on
// screen (see lib/emailFrame). Nothing here builds a second copy of mail HTML
// or loosens that frame. Printing is the page itself with the app's chrome
// hidden and the conversation laid out as a document (the `printing` class,
// styled in index.css), which also means remote images print as the user has
// them: blocked ones stay blocked, shown ones are shown.
//
// The price is page breaks: a browser prints a frame as one block, so a very
// long HTML message can be cut across a page mid-line.

let holds = 0;
let wasDark = false;

/**
 * Put the page into its print layout, on screen as well: the frames have to
 * be laid out at the printed width BEFORE the browser paginates, because they
 * are sized by script and no script runs in between. Returns the way back.
 * Counted, so the reader's own print and the browser's (the menu, a
 * beforeprint from anywhere) can overlap without one undoing the other.
 */
export function enterPrintLayout(): () => void {
  const root = document.documentElement;
  if (holds++ === 0) {
    // Paper is white: a dark theme would print grey on white at best.
    wasDark = root.classList.contains("dark");
    root.classList.remove("dark");
    root.classList.add("printing");
  }
  let left = false;
  return () => {
    if (left) return;
    left = true;
    if (--holds > 0) return;
    root.classList.remove("printing");
    if (wasDark) root.classList.add("dark");
  };
}

/**
 * Resolve once every message frame under `root` has loaded and stopped
 * changing height (they re-measure themselves when the layout width changes),
 * or after `timeoutMs` at the latest: a slow frame must not block printing.
 */
export async function framesSettled(root: ParentNode, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  let last: string | null = null;
  let steady = 0;
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const frames = Array.from(root.querySelectorAll("iframe"));
    const loaded = frames.every((f) => f.contentDocument?.readyState === "complete");
    const heights = frames.map((f) => f.style.height).join(",");
    if (loaded && heights === last) {
      if (++steady >= 2) return;
    } else {
      steady = 0;
    }
    last = heights;
  }
}

/**
 * A message shorter than this is kept on one page. Comfortably under the
 * printable height of both Letter and A4 at the margins index.css sets.
 */
const KEEP_TOGETHER_PX = 860;

/**
 * Mark the messages that fit on a page, for the stylesheet to keep whole. A
 * taller one is left unmarked: asked to stay together it cannot, and the
 * attempt costs a page (its sender line alone, then the body on the next).
 */
export function markKeepTogether(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-message-open]"))) {
    el.toggleAttribute("data-print-keep", el.offsetHeight > 0 && el.offsetHeight <= KEEP_TOGETHER_PX);
  }
}
