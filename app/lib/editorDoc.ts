// Helpers over stringified TipTap documents (drafts, send gating).

/** Parse a stored doc; null unless it's a plausible TipTap document. */
export function parseEditorDoc(json: string | undefined): object | null {
  if (!json) return null;
  try {
    const doc = JSON.parse(json) as { type?: unknown };
    return doc && typeof doc === "object" && doc.type === "doc" ? (doc as object) : null;
  } catch {
    return null;
  }
}

/**
 * Does the document render anything? True for any non-whitespace text OR any
 * node beyond empty paragraphs (image, divider, button, heading, …) — used to
 * ship HTML for rich bodies whose plaintext serialization is empty.
 */
export function docHasVisibleContent(json: string | undefined): boolean {
  const doc = parseEditorDoc(json);
  if (!doc) return false;
  function nodeHas(n: unknown): boolean {
    if (!n || typeof n !== "object") return false;
    const node = n as { type?: string; text?: string; content?: unknown[] };
    if (node.type === "text") return !!node.text && node.text.trim() !== "";
    // globalContent is the editor's invisible theme/styles store (seeded into
    // every doc by the theme config) — it never renders anything.
    if (node.type === "globalContent") return false;
    // container is the structural wrapper every document carries — it renders
    // nothing itself, so look through it at its children.
    if (node.type && !["doc", "container", "paragraph", "hardBreak"].includes(node.type)) return true;
    return Array.isArray(node.content) && node.content.some(nodeHas);
  }
  return nodeHas(doc);
}
