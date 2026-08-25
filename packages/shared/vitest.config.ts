import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "better-sqlite3": "better-sqlite3-test",
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
    },
  },
});
