// Three things that were broken on a phone, each pinned by measurement.
import { test, expect } from "@playwright/test";
import { PHONE, makeThreads, stubMailbox } from "./e2eMailbox";

test.use(PHONE);

test("the reply placeholder is one line and cannot sit on top of the quoted message", async ({ page }) => {
  await stubMailbox(page, makeThreads(2));
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByText("Thread 2", { exact: true }).click();
  await page.getByRole("button", { name: /^Reply to / }).click();
  const empty = page.locator(".ProseMirror [data-placeholder]").first();
  await expect(empty).toBeVisible();
  // On a phone the tip about the slash menu is left out.
  await expect(empty).toHaveAttribute("data-placeholder", "Write your reply…");

  const m = await empty.evaluate((el) => {
    const before = getComputedStyle(el, "::before");
    const line = parseFloat(getComputedStyle(el).lineHeight);
    const quote = el.ownerDocument.querySelector(".ProseMirror blockquote");
    return {
      whiteSpace: before.whiteSpace,
      overflow: before.overflowX,
      position: before.position,
      float: before.float,
      beforeHeight: parseFloat(before.height),
      line,
      bottom: el.getBoundingClientRect().bottom,
      quoteTop: quote ? quote.getBoundingClientRect().top : null,
    };
  });
  expect(m.whiteSpace).toBe("nowrap");
  expect(m.overflow).toBe("hidden");
  expect(m.position).toBe("absolute");
  expect(m.float).toBe("none");
  // One line tall, and the quoted text starts below the empty line it sits on.
  expect(m.beforeHeight).toBeLessThanOrEqual(m.line + 1);
  expect(m.quoteTop).not.toBeNull();
  expect(m.quoteTop!).toBeGreaterThanOrEqual(m.bottom - 0.5);
});

test("a long placeholder is still held to one line (the full tip, in a narrow box)", async ({ page }) => {
  await stubMailbox(page, makeThreads(2));
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByText("Thread 2", { exact: true }).click();
  await page.getByRole("button", { name: /^Reply to / }).click();
  const empty = page.locator(".ProseMirror [data-placeholder]").first();
  await expect(empty).toBeVisible();
  const height = await empty.evaluate((el) => {
    el.setAttribute("data-placeholder", "Write your reply… ( / for blocks, markdown works) and then some more words to be sure");
    const before = getComputedStyle(el, "::before");
    return { before: parseFloat(before.height), line: parseFloat(getComputedStyle(el).lineHeight), width: parseFloat(before.width), box: el.getBoundingClientRect().width };
  });
  expect(height.before).toBeLessThanOrEqual(height.line + 1);
  expect(height.width).toBeLessThanOrEqual(height.box + 0.5);
});

test("the blocked images banner shows its whole Always button, sender included", async ({ page }) => {
  const threads = makeThreads(2);
  threads[0].from = "The Weekly Byte <news@weeklybyte.example>";
  threads[0].blockedImages = 3;
  await stubMailbox(page, threads);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByText("Thread 2", { exact: true }).click();
  const always = page.getByRole("button", { name: "Always show from news@weeklybyte.example" });
  await expect(always).toBeVisible();
  const width = page.viewportSize()!.width;
  const b = (await always.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(width);
  expect(b.height).toBeGreaterThanOrEqual(44);
  // Nothing is cut off: no ellipsis, and the text fits its box.
  const clipped = await always.evaluate((el) => {
    const span = el.querySelector("span")!;
    return span.scrollWidth > span.clientWidth + 1 || getComputedStyle(span).textOverflow === "ellipsis";
  });
  expect(clipped).toBe(false);
  expect((await page.getByRole("button", { name: "Display images" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("compose: Cc and Bcc stay on screen beside a long recipient list", async ({ page }) => {
  await stubMailbox(page, makeThreads(1));
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Compose" }).click();
  const to = page.getByLabel("Add recipient");
  for (const address of [
    "anna.lindqvist@lindqvist.example",
    "maya@okafor.example",
    "a.very.long.address.for.testing.the.layout@subdomain.of.another.example.org",
  ]) {
    await to.fill(address);
    await to.press("Enter");
  }
  const width = page.viewportSize()!.width;
  const dialog = page.getByRole("dialog");
  for (const name of ["Cc", "Bcc"]) {
    const button = dialog.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const b = (await button.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(width);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
  // Every chip is inside the dialog, the long one shortened with its full text a hover away.
  for (const remove of await dialog.getByRole("button", { name: /^Remove / }).all()) {
    const b = (await remove.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(width);
  }
  await expect(dialog.getByTitle("a.very.long.address.for.testing.the.layout@subdomain.of.another.example.org")).toBeVisible();
  const overflow = await dialog.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(overflow).toBe(false);

  await dialog.getByRole("button", { name: "Cc", exact: true }).tap();
  await expect(dialog.getByLabel("Add Cc recipient")).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Bcc", exact: true })).toBeVisible();
});

test("small icon buttons take a 44px tap: recipient chips, and the reply box's Expand and Discard", async ({ page }) => {
  await stubMailbox(page, makeThreads(2));
  await page.goto("/", { waitUntil: "networkidle" });
  /** The element that a tap `dx` px left of and `dy` px above the button's centre would hit. */
  const hitNear = (name: string, dx: number, dy: number) =>
    page.getByRole("button", { name }).evaluate(
      (el, [x, y]) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2 - x, r.y + r.height / 2 - y);
        return hit === el || el.contains(hit);
      },
      [dx, dy],
    );

  await page.getByText("Thread 2", { exact: true }).click();
  await page.getByRole("button", { name: /^Reply to / }).click();
  for (const name of ["Discard reply", "Open in full composer"]) {
    const b = (await page.getByRole("button", { name }).boundingBox())!;
    expect(b.width).toBeLessThan(44); // still looks small
    expect(await hitNear(name, 0, 20)).toBe(true);
    expect(await hitNear(name, 0, -20)).toBe(true);
  }
  // Between the two, each owns its half.
  expect(await hitNear("Discard reply", -20, 0)).toBe(true);
  await page.getByRole("button", { name: "Discard reply" }).click();

  await page.getByRole("button", { name: "Compose" }).click();
  const to = page.getByLabel("Add recipient");
  await to.fill("anna@lindqvist.example");
  await to.press("Enter");
  const remove = "Remove anna@lindqvist.example";
  expect((await page.getByRole("button", { name: remove }).boundingBox())!.width).toBeLessThanOrEqual(16);
  for (const [dx, dy] of [[0, 20], [0, -20], [-20, 0], [20, 0]]) expect(await hitNear(remove, dx, dy)).toBe(true);
});
