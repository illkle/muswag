import { defineConfig } from "vitest/config";

const conditions = ["source", "module", "node", "development|production"];

export default defineConfig({
  // Workspace packages are transformed from source rather than loaded from their builds.
  resolve: { conditions, tsconfigPaths: true },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    server: { deps: { inline: [/@muswag\//] } },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "coverage",
    },
  },
});
