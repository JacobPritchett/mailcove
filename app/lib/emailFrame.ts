// Everything about the sandboxed email-body iframe that is not React: the
// document it is given, and how the parent sizes and hardens it after load.
// Kept free of React so the real-browser check (app/test/e2e-email-frame.spec.ts)
// can drive exactly this code.

import { openMailto } from "./mailtoHandler";

/**
 * Sandbox for every email-body iframe.
 *
 * - NO `allow-scripts`. This is the load-bearing guarantee: mail can never run
 *   code, which is also the only reason `allow-same-origin` is safe.
 * - `allow-same-origin` lets the PARENT reach the frame's contentDocument: to
 *   size it, and to handle its link clicks (see interceptLinks). With scripts
 *   blocked, the email cannot use the same-origin grant for anything.
 * - NO `allow-popups`, and so no `allow-popups-to-escape-sandbox` either. The
 *   frame never opens anything itself. A link is opened by the parent, from a
 *   click listener the parent registered, with `noopener,noreferrer`; the tab
 *   that results is the parent's popup, an ordinary unsandboxed page with no
 *   opener. Granting the frame popups would only matter for a link the parent
 *   failed to intercept, and that is exactly the link that must not open: it
 *   could carry `rel="opener"`, or sit somewhere a DOM query does not look
 *   (an SVG `xlink:href`, a declarative shadow root). Without the grant such a
 *   link is dead instead of dangerous.
 */
export const IFRAME_SANDBOX = "allow-same-origin";

const MEDIA_ORIGIN = typeof location !== "undefined" ? location.origin : "";

/**
 * Strict CSP applied to every email-body iframe. `default-src 'none'` blocks ALL
 * remote subresource loads (scripts, remote images/tracking pixels, fonts,
 * frames). Inline styles and data:-URI images/fonts are allowed so legit HTML
 * email still renders. Reused unchanged for every message in a conversation.
 */
export const CSP =
  `default-src 'none'; img-src data: ${MEDIA_ORIGIN}/api/media; style-src 'unsafe-inline'; font-src data:; base-uri 'none'`;

// Injected into every email document: a viewport so fixed-width (e.g. 600px
// table) newsletters don't overflow on mobile, theme-aware defaults for simple
// rich messages, and a small reset so images/tables never exceed the reading
// column. Email HTML that brings its own backgrounds still wins; plain HTML
// messages inherit an app-theme surface instead of a forced white body.
// Animations and transitions are off: a letter has no business animating, and
// one that animates its own height would have the frame chase it forever (the
// email's own rules are stripped as well, see pinViewportUnits, since an
// !important of its own would outrank this one).
const BASE_STYLE =
  "html{color-scheme:light}html[data-app-theme='dark']{color-scheme:dark}*,*::before,*::after{animation:none!important;transition:none!important}body{box-sizing:border-box;margin:0;background:#fff;color:#1a1a1a;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}a{color:#2563eb}html[data-app-theme='dark'] body:not([data-email-background='true']){background:#0f172a;color:#e5e7eb}html[data-app-theme='dark'] body:not([data-email-background='true']) a{color:#93c5fd!important}html[data-app-theme='dark'] body:not([data-email-background='true']) :where(p,div,span,font,td,th,li,strong,em,b,i,h1,h2,h3,h4,h5,h6,blockquote){color:inherit!important;background-color:transparent!important}img{max-width:100%;height:auto}table{max-width:100%}";

function emailDeclaresBackground(html: string): boolean {
  return /(?:style\s*=\s*["'][^"']*background(?:-[a-z]+)?\s*:|\bbgcolor\s*=|\bbackground\s*=)/i.test(html);
}

function appThemeOf(doc: Document | undefined): "dark" | "light" {
  return doc?.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Wrap untrusted email HTML so the CSP meta is the first thing in <head>.
 *
 * `<base target="_blank">` is defence in depth: with no popup permission a
 * `_blank` navigation goes nowhere, so even a link that escaped both the click
 * interception and the attribute pass cannot replace the message with its
 * destination. It carries no href, so the CSP's `base-uri 'none'` (which stops
 * the email re-basing its own URLs) does not apply to it, and being first it
 * wins over any <base> the email ships. The referrer meta keeps this app's URL
 * out of the Referer header of anything the frame requests.
 *
 * The two data attributes drive the theme rules in BASE_STYLE: the app theme at
 * render time (kept current by autoSizeEmailFrame), and whether the email
 * paints a background of its own.
 */
export function wrapHtml(html: string): string {
  const theme = appThemeOf(typeof document !== "undefined" ? document : undefined);
  const hasBackground = emailDeclaresBackground(html) ? "true" : "false";
  return `<!doctype html><html data-app-theme="${theme}"><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><base target="_blank"><meta name="referrer" content="no-referrer"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><style>${BASE_STYLE}</style></head><body data-email-background="${hasBackground}">${html}</body></html>`;
}

const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * The link target an element carries, in any namespace: HTML `a`/`area`, SVG
 * `a` (which may use `href` or the older `xlink:href`), MathML. `<base>` and
 * `<link>` have an href but are not something a user can click.
 */
function hrefOf(el: Element): string | null {
  const name = el.localName;
  if (name === "base" || name === "link") return null;
  return el.getAttribute("href") ?? el.getAttributeNS(XLINK_NS, "href");
}

/**
 * Attribute hardening, as defence in depth behind interceptLinks: every
 * element that carries a link target, in any namespace, is pointed at a new
 * tab with `rel="noopener noreferrer"` (replacing whatever `rel` the email
 * chose, `opener` included). With no popup permission on the frame that new
 * tab cannot actually open; what this guarantees is that no link navigates the
 * frame itself. Run once on load: with scripts blocked the DOM cannot change
 * afterwards. Same-document fragment links keep `_self` so they can scroll.
 */
export function hardenLinks(doc: Document): void {
  doc.querySelectorAll("*").forEach((el) => {
    const href = hrefOf(el);
    if (href === null) return;
    el.setAttribute("target", href.trim().startsWith("#") ? "_self" : "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  });
}

/** The only schemes a link in an email may open. */
const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Resolve a link from an email to the URL the parent may open, or null.
 *
 * Only http, https and mailto. Anything that resolves to this app's own origin
 * is refused too: the frame's base URL is the app's, so a relative link (or an
 * absolute one aimed at the inbox) would open one of our own endpoints with
 * the user's session.
 */
export function safeLinkUrl(raw: string, base: string): string | null {
  const href = raw.trim();
  if (!href || href.startsWith("#")) return null;
  let url: URL;
  let own: URL;
  try {
    url = new URL(href, base);
    own = new URL(base);
  } catch {
    return null;
  }
  if (!LINK_SCHEMES.has(url.protocol)) return null;
  if (url.protocol !== "mailto:" && url.origin === own.origin) return null;
  return url.href;
}

/** What interceptLinks needs of the parent window (narrow, so tests can fake it). */
export interface LinkOpener {
  open(url: string, target: string, features: string): unknown;
  location: { href: string };
}

/**
 * Make opening a link something the PARENT does.
 *
 * The parent registers capture-phase listeners on the frame's document. They
 * run in the parent's realm, so the frame's script ban does not stop them,
 * and capture on the document sees every click before the element does. Each
 * click is cancelled, always: the frame never navigates and never opens
 * anything by itself, whether or not we could see what was clicked (a link
 * inside a closed shadow root is invisible here, and cancelling regardless is
 * what keeps it inert). If the click was on a link with an allowed URL, the
 * parent opens it in a new tab with no opener and no referrer.
 *
 * Keyboard activation (Enter on a focused link) arrives as a click, and a
 * middle click as auxclick, so both are covered. The cost is that nothing else
 * in an email reacts to a click either (a <details>, a checkbox); for mail
 * that is the right trade.
 *
 * Returns a cleanup function.
 */
export function interceptLinks(doc: Document, opener: LinkOpener): () => void {
  const onClick = (event: Event) => {
    event.preventDefault();
    // composedPath sees into open shadow roots; fall back to walking parents.
    let path: EventTarget[] = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.length === 0) {
      for (let n = event.target as Node | null; n; n = n.parentNode) path.push(n);
    }
    let href: string | null = null;
    for (const node of path) {
      // nodeType check, not instanceof: these nodes belong to the frame's realm.
      if ((node as Node).nodeType !== 1) continue;
      href = hrefOf(node as Element);
      if (href !== null) break;
    }
    if (href === null) return;
    if (href.trim().startsWith("#")) {
      const id = decodeURIComponent(href.trim().slice(1));
      const target = id ? (doc.getElementById(id) ?? doc.getElementsByName(id)[0]) : null;
      target?.scrollIntoView();
      return;
    }
    const url = safeLinkUrl(href, opener.location.href);
    if (!url) return;
    // An address in a message is written to from here, not from whatever
    // mail program the device happens to have registered.
    if (/^mailto:/i.test(url) && openMailto(url)) return;
    opener.open(url, "_blank", "noopener,noreferrer");
  };
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("auxclick", onClick, true);
  return () => {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("auxclick", onClick, true);
  };
}

/** A length in viewport-height units (vh, dvh, svh, lvh, vb and friends). */
const VIEWPORT_HEIGHT_UNIT = /(-?\d*\.?\d+)[dsl]?v[hb]\b/gi;

function pinDeclaration(style: CSSStyleDeclaration, refPx: number): void {
  // Animations and transitions go entirely (collected first: removing while
  // indexing would skip entries).
  const moving: string[] = [];
  for (let i = 0; i < style.length; i++) {
    if (/^(animation|transition)/.test(style[i])) moving.push(style[i]);
  }
  for (const prop of moving) style.removeProperty(prop);
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    const value = style.getPropertyValue(prop);
    if (!value || !/v[hb]\b/i.test(value)) continue;
    // "At least a screen tall" has no meaning in a frame that is sized to its
    // content, so a minimum collapses to nothing. Any other use (an explicit
    // height, padding) keeps the size it would have had in a browser window.
    const base = /^min-(height|block-size)$/.test(prop) ? 0 : refPx;
    style.setProperty(
      prop,
      value.replace(VIEWPORT_HEIGHT_UNIT, (_m, n: string) => `${(parseFloat(n) * base) / 100}px`),
      style.getPropertyPriority(prop),
    );
  }
}

/** Upper bound on style rules rewritten per message, so hostile CSS cannot stall the reader. */
const MAX_PINNED_RULES = 5000;

/**
 * Replace viewport-height units in the email's own CSS with fixed pixels.
 *
 * The frame is sized to its content, so inside it "the viewport" IS the
 * content height. `min-height:100vh` followed by a footer therefore describes a
 * document that is always taller than its frame: sizing the frame to fit makes
 * the document taller again, forever. There is no height that satisfies it, so
 * the dependency has to be removed rather than measured around. `refPx` is the
 * app window's height, which is what the units would have meant in a browser.
 *
 * The same pass removes the email's animation and transition declarations: an
 * animated height is another document with no settled size.
 */
export function pinViewportUnits(doc: Document, refPx: number): void {
  let budget = MAX_PINNED_RULES;
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (budget-- <= 0) return;
      const r = rule as Partial<CSSStyleRule> & Partial<CSSGroupingRule>;
      if (r.style) pinDeclaration(r.style, refPx);
      if (r.cssRules) walk(r.cssRules);
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      // unreadable sheet: nothing to pin
    }
  }
  doc.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    if (budget-- > 0) pinDeclaration(el.style, refPx);
  });
}

/**
 * Decide whether an email needs breathing room inside its card.
 *
 * A newsletter ships its own full-width coloured canvas and must stay flush to
 * the card edge, or a gutter appears around a design that was meant to bleed.
 * An ordinary reply arrives as a bare `<div dir="ltr">` with no margins at all
 * and would otherwise sit jammed against the border. Decided by measuring the
 * rendered document rather than pattern-matching the HTML, because "does this
 * paint to the edge" is a layout question and only layout can answer it.
 */
export function applyBodyPadding(doc: Document): void {
  const body = doc.body;
  const view = doc.defaultView;
  if (!body || !view) return;
  // Writing an unchanged value would still be a style mutation, and this runs
  // from a ResizeObserver-adjacent path — assign only on a real change so it
  // cannot feed itself.
  const set = (v: string) => {
    if (body.style.padding !== v) body.style.padding = v;
  };
  // The padding must come out of the body's height, not add to it. Mail that
  // sets `body{height:100%}` would otherwise always be one padding taller than
  // its frame, whatever height the frame is given, and lose its last lines.
  if (body.style.boxSizing !== "border-box") body.style.boxSizing = "border-box";
  const bleeds = Array.from(body.children).some((el) => {
    const bg = view.getComputedStyle(el).backgroundColor;
    // rgba(...,0) and "transparent" both mean nothing is painted.
    if (!bg || bg === "transparent" || /,\s*0\s*\)$/.test(bg)) return false;
    return el.getBoundingClientRect().width >= body.clientWidth - 2;
  });
  set(bleeds ? "0px" : "16px");
}

/**
 * The document's content height, measured with the frame collapsed.
 *
 * `scrollHeight` is never less than the viewport, and percentage heights
 * (`html,body{height:100%}`, `<table height="100%">`) resolve against it, so
 * measuring at the frame's current height can only ever report "at least as
 * tall as it already is": the frame could grow but never shrink. Collapsing it
 * first (to its CSS min-height, the floor it has anyway) makes the answer
 * independent of whatever height it had before.
 *
 * The collapse is undone by the caller in the same task, so it is never
 * painted. The parent element holds the old height meanwhile: reading layout
 * here lays out the app too, and a momentarily shorter thread would clamp the
 * reading pane's scroll position.
 */
export function measureContentHeight(iframe: HTMLIFrameElement): number | null {
  const doc = iframe.contentDocument;
  if (!doc?.documentElement) return null;
  const holder = iframe.parentElement;
  const before = iframe.style.height;
  if (holder) holder.style.minHeight = `${iframe.offsetHeight}px`;
  iframe.style.height = "0px";
  const height = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
  iframe.style.height = before;
  if (holder) holder.style.minHeight = "";
  return height;
}

/** Observer-driven measurements allowed in one burst before the frame is latched. */
const MAX_AUTO_FITS = 60;
/** A burst ends after this long with no observer activity. */
const QUIET_MS = 2000;

/**
 * Keep a sandboxed email iframe exactly as tall as its content, so short mail
 * does not get a tall empty box and long mail does not get a nested scrollbar
 * (the reading pane scrolls instead). Also applies the on-load work that needs
 * the parsed document: link handling, viewport units, edge padding.
 *
 * Returns a cleanup function.
 */
export function autoSizeEmailFrame(iframe: HTMLIFrameElement): () => void {
  const win = iframe.ownerDocument.defaultView;
  let ro: ResizeObserver | undefined;
  let raf = 0;
  let stopLinks: (() => void) | undefined;
  // Backstop for a document whose height never settles (CSS animation is
  // stripped, but SVG SMIL can still animate a size). Legitimate late changes
  // are finite: images and fonts arriving. So observer-driven measurements are
  // budgeted per burst, the check comes BEFORE the measurement (measuring is
  // the expensive part), and a document that spends the budget is latched: the
  // observer is disconnected and the frame is left at the tallest height it
  // reached, until the next load or window resize.
  let autoFits = 0;
  let lastAutoFit = 0;
  let latched = false;
  let tallest = 0;

  const observe = () => {
    const doc = iframe.contentDocument;
    ro?.disconnect();
    if (doc && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(schedule);
      ro.observe(doc.documentElement);
      if (doc.body) ro.observe(doc.body);
    }
  };

  const fit = (explicit: boolean) => {
    try {
      const now = Date.now();
      if (explicit) {
        autoFits = 0;
        tallest = 0;
        if (latched) {
          latched = false;
          observe();
        }
      } else {
        if (latched) return;
        if (now - lastAutoFit > QUIET_MS) autoFits = 0;
        lastAutoFit = now;
        if (++autoFits > MAX_AUTO_FITS) {
          latched = true;
          ro?.disconnect();
          if (tallest > 0) iframe.style.height = `${tallest}px`;
          return;
        }
      }
      const next = measureContentHeight(iframe);
      if (next === null) return;
      tallest = Math.max(tallest, next);
      const value = `${next}px`;
      if (iframe.style.height !== value) iframe.style.height = value;
    } catch {
      // Opaque-origin frame (shouldn't happen with allow-same-origin) — keep
      // the CSS fallback height.
    }
  };

  // Observer callbacks are coalesced into the next frame: resizing an observed
  // element from inside its own callback is what "ResizeObserver loop" means.
  function schedule() {
    if (raf || !win) return;
    raf = win.requestAnimationFrame(() => {
      raf = 0;
      fit(false);
    });
  }

  // The frame's document carries the app theme as an attribute (see
  // BASE_STYLE). Keep it current when the user switches theme mid-read.
  const syncTheme = () => {
    try {
      const doc = iframe.contentDocument;
      if (doc?.documentElement) doc.documentElement.dataset.appTheme = appThemeOf(iframe.ownerDocument);
    } catch {
      /* ignore */
    }
  };

  const onLoad = () => {
    syncTheme();
    try {
      const doc = iframe.contentDocument;
      if (doc && win) {
        // First, and on its own: if anything below throws, links must already
        // be in the parent's hands.
        stopLinks?.();
        stopLinks = interceptLinks(doc, win);
      }
    } catch {
      /* without it links are dead, not dangerous: the frame has no popup grant */
    }
    try {
      const doc = iframe.contentDocument;
      if (doc) {
        hardenLinks(doc);
        pinViewportUnits(doc, win?.innerHeight ?? 0);
        applyBodyPadding(doc);
      }
    } catch {
      /* ignore - the sandbox and CSP hold regardless of this pass */
    }
    latched = false;
    fit(true);
    try {
      observe();
    } catch {
      /* ignore */
    }
  };
  iframe.addEventListener("load", onLoad);
  if (iframe.contentDocument?.readyState === "complete") onLoad();

  // Whether an email paints to the edge is a LAYOUT answer, so it can change
  // when the viewport does: a newsletter whose fixed-width table stops
  // spanning the frame at a narrow width needs the padding a wide one does
  // not. The height changes with the width too, in both directions.
  const onResize = () => {
    try {
      if (iframe.contentDocument) applyBodyPadding(iframe.contentDocument);
    } catch {
      /* cosmetic */
    }
    fit(true);
  };
  win?.addEventListener("resize", onResize);

  const themeObserver =
    typeof MutationObserver !== "undefined" ? new MutationObserver(syncTheme) : undefined;
  themeObserver?.observe(iframe.ownerDocument.documentElement, { attributes: true, attributeFilter: ["class"] });
  syncTheme();

  return () => {
    themeObserver?.disconnect();
    iframe.removeEventListener("load", onLoad);
    win?.removeEventListener("resize", onResize);
    if (raf) win?.cancelAnimationFrame(raf);
    ro?.disconnect();
    stopLinks?.();
  };
}
