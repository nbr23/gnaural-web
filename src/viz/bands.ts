/**
 * EEG frequency bands (PLAN.md §1). These are what a beat frequency *means* to a listener, so
 * the beat lane shades them behind the curve; step 6's live band-name readout reads the same
 * table.
 */

export interface EegBand {
  name: string;
  /** Inclusive lower bound, exclusive upper bound, in Hz. */
  min: number;
  max: number;
}

export const EEG_BANDS: readonly EegBand[] = [
  { name: 'Delta', min: 0.5, max: 4 },
  { name: 'Theta', min: 4, max: 8 },
  { name: 'Alpha', min: 8, max: 13 },
  { name: 'Beta', min: 13, max: 30 },
  { name: 'Gamma', min: 30, max: 100 },
];

/** The band containing `hz`, or undefined below Delta / above Gamma. */
export function bandFor(hz: number): EegBand | undefined {
  return EEG_BANDS.find((band) => hz >= band.min && hz < band.max);
}

/**
 * A band's own centre, geometrically — Delta 1.41 Hz, Theta 5.66, Alpha 10.2, Beta 19.75, Gamma 54.77.
 *
 * Geometric rather than arithmetic because the bands are roughly geometric themselves, which is the
 * same reason Live mode's sliders are logarithmic: the arithmetic middle of Delta (2.25 Hz) sits well
 * above the middle of what a listener hears as delta.
 *
 * **Deliberately not `bandTargets()` in `src/live/sliders.ts`**, which intersects each band with the
 * 0.5–40 Hz slider range so that a thumb can reach it. That is a fact about a slider; this is a fact
 * about a band, and §6.1's band presets are generators rather than slider jumps — so Gamma lands at
 * 54.8 Hz, above the beat ceiling step 7 warns at, and the notice it raises is correct.
 */
export function bandCentre(band: EegBand): number {
  return Math.round(Math.sqrt(band.min * band.max) * 1e4) / 1e4;
}
