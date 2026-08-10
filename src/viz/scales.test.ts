import { describe, expect, it } from 'vitest';
import { linearScale, niceTicks, timeTicks } from './scales';

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
    // A voice whose base frequency never changes collapses its domain to a single value.
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
    // 1200s / 6 ~= 200s rough, which rounds up to the 5-minute step.
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
