import { describe, it, expect } from "vitest";
import { htmlToText, MAX_HTML_TEXT_INPUT } from "../htmlText";
import { bodyForIndex } from "../search";
import { buildTranscript } from "../ai";
import { clampUtf8 } from "../push";

// Generous on purpose: the quadratic version took seconds to minutes on these
// inputs, so this still fails loudly on a regression, without flaking when the
// machine is busy running other suites.
const BUDGET_MS = 2000;

describe("htmlToText", () => {
  it("drops style, script, title and head contents", () => {
    const html =
      "<html><head><title>Sale now on</title><style>.a{color:red} p>b{x:y}</style>" +
      "<meta charset=utf-8></head><body><script>var a = '<p>no</p>';</script><p>Hello</p>" +
      "<style>.late{}</style><p>World</p></body></html>";
    expect(htmlToText(html)).toBe("Hello\n\nWorld");
  });

  it("drops a head whose close tag was omitted, up to <body>", () => {
    expect(htmlToText("<head><meta name=x content='a b'><body><p>Hi</p>")).toBe("Hi");
  });

  it("drops comments, including Outlook conditionals, and declarations", () => {
    expect(htmlToText("<!DOCTYPE html><?xml version='1.0'?>a<!-- hidden <b>x</b> -->b<!--[if mso]><p>mso only</p><![endif]-->c")).toBe("abc");
  });

  it("decodes named and numeric entities", () => {
    expect(htmlToText("Tom &amp; Jerry &lt;tj@x.com&gt; &quot;hi&quot; &#39;x&#39; &copy; &#169; &#xA9; &#x1F600; caf&eacute;"))
      .toBe("Tom & Jerry <tj@x.com> \"hi\" 'x' © © © \u{1F600} café");
  });

  it("leaves unknown or malformed entities as written", () => {
    expect(htmlToText("AT&T &bogus; &amp &#; a & b")).toBe("AT&T &bogus; &amp &#; a & b");
  });

  it("never lets a numeric entity produce a control character or an invalid code point", () => {
    expect(htmlToText("a&#0;b&#10;c&#x1b;d&#xD800;e&#99999999;f")).toBe("a�b c d�e�f");
  });

  it("turns nbsp into a space and strips zero-width preheader padding", () => {
    expect(htmlToText("Big&nbsp;sale&zwnj;&nbsp;&zwnj;&nbsp;&#847;&#8203;&shy; today")).toBe("Big sale today");
  });

  it("puts block boundaries and <br> on new lines and collapses other whitespace", () => {
    expect(htmlToText("<div>one</div><div>two<br>three</div>\n\n   <p>four\n   five</p>")).toBe("one\n\ntwo\nthree\n\nfour five");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toBe("a\n\nb");
    expect(htmlToText("<p>a</p><br><br><br><br><p>b</p>")).toBe("a\n\nb");
  });

  it("does not split words at inline tags, and separates table cells", () => {
    expect(htmlToText("he<b>ll</b>o <a href='https://x.test/?a=1&amp;b=2'>link</a>")).toBe("hello link");
    expect(htmlToText("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>")).toBe("a b\n\nc");
  });

  it("does not end a tag at a > inside a quoted attribute", () => {
    expect(htmlToText('<a title="a > b" href="#">x</a> y')).toBe("x y");
  });

  it("keeps a bare less-than sign in running text", () => {
    expect(htmlToText("1 < 2 and 3 <4 but a<b")).toBe("1 < 2 and 3 <4 but a<b");
  });

  it("returns an empty string for nothing", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText(null)).toBe("");
    expect(htmlToText(undefined)).toBe("");
  });

  it("ignores input past the cap", () => {
    const html = "a".repeat(MAX_HTML_TEXT_INPUT) + "TAIL";
    const text = htmlToText(html);
    expect(text.length).toBe(MAX_HTML_TEXT_INPUT);
    expect(text).not.toContain("TAIL");
  });
});

// The strip this replaced was quadratic on sender-controlled input: 80 KB of
// "<" cost ~2.6 s per pass and ~250 KB got the Worker killed mid-ingest. Each
// case below is a shape that defeats a naive scanner; a linear one handles a
// megabyte of any of them in a few milliseconds.
describe("htmlToText stays linear on hostile input", () => {
  const MB = 1_000_000;
  const cases: Record<string, string> = {
    "run of <": "<".repeat(MB),
    "run of <a": "<a".repeat(MB / 2),
    "run of < with a late >": "<".repeat(MB - 1) + ">",
    "run of </": "</".repeat(MB / 2),
    "run of &": "&".repeat(MB),
    "run of &#": "&#".repeat(MB / 2),
    "run of &amp without ;": "&amp".repeat(MB / 4),
    "unterminated comments": "<!--".repeat(MB / 4),
    "unterminated styles": "<style>".repeat(MB / 7),
    "unclosed heads": "<head>".repeat(MB / 6),
    "empty styles": "<style></style>".repeat(MB / 15),
    "alternating quotes in tags": `<a '> <a "> `.repeat(MB / 12),
    "one open quote then tags": `<a "` + "<b>".repeat(MB / 3),
    "run of >": ">".repeat(MB),
    "run of spaces": " ".repeat(MB),
    "run of newlines": "\n".repeat(MB),
    "run of <br>": "<br>".repeat(MB / 4),
    "space newline pairs": " \n".repeat(MB / 2),
    "nested divs": "<div>".repeat(MB / 5),
  };
  for (const [label, input] of Object.entries(cases)) {
    it(label, () => {
      const start = performance.now();
      htmlToText(input);
      expect(performance.now() - start).toBeLessThan(BUDGET_MS);
    });
  }

  it("the three callers that used the quadratic strip are fast too", () => {
    const html = "<".repeat(250_000);
    const start = performance.now();
    bodyForIndex("", html);
    buildTranscript([{ direction: "in", msg_from: "a@x.com", date: 1, body: { text: "", html } }]);
    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
  });
});

describe("bodyForIndex and buildTranscript on HTML-only bodies", () => {
  const html = "<html><head><style>.preheader{display:none}</style></head><body><p>Tom &amp; Jerry</p></body></html>";
  it("index the visible text, not the stylesheet", () => {
    expect(bodyForIndex("", html)).toBe("Tom & Jerry");
    expect(bodyForIndex("   ", html)).toBe("Tom & Jerry");
  });
  it("give the model the visible text", () => {
    expect(buildTranscript([{ direction: "in", msg_from: "a@x.com", date: 1, body: { html } }])).toBe("a@x.com: Tom & Jerry");
  });
  it("still prefer a real text part", () => {
    expect(bodyForIndex("plain  text", html)).toBe("plain text");
  });
});

describe("clampUtf8", () => {
  it("clamps by encoded bytes without splitting a character", () => {
    expect(clampUtf8("héllo", 2)).toBe("h"); // "h" + half of a 2-byte char does not fit
    expect(clampUtf8("héllo", 3)).toBe("hé");
    expect(clampUtf8("\u{1F600}\u{1F600}", 7)).toBe("\u{1F600}");
    expect(clampUtf8("\u{1F600}", 3)).toBe("");
    expect(clampUtf8("abc", 0)).toBe("");
  });
  it("never exceeds the byte budget", () => {
    const samples = ["x".repeat(500), "é".repeat(500), "中".repeat(500), "\u{1F600}".repeat(500), "a\ud800b".repeat(200)];
    for (const s of samples) {
      for (const max of [0, 1, 2, 3, 4, 5, 99, 100, 300]) {
        expect(new TextEncoder().encode(clampUtf8(s, max)).length).toBeLessThanOrEqual(max);
      }
    }
  });
  it("is fast on a very long string", () => {
    const start = performance.now();
    clampUtf8("x".repeat(1_000_000), 300);
    clampUtf8("\u{1F600}".repeat(500_000), 300);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
