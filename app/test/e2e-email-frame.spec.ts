// The email iframe in a real browser: how tall it ends up, and where its links
// go. jsdom has no layout and no sandbox, so neither can be shown there.
//
// The page under test runs the REAL app/lib/emailFrame.ts (bundled below), not
// a copy of it, against a host that mirrors Reader's EmailFrame markup.
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const ORIGIN = "http://frame.test";
let bundle = "";

test.beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("../lib/emailFrame.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "EmailFrame",
  });
  bundle = out.outputFiles[0].text;
});

// Mirrors Reader's EmailFrame: a plain wrapper, and an iframe with the same
// classes' effect (block, full width, min-h-24 = 96px floor).
const HOST = `<!doctype html><html><body style="margin:0"><div id="pane" style="width:100%"><div id="holder"></div></div></body></html>`;

async function mount(page: Page, ctx: BrowserContext, html: string) {
  await ctx.route(`${ORIGIN}/`, (r) => r.fulfill({ contentType: "text/html", body: HOST }));
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate((emailHtml) => {
    const EF = (window as unknown as { EmailFrame: typeof import("../lib/emailFrame") }).EmailFrame;
    const iframe = document.createElement("iframe");
    iframe.id = "f";
    iframe.setAttribute("sandbox", EF.IFRAME_SANDBOX);
    iframe.setAttribute("scrolling", "no");
    iframe.style.cssText = "display:block;width:100%;min-height:96px;border:0;overflow:hidden;background:#fff";
    iframe.srcdoc = EF.wrapHtml(emailHtml);
    document.getElementById("holder")!.appendChild(iframe);
    EF.autoSizeEmailFrame(iframe);
  }, html);
  await page.frameLocator("#f").locator("body").waitFor();
}

const frameHeight = (page: Page) => page.evaluate(() => document.getElementById("f")!.offsetHeight);

/** Heights sampled over ~2s: a runaway frame shows up as a rising series. */
async function samples(page: Page): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(400);
    out.push(await frameHeight(page));
  }
  return out;
}

/** Bottom edge of the last element in the email, in frame coordinates. */
const contentBottom = (page: Page) =>
  page
    .frameLocator("#f")
    .locator("body")
    .evaluate((b) => Math.ceil(Math.max(...Array.from(b.querySelectorAll("*"), (el) => el.getBoundingClientRect().bottom))));

const PARAGRAPHS = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i} ${"lorem ipsum dolor sit amet ".repeat(12)}</p>`).join("");
const NEWSLETTER = `<table width="600" cellpadding="0" cellspacing="0" style="margin:0 auto;background:#f4f4f4"><tr><td style="padding:24px"><h1>News</h1>${PARAGRAPHS}</td></tr></table>`;

test.describe("auto height", () => {
  test("min-height:100vh mail settles instead of growing forever, and nothing is clipped", async ({ page, context }) => {
    await mount(page, context, `<div style="min-height:100vh;background:#eef">Hero</div><p id="footer">footer</p>`);
    const hs = await samples(page);
    expect(new Set(hs).size, `heights ${hs.join(" -> ")}`).toBe(1);
    expect(hs[0]).toBeLessThan(400);
    expect(await contentBottom(page)).toBeLessThanOrEqual(hs[0]);
  });

  test("html,body{height:100%} mail settles at its content height", async ({ page, context }) => {
    await mount(
      page,
      context,
      `<style>html,body{height:100%}</style><table height="100%" width="100%"><tr><td>${PARAGRAPHS}</td></tr></table>`,
    );
    const hs = await samples(page);
    expect(new Set(hs).size, `heights ${hs.join(" -> ")}`).toBe(1);
    const bottom = await contentBottom(page);
    expect(bottom).toBeLessThanOrEqual(hs[0]);
    expect(hs[0] - bottom).toBeLessThan(40);
  });

  test("a normal newsletter is exactly as tall as its content", async ({ page, context }) => {
    await mount(page, context, NEWSLETTER);
    const hs = await samples(page);
    expect(new Set(hs).size, `heights ${hs.join(" -> ")}`).toBe(1);
    const bottom = await contentBottom(page);
    expect(hs[0]).toBeGreaterThan(300);
    expect(Math.abs(hs[0] - bottom)).toBeLessThan(40);
  });

  test("a short plain message stays at the minimum height", async ({ page, context }) => {
    await mount(page, context, `<p>Hello</p><p>short email</p>`);
    const hs = await samples(page);
    expect(new Set(hs).size, `heights ${hs.join(" -> ")}`).toBe(1);
    expect(hs[0]).toBeGreaterThanOrEqual(96);
    expect(hs[0]).toBeLessThan(140);
  });

  for (const [name, html] of [
    ["plain flowing text", PARAGRAPHS],
    ["height:100% mail", `<style>html,body{height:100%}</style><div style="height:100%">${PARAGRAPHS}</div>`],
  ] as const) {
    test(`the frame shrinks when ${name} gets shorter (viewport widened)`, async ({ page, context }) => {
      await page.setViewportSize({ width: 360, height: 800 });
      await mount(page, context, html);
      const narrow = (await samples(page)).at(-1)!;
      await page.setViewportSize({ width: 1400, height: 800 });
      const wide = (await samples(page)).at(-1)!;
      expect(wide).toBeLessThan(narrow * 0.6);
      const bottom = await contentBottom(page);
      expect(bottom).toBeLessThanOrEqual(wide);
      expect(wide - bottom).toBeLessThan(40);
    });
  }

  test("re-measuring does not move the reading position of a scrolled pane", async ({ page, context }) => {
    await page.setViewportSize({ width: 600, height: 500 });
    await mount(page, context, NEWSLETTER);
    await samples(page);
    await page.evaluate(() => window.scrollTo(0, 99999));
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(100);
    // Same width, different height: forces a re-measure without changing the content height.
    await page.setViewportSize({ width: 600, height: 480 });
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(before);
  });
});

test.describe("an email that animates its own height", () => {
  test("is held at a stable height instead of being re-measured forever", async ({ page, context }) => {
    await mount(
      page,
      context,
      // CSS animation with its own !important (outranks the injected reset, so
      // only stripping the rule stops it), plus SMIL, which no stylesheet can.
      `<style>@keyframes grow{from{height:50px}to{height:900px}}#g{animation:grow .3s infinite alternate !important;background:#fee}</style>` +
        `<div id="g" style="animation: grow .3s infinite alternate">css</div>` +
        `<svg id="s" width="100" height="100"><animate attributeName="height" values="100;700;100" dur="0.4s" repeatCount="indefinite"/><rect width="100" height="700" fill="#eef"/></svg>` +
        `<p>after</p>`,
    );
    // The CSS animation is gone outright.
    expect(await page.frameLocator("#f").locator("#g").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    // Count measurements from here on: collapsing the frame is how one shows.
    await page.evaluate(() => {
      const f = document.getElementById("f")!;
      (window as unknown as { collapses: number }).collapses = 0;
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.oldValue !== null && (r.target as HTMLElement).style.height === "0px") {
            (window as unknown as { collapses: number }).collapses++;
          }
        }
      }).observe(f, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
    });
    await page.waitForTimeout(4000);
    const during = await page.evaluate(() => (window as unknown as { collapses: number }).collapses);
    // Once latched nothing measures any more, and the height stops moving.
    const hs = await samples(page);
    expect(new Set(hs).size, `heights ${hs.join(" -> ")}`).toBe(1);
    const after = await page.evaluate(() => (window as unknown as { collapses: number }).collapses);
    expect(after).toBe(during);
    expect(during).toBeLessThanOrEqual(61);
    expect(hs[0]).toBeGreaterThan(96);
  });
});

test.describe("links", () => {
  const DEST = `<title>nojs</title><h1>dest</h1><script>document.title = "JS RAN"</script>`;
  const MAIL =
    `<a id="plain" href="http://dest.test/a">plain link</a> ` +
    `<a id="self" target="_self" href="http://dest.test/b">self link</a> ` +
    `<a id="blank" target="_blank" rel="opener" href="http://dest.test/c">blank link</a> ` +
    `<svg width="120" height="30" xmlns:xlink="http://www.w3.org/1999/xlink">` +
    `<a id="svg" xlink:href="http://dest.test/d" target="_blank" rel="opener"><rect width="120" height="30" fill="#ccd"/></a></svg> ` +
    `<svg width="120" height="30"><a id="svghref" href="http://dest.test/e" target="_top"><rect width="120" height="30" fill="#dcc"/></a></svg> ` +
    `<img id="mapimg" usemap="#m" width="60" height="30" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">` +
    `<map name="m"><area id="area" shape="rect" coords="0,0,60,30" href="http://dest.test/f"></map> ` +
    `<a id="js" href="javascript:document.body.setAttribute('data-js','1')">js link</a> ` +
    `<a id="data" href="data:text/html,<script>opener.document.title='pwned'</script>">data link</a> ` +
    `<a id="own" href="/api/send">own-origin link</a> ` +
    `<form id="form" action="http://dest.test/form" method="get" target="_blank"><input name="q" value="1"><button id="submit">go</button></form>` +
    `<script>document.body.setAttribute("data-ran", "1")</script>`;

  async function openMail(page: Page, context: BrowserContext) {
    const hits: string[] = [];
    await context.route("http://dest.test/**", (r) => {
      hits.push(new URL(r.request().url()).pathname);
      return r.fulfill({ contentType: "text/html", body: DEST });
    });
    await mount(page, context, MAIL);
    return { frame: page.frames().find((f) => f !== page.mainFrame())!, hits };
  }

  async function expectCleanTab(popup: Page, page: Page, path: string) {
    await popup.waitForLoadState();
    expect(new URL(popup.url()).pathname).toBe(path);
    // The destination is a normal page: its scripts run (it is the parent's
    // popup, never a sandboxed one).
    expect(await popup.title()).toBe("JS RAN");
    // It has no handle on, and no referrer from, the inbox.
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(await popup.evaluate(() => document.referrer)).toBe("");
    // The message itself did not navigate, and the top page did not either.
    expect(page.url()).toBe(`${ORIGIN}/`);
    expect(await page.frameLocator("#f").locator("#plain").count()).toBe(1);
  }

  for (const [id, path] of [
    ["plain", "/a"],
    ["self", "/b"],
    ["blank", "/c"],
    ["svg", "/d"],
    ["svghref", "/e"],
  ] as const) {
    test(`a ${id} link opens a working, opener-less tab and leaves the message in place`, async ({ page, context }) => {
      const { frame } = await openMail(page, context);
      const [popup] = await Promise.all([context.waitForEvent("page"), frame.click(`#${id}`)]);
      await expectCleanTab(popup, page, path);
    });
  }

  test("an image-map area link does the same", async ({ page, context }) => {
    const { frame } = await openMail(page, context);
    const [popup] = await Promise.all([context.waitForEvent("page"), frame.click("#mapimg")]);
    await expectCleanTab(popup, page, "/f");
  });

  test("Enter on a focused link and a middle click are handled the same way", async ({ page, context }) => {
    const { frame } = await openMail(page, context);
    await frame.focus("#self");
    const [byKey] = await Promise.all([context.waitForEvent("page"), page.keyboard.press("Enter")]);
    await expectCleanTab(byKey, page, "/b");
    const [byMiddle] = await Promise.all([context.waitForEvent("page"), frame.click("#blank", { button: "middle" })]);
    await expectCleanTab(byMiddle, page, "/c");
  });

  test("javascript:, data: and own-origin links are inert, and a form cannot submit", async ({ page, context }) => {
    const { frame, hits } = await openMail(page, context);
    let opened = 0;
    context.on("page", () => opened++);
    for (const id of ["js", "data", "own", "submit"]) await frame.click(`#${id}`);
    await frame.focus("#submit");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    expect(opened).toBe(0);
    expect(hits).toEqual([]);
    expect(page.url()).toBe(`${ORIGIN}/`);
    expect(await page.title()).not.toBe("pwned");
    const body = page.frameLocator("#f").locator("body");
    expect(await body.getAttribute("data-js")).toBeNull();
    expect(await page.frameLocator("#f").locator("#plain").count()).toBe(1);
  });

  test("with the parent's listener removed, links are dead rather than dangerous", async ({ page, context }) => {
    const hits: string[] = [];
    await context.route("http://dest.test/**", (r) => {
      hits.push(r.request().url());
      return r.fulfill({ contentType: "text/html", body: DEST });
    });
    // Mount the bare frame: same sandbox and document, none of the on-load work.
    await context.route(`${ORIGIN}/`, (r) => r.fulfill({ contentType: "text/html", body: HOST }));
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ content: bundle });
    await page.evaluate((emailHtml) => {
      const EF = (window as unknown as { EmailFrame: typeof import("../lib/emailFrame") }).EmailFrame;
      const iframe = document.createElement("iframe");
      iframe.id = "f";
      iframe.setAttribute("sandbox", EF.IFRAME_SANDBOX);
      iframe.style.cssText = "display:block;width:100%;height:300px;border:0";
      iframe.srcdoc = EF.wrapHtml(emailHtml);
      document.getElementById("holder")!.appendChild(iframe);
    }, MAIL);
    await page.frameLocator("#f").locator("#plain").waitFor();
    const frame = page.frames().find((f) => f !== page.mainFrame())!;
    let opened = 0;
    context.on("page", () => opened++);
    for (const id of ["plain", "blank", "svg"]) await frame.click(`#${id}`);
    await page.waitForTimeout(500);
    expect(opened).toBe(0);
    expect(hits).toEqual([]);
  });

  test("scripts in the email still never run", async ({ page, context }) => {
    await mount(page, context, MAIL);
    expect(await page.frameLocator("#f").locator("body").getAttribute("data-ran")).toBeNull();
  });
});
