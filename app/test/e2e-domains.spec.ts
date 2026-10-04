import { test, expect } from "@playwright/test";
import { stubMailbox, makeThreads } from "./e2eMailbox";

test("domain routing shows the request failure and Retry recovers the selected domain", async ({ page }) => {
  await stubMailbox(page, makeThreads(1));
  await page.route("**/api/domains", (route) => route.fulfill({ json: {
    domains: [{ zoneId: "abc123", name: "example.com", zoneStatus: "active", paused: false }],
  } }));
  let failing = true;
  await page.route("**/api/domain-routing/abc123?*", (route) => route.fulfill(failing
    ? { status: 502, json: { error: "failed to load domain" } }
    : { json: { detail: { zoneId: "abc123", name: "example.com", routing: { enabled: true, status: "ready" },
      rules: [], catchAll: null, destinations: [], mx: [], sending: [] } } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Domains", exact: true }).click();
  await page.getByRole("button", { name: "example.com", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("failed to load domain (HTTP 502)", { timeout: 15000 });
  failing = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a blocked routing request explains that the browser could not reach the service", async ({ page }) => {
  await stubMailbox(page, makeThreads(1));
  await page.route("**/api/domains", (route) => route.fulfill({ json: {
    domains: [{ zoneId: "abc123", name: "example.com", zoneStatus: "active", paused: false }],
  } }));
  await page.route("**/api/domain-routing/abc123?*", (route) => route.abort("blockedbyclient"));
  await page.goto("/");
  await page.getByRole("button", { name: "Domains", exact: true }).click();
  await page.getByRole("button", { name: "example.com", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("whether a browser extension blocked the request", { timeout: 15000 });
});
