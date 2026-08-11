import { describe, expect, it } from 'vitest';
import { formatHash, parseHash } from './routing';

describe('parseHash', () => {
  it('reads a bundled program route', () => {
    expect(parseHash('#/p/powernap')).toEqual({ view: 'program', id: 'powernap' });
  });

  it('reads an imported program route', () => {
    expect(parseHash('#/i/2f9b')).toEqual({ view: 'imported', id: '2f9b' });
  });

  it('reads the live route, which carries nothing', () => {
    expect(parseHash('#/live')).toEqual({ view: 'live' });
    expect(parseHash('#live')).toEqual({ view: 'live' });
  });

  it('reads a share route, taking the payload verbatim', () => {
    expect(parseHash('#/s/q1bO-_AA')).toEqual({ view: 'shared', payload: 'q1bO-_AA' });
  });

  it('falls back to the library for empty, unknown, and malformed hashes', () => {
    expect(parseHash('')).toEqual({ view: 'library' });
    expect(parseHash('#')).toEqual({ view: 'library' });
    expect(parseHash('#/')).toEqual({ view: 'library' });
    expect(parseHash('#/nonsense')).toEqual({ view: 'library' });
    // Not base64url, so it cannot be a share payload and must not be treated as one.
    expect(parseHash('#/s/not a payload')).toEqual({ view: 'library' });
    // The route an opened file used before imports were persisted; now nothing.
    expect(parseHash('#/opened')).toEqual({ view: 'library' });
  });

  it('round-trips ids that need escaping', () => {
    const route = { view: 'program', id: 'a program/with slash' } as const;
    expect(parseHash(formatHash(route))).toEqual(route);
  });
});

describe('formatHash', () => {
  it('formats each view', () => {
    expect(formatHash({ view: 'library' })).toBe('#/');
    expect(formatHash({ view: 'live' })).toBe('#/live');
    expect(formatHash({ view: 'program', id: 'sleep-smr' })).toBe('#/p/sleep-smr');
    expect(formatHash({ view: 'imported', id: '2f9b' })).toBe('#/i/2f9b');
    expect(formatHash({ view: 'shared', payload: 'q1bO-_AA' })).toBe('#/s/q1bO-_AA');
  });
});
