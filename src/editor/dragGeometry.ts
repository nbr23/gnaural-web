// Pixel geometry for a node drag: what to freeze when a finger lands, and what to redraw while it
// moves. React-free and DOM-free, the same split viz/geometry.ts keeps from ScheduleChart.tsx.
//
// A drag is O(1) per move: the chart's static layer stays memoised on the committed document
// throughout the gesture, and this module supplies the handful of marks drawn over it instead of
// pushing the in-flight document back through the chart (previously measured at 1220ms of
// scripting per 5s of playback). A ripple moves every node after the dragged one by the same
// amount, so its tail is one path string built at pointerdown and translated, not rebuilt per node.
// A group drag applies the same trick per affected voice: one block per voice, translated by
// (dx, dy) in the grabbed lane and (dx, 0) elsewhere, so a 70-node selection costs what a 1-node
// selection costs.

import type { MoveMode } from '../document/edit';
import type { EntryLocation, Schedule } from '../document/types';
import type { ChartLayout, LaneId } from '../viz/geometry';
import { polylinePath } from '../viz/geometry';

export interface Point {
  x: number;
  y: number;
}

export interface LaneAnchors {
  laneId: LaneId;
  // The dragged node's committed position in this lane.
  node: Point;
  // The preceding breakpoint, which never moves. Null when the block starts at entry 0.
  previous: Point | null;
  // The block itself, as a path in committed pixel space — null for a block of one node.
  block: string | null;
  blockEnd: Point;
  // The breakpoint after the block. Moves with it under a ripple; stays put under a squeeze.
  next: Point | null;
  // Everything after `next`, as a path in committed pixel space. Only translated under a ripple.
  tail: string | null;
}

export interface VoiceBlock {
  voice: number;
  first: number;
  last: number;
  // Fixed when the pointer lands: a block ending on the voice's last entry has no following
  // segment to squeeze into, so it ripples regardless of the control.
  rippling: boolean;
  lanes: LaneAnchors[];
  colour: string;
}

export interface DragAnchors {
  laneId: LaneId;
  voice: number;
  entry: number;
  blocks: VoiceBlock[];
  colour: string;
  time: number;
  value: number;
  // How far the grabbed node may travel before some voice's neighbour would go negative.
  minTime: number;
  maxTime: number;
  // Bounds on the grabbed node's value that keep every selected node inside the lane.
  minValue: number;
  maxValue: number;
}

export interface DragAnchorArgs {
  schedule: Schedule;
  layout: ChartLayout;
  laneId: LaneId;
  voice: number;
  entry: number;
  selection: readonly EntryLocation[];
  mode: MoveMode;
  colourOf(voice: number): string;
}

// Freezes everything a drag needs at the instant the pointer lands. Returns null only for a grab
// the document can't place — entry 0 can still be dragged in value, via minTime === maxTime, since
// its start is fixed at zero rather than refused.
export function dragAnchors(args: DragAnchorArgs): DragAnchors | null {
  const { schedule, layout, laneId, voice, entry, mode } = args;
  const grabbed = layout.lanes.find((lane) => lane.model.id === laneId);
  const source = grabbed?.model.series.find((series) => series.slot === voice);
  if (!grabbed || !source || !source.points[entry]) return null;

  const entries = schedule.voices[voice]?.entries;
  if (!entries || entry >= entries.length) return null;

  // One resolved node list, so the blocks and the value bounds cannot disagree about what is being
  // dragged: grabbing a node outside the current selection drags that node alone.
  const nodes = args.selection.some((node) => node.voice === voice && node.entry === entry)
    ? args.selection
    : [{ voice, entry }];
  const runs = blockRuns(schedule, nodes);

  let minDelta = -Infinity;
  let maxDelta = Infinity;
  const blocks: VoiceBlock[] = [];

  for (const run of runs) {
    const voiceEntries = schedule.voices[run.voice].entries;
    // §3.7 in the small: a block may reach its neighbour and stop, never pass it.
    const rippling = mode === 'ripple' || run.last === voiceEntries.length - 1;

    if (run.first > 0) {
      minDelta = Math.max(minDelta, -voiceEntries[run.first - 1].duration);
      if (!rippling) maxDelta = Math.min(maxDelta, voiceEntries[run.last].duration);
    } else {
      // Entry 0 cannot move in time at all, so a block pinned to it fixes the whole gesture.
      minDelta = 0;
      maxDelta = 0;
    }

    const lanes = layout.lanes.map<LaneAnchors>((lane) => {
      const series = lane.model.series.find((s) => s.slot === run.voice);
      const points = series?.points ?? [];
      const at = (index: number): Point | null => {
        const point = points[index];
        return point
          ? { x: layout.timeScale.toPixel(point.time), y: lane.valueScale.toPixel(point.value) }
          : null;
      };

      const inside = points.slice(run.first, run.last + 1);
      const rest = points.slice(run.last + 2);
      return {
        laneId: lane.model.id,
        node: at(run.first) ?? { x: 0, y: 0 },
        previous: run.first > 0 ? at(run.first - 1) : null,
        block: inside.length > 1 ? polylinePath(inside, layout.timeScale, lane.valueScale) : null,
        blockEnd: at(run.last) ?? { x: 0, y: 0 },
        next: at(run.last + 1),
        tail: rest.length > 0 ? polylinePath(rest, layout.timeScale, lane.valueScale) : null,
      };
    });

    blocks.push({ ...run, rippling, lanes, colour: args.colourOf(run.voice) });
  }

  const time = source.points[entry].time;
  const value = source.points[entry].value;
  const [laneMin, laneMax] = grabbed.model.domain;
  const values = selectedValues(layout, laneId, nodes);

  return {
    laneId,
    voice,
    entry,
    blocks,
    colour: args.colourOf(voice),
    time,
    value,
    minTime: time + (Number.isFinite(minDelta) ? minDelta : 0),
    maxTime: Number.isFinite(maxDelta) ? time + maxDelta : layout.view.end,
    // Every selected node has to stay inside the lane, so the grabbed one stops as soon as the
    // highest or lowest of them reaches an edge. For one node this is exactly the lane's domain.
    minValue: laneMin + (value - values.min),
    maxValue: laneMax - (values.max - value),
  };
}

/** The run of entries each affected voice contributes, matching `moveEntries`'s own block rule. */
function blockRuns(
  schedule: Schedule,
  nodes: readonly EntryLocation[],
): { voice: number; first: number; last: number }[] {
  const byVoice = new Map<number, { first: number; last: number }>();
  for (const node of nodes) {
    const entries = schedule.voices[node.voice]?.entries;
    if (!entries || node.entry < 0 || node.entry >= entries.length) continue;

    const run = byVoice.get(node.voice);
    if (!run) byVoice.set(node.voice, { first: node.entry, last: node.entry });
    else {
      run.first = Math.min(run.first, node.entry);
      run.last = Math.max(run.last, node.entry);
    }
  }

  return [...byVoice.entries()].map(([at, run]) => ({ voice: at, ...run }));
}

/** The extremes of the selection's values in the grabbed lane, which bound a group's value drag. */
function selectedValues(
  layout: ChartLayout,
  laneId: LaneId,
  selection: readonly EntryLocation[],
): { min: number; max: number } {
  const lane = layout.lanes.find((l) => l.model.id === laneId);
  let min = Infinity;
  let max = -Infinity;

  for (const node of selection) {
    const point = lane?.model.series.find((s) => s.slot === node.voice)?.points[node.entry];
    if (!point) continue;
    min = Math.min(min, point.value);
    max = Math.max(max, point.value);
  }

  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
}

export interface LaneOverlay {
  laneId: LaneId;
  voice: number;
  node: Point;
  // From the preceding breakpoint to the block's first node. Null when the block starts the voice.
  incoming: string | null;
  outgoing: string | null;
  // The block itself, and how far to translate it. Null for a block of one node.
  block: { d: string; dx: number; dy: number } | null;
  // Pre-built path for everything past `next`, plus how far to translate it.
  tail: { d: string; dx: number } | null;
}

// Called once per pointermove per lane per affected voice, doing fixed work per call — nothing
// here is proportional to the number of nodes being dragged.
export function dragOverlay(
  anchors: DragAnchors,
  layout: ChartLayout,
  time: number,
  value: number,
): LaneOverlay[] {
  const dx = layout.timeScale.toPixel(time) - layout.timeScale.toPixel(anchors.time);
  const grabbedLane = layout.lanes.find((lane) => lane.model.id === anchors.laneId);
  const dy = grabbedLane
    ? grabbedLane.valueScale.toPixel(value) - grabbedLane.valueScale.toPixel(anchors.value)
    : 0;

  return anchors.blocks.flatMap((block) =>
    block.lanes.map<LaneOverlay>((lane) => {
      // Only the grabbed lane's value changes; every other lane follows the node in time alone.
      const shift = lane.laneId === anchors.laneId ? dy : 0;
      const node = { x: lane.node.x + dx, y: lane.node.y + shift };
      const blockEnd = { x: lane.blockEnd.x + dx, y: lane.blockEnd.y + shift };
      const tailShift = block.rippling ? dx : 0;
      const next = lane.next ? { x: lane.next.x + tailShift, y: lane.next.y } : null;

      return {
        laneId: lane.laneId,
        voice: block.voice,
        node,
        incoming: lane.previous ? segment(lane.previous, node) : null,
        outgoing: next ? segment(blockEnd, next) : null,
        block: lane.block ? { d: lane.block, dx, dy: shift } : null,
        tail: block.rippling && lane.tail ? { d: lane.tail, dx } : null,
      };
    }),
  );
}

function segment(from: Point, to: Point): string {
  return `M${from.x.toFixed(2)} ${from.y.toFixed(2)} L${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
