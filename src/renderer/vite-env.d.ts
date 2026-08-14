/// <reference types="vite/client" />

import type { ElectronAPI } from "@electron-toolkit/preload";

declare global {
  interface Window {
    electron: ElectronAPI;
  }

  interface ImportMetaEnv {
    readonly VITE_DEFAULT_SUBSONIC_URL?: string;
    readonly VITE_DEFAULT_SUBSONIC_USERNAME?: string;
    readonly VITE_DEFAULT_SUBSONIC_PASSWORD?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
