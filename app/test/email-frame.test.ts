import { describe, it, expect, vi } from "vitest";
import { IFRAME_SANDBOX, CSP, wrapHtml, hardenLinks, pinViewportUnits, interceptLinks, safeLinkUrl } from "@/lib/emailFrame";

function docOf(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("email frame document", () => {
  it("grants the frame nothing but same-origin: no scripts, no popups, no forms, no navigation", () => {
    // Links are opened by the parent (interceptLinks), so the frame itself
    // needs no popup permission at all. A link the parent somehow missed can
    // then do nothing, rather than open a tab that escaped the sandbox.
    expect(IFRAME_SANDBOX).toBe("allow-same-origin");
  });

  it("keeps default-src 'none' and puts the CSP before anything else in head", () => {
    expect(CSP).toMatch(/^default-src 'none';/);
    const html = wrapHtml("<p>hi</p>");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<base"));
    expect(html).toContain(`<head><meta http-equiv="Content-Security-Policy"`);
  });

  it("sends plain links to a new tab via a base target that precedes the email's own markup", () => {
    const doc = docOf(wrapHtml(`<base target="_self"><a href="https://example.com/">x</a>`));
    const first = doc.querySelector("base")!;
    expect(first.getAttribute("target")).toBe("_blank");
    expect(first.hasAttribute("href")).toBe(false);
    expect(doc.querySelector('meta[name="referrer"]')!.getAttribute("content")).toBe("no-referrer");
  });
});

describe("hardenLinks", () => {
  it("forces every link to a new opener-less tab, whatever target the email chose", () => {
    const doc = docOf(
      `<a id="a" href="https://a.example/">a</a>` +
        `<a id="b" href="https://b.example/" target="_self" rel="opener">b</a>` +
        `<a id="c" href="https://c.example/" target="_top">c</a>` +
        `<map><area id="d" href="https://d.example/"></map>`,
    );
    hardenLinks(doc);
    for (const id of ["a", "b", "c", "d"]) {
      const el = doc.getElementById(id)!;
      expect(el.getAttribute("target")).toBe("_blank");
      expect(el.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("leaves same-document fragment links scrolling in place", () => {
    const doc = docOf(`<a id="f" href="#section">jump</a>`);
    hardenLinks(doc);
    expect(doc.getElementById("f")!.getAttribute("target")).toBe("_self");
  });
});

describe("pinViewportUnits", () => {
  it("drops viewport-relative minimum heights and pins other uses to the reference height", () => {
    // The live jsdom document: a DOMParser document has no styleSheets.
    const doc = document;
    doc.head.innerHTML =
      `<style>.hero{min-height:100vh}.tall{height:50vh}@media (min-width:1px){.m{min-height:100dvh}}</style>`;
    doc.body.innerHTML = `<div id="inline" style="min-height: 100vh; padding-top: 10vh; width: 50vw">x</div>`;
    pinViewportUnits(doc, 800);

    const rules = Array.from(doc.styleSheets[0].cssRules) as CSSStyleRule[];
    expect(rules[0].style.getPropertyValue("min-height")).toBe("0px");
    expect(rules[1].style.getPropertyValue("height")).toBe("400px");
    const nested = (rules[2] as unknown as CSSMediaRule).cssRules[0] as CSSStyleRule;
    expect(nested.style.getPropertyValue("min-height")).toBe("0px");

    const inline = doc.getElementById("inline")!;
    expect(inline.style.minHeight).toBe("0px");
    expect(inline.style.paddingTop).toBe("80px");
    // Width units are not the problem and are left alone.
    expect(inline.style.width).toBe("50vw");
  });
});

describe("hardenLinks across namespaces", () => {
  it("hardens SVG links (href and xlink:href) and strips any opener", () => {
    const doc = docOf(
      `<svg xmlns:xlink="http://www.w3.org/1999/xlink">` +
        `<a id="x" xlink:href="https://attacker.example/" target="_blank" rel="opener"><text>x</text></a>` +
        `<a id="h" href="https://attacker.example/" target="_top"><text>h</text></a></svg>`,
    );
    hardenLinks(doc);
    for (const id of ["x", "h"]) {
      const el = doc.getElementById(id)!;
      expect(el.getAttribute("target")).toBe("_blank");
      expect(el.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });
});

describe("safeLinkUrl", () => {
  const base = "https://inbox.example/";
  it.each([
    ["https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["http://example.com/", "http://example.com/"],
    ["mailto:a@example.com", "mailto:a@example.com"],
    ["  https://example.com/x  ", "https://example.com/x"],
  ])("allows %s", (raw, out) => {
    expect(safeLinkUrl(raw, base)).toBe(out);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://inbox.example/abc",
    "file:///etc/passwd",
    "vbscript:x",
    "",
    "#section",
    // Relative and same-origin URLs resolve to the inbox itself: an email has
    // no business sending the user to one of this app's own endpoints.
    "/api/threads/t1/mutate",
    "https://inbox.example/?thread=x",
    "//inbox.example/x",
    "http://[bad",
  ])("refuses %s", (raw) => {
    expect(safeLinkUrl(raw, base)).toBeNull();
  });
});

describe("interceptLinks", () => {
  function setup(html: string) {
    const doc = docOf(html);
    const open = vi.fn();
    const stop = interceptLinks(doc, { open, location: { href: "https://inbox.example/" } });
    const click = (id: string, type = "click") => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true });
      doc.getElementById(id)!.dispatchEvent(e);
      return e;
    };
    return { doc, open, stop, click };
  }

  it("opens an HTML link from the parent, opener-less, and stops the frame navigating", () => {
    const { open, click } = setup(`<a id="a" href="https://example.com/x" target="_self"><b id="inner">go</b></a>`);
    const e = click("inner");
    expect(e.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/x", "_blank", "noopener,noreferrer");
  });

  it("handles an SVG xlink:href link that asks for an opener", () => {
    const { open, click } = setup(
      `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://attacker.example/" target="_blank" rel="opener"><text id="t">x</text></a></svg>`,
    );
    const e = click("t");
    expect(e.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://attacker.example/", "_blank", "noopener,noreferrer");
  });

  it("handles area links and middle clicks", () => {
    const { open, click } = setup(`<map><area id="ar" href="https://example.com/area"></map>`);
    expect(click("ar", "auxclick").defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/area", "_blank", "noopener,noreferrer");
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "/api/send"])("makes a %s link inert", (href) => {
    const { open, click } = setup(`<a id="a" href="${href}">x</a>`);
    expect(click("a").defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("consumes clicks that are not on a link too, so nothing it cannot see can navigate", () => {
    const { open, click } = setup(`<p id="p">text</p>`);
    expect(click("p").defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("scrolls to a same-document fragment instead of opening anything", () => {
    const { doc, open, click } = setup(`<a id="a" href="#end">jump</a><p id="end">end</p>`);
    const into = vi.fn();
    doc.getElementById("end")!.scrollIntoView = into;
    click("a");
    expect(open).not.toHaveBeenCalled();
    expect(into).toHaveBeenCalledTimes(1);
  });

  it("stops intercepting after cleanup", () => {
    const { open, click, stop } = setup(`<a id="a" href="https://example.com/">x</a>`);
    stop();
    expect(click("a").defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("layout animation", () => {
  it("is switched off in the injected stylesheet and stripped from the email's own rules", () => {
    expect(wrapHtml("")).toMatch(/animation:none!important/);
    expect(wrapHtml("")).toMatch(/transition:none!important/);

    const doc = document;
    doc.head.innerHTML = `<style>#grow{animation:grow 1s infinite !important;transition:height 1s;color:red}</style>`;
    doc.body.innerHTML = `<div id="inline" style="animation: grow 2s infinite; height: 10px">x</div>`;
    pinViewportUnits(doc, 800);
    const rule = doc.styleSheets[0].cssRules[0] as CSSStyleRule;
    expect(rule.style.getPropertyValue("animation")).toBe("");
    expect(rule.style.getPropertyValue("animation-name")).toBe("");
    expect(rule.style.getPropertyValue("transition")).toBe("");
    expect(rule.style.getPropertyValue("color")).toBe("red");
    const inline = doc.getElementById("inline")!;
    expect(inline.style.getPropertyValue("animation")).toBe("");
    expect(inline.style.height).toBe("10px");
  });
});
