import { defineConfig } from "vitest/config";
import { devtools } from "@tanstack/devtools-vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tanstackRouter from "@tanstack/router-plugin/vite";

export const rendererConfig = defineConfig({
  clearScreen: false,
  root: ".",
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_"],
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "coverage",
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    outDir: "out/renderer",
    target: "chrome124",
  },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackRouter({
      target: "react",
      routesDirectory: "src/renderer/routes",
      generatedRouteTree: "src/renderer/routeTree.gen.ts",
      autoCodeSplitting: true,
    }),
    viteReact(),
  ],
});

export default rendererConfig;
