import { describe, expect, it } from 'vitest';
import { formatHz, formatHzFixed } from './format';

describe('formatHzFixed', () => {
  it('keeps its decimals below 100 Hz, where the plain formatter drops them', () => {
    expect(formatHzFixed(10)).toBe('10.00');
    expect(formatHz(10)).toBe('10');

    const decimals = new Set(
      [9.85, 10, 10.25, 4, 0.5].map((hz) => formatHzFixed(hz).split('.')[1]?.length),
    );
    expect(decimals).toEqual(new Set([2]));
  });

  it('drops the decimals where they would be noise, as the plain formatter does', () => {
    expect(formatHzFixed(210)).toBe('210');
    expect(formatHzFixed(440)).toBe('440');
  });
});
