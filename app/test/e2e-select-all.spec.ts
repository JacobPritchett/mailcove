// Select all across pages against a paged mailbox: the offer, the action on
// conversations that were never loaded, the request sizes, and Undo.
import { test, expect, type Page } from "@playwright/test";
import { makeThreads, stubMailbox, PHONE } from "./e2eMailbox";

const TOTAL = 620;
const bar = (page: Page) => page.getByRole("toolbar", { name: "Actions for the selected conversations" });
const loadedRows = (page: Page) => page.getByRole("checkbox", { name: /^Select thread:/ });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("archives the whole inbox in bounded requests, and Undo brings all of it back", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(TOTAL));
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByText(`Thread ${TOTAL}`, { exact: true })).toBeVisible();
    await page.keyboard.press("*");
    await page.keyboard.press("a");
    await expect(bar(page)).toContainText("50 selected");

    const offer = page.getByRole("button", { name: `Select all ${TOTAL} in this view` });
    await expect(offer).toBeVisible();
    // Reachable from the keyboard, right after the bar it belongs to.
    await offer.focus();
    await page.keyboard.press("Enter");
    await expect(bar(page)).toContainText(`All ${TOTAL} selected`);
    await expect(page.getByText(`All ${TOTAL} conversations in this view are selected.`)).toBeVisible();
    expect(mail.mutations).toHaveLength(0);

    await bar(page).getByRole("button", { name: "Archive selected" }).click();
    await expect(page.getByText(`${TOTAL} archived`)).toBeVisible();
    await expect.poll(() => mail.threads.filter((t) => t.state === "archived").length).toBe(TOTAL);
    // Collected 500 at a time, changed 200 at a time: nothing unbounded.
    expect(mail.requests.filter((r) => r.startsWith("GET /api/messages/ids")).length).toBe(2);
    expect(mail.mutations.map((m) => m.threadIds.length)).toEqual([200, 200, 200, 20]);
    expect(new Set(mail.mutations.flatMap((m) => m.threadIds)).size).toBe(TOTAL);
    await expect(loadedRows(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => mail.threads.filter((t) => t.state === "inbox").length).toBe(TOTAL);
    await expect(page.getByText(`Thread ${TOTAL}`, { exact: true })).toBeVisible();
  });

  test("mail that arrives after the selection was made is left alone", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(120));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.keyboard.press("*");
    await page.keyboard.press("a");
    await page.getByRole("button", { name: "Select all 120 in this view" }).click();
    await bar(page).getByRole("button", { name: "Mark selected as read" }).click();
    await expect.poll(() => mail.mutations.length).toBe(1);
    const late = mail.deliver("Arrived late");
    expect(mail.mutations[0].threadIds).not.toContain(late.thread_id);
    expect(mail.mutations[0].threadIds).toHaveLength(120);
  });

  test("a search can be selected whole too, without a count", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(130));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Search messages" }).fill("Thread 1");
    await expect(page.getByText(/results?$/)).toBeVisible();
    await page.getByRole("textbox", { name: "Search messages" }).blur();
    const matching = mail.threads.filter((t) => t.subject.includes("Thread 1")).length;
    await page.keyboard.press("*");
    await page.keyboard.press("a");
    const offer = page.getByRole("button", { name: "Select all in this view" });
    if (matching > 50) {
      await offer.click();
      await expect(bar(page)).toContainText("All selected");
      await bar(page).getByRole("button", { name: "Move selected to trash" }).click();
      await expect.poll(() => mail.threads.filter((t) => t.state === "trash").length).toBe(matching);
    } else {
      await expect(offer).toHaveCount(0);
    }
  });
});

test.describe("phone", () => {
  test.use({ ...PHONE });

  test("the offer fits the screen and is thumb-sized", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(TOTAL));
    await page.goto("/", { waitUntil: "networkidle" });
    // Long press to start selecting, then tick the rest from the keyboard path the bar offers.
    const first = page.getByText(`Thread ${TOTAL}`, { exact: true });
    await first.dispatchEvent("pointerdown", { pointerType: "touch", button: 0, clientX: 100, clientY: 200, isPrimary: true });
    await page.waitForTimeout(700);
    await first.dispatchEvent("pointerup", { pointerType: "touch", button: 0, clientX: 100, clientY: 200, isPrimary: true });
    await expect(bar(page)).toContainText("1 selected");
    await page.keyboard.press("*");
    await page.keyboard.press("a");
    const offer = page.getByRole("button", { name: `Select all ${TOTAL} in this view` });
    await expect(offer).toBeVisible();
    const box = (await offer.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await offer.tap();
    await expect(bar(page)).toContainText(`All ${TOTAL} selected`);
    await bar(page).getByRole("button", { name: "Move selected to trash" }).tap();
    await expect.poll(() => mail.threads.filter((t) => t.state === "trash").length).toBe(TOTAL);
  });
});
