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
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function formatHz(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(2).replace(/\.?0+$/, '');
}
