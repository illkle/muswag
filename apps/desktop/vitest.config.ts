import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const conditions = ["source", "module", "node", "development|production"];

export default defineConfig({
  // Workspace packages are transformed from source rather than loaded from their builds.
  resolve: { conditions, tsconfigPaths: true },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    // A cache of this package's own: the packages' tests run side by side, and a lockfile change has
    // each of them clear a shared one at once.
    fsModuleCachePath: fileURLToPath(new URL("node_modules/.vitest-cache", import.meta.url)),
    server: { deps: { inline: [/@muswag\//] } },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "coverage",
    },
  },
});
