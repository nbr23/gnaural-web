/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

/** Build stamp, injected by `define` in `vite.config.ts`. See `src/app/build.ts`. */
declare const __BUILD_ID__: string;

/** Git short hash, injected by `define` in `vite.config.ts`. */
declare const __GIT_SHA__: string;
