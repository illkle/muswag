import { createRequire } from "node:module";
import { resolve } from "node:path";

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

// Set to let a browser on another machine run the renderer; see src/main/dev-bridge.ts.
const devBridgePort = process.env.MUSWAG_DEV_BRIDGE_PORT;

export const rendererConfig = defineConfig({
  clearScreen: false,
  root: resolve(import.meta.dirname, "src/renderer"),
  // Production renderer is loaded via file://, so asset URLs must be relative.
  base: "./",
  server: {
    host: "127.0.0.1",
    // A second checkout running at the same time needs a port of its own.
    port: Number(process.env.MUSWAG_DEV_PORT) || 5173,
    strictPort: true,
    ...(devBridgePort
      ? {
          allowedHosts: [".ts.net"],
          proxy: {
            "/__bridge": {
              target: `http://127.0.0.1:${devBridgePort}`,
              // The bridge answers only to its own name, whatever name the browser reached this server by.
              changeOrigin: true,
              // The proxy leaves a response open when main dies in the middle of it, and the browser must see its event stream end.
              configure: (proxy) => proxy.on("proxyRes", (proxyResponse, _request, response) => proxyResponse.on("close", () => proxyResponse.complete || response.destroy())),
            },
          },
        }
      : {}),
  },
  resolve: {
    conditions: ["source", "module", "browser", "development|production"],
    dedupe: ["react", "react-dom"],
    tsconfigPaths: true,
  },
  build: {
    emptyOutDir: false,
    outDir: resolve(import.meta.dirname, "out/renderer"),
    sourcemap: true,
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
