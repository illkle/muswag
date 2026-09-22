import { builtinModules } from "node:module";

import { defineConfig } from "vite";

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const runtimePackages = ["better-sqlite3", "effect", "electron-updater"];

function isExternal(id: string): boolean {
  if (id === "electron" || id.startsWith("electron/")) return true;
  if (nodeBuiltins.has(id)) return true;
  return runtimePackages.some((name) => id === name || id.startsWith(`${name}/`));
}

export default defineConfig({
  resolve: {
    conditions: ["source", "module", "node", "development|production"],
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
