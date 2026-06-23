import { describe, it, expect } from "vitest";
import { parseEditorDoc, docHasVisibleContent } from "../lib/editorDoc";

const doc = (content: unknown[]) => JSON.stringify({ type: "doc", content });

describe("parseEditorDoc", () => {
  it("accepts only parseable {type:'doc'} JSON", () => {
    expect(parseEditorDoc(doc([]))).toBeTruthy();
    expect(parseEditorDoc(`{"x":1}`)).toBeNull();
    expect(parseEditorDoc("nope")).toBeNull();
    expect(parseEditorDoc(undefined)).toBeNull();
  });
});

describe("docHasVisibleContent", () => {
  it("false for empty docs and whitespace-only text", () => {
    expect(docHasVisibleContent(doc([]))).toBe(false);
    expect(docHasVisibleContent(doc([{ type: "paragraph" }]))).toBe(false);
    expect(
      docHasVisibleContent(doc([{ type: "paragraph", content: [{ type: "text", text: "   " }] }])),
    ).toBe(false);
    expect(docHasVisibleContent(undefined)).toBe(false);
  });

  it("looks through the editor's structural nodes (globalContent store, container wrapper)", () => {
    const globalContent = {
      type: "globalContent",
      attrs: { data: { theme: "basic", styles: [{ id: "body", inputs: [] }] } },
    };
    // The real editor document shape: globalContent + container around everything.
    const wrap = (content: unknown[]) => doc([globalContent, { type: "container", content }]);
    expect(docHasVisibleContent(wrap([{ type: "paragraph" }]))).toBe(false);
    expect(
      docHasVisibleContent(wrap([{ type: "paragraph", content: [{ type: "text", text: "hi" }] }])),
    ).toBe(true);
    expect(docHasVisibleContent(wrap([{ type: "image", attrs: { src: "x" } }]))).toBe(true);
  });

  it("true for real text and for non-text blocks (image/divider/heading)", () => {
    expect(
      docHasVisibleContent(doc([{ type: "paragraph", content: [{ type: "text", text: "hi" }] }])),
    ).toBe(true);
    expect(docHasVisibleContent(doc([{ type: "image", attrs: { src: "x" } }]))).toBe(true);
    expect(docHasVisibleContent(doc([{ type: "horizontalRule" }]))).toBe(true);
    expect(docHasVisibleContent(doc([{ type: "paragraph" }, { type: "heading" }]))).toBe(true);
  });
});
