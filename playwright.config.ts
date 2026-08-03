import { defineConfig, devices } from "@playwright/test";

// E2E specs live outside the vitest globs (vitest includes only *.test.{ts,tsx};
// these are *.spec.ts) so `npm test` never picks them up. Run with `npm run e2e`.
//
// e2e-images is self-contained (it routes its own origin). e2e-suggestion-
// placement needs the real app, so a preview server serves the built assets and
// the spec stubs /api/* per test.
export default defineConfig({
  testDir: "./app/test",
  testMatch: /e2e-.*\.spec\.ts$/,
  use: { ...devices["Desktop Chrome"], headless: true, baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
