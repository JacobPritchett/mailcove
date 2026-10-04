// Tablet and narrow-desktop widths: the sidebar becomes an icon rail so the
// list and the reader both have room, and the reader toolbar stays one row.
import { test, expect, type Page } from "@playwright/test";
import { makeThreads, stubMailbox } from "./e2eMailbox";

const WIDTHS = [768, 820, 900, 1024, 1180, 1280];
/** The full sidebar shows from here up (useIsWide). */
const WIDE = 1100;

function threads() {
  const t = makeThreads(12);
  for (const x of t) x.cc = "dev@patel.example";
  return t;
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const width = (sel: string) => Math.round(document.querySelector(sel)!.getBoundingClientRect().width);
    const toolbar = document.querySelector('[role="toolbar"]')!;
    const tops = [...toolbar.children]
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.width > 0)
      .map((r) => Math.round(r.top));
    return {
      aside: width("aside"),
      list: width("section"),
      reader: width("main"),
      toolbarRows: new Set(tops).size,
      toolbarScrolls: toolbar.scrollWidth > toolbar.clientWidth,
      toolbarOverflow: getComputedStyle(toolbar).overflowX,
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

for (const width of WIDTHS) {
  test(`${width}px: list and reader both have room, and the toolbar is one row that cannot scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Thread 12", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Thread 12" })).toBeVisible();

    const m = await measure(page);
    expect(m.aside).toBe(width < WIDE ? 56 : 224);
    expect(m.list).toBe(320);
    // It was 224px at 768 with all three panes at full width. 390 is a
    // phone's reader, the narrowest the message layout is built for.
    expect(m.reader).toBeGreaterThanOrEqual(390);
    expect(m.toolbarRows).toBe(1);
    expect(m.toolbarScrolls).toBe(false);
    expect(m.toolbarOverflow).toBe("visible");
    expect(m.sideways).toBe(0);
    // Every toolbar action is inside the pane, not cut off at its edge.
    const pane = (await page.locator("main").boundingBox())!;
    for (const button of await page.getByRole("toolbar", { name: "Conversation actions" }).getByRole("button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
    }
  });
}

test.describe("the rail", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  test("every button is named, thumb-sized and works; the current view is marked", async ({ page }) => {
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    const rail = page.getByRole("navigation", { name: "Folders" });
    for (const name of ["Starred", "Snoozed", "Drafts", "Sent", "All Mail", "Junk", "Trash"]) {
      await expect(rail.getByRole("button", { name, exact: true })).toBeVisible();
    }
    // The inbox carries its unread count in its name, since the label is gone.
    const inbox = rail.getByRole("button", { name: /^Inbox, \d+ unread$/ });
    await expect(inbox).toHaveAttribute("aria-current", "page");

    const sizes = await page.locator("aside button").evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect()).map((r) => [r.width, r.height]),
    );
    expect(sizes.length).toBeGreaterThanOrEqual(12);
    for (const [w, h] of sizes) {
      expect(w).toBeGreaterThanOrEqual(44);
      expect(h).toBeGreaterThanOrEqual(44);
    }

    await rail.getByRole("button", { name: "All Mail", exact: true }).click();
    await expect(rail.getByRole("button", { name: "All Mail", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(inbox).not.toHaveAttribute("aria-current", "page");

    await page.locator("aside").getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  });

  test("the menu button opens the full menu as a drawer, and picking a view closes it", async ({ page }) => {
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("button", { name: "Sent" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Rules" })).toBeVisible();
    await drawer.getByRole("button", { name: "Sent" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: "Sent", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("the rail is reachable by keyboard, in order", async ({ page }) => {
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /^Inbox/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Starred", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Starred", exact: true })).toHaveAttribute("aria-current", "page");
  });
});

test("resizing from the rail to a wide window closes the drawer and shows the full sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await stubMailbox(page, threads());
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("aside").getByText("Inbox", { exact: true })).toBeVisible();
});
