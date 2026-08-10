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
