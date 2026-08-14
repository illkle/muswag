import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "better-sqlite3", replacement: "better-sqlite3-test" },
      { find: /^#core\/(.*)$/, replacement: `${resolve(import.meta.dirname, "src/core")}/$1` },
      { find: "#core", replacement: resolve(import.meta.dirname, "src/core/index.ts") },
      { find: "#subsonic-api", replacement: resolve(import.meta.dirname, "src/subsonic-api/index.ts") },
    ],
  },
  test: {
    include: ["tests/benchmark/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
