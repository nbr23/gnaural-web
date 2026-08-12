/**
 * Pixel geometry for a node drag: what to freeze when a finger lands, and what to redraw while it
 * moves. React-free and DOM-free, the same split `viz/geometry.ts` keeps from `ScheduleChart.tsx`.
 *
 * **The whole point of this module is that a drag is O(1) per move.** The chart's static layer is
 * memoised on its layout, and the layout is built from the *committed* document — so during a
 * gesture it holds still and this supplies the handful of marks that move over the top of it. If a
 * drag instead pushed its in-flight document back into the chart, `buildChartModel`, `layoutChart`
 * and `StaticPlot` would all rebuild on every `pointermove`, which is the defect measured at 1220 ms
 * of scripting per 5 s of playback and fixed once already (see PROGRESS.md).
 *
 * A ripple is the case that looks like it should cost O(entries): every node after the dragged one
 * moves. It does not — they all move by the *same* amount, so the tail is a path string built once
 * when the finger lands and translated thereafter.
 */

import type { MoveMode } from '../document/edit';
import { entryStartTimes } from '../document/timing';
import type { Schedule } from '../document/types';
import type { ChartLayout, LaneId } from '../viz/geometry';
import { polylinePath } from '../viz/geometry';

export interface Point {
  x: number;
  y: number;
}

export interface LaneAnchors {
  laneId: LaneId;
  /** The dragged node's committed position in this lane. */
  node: Point;
  /** The preceding breakpoint, which never moves. Null when the node is entry 0. */
  previous: Point | null;
  /** The following breakpoint. Under a ripple it moves with the node; under a squeeze it does not. */
  next: Point | null;
  /**
   * Everything after `next`, as a path in committed pixel space. Translated horizontally under a
   * ripple and unused under a squeeze, where nothing past `next` moves at all.
   */
  tail: string | null;
}

export interface DragAnchors {
  /** The lane the pointer grabbed in — the only one whose *value* the drag changes. */
  laneId: LaneId;
  voice: number;
  entry: number;
  lanes: LaneAnchors[];
  colour: string;
  /** Committed time and value of the grabbed node, in document units. */
  time: number;
  value: number;
  /** How far the node may travel in time before it would give a neighbour a negative duration. */
  minTime: number;
  maxTime: number;
  minValue: number;
  maxValue: number;
}

/**
 * Freeze everything a drag needs, at the instant the pointer lands.
 *
 * Returns null for a node the document has no time axis for: entry 0's start is the sum of no
 * durations and is zero by definition, so it can still be dragged in value — that case is handled
 * by `minTime === maxTime`, not by refusing the grab.
 */
export function dragAnchors(
  schedule: Schedule,
  layout: ChartLayout,
  laneId: LaneId,
  voice: number,
  entry: number,
  mode: MoveMode,
  colour: string,
): DragAnchors | null {
  const grabbed = layout.lanes.find((lane) => lane.model.id === laneId);
  const source = grabbed?.model.series.find((series) => series.slot === voice);
  if (!grabbed || !source || !source.points[entry]) return null;

  const entries = schedule.voices[voice]?.entries;
  if (!entries || entry >= entries.length) return null;

  const starts = entryStartTimes(schedule.voices[voice]);
  const isLast = entry === entries.length - 1;
  // §3.7 in the small: a node may reach its neighbour and stop, never pass it. The last entry has
  // no following segment to squeeze into, so it ripples whatever the mode says — and its only
  // upper bound is the extent that is drawn.
  const rippling = mode === 'ripple' || isLast;
  const minTime = entry === 0 ? 0 : starts[entry - 1];
  const maxTime = entry === 0 ? 0 : rippling ? layout.model.duration : starts[entry + 1];

  const lanes = layout.lanes.map<LaneAnchors>((lane) => {
    const series = lane.model.series.find((s) => s.slot === voice);
    const points = series?.points ?? [];
    const at = (index: number): Point | null => {
      const point = points[index];
      return point
        ? { x: layout.timeScale.toPixel(point.time), y: lane.valueScale.toPixel(point.value) }
        : null;
    };

    const rest = points.slice(entry + 2);
    return {
      laneId: lane.model.id,
      node: at(entry) ?? { x: 0, y: 0 },
      previous: entry > 0 ? at(entry - 1) : null,
      next: at(entry + 1),
      tail: rest.length > 0 ? polylinePath(rest, layout.timeScale, lane.valueScale) : null,
    };
  });

  const [minValue, maxValue] = grabbed.model.domain;

  return {
    laneId,
    voice,
    entry,
    lanes,
    colour,
    time: source.points[entry].time,
    value: source.points[entry].value,
    minTime,
    maxTime,
    minValue,
    maxValue,
  };
}

export interface LaneOverlay {
  laneId: LaneId;
  node: Point;
  /** From the preceding breakpoint to the node. Null when the node is entry 0. */
  incoming: string | null;
  /** From the node to the following breakpoint, wherever the mode has left it. */
  outgoing: string | null;
  /** Pre-built path for everything past `next`, plus how far to translate it. */
  tail: { d: string; dx: number } | null;
}

/**
 * Where the drag's marks go, given the node's new time and value.
 *
 * Called once per `pointermove` per visible lane and does a fixed amount of work in each — two line
 * segments, a marker, and a translation offset for a path built at pointerdown.
 */
export function dragOverlay(
  anchors: DragAnchors,
  layout: ChartLayout,
  time: number,
  value: number,
  mode: MoveMode,
  isLast: boolean,
): LaneOverlay[] {
  const rippling = mode === 'ripple' || isLast;
  const x = layout.timeScale.toPixel(time);
  const dx = x - anchors.lanes[0]?.node.x;

  return anchors.lanes.map<LaneOverlay>((lane, index) => {
    const layoutLane = layout.lanes[index];
    // Only the grabbed lane's value changes; the others follow the node in time alone.
    const y =
      lane.laneId === anchors.laneId && layoutLane
        ? layoutLane.valueScale.toPixel(value)
        : lane.node.y;
    const node = { x, y };
    const shift = rippling ? dx : 0;
    const next = lane.next ? { x: lane.next.x + shift, y: lane.next.y } : null;

    return {
      laneId: lane.laneId,
      node,
      incoming: lane.previous ? segment(lane.previous, node) : null,
      outgoing: next ? segment(node, next) : null,
      tail: rippling && lane.tail ? { d: lane.tail, dx } : null,
    };
  });
}

function segment(from: Point, to: Point): string {
  return `M${from.x.toFixed(2)} ${from.y.toFixed(2)} L${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
