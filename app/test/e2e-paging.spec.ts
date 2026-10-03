// Infinite scroll in a real layout: pages load as the end nears, nothing is
// listed twice, and mail arriving at the top does not move what is on screen.
import { test, expect, type Page } from "@playwright/test";
import { PHONE, makeThreads, stubMailbox } from "./e2eMailbox";

const viewport = (page: Page) => page.locator('section [data-slot="scroll-area-viewport"]').first();
const rowIds = (page: Page) =>
  page.locator("li[data-thread-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.threadId));

async function scrollToEnd(page: Page) {
  await viewport(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
}

for (const profile of [
  { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
  { name: "phone", use: PHONE },
]) {
  test.describe(`paging (${profile.name})`, () => {
    test.use(profile.use);

    test("scrolling loads each page once, with no duplicates and nothing at the end", async ({ page }) => {
      const box = await stubMailbox(page, makeThreads(120), { pageDelayMs: 150 });
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.locator("li[data-thread-id]")).toHaveCount(50);

      await scrollToEnd(page);
      await expect(page.getByText("Loading more")).toBeVisible();
      await expect(page.locator("li[data-thread-id]")).toHaveCount(100);
      await scrollToEnd(page);
      await expect(page.locator("li[data-thread-id]")).toHaveCount(120);
      await expect(page.getByText("Loading more")).toHaveCount(0);

      const ids = await rowIds(page);
      expect(new Set(ids).size).toBe(120);
      // One request per page, each sized 50.
      const pages = box.requests.filter((r) => r.startsWith("GET /api/messages?") && r.includes("cursor="));
      expect(pages).toHaveLength(2);
      expect(box.requests.filter((r) => r.startsWith("GET /api/messages?")).every((r) => r.includes("limit=50"))).toBe(true);
      // At the true end scrolling asks for nothing more.
      await scrollToEnd(page);
      await page.waitForTimeout(300);
      expect(box.requests.filter((r) => r.includes("cursor="))).toHaveLength(2);
    });

    test("new mail at the top leaves the rows on screen where they were", async ({ page }) => {
      const box = await stubMailbox(page, makeThreads(120));
      await page.goto("/", { waitUntil: "networkidle" });
      await scrollToEnd(page);
      await expect(page.locator("li[data-thread-id]")).toHaveCount(100);
      // Sit in the middle of the first page, on a known row.
      const target = page.locator('li[data-thread-id="t90"]');
      await target.evaluate((el) => el.scrollIntoView({ block: "start" }));
      const before = (await target.boundingBox())!.y;

      box.deliver("Fresh arrival one");
      box.deliver("Fresh arrival two");
      // Coming back to the tab is the cheapest way to make the app refetch now.
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await expect(page.locator('li[data-thread-id^="new-"]')).toHaveCount(2);

      const after = (await target.boundingBox())!.y;
      expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
      // The refetch renewed the first page only, and the later page survived.
      await expect(page.locator("li[data-thread-id]")).toHaveCount(102);
      expect(new Set(await rowIds(page)).size).toBe(102);
    });

    test("mail arriving between two pages is not listed twice", async ({ page }) => {
      const box = await stubMailbox(page, makeThreads(120));
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.locator("li[data-thread-id]")).toHaveCount(50);
      // Arrives after page one was fetched and before page two is.
      box.deliver("Between pages");
      await scrollToEnd(page);
      await expect(page.locator("li[data-thread-id]")).toHaveCount(100);
      await scrollToEnd(page);
      await expect.poll(async () => (await rowIds(page)).length).toBeGreaterThanOrEqual(120);
      const ids = await rowIds(page);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
}

test.describe("keyboard paging", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("j walks past the last loaded row onto the next page, keeping the row in view", async ({ page }) => {
    await stubMailbox(page, makeThreads(60));
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.locator("li[data-thread-id]")).toHaveCount(50);
    for (let i = 0; i < 51; i++) await page.keyboard.press("j");
    const current = page.locator('li[data-thread-id] button[aria-current="true"]');
    await expect(current).toContainText("Thread 10");
    await expect(current).toBeInViewport();
    await expect(page.locator("li[data-thread-id]")).toHaveCount(60);
  });
});
