/**
 * Renderer-agnostic scales (PLAN.md §6.2 — "keep the geometry/hit-test logic renderer-agnostic").
 * No DOM, no React, no SVG: value <-> pixel arithmetic only.
 */

export interface Scale {
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  /** Map a data value onto the pixel range. */
  toPixel(value: number): number;
  /** Map a pixel back onto a data value — the inverse a pointer needs to answer "what is here?". */
  toValue(pixel: number): number;
}

/** Widening applied to a zero-width domain, as a fraction of the value (or absolute, at zero). */
const DEGENERATE_PAD = 0.05;

/**
 * A constant-valued curve (a voice whose base frequency never changes) collapses the domain to a
 * single point, which would divide by zero. Pad it instead, so the curve draws as a flat line
 * through the middle of its lane rather than vanishing.
 */
function widen([min, max]: readonly [number, number]): [number, number] {
  if (min !== max) return [min, max];
  const pad = Math.abs(min) * DEGENERATE_PAD || 1;
  return [min - pad, max + pad];
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const [d0, d1] = widen(domain);
  const [r0, r1] = range;
  const scale = (r1 - r0) / (d1 - d0);

  return {
    domain: [d0, d1],
    range: [r0, r1],
    toPixel: (value) => r0 + (value - d0) * scale,
    toValue: (pixel) => d0 + (pixel - r0) / scale,
  };
}

const TICK_STEPS = [1, 2, 2.5, 5, 10];

/** Round, evenly spaced values covering `domain`, at roughly `count` intervals. */
export function niceTicks(domain: readonly [number, number], count: number): number[] {
  const [min, max] = widen(domain);
  const rough = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = (TICK_STEPS.find((s) => s * magnitude >= rough) ?? 10) * magnitude;

  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step / 1e6; t += step) {
    // Re-derive from the step index rather than accumulating, which drifts on fractional steps.
    ticks.push(Number((Math.round(t / step) * step).toPrecision(12)));
  }
  return ticks;
}

/** Tick intervals people actually read a clock in, rather than powers of ten of seconds. */
const TIME_STEPS = [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** Round time ticks (in seconds) from 0 to `duration`, at roughly `count` intervals. */
export function timeTicks(duration: number, count: number): number[] {
  const rough = duration / Math.max(1, count);
  const step = TIME_STEPS.find((s) => s >= rough) ?? TIME_STEPS[TIME_STEPS.length - 1];

  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);
  return ticks;
}
