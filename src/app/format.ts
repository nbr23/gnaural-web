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
  if (seconds < 60) return seconds < 1 ? `${seconds.toFixed(2)} s` : `${Math.round(seconds)} s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** File size at the coarse precision an estimate deserves. */
export function formatBytes(bytes: number): string {
  const megabytes = bytes / 1024 ** 2;
  if (megabytes < 1000) return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

export function formatHz(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * The same number with its trailing zeros kept, so a live-updating readout (ten times a second
 * while a beat ramps) doesn't reflow: `formatHz` drops them, which would shuffle the digit count
 * every frame.
 */
export function formatHzFixed(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
}

/** A typed number, or the value it's replacing when the field says nothing usable. */
export function numberOr(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}
