// The search hint and domain-scoped search, at a desktop and a phone size.
import { test, expect } from "@playwright/test";
import { PHONE, makeThreads, stubMailbox } from "./e2eMailbox";

test.describe("search (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("/ focuses the box and shows the operators; clicking one inserts it and keeps focus", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(5));
    await page.goto("/", { waitUntil: "networkidle" });
    const input = page.getByLabel("Search messages", { exact: true });
    const tips = page.getByRole("group", { name: "Search operators" });
    await expect(tips).toHaveCount(0);
    await page.keyboard.press("/");
    await expect(input).toBeFocused();
    await expect(tips).toBeVisible();

    // Inside the list column, over the list rather than pushing it down.
    const t = (await tips.boundingBox())!;
    const column = (await page.locator("section").first().boundingBox())!;
    expect(t.x).toBeGreaterThanOrEqual(column.x);
    expect(t.x + t.width).toBeLessThanOrEqual(column.x + column.width);
    const firstRow = (await page.locator("li[data-thread-id]").first().boundingBox())!;
    expect(t.y + t.height).toBeGreaterThan(firstRow.y);
    // No example or meaning is cut off.
    const clipped = await tips.locator("button code").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).length);
    expect(clipped).toBe(0);

    await tips.getByRole("button", { name: /^subject:invoice/ }).click();
    await expect(input).toHaveValue("subject:");
    await expect(input).toBeFocused();
    await expect(tips).toHaveCount(0);
    await page.keyboard.type("invoice");
    await expect.poll(() => box.requests.some((r) => r.includes("q=subject%3Ainvoice"))).toBe(true);
  });

  test("the hint is reachable by keyboard, and dismissing it sticks across a reload", async ({ page }) => {
    await stubMailbox(page, makeThreads(3));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.keyboard.press("/");
    const tips = page.getByRole("group", { name: "Search operators" });
    await expect(tips).toBeVisible();
    await page.keyboard.press("Tab"); // the help button
    await page.keyboard.press("Tab"); // Hide search tips
    await expect(page.getByRole("button", { name: "Hide search tips" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(tips.getByRole("button", { name: /^from:anna/ })).toBeFocused();
    await page.keyboard.press("Enter");
    const input = page.getByLabel("Search messages", { exact: true });
    await expect(input).toHaveValue("from:");
    await expect(input).toBeFocused();

    await input.fill("");
    await expect(tips).toBeVisible();
    await page.getByRole("button", { name: "Hide search tips" }).click();
    await expect(tips).toHaveCount(0);
    await page.reload({ waitUntil: "networkidle" });
    await page.keyboard.press("/");
    await expect(tips).toHaveCount(0);
    await page.getByRole("button", { name: "Search tips" }).click();
    await expect(tips).toBeVisible();
  });

  test("a chosen domain still applies while searching, and the count says so", async ({ page }) => {
    const threads = makeThreads(6);
    threads[0].domain = "other.example";
    threads[1].domain = "other.example";
    const box = await stubMailbox(page, threads);
    // Two domains, so the inbox switcher shows.
    await page.route("**/api/counts", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          inbox: 6, starred: 0, sent: 0, all: 6, trash: 0, spam: 0, snoozed: 0, inboxUnread: 2, drafts: 0,
          domains: [
            { domain: "example.com", threads: 4, unread: 1 },
            { domain: "other.example", threads: 2, unread: 1 },
          ],
        }),
      }),
    );
    await page.goto("/", { waitUntil: "networkidle" });
    const sidebar = page.getByRole("complementary");
    await sidebar.getByRole("button", { name: /other\.example/ }).click();
    await expect(page.locator("li[data-thread-id]")).toHaveCount(2);
    await page.getByLabel("Search messages", { exact: true }).fill("Thread");
    await expect(page.getByText("2 results in other.example")).toBeVisible();
    expect(box.requests.filter((r) => r.includes("q=Thread")).every((r) => r.includes("domain=other.example"))).toBe(true);
    await sidebar.getByRole("button", { name: /All inboxes/ }).click();
    await expect(page.getByText("6 results", { exact: true })).toBeVisible();
  });
});

test.describe("search (phone)", () => {
  test.use(PHONE);

  test("the hint is chips that fit the screen, each a 44px target, and inserting keeps the keyboard's field focused", async ({ page }) => {
    await stubMailbox(page, makeThreads(5));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Search messages" }).click();
    const input = page.getByLabel("Search messages input");
    await expect(input).toBeFocused();
    const tips = page.getByRole("group", { name: "Search operators" });
    await expect(tips).toBeVisible();

    const { width, height } = page.viewportSize()!;
    const t = (await tips.boundingBox())!;
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.x + t.width).toBeLessThanOrEqual(width);
    expect(t.y + t.height).toBeLessThanOrEqual(height);
    for (const b of await tips.getByRole("button").all()) {
      const r = (await b.boundingBox())!;
      expect(r.height).toBeGreaterThanOrEqual(44);
      expect(r.width).toBeGreaterThanOrEqual(44);
      expect(r.x + r.width).toBeLessThanOrEqual(width);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);

    await tips.getByRole("button", { name: /^is:unread/ }).tap();
    await expect(input).toHaveValue("is:unread ");
    await expect(input).toBeFocused();
  });
});
