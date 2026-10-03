// Snooze end to end: the menu, the custom time, the keyboard, the Snoozed view.
import { test, expect } from "@playwright/test";
import { PHONE, makeThreads, stubMailbox } from "./e2eMailbox";

test.describe("snooze (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("b opens the menu with focus in it; a preset snoozes, moves on, and Undo brings it back", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(4));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.keyboard.press("j");
    await expect(page.getByRole("heading", { name: "Thread 4" })).toBeVisible();
    await page.keyboard.press("b");

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Tomorrow/ })).toContainText("8:00 am");
    // Focus is inside the menu, so the arrows and Enter drive it.
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
    await menu.getByRole("menuitem", { name: /Tomorrow/ }).click();

    const toast = page.locator("[data-sonner-toast]").filter({ hasText: /^Snoozed until \w{3} 8:00 am/ });
    await expect(toast).toBeVisible();
    await expect(page.locator("li[data-thread-id]")).toHaveCount(3);
    await expect(page.getByRole("button", { name: /^Snoozed/ })).toHaveText("Snoozed1");
    // Carried on to the next thread rather than leaving an empty reader.
    await expect(page.getByRole("heading", { name: "Thread 3" })).toBeVisible();
    const sent = box.mutations.at(-1)!;
    expect(sent.action).toBe("snooze");
    expect(new Date(sent.until!).getHours()).toBe(8);
    expect(sent.until!).toBeGreaterThan(Date.now());

    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("li[data-thread-id]")).toHaveCount(4);
    await expect(page.getByRole("button", { name: /^Snoozed/ })).toHaveText("Snoozed");
  });

  test("Escape closes the menu and hands focus back to the Snooze button", async ({ page }) => {
    await stubMailbox(page, makeThreads(2));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.keyboard.press("j");
    const trigger = page.getByRole("main").getByRole("button", { name: "Snooze" });
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("a custom time: the field takes focus, refuses the past, and snoozes to the time typed", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(2));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.keyboard.press("j");
    await page.keyboard.press("b");
    await page.getByRole("menuitem", { name: "Pick a date and time" }).click();

    const dialog = page.getByRole("dialog");
    const field = dialog.getByLabel("Date and time");
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("type", "datetime-local");

    await field.fill("2020-01-01T09:00");
    await dialog.getByRole("button", { name: "Snooze" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Pick a time in the future.");

    const target = new Date(Date.now() + 3 * 86_400_000);
    target.setHours(9, 30, 0, 0);
    const p = (n: number) => String(n).padStart(2, "0");
    await field.fill(
      `${target.getFullYear()}-${p(target.getMonth() + 1)}-${p(target.getDate())}T09:30`,
    );
    // Cancel first: focus goes back to the Snooze button, not to the page body.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("button", { name: "Snooze" })).toBeFocused();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Pick a date and time" }).click();
    await field.fill(
      `${target.getFullYear()}-${p(target.getMonth() + 1)}-${p(target.getDate())}T09:30`,
    );
    await field.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: /^Snoozed until \w{3} 9:30 am/ })).toBeVisible();
    expect(box.mutations.at(-1)).toMatchObject({ action: "snooze", until: target.getTime() });
  });

  test("the Snoozed view shows when each thread returns and unsnoozes from the row", async ({ page }) => {
    const threads = makeThreads(3);
    const until = new Date(Date.now() + 2 * 86_400_000);
    until.setHours(8, 0, 0, 0);
    threads[1].snoozedUntil = until.getTime();
    const box = await stubMailbox(page, threads);
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.locator("li[data-thread-id]")).toHaveCount(2);
    await page.getByRole("button", { name: /^Snoozed/ }).click();

    const row = page.locator('li[data-thread-id="t2"]');
    await expect(row).toContainText(/Until \w{3} 8:00 am/);
    await row.hover();
    await row.getByRole("button", { name: "Unsnooze" }).click();
    await expect(page.getByText("Nothing is snoozed")).toBeVisible();
    expect(box.threads.find((t) => t.thread_id === "t2")!.snoozedUntil).toBeNull();

    // Undo puts the same time back.
    await page.locator("[data-sonner-toast]").getByRole("button", { name: "Undo" }).click();
    await expect(row).toContainText(/Until \w{3} 8:00 am/);
    expect(box.threads.find((t) => t.thread_id === "t2")!.snoozedUntil).toBe(until.getTime());
  });

  test("a row's snooze button stays put while its menu is open", async ({ page }) => {
    await stubMailbox(page, makeThreads(3));
    await page.goto("/", { waitUntil: "networkidle" });
    const row = page.locator('li[data-thread-id="t2"]');
    await row.hover();
    const trigger = row.getByRole("button", { name: "Snooze" });
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();
    // The pointer is now over the menu, not the row; the button must not vanish.
    // (Looked up by attribute: an open menu hides the rest of the page from
    // the accessibility tree, so a role query no longer finds the button.)
    await page.getByRole("menuitem", { name: /Next week/ }).hover();
    await page.waitForTimeout(250); // longer than the panel's fade
    const opacity = await row
      .locator('button[aria-label="Snooze"]')
      .evaluate((el) => getComputedStyle(el.parentElement!.parentElement!).opacity);
    expect(opacity).toBe("1");
    await page.getByRole("menuitem", { name: /Next week/ }).click();
    await expect(page.locator("li[data-thread-id]")).toHaveCount(2);
  });
});

test.describe("snooze (phone)", () => {
  test.use(PHONE);

  test("the menu fits the screen with 44px rows, and the date dialog fits too", async ({ page }) => {
    await stubMailbox(page, makeThreads(2));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Thread 2", { exact: true }).click();
    await page.getByRole("button", { name: "Snooze" }).click();
    const width = page.viewportSize()!.width;
    const menu = page.getByRole("menu");
    const m = (await menu.boundingBox())!;
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.x + m.width).toBeLessThanOrEqual(width);
    for (const item of await menu.getByRole("menuitem").all()) {
      expect(Math.round((await item.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
    }

    await menu.getByRole("menuitem", { name: "Pick a date and time" }).click();
    const dialog = page.getByRole("dialog");
    const d = (await dialog.boundingBox())!;
    expect(d.x).toBeGreaterThanOrEqual(0);
    expect(d.x + d.width).toBeLessThanOrEqual(width);
    for (const name of ["Cancel", "Snooze"]) {
      expect((await dialog.getByRole("button", { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect((await dialog.getByLabel("Date and time").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});
