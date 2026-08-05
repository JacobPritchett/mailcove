// Turn the editor's rendered email into something that looks like personal mail.
//
// @react-email/editor serialises to a full marketing-newsletter document: an
// XHTML Transitional doctype, a <head>, TWO `x-apple-disable-message-
// reformatting` metas, nested `role="presentation"` layout tables, a 600px
// max-width container, and a forced font stack, font-size and line-height. For
// a newsletter that is all correct. For "Hi Bob, are we still on for Thursday?"
// it is why the message arrives looking like a broken mailing-list template.
//
// Two specific consequences the recipient sees:
//
//   * It will not follow their dark mode. `x-apple-disable-message-
//     reformatting` asks Apple Mail not to touch the message, and clients
//     generally only re-theme SIMPLE messages — a full document of layout
//     tables reads as a designed email and is left on white.
//   * It has no spacing. Every paragraph carries `margin:0;padding:0`, so the
//     default paragraph margins the client would otherwise apply are
//     suppressed and the text sits flush against the edge.
//
// What Gmail and Apple Mail actually put on the wire for the same message is a
// bare fragment — no doctype, no head, no tables, no width cap, no fonts — and
// the receiving client styles it. That is what this produces.
//
// It works by UNWRAPPING the real DOM rather than re-serialising from the
// document model: every node the user wrote is carried across as-is, so a node
// type nobody remembered to handle cannot be silently dropped.

/** Layout-only styles the editor injects. Everything else is the user's. */
const STRIPPED_PROPERTIES = [
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-family",
  "font-size",
  "line-height",
  "min-height",
  "max-width",
];

/**
 * Properties expressing what the user CHOSE are kept: colour, alignment,
 * weight, decoration. Stripping those would lose intent, not chrome.
 */
function stripLayoutStyles(el: HTMLElement) {
  for (const prop of STRIPPED_PROPERTIES) el.style.removeProperty(prop);
  if (el.getAttribute("style") === "") el.removeAttribute("style");
}

/** Replace an element with its children, in place. */
function unwrap(el: Element) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/** Block-level tags: whitespace BETWEEN two of these is only indentation. */
const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "DD", "DT",
  "FIGURE", "FIGCAPTION", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY",
  "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** React's hydration markers survive the render and are pure noise on the wire. */
function removeComments(root: HTMLElement) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const doomed: Comment[] = [];
  while (walker.nextNode()) doomed.push(walker.currentNode as Comment);
  for (const c of doomed) c.remove();
}

/**
 * Drop the pretty-printer's indentation, which unwrapping the tables leaves
 * behind as a stack of blank lines.
 *
 * Only whitespace BETWEEN block elements goes: the space in
 * `<span>a</span> <span>b</span>` is meaningful text and must survive, so a
 * whitespace node with an inline neighbour is left alone. `<pre>` is skipped
 * entirely — there whitespace IS the content.
 */
function removeIndentation(root: HTMLElement) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const doomed: Text[] = [];
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (t.data.trim() !== "") continue;
    if (t.parentElement?.closest("pre")) continue;
    const before = t.previousElementSibling;
    const after = t.nextElementSibling;
    const okBefore = !before || BLOCK.has(before.tagName);
    const okAfter = !after || BLOCK.has(after.tagName);
    if (okBefore && okAfter) doomed.push(t);
  }
  for (const t of doomed) t.remove();

  // Indentation at the START and END of a block is also the pretty-printer's,
  // not the writer's. HTML collapses it either way; trimming just stops the
  // sent source reading like a generated template.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (!BLOCK.has(el.tagName) || el.closest("pre")) continue;
    const first = el.firstChild;
    if (first?.nodeType === 3) first.textContent = first.textContent!.replace(/^\s+/, "");
    const last = el.lastChild;
    if (last?.nodeType === 3) last.textContent = last.textContent!.replace(/\s+$/, "");
  }
}

/**
 * Convert the editor's full email document into a minimal HTML fragment.
 *
 * Returns "" for empty input so the caller can fall back to text/plain rather
 * than send an empty HTML part.
 */
export function toEmailFragment(fullHtml: string): string {
  const source = (fullHtml ?? "").trim();
  if (!source) return "";
  if (typeof DOMParser === "undefined") return source;

  const doc = new DOMParser().parseFromString(source, "text/html");
  const body = doc.body;
  if (!body) return source;

  // The editor plants a zero-height marker node to carry document-level state.
  // It is not content and renders as a stray empty block in some clients.
  body.querySelectorAll('[data-type="globalContent"]').forEach((el) => el.remove());

  // Unwrap layout tables innermost-first, so a cell's contents are lifted
  // before the table around it disappears. `role="presentation"` is exactly the
  // marker that says "this table is scaffolding, not data" — a real table the
  // user inserted has no such role and survives untouched.
  const layout = Array.from(body.querySelectorAll('table[role="presentation"]'));
  for (const table of layout.reverse()) {
    table.querySelectorAll("tbody, tr, td, th").forEach(unwrap);
    unwrap(table);
  }

  body.querySelectorAll<HTMLElement>("[style]").forEach(stripLayoutStyles);

  removeComments(body);
  removeIndentation(body);

  // Class names refer to editor stylesheets the recipient will never load.
  body.querySelectorAll("[class]").forEach((el) => el.removeAttribute("class"));

  const inner = body.innerHTML.trim();
  if (!inner) return "";
  // dir is worth keeping: it is the one piece of document-level context that
  // actually affects how the text reads.
  const dir = doc.documentElement.getAttribute("dir") === "rtl" ? "rtl" : "ltr";
  return `<div dir="${dir}">${inner}</div>`;
}
