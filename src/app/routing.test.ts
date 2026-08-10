import { describe, expect, it } from 'vitest';
import { formatHash, parseHash } from './routing';

describe('parseHash', () => {
  it('reads a bundled program route', () => {
    expect(parseHash('#/p/powernap')).toEqual({ view: 'program', id: 'powernap' });
  });

  it('reads the opened-file route', () => {
    expect(parseHash('#/opened')).toEqual({ view: 'opened' });
  });

  it('falls back to the library for empty, unknown, and reserved hashes', () => {
    expect(parseHash('')).toEqual({ view: 'library' });
    expect(parseHash('#')).toEqual({ view: 'library' });
    expect(parseHash('#/')).toEqual({ view: 'library' });
    expect(parseHash('#/nonsense')).toEqual({ view: 'library' });
    // Reserved for step 8's share links; until they exist it must not look like a program.
    expect(parseHash('#/s/AAAA')).toEqual({ view: 'library' });
  });

  it('round-trips ids that need escaping', () => {
    const route = { view: 'program', id: 'a program/with slash' } as const;
    expect(parseHash(formatHash(route))).toEqual(route);
  });
});

describe('formatHash', () => {
  it('formats each view', () => {
    expect(formatHash({ view: 'library' })).toBe('#/');
    expect(formatHash({ view: 'program', id: 'sleep-smr' })).toBe('#/p/sleep-smr');
    expect(formatHash({ view: 'opened' })).toBe('#/opened');
  });
});
