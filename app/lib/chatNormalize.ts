export type Inline = { t: "text"; s: string } | { t: "link"; s: string; href: string };
export type Block = Inline[];
export interface NormalizedMessage {
  body: Block[];
  quoted: Block[] | null;
  signature: Block[] | null;
}

export function validateHref(href: string): string | null {
  const trimmed = href.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

export function linkifyText(s: string): Inline[] {
  const result: Inline[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(s)) !== null) {
    const pre = s.slice(last, match.index);
    if (pre) result.push({ t: "text", s: pre });
    const url = match[0];
    const validated = validateHref(url);
    if (validated) {
      result.push({ t: "link", s: url, href: validated });
    } else {
      result.push({ t: "text", s: url });
    }
    last = match.index + url.length;
  }
  const tail = s.slice(last);
  if (tail) result.push({ t: "text", s: tail });
  return result;
}

export function toBlocks(s: string): Block[] {
  const paragraphs = s.split(/\n\s*\n/);
  const blocks: Block[] = [];
  for (const para of paragraphs) {
    const collapsed = para.replace(/\n/g, " ").trim();
    if (!collapsed) continue;
    const inlines = linkifyText(collapsed);
    if (inlines.length > 0) blocks.push(inlines);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Text-source normalisation
// ---------------------------------------------------------------------------

const QUOTE_BOUNDARY_RE = /^\s*On .+ wrote:\s*$/;
const ORIGINAL_MSG_RE = /^-+ ?Original Message ?-+$/i;
const UNDERSCORES_RE = /^_{5,}$/;
const QUOTE_LINE_RE = /^\s*>/;
const SIG_DELIM_RE = /^-- ?$/;

function stripLeadingQuoteChar(line: string): string {
  return line.replace(/^\s*>\s?/, "");
}

export function normalizeText(text: string): NormalizedMessage {
  const raw = text.replace(/\r\n/g, "\n");
  const lines = raw.split("\n");

  // Find quote boundary index: first line matching a hard pattern OR the first
  // line of a contiguous trailing run of > lines.
  let boundaryIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (
      QUOTE_BOUNDARY_RE.test(l) ||
      ORIGINAL_MSG_RE.test(l) ||
      UNDERSCORES_RE.test(l)
    ) {
      boundaryIdx = i;
      break;
    }
  }

  // Check for contiguous > block at the end (if no hard boundary found yet or
  // if it starts earlier).
  for (let i = 0; i < lines.length; i++) {
    if (QUOTE_LINE_RE.test(lines[i])) {
      // Verify it's contiguous to end.
      let allQuote = true;
      for (let j = i; j < lines.length; j++) {
        if (!QUOTE_LINE_RE.test(lines[j]) && lines[j].trim() !== "") {
          allQuote = false;
          break;
        }
      }
      if (allQuote && (boundaryIdx === -1 || i < boundaryIdx)) {
        boundaryIdx = i;
      }
      break;
    }
  }

  const visibleLines = boundaryIdx === -1 ? lines : lines.slice(0, boundaryIdx);
  const quotedLines =
    boundaryIdx === -1
      ? []
      : lines.slice(boundaryIdx).map(stripLeadingQuoteChar);

  // Split visible lines on signature delimiter.
  // Only accept a `-- `/ `--` delimiter when it falls within the last 15
  // lines, to avoid mis-classifying pasted diffs or markdown horizontal rules.
  let sigIdx = -1;
  const tailStart = Math.max(0, visibleLines.length - 15);
  for (let i = 0; i < visibleLines.length; i++) {
    if (SIG_DELIM_RE.test(visibleLines[i]) && i >= tailStart) {
      sigIdx = i;
      break;
    }
  }

  const bodyLines = sigIdx === -1 ? visibleLines : visibleLines.slice(0, sigIdx);
  const sigLines = sigIdx === -1 ? [] : visibleLines.slice(sigIdx + 1);

  const body = toBlocks(bodyLines.join("\n"));
  const quoted = quotedLines.length > 0 ? toBlocks(quotedLines.join("\n")) : null;
  const signature = sigLines.length > 0 ? toBlocks(sigLines.join("\n")) : null;

  return {
    body,
    quoted: quoted && quoted.length > 0 ? quoted : null,
    signature: signature && signature.length > 0 ? signature : null,
  };
}

// ---------------------------------------------------------------------------
// HTML-source normalisation via DOMParser (inert parse — never re-injected)
// Security contract: links only for http/https/mailto; js/data URIs degrade
// to text; scripts/styles removed before extraction.
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TR",
  "BLOCKQUOTE",
]);

const QUOTED_SELECTOR =
  'blockquote, .gmail_quote, .moz-cite-prefix, [id*="OriginalMessage" i], [id*="divRplyFwdMsg" i]';

function extractInlines(node: Node): Inline[] {
  const result: Inline[] = [];
  if (node.nodeType === Node.TEXT_NODE) {
    const s = node.textContent ?? "";
    if (s) result.push(...linkifyText(s));
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === "A") {
      const href = el.getAttribute("href") ?? "";
      const validated = validateHref(href);
      const text = el.textContent ?? "";
      if (validated && text.trim()) {
        result.push({ t: "link", s: text, href: validated });
      } else if (text.trim()) {
        result.push({ t: "text", s: text });
      }
    } else if (tag === "BR") {
      // Handled as flush point in walker — return a sentinel
      result.push({ t: "text", s: "\n" });
    } else {
      for (const child of Array.from(el.childNodes)) {
        result.push(...extractInlines(child));
      }
    }
  }
  return result;
}

function walkElement(
  el: Element,
  currentBlock: Inline[],
  blocks: Block[],
  depth = 0
): Inline[] {
  // Guard against stack overflow on pathologically deep DOM trees.
  if (depth > 200) {
    // Flush whatever has accumulated and stop descending.
    if (currentBlock.length > 0) {
      blocks.push([...currentBlock]);
    }
    return [];
  }
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl = child as Element;
      const tag = childEl.tagName.toUpperCase();
      if (tag === "BR") {
        // Flush on <br>
        if (currentBlock.length > 0) {
          blocks.push([...currentBlock]);
          currentBlock = [];
        }
      } else if (BLOCK_TAGS.has(tag)) {
        // Flush current block, recurse, flush again
        if (currentBlock.length > 0) {
          blocks.push([...currentBlock]);
          currentBlock = [];
        }
        currentBlock = walkElement(childEl, [], blocks, depth + 1);
        if (currentBlock.length > 0) {
          blocks.push([...currentBlock]);
          currentBlock = [];
        }
      } else if (tag === "A") {
        const href = childEl.getAttribute("href") ?? "";
        const validated = validateHref(href);
        const text = childEl.textContent ?? "";
        if (validated && text.trim()) {
          currentBlock.push({ t: "link", s: text, href: validated });
        } else if (text.trim()) {
          currentBlock.push({ t: "text", s: text });
        }
      } else {
        currentBlock = walkElement(childEl, currentBlock, blocks, depth + 1);
      }
    } else if (child.nodeType === Node.TEXT_NODE) {
      const s = child.textContent ?? "";
      if (s.trim()) {
        currentBlock.push(...linkifyText(s));
      } else if (s && currentBlock.length > 0) {
        // Preserve whitespace between words
        currentBlock.push({ t: "text", s: " " });
      }
    }
  }
  return currentBlock;
}

function collapseWhitespace(blocks: Block[]): Block[] {
  return blocks
    .map((block) => {
      const merged: Inline[] = [];
      for (const inline of block) {
        if (
          inline.t === "text" &&
          merged.length > 0 &&
          merged[merged.length - 1].t === "text"
        ) {
          const prev = merged[merged.length - 1] as { t: "text"; s: string };
          const combined = (prev.s + inline.s).replace(/\s+/g, " ");
          merged[merged.length - 1] = { t: "text", s: combined };
        } else if (inline.t === "text") {
          const trimmed = inline.s.trim();
          if (trimmed) merged.push({ t: "text", s: inline.s.replace(/\s+/g, " ") });
          else if (merged.length > 0) merged.push({ t: "text", s: " " });
        } else {
          merged.push(inline);
        }
      }
      // Trim leading/trailing spaces
      if (merged.length > 0 && merged[0].t === "text") {
        (merged[0] as { t: "text"; s: string }).s = (merged[0] as { t: "text"; s: string }).s.trimStart();
        if (!(merged[0] as { t: "text"; s: string }).s) merged.shift();
      }
      if (merged.length > 0 && merged[merged.length - 1].t === "text") {
        const last = merged[merged.length - 1] as { t: "text"; s: string };
        last.s = last.s.trimEnd();
        if (!last.s) merged.pop();
      }
      return merged;
    })
    .filter((b) => b.length > 0);
}

export function htmlToNormalized(html: string): NormalizedMessage {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Remove unwanted elements
  doc
    .querySelectorAll("script,style,head,noscript,title")
    .forEach((el) => el.remove());

  // Remove hidden elements
  doc.querySelectorAll("[hidden]").forEach((el) => el.remove());
  doc.querySelectorAll('[aria-hidden="true"]').forEach((el) => el.remove());
  doc.querySelectorAll("[style]").forEach((el) => {
    const style = (el as HTMLElement).style;
    if (style && style.display === "none") el.remove();
  });

  // Extract quoted sections before they're removed
  const quotedBlocks: Block[] = [];
  const quotedEls = doc.querySelectorAll(QUOTED_SELECTOR);
  for (const qEl of Array.from(quotedEls)) {
    const tmpBlocks: Block[] = [];
    const leftover = walkElement(qEl, [], tmpBlocks);
    if (leftover.length > 0) tmpBlocks.push(leftover);
    const cleaned = collapseWhitespace(tmpBlocks);
    quotedBlocks.push(...cleaned);
    qEl.remove();
  }

  // Now extract visible body content
  const body = doc.body;
  if (!body) {
    return {
      body: [],
      quoted: quotedBlocks.length > 0 ? quotedBlocks : null,
      signature: null,
    };
  }

  const rawBlocks: Block[] = [];
  const leftover = walkElement(body, [], rawBlocks);
  if (leftover.length > 0) rawBlocks.push(leftover);
  const visibleBlocks = collapseWhitespace(rawBlocks);

  // Signature: find a block whose text trims to "--" or "-- "
  let sigIdx = -1;
  for (let i = 0; i < visibleBlocks.length; i++) {
    const text = visibleBlocks[i]
      .map((i) => i.s)
      .join("")
      .trim();
    if (text === "--" || text === "-- ") {
      sigIdx = i;
      break;
    }
  }

  const bodyBlocks = sigIdx === -1 ? visibleBlocks : visibleBlocks.slice(0, sigIdx);
  const sigBlocks = sigIdx === -1 ? [] : visibleBlocks.slice(sigIdx + 1);

  return {
    body: bodyBlocks,
    quoted: quotedBlocks.length > 0 ? quotedBlocks : null,
    signature: sigBlocks.length > 0 ? sigBlocks : null,
  };
}

// ---------------------------------------------------------------------------
// Main entry-point
// ---------------------------------------------------------------------------

export function normalizeMessage(input: {
  text: string;
  html: string;
}): NormalizedMessage {
  try {
    if (input.text.trim()) {
      return normalizeText(input.text);
    }
    if (input.html.trim()) {
      return htmlToNormalized(input.html);
    }
    return { body: [], quoted: null, signature: null };
  } catch {
    // Never throw into the render path. Fall back to the plain-text body if we
    // have one, else empty. (No quoted/signature splitting in the fallback.)
    const text = (input.text || "").trim();
    return { body: text ? toBlocks(text) : [], quoted: null, signature: null };
  }
}
