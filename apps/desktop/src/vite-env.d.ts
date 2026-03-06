/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_SUBSONIC_URL?: string;
  readonly VITE_DEFAULT_SUBSONIC_USERNAME?: string;
  readonly VITE_DEFAULT_SUBSONIC_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
