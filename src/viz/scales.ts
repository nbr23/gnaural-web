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
  return timeTicksIn(0, duration, count);
}

/**
 * The same, over an arbitrary window — what a zoomed axis labels.
 *
 * The step is chosen from the window's own span, so labels stay about as far apart however far in
 * the view is; the values themselves stay round multiples measured from schedule zero, so a label
 * means the same instant at every zoom level.
 */
export function timeTicksIn(start: number, end: number, count: number): number[] {
  const rough = (end - start) / Math.max(1, count);
  const step = TIME_STEPS.find((s) => s >= rough) ?? TIME_STEPS[TIME_STEPS.length - 1];
  return gridLines(start, end, step);
}

/**
 * Steps for the snap grid — the clock ladder again, extended below a second because a grid is not
 * labelled and can therefore be far finer than `TIME_STEPS`, and because zoomed in far enough the
 * interesting distances are fractions of a second.
 */
const GRID_STEPS = [
  0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];

/** Roughly the narrowest grid a finger can aim between, and the floor the step is chosen against. */
export const MIN_GRID_PX = 14;

/**
 * The grid interval for a window, in seconds: the finest clock-round step still at least
 * `minPixels` apart on screen.
 *
 * **The grid follows the zoom**, which is the whole reason snapping is usable at all here: the
 * x-ticks are chosen for label spacing and are far too coarse to snap to (at 1× on a 73-minute
 * programme the labelled step is 300 s, about 100× the median gap between that document's nodes).
 * Zooming in is what makes the grid mean something, and is why the snap control ships off.
 */
export function timeGridStep(span: number, pixels: number, minPixels = MIN_GRID_PX): number {
  if (span <= 0 || pixels <= 0) return GRID_STEPS[0];
  const rough = (span * minPixels) / pixels;
  return GRID_STEPS.find((step) => step >= rough) ?? GRID_STEPS[GRID_STEPS.length - 1];
}

/** Round to the nearest multiple of `step`, guarding a degenerate step. */
export function snapToStep(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

/** The grid lines inside a window, for drawing. */
export function gridLines(start: number, end: number, step: number): number[] {
  if (step <= 0 || end <= start) return [];

  const lines: number[] = [];
  const first = Math.ceil(start / step);
  const last = Math.floor(end / step);
  // A window narrow enough to be all grid would draw thousands of lines; the step is chosen
  // against MIN_GRID_PX so this is a guard, not a path anything normally takes.
  if (last - first > 400) return [];

  for (let i = first; i <= last; i++) lines.push(Number((i * step).toPrecision(12)));
  return lines;
}
