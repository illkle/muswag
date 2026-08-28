import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source", "module", "node", "development|production"],
    tsconfigPaths: true,
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "coverage",
    },
  },
});
