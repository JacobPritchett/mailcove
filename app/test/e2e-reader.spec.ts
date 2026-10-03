// The reader's layout, measured: what is above the fold on a phone, that the
// actions stay reachable while scrolling, and that the desktop toolbar is one
// row at the widths people actually use.
import { test, expect, type Page } from "@playwright/test";
import { PHONE, makeThreads, stubMailbox } from "./e2eMailbox";

/** A thread long enough to scroll, with a subject that carries reply prefixes. */
function longThread() {
  const threads = makeThreads(3);
  threads[0].subject = "RE: Re: Fwd: Cabin weekend in November?";
  threads[0].cc = "dev@patel.example"; // someone for Reply all to add
  threads[0].html = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i + 1} of a long message.</p>`).join("");
  return threads;
}

/** The open menu's items, in order. */
const itemNames = (page: Page) =>
  page
    .getByRole("menu")
    .locator('[role="menuitem"],[role="menuitemradio"]')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));

async function noHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test.describe("reader (phone)", () => {
  test.use(PHONE);

  test("the subject and the first message are on screen at once, under one bar of actions", async ({ page }) => {
    await stubMailbox(page, longThread());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Cabin weekend in November?").first().click();
    const { width, height } = page.viewportSize()!;

    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText("Cabin weekend in November?");
    const frame = page.locator("iframe").first();
    await expect(frame).toBeVisible();
    const h = (await heading.boundingBox())!;
    const f = (await frame.boundingBox())!;
    // The heading sits directly under the bar, and the message body starts in
    // the top half of the screen rather than below three rows of buttons.
    expect(h.y).toBeLessThan(110);
    expect(f.y).toBeLessThan(height / 2);

    const toolbar = page.getByRole("toolbar", { name: "Conversation actions" });
    const names = await toolbar.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    expect(names).toEqual(["Archive", "Move to trash", "Mark as unread", "Snooze", "More actions"]);
    // Back, the five actions and Compose share one row, each a 44px target, none clipped.
    const bar = [page.getByRole("button", { name: "Back to list" }), ...(await toolbar.getByRole("button").all()), page.getByRole("button", { name: "Compose" })];
    const tops = new Set<number>();
    let previousRight = -1;
    for (const b of bar) {
      const r = (await b.boundingBox())!;
      expect(r.width).toBeGreaterThanOrEqual(44);
      expect(r.height).toBeGreaterThanOrEqual(44);
      expect(r.x).toBeGreaterThanOrEqual(previousRight - 0.5);
      expect(r.x + r.width).toBeLessThanOrEqual(width);
      previousRight = r.x + r.width;
      tops.add(Math.round(r.y));
    }
    expect(tops.size).toBe(1);
    await noHorizontalOverflow(page);
  });

  test("a message header shows the sender's name whole, with the address under it", async ({ page }) => {
    const threads = longThread();
    threads[0].from = "The Weekly Byte <news@weeklybyte.example>";
    await stubMailbox(page, threads);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Cabin weekend in November?").first().click();
    const name = page.locator("main section").getByText("The Weekly Byte", { exact: true });
    const address = page.locator("main section").getByText("news@weeklybyte.example", { exact: true }).first();
    await expect(name).toBeVisible();
    for (const el of [name, address]) {
      expect(await el.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    }
    expect((await address.boundingBox())!.y).toBeGreaterThan((await name.boundingBox())!.y);
  });

  test("in the installed app the top bar sits below the status bar, not under it", async ({ page }) => {
    // A notched phone: 47px at the top belongs to the system.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: 47, bottom: 34 } } as never);
    await stubMailbox(page, longThread());
    await page.goto("/", { waitUntil: "networkidle" });
    const inset = await page.evaluate(() => {
      const d = document.createElement("div");
      d.style.paddingTop = "env(safe-area-inset-top)";
      document.body.appendChild(d);
      const v = parseFloat(getComputedStyle(d).paddingTop);
      d.remove();
      return v;
    });
    expect(inset).toBe(47);

    await page.getByText("Cabin weekend in November?").first().click();
    const names = ["Back to list", "Archive", "Move to trash", "Mark as unread", "Snooze", "More actions", "Compose"];
    for (const name of names) {
      const b = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(47);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    // The same line the list's own bar keeps.
    const back = (await page.getByRole("button", { name: "Back to list" }).boundingBox())!;
    await page.getByRole("button", { name: "Back to list" }).click();
    const menu = (await page.getByRole("button", { name: "Open menu" }).boundingBox())!;
    expect(back.y).toBe(menu.y);
    // And the heading starts below the whole bar.
    await page.getByText("Cabin weekend in November?").first().click();
    expect((await page.getByRole("heading", { level: 1 }).boundingBox())!.y).toBeGreaterThanOrEqual(47 + 56);
  });

  test("the actions stay put while the thread scrolls", async ({ page }) => {
    await stubMailbox(page, longThread());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Cabin weekend in November?").first().click();
    const archive = page.getByRole("button", { name: "Archive" });
    const before = (await archive.boundingBox())!;
    await page.locator('main [data-slot="scroll-area-viewport"]').evaluate((el) => el.scrollTo(0, 1500));
    await expect(page.getByRole("heading", { level: 1 })).not.toBeInViewport();
    const after = (await archive.boundingBox())!;
    expect(after.y).toBe(before.y);
    await expect(archive).toBeInViewport();
  });

  test("More holds star, junk, summarize and the reading mode; Reply stays at the end of the thread", async ({ page }) => {
    await stubMailbox(page, longThread());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Cabin weekend in November?").first().click();
    await expect(page.getByRole("toolbar").getByRole("button", { name: "Reply" })).toHaveCount(0);
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    const menu = page.getByRole("menu");
    expect(await itemNames(page)).toEqual(["Star", "Report junk", "Summarize", "Rich", "Chat"]);
    for (const item of await menu.locator('[role="menuitem"],[role="menuitemradio"]').all()) {
      // Rounded: the box is read while the menu's open animation settles.
      expect(Math.round((await item.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
    }
    await menu.getByRole("menuitemradio", { name: "Chat" }).click();
    await expect(page.locator("iframe")).toHaveCount(0);
    // Focus goes back to the button that opened the menu.
    await expect(page.getByRole("button", { name: "More actions", exact: true })).toBeFocused();

    await page.locator('main [data-slot="scroll-area-viewport"]').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    for (const name of ["Reply all", "Forward"]) {
      await expect(page.getByRole("button", { name })).toBeInViewport();
    }
    await expect(page.getByRole("button", { name: /^Reply to / })).toBeInViewport();
  });

  test("archiving from the bar returns to the list with an Undo toast", async ({ page }) => {
    const box = await stubMailbox(page, longThread());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Cabin weekend in November?").first().click();
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Archived" })).toBeVisible();
    expect(box.mutations.at(-1)).toMatchObject({ action: "archive" });
  });
});

for (const width of [1280, 1440]) {
  test.describe(`reader (desktop ${width})`, () => {
    test.use({ viewport: { width, height: width === 1280 ? 800 : 900 } });

    test("the toolbar is one row of labelled buttons and stays in view while scrolling", async ({ page }) => {
      await stubMailbox(page, longThread());
      await page.goto("/", { waitUntil: "networkidle" });
      await page.getByText("Cabin weekend in November?").first().click();
      const toolbar = page.getByRole("toolbar", { name: "Conversation actions" });
      await expect(toolbar).toBeVisible();

      const buttons = await toolbar.getByRole("button").all();
      expect(buttons).toHaveLength(6);
      const tops = new Set<number>();
      for (const b of buttons) tops.add(Math.round((await b.boundingBox())!.y + (await b.boundingBox())!.height / 2));
      expect(tops.size).toBe(1);
      await expect(toolbar.getByRole("button")).toHaveText(["Reply", "Archive", "Trash", "Unread", "Snooze", "More"]);
      // Nothing spills past the reading column.
      const t = (await toolbar.boundingBox())!;
      const article = (await page.locator("main article").boundingBox())!;
      expect(t.x + t.width).toBeLessThanOrEqual(article.x + article.width);
      const last = (await buttons.at(-1)!.boundingBox())!;
      expect(last.x + last.width).toBeLessThanOrEqual(article.x + article.width);

      await page.locator('main [data-slot="scroll-area-viewport"]').evaluate((el) => el.scrollTo(0, 1200));
      await expect(page.getByRole("heading", { level: 1 })).not.toBeInViewport();
      await expect(toolbar.getByRole("button", { name: "Archive" })).toBeInViewport();
      // And it covers what scrolls under it rather than letting text show through.
      const bg = await toolbar.evaluate((el) => getComputedStyle(el.parentElement!).backgroundColor);
      expect(bg).not.toMatch(/rgba?\(0, 0, 0, 0\)|transparent/);
    });

    test("More opens from the keyboard and holds the rest", async ({ page }) => {
      await stubMailbox(page, longThread());
      await page.goto("/", { waitUntil: "networkidle" });
      await page.getByText("Cabin weekend in November?").first().click();
      await page.getByRole("button", { name: "More actions", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menu")).toBeVisible();
      expect(await itemNames(page)).toEqual([
        "Reply all", "Forward", "Star", "Report junk", "Summarize", "Rich", "Chat",
      ]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "More actions", exact: true })).toBeFocused();
    });
  });
}

test.describe("reader in a narrow desktop pane (a tablet in portrait)", () => {
  test.use({ viewport: { width: 820, height: 1180 } });

  test("the toolbar falls back to icons rather than wrapping or overflowing", async ({ page }) => {
    await stubMailbox(page, longThread());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Cabin weekend in November?").first().click();
    const toolbar = page.getByRole("toolbar", { name: "Conversation actions" });
    await expect(toolbar).toBeVisible();
    const pane = (await page.locator("main").boundingBox())!;
    const tops = new Set<number>();
    for (const b of await toolbar.getByRole("button").all()) {
      const r = (await b.boundingBox())!;
      tops.add(Math.round(r.y + r.height / 2));
      expect(r.x + r.width).toBeLessThanOrEqual(pane.x + pane.width);
    }
    expect(tops.size).toBe(1);
    await expect(toolbar.getByRole("button", { name: "Archive" }).locator("span")).toBeHidden();
    await noHorizontalOverflow(page);
  });
});
