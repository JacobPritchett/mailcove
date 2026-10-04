// The list keeps its place: coming back to a view (from another view, from
// Drafts, from the reader on a phone) finds it scrolled where it was left.
// And the row menus, mounted on demand, still open from mouse and keyboard.
import { test, expect, type Page } from "@playwright/test";
import { makeThreads, stubMailbox, PHONE } from "./e2eMailbox";

const viewport = (page: Page) => page.locator("li[data-thread-id]").first().locator("xpath=ancestor::*[@data-slot='scroll-area-viewport']");
const scrollTop = (page: Page) => viewport(page).evaluate((el) => Math.round(el.scrollTop));
async function scrollTo(page: Page, y: number) {
  await viewport(page).evaluate((el, top) => {
    el.scrollTop = top;
  }, y);
  await expect.poll(() => scrollTop(page)).toBe(y);
  // Let the scroll event that records the position run.
  await page.waitForTimeout(100);
}

function threads() {
  const t = makeThreads(120);
  // Some sent mail, so Sent is a view with rows of its own.
  for (let i = 0; i < 30; i++) t.push({ ...t[i], thread_id: `s${i}`, subject: `Sent ${i}`, direction: "out" });
  return t;
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("returning to a view restores its scroll position, per view", async ({ page }) => {
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await scrollTo(page, 1500);

    await page.getByRole("button", { name: "Sent" }).click();
    await expect(page.getByText("Sent 0", { exact: true })).toBeVisible();
    // A view seen for the first time starts at its top.
    expect(await scrollTop(page)).toBe(0);
    await scrollTo(page, 400);

    await page.getByRole("button", { name: "Inbox" }).click();
    await expect.poll(() => scrollTop(page)).toBe(1500);
    await page.getByRole("button", { name: "Sent" }).click();
    await expect.poll(() => scrollTop(page)).toBe(400);
  });

  test("and survives a visit to Drafts, which replaces the list altogether", async ({ page }) => {
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await scrollTo(page, 1200);
    await page.getByRole("button", { name: "Drafts" }).click();
    await expect(page.getByText("No drafts.")).toBeVisible();
    await page.getByRole("button", { name: "Inbox" }).click();
    await expect.poll(() => scrollTop(page)).toBe(1200);
  });

  test("opening a conversation and coming back with the keyboard leaves the list where it was", async ({ page }) => {
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await scrollTo(page, 900);
    const row = page.locator("li[data-thread-id]").nth(14);
    await row.locator("button[data-slot=thread-row]").click();
    await expect(page.getByRole("toolbar", { name: "Conversation actions" })).toBeVisible();
    expect(await scrollTop(page)).toBe(900);
  });

  test("a row's menus are mounted when the pointer reaches it, and open as before", async ({ page }) => {
    const mail = await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    const mounted = page.locator('li[data-thread-id] [data-slot="dropdown-menu-trigger"]');
    await expect(mounted).toHaveCount(0);
    const row = page.locator("li[data-thread-id]").nth(2);
    await row.hover();
    await expect(row.locator('[data-slot="dropdown-menu-trigger"]')).toHaveCount(2);
    await row.getByRole("button", { name: /^More actions for/ }).click();
    await page.getByRole("menuitem", { name: "Star" }).click();
    await expect.poll(() => mail.mutations.map((m) => m.action)).toEqual(["star"]);
    // Only the rows the pointer crossed carry menus.
    expect(await mounted.count()).toBeLessThanOrEqual(8);
  });

  test("from the keyboard: Tab into a row reaches its actions, and the menu opens with Enter", async ({ page }) => {
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    const row = page.locator("li[data-thread-id]").nth(1);
    await row.locator("button[data-slot=thread-row]").focus();
    await page.keyboard.press("Tab");
    await expect(row.getByRole("button", { name: "Archive" })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(row.getByRole("button", { name: "Snooze" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(row.getByRole("button", { name: /^More actions for/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Report junk" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(row.getByRole("button", { name: /^More actions for/ })).toBeFocused();
  });
});

test.describe("phone", () => {
  test.use({ ...PHONE });

  test("back from the reader finds the list where it was, with no menus mounted at all", async ({ page }) => {
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await scrollTo(page, 2000);
    const row = page.locator("li[data-thread-id]").nth(26);
    const subject = await row.locator("button[data-slot=thread-row]").innerText();
    await row.locator("button[data-slot=thread-row]").tap();
    await expect(page.getByRole("button", { name: "Back to list" })).toBeVisible();
    await page.getByRole("button", { name: "Back to list" }).tap();
    await expect.poll(() => scrollTop(page)).toBe(2000);
    await expect(page.getByText(subject.split("\n")[1] ?? subject).first()).toBeInViewport();
    expect(await page.locator('li[data-thread-id] [data-slot="dropdown-menu-trigger"]').count()).toBe(0);
  });
});
