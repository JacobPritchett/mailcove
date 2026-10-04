// Undo send in a real browser, with the real editor: the hold, Undo, the
// page going away mid-hold, and a failure nobody was there to see.
import { test, expect, type Page } from "@playwright/test";
import { makeThreads, stubMailbox, PHONE } from "./e2eMailbox";

const subjectField = (page: Page) => page.getByRole("textbox", { name: "Subject" });

async function writeMessage(page: Page, subject: string) {
  await page.getByRole("button", { name: "Compose" }).first().click();
  await page.getByLabel("Add recipient").fill("ada@example.com");
  await subjectField(page).fill(subject);
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("The body of the message.");
}
const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
const toastUndo = (page: Page) => page.getByRole("button", { name: "Undo" });
/** The toast of a held message. The Send button also reads "Sending..." for a moment, so match the toast itself. */
const holding = (page: Page) =>
  // The newest one: a toast taken back by Undo is still fading out when the next appears.
  page.locator("[data-sonner-toast]").filter({ hasText: "Sending\u2026" }).last();

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Send holds the message, Undo puts the composer back, and the second Send goes out once", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(3), { undoSendSeconds: 5 });
    await page.goto("/", { waitUntil: "networkidle" });
    await writeMessage(page, "Lunch on Friday");
    await page.getByRole("button", { name: "Cc", exact: true }).click();
    await page.getByLabel("Add Cc recipient").fill("carol@example.com");
    await send(page);

    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(holding(page)).toBeVisible();
    await expect(toastUndo(page)).toBeVisible();
    expect(mail.sends).toHaveLength(0);
    // The draft is on the server before anything is held.
    expect(mail.drafts.size).toBe(1);

    await toastUndo(page).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("ada@example.com")).toBeVisible();
    await expect(dialog.getByText("carol@example.com")).toBeVisible();
    await expect(subjectField(page)).toHaveValue("Lunch on Friday");
    await expect(page.locator(".ProseMirror")).toContainText("The body of the message.");
    // Focus is back in the composer, not lost with the toast.
    await expect(page.locator(".ProseMirror")).toBeFocused();

    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(holding(page)).toBeVisible();
    await expect(page.getByText("Sent ✓")).toBeVisible({ timeout: 10_000 });
    expect(mail.sends).toHaveLength(1);
    expect(mail.sends[0]).toMatchObject({ to: ["ada@example.com"], cc: ["carol@example.com"], subject: "Lunch on Friday" });
    // Sent from its draft, and the draft went with it.
    expect(mail.drafts.size).toBe(0);
  });

  test("opening a held message from Drafts cancels its send before editing", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(3), { undoSendSeconds: 5 });
    await page.goto("/", { waitUntil: "networkidle" });
    await writeMessage(page, "Edit before sending");
    await send(page);
    await expect(holding(page)).toBeVisible();
    await page.getByRole("button", { name: /^Drafts/ }).first().click();
    await page.getByRole("list", { name: "Drafts" }).getByText("Edit before sending").click();
    await expect(subjectField(page)).toHaveValue("Edit before sending");
    await page.waitForTimeout(5500);
    expect(mail.sends).toHaveLength(0);
  });

  test("deleting a held draft also cancels its queued send", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(3), { undoSendSeconds: 5 });
    await page.goto("/", { waitUntil: "networkidle" });
    await writeMessage(page, "Cancel by deleting");
    await send(page);
    await expect(holding(page)).toBeVisible();
    await page.getByRole("button", { name: /^Drafts/ }).first().click();
    await page.getByRole("button", { name: "Delete draft Cancel by deleting" }).click();
    await page.waitForTimeout(5500);
    expect(mail.sends).toHaveLength(0);
    expect(mail.drafts.size).toBe(0);
  });

  test("z takes a held message back", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(3), { undoSendSeconds: 5 });
    await page.goto("/", { waitUntil: "networkidle" });
    await writeMessage(page, "Taken back by keyboard");
    await send(page);
    await expect(holding(page)).toBeVisible();
    await page.keyboard.press("z");
    await expect(subjectField(page)).toHaveValue("Taken back by keyboard");
    await page.waitForTimeout(5500);
    expect(mail.sends).toHaveLength(0);
  });

  /** What the browser does to a tab that is switched away from. */
  const hidePage = (page: Page) =>
    page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });

  // The page going away for good is covered against the real Worker by hand
  // (a reload mid-hold: the message is in Sent, the draft is gone). Here the
  // page is hidden instead, which takes the same path and can be observed:
  // a request made by a page that is unloading is not reliably routed.
  test("hiding the page during the hold sends the message at once, on a keepalive request", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(3), { undoSendSeconds: 30 });
    await page.goto("/", { waitUntil: "networkidle" });
    await writeMessage(page, "Sent as the page went");
    await send(page);
    await expect(holding(page)).toBeVisible();
    const keepalive = page.waitForRequest((r) => r.url().endsWith("/api/send"));
    await hidePage(page);
    await keepalive;
    await expect.poll(() => mail.sends.length).toBe(1);
    expect(mail.sends[0]).toMatchObject({ subject: "Sent as the page went" });
    // Small enough for the browser to finish after the page is gone.
    expect(JSON.stringify(mail.sends[0]).length).toBeLessThan(64 * 1024);
    await expect.poll(() => mail.drafts.size).toBe(0);
    await expect(toastUndo(page)).toHaveCount(0);
  });

  test("a send that fails while the page is hidden is still on screen on return, with its draft", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(3), { undoSendSeconds: 30, sendStatus: 502 });
    await page.goto("/", { waitUntil: "networkidle" });
    await writeMessage(page, "Never arrived");
    await send(page);
    await expect(holding(page)).toBeVisible();
    await hidePage(page);
    await expect.poll(() => mail.sends.length).toBe(1);
    expect(mail.drafts.size).toBe(1);
    // Not a toast that times out: it waits for the user to come back.
    await page.waitForTimeout(5000);
    await expect(page.getByText("Couldn’t confirm sending. Check Sent before sending again. Your saved draft can be reopened.")).toBeVisible();
    await page.getByRole("button", { name: "Open draft" }).click();
    await expect(subjectField(page)).toHaveValue("Never arrived");
    await expect(page.getByRole("dialog").getByText("ada@example.com")).toBeVisible();
  });

  test("a message an earlier page never got an answer for is reported on the next visit when its draft is still there", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(3));
    const draftId = "0b0e6a1c-1111-4222-8333-444455556666";
    mail.drafts.set(draftId, { to: "ada@example.com", subject: "Never arrived", bodyText: "The body." });
    // What the earlier page left behind as it went.
    await page.addInitScript((id) => {
      localStorage.setItem(
        "mailcove.outbox",
        JSON.stringify([{ id: "held-earlier", draftId: id, to: "ada@example.com", subject: "Never arrived", due: Date.now() - 60_000 }]),
      );
    }, draftId);
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByText('"Never arrived" to ada@example.com still has a saved draft. Check Sent before sending again; delivery could not be confirmed.')).toBeVisible();
    await page.getByRole("button", { name: "Open draft" }).click();
    await expect(subjectField(page)).toHaveValue("Never arrived");
    expect(mail.sends).toHaveLength(0);
  });

  test("and nothing is said when its draft is gone, because the Worker accepted it", async ({ page }) => {
    await stubMailbox(page, makeThreads(3));
    await page.addInitScript(() => {
      localStorage.setItem(
        "mailcove.outbox",
        JSON.stringify([{ id: "held-earlier", draftId: "0b0e6a1c-1111-4222-8333-444455556666", to: "ada@example.com", subject: "Arrived", due: Date.now() - 60_000 }]),
      );
    });
    await page.goto("/", { waitUntil: "networkidle" });
    await expect.poll(() => page.evaluate(() => localStorage.getItem("mailcove.outbox"))).toBeNull();
    await expect(page.getByText(/delivery could not be confirmed/)).toHaveCount(0);
  });

  test("the delay can be turned off in Settings, and then Send goes at once", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(3), { undoSendSeconds: 10 });
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Settings" }).click();
    const choices = page.getByRole("radiogroup", { name: "Undo send" });
    await expect(choices.getByRole("radio", { name: "10 seconds" })).toBeChecked();
    await choices.getByRole("radio", { name: "Off" }).click();
    await expect(choices.getByRole("radio", { name: "Off" })).toBeChecked();
    await page.keyboard.press("Escape");
    await writeMessage(page, "No hold");
    await send(page);
    await expect(page.getByText("Sent ✓")).toBeVisible();
    expect(mail.sends).toHaveLength(1);
    await expect(toastUndo(page)).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ ...PHONE });

  test("an inline reply is held, its Undo is thumb-sized, and Undo puts the reply back in place", async ({ page }) => {
    const mail = await stubMailbox(page, makeThreads(3), { undoSendSeconds: 5 });
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Thread 3", { exact: true }).click();
    await page.getByTestId("inline-reply").click();
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("On my way.");
    await page.getByTestId("inline-reply").getByRole("button", { name: "Send" }).click();

    await expect(holding(page)).toBeVisible();
    const undo = await toastUndo(page).boundingBox();
    expect(undo!.height).toBeGreaterThanOrEqual(44);
    expect(mail.sends).toHaveLength(0);
    // Nothing pushed sideways by the toast.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

    await toastUndo(page).click();
    await expect(page.getByTestId("inline-reply").locator(".ProseMirror")).toContainText("On my way.");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByTestId("inline-reply").getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Sent ✓")).toBeVisible({ timeout: 10_000 });
    expect(mail.sends).toHaveLength(1);
    expect(mail.sends[0]).toMatchObject({ to: "sender3@example.com", threadId: "t3" });
    expect(String(mail.sends[0].text)).toContain("On my way.");
  });
});
