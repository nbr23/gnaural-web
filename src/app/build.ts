/**
 * Which build this is, stamped in by `define` in `vite.config.ts` and shown at the foot of the
 * library. With `registerType: 'prompt'` an installed PWA keeps serving its precached build until
 * told otherwise, so this is the only always-visible answer to "is this the build I deployed?".
 */
export const BUILD_ID: string = __BUILD_ID__;

/** Git short hash of the commit this was built from. Empty outside the Docker build. */
export const GIT_SHA: string = __GIT_SHA__;
