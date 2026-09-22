import { builtinModules } from "node:module";

import { defineConfig } from "vite";

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

function isExternal(id: string): boolean {
  return id === "electron" || id.startsWith("electron/") || nodeBuiltins.has(id);
}

export default defineConfig({
  resolve: {
    conditions: ["source", "module", "node", "development|production"],
  },
  build: {
    copyPublicDir: false,
    emptyOutDir: false,
    lib: {
      entry: "src/preload/index.ts",
      fileName: () => "index.cjs",
      formats: ["cjs"],
    },
    minify: false,
    outDir: "out/preload",
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
