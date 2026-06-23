import { describe, it, expect } from "vitest";
import { escapeHtml, plainTextToHtml } from "../lib/plainText";

describe("escapeHtml", () => {
  it("escapes the four HTML-significant characters", () => {
    expect(escapeHtml(`<b>&"x"</b>`)).toBe("&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;");
  });
});

describe("plainTextToHtml", () => {
  it("returns '' for empty input", () => {
    expect(plainTextToHtml("")).toBe("");
  });

  it("splits paragraphs on blank lines, keeps single newlines as <br>", () => {
    expect(plainTextToHtml("a\nb\n\nc")).toBe("<p>a<br>b</p><p>c</p>");
  });

  it("turns runs of '> ' lines into a blockquote (reply prefill shape)", () => {
    expect(plainTextToHtml("Thanks!\n\nOn Tue, Alice wrote:\n> hi there\n> bye")).toBe(
      "<p>Thanks!</p><p>On Tue, Alice wrote:</p><blockquote><p>hi there<br>bye</p></blockquote>",
    );
  });

  it("preserves LEADING blank lines as one empty paragraph (reply caret line)", () => {
    expect(plainTextToHtml("\n\nOn Tue, Alice wrote:\n> hi")).toBe(
      "<p></p><p>On Tue, Alice wrote:</p><blockquote><p>hi</p></blockquote>",
    );
    // Whitespace-only input still yields nothing.
    expect(plainTextToHtml("\n\n\n")).toBe("");
  });

  it("escapes HTML inside lines and quotes; handles CRLF", () => {
    expect(plainTextToHtml("a <script>\r\n> q & r")).toBe(
      "<p>a &lt;script&gt;</p><blockquote><p>q &amp; r</p></blockquote>",
    );
  });

  it("bare '>' counts as a quote line; quote runs split paragraphs", () => {
    expect(plainTextToHtml("x\n>\n> y\nz")).toBe(
      "<p>x</p><blockquote><p><br>y</p></blockquote><p>z</p>",
    );
  });
});
