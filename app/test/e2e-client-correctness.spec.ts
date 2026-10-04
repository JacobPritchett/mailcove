// Keyboard and focus behaviour that jsdom cannot show: implicit form
// submission, where a shortcut's own character ends up, and what the real
// editor does with focus. Runs against the built app with /api stubbed.
import { test, expect, type Page } from "@playwright/test";

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const ROWS = ["t1", "t2"].map((id, i) => ({
  thread_id: id, id: `m${id}`, msg_from: "Alice <alice@example.com>", msg_to: "hello@example.com",
  subject: `Thread ${i + 1}`, snippet: "s", date: Date.now() - i * 1000, count: 1, anyUnread: 0,
  hasAttachments: 0, starred: 0, category: null,
}));

const thread = (id: string) => ({
  thread_id: id,
  messages: [{
    id: `m${id}`, thread_id: id, direction: "in", folder: "inbox", msg_from: "Alice <alice@example.com>",
    msg_to: "hello@example.com", subject: `Subject ${id}`, snippet: "s", date: Date.now(), unread: 0,
    has_attachments: 0, msg_cc: null, message_id: "<mid@example.com>", in_reply_to: null,
    body: { text: "hello", html: `<p>Hello</p><a id="link" href="http://dest.test/page">a link</a>`, attachments: [] },
  }],
});

/** Stub the API; returns the list of /api/send request bodies seen. */
async function stubApi(page: Page, opts: { sendDelayMs?: number } = {}) {
  const sends: unknown[] = [];
  // These specs are about a send that goes out at once; the hold that Undo
  // send puts in front of it has its own (e2e-undo-send).
  await page.addInitScript(() => localStorage.setItem("mailcove.undo-send", "0"));
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === "/api/me") return route.fulfill(json({ email: "hello@example.com" }));
    if (p === "/api/counts")
      return route.fulfill(json({ inbox: 2, starred: 0, sent: 0, all: 2, trash: 0, inboxUnread: 0, drafts: 0, domains: [] }));
    if (p === "/api/messages") return route.fulfill(json({ threads: ROWS, unread: 0 }));
    if (p.startsWith("/api/threads/") && req.method() === "GET")
      return route.fulfill(json(thread(decodeURIComponent(p.split("/")[3]))));
    if (p === "/api/contacts") return route.fulfill(json({ contacts: [] }));
    if (p === "/api/identities")
      return route.fulfill(
        json({
          identities: [{ domain: "example.com", sendingDomain: "send.example.com", displayName: "S", signature: "" }],
          defaultLocal: "hello",
          defaultDomain: "example.com",
        }),
      );
    if (p === "/api/drafts") return route.fulfill(json({ drafts: [] }));
    if (p === "/api/send") {
      sends.push(req.postDataJSON());
      if (opts.sendDelayMs) await new Promise((r) => setTimeout(r, opts.sendDelayMs));
      return route.fulfill(json({ ok: true, id: "sent" }));
    }
    return route.fulfill(json({ ok: true }));
  });
  return sends;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("c opens compose with the caret in To, and the c is not typed into it", async ({ page }) => {
  await stubApi(page);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.keyboard.press("c");
  const to = page.getByLabel("Add recipient");
  await expect(to).toBeFocused();
  await expect(to).toHaveValue("");
  await page.keyboard.type("bob@example.com");
  await expect(to).toHaveValue("bob@example.com");
});

test("Enter in Subject, From name and From local never sends; Subject hands over to the body", async ({ page }) => {
  const sends = await stubApi(page);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.keyboard.press("c");
  await page.getByLabel("Add recipient").fill("bob@example.com");
  await page.locator(".ProseMirror").waitFor();

  for (const label of ["From name", "From local part"]) {
    await page.getByLabel(label).click();
    await page.keyboard.press("Enter");
  }
  await page.getByLabel("Subject").click();
  await page.keyboard.type("Hello");
  await page.keyboard.press("Enter");

  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.keyboard.type("body text");
  await expect(page.locator(".ProseMirror")).toContainText("body text");
  await page.waitForTimeout(300);
  expect(sends).toHaveLength(0);
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("Cmd/Ctrl+Enter pressed twice sends exactly one message", async ({ page }) => {
  const sends = await stubApi(page, { sendDelayMs: 300 });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.keyboard.press("c");
  await page.getByLabel("Add recipient").fill("bob@example.com");
  await page.getByLabel("Subject").fill("Hello");
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("body text");
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ to: ["bob@example.com"], subject: "Hello" });
});

test("inline reply: r does not type an r, and a double Ctrl+Enter sends once", async ({ page }) => {
  const sends = await stubApi(page, { sendDelayMs: 300 });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByText("Thread 1").click();
  await page.getByRole("heading", { name: "Subject t1" }).waitFor();
  await page.keyboard.press("r");
  const editor = page.getByTestId("inline-reply").locator(".ProseMirror");
  await expect(editor).toBeFocused();
  await page.keyboard.type("my reply");
  const text = await editor.innerText();
  expect(text.startsWith("my reply")).toBe(true);
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sends.length).toBe(1);
  // The composer collapses back to its one-line affordance once the send lands.
  await expect(page.getByTestId("inline-reply").locator(".ProseMirror")).toHaveCount(0);
  expect(sends).toHaveLength(1);
});

test("a link in an HTML message opens a new tab and the message stays put", async ({ page, context }) => {
  await stubApi(page);
  await context.route("http://dest.test/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<title>dest</title>" }),
  );
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByText("Thread 1").click();
  const frame = page.frameLocator('iframe[title^="Message from"]');
  const [popup] = await Promise.all([context.waitForEvent("page"), frame.locator("#link").click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe("http://dest.test/page");
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expect(frame.locator("#link")).toBeVisible();
});

test("Escape in search clears the query, then leaves the field", async ({ page }) => {
  await stubApi(page);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.keyboard.press("/");
  const search = page.getByLabel("Search messages", { exact: true });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await page.keyboard.type("invoice");
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).not.toBeFocused();
});

test("opening /?thread=<id> selects that thread and cleans the URL", async ({ page }) => {
  await stubApi(page);
  await page.goto("/?thread=t2", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Subject t2" })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
});

test("mobile Back closes one layer at a time, top first, and never leaves the app", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await stubApi(page);
  await page.goto("/", { waitUntil: "networkidle" });
  const home = page.url();

  await page.getByText("Thread 1").click();
  await expect(page.getByRole("button", { name: "Back to list" })).toBeVisible();
  await page.getByRole("button", { name: "Compose" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Back to list" })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("button", { name: "Back to list" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  expect(page.url()).toBe(home);

  // Drawer handing over to a dialog (one closes as the other opens), then Back.
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: /Rules|Filters/ }).last().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(200);
  await page.goBack();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  expect(page.url()).toBe(home);
});

