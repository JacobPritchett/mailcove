// The phone list, driven with real touch input (CDP touch events, which the
// compositor treats like a finger: touch-action, native scrolling and all).
import { test, expect, type CDPSession, type Locator, type Page } from "@playwright/test";
import { PHONE, makeThreads, stubMailbox } from "./e2eMailbox";

test.use(PHONE);

async function touch(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}
/** Put a finger down, move it along `path`, and (unless told not to) lift it. */
async function drag(cdp: CDPSession, path: [number, number][], opts: { lift?: boolean; stepMs?: number } = {}) {
  const [first, ...rest] = path;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: first[0], y: first[1] }] });
  let [px, py] = first;
  for (const [x, y] of rest) {
    // A finger does not teleport: interpolate so the browser sees a drag.
    const steps = Math.max(2, Math.ceil(Math.hypot(x - px, y - py) / 12));
    for (let i = 1; i <= steps; i++) {
      const nx = px + ((x - px) * i) / steps;
      const ny = py + ((y - py) * i) / steps;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: nx, y: ny }] });
      if (opts.stepMs) await new Promise((r) => setTimeout(r, opts.stepMs));
    }
    [px, py] = [x, y];
  }
  if (opts.lift !== false) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const lift = (cdp: CDPSession) => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
const row = (page: Page, id: string) => page.locator(`li[data-thread-id="${id}"]`);
async function mid(el: Locator) {
  const b = (await el.boundingBox())!;
  return { ...b, cy: b.y + b.height / 2 };
}
const slideX = (r: Locator) =>
  r.locator('[data-slot="thread-row"]').evaluate((b) => new DOMMatrix(getComputedStyle(b.parentElement!).transform).m41);
const viewport = (page: Page) => page.locator('section [data-slot="scroll-area-viewport"]').first();

test.describe("swiping rows", () => {
  test("right archives, with the Undo toast; Undo brings the row back", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(8));
    await page.goto("/", { waitUntil: "networkidle" });
    const r = await mid(row(page, "t7"));
    await drag(await touch(page), [[40, r.cy], [260, r.cy + 4]]);

    await expect(row(page, "t7")).toHaveCount(0);
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Archived" });
    await expect(toast).toBeVisible();
    expect(box.mutations.at(-1)).toMatchObject({ threadIds: ["t7"], action: "archive" });
    // The swipe did not also open the thread.
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();

    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(row(page, "t7")).toBeVisible();
    expect(await slideX(row(page, "t7"))).toBe(0);
  });

  test("left moves to Trash", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(8));
    await page.goto("/", { waitUntil: "networkidle" });
    const r = await mid(row(page, "t6"));
    await drag(await touch(page), [[340, r.cy], [120, r.cy - 3]]);
    await expect(row(page, "t6")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Moved to Trash" })).toBeVisible();
    expect(box.mutations.at(-1)).toMatchObject({ threadIds: ["t6"], action: "trash" });
  });

  test("the row follows the finger over a coloured background and icon, and arms at the threshold", async ({ page }) => {
    await stubMailbox(page, makeThreads(8));
    await page.goto("/", { waitUntil: "networkidle" });
    const target = row(page, "t7");
    const r = await mid(target);
    const cdp = await touch(page);
    const underlay = target.locator("[aria-hidden]").first();
    await expect(underlay).toBeHidden();

    await drag(cdp, [[60, r.cy], [130, r.cy]], { lift: false });
    // Follows the finger, less the few pixels spent deciding the gesture.
    expect(await slideX(target)).toBeGreaterThan(50);
    expect(await slideX(target)).toBeLessThanOrEqual(70);
    await expect(underlay).toBeVisible();
    await expect(underlay).toHaveAttribute("data-dir", "right");
    await expect(underlay).toHaveAttribute("data-armed", "false");
    await expect(underlay).toHaveCSS("background-color", /oklch|rgb/);
    const green = await underlay.evaluate((el) => getComputedStyle(el).backgroundColor);
    // The icon sits in the strip the row has uncovered.
    const icon = (await underlay.locator("svg").first().boundingBox())!;
    expect(icon.x + icon.width).toBeLessThanOrEqual(r.x + 70);

    await drag(cdp, [[130, r.cy], [240, r.cy]], { lift: false }).catch(() => {});
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 240, y: r.cy }] });
    await expect(underlay).toHaveAttribute("data-armed", "true");

    // Back the other way past the start: the other action's colour.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 20, y: r.cy }] });
    await expect(underlay).toHaveAttribute("data-dir", "left");
    const red = await underlay.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(red).not.toBe(green);

    // And home again before letting go: nothing happens.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 70, y: r.cy }] });
    await lift(cdp);
    await expect.poll(() => slideX(target)).toBe(0);
    await expect(underlay).toBeHidden();
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  });

  test("released short of the threshold, the row snaps back and nothing is sent", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(8));
    await page.goto("/", { waitUntil: "networkidle" });
    const target = row(page, "t7");
    const r = await mid(target);
    await drag(await touch(page), [[60, r.cy], [140, r.cy]]);
    await expect.poll(() => slideX(target)).toBe(0);
    await expect(target).toBeVisible();
    expect(box.mutations).toEqual([]);
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  });

  test("a vertical drag scrolls the list and never slides a row, even when it drifts sideways", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(30));
    await page.goto("/", { waitUntil: "networkidle" });
    const target = row(page, "t27");
    const r = await mid(target);
    const cdp = await touch(page);
    // Up, with a strong sideways drift once the scroll has begun.
    await drag(cdp, [[200, r.cy], [205, r.cy - 60], [330, r.cy - 300]], { lift: false, stepMs: 8 });
    expect(await viewport(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    for (const id of ["t27", "t26", "t25"]) expect(await slideX(row(page, id))).toBe(0);
    await lift(cdp);
    expect(box.mutations).toEqual([]);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  });

  test("in Trash, a swipe either way restores", async ({ page }) => {
    const threads = makeThreads(4);
    for (const t of threads) t.state = "trash";
    const box = await stubMailbox(page, threads);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^Trash/ }).click();
    await expect(row(page, "t4")).toBeVisible();

    const cdp = await touch(page);
    let r = await mid(row(page, "t4"));
    await drag(cdp, [[40, r.cy], [260, r.cy]]);
    await expect(row(page, "t4")).toHaveCount(0);
    r = await mid(row(page, "t3"));
    await drag(cdp, [[340, r.cy], [120, r.cy]]);
    await expect(row(page, "t3")).toHaveCount(0);
    expect(box.mutations.map((m) => m.action)).toEqual(["restore", "restore"]);
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Restored" }).first()).toBeVisible();
  });
});

test.describe("gestures that are not ours", () => {
  test("a swipe from the very edge of the screen is left to the browser", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(8));
    await page.goto("/", { waitUntil: "networkidle" });
    const target = row(page, "t7");
    const r = await mid(target);
    const cdp = await touch(page);
    await drag(cdp, [[2, r.cy], [250, r.cy]], { lift: false });
    expect(await slideX(target)).toBe(0);
    await lift(cdp);
    const width = page.viewportSize()!.width;
    await drag(cdp, [[width - 3, r.cy], [100, r.cy]]);
    await page.waitForTimeout(300);
    expect(box.mutations).toEqual([]);
    await expect(target).toBeVisible();
  });

  test("a swipe the system cancels does nothing, and neither does a cancelled pull", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(8));
    await page.goto("/", { waitUntil: "networkidle" });
    const target = row(page, "t7");
    const r = await mid(target);
    const cdp = await touch(page);
    await drag(cdp, [[60, r.cy], [300, r.cy]], { lift: false });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect.poll(() => slideX(target)).toBe(0);
    expect(box.mutations).toEqual([]);

    const lists = () => box.requests.filter((q) => q.startsWith("GET /api/messages?")).length;
    const before = lists();
    const v = (await viewport(page).boundingBox())!;
    await drag(cdp, [[195, v.y + 30], [195, v.y + 280]], { lift: false, stepMs: 6 });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await page.waitForTimeout(700);
    expect(lists()).toBe(before);
    await expect(page.getByRole("status").filter({ hasText: "Refreshing" })).toHaveCount(0);
  });
});

test.describe("reduced motion", () => {
  test("a swipe still works, with no slide animation", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await stubMailbox(page, makeThreads(6));
    await page.goto("/", { waitUntil: "networkidle" });
    const target = row(page, "t5");
    const r = await mid(target);
    const cdp = await touch(page);
    await drag(cdp, [[60, r.cy], [140, r.cy]]);
    // Back at rest with no transition to run.
    await expect.poll(() => slideX(target)).toBe(0);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    expect(await target.locator('[data-slot="thread-row"]').evaluate((b) => b.parentElement!.style.transition)).toBe("none");
    await drag(cdp, [[40, r.cy], [260, r.cy]]);
    await expect(target).toHaveCount(0);
  });
});

test.describe("pull to refresh", () => {
  const listRequests = (box: { requests: string[] }) => box.requests.filter((q) => q.startsWith("GET /api/messages?")).length;

  test("pulling down at the top refetches and shows the new mail", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(20));
    await page.goto("/", { waitUntil: "networkidle" });
    const before = listRequests(box);
    box.deliver("Arrived while away");
    const v = (await viewport(page).boundingBox())!;
    await drag(await touch(page), [[195, v.y + 30], [195, v.y + 260]], { stepMs: 6 });

    await expect(page.getByRole("status").filter({ hasText: "Refreshing" })).toHaveCount(1);
    await expect(page.getByText("Arrived while away")).toBeVisible();
    expect(listRequests(box)).toBe(before + 1);
    // One page, not the whole list.
    expect(box.requests.filter((q) => q.startsWith("GET /api/messages?")).at(-1)).toContain("limit=50");
    await expect(page.getByRole("status").filter({ hasText: "Refreshing" })).toHaveCount(0);
  });

  test("a short pull does nothing, and a pull from further down the list is just a scroll", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(30));
    await page.goto("/", { waitUntil: "networkidle" });
    const before = listRequests(box);
    const v = (await viewport(page).boundingBox())!;
    const cdp = await touch(page);
    await drag(cdp, [[195, v.y + 30], [195, v.y + 90]], { stepMs: 6 });
    await page.waitForTimeout(300);
    expect(listRequests(box)).toBe(before);

    await viewport(page).evaluate((el) => el.scrollTo(0, 600));
    await drag(cdp, [[195, v.y + 30], [195, v.y + 260]], { stepMs: 6 });
    await page.waitForTimeout(300);
    expect(listRequests(box)).toBe(before);
    // It scrolled back up instead.
    expect(await viewport(page).evaluate((el) => el.scrollTop)).toBeLessThan(600);
  });
});

test.describe("selecting", () => {
  test("no checkbox column at rest: rows use the full width", async ({ page }) => {
    await stubMailbox(page, makeThreads(5));
    await page.goto("/", { waitUntil: "networkidle" });
    const subject = (await page.getByText("Thread 5", { exact: true }).boundingBox())!;
    // 16px of padding, not the 44px gutter.
    expect(subject.x).toBeLessThan(40);
    // The checkbox is still there for a screen reader, clipped to a pixel.
    const holder = page.getByRole("checkbox", { name: "Select thread: Thread 5" }).locator("xpath=..");
    expect((await holder.boundingBox())!.width).toBeLessThanOrEqual(1);
    await expect(holder).toHaveCSS("overflow", "hidden");
  });

  test("a long press enters selection mode; taps then toggle; the bar's X leaves it", async ({ page }) => {
    await stubMailbox(page, makeThreads(6));
    await page.goto("/", { waitUntil: "networkidle" });
    const cdp = await touch(page);
    const r = await mid(row(page, "t5"));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 150, y: r.cy }] });
    await expect(page.getByText("1 selected")).toBeVisible();
    await lift(cdp);
    // Still in the list, not the reader, and the row is checked.
    await expect(page.getByRole("checkbox", { name: "Select thread: Thread 5" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Select thread: Thread 5" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);

    await page.getByText("Thread 3", { exact: true }).tap();
    await expect(page.getByText("2 selected")).toBeVisible();
    await page.getByText("Thread 3", { exact: true }).tap();
    await expect(page.getByText("1 selected")).toBeVisible();

    await page.getByRole("button", { name: "Clear selection" }).tap();
    await expect(page.getByText("1 selected")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
    // Out of selection mode a tap opens the thread again.
    await page.getByText("Thread 3", { exact: true }).tap();
    await expect(page.getByRole("button", { name: "Back to list" })).toBeVisible();
  });

  test("the system Back button leaves selection mode", async ({ page }) => {
    await stubMailbox(page, makeThreads(4));
    await page.goto("/", { waitUntil: "networkidle" });
    const cdp = await touch(page);
    const r = await mid(row(page, "t3"));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 150, y: r.cy }] });
    await expect(page.getByText("1 selected")).toBeVisible();
    await lift(cdp);
    await page.goBack();
    await expect(page.getByText("1 selected")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  });

  test("the bulk bar is named icons at 44px, all on screen, none clipped", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(6));
    await page.goto("/", { waitUntil: "networkidle" });
    const cdp = await touch(page);
    const r = await mid(row(page, "t5"));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 150, y: r.cy }] });
    await expect(page.getByText("1 selected")).toBeVisible();
    await lift(cdp);

    const bar = page.getByRole("toolbar", { name: "Actions for the selected conversations" });
    const width = page.viewportSize()!.width;
    const names: string[] = [];
    let previousRight = 0;
    for (const b of await bar.getByRole("button").all()) {
      const box = (await b.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      // Not overlapping the one before it (the count sits between the first two).
      expect(box.x).toBeGreaterThanOrEqual(previousRight - 0.5);
      previousRight = box.x + box.width;
      names.push((await b.getAttribute("aria-label")) ?? "");
      expect(await b.innerText()).toBe("");
    }
    expect(names).toEqual([
      "Clear selection", "Archive selected", "Move selected to trash", "Mark selected as read",
      "Snooze selected", "More actions for the selection",
    ]);
    // The count is whole: its text is not wider than its box.
    const clipped = await page.getByText("1 selected").evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(false);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);

    await bar.getByRole("button", { name: "Mark selected as read" }).tap();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "1 marked read" })).toBeVisible();
    expect(box.mutations.at(-1)).toMatchObject({ action: "read", threadIds: ["t5"] });
  });

  test("swiping is off while selecting", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(6));
    await page.goto("/", { waitUntil: "networkidle" });
    const cdp = await touch(page);
    const r = await mid(row(page, "t5"));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 150, y: r.cy }] });
    await expect(page.getByText("1 selected")).toBeVisible();
    await lift(cdp);
    const other = await mid(row(page, "t4"));
    await drag(cdp, [[40, other.cy], [260, other.cy]]);
    expect(await slideX(row(page, "t4"))).toBe(0);
    expect(box.mutations).toEqual([]);
  });
});
