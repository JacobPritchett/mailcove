// Desktop list rows: the hover actions are laid over the row, never squeezed
// into it.
import { test, expect, type Locator } from "@playwright/test";
import { makeThreads, stubMailbox } from "./e2eMailbox";

test.use({ viewport: { width: 1440, height: 900 } });

/** Where the row's three pieces of text sit, to the pixel. */
async function textBoxes(row: Locator) {
  return row.locator('[data-slot="thread-row"]').evaluate((button) => {
    const out: Record<string, number[]> = {};
    button.querySelectorAll<HTMLElement>("span.truncate, span.shrink-0, div.truncate").forEach((el, i) => {
      const r = el.getBoundingClientRect();
      out[`${i}:${el.textContent?.slice(0, 12)}`] = [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
    });
    return out;
  });
}

test("hovering a row does not move or further truncate its sender, subject or date", async ({ page }) => {
  const threads = makeThreads(6);
  threads[2].subject = "A subject long enough that it is already truncated in a 320px column";
  threads[2].from = "A Sender With A Decidedly Long Display Name <long@example.com>";
  await stubMailbox(page, threads);
  await page.goto("/", { waitUntil: "networkidle" });
  const row = page.locator('li[data-thread-id="t4"]');
  await page.mouse.move(900, 500); // well away from the list
  const before = await textBoxes(row);
  expect(Object.keys(before).length).toBeGreaterThanOrEqual(4);

  await row.hover();
  const archive = row.getByRole("button", { name: "Archive" });
  await expect(archive).toBeVisible();
  await page.waitForTimeout(250); // any transition would have run by now
  expect(await textBoxes(row)).toEqual(before);

  // The actions sit inside the row's right edge, on an opaque surface.
  const rowBox = (await row.boundingBox())!;
  const panel = archive.locator("xpath=ancestor::div[contains(@class,'absolute')][1]");
  const p = (await panel.boundingBox())!;
  expect(p.x + p.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  expect(p.y).toBeGreaterThanOrEqual(rowBox.y);
  expect(p.y + p.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
  const style = await panel.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, opacity: cs.opacity };
  });
  expect(style.opacity).toBe("1");
  expect(style.bg).not.toMatch(/transparent|rgba\(.*,\s*0\)$|\/\s*0\)$/);
});

test("the actions are reachable by keyboard, which also reveals them", async ({ page }) => {
  await stubMailbox(page, makeThreads(3));
  await page.goto("/", { waitUntil: "networkidle" });
  await page.mouse.move(900, 500);
  const row = page.locator('li[data-thread-id="t3"]');
  const archive = row.getByRole("button", { name: "Archive" });
  const panelOpacity = () => archive.evaluate((el) => getComputedStyle(el.parentElement!.parentElement!).opacity);
  expect(await panelOpacity()).toBe("0");
  await archive.focus();
  await expect.poll(panelOpacity).toBe("1");
  // Along the panel to its menu, and into it.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(row.getByRole("button", { name: "More actions for Thread 3" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Star" }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Starred" })).toBeVisible();
});

test("the panel leaves most of the row free: clicking the subject still opens the thread", async ({ page }) => {
  await stubMailbox(page, makeThreads(3));
  await page.goto("/", { waitUntil: "networkidle" });
  const row = page.locator('li[data-thread-id="t2"]');
  await row.hover();
  const rowBox = (await row.boundingBox())!;
  const panel = (await row
    .getByRole("button", { name: "Archive" })
    .locator("xpath=ancestor::div[contains(@class,'absolute')][1]")
    .boundingBox())!;
  expect(panel.width).toBeLessThan(rowBox.width * 0.45);
  // The middle of the row, where a hurried click lands.
  await page.mouse.click(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await expect(page.getByRole("heading", { name: "Thread 2" })).toBeVisible();
});
