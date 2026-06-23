import { defineConfig, devices } from "@playwright/test";

// E2E proof for safe-image rendering. Self-contained (routes its own origin), so
// no webServer is needed. Lives outside the vitest globs (vitest includes only
// *.test.{ts,tsx}; this is *.spec.ts) so `npm test` never picks it up.
export default defineConfig({
  testDir: "./app/test",
  testMatch: /e2e-.*\.spec\.ts$/,
  use: { ...devices["Desktop Chrome"], headless: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
