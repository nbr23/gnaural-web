import { describe, expect, it } from 'vitest';
import { parseSchedule } from '../document/parser';
import { serializeSchedule } from '../document/serializer';
import { CORPUS_TIMEOUT, fixtureNames, loadFixture } from '../document/test-fixtures';
import type { Schedule, Voice } from '../document/types';
import {
  MAX_SHARE_PAYLOAD,
  ShareTooLargeError,
  decodeSharePayload,
  encodeSharePayload,
  shareUrl,
} from './shareLink';

// Four of Gnaural's own presets exceed the fragment guard. Pinned by name so the set can only
// change deliberately: a program quietly joining it loses its share button.
const TOO_LARGE_TO_SHARE = [
  'gnaural/euphoria.gnaural',
  'gnaural/full-moon.gnaural',
  'gnaural/hypnagogic-gale.gnaural',
  'gnaural/instant-nap.gnaural',
];

describe('share payloads', () => {
  const shareable = fixtureNames().filter((name) => !TOO_LARGE_TO_SHARE.includes(name));

  it.each(shareable)('round-trips %s to the same document', { timeout: CORPUS_TIMEOUT }, async (name) => {
    const original = parseSchedule(loadFixture(name));
    const shared = await decodeSharePayload(await encodeSharePayload(original));

    expect(serializeSchedule(shared)).toBe(serializeSchedule(original));
  });

  it.each(TOO_LARGE_TO_SHARE)('refuses %s rather than truncating it', { timeout: CORPUS_TIMEOUT }, async (name) => {
    const original = parseSchedule(loadFixture(name));

    await expect(encodeSharePayload(original)).rejects.toBeInstanceOf(ShareTooLargeError);
  });

  it('uses only base64url characters, so the fragment needs no escaping', async () => {
    const payload = await encodeSharePayload(parseSchedule(loadFixture('powernap.gnaural')));

    expect(payload).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(encodeURIComponent(payload)).toBe(payload);
  });

  it('compresses a real program to a link-sized payload', async () => {
    const payload = await encodeSharePayload(parseSchedule(loadFixture('powernap.gnaural')));

    expect(payload.length).toBeLessThan(2000);
  });

  it('refuses a payload past the fragment guard', async () => {
    await expect(encodeSharePayload(oversized())).rejects.toBeInstanceOf(ShareTooLargeError);
  });

  it('builds a URL on the current page with the payload in the fragment', () => {
    expect(shareUrl('abc')).toBe(`${window.location.origin}${window.location.pathname}#/s/abc`);
  });
});

// A schedule too big to share. Deflate is so effective on repetitive XML that a merely long program
// is nowhere near the guard — the entries have to be incompressible, so every value is random.
function oversized(): Schedule {
  const voice: Voice = {
    id: 0,
    description: 'noise',
    type: 0,
    muted: false,
    hidden: false,
    mono: false,
    entries: Array.from({ length: 4000 }, () => ({
      duration: Math.random() * 10,
      baseFreq: 100 + Math.random() * 300,
      beatFreq: Math.random() * 30,
      volumeLeft: Math.random(),
      volumeRight: Math.random(),
      preserved: {},
    })),
    preserved: {},
  };

  return {
    title: 'Too large',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [voice],
    preserved: {},
  };
}

it('sanity-checks the guard against the largest bundled program', async () => {
  const largest = parseSchedule(loadFixture('airplanetravelaid.gnaural'));

  expect((await encodeSharePayload(largest)).length).toBeLessThan(MAX_SHARE_PAYLOAD / 4);
});
