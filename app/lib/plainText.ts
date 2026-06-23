// Plain-text → HTML seeding for the rich compose editor. Reply prefills are
// plain text with "> "-quoted lines (built in App.tsx buildReplyInitial); the
// editor wants HTML, so quotes become <blockquote> and paragraphs stay intact.

/** Minimal HTML escape for text destined for editor content. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert plain text into simple editor HTML: blank lines separate <p>
 * paragraphs, single newlines become <br>, and runs of ">"-prefixed lines
 * (one quoting level — the only kind buildReplyInitial produces) become a
 * <blockquote>. LEADING blank lines are preserved as one empty paragraph —
 * that's where the caret lands in a reply, above the quoted history. Returns
 * "" for empty input so callers can fall back to the editor's own
 * empty-document default.
 */
export function plainTextToHtml(text: string): string {
  if (!text) return "";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  if (lines[0]?.trim() === "" && lines.some((l) => l.trim() !== "")) {
    out.push("<p></p>");
  }
  let para: string[] = [];
  let quote: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote><p>${quote.join("<br>")}</p></blockquote>`);
    quote = [];
  };
  for (const raw of lines) {
    if (/^>\s?/.test(raw)) {
      flushPara();
      quote.push(escapeHtml(raw.replace(/^>\s?/, "")));
      continue;
    }
    flushQuote();
    if (raw.trim() === "") {
      flushPara();
      continue;
    }
    para.push(escapeHtml(raw));
  }
  flushPara();
  flushQuote();
  return out.join("");
}
