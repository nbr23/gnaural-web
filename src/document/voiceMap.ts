/**
 * Where each voice of one document ended up in the next — the one delta a stack of immutable
 * documents still needs. The engine keys session mute/solo by index into `schedule.voices` (ids
 * aren't unique in real files), and a document alone can't say what moved — so a structural
 * transform reports it, the commit carries it, and undo applies its inverse. A synthetic uid on
 * `Voice` was rejected: the serializer would have to ignore it and a share link wouldn't preserve it.
 */

/** Old voice index -> new voice index, or `REMOVED`. Length is the *previous* voice count. */
export type VoiceMap = readonly number[];

/** The value a deleted voice maps to. */
export const REMOVED = -1;

export function identityVoiceMap(count: number): VoiceMap {
  return Array.from({ length: count }, (_unused, index) => index);
}

/** A voice appears at `at`; everything from there down shifts by one. */
export function insertVoiceMap(count: number, at: number): VoiceMap {
  return Array.from({ length: count }, (_unused, index) => (index < at ? index : index + 1));
}

export function removeVoiceMap(count: number, at: number): VoiceMap {
  return Array.from({ length: count }, (_unused, index) => {
    if (index === at) return REMOVED;
    return index < at ? index : index - 1;
  });
}

/** `splice(from, 1)` then `splice(to, 0, voice)` — the same semantics the transform implements. */
export function moveVoiceMap(count: number, from: number, to: number): VoiceMap {
  return Array.from({ length: count }, (_unused, index) => {
    if (index === from) return to;
    const afterRemoval = index > from ? index - 1 : index;
    return afterRemoval >= to ? afterRemoval + 1 : afterRemoval;
  });
}

/** The map that undoes this one. Voices the map created have no previous index and report `REMOVED`. */
export function invertVoiceMap(map: VoiceMap, nextCount: number): VoiceMap {
  const inverse = new Array<number>(nextCount).fill(REMOVED);
  map.forEach((to, from) => {
    if (to >= 0 && to < nextCount) inverse[to] = from;
  });
  return inverse;
}

/**
 * Two transitions as one. Needed because the push to the engine is throttled and keeps only the
 * most recent document: two structural commits inside one throttle interval have to arrive as one
 * map rather than one of them being dropped.
 */
export function composeVoiceMaps(first: VoiceMap, second: VoiceMap): VoiceMap {
  return first.map((middle) => (middle < 0 ? REMOVED : second[middle] ?? REMOVED));
}

/** Carry a set of voice indices — the engine's mute and solo sets — across a transition. */
export function remapIndices(indices: Iterable<number>, map: VoiceMap): Set<number> {
  const moved = new Set<number>();
  for (const index of indices) {
    const to = map[index];
    if (to !== undefined && to >= 0) moved.add(to);
  }
  return moved;
}
