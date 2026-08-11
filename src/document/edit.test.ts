import { describe, expect, it } from 'vitest';
import { updateSchedule } from './edit';
import { parseSchedule } from './parser';
import { serializeSchedule } from './serializer';
import { loadFixture } from './test-fixtures';

/** A real multi-voice document, so the structural-sharing assertions have something to share. */
function fixture() {
  return parseSchedule(loadFixture('presets/oobe-lucid-dreams-2.gnaural'));
}

describe('updateSchedule', () => {
  it('applies the patch and leaves everything else alone', () => {
    const before = fixture();
    const after = updateSchedule(before, { title: 'Draft of lucid dreams', loops: 0 });

    expect(after.title).toBe('Draft of lucid dreams');
    expect(after.loops).toBe(0);
    expect(after.author).toBe(before.author);
    expect(after.description).toBe(before.description);
    expect(after.stereoSwap).toBe(before.stereoSwap);
  });

  it('never mutates its input', () => {
    const before = fixture();
    const title = before.title;
    updateSchedule(before, { title: 'something else' });
    expect(before.title).toBe(title);
  });

  /**
   * The premise the history stack's memory budget rests on. If a transform is ever rewritten with a
   * deep clone, a 200-step history goes from a few hundred kilobytes to tens of megabytes, and
   * nothing else in the suite would notice.
   */
  it('keeps the identity of everything it did not touch', () => {
    const before = fixture();
    const after = updateSchedule(before, { title: 'renamed' });

    expect(after).not.toBe(before);
    expect(after.voices).toBe(before.voices);
    expect(after.voices[0]).toBe(before.voices[0]);
    expect(after.voices[0].entries).toBe(before.voices[0].entries);
    expect(after.preserved).toBe(before.preserved);
  });

  /** So retyping a title that is already there does not push an undo step. */
  it('returns the same object when the patch changes nothing', () => {
    const before = fixture();

    expect(updateSchedule(before, {})).toBe(before);
    expect(updateSchedule(before, { title: before.title })).toBe(before);
    expect(updateSchedule(before, { masterVolume: { ...before.masterVolume } })).toBe(before);
  });

  it('compares master volume by value, since it is an object', () => {
    const before = fixture();
    const louder = { left: before.masterVolume.left / 2, right: before.masterVolume.right };
    const after = updateSchedule(before, { masterVolume: louder });

    expect(after).not.toBe(before);
    expect(after.masterVolume).toEqual(louder);
  });

  /** §3.4: unrecognised data survives a round-trip, including one that goes through the editor. */
  it('leaves preserved data intact through a serialize', () => {
    const before = fixture();
    const after = updateSchedule(before, { author: 'Someone else' });
    const reparsed = parseSchedule(serializeSchedule(after));

    expect(reparsed.author).toBe('Someone else');
    expect(reparsed.voices[0].preserved).toEqual(before.voices[0].preserved);
    expect(reparsed.voices[0].entries[0].preserved).toEqual(before.voices[0].entries[0].preserved);
  });
});
