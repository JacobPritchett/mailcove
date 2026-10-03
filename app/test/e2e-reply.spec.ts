// Reply targeting with the real editor: reply all never sticks, and what is
// sent goes to the people the box named.
import { test, expect, type Page } from "@playwright/test";
import { makeThreads, stubMailbox } from "./e2eMailbox";

test.use({ viewport: { width: 1280, height: 800 } });

function threads() {
  const t = makeThreads(3);
  for (const x of t) x.cc = "dev@patel.example, anna@lindqvist.example";
  return t;
}
const box = (page: Page) => page.getByTestId("inline-reply");
const open = (page: Page, subject: string) => page.getByText(subject, { exact: true }).click();

test("reply all, discard, then the plain reply box: a plain reply, also after a thread switch and on send", async ({ page }) => {
  const mail = await stubMailbox(page, threads());
  await page.goto("/", { waitUntil: "networkidle" });
  await open(page, "Thread 3");
  await expect(box(page)).toContainText("Reply to sender3@example.com");

  await page.getByRole("button", { name: "Reply all" }).last().click();
  await expect(box(page)).toContainText("Replying to sender3@example.com and 2 more");
  await page.getByRole("button", { name: "Discard reply" }).click();
  await expect(box(page)).toContainText("Reply to sender3@example.com");
  await box(page).click();
  await expect(box(page)).toContainText("Replying to sender3@example.com as");
  await expect(box(page)).not.toContainText("more");
  await page.getByRole("button", { name: "Discard reply" }).click();

  // Reply all on one thread says nothing about the next.
  await page.getByRole("button", { name: "Reply all" }).last().click();
  await expect(box(page)).toContainText("and 2 more");
  await open(page, "Thread 2");
  await expect(page.getByRole("heading", { name: "Thread 2" })).toBeVisible();
  await box(page).click();
  await expect(box(page)).toContainText("Replying to sender2@example.com as");
  await expect(box(page)).not.toContainText("more");

  await page.locator(".ProseMirror").click();
  await page.keyboard.type("just for you");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(() => mail.sends.length).toBe(1);
  expect(mail.sends[0]).toMatchObject({ to: "sender2@example.com" });
  expect(mail.sends[0].cc).toBeUndefined();

  // And after a send, r is a plain reply to the same thread's sender.
  await expect(box(page)).toContainText("Reply to sender2@example.com");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("r");
  await expect(box(page)).toContainText("Replying to sender2@example.com as");
  await expect(box(page)).not.toContainText("more");
});

test("a typed reply is not turned into a reply all by a stray key", async ({ page }) => {
  const mail = await stubMailbox(page, threads());
  await page.goto("/", { waitUntil: "networkidle" });
  await open(page, "Thread 3");
  await page.keyboard.press("r");
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("only for the sender");
  // Focus leaves the editor (a click on the page), then `a`.
  await page.getByRole("heading", { name: "Thread 3" }).click();
  await page.keyboard.press("a");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Discard this reply and start a new one?");
  await confirm.getByRole("button", { name: "Keep writing" }).click();
  await expect(box(page)).not.toContainText("more");
  await expect(page.locator(".ProseMirror")).toContainText("only for the sender");
  await box(page).getByRole("button", { name: "Send" }).click();
  await expect.poll(() => mail.sends.length).toBe(1);
  expect(mail.sends[0].cc).toBeUndefined();
});
