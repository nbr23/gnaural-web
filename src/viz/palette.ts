/**
 * Categorical slot colours, as CSS custom-property references resolved by `ScheduleChart.css`.
 *
 * Lives outside the chart component so every surface that names a voice — the chart, the
 * player's voice list, a tooltip key — keys it with the *same* colour. Colour follows the
 * entity, never its position in whatever list is currently on screen.
 */

/** Categorical slots available before a voice falls back to the de-emphasis gray. */
export const SLOT_COUNT = 8;

export function seriesColor(slot: number): string {
  return slot < SLOT_COUNT ? `var(--viz-series-${slot + 1})` : 'var(--viz-series-overflow)';
}

/**
 * A colour per EEG band, for the surfaces that name one — the player's band tile and Live's band
 * presets. Fixed slots rather than a gradient: they are five categories, not five points on a
 * scale, and the name is always beside the colour.
 */
const BAND_SLOTS: Record<string, number> = {
  Delta: 6,
  Theta: 0,
  Alpha: 2,
  Beta: 3,
  Gamma: 1,
};

export function bandColor(name: string): string {
  const slot = BAND_SLOTS[name];
  return slot === undefined ? 'var(--viz-series-overflow)' : seriesColor(slot);
}
