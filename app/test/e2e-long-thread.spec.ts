// Long conversations with real layout: folded lines are tappable and fit,
// folded bodies mount no frame, and unfolding moves the keyboard along.
import { test, expect, type Page } from "@playwright/test";
import { makeThreads, stubMailbox, PHONE } from "./e2eMailbox";

function threads() {
  const t = makeThreads(3);
  for (const x of t) x.unread = false;
  t[0].earlier = 7; // Thread 3: eight messages
  t[1].earlier = 2; // Thread 2: three messages
  return t;
}
const folded = (page: Page) => page.getByRole("button", { name: /^Expand message from/ });
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const [name, use] of [
  ["desktop", { viewport: { width: 1280, height: 800 } }],
  ["tablet", { viewport: { width: 820, height: 1180 } }],
  ["phone", PHONE],
] as const) {
  test.describe(name, () => {
    test.use(use);

    test("earlier messages fold to one line each and mount no frame", async ({ page }) => {
      await stubMailbox(page, threads());
      await page.goto("/", { waitUntil: "networkidle" });
      await page.getByText("Thread 3", { exact: true }).click();
      await expect(page.getByText("8 messages")).toBeVisible();
      await expect(folded(page)).toHaveCount(7);
      await expect(page.locator("iframe")).toHaveCount(1);
      // The open message is on screen, not below a column of folded lines.
      await expect(page.locator("iframe")).toBeInViewport();

      const lines = await folded(page).evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const time = el.querySelector("time")!.getBoundingClientRect();
          return { height: r.height, timeInside: time.right <= r.right + 0.5, clipped: el.scrollWidth > el.clientWidth + 1 };
        }),
      );
      for (const line of lines) {
        expect(line.height).toBeGreaterThanOrEqual(44);
        expect(line.timeInside).toBe(true);
        expect(line.clipped).toBe(false);
      }
      expect(await sideways(page)).toBe(0);
    });

    test("a short conversation is not folded", async ({ page }) => {
      await stubMailbox(page, threads());
      await page.goto("/", { waitUntil: "networkidle" });
      await page.getByText("Thread 2", { exact: true }).click();
      await expect(page.getByText("3 messages")).toBeVisible();
      await expect(folded(page)).toHaveCount(0);
      await expect(page.locator("iframe")).toHaveCount(3);
    });
  });
}

test.describe("keyboard", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Enter on a folded line unfolds it and focus lands on the message; Expand all opens the rest", async ({ page }) => {
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Thread 3", { exact: true }).click();
    await expect(folded(page)).toHaveCount(7);

    await folded(page).nth(2).focus();
    await page.keyboard.press("Enter");
    await expect(folded(page)).toHaveCount(6);
    await expect(page.getByRole("region", { name: "Message from Earlier 3" })).toBeFocused();
    await expect(page.locator("iframe")).toHaveCount(2);
    // Tab carries on inside the message that was opened, not from the top.
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest('[aria-label="Message from Earlier 3"]')),
    ).toBe(true);

    await page.getByRole("button", { name: "Expand all" }).click();
    await expect(folded(page)).toHaveCount(0);
    await expect(page.locator("iframe")).toHaveCount(8);
    await page.getByRole("button", { name: "Collapse earlier" }).click();
    await expect(folded(page)).toHaveCount(7);
    await expect(page.locator("iframe")).toHaveCount(1);
  });
});
