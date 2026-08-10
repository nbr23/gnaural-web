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
