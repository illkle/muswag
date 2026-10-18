import { builtinModules } from "node:module";

import { build, defineConfig, type Plugin } from "vite";

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const runtimePackages = ["effect", "electron-updater"];

function isExternal(id: string): boolean {
  if (id === "electron" || id.startsWith("electron/")) return true;
  if (nodeBuiltins.has(id)) return true;
  return runtimePackages.some((name) => id === name || id.startsWith(`${name}/`));
}

const conditions = ["source", "module", "node", "development|production"];

/**
 * Bundles the search worker (`src/main/search/search-worker.ts`) whole, into `search-worker.cjs` next
 * to main's `index.cjs`. A worker thread loads a script of its own; as a second entry of this build it
 * would share chunks with main, and loading one of them would start main again inside the worker.
 */
function searchWorker(): Plugin {
  return {
    name: "muswag:search-worker",
    async buildStart() {
      const result = await build({
        configFile: false,
        logLevel: "warn",
        resolve: { conditions },
        build: {
          write: false,
          lib: { entry: "src/main/search/search-worker.ts", fileName: () => "search-worker.cjs", formats: ["cjs"] },
          minify: false,
          rollupOptions: { external: isExternal },
          target: "node24",
        },
      });
      for (const output of (Array.isArray(result) ? result : [result]) as Array<{ output: Array<{ type: string; fileName: string; code?: string; moduleIds?: string[] }> }>) {
        for (const chunk of output.output) {
          if (chunk.type !== "chunk") continue;
          for (const id of chunk.moduleIds ?? []) if (!id.startsWith("\0")) this.addWatchFile(id);
          this.emitFile({ type: "asset", fileName: chunk.fileName, source: chunk.code ?? "" });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [searchWorker()],
  resolve: {
    conditions,
  },
  build: {
    copyPublicDir: false,
    emptyOutDir: true,
    lib: {
      entry: "src/main/index.ts",
      fileName: () => "index.cjs",
      formats: ["cjs"],
    },
    minify: false,
    outDir: "out/main",
    rollupOptions: {
      external: isExternal,
      output: {
        chunkFileNames: "chunks/[name]-[hash].cjs",
      },
    },
    sourcemap: true,
    target: "node24",
  },
});
