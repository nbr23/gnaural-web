import { describe, expect, it } from 'vitest';
import { formatHz, formatHzFixed } from './format';

describe('formatHzFixed', () => {
  it('keeps its decimals below 100 Hz, where the plain formatter drops them', () => {
    // The readout redraws ten times a second while a beat ramps. `formatHz` is right for prose and
    // wrong there: 9.85 → 10 → 10.25 changes the number of decimals twice a second, and the text
    // reflows with it. A constant decimal count plus tabular figures leaves only the integer digits
    // to change, which is what `.readout__tile`'s fixed width absorbs.
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
