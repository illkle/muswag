import { createRequire } from "node:module";

import { devtools } from "@tanstack/devtools-vite";
import { electronToChromium } from "electron-to-chromium";
import { defineConfig } from "vite";

import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tanstackRouter from "@tanstack/router-plugin/vite";

import babel from "@rolldown/plugin-babel";

const require = createRequire(import.meta.url);
const electronVersion = (require("electron/package.json") as { version: string }).version;
const chromiumVersion = electronToChromium(electronVersion.split(".").slice(0, 2).join("."));

if (!chromiumVersion) {
  throw new Error(`No Chromium target found for Electron ${electronVersion}`);
}

export const rendererConfig = defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    target: `chrome${chromiumVersion}`,
  },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackRouter({
      target: "react",
      routesDirectory: "routes",
      generatedRouteTree: "routeTree.gen.ts",
      autoCodeSplitting: true,
    }),
    viteReact(),
    babel({
      presets: [reactCompilerPreset()],
    }),
  ],
});

export default rendererConfig;
