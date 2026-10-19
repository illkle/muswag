import { builtinModules } from "node:module";

import { build, defineConfig, type Plugin } from "vite";

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
// Shipped in the app's node_modules rather than bundled. Everything else is bundled, so that only the
// parts of a package main uses are packaged and loaded.
const runtimePackages = ["electron-updater"];

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
function searchWorker(minify: boolean): Plugin {
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
          minify,
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

export default defineConfig(({ mode }) => ({
  plugins: [searchWorker(mode !== "development")],
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
    // Comments and whitespace are most of an unminified bundle, and V8 keeps the source of every function it
    // loads. Development keeps its names and lines, for the stack traces in the terminal.
    minify: mode !== "development",
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
}));
