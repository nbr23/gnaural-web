/**
 * Which build this is, stamped in by `define` in `vite.config.ts` and shown at the foot of the
 * library.
 *
 * Kept deliberately, after the temporary diagnostics around it were deleted. With
 * `registerType: 'prompt'` an installed PWA goes on serving its precached build until it is told
 * otherwise, so "is this actually the code I just deployed?" is a real question with no other
 * answer on screen — and during the Android investigation it was the most useful thing there. It
 * costs one line of build config and a line of small print.
 *
 * `UpdatePrompt` answers the same question from the other side, by offering the newer build when
 * one is waiting. The two are complementary: the prompt appears only when something is ready, this
 * is always readable.
 */
export const BUILD_ID: string = __BUILD_ID__;

/** Git short hash of the commit this was built from. Empty outside the Docker build, which is
 * the only place `GIT_SHA` is passed through. */
export const GIT_SHA: string = __GIT_SHA__;
