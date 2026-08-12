/**
 * Pure chart geometry: schedule -> lane models -> pixel layout -> hit-testing.
 *
 * Deliberately renderer-agnostic (PLAN.md §6.2). Nothing here imports React, touches the DOM, or
 * knows what SVG is; the one SVG-shaped function, `polylinePath`, is a thin formatter over point
 * arrays that are themselves the primary output, so a Canvas renderer could consume the same
 * model. Phase 1's editor hit-tests through `timeAtPixel` / `nearestBreakpoint` rather than
 * through DOM events on individual marks.
 */

import { formatHz } from '../app/format';
import type { EntryPatch } from '../document/edit';
import { DURATION_EPSILON, scheduleDuration, voiceDuration } from '../document/timing';
import type { Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import type { AutomationEvent } from '../engine/compiler';
import { compileVoice, eventBaseFreq, eventBeatFreq } from '../engine/compiler';
import type { Scale } from './scales';
import { linearScale } from './scales';

export type LaneId = 'beat' | 'base' | 'volumeLeft' | 'volumeRight';

export const DEFAULT_LANES: readonly LaneId[] = ['beat', 'base'];

/** Every lane §6.1 asks for, top to bottom, for a caller offering the whole set. */
export const ALL_LANES: readonly LaneId[] = ['beat', 'base', 'volumeLeft', 'volumeRight'];

interface LaneDefinition {
  title: string;
  /** Empty for a dimensionless lane; volume is a bare 0–1 fraction. */
  unit: string;
  /** The `Entry` field a value drag in this lane writes. The inverse of `valueOf`, per voice. */
  field: keyof EntryPatch;
  valueOf(event: AutomationEvent): number;
  domainOf(values: number[], padding: number): [number, number];
  format(value: number): string;
}

/** Headroom above and below a fitted lane's data, as a fraction of its value range. */
export const DOMAIN_PADDING = 0.1;

/**
 * Headroom for a lane that is being dragged in.
 *
 * A drag can only reach what is on screen, so 10% around the data would let a beat curve spanning
 * 4–12 Hz be dragged no further than 3.2–12.8 Hz. Wider is more useful and still bounded; anything
 * outside it is what §6.1 asks for a numeric panel for ("dragging is imprecise and people want
 * exact values"), and a manual axis override is step 8's.
 */
export const EDITOR_DOMAIN_PADDING = 0.35;

const LANE_DEFINITIONS: Record<LaneId, LaneDefinition> = {
  beat: {
    title: 'Beat frequency',
    unit: 'Hz',
    field: 'beatFreq',
    valueOf: eventBeatFreq,
    domainOf: paddedDomain,
    format: formatHz,
  },
  base: {
    title: 'Base frequency',
    unit: 'Hz',
    field: 'baseFreq',
    valueOf: eventBaseFreq,
    domainOf: paddedDomain,
    format: formatHz,
  },
  volumeLeft: {
    title: 'Volume left',
    unit: '',
    field: 'volumeLeft',
    valueOf: (event) => event.leftGain,
    domainOf: volumeDomain,
    format: formatVolume,
  },
  volumeRight: {
    title: 'Volume right',
    unit: '',
    field: 'volumeRight',
    valueOf: (event) => event.rightGain,
    domainOf: volumeDomain,
    format: formatVolume,
  },
};

/** Which `Entry` field a value drag in this lane writes. */
export function laneField(id: LaneId): keyof EntryPatch {
  return LANE_DEFINITIONS[id].field;
}

export interface VoiceIdentity {
  voiceId: number;
  /**
   * Categorical palette slot. Derived from the voice's position in `schedule.voices`, never from
   * its rank or its index among *visible* voices — hiding a voice must not repaint the others.
   */
  slot: number;
  label: string;
  type: VoiceType;
  /** This voice's own total length. Voices are not padded to a common length (§3.7). */
  duration: number;
}

export interface SeriesPoint {
  time: number;
  value: number;
}

/**
 * A node the caller wants drawn attention to — §6.1's inline validation, marked where it happened.
 *
 * Addressed like everything else here, by index into `schedule.voices` and into that voice's
 * entries. `lanes: null` means it belongs to no particular lane; a list means those lanes, and a
 * lane that is closed is not a place a mark can hide (see `IssueMarks`).
 */
export interface ChartMark {
  voice: number;
  entry: number;
  lanes: readonly LaneId[] | null;
  /** Shown on hover and to a screen reader. Usually the warning's own sentence. */
  label: string;
}

export interface VoiceSeries extends VoiceIdentity {
  points: SeriesPoint[];
}

export interface LaneModel {
  id: LaneId;
  title: string;
  unit: string;
  domain: [number, number];
  /** Tick and readout formatting — Hz reads differently from a 0–1 fraction. */
  format(value: number): string;
  series: VoiceSeries[];
}

export interface ChartModel {
  /** Length of the longest drawn voice — the extent, so no plotted curve is cropped. */
  duration: number;
  /**
   * Where playback actually ends: the shortest voice in the *whole schedule*, hidden and
   * unrenderable voices included, since any of them can end it (§3.7).
   */
  playbackDuration: number;
  /** True when voices differ in length by more than a rounding error, so the §3.7 case is live. */
  truncated: boolean;
  voices: VoiceIdentity[];
  lanes: LaneModel[];
}

function voiceLabel(voice: Voice): string {
  return voice.description.trim() || `Voice ${voice.id}`;
}

function paddedDomain(values: number[], padding: number): [number, number] {
  if (values.length === 0) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * padding;
  // Frequencies are never negative; don't spend lane height below the axis floor.
  return [Math.max(0, min - pad), max + pad];
}

/**
 * Volume is bounded and its endpoints mean something, so the lane is **not** fitted to its data:
 * a program running 0.50–0.52 would otherwise read as a dramatic swing, and two voices at quite
 * different levels would draw identically.
 *
 * Values above 1 are not clamped. §3.4 says real files are dirty, and an out-of-range volume has to
 * be visibly out of range for step 7's validation to have anything to point at.
 */
function volumeDomain(values: number[]): [number, number] {
  const max = values.length > 0 ? Math.max(...values) : 1;
  return [0, max > 1 ? max * 1.05 : 1];
}

function formatVolume(value: number): string {
  return value.toFixed(2);
}

/**
 * Build the plottable model for a schedule.
 *
 * Curves come from `compileVoice`, not from the raw entries: it supplies absolute times and the
 * unconditional wrap back to entry[0] over the final segment (§3.5), so the picture matches what
 * is actually heard rather than stopping short at the last authored breakpoint.
 *
 * Voices with `hidden` set are omitted — the format defines `voice_hide` as editor presentation
 * state. Non-binaural voices are kept: their entries carry real base/beat values that Phase 1
 * must be able to edit, and the legend labels their type so a reader knows the curve is not
 * audible as a tone.
 */
export function buildChartModel(
  schedule: Schedule,
  laneIds: readonly LaneId[] = DEFAULT_LANES,
  domainPadding = DOMAIN_PADDING,
): ChartModel {
  const compiled: { identity: VoiceIdentity; events: AutomationEvent[] }[] = [];

  schedule.voices.forEach((voice, index) => {
    if (voice.hidden) return;
    const events = compileVoice(voice);
    if (events.length === 0) return;

    compiled.push({
      identity: {
        voiceId: voice.id,
        slot: index,
        label: voiceLabel(voice),
        type: voice.type,
        duration: voiceDuration(voice),
      },
      events,
    });
  });

  const drawn = compiled.map(({ identity }) => identity.duration);
  const duration = drawn.length > 0 ? Math.max(...drawn) : 0;
  const playbackDuration = scheduleDuration(schedule);

  const lanes = laneIds.map<LaneModel>((id) => {
    const definition = LANE_DEFINITIONS[id];
    const series = compiled.map<VoiceSeries>(({ identity, events }) => ({
      ...identity,
      points: events.map((event) => ({ time: event.time, value: definition.valueOf(event) })),
    }));

    return {
      id,
      title: definition.title,
      unit: definition.unit,
      domain: definition.domainOf(series.flatMap((s) => s.points.map((p) => p.value)), domainPadding),
      format: definition.format,
      series,
    };
  });

  return {
    duration,
    playbackDuration,
    truncated: duration - playbackDuration > DURATION_EPSILON,
    voices: compiled.map(({ identity }) => identity),
    lanes,
  };
}

/** Interpolated value of a series at `time`, or null once the voice has ended (§3.7). */
export function seriesValueAt(series: VoiceSeries, time: number): number | null {
  const { points } = series;
  if (points.length === 0) return null;
  if (time < points[0].time || time > points[points.length - 1].time) return null;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (time <= b.time) {
      const factor = b.time === a.time ? 1 : (time - a.time) / (b.time - a.time);
      return a.value + (b.value - a.value) * factor;
    }
  }
  return points[points.length - 1].value;
}

export interface LaneLayout {
  model: LaneModel;
  /** Plot rect, excluding the lane's title row. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Value -> pixel, inverted so larger values sit higher. */
  valueScale: Scale;
}

export interface ChartLayout {
  model: ChartModel;
  width: number;
  height: number;
  /** Shared across every lane — one time axis, drawn once under the last lane. */
  timeScale: Scale;
  lanes: LaneLayout[];
}

export interface LayoutMetrics {
  paddingTop: number;
  paddingRight: number;
  paddingLeft: number;
  /** Height reserved below the last lane for the time axis, so its labels are never clipped. */
  axisBand: number;
  /** Height reserved above each lane's plot rect for its title. */
  laneHeader: number;
  laneGap: number;
}

export const DEFAULT_METRICS: LayoutMetrics = {
  paddingTop: 4,
  // Enough that a centred `h:mm:ss` label on the final time tick doesn't overhang the edge.
  paddingRight: 26,
  paddingLeft: 48,
  axisBand: 26,
  laneHeader: 20,
  laneGap: 12,
};

export function layoutChart(
  model: ChartModel,
  width: number,
  height: number,
  metrics: LayoutMetrics = DEFAULT_METRICS,
): ChartLayout {
  const plotLeft = metrics.paddingLeft;
  const plotWidth = Math.max(1, width - metrics.paddingLeft - metrics.paddingRight);
  const laneCount = Math.max(1, model.lanes.length);
  const available = Math.max(
    laneCount,
    height - metrics.paddingTop - metrics.axisBand - metrics.laneGap * (laneCount - 1),
  );
  const blockHeight = available / laneCount;
  const plotHeight = Math.max(1, blockHeight - metrics.laneHeader);

  const lanes = model.lanes.map<LaneLayout>((lane, index) => {
    const top = metrics.paddingTop + index * (blockHeight + metrics.laneGap) + metrics.laneHeader;
    return {
      model: lane,
      x: plotLeft,
      y: top,
      width: plotWidth,
      height: plotHeight,
      valueScale: linearScale(lane.domain, [top + plotHeight, top]),
    };
  });

  return {
    model,
    width,
    height,
    timeScale: linearScale([0, model.duration], [plotLeft, plotLeft + plotWidth]),
    lanes,
  };
}

/** SVG path data for a series. The only renderer-specific function in this module. */
export function polylinePath(points: readonly SeriesPoint[], timeScale: Scale, valueScale: Scale): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${timeScale.toPixel(p.time).toFixed(2)} ${valueScale.toPixel(p.value).toFixed(2)}`)
    .join(' ');
}

/** Schedule time under a pixel x, clamped to the drawn extent. */
export function timeAtPixel(layout: ChartLayout, pixelX: number): number {
  return Math.min(layout.model.duration, Math.max(0, layout.timeScale.toValue(pixelX)));
}

export interface BreakpointHit {
  series: VoiceSeries;
  point: SeriesPoint;
  /** Index into `series.points`. */
  index: number;
  /** Index into `schedule.voices` — the same keying `NodeRef` and the engine's mute gates use. */
  voice: number;
  /**
   * Index into that voice's entries, or **null at the terminal point**.
   *
   * `compileVoice` emits one event per entry plus §3.5's unconditional wrap back to entry[0], so
   * every point but the last addresses an entry and the last one addresses nothing: its value is
   * entry[0]'s and its time is the sum of the durations. It is derived, not authored.
   */
  entry: number | null;
  distance: number;
}

/** Whether a point in a compiled series is §3.5's derived wrap rather than an authored entry. */
export function isTerminalPoint(series: VoiceSeries, index: number): boolean {
  return index === series.points.length - 1;
}

/**
 * Closest authored breakpoint to a pixel position within `maxDistance`, across every series in
 * the lane. Read-only mode uses this to surface where a voice's entries actually sit; the editor
 * uses the same call to decide what a drag grabs.
 *
 * `entriesOnly` excludes the terminal point, which the editor does because that point is not
 * editable: a pointer there is then an ordinary miss rather than a tap that visibly does nothing.
 */
export function nearestBreakpoint(
  lane: LaneLayout,
  timeScale: Scale,
  pixelX: number,
  pixelY: number,
  maxDistance: number,
  entriesOnly = false,
): BreakpointHit | null {
  let best: BreakpointHit | null = null;

  for (const series of lane.model.series) {
    for (let index = 0; index < series.points.length; index++) {
      const terminal = isTerminalPoint(series, index);
      if (terminal && entriesOnly) continue;

      const point = series.points[index];
      const dx = timeScale.toPixel(point.time) - pixelX;
      const dy = lane.valueScale.toPixel(point.value) - pixelY;
      const distance = Math.hypot(dx, dy);
      if (distance <= maxDistance && (best === null || distance < best.distance)) {
        best = { series, point, index, voice: series.slot, entry: terminal ? null : index, distance };
      }
    }
  }

  return best;
}
