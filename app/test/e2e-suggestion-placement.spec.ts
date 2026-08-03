// Where the recipient-suggestion list actually LANDS, in a real browser.
//
// This file exists because the unit tests could not have caught the bug it
// pins. `computePlacement` was arithmetically correct, and the jsdom test
// asserted the listbox's DOM parent — but `position: fixed` resolves against
// the nearest ancestor carrying a transform, not the viewport, and the compose
// dialog is centred with `translate: -50% -50%`. Hosting the portal inside the
// dialog therefore put every coordinate in the dialog's frame: 353px of
// horizontal error at 1280x800, with the list sheared off the dialog edge and
// sitting over the body editor.
//
// It measured perfectly at 390 wide, because below `sm` the dialog is
// full-bleed and that error is exactly zero — so a mobile-only check passed it.
// Hence: assert the geometry, at a desktop width AND a mobile one.
import { test, expect, type Page } from "@playwright/test";

const CONTACTS = {
  contacts: Array.from({ length: 8 }, (_, i) => ({
    email: `alice${i}@example.com`,
    name: `Alice Number ${i}`,
  })),
};

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function stubApi(page: Page) {
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/me") return route.fulfill(json({ email: "hello@example.com" }));
    if (p === "/api/counts")
      return route.fulfill(
        json({ inbox: 0, starred: 0, sent: 0, all: 0, trash: 0, inboxUnread: 0, drafts: 0, domains: [] }),
      );
    if (p === "/api/messages") return route.fulfill(json({ threads: [], unread: 0 }));
    if (p === "/api/contacts") return route.fulfill(json(CONTACTS));
    if (p === "/api/identities")
      return route.fulfill(
        json({
          identities: [
            { domain: "example.com", sendingDomain: "send.example.com", displayName: "S", signature: "" },
          ],
          defaultLocal: "hello",
          defaultDomain: "example.com",
        }),
      );
    if (p === "/api/drafts") return route.fulfill(json({ drafts: [] }));
    return route.fulfill(json({ ok: true }));
  });
}

/** Open compose, type into To, and measure the list against its field. */
async function measure(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /compose/i }).first().click();
  const to = page.locator('input[aria-controls="contact-suggestions"]').first();
  await to.click();
  await to.type("alice", { delay: 30 });
  await page.waitForSelector("#contact-suggestions");
  return page.evaluate(() => {
    const ul = document.getElementById("contact-suggestions")!;
    const field = document
      .querySelector('input[aria-controls="contact-suggestions"]')!
      .closest("div")!;
    const l = ul.getBoundingClientRect();
    const f = field.getBoundingClientRect();
    return {
      dx: Math.round(l.left - f.left),
      dy: Math.round(l.top - f.bottom),
      overflowsRight: Math.round(l.right - window.innerWidth),
      overflowsBottom: Math.round(l.bottom - window.innerHeight),
      clickable: getComputedStyle(ul).pointerEvents === "auto",
    };
  });
}

// 390 is where the dialog is full-bleed (the error cancels); 1280 and 844 are
// where hosting the portal in the dialog was 353px and 135px out.
for (const [w, h] of [
  [390, 800],
  [390, 320],
  [844, 390],
  [1280, 800],
] as const) {
  test(`suggestion list sits under its field at ${w}x${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await stubApi(page);

    const m = await measure(page);

    expect(m.dx).toBe(0); // same left edge as the field
    expect(m.dy).toBeGreaterThanOrEqual(0); // below it, never overlapping
    expect(m.dy).toBeLessThanOrEqual(8); // and touching it, not adrift
    expect(m.overflowsRight).toBeLessThanOrEqual(0);
    expect(m.overflowsBottom).toBeLessThanOrEqual(0);
    // Radix sets pointer-events:none on the body while a modal is open.
    expect(m.clickable).toBe(true);
  });
}

test("an option can actually be clicked from the portal", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubApi(page);
  await measure(page);

  await page.locator("#contact-suggestions li").first().click();

  await expect(page.getByLabel("Remove alice0@example.com")).toBeVisible();
});
