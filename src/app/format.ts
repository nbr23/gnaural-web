/** `m:ss`, or `h:mm:ss` once a program runs past an hour (several bundled ones do). */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secondsPart = String(total % 60).padStart(2, '0');
  if (minutes < 60) return `${minutes}:${secondsPart}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${secondsPart}`;
}

/** Rounded, human phrasing for a program's length in a list — not a running clock. */
export function formatDuration(seconds: number): string {
  // Gnaural's `8-voice` is a one-second loop, and rounding that to "0 min" tells the reader nothing
  // about a program they may play for an hour.
  if (seconds < 60) return seconds < 1 ? `${seconds.toFixed(2)} s` : `${Math.round(seconds)} s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** File size at the coarse precision an estimate deserves — MB is the useful unit here, since
 *  even a short program exports tens of megabytes. */
export function formatBytes(bytes: number): string {
  const megabytes = bytes / 1024 ** 2;
  if (megabytes < 1000) return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

export function formatHz(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * The same number with its trailing zeros kept, for a figure that updates ten times a second.
 *
 * `formatHz` drops them, which is right in prose and in a field but means a ramping beat runs
 * `9.85 → 10 → 10.25` — three widths in a second. Paired with tabular figures, a fixed number of
 * decimals is what stops a live readout from shuffling itself and everything beside it.
 */
export function formatHzFixed(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
}

/**
 * A typed number, or the value it is replacing when the field says nothing usable.
 *
 * The inverse of the formatters above, and shared by every numeric field in the editor: falling back
 * to the current value is what makes a half-typed or emptied field a no-op rather than a NaN in the
 * document, which §3.4's "never fail hard on a malformed field" asks of the parser and the editor
 * has exactly as much reason to do.
 */
export function numberOr(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}
