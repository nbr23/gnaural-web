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
import type { EntryValueField } from '../document/edit';
import { DURATION_EPSILON, scheduleDuration, voiceDuration } from '../document/timing';
import type { Schedule, Voice } from '../document/types';
import { VoiceType, isTonalType } from '../document/types';
import type { AutomationEvent } from '../engine/compiler';
import { compileVoice, eventBaseFreq, eventBeatFreq } from '../engine/compiler';
import type { Scale } from './scales';
import { linearScale } from './scales';

export type LaneId = 'beat' | 'base' | 'volumeLeft' | 'volumeRight';

/**
 * The stretch of schedule time the chart draws, in seconds — §6.1's "zoom and pan on the time axis".
 *
 * **It belongs to the layout, never to the model.** `buildChartModel` compiles every voice and is
 * memoised on the document; a window that reached it would recompile all of them on every zoom
 * frame. What a window changes is one scale, so it changes in `layoutChart` and everything
 * downstream — `polylinePath`, `timeAtPixel`, `nearestBreakpoint`, the drag geometry, the
 * validation marks — follows for free through `layout.timeScale`.
 */
export interface ViewWindow {
  start: number;
  end: number;
}

/**
 * The narrowest window, in seconds.
 *
 * A floor rather than a judgement about how far anyone should be able to zoom: 22 of the 43 bundled
 * files carry entries 0.001 s apart or closer — Gnaural's own output writes an instantaneous jump as
 * a zero-length segment — and no reachable window separates those; 0.001 s of a 2331 s programme is
 * a millionth of the axis. Zoom is what makes the *ordinary* clusters addressable
 * (median gap 1.16 px at 640 px on `airplanetravelaid`, against a 12 px hit radius); the arrow-walk
 * and the numeric panel are what reach the rest, which is why neither is optional.
 */
export const MIN_VIEW_SECONDS = 0.5;

export function fullView(duration: number): ViewWindow {
  return { start: 0, end: Math.max(duration, MIN_VIEW_SECONDS) };
}

/** A window slid and narrowed until it is a real span inside `[0, duration]`. */
export function clampView(view: ViewWindow, duration: number): ViewWindow {
  const extent = Math.max(duration, MIN_VIEW_SECONDS);
  const span = Math.min(extent, Math.max(MIN_VIEW_SECONDS, view.end - view.start));
  const start = Math.min(Math.max(0, view.start), extent - span);
  return { start, end: start + span };
}

/**
 * Zoom by `factor` about a fixed point in schedule time, so whatever is under the pointer stays
 * under it while the axis grows around it. A button passes the middle of the window as the anchor.
 */
export function zoomView(
  view: ViewWindow,
  duration: number,
  factor: number,
  anchor: number,
): ViewWindow {
  const span = view.end - view.start;
  if (span <= 0 || factor <= 0) return clampView(view, duration);

  const at = Math.min(Math.max(anchor, view.start), view.end);
  const share = (at - view.start) / span;
  const next = span / factor;
  return clampView({ start: at - next * share, end: at + next * (1 - share) }, duration);
}

export function panView(view: ViewWindow, duration: number, seconds: number): ViewWindow {
  return clampView({ start: view.start + seconds, end: view.end + seconds }, duration);
}

/** How much of the schedule is on screen, as a factor: 1 is the whole of it. */
export function zoomFactor(view: ViewWindow, duration: number): number {
  const span = view.end - view.start;
  return span > 0 ? Math.max(duration, MIN_VIEW_SECONDS) / span : 1;
}

export const DEFAULT_LANES: readonly LaneId[] = ['beat', 'base'];

/** Every lane §6.1 asks for, top to bottom, for a caller offering the whole set. */
export const ALL_LANES: readonly LaneId[] = ['beat', 'base', 'volumeLeft', 'volumeRight'];

interface LaneDefinition {
  title: string;
  /** Empty for a dimensionless lane; volume is a bare 0–1 fraction. */
  unit: string;
  /** The `Entry` field a value drag in this lane writes. The inverse of `valueOf`, per voice. */
  field: EntryValueField;
  valueOf(event: AutomationEvent): number;
  domainOf(values: number[], padding: number): [number, number];
  /**
   * Whether a fitted domain looks only at voices whose `basefreq`/`beatfreq` mean a carrier and a
   * rate (`isTonalType`) — see `fittedValues`. Volume means the same thing on every type, so only
   * the two frequency lanes set it.
   */
  tonalFit?: boolean;
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
    tonalFit: true,
    format: formatHz,
  },
  base: {
    title: 'Base frequency',
    unit: 'Hz',
    field: 'baseFreq',
    valueOf: eventBaseFreq,
    domainOf: paddedDomain,
    tonalFit: true,
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
export function laneField(id: LaneId): EntryValueField {
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

/**
 * The values a lane fits its domain to.
 *
 * **The two frequency lanes fit to tonal voices alone**, because on every other type those fields
 * are not frequencies: a water voice's `basefreq` is a per-sample probability of 0.00035 and its
 * `beatfreq` a drop count of up to 100, and a noise voice's are the 100 and 0 all nine in the
 * corpus carry. Fitted together with a carrier at 200 Hz, any of them flattens every tone curve in
 * the lane into a few pixels — reachable with dirty data since step 5, and ordinary once types 5
 * and 6 can be added.
 *
 * A schedule with no tonal voice at all falls back to fitting everything: there is then nothing to
 * protect, and a lane fitted to no values would draw a noise-only or water-only file as an empty
 * 0–1 axis. Values the fit excludes are still reachable — `LaneRanges` is the manual override, and
 * `NodePanel` is the exact one.
 */
function fittedValues(series: VoiceSeries[], definition: LaneDefinition): number[] {
  const flatten = (subset: VoiceSeries[]) => subset.flatMap((s) => s.points.map((p) => p.value));
  if (!definition.tonalFit) return flatten(series);

  const tonal = series.filter((s) => isTonalType(s.type));
  return flatten(tonal.length > 0 ? tonal : series);
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
 * Manual y-axis bounds, per lane — §6.1's "vertical axis auto-scales to content with a manual
 * override". A lane with no entry here is fitted to its data as it always was.
 *
 * The override is what makes a value reachable by dragging at all when it is far outside the
 * document's own range: a lane fitted to a 200–210 Hz curve, even at `EDITOR_DOMAIN_PADDING`,
 * cannot be dragged to 400 Hz. Session state, like the view window and the open lanes.
 */
export type LaneDomains = Partial<Record<LaneId, readonly [number, number]>>;

/**
 * The extent a chart of this schedule draws: its longest *visible* voice.
 *
 * `buildChartModel` reports the same number on the model it returns, and calls this to get it — one
 * rule, so a caller that needs the extent without building a model (the editor's zoom controls) and
 * the model itself cannot come to disagree about how long the picture is. Hidden voices are omitted
 * for the reason the model omits them: `voice_hide` is editor presentation state.
 */
export function drawnDuration(schedule: Schedule): number {
  const drawn = schedule.voices
    .filter((voice) => !voice.hidden && voice.entries.length > 0)
    .map(voiceDuration);
  return drawn.length > 0 ? Math.max(...drawn) : 0;
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
  domains: LaneDomains = {},
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

  const duration = drawnDuration(schedule);
  const playbackDuration = scheduleDuration(schedule);

  const lanes = laneIds.map<LaneModel>((id) => {
    const definition = LANE_DEFINITIONS[id];
    const series = compiled.map<VoiceSeries>(({ identity, events }) => ({
      ...identity,
      points: events.map((event) => ({ time: event.time, value: definition.valueOf(event) })),
    }));

    const override = domains[id];
    return {
      id,
      title: definition.title,
      unit: definition.unit,
      domain: override
        ? [override[0], override[1]]
        : definition.domainOf(fittedValues(series, definition), domainPadding),
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
  /** The stretch of time this layout draws. The whole schedule unless the caller zoomed. */
  view: ViewWindow;
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
  window?: ViewWindow,
): ChartLayout {
  const view = clampView(window ?? fullView(model.duration), model.duration);
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
    timeScale: linearScale([view.start, view.end], [plotLeft, plotLeft + plotWidth]),
    view,
    lanes,
  };
}

/**
 * Which points a windowed lane actually has to draw: everything inside, plus one either side.
 *
 * The neighbours are not an optimisation detail, they are what makes the line *enter* the window
 * from off-screen instead of starting at the first visible node. Returned as slice bounds so a
 * caller can keep each point's own index, which is what addresses an entry.
 *
 * This is where zoom stops being expensive. A full rebuild of the densest bundled document costs
 * 10.7 ms of React and DOM at four lanes against 0.14 ms of geometry, so the saving that matters is
 * *elements not created*: at 4× zoom only 6 of that document's 80 points are inside the window.
 */
export function visibleRange(points: readonly SeriesPoint[], view: ViewWindow): [number, number] {
  if (points.length === 0) return [0, 0];

  let from = 0;
  while (from + 1 < points.length && points[from + 1].time <= view.start) from++;

  let to = points.length;
  while (to - 1 > from + 1 && points[to - 2].time >= view.end) to--;

  return [from, to];
}

/** A rectangle in the layout's own pixel space. Corners in any order. */
export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Every authored node inside a rectangle — §6.1's marquee.
 *
 * **The union across lanes, not one lane's answer.** A node is one entry that appears once per
 * lane, so a rectangle dragged across the beat lane and into the base lane means the nodes it
 * covers in either. It spans voices for the reason step 6 gave for insert: empty space cannot name
 * a voice, so a marquee restricted to one would need an "active voice" this editor does not have.
 *
 * §3.5's terminal wrap point is excluded, the same rule `nearestBreakpoint`'s `entriesOnly` uses:
 * it is derived rather than authored, so it is not a thing a selection can contain.
 */
export function nodesInRect(layout: ChartLayout, rect: PixelRect): { voice: number; entry: number }[] {
  const left = Math.min(rect.x0, rect.x1);
  const right = Math.max(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const bottom = Math.max(rect.y0, rect.y1);

  const found = new Map<string, { voice: number; entry: number }>();

  for (const lane of layout.lanes) {
    for (const series of lane.model.series) {
      for (let index = 0; index < series.points.length; index++) {
        if (isTerminalPoint(series, index)) continue;

        const point = series.points[index];
        const x = layout.timeScale.toPixel(point.time);
        if (x < left || x > right) continue;

        const y = lane.valueScale.toPixel(point.value);
        if (y < top || y > bottom) continue;

        found.set(`${series.slot}:${index}`, { voice: series.slot, entry: index });
      }
    }
  }

  return [...found.values()].sort((a, b) => a.voice - b.voice || a.entry - b.entry);
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
