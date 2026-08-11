/**
 * Diagnostic switches, all of them temporary.
 *
 * They exist because the only machine that reproduces the bug being chased is a phone on someone
 * else's desk, and each round trip is expensive. Search parameters rather than hash ones so they
 * survive the hash router, and gathered in one module so that deleting the investigation is
 * deleting one file and its callers.
 *
 * | Parameter        | Effect                                                              |
 * |------------------|---------------------------------------------------------------------|
 * | `?debug=1`       | Show the audio diagnostics readout in the player.                    |
 * | `?keepalive=0`   | Do not create the silent media element (`keepalive.ts`).             |
 * | `?lookahead=120` | Override the transport scheduling lookahead, in **milliseconds**.    |
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

/** Seconds, or null to leave `scheduleLookahead` to work it out from the device. */
export function lookaheadOverride(): number | null {
  const raw = params().get('lookahead');
  if (raw === null) return null;

  const milliseconds = Number(raw);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1000 : null;
}

/** Stamped in at build time, so it is possible to tell which build a phone is actually running. */
export const BUILD_ID: string = __BUILD_ID__;
