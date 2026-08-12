import { describe, expect, it } from 'vitest';
import type { VoiceMap } from './voiceMap';
import {
  REMOVED,
  composeVoiceMaps,
  identityVoiceMap,
  insertVoiceMap,
  invertVoiceMap,
  moveVoiceMap,
  remapIndices,
  removeVoiceMap as removeAt,
} from './voiceMap';

/** Apply a map to a list of voice labels, the way the transforms apply it to voices. */
function applied(labels: string[], map: VoiceMap, inserted: string[] = []): string[] {
  const next: string[] = [...inserted];
  map.forEach((to, from) => {
    if (to >= 0) next[to] = labels[from];
  });
  return next;
}

describe('voiceMap', () => {
  it('identity leaves every index where it was', () => {
    expect(identityVoiceMap(3)).toEqual([0, 1, 2]);
    expect(identityVoiceMap(0)).toEqual([]);
  });

  it('insert shifts everything from the insertion point down', () => {
    expect(insertVoiceMap(3, 3)).toEqual([0, 1, 2]); // appended
    expect(insertVoiceMap(3, 0)).toEqual([1, 2, 3]);
    expect(insertVoiceMap(3, 1)).toEqual([0, 2, 3]);
  });

  it('remove reports the deleted voice and closes the gap', () => {
    expect(removeAt(3, 1)).toEqual([0, REMOVED, 1]);
    expect(removeAt(3, 0)).toEqual([REMOVED, 0, 1]);
    expect(removeAt(1, 0)).toEqual([REMOVED]);
  });

  it('move matches splice-out-then-splice-in, in both directions', () => {
    const labels = ['A', 'B', 'C', 'D'];

    expect(applied(labels, moveVoiceMap(4, 0, 2))).toEqual(['B', 'C', 'A', 'D']);
    expect(applied(labels, moveVoiceMap(4, 3, 0))).toEqual(['D', 'A', 'B', 'C']);
    expect(applied(labels, moveVoiceMap(4, 1, 2))).toEqual(['A', 'C', 'B', 'D']);
    expect(applied(labels, moveVoiceMap(4, 2, 1))).toEqual(['A', 'C', 'B', 'D']);
    expect(applied(labels, moveVoiceMap(4, 2, 2))).toEqual(labels);
  });

  it('inverting a move undoes it', () => {
    const labels = ['A', 'B', 'C', 'D'];
    const map = moveVoiceMap(4, 0, 3);
    const moved = applied(labels, map);

    expect(applied(moved, invertVoiceMap(map, 4))).toEqual(labels);
  });

  it('inverting an insert reports the new voice as having no previous index', () => {
    // Three voices, one inserted at the front: the new voice at 0 did not exist before.
    expect(invertVoiceMap(insertVoiceMap(3, 0), 4)).toEqual([REMOVED, 0, 1, 2]);
  });

  it('inverting a remove restores the survivors and cannot restore the deleted one', () => {
    const labels = ['A', 'B', 'C'];
    const map = removeAt(3, 1);
    const after = applied(labels, map);

    expect(after).toEqual(['A', 'C']);
    expect(invertVoiceMap(map, 2)).toEqual([0, 2]);
    expect(applied(after, invertVoiceMap(map, 2))).toEqual(['A', undefined, 'C']);
  });

  it('composing two transitions gives the same answer as applying them in turn', () => {
    const labels = ['A', 'B', 'C'];
    const first = moveVoiceMap(3, 0, 2); // B C A
    const second = removeAt(3, 0); // C A

    const stepwise = applied(applied(labels, first), second);
    const composed = applied(labels, composeVoiceMaps(first, second));

    expect(stepwise).toEqual(['C', 'A']);
    expect(composed).toEqual(stepwise);
  });

  it('a voice deleted by either half of a composition stays deleted', () => {
    expect(composeVoiceMaps(removeAt(3, 1), identityVoiceMap(2))).toEqual([0, REMOVED, 1]);
    expect(composeVoiceMaps(identityVoiceMap(3), removeAt(3, 1))).toEqual([0, REMOVED, 1]);
    // Removed twice over: the survivor of the first removal is the casualty of the second.
    expect(composeVoiceMaps(removeAt(3, 0), removeAt(2, 0))).toEqual([REMOVED, REMOVED, 0]);
  });

  it('carries a set of gates across a transition, dropping the ones that went', () => {
    // Voices 0 and 2 are soloed; voice 0 is deleted.
    expect([...remapIndices([0, 2], removeAt(3, 0))]).toEqual([1]);
    // Voice 1 is muted and moves to the front.
    expect([...remapIndices([1], moveVoiceMap(3, 1, 0))]).toEqual([0]);
    // A stray index past the end of the previous document is dropped, as it always was.
    expect([...remapIndices([5], identityVoiceMap(3))]).toEqual([]);
  });
});
