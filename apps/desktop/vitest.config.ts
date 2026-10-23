import { defineConfig } from "vitest/config";

const conditions = ["source", "module", "node", "development|production"];

export default defineConfig({
  // Workspace packages are transformed from source rather than loaded from their builds.
  resolve: { conditions, tsconfigPaths: true },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    // Material's colour utilities import some of their own modules without the extension, which only a bundler resolves.
    server: { deps: { inline: [/@muswag\//, "@material/material-color-utilities"] } },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "coverage",
    },
  },
});
