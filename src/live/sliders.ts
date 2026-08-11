import type { EegBand } from '../viz/bands';
import { EEG_BANDS } from '../viz/bands';
import type { Range } from './liveSchedule';
import { BEAT_RANGE, clampTo } from './liveSchedule';

/**
 * Slider geometry for Live mode — pure, and renderer-agnostic in the same way `viz/scales.ts` is.
 *
 * **Both frequency sliders are logarithmic, and that is the load-bearing choice.** Pitch is
 * perceived logarithmically: a linear 40–800 Hz slider spends half its travel above 400 Hz, where
 * a binaural carrier is doing nothing interesting, and is coarse at 100–200 Hz where the whole
 * corpus lives. Beat is worse — the EEG bands (§1) are roughly geometric, so a linear 0.5–40 Hz
 * slider gives Delta, which every sleep program uses, 9% of its travel. Log gives it 47%.
 */

/** Slider positions are 0..1 with this step, i.e. 1000 stops — 0.3%/step on base, 0.44% on beat,
 *  which is also what an arrow key moves. */
export const SLIDER_STEP = 0.001;

export function positionToValue(range: Range, position: number): number {
  const clamped = Math.min(1, Math.max(0, position));
  return clampTo(range, range.min * (range.max / range.min) ** clamped);
}

export function valueToPosition(range: Range, value: number): number {
  const clamped = Math.min(range.max, Math.max(range.min, value));
  return Math.log(clamped / range.min) / Math.log(range.max / range.min);
}

/**
 * Where the EEG band boundaries fall on the beat slider, as native tick marks.
 *
 * **The slider does not snap to them.** The bands are conventional labels over a continuum, and
 * hunting for the frequency that works for you is the entire point of Live mode — snapping would
 * assert the boundaries are physically real. `bandFor()` reads out where you landed instead.
 */
export function beatBandTicks(): number[] {
  const bounds = new Set<number>();
  for (const band of EEG_BANDS) {
    for (const edge of [band.min, band.max]) {
      if (edge > BEAT_RANGE.min && edge < BEAT_RANGE.max) bounds.add(edge);
    }
  }
  return [...bounds].sort((a, b) => a - b);
}

export interface BandTarget {
  band: EegBand;
  /** Where the chip puts the beat: the geometric centre of the reachable part of the band. */
  beatFreq: number;
}

/**
 * Jump targets, one per band the slider can reach.
 *
 * Not snapping — a separate affordance. Getting to 6.5 Hz by dragging a thumb across a phone is
 * fiddly, and this is the cheap version of §6.1's "EEG-band presets" generator.
 *
 * The target is the geometric centre of the band **intersected with the slider's range**, so
 * Gamma — which starts at 30 Hz and runs past the 40 Hz top — lands inside the reachable part
 * rather than pinned against the end.
 */
export function bandTargets(): BandTarget[] {
  return EEG_BANDS.flatMap((band) => {
    const min = Math.max(band.min, BEAT_RANGE.min);
    const max = Math.min(band.max, BEAT_RANGE.max);
    if (min >= max) return [];
    return [{ band, beatFreq: clampTo(BEAT_RANGE, Math.sqrt(min * max)) }];
  });
}
