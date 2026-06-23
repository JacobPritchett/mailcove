import { test, expect } from "@playwright/test";

// Stable origin for the harness so the explicit-origin CSP actually matches.
const ORIGIN = "http://images.test";
// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// The harness builds the SAME sandboxed srcdoc iframe + meta CSP that Reader.tsx
// uses, with three images: data:, same-origin /api/media, cross-origin sender.
function harness(): string {
  const csp = `default-src 'none'; img-src data: ${ORIGIN}/api/media; style-src 'unsafe-inline'; font-src data:; base-uri 'none'`;
  const inner =
    `<!doctype html><html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `</head><body>` +
    `<img id="dataimg" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==">` +
    `<img id="ok" src="${ORIGIN}/api/media?t=tok">` +
    `<img id="blocked" src="http://sender.test/pixel.png">` +
    `</body></html>`;
  // Encode for the srcdoc attribute (escape quotes).
  const srcdoc = inner.replace(/"/g, "&quot;");
  return `<!doctype html><html><body><iframe sandbox="allow-popups" srcdoc="${srcdoc}"></iframe></body></html>`;
}

test.beforeEach(async ({ page }) => {
  await page.route(`${ORIGIN}/`, (r) => r.fulfill({ contentType: "text/html", body: harness() }));
  await page.route(`${ORIGIN}/api/media*`, (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.route("http://sender.test/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
});

test("sandboxed srcdoc iframe: data: and /api/media load by URL; direct sender URL is CSP-blocked", async ({ page }) => {
  await page.goto(`${ORIGIN}/`);
  const frame = page.frameLocator("iframe");
  // data: image renders (CSP allows data:)
  await expect.poll(() => frame.locator("#dataimg").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  // same-origin /api/media renders — proves the opaque-origin sandboxed iframe
  // loads it purely by URL (no Access cookie) and the path-scoped CSP allows it.
  await expect.poll(() => frame.locator("#ok").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  // direct cross-origin sender URL is blocked by CSP (never loads).
  expect(await frame.locator("#blocked").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(0);
});
