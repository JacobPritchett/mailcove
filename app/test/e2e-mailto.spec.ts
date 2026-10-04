// mailto: links with the real frame and the real editor: a link in a message
// and a link handed over by the browser both open the composer, filled in,
// and neither sends anything.
import { test, expect, type Page } from "@playwright/test";
import { makeThreads, stubMailbox, PHONE } from "./e2eMailbox";

function threads() {
  const t = makeThreads(2);
  t[0].html = `<p>Questions? <a id="write" href="mailto:Support%20Desk%20%3Csupport@example.com%3E?subject=Order%2042&body=Hello%2C%0A%0AAbout%20my%20order.">Write to us</a></p>`;
  return t;
}
const subject = (page: Page) => page.getByRole("textbox", { name: "Subject" });

for (const [name, use] of [
  ["desktop", { viewport: { width: 1280, height: 800 } }],
  ["phone", PHONE],
] as const) {
  test.describe(name, () => {
    test.use(use);

    test("a mailto: link in a message opens the composer in the app, filled in", async ({ page, context }) => {
      const mail = await stubMailbox(page, threads());
      await page.goto("/", { waitUntil: "networkidle" });
      await page.getByText("Thread 2", { exact: true }).click();
      const pages = context.pages().length;
      await page.frameLocator('iframe[title^="Message from"]').locator("#write").click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("support@example.com")).toBeVisible();
      await expect(subject(page)).toHaveValue("Order 42");
      await expect(page.locator(".ProseMirror")).toContainText("About my order.");
      // The app did not open a tab or hand the link to another program.
      expect(context.pages().length).toBe(pages);
      // Ready to write in, and nothing has gone anywhere.
      await expect(page.locator(".ProseMirror")).toBeFocused();
      expect(mail.sends).toHaveLength(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    });

    test("a link handed over by the browser opens the composer and leaves the address bar clean", async ({ page }) => {
      const mail = await stubMailbox(page, threads());
      const link = "mailto:ada@example.com?cc=carol@example.com&subject=From%20another%20site&body=Line%20one";
      await page.goto(`/?compose=${encodeURIComponent(link)}`, { waitUntil: "networkidle" });
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("ada@example.com")).toBeVisible();
      await expect(dialog.getByText("carol@example.com")).toBeVisible();
      await expect(subject(page)).toHaveValue("From another site");
      await expect(page.locator(".ProseMirror")).toContainText("Line one");
      expect(new URL(page.url()).search).toBe("");
      await page.waitForTimeout(300);
      expect(mail.sends).toHaveLength(0);
      // Send is there, enabled, and still the user's to press.
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    });
  });
}

test.describe("hostile links", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("an oversized link with control characters and an attachment request fills in only what is safe", async ({ page }) => {
    const mail = await stubMailbox(page, threads());
    const link =
      "mailto:ada@example.com%0D%0ABcc:evil@example.com,real@example.com" +
      "?attach=C:%5Csecrets.txt&subject=Hi%00%1B%5B31m%E2%80%AEthere&body=" + "A".repeat(9_000);
    await page.goto(`/?compose=${encodeURIComponent(link)}`, { waitUntil: "networkidle" });
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("real@example.com")).toBeVisible();
    await expect(dialog.getByText(/evil@example\.com/)).toHaveCount(0);
    const value = await subject(page).inputValue();
    // No control or direction-override characters reach the field.
    expect(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(value)).toBe(false);
    expect(await page.locator(".ProseMirror").innerText()).not.toContain("secrets");
    // Bounded: the link is cut at 8000 characters before it is even parsed.
    expect((await page.locator(".ProseMirror").innerText()).length).toBeLessThan(8000);
    await expect(dialog.locator("li", { hasText: "secrets" })).toHaveCount(0);
    expect(mail.sends).toHaveLength(0);
  });

  test("the manifest registers the app for mailto: links", async ({ page }) => {
    const res = await page.request.get("/manifest.webmanifest");
    const manifest = (await res.json()) as { protocol_handlers?: unknown };
    expect(manifest.protocol_handlers).toEqual([{ protocol: "mailto", url: "/?compose=%s" }]);
  });

  test("Settings offers to register, from a button with a name", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { registered: unknown[] }).registered = [];
      navigator.registerProtocolHandler = (...args: unknown[]) => {
        (window as unknown as { registered: unknown[] }).registered.push(args);
      };
    });
    await stubMailbox(page, threads());
    await page.goto("/", { waitUntil: "networkidle" });
    expect(await page.evaluate(() => (window as unknown as { registered: unknown[] }).registered)).toEqual([]);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Open email links here" }).click();
    expect(await page.evaluate(() => (window as unknown as { registered: unknown[] }).registered)).toEqual([
      ["mailto", `${new URL(page.url()).origin}/?compose=%s`],
    ]);
  });
});
