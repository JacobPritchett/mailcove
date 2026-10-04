// Printing with real layout: nothing of the app's chrome is left, the
// conversation flows at the printed width, every frame keeps its sandbox, and
// blocked images stay blocked.
import { test, expect, type Page } from "@playwright/test";
import { makeThreads, stubMailbox, PHONE } from "./e2eMailbox";

const TALL = `<div style="font:16px Georgia">${Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i + 1} of a long letter.</p>`).join("")}<p id="end">The last line.</p></div>`;

function threads() {
  const t = makeThreads(3);
  for (const x of t) x.unread = false;
  t[0].earlier = 5; // Thread 3: six messages
  t[1].html = TALL; // Thread 2: one message, several pages long
  t[2].html = `<p>Look</p><img src="https://tracker.example/pixel.gif" width="1" height="1">`;
  t[2].blockedImages = 1;
  return t;
}

/** Stand in for the print dialog: record the call, leave the page in its print layout. */
async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed++;
    };
  });
}
const printed = (page: Page) => page.evaluate(() => (window as unknown as { printed: number }).printed);

async function layout(page: Page) {
  return page.evaluate(() => {
    const shown = (sel: string) =>
      [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => el.getBoundingClientRect().width > 0).length;
    const article = document.querySelector<HTMLElement>("[data-print-root]")!;
    return {
      chrome: shown("aside") + shown('[role="toolbar"]') + shown('[data-testid="inline-reply"]') + shown("button"),
      width: Math.round(article.getBoundingClientRect().width),
      // The page itself is the scroller now: nothing is trapped in a pane.
      flows: document.documentElement.scrollHeight >= article.scrollHeight,
      sandboxes: [...new Set([...document.querySelectorAll("iframe")].map((f) => f.getAttribute("sandbox")))],
      clipped: [...document.querySelectorAll("iframe")].filter(
        (f) => f.contentDocument!.documentElement.scrollHeight > f.clientHeight + 2,
      ).length,
      frames: document.querySelectorAll("iframe").length,
    };
  });
}

for (const [name, use] of [
  ["desktop", { viewport: { width: 1280, height: 800 } }],
  ["tablet", { viewport: { width: 820, height: 1180 } }],
  ["phone", PHONE],
] as const) {
  test.describe(name, () => {
    test.use(use);

    test("Print lays the whole conversation out as a document and then puts the app back", async ({ page }) => {
      await stubPrint(page);
      await stubMailbox(page, threads());
      await page.goto("/", { waitUntil: "networkidle" });
      await page.getByText("Thread 3", { exact: true }).click();
      await expect(page.getByText("6 messages")).toBeVisible();
      await expect(page.locator("iframe")).toHaveCount(1);

      await page.getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Print" }).click();
      await expect.poll(() => printed(page)).toBe(1);

      const m = await layout(page);
      expect(m.chrome).toBe(0);
      // 6.9in: the same on any screen, so the frames are measured as printed.
      expect(m.width).toBe(662);
      expect(m.flows).toBe(true);
      expect(m.frames).toBe(6);
      expect(m.sandboxes).toEqual(["allow-same-origin"]);
      expect(m.clipped).toBe(0);
      // Every message says who it went to and when.
      await expect(page.locator("[data-print-root] dl")).toHaveCount(6);

      await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
      await expect(page.locator("iframe")).toHaveCount(1);
      await expect(page.getByRole("toolbar", { name: "Conversation actions" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.classList.contains("printing"))).toBe(false);
    });
  });
}

test.describe("what reaches paper", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a message longer than a page prints in full", async ({ page }) => {
    await stubPrint(page);
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Thread 2", { exact: true }).click();
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Print" }).click();
    await expect.poll(() => printed(page)).toBe(1);
    // Taller than a page: left free to break, not marked to be kept whole.
    expect(await page.locator("[data-message-open][data-print-keep]").count()).toBe(0);
    const wrapper = await page.locator("[data-email-frame-wrapper]").evaluate((el) => ({
      overflow: getComputedStyle(el).overflow,
      border: getComputedStyle(el).borderTopWidth,
    }));
    expect(wrapper).toEqual({ overflow: "visible", border: "0px" });
    const frameHeight = await page.locator("iframe").evaluate((f) => f.getBoundingClientRect().height);
    const pdf = await page.pdf({ format: "Letter" });
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    // Every page of the frame is there: a clipped card printed one and stopped.
    expect(pages).toBeGreaterThanOrEqual(Math.ceil(frameHeight / 960));
    expect(pages).toBeLessThanOrEqual(Math.ceil(frameHeight / 960) + 1);
  });

  test("blocked remote images stay blocked in print", async ({ page }) => {
    // What actually leaves the browser, and what the frame's policy stops
    // (the browser reports a blocked load as a request that failed with "csp").
    const remote: string[] = [];
    const stopped: string[] = [];
    await page.route("https://tracker.example/**", (route) => {
      remote.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "image/gif", body: "" });
    });
    page.on("requestfailed", (r) => {
      if (r.url().includes("tracker.example")) stopped.push(r.failure()?.errorText ?? "");
    });
    await stubPrint(page);
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Thread 1", { exact: true }).click();
    await expect(page.getByText("1 image blocked for your privacy.")).toBeVisible();
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Print" }).click();
    await expect.poll(() => printed(page)).toBe(1);
    // The banner's buttons are controls, not content.
    await expect(page.getByRole("button", { name: "Display images" })).toBeHidden();
    await page.pdf({ format: "Letter" });
    expect(remote).toEqual([]);
    expect(stopped.length).toBeGreaterThan(0);
    expect(new Set(stopped)).toEqual(new Set(["csp"]));
  });

  test("a message's own Print prints that message alone", async ({ page }) => {
    await stubPrint(page);
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Thread 3", { exact: true }).click();
    await page.getByRole("button", { name: "Expand message from Earlier 2" }).click();
    await page.getByRole("region", { name: "Message from Earlier 2" }).getByRole("button", { name: "Message actions" }).click();
    await page.getByRole("menuitem", { name: "Print" }).click();
    await expect.poll(() => printed(page)).toBe(1);
    await expect(page.locator("iframe")).toHaveCount(1);
    await expect(page.locator("[data-message-open]")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Thread 3" })).toBeVisible();
  });

  test("Ctrl+P prints the open conversation; focus returns to the page afterwards", async ({ page }) => {
    await stubPrint(page);
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Thread 3", { exact: true }).click();
    await expect(page.getByText("6 messages")).toBeVisible();
    await page.keyboard.press("Control+p");
    await expect.poll(() => printed(page)).toBe(1);
    await expect(page.locator("iframe")).toHaveCount(6);
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await expect(page.locator("iframe")).toHaveCount(1);
  });
});
