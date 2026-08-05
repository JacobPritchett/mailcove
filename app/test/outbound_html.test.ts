// Mail sent from here arrived looking like a broken mailing-list template:
// forced onto white in clients that dark-mode everything else, and with no
// spacing at all. The cause was the editor serialising a full marketing
// document — doctype, <head>, `x-apple-disable-message-reformatting`, nested
// presentation tables, a 600px cap and a forced font stack — for what is a
// two-line personal note.
//
// These pin BOTH halves: the chrome goes, and nothing the user wrote goes with
// it. The second half matters more — silently dropping someone's paragraph is
// far worse than an ugly one.
import { describe, it, expect } from "vitest";
import { toEmailFragment } from "../lib/outboundHtml";

/** The shape @react-email/editor really produces (captured from a live send). */
function wrap(content: string): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">
  <head>
    <meta content="width=device-width" name="viewport" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta content="telephone=no,address=no,email=no,date=no,url=no" name="format-detection" />
  </head>
  <body dir="ltr" lang="en">
    <!--$--><!--html-->
    <div data-type="globalContent" style="height:1px;visibility:hidden"></div>
    <table border="0" width="100%" role="presentation" align="center">
      <tbody><tr><td style="font-family:-apple-system, sans-serif;font-size:1em;min-height:100%;line-height:155%">
        <table align="left" width="100%" role="presentation" style="max-width:600px;line-height:155%">
          <tbody><tr style="width:100%"><td style="padding-top:0px;padding-right:0px;padding-bottom:0px;padding-left:0px">
            ${content}
          </td></tr></tbody>
        </table>
      </td></tr></tbody>
    </table>
    <!--/$-->
  </body>
</html>`;
}

const P = (t: string) =>
  `<p class="node-paragraph" style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">${t}</p>`;

describe("toEmailFragment — the chrome", () => {
  it("sends a bare fragment, not a document", () => {
    const out = toEmailFragment(wrap(P("Hi Bob,")));
    expect(out).toBe('<div dir="ltr"><p>Hi Bob,</p></div>');
  });

  it("drops the meta that tells Apple Mail not to re-theme the message", () => {
    // This is the specific reason it would not follow the recipient's dark mode.
    expect(toEmailFragment(wrap(P("hi")))).not.toContain("x-apple-disable-message-reformatting");
  });

  it("drops the doctype, head and format-detection metas", () => {
    const out = toEmailFragment(wrap(P("hi")));
    expect(out).not.toMatch(/doctype/i);
    expect(out).not.toContain("<head");
    expect(out).not.toContain("format-detection");
  });

  it("unwraps the layout tables", () => {
    const out = toEmailFragment(wrap(P("hi")));
    expect(out).not.toContain("<table");
    expect(out).not.toContain("<td");
  });

  it("drops the 600px cap and the forced font stack", () => {
    const out = toEmailFragment(wrap(P("hi")));
    expect(out).not.toContain("max-width");
    expect(out).not.toContain("font-family");
    expect(out).not.toContain("line-height");
  });

  it("drops the per-paragraph margin:0 that suppressed the client's own spacing", () => {
    // With these gone the recipient's default paragraph margins apply, which is
    // the "margins my client normally infers" the report was about.
    const out = toEmailFragment(wrap(P("hi")));
    expect(out).not.toContain("margin");
    expect(out).not.toContain("padding");
  });

  it("removes the editor's hidden state marker and React's hydration comments", () => {
    const out = toEmailFragment(wrap(P("hi")));
    expect(out).not.toContain("globalContent");
    expect(out).not.toContain("<!--");
  });

  it("removes class names that point at stylesheets the recipient never loads", () => {
    expect(toEmailFragment(wrap(P("hi")))).not.toContain("class=");
  });
});

describe("toEmailFragment — the content", () => {
  it("keeps every block, in order", () => {
    const out = toEmailFragment(wrap(P("one") + P("two") + P("three")));
    expect(out).toBe('<div dir="ltr"><p>one</p><p>two</p><p>three</p></div>');
  });

  it("keeps inline formatting and links", () => {
    const out = toEmailFragment(
      wrap(P('a <strong>b</strong> <em>c</em> <a href="https://example.com">d</a>')),
    );
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain("<em>c</em>");
    expect(out).toContain('href="https://example.com"');
  });

  it("keeps lists, headings, quotes and rules", () => {
    const rich =
      '<h1 style="font-weight: 600;">Title</h1>' +
      "<ul><li><p>one</p></li><li><p>two</p></li></ul>" +
      '<ol start="1"><li><p>first</p></li></ol>' +
      '<blockquote style="border-left: 3px solid rgb(172,179,190); color: rgb(126,138,154);"><p>quoted</p></blockquote>' +
      "<hr>";
    const out = toEmailFragment(wrap(rich));
    for (const frag of ["<h1", "<ul>", "<ol", "<li>", "<blockquote", "<hr"]) {
      expect(out).toContain(frag);
    }
    // A reply's quoted history has to stay visually distinct, so the quote's
    // border must survive — it is styling the user sees, not layout chrome.
    expect(out).toContain("border-left");
  });

  it("keeps images", () => {
    const out = toEmailFragment(wrap('<p><img src="https://example.com/a.png" alt="a"></p>'));
    expect(out).toContain('src="https://example.com/a.png"');
    expect(out).toContain('alt="a"');
  });

  it("keeps styles the user CHOSE", () => {
    // Colour and alignment are intent; stripping them would lose meaning.
    const out = toEmailFragment(
      wrap('<p style="color:#c00;text-align:center;font-weight:700;margin:0;padding:0">loud</p>'),
    );
    expect(out).toContain("color");
    expect(out).toContain("text-align");
    expect(out).toContain("font-weight");
  });

  it("keeps a table the USER inserted", () => {
    // Only `role="presentation"` marks a table as scaffolding.
    const out = toEmailFragment(wrap("<table><tbody><tr><td>data</td></tr></tbody></table>"));
    expect(out).toContain("<table>");
    expect(out).toContain("data");
  });

  it("does not join two inline elements separated only by a line break", () => {
    // The pretty-printer breaks lines between inline tags, leaving a
    // whitespace-ONLY text node. That is the dangerous case: removing it as
    // "indentation" would render "bolditalic" as one word.
    const out = toEmailFragment(wrap(P("<strong>bold</strong>\n      <em>italic</em>")));
    expect(out).toMatch(/<\/strong>\s+<em>/);
    expect(out).not.toContain("</strong><em>");
  });

  it("still drops whitespace BETWEEN blocks, where it is only indentation", () => {
    const out = toEmailFragment(wrap("<p>one</p>\n      <p>two</p>"));
    expect(out).toBe('<div dir="ltr"><p>one</p><p>two</p></div>');
  });

  it("leaves whitespace inside <pre> alone", () => {
    const out = toEmailFragment(wrap("<pre><code>line one\n    indented\n</code></pre>"));
    expect(out).toContain("line one\n    indented");
  });

  it("carries an rtl document direction through", () => {
    const rtl = wrap(P("שלום")).replace('<html dir="ltr"', '<html dir="rtl"');
    expect(toEmailFragment(rtl)).toContain('dir="rtl"');
  });

  it("returns empty for empty input so the caller can send text only", () => {
    expect(toEmailFragment("")).toBe("");
    expect(toEmailFragment("   ")).toBe("");
  });
});
