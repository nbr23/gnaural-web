/**
 * Diagnostic switches, all of them temporary.
 *
 * They exist because the only machine that reproduces the bug being chased is a phone on someone
 * else's desk, and each round trip is expensive. Search parameters rather than hash ones so they
 * survive the hash router, and gathered in one module so that deleting the investigation is
 * deleting one file and its callers.
 *
 * | Parameter      | Effect                                                                |
 * |----------------|-----------------------------------------------------------------------|
 * | `?debug=1`     | Show the audio diagnostics readout in the player.                      |
 * | `?keepalive=0` | Do not create the silent media element (`keepalive.ts`).               |
 *
 * `?lookahead=<ms>` has been removed: it did its job, disproving the theory that the scheduling
 * lookahead was behind the Android crackling. What is left is here only until a phone confirms
 * §5.3's lock-screen controls, which is also what decides whether `keepalive.ts` survives.
 */

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

export function debugEnabled(): boolean {
  return params().get('debug') === '1';
}

export function keepaliveDisabled(): boolean {
  return params().get('keepalive') === '0';
}

/** Stamped in at build time, so it is possible to tell which build a phone is actually running. */
export const BUILD_ID: string = __BUILD_ID__;
