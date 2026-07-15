/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * WorkOS AuthKit client id (public identifier — safe to bake into builds).
   * Unset → the sign-in UI stays in its "coming soon" state.
   */
  readonly VITE_WORKOS_CLIENT_ID?: string;
  /**
   * Managed AI proxy endpoint. Must pair with the WorkOS environment of
   * VITE_WORKOS_CLIENT_ID (staging tokens only validate against a backend
   * running staging). Unset → production proxy.
   */
  readonly VITE_MANAGED_AI_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** App version from package.json, injected at build time (vite.config.ts). */
declare const __APP_VERSION__: string;
