/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** "1" builds the /styleguide page (local design-system preview and the UI audit environment). */
  readonly VITE_STYLEGUIDE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
