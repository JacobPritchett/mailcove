// HTML → plain text for everything that needs to READ an HTML email body
// without rendering it: the list snippet, the full-text index, the AI
// transcript, and the stored `text` of a message that arrived with no text
// part (which is what reply quoting uses).
//
// The input is whatever a stranger chose to send, so two properties matter
// more than fidelity:
//
// - LINEAR time. This is a single forward scan. Every search either consumes
//   what it skipped or, when it finds nothing, is never attempted again, so no
//   input makes the scanner re-read the same bytes. The `/<[^>]+>/g` strip this
//   replaces was quadratic: 80 KB of "<" cost seconds per pass and ~250 KB got
//   the Worker killed mid-ingest, which a try/catch cannot rescue.
// - BOUNDED input. Anything past MAX_HTML_TEXT_INPUT is ignored.
//
// It is not a sanitizer. The output is plain text for indexing and quoting and
// is never written back into a page as markup.

/** Characters of HTML examined; the rest of an oversized body is ignored. */
export const MAX_HTML_TEXT_INPUT = 1_000_000;

/** Elements whose CONTENT is not text the reader ever sees, each with the
 *  pattern that finds its closing tag. */
const closer = (name: string) => new RegExp(`</${name}(?![A-Za-z0-9])`, "gi");
const DROP_CONTENT = new Map<string, RegExp>(
  ["script", "style", "title", "template"].map((name) => [name, closer(name)]),
);
/** <head> ends at </head>, or at <body> when the close tag was omitted. */
const HEAD_END = /<\/head(?![A-Za-z0-9])|<body(?![A-Za-z0-9])/gi;

/** Elements that start or end a line. */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "br", "caption", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tr", "ul",
]);

/** Elements that separate words without breaking the line (table cells). */
const SPACER = new Set(["td", "th"]);

// Common named entities. Anything not listed is left exactly as written.
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  zwnj: "", zwj: "", shy: "", lrm: "", rlm: "",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±",
  times: "×", divide: "÷", micro: "µ", para: "¶", sect: "§",
  middot: "·", bull: "•", hellip: "…", prime: "′", Prime: "″",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»",
  lsaquo: "‹", rsaquo: "›", dagger: "†", Dagger: "‡",
  euro: "€", pound: "£", yen: "¥", cent: "¢", curren: "¤",
  frac12: "½", frac14: "¼", frac34: "¾", iexcl: "¡", iquest: "¿",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
  check: "✓", hearts: "♥", ne: "≠", le: "≤", ge: "≥",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å",
  ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", ntilde: "ñ",
  ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", szlig: "ß",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Auml: "Ä", Aring: "Å",
  Ccedil: "Ç", Egrave: "È", Eacute: "É", Ntilde: "Ñ",
  Ouml: "Ö", Oslash: "Ø", Uuml: "Ü", aelig: "æ", AElig: "Æ",
};

// One entity, anchored at lastIndex (sticky). Every quantifier is bounded, so a
// failed match costs a constant amount of work however long the input is.
const ENTITY = /&(#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const TAG_NAME = /[A-Za-z][A-Za-z0-9]*/y;
const NEXT_SPECIAL = /[<&]/g;
const WHITESPACE = /\s+/g;
// Invisible characters marketing mail pads its preheader with: soft hyphen,
// combining grapheme joiner, Arabic letter mark, zero-width space/joiners and
// direction marks, word joiner and its neighbours, BOM.
const INVISIBLE = /[­͏؜​-‏⁠-⁤﻿]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function decodeEntity(body: string): string | null {
  if (body[0] !== "#") return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : null;
  const hex = body[1] === "x" || body[1] === "X";
  const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
  if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
  const ch = String.fromCodePoint(cp);
  // A decoded control or whitespace character is a word break, nothing more:
  // never let `&#10;` or `&#0;` put a raw control character into stored text.
  return CONTROL.test(ch) || /\s/.test(ch) ? " " : ch;
}

/**
 * Convert an HTML document or fragment to readable plain text.
 *
 * Drops the contents of script/style/title/template and of <head>, drops
 * comments, decodes common named and all numeric entities, turns block
 * boundaries and <br> into newlines (at most one blank line in a row), and
 * collapses every other run of whitespace to a single space.
 */
export function htmlToText(input: string | null | undefined): string {
  if (!input) return "";
  const html = input.length > MAX_HTML_TEXT_INPUT ? input.slice(0, MAX_HTML_TEXT_INPUT) : input;
  const n = html.length;
  const out: string[] = [];
  // Set once a search runs to the end without a hit, so it is never repeated:
  // this is what keeps "<a<a<a…" and "<head><head>…" linear.
  let noMoreGt = false;
  let quoteAware = true;
  let headUnclosed = false;

  /** Index of the ">" closing the tag opened at `from`, or -1. */
  const tagEnd = (from: number): number => {
    if (noMoreGt) return -1;
    if (quoteAware) {
      // A ">" inside a quoted attribute value does not end the tag.
      let quote = 0;
      for (let j = from + 1; j < n; j++) {
        const c = html.charCodeAt(j);
        if (quote) {
          if (c === quote) quote = 0;
        } else if (c === 34 || c === 39) quote = c;
        else if (c === 62) return j;
      }
      // An unbalanced quote swallowed the rest of the document. Stop trusting
      // quotes from here on (one wasted scan, never a second).
      quoteAware = false;
    }
    const j = html.indexOf(">", from + 1);
    if (j === -1) noMoreGt = true;
    return j;
  };

  /** Position of the next match of `re` at or after `from`, or -1. */
  const find = (re: RegExp, from: number): number => {
    re.lastIndex = from;
    const m = re.exec(html);
    return m ? m.index : -1;
  };

  let i = 0;
  while (i < n) {
    const next = find(NEXT_SPECIAL, i);
    if (next === -1) {
      out.push(html.slice(i).replace(WHITESPACE, " "));
      break;
    }
    if (next > i) out.push(html.slice(i, next).replace(WHITESPACE, " "));
    i = next;

    if (html.charCodeAt(i) === 38 /* & */) {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(html);
      const decoded = m ? decodeEntity(m[1]) : null;
      if (m && decoded !== null) {
        out.push(decoded);
        i += m[0].length;
      } else {
        out.push("&");
        i++;
      }
      continue;
    }

    // "<": a comment, a tag, or just a less-than sign in running text.
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end === -1) break; // unterminated comment hides the rest, as in a browser
      i = end + 3;
      continue;
    }
    let p = i + 1;
    const closing = html.charCodeAt(p) === 47; /* / */
    if (closing) p++;
    TAG_NAME.lastIndex = p;
    const nameMatch = TAG_NAME.exec(html);
    const declaration = !closing && (html.charCodeAt(p) === 33 /* ! */ || html.charCodeAt(p) === 63); /* ? */
    if (!nameMatch && !declaration) {
      out.push("<");
      i++;
      continue;
    }
    const end = tagEnd(i);
    if (end === -1) {
      // No ">" anywhere ahead: this was never a tag.
      out.push("<");
      i++;
      continue;
    }
    i = end + 1;
    if (!nameMatch) continue; // <!doctype …>, <?xml …?>, <![endif]>

    const name = nameMatch[0].toLowerCase();
    if (BLOCK.has(name)) out.push("\n");
    else if (SPACER.has(name)) out.push(" ");
    if (closing) continue;

    const dropUntil = DROP_CONTENT.get(name);
    if (dropUntil) {
      const close = find(dropUntil, i);
      if (close === -1) break; // unterminated: the rest is its content
      i = close;
    } else if (name === "head" && !headUnclosed) {
      const close = find(HEAD_END, i);
      if (close === -1) headUnclosed = true;
      else i = close;
    }
  }

  return out
    .join("")
    .replace(INVISIBLE, "")
    .replace(/ {2,}/g, " ")
    .replace(/ ?\n[ \n]*/g, (run) => (run.indexOf("\n") !== run.lastIndexOf("\n") ? "\n\n" : "\n"))
    .trim();
}
