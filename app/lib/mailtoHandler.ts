// Registering this app as the browser's handler for mailto: links. The
// browser turns a clicked link into a visit to HANDLER_URL with the whole
// link in place of %s; App reads it back with mailtoFromSearch.

// Relative imports: lib/emailFrame is bundled on its own by a spec, and pulls this in.
import { parseMailto, type MailtoFields } from "./mailto";

/** Must stay in step with `protocol_handlers` in public/manifest.webmanifest. */
export const HANDLER_PATH = "/?compose=%s";

export function canRegisterMailto(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.registerProtocolHandler === "function";
}

/**
 * Ask the browser to send mailto: links here. Only ever called from a button:
 * browsers ignore (or count against the site) a request made on page load.
 * Returns false when the browser refused outright.
 */
export function registerMailtoHandler(): boolean {
  try {
    navigator.registerProtocolHandler("mailto", `${window.location.origin}${HANDLER_PATH}`);
    return true;
  } catch {
    return false;
  }
}

/** Whoever can open the composer (App), told here so that code far from it can ask. */
let composer: ((fields: MailtoFields) => void) | null = null;

/** App registers its composer on mount. Returns the way to withdraw it. */
export function setMailtoComposer(fn: (fields: MailtoFields) => void): () => void {
  composer = fn;
  return () => {
    if (composer === fn) composer = null;
  };
}

/**
 * Open a mailto: link in the app's own composer. The link is someone else's
 * text (a received message, another website): it is parsed defensively (see
 * lib/mailto) and only ever fills the form in. Nothing is sent.
 *
 * False when it was not handled (not a mailto: link, or no composer is
 * mounted), so the caller can fall back to whatever it did before.
 */
export function openMailto(raw: string): boolean {
  if (!composer) return false;
  const fields = parseMailto(raw);
  if (!fields) return false;
  composer(fields);
  return true;
}
