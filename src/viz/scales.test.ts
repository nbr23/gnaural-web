import { describe, expect, it } from 'vitest';
import {
  gridLines,
  linearScale,
  niceTicks,
  snapToStep,
  timeGridStep,
  timeTicks,
  timeTicksIn,
} from './scales';

describe('linearScale', () => {
  it('maps the domain onto the range', () => {
    const scale = linearScale([0, 10], [100, 300]);
    expect(scale.toPixel(0)).toBe(100);
    expect(scale.toPixel(10)).toBe(300);
    expect(scale.toPixel(5)).toBe(200);
  });

  it('inverts, so a pixel resolves back to its value', () => {
    const scale = linearScale([4, 11], [0, 640]);
    for (const value of [4, 6.5, 9.125, 11]) {
      expect(scale.toValue(scale.toPixel(value))).toBeCloseTo(value, 9);
    }
  });

  it('handles an inverted range, as a y-axis needs', () => {
    const scale = linearScale([0, 100], [200, 50]);
    expect(scale.toPixel(0)).toBe(200);
    expect(scale.toPixel(100)).toBe(50);
    expect(scale.toValue(125)).toBeCloseTo(50);
  });

  it('pads a degenerate domain instead of dividing by zero', () => {
    const scale = linearScale([164, 164], [100, 0]);
    expect(Number.isFinite(scale.toPixel(164))).toBe(true);
    expect(scale.toPixel(164)).toBeCloseTo(50);
    expect(scale.domain[0]).toBeLessThan(scale.domain[1]);
  });

  it('pads a degenerate domain at zero', () => {
    const scale = linearScale([0, 0], [0, 100]);
    expect(Number.isFinite(scale.toPixel(0))).toBe(true);
    expect(scale.domain).toEqual([-1, 1]);
  });
});

describe('niceTicks', () => {
  it('produces round values covering the domain', () => {
    expect(niceTicks([0, 10], 5)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('stays inside the domain', () => {
    const ticks = niceTicks([153.2, 164.8], 4);
    expect(ticks[0]).toBeGreaterThanOrEqual(153.2);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(164.8);
  });

  it('does not accumulate floating-point drift on fractional steps', () => {
    expect(niceTicks([0, 1], 4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});

describe('timeTicks', () => {
  it('uses clock-shaped intervals rather than powers of ten', () => {
    expect(timeTicks(1200, 6)).toEqual([0, 300, 600, 900, 1200]);
  });

  it('always starts at zero', () => {
    expect(timeTicks(37, 6)[0]).toBe(0);
  });

  it('never overshoots the duration', () => {
    const ticks = timeTicks(3600, 6);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(3600);
  });
});

describe('timeTicksIn', () => {
  it('labels a zoomed window in values measured from schedule zero', () => {
    expect(timeTicksIn(1000, 1100, 4)).toEqual([1020, 1050, 1080]);
  });

  it('is the whole-schedule case when the window is the whole schedule', () => {
    expect(timeTicksIn(0, 1200, 6)).toEqual(timeTicks(1200, 6));
  });
});

describe('timeGridStep', () => {
  it('picks the finest clock-round step still far enough apart to aim between', () => {
    expect(timeGridStep(600, 600)).toBe(15);
    expect(timeGridStep(60, 600)).toBe(2);
  });

  it('goes below a second once the window is small enough, since a grid carries no label', () => {
    expect(timeGridStep(5, 600)).toBe(0.25);
    expect(timeGridStep(0.5, 600)).toBe(0.02);
  });

  it('tops out rather than inventing a step, however far out the view is', () => {
    expect(timeGridStep(10_000_000, 600)).toBe(3600);
  });

  it('never divides by a degenerate span or width', () => {
    expect(timeGridStep(0, 600)).toBeGreaterThan(0);
    expect(timeGridStep(600, 0)).toBeGreaterThan(0);
  });
});

describe('snapToStep', () => {
  it('rounds to the nearest multiple', () => {
    expect(snapToStep(13, 5)).toBe(15);
    expect(snapToStep(12, 5)).toBe(10);
  });

  it('passes a value through untouched when there is no grid', () => {
    expect(snapToStep(13.7, 0)).toBe(13.7);
  });
});

describe('gridLines', () => {
  it('lists the multiples inside the window, at absolute times', () => {
    expect(gridLines(10, 25, 5)).toEqual([10, 15, 20, 25]);
  });

  it('draws nothing rather than thousands of lines for a degenerate step', () => {
    expect(gridLines(0, 3600, 0.01)).toEqual([]);
    expect(gridLines(0, 10, 0)).toEqual([]);
  });
});
