import { test, expect } from "@playwright/test";
import { makeThreads, stubMailbox } from "./e2eMailbox";

test("failed save recovers name, address, text and attachment after reload", async ({ page }) => {
  const mail = await stubMailbox(page, makeThreads(1), { undoSendSeconds: 5 });
  let failing = true;
  await page.route("**/api/drafts/**", async route => {
    if (route.request().method() === "PUT" && failing) return route.fulfill({ status: 503, json: { error: "offline" } });
    return route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Add recipient" }).fill("person@example.org");
  await dialog.getByRole("textbox", { name: "Subject", exact: true }).fill("Recover this message");
  await dialog.getByRole("textbox", { name: "From name" }).fill("Custom Sender");
  await dialog.getByRole("textbox", { name: "From local part" }).fill("billing");
  await dialog.locator(".ProseMirror").fill("Important reply with my signature");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("keep this file") });
  await expect(dialog.getByRole("status")).toContainText("Recovery copy", { timeout: 10000 });
  await expect(dialog.getByRole("note")).toContainText("files are attached");
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.reload();
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.getByRole("button", { name: /Recover this message.*Device recovery/ }).click();
  await expect(dialog.getByRole("textbox", { name: "From name" })).toHaveValue("Custom Sender");
  await expect(dialog.getByRole("textbox", { name: "From local part" })).toHaveValue("billing");
  await expect(dialog.locator(".ProseMirror")).toContainText("Important reply with my signature");
  await expect(dialog.getByText("note.txt", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Retry saving" })).toBeVisible({ timeout: 10000 });
  failing = false;
  await dialog.getByRole("button", { name: "Retry saving" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Draft saved");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => mail.sends.length).toBe(1);
  expect(mail.sends[0]).toMatchObject({ fromName: "Custom Sender", from: "billing@example.com", attachments: [{ filename: "note.txt", data: "a2VlcCB0aGlzIGZpbGU=" }] });
});

test("inline failed send stays visible and changing identity survives expansion", async ({ page }) => {
  await stubMailbox(page, makeThreads(1), { sendStatus: 503 });
  await page.goto("/");
  await page.getByText("Thread 1", { exact: true }).click();
  const box = page.getByTestId("inline-reply");
  await box.click();
  await box.getByRole("textbox", { name: "From name" }).fill("Support Team");
  await box.getByRole("textbox", { name: "From local part" }).fill("support");
  await box.locator(".ProseMirror").fill("Reply from support");
  await box.getByRole("button", { name: "Send", exact: true }).click();
  await expect(box.getByRole("alert")).toContainText("Check Sent before trying again");
  await expect(box.locator(".ProseMirror")).toContainText("Reply from support");
  await box.getByRole("button", { name: "Open in full composer" }).click();
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "From name" })).toHaveValue("Support Team");
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "From local part" })).toHaveValue("support");
});

test("sent details show the stored name instead of losing it behind You", async ({ page }) => {
  const rows = makeThreads(1);
  rows[0].direction = "out";
  rows[0].from = "billing@example.com";
  rows[0].message = { body: { text: "Invoice", html: "", attachments: [], headers: { fromName: "Accounts Team" } } };
  await stubMailbox(page, rows);
  await page.goto("/");
  await page.getByRole("button", { name: /^Sent/ }).click();
  await page.getByText("Thread 1", { exact: true }).click();
  await expect(page.getByText("You · Accounts Team", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "to me@example.com", exact: true }).click();
  await expect(page.getByText("Accounts Team <billing@example.com>", { exact: true })).toBeVisible();
});


test("an oversized reply asks before bypassing Undo send", async ({ page }) => {
  const mail = await stubMailbox(page, makeThreads(1), { undoSendSeconds: 5 });
  await page.goto("/");
  await page.getByText("Thread 1", { exact: true }).click();
  const box = page.getByTestId("inline-reply");
  await box.click();
  await box.locator(".ProseMirror").fill("Large reply ".repeat(6000));
  await box.getByRole("button", { name: "Send", exact: true }).click();
  await expect(box.getByRole("alert")).toContainText("too large for Undo send");
  expect(mail.sends).toHaveLength(0);
  await box.getByRole("button", { name: "Send immediately", exact: true }).click();
  await expect.poll(() => mail.sends.length).toBe(1);
});

test("a receive-only domain explains the fallback address before sending", async ({ page }) => {
  const rows = makeThreads(1);
  rows[0].domain = "receive-only.example";
  await stubMailbox(page, rows);
  await page.goto("/");
  await page.getByText("Thread 1", { exact: true }).click();
  const box = page.getByTestId("inline-reply");
  await box.click();
  await expect(box.getByText(/receive-only.example cannot send/)).toBeVisible();
  await expect(box.getByRole("combobox", { name: "From domain" })).toHaveValue("example.com");
});

test("custom identity survives send, Undo, reload, and the next reply", async ({ page }) => {
  const mail = await stubMailbox(page, makeThreads(1), { undoSendSeconds: 5 });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Add recipient").fill("client@example.org");
  await dialog.getByLabel("Subject", { exact: true }).fill("Identity continuity");
  await dialog.getByLabel("From name").fill("Project Team");
  await dialog.getByLabel("From local part").fill("projects");
  await dialog.locator(".ProseMirror").fill("First message");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(dialog.getByLabel("From name")).toHaveValue("Project Team");
  await expect(dialog.getByLabel("From local part")).toHaveValue("projects");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => mail.sends.length, { timeout: 10000 }).toBe(1);
  const first = mail.sends[0];
  // The browser transport models the backend's stored-name contract, which
  // is separately tested against the real send handler in send_from.test.ts.
  await page.route("**/api/threads/t1", route => route.fulfill({ json: {
    thread_id: "t1", messages: [
      { id: "original", thread_id: "t1", direction: "out", domain: "example.com", folder: "sent", state: "inbox",
        msg_from: first.from, msg_to: Array.isArray(first.to) ? first.to.join(", ") : first.to, snippet: "First message", subject: first.subject, date: 1, message_id: "<original@example.com>",
        body: { text: first.text, html: "", attachments: [], headers: { fromName: first.fromName } } },
      { id: "response", thread_id: "t1", direction: "in", domain: "example.com", folder: "inbox", state: "inbox",
        msg_from: "Client <client@example.org>", msg_to: first.from, envelope_to: first.from, snippet: "Thanks",
        subject: first.subject, date: 2, message_id: "<response@example.org>",
        body: { text: "Thanks, please reply", html: "", attachments: [] } },
    ],
  } }));
  await page.reload();
  await page.getByText("Thread 1", { exact: true }).click();
  const box = page.getByTestId("inline-reply");
  await box.click();
  await expect(box.getByLabel("From name")).toHaveValue("Project Team");
  await expect(box.getByLabel("From local part")).toHaveValue("projects");
  await box.locator(".ProseMirror").fill("Following up");
  await box.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => mail.sends.length, { timeout: 10000 }).toBe(2);
  expect(mail.sends[1]).toMatchObject({ fromName: "Project Team", from: "projects@example.com", threadId: "t1" });
});
