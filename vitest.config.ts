import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const appAlias = {
  "@": fileURLToPath(new URL("./app", import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      {
        // Worker tests: node environment, no DOM.
        test: {
          name: "worker",
          environment: "node",
          globals: true,
          include: ["src/**/*.test.ts"],
        },
      },
      {
        // React component tests: jsdom + jest-dom matchers.
        plugins: [react()],
        resolve: {
          alias: [
            // The rich body editor (ProseMirror) needs real DOM ranges jsdom
            // lacks; tests get a textarea-backed mock implementing the same
            // ComposeBodyHandle contract. Must precede the generic "@" alias.
            {
              find: /^@\/components\/EmailBodyEditor$/,
              replacement: fileURLToPath(
                new URL("./app/test/mocks/EmailBodyEditorMock.tsx", import.meta.url),
              ),
            },
            { find: "@", replacement: appAlias["@"] },
          ],
        },
        test: {
          name: "app",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./app/test/setup.ts"],
          include: ["app/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
