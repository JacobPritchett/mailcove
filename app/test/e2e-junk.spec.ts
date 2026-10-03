// Junk end to end against an in-memory mailbox, at a desktop and a phone size.
import { test, expect } from "@playwright/test";
import { PHONE, makeThreads, stubMailbox } from "./e2eMailbox";

test.describe("junk (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("report from the keyboard, undo from the toast, then block the sender", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(5));
    await page.goto("/", { waitUntil: "networkidle" });
    const junkNav = page.getByRole("button", { name: /^Junk/ });
    await expect(junkNav).toHaveText("Junk");

    await page.keyboard.press("j");
    await page.keyboard.press("!");
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Moved to Junk" });
    await expect(toast).toBeVisible();
    await expect(page.locator("li[data-thread-id]")).toHaveCount(4);
    await expect(junkNav).toHaveText("Junk1");

    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("li[data-thread-id]")).toHaveCount(5);
    await expect(junkNav).toHaveText("Junk");

    // Again, this time taking the offer to block (once the first toast has gone).
    await expect(toast).toHaveCount(0, { timeout: 10_000 });
    await page.getByText("Thread 5", { exact: true }).click();
    await page.keyboard.press("!");
    await page.locator("[data-sonner-toast]").getByRole("button", { name: "Block this sender too" }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Blocked sender5@example.com" })).toBeVisible();
    expect(box.blocked.map((b) => b.address)).toEqual(["sender5@example.com"]);

    // Blocking did not cost the way back: the junk toast is still there with
    // its Undo (and no longer offers to block), and Undo still works.
    const kept = page.locator('[data-sonner-toast][data-removed="false"]').filter({ hasText: "Moved to Junk" });
    await expect(kept).toBeVisible();
    await expect(kept.getByRole("button", { name: "Block this sender too" })).toHaveCount(0);
    await kept.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("li[data-thread-id]")).toHaveCount(5);
    expect(box.mutations.at(-1)).toMatchObject({ action: "unspam", threadIds: ["t5"] });
  });

  test("the Junk view: note, Not junk, and the row actions", async ({ page }) => {
    const threads = makeThreads(4);
    threads[0].state = "trash";
    threads[0].spam = true;
    const box = await stubMailbox(page, threads);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Junk/ }).click();
    await expect(page.getByRole("note")).toHaveText("Mail in Junk is deleted after 30 days.");
    const row = page.locator('li[data-thread-id="t4"]');
    await row.hover();
    await expect(row.getByRole("button", { name: "Delete forever" })).toBeVisible();
    await row.getByRole("button", { name: "Not junk" }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Marked as not junk" })).toBeVisible();
    await expect(page.getByText("No messages in Junk")).toBeVisible();
    expect(box.threads.find((t) => t.thread_id === "t4")).toMatchObject({ state: "inbox", spam: false });
  });

  test("Rules: block a domain, see the Worker's refusal inline, unblock", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(2));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Rules" }).click();
    const dialog = page.getByRole("dialog");
    const field = dialog.getByLabel("Address or domain to block");

    await field.fill("@example.org");
    await field.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveText("That is one of your own domains.");
    await expect(field).toHaveAttribute("aria-invalid", "true");

    await field.fill("@ads.example");
    await field.press("Enter");
    await expect(dialog.getByText("Everyone at ads.example")).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(field).toHaveValue("");

    await dialog.getByRole("button", { name: "Unblock @ads.example" }).click();
    await expect(dialog.getByText("Nobody is blocked.")).toBeVisible();
    expect(box.blocked).toEqual([]);
  });

  test("Block sender in a message's menu confirms with the address and leaves the page usable", async ({ page }) => {
    const box = await stubMailbox(page, makeThreads(2));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Thread 2", { exact: true }).click();
    await page.getByRole("button", { name: "Message actions" }).click();
    await page.getByRole("menuitem", { name: "Block sender" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Block sender2@example.com?");
    await confirm.getByRole("button", { name: "Block sender" }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Blocked sender2@example.com" })).toBeVisible();
    expect(box.blocked.map((b) => b.address)).toEqual(["sender2@example.com"]);
    // The page is usable again: nothing is left inert behind the closed dialog.
    await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");
  });
});

test.describe("junk (phone)", () => {
  test.use(PHONE);

  test("the junk toast and its two buttons fit the screen", async ({ page }) => {
    await stubMailbox(page, makeThreads(3));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Thread 3", { exact: true }).click();
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Report junk" }).click();
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Moved to Junk" });
    await expect(toast).toBeVisible();
    const width = page.viewportSize()!.width;
    for (const name of ["Undo", "Block this sender too"]) {
      const box = (await toast.getByRole("button", { name }).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    const t = (await toast.boundingBox())!;
    expect(t.x + t.width).toBeLessThanOrEqual(width);
  });

  test("the blocked senders form fits and its controls are 44px", async ({ page }) => {
    await stubMailbox(page, makeThreads(1));
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("button", { name: "Rules" }).click();
    const dialog = page.getByRole("dialog");
    const field = dialog.getByLabel("Address or domain to block");
    await field.fill("pest@spam.example");
    const block = dialog.getByRole("button", { name: "Block", exact: true });
    for (const el of [field, block]) {
      const b = (await el.boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    await block.click();
    const unblock = dialog.getByRole("button", { name: "Unblock pest@spam.example" });
    const u = (await unblock.boundingBox())!;
    expect(Math.min(u.width, u.height)).toBeGreaterThanOrEqual(44);
  });
});
