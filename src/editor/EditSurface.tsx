import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { formatClock } from '../app/format';
import { useThrottled } from '../app/useThrottled';
import type { MoveMode } from '../document/edit';
import { adjustEntries, moveEntries, removeEntries } from '../document/edit';
import type { Schedule } from '../document/types';
import type { ChartInteraction, ChartPointer } from '../viz/ScheduleChart';
import { ScheduleChart } from '../viz/ScheduleChart';
import type { ChartLayout, ChartMark, LaneDomains, LaneId, PixelRect, ViewWindow } from '../viz/geometry';
import {
  EDITOR_DOMAIN_PADDING,
  clampView,
  drawnDuration,
  fullView,
  laneField,
  nodesInRect,
  panView,
  zoomFactor,
  zoomView,
} from '../viz/geometry';
import { seriesColor } from '../viz/palette';
import { snapToStep, timeGridStep } from '../viz/scales';
import type { DragAnchors } from './dragGeometry';
import { clamp, dragAnchors, dragOverlay } from './dragGeometry';
import type { NodeRef, Selection } from './history';

export interface EditSurfaceProps {
  /** The committed document — never an in-flight one; see `ChartInteraction`. */
  schedule: Schedule;
  lanes: readonly LaneId[];
  height: number;
  currentTime?: number;
  selected: Selection;
  mode: MoveMode;
  snap: boolean;
  domains?: LaneDomains;
  marks?: readonly ChartMark[];
  onSelect(selection: Selection): void;
  onCommit(schedule: Schedule, label: string): void;
  onCommitAt(schedule: Schedule, label: string, selection: Selection): void;
  onPreview(schedule: Schedule): void;
}

interface Drag {
  pointerId: number;
  anchors: DragAnchors;
  layout: ChartLayout;
  grabX: number;
  grabY: number;
  time: number;
  value: number;
  // Fixed at pointerdown from the mode and Alt state, so a modifier released mid-drag can't change
  // what the gesture meant.
  mode: MoveMode;
  gridStep: number;
  nodes: Selection;
  moved: boolean;
}

interface Marquee {
  pointerId: number;
  origin: { x: number; y: number };
  rect: PixelRect;
  additive: boolean;
  moved: boolean;
}

const MARQUEE_THRESHOLD_PX = 4;
const ZOOM_STEP = 2;

// This is the only component that re-renders while a finger is down: the drag's in-flight state
// lives here rather than in EditorView so everything above it (readout, timeline, node panel)
// doesn't re-render at pointer rate. The view window lives here too, and is rate-limited harder —
// a zoom changes the layout memo every child is keyed on, measured at 10.7ms/frame for the
// densest bundled document vs 0.34ms for a playhead-only frame — so continuous zoom/pan gestures
// share the engine's 100ms throttle; only the zoom buttons apply immediately.
export function EditSurface({
  schedule,
  lanes,
  height,
  currentTime,
  selected,
  mode,
  snap,
  domains,
  marks,
  onSelect,
  onCommit,
  onCommitAt,
  onPreview,
}: EditSurfaceProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  // Mirrored in refs so a move can read the gesture, push it at the engine and store it without
  // doing any of that inside a state updater, which React is free to run more than once.
  const dragRef = useRef<Drag | null>(null);
  const marqueeRef = useRef<Marquee | null>(null);
  const setGesture = useCallback((next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);
  const setBox = useCallback((next: Marquee | null) => {
    marqueeRef.current = next;
    setMarquee(next);
  }, []);

  const duration = useMemo(() => drawnDuration(schedule), [schedule]);
  // Null view means "the whole thing", so a document that grows or shrinks under an untouched view
  // keeps showing all of itself. Must stay memoized: this feeds the chart's layout memo, and a
  // fresh object per render rebuilt the whole picture on every pointermove (4.0ms/move vs 0.6ms).
  const [view, setView] = useState<ViewWindow | null>(null);
  const window = useMemo(
    () => (view ? clampView(view, duration) : fullView(duration)),
    [duration, view],
  );
  const factor = zoomFactor(window, duration);

  const viewRef = useRef(window);
  viewRef.current = window;
  const pushView = useThrottled((next: ViewWindow) => setView(next));

  const zoom = useCallback(
    (by: number, anchor: number, immediate = false) => {
      const next = zoomView(viewRef.current, duration, by, anchor);
      viewRef.current = next;
      if (immediate) setView(next);
      else pushView(next);
    },
    [duration, pushView],
  );

  const pan = useCallback(
    (seconds: number, immediate = false) => {
      const next = panView(viewRef.current, duration, seconds);
      viewRef.current = next;
      if (immediate) setView(next);
      else pushView(next);
    },
    [duration, pushView],
  );

  // Read through a ref so the throttle's trailing edge cannot fire against a stale document, and so
  // that pushing to the engine never needs the drag in React state.
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  const documentFor = useCallback((current: Drag): Schedule => {
    const { anchors } = current;
    const moved = moveEntries(scheduleRef.current, {
      nodes: current.nodes,
      deltaTime: current.time - anchors.time,
      mode: current.mode,
    });
    // No clamp here: anchors.minValue/maxValue already bound the grabbed node to keep every
    // selected node inside the lane, applied before this ran.
    return adjustEntries(moved, {
      nodes: current.nodes,
      field: laneField(anchors.laneId),
      delta: current.value - anchors.value,
    });
  }, []);

  // Built inside the throttled action rather than on every move: at 60 Hz a preview document is
  // ~1 kB of garbage per frame for a value nothing reads until the next push.
  const push = useThrottled((current: Drag) => onPreview(documentFor(current)));

  const begin = useCallback(
    (pointer: ChartPointer) => {
      const { hit, lane, layout } = pointer;
      if (!hit || !lane || hit.entry === null) {
        // A pointer on empty space is not yet a decision: it arms a marquee, and clears the
        // selection on pointerup only if it never moved.
        setBox({
          pointerId: pointer.event.pointerId,
          origin: { x: pointer.x, y: pointer.y },
          rect: { x0: pointer.x, y0: pointer.y, x1: pointer.x, y1: pointer.y },
          additive: pointer.event.shiftKey,
          moved: false,
        });
        return;
      }

      // Alt inverts the mode for this gesture only, and Shift inverts snapping. A phone has neither,
      // which is why both standing choices are controls in the editor rather than chords.
      const gestureMode: MoveMode =
        pointer.event.altKey ? (mode === 'squeeze' ? 'ripple' : 'squeeze') : mode;
      const snapping = pointer.event.shiftKey ? !snap : snap;
      const grabbed = { voice: hit.voice, entry: hit.entry };
      const inSelection = selected.some(
        (node) => node.voice === grabbed.voice && node.entry === grabbed.entry,
      );
      const nodes: Selection = inSelection ? selected : [grabbed];

      const anchors = dragAnchors({
        schedule,
        layout,
        laneId: lane.model.id,
        voice: hit.voice,
        entry: hit.entry,
        selection: nodes,
        mode: gestureMode,
        colourOf: (voice) => seriesColor(voice),
      });
      if (!anchors) return;

      // Grabbing a node outside the selection replaces it; grabbing one inside keeps the group, so
      // a group drag does not have to begin by re-selecting what is already selected.
      if (!inSelection) onSelect(nodes);

      const grabbedLane = anchors.blocks
        .find((block) => block.voice === hit.voice)
        ?.lanes.find((l) => l.laneId === lane.model.id);
      const plot = layout.lanes[0]?.width ?? 1;

      setGesture({
        pointerId: pointer.event.pointerId,
        anchors,
        layout,
        grabX: pointer.x - (grabbedLane?.node.x ?? pointer.x),
        grabY: pointer.y - (grabbedLane?.node.y ?? pointer.y),
        time: anchors.time,
        value: anchors.value,
        mode: gestureMode,
        gridStep: snapping ? timeGridStep(layout.view.end - layout.view.start, plot) : 0,
        nodes,
        moved: false,
      });
    },
    [mode, onSelect, schedule, selected, setBox, setGesture, snap],
  );

  const move = useCallback(
    (pointer: ChartPointer) => {
      const box = marqueeRef.current;
      if (box && pointer.event.pointerId === box.pointerId) {
        const moved =
          box.moved ||
          Math.abs(pointer.x - box.origin.x) > MARQUEE_THRESHOLD_PX ||
          Math.abs(pointer.y - box.origin.y) > MARQUEE_THRESHOLD_PX;
        setBox({
          ...box,
          rect: { x0: box.origin.x, y0: box.origin.y, x1: pointer.x, y1: pointer.y },
          moved,
        });
        return;
      }

      const current = dragRef.current;
      if (!current || pointer.event.pointerId !== current.pointerId) return;

      const { anchors, layout } = current;
      const grabbed = layout.lanes.find((l) => l.model.id === anchors.laneId);
      if (!grabbed) return;

      const wanted = layout.timeScale.toValue(pointer.x - current.grabX);
      const next: Drag = {
        ...current,
        time: clamp(
          current.gridStep > 0 ? snapToStep(wanted, current.gridStep) : wanted,
          anchors.minTime,
          anchors.maxTime,
        ),
        value: clamp(
          grabbed.valueScale.toValue(pointer.y - current.grabY),
          anchors.minValue,
          anchors.maxValue,
        ),
        moved: true,
      };
      push(next);
      setGesture(next);
    },
    [push, setBox, setGesture],
  );

  const end = useCallback(
    (pointer: ChartPointer) => {
      const box = marqueeRef.current;
      if (box && pointer.event.pointerId === box.pointerId) {
        setBox(null);
        if (!box.moved) {
          // A tap on empty space means "nothing", and nothing else — the playhead belongs to the
          // timeline, not to a plot a finger can brush past.
          onSelect([]);
          return;
        }
        const found = nodesInRect(pointer.layout, box.rect);
        onSelect(box.additive ? union(selected, found) : found);
        return;
      }

      const current = dragRef.current;
      if (!current || pointer.event.pointerId !== current.pointerId) return;
      setGesture(null);
      if (!current.moved) return;

      // The same call that ends the gesture is the one that expands the engine's editing horizon
      // back to full, because it goes through the ordinary `player.update`.
      onCommit(documentFor(current), labelFor(current.anchors.laneId, current.nodes.length));
    },
    [documentFor, onCommit, onSelect, selected, setBox, setGesture],
  );

  const cancelGesture = useCallback(() => {
    setBox(null);
    setGesture(null);
  }, [setBox, setGesture]);

  // Keyboard is navigation only — arrows walk nodes, Shift extends the selection, Delete removes
  // it — values are edited through the numeric panel instead, since a selection alone doesn't say
  // which of up to four lanes an arrow key should nudge.
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<SVGSVGElement>): boolean => {
      const voices = schedule.voices;
      const focus = selected[selected.length - 1] ?? null;

      // With nothing selected Escape is left alone, and falls through to leaving the editor.
      if (event.key === 'Escape' && selected.length > 0) {
        event.preventDefault();
        onSelect([]);
        return true;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && focus) {
        event.preventDefault();
        // A refusal is silent here rather than disabled — there is no control to grey out — and the
        // panel says why on the node it applies to.
        const next = removeEntries(schedule, selected);
        if (next !== schedule) {
          const lowest = selected.reduce((low, node) => Math.min(low, node.entry), Infinity);
          onCommitAt(next, selected.length > 1 ? 'Delete nodes' : 'Delete node', [
            { voice: focus.voice, entry: Math.max(0, lowest - 1) },
          ]);
        }
        return true;
      }

      const step = KEY_STEPS[event.key];
      if (!step) return false;

      if (!focus) {
        // The first press is what gets a keyboard user onto the surface at all.
        const first = voices.findIndex((voice) => voice.entries.length > 0);
        if (first === -1) return false;
        event.preventDefault();
        onSelect([{ voice: first, entry: 0 }]);
        return true;
      }

      const voice = clamp(focus.voice + step.voice, 0, voices.length - 1);
      const entries = voices[voice]?.entries.length ?? 0;
      if (entries === 0) return true;

      event.preventDefault();
      const next = { voice, entry: clamp(focus.entry + step.entry, 0, entries - 1) };
      // Extending only makes sense along a voice; Shift+Up/Down would have to say what a rectangle
      // between two voices means, which is the marquee's question and the marquee's answer.
      const extending = event.shiftKey && step.voice === 0;
      onSelect(extending ? union(selected, [next]) : [next]);
      return true;
    },
    [onCommitAt, onSelect, schedule, selected],
  );

  const interaction = useMemo<ChartInteraction>(
    () => ({
      domainPadding: EDITOR_DOMAIN_PADDING,
      selected,
      dragging: (drag !== null && drag.moved) || (marquee?.moved ?? false),
      grid: snap,
      marks,
      onPointerDown: begin,
      onPointerMove: move,
      onPointerUp: end,
      onZoom: (by, anchor) => zoom(by, anchor),
      onPan: (seconds) => pan(seconds),
      onGestureCancel: cancelGesture,
      onKeyDown,
      overlay: (layout) => (
        <>
          {drag && <DragOverlay drag={drag} layout={layout} />}
          {marquee?.moved && <MarqueeBox rect={marquee.rect} />}
        </>
      ),
    }),
    [begin, cancelGesture, drag, end, marks, marquee, move, onKeyDown, pan, selected, snap, zoom],
  );

  // The toolbar as a memoised element rather than a memoised component: it changes only when the
  // window does, and this component re-renders on every `pointermove` of a drag.
  const controls = useMemo(
    () => (
      <ViewControls
        factor={factor}
        window={window}
        duration={duration}
        onZoom={(by) => zoom(by, (window.start + window.end) / 2, true)}
        onFit={() => {
          viewRef.current = fullView(duration);
          setView(null);
        }}
        onStart={(start) => pan(start - viewRef.current.start)}
      />
    ),
    [duration, factor, pan, window, zoom],
  );

  return (
    <>
      {controls}

      <ScheduleChart
        schedule={schedule}
        lanes={lanes}
        height={height}
        currentTime={currentTime}
        interaction={interaction}
        view={window}
        domains={domains}
        className="editor__chart"
      />
    </>
  );
}

function ViewControls({
  factor,
  window,
  duration,
  onZoom,
  onFit,
  onStart,
}: {
  factor: number;
  window: ViewWindow;
  duration: number;
  onZoom(by: number): void;
  onFit(): void;
  onStart(start: number): void;
}) {
  const span = window.end - window.start;
  const zoomed = factor > 1.01;

  return (
    <div className="editor__view">
      <span className="editor__view-label">Zoom</span>
      <button type="button" className="button" onClick={() => onZoom(1 / ZOOM_STEP)} disabled={!zoomed}>
        −
      </button>
      <span className="editor__zoom" aria-live="polite">
        {factor < 10 ? factor.toFixed(1) : Math.round(factor)}×
      </span>
      <button type="button" className="button" onClick={() => onZoom(ZOOM_STEP)}>
        +
      </button>
      <button type="button" className="button" onClick={onFit} disabled={!zoomed}>
        Fit
      </button>

      {zoomed && (
        <>
          <input
            className="editor__pan"
            type="range"
            min={0}
            max={Math.max(0, duration - span)}
            step={Math.max(0.01, span / 100)}
            value={window.start}
            aria-label="Pan"
            onChange={(event) => onStart(Number(event.target.value))}
          />
          <span className="editor__view-span">
            {formatClock(window.start)}–{formatClock(window.end)}
          </span>
        </>
      )}
    </div>
  );
}

const KEY_STEPS: Record<string, { voice: number; entry: number }> = {
  ArrowLeft: { voice: 0, entry: -1 },
  ArrowRight: { voice: 0, entry: 1 },
  ArrowUp: { voice: -1, entry: 0 },
  ArrowDown: { voice: 1, entry: 0 },
};

function labelFor(laneId: LaneId, count: number): string {
  const what = laneId === 'beat' || laneId === 'base' ? 'node' : 'volume node';
  return count > 1 ? `Move ${what}s` : `Move ${what}`;
}

/** Selections are sets of addresses; the order they were picked in means nothing downstream. */
function union(current: Selection, added: readonly NodeRef[]): Selection {
  const seen = new Map<string, NodeRef>();
  for (const node of [...current, ...added]) seen.set(`${node.voice}:${node.entry}`, node);
  return [...seen.values()].sort((a, b) => a.voice - b.voice || a.entry - b.entry);
}

function DragOverlay({ drag, layout }: { drag: Drag; layout: ChartLayout }) {
  const overlays = dragOverlay(drag.anchors, layout, drag.time, drag.value);
  const colours = new Map(drag.anchors.blocks.map((block) => [block.voice, block.colour]));

  return (
    <g className="schedule-chart__overlay">
      {overlays.map((overlay) => {
        const colour = colours.get(overlay.voice) ?? drag.anchors.colour;
        return (
          <g key={`${overlay.voice}-${overlay.laneId}`}>
            {overlay.tail && (
              <g transform={`translate(${overlay.tail.dx.toFixed(2)} 0)`}>
                <path
                  className="schedule-chart__overlay-series"
                  d={overlay.tail.d}
                  style={{ stroke: colour }}
                />
              </g>
            )}
            {overlay.block && (
              <g transform={`translate(${overlay.block.dx.toFixed(2)} ${overlay.block.dy.toFixed(2)})`}>
                <path
                  className="schedule-chart__overlay-series"
                  d={overlay.block.d}
                  style={{ stroke: colour }}
                />
              </g>
            )}
            {overlay.incoming && (
              <path
                className="schedule-chart__overlay-series"
                d={overlay.incoming}
                style={{ stroke: colour }}
              />
            )}
            {overlay.outgoing && (
              <path
                className="schedule-chart__overlay-series"
                d={overlay.outgoing}
                style={{ stroke: colour }}
              />
            )}
            <circle
              className="schedule-chart__overlay-node"
              cx={overlay.node.x}
              cy={overlay.node.y}
              r={5}
              style={{ fill: colour }}
            />
          </g>
        );
      })}

      <DragLabel
        drag={drag}
        overlay={overlays.find(
          (o) => o.laneId === drag.anchors.laneId && o.voice === drag.anchors.voice,
        )}
      />
    </g>
  );
}

function MarqueeBox({ rect }: { rect: PixelRect }) {
  return (
    <rect
      className="schedule-chart__marquee"
      x={Math.min(rect.x0, rect.x1)}
      y={Math.min(rect.y0, rect.y1)}
      width={Math.abs(rect.x1 - rect.x0)}
      height={Math.abs(rect.y1 - rect.y0)}
    />
  );
}

// Rendered here rather than through the numeric panel: the panel is outside this component, and
// updating it per move would re-render the editor. It catches up on pointerup instead.
function DragLabel({ drag, overlay }: { drag: Drag; overlay: { node: { x: number; y: number } } | undefined }) {
  if (!overlay) return null;
  const flip = overlay.node.x > drag.layout.width - 90;

  return (
    <text
      className="schedule-chart__overlay-label"
      x={overlay.node.x + (flip ? -10 : 10)}
      y={overlay.node.y - 10}
      textAnchor={flip ? 'end' : 'start'}
    >
      {formatNode(drag)}
    </text>
  );
}

function formatNode(drag: Drag): string {
  const lane = drag.layout.lanes.find((l) => l.model.id === drag.anchors.laneId);
  const value = lane ? `${lane.model.format(drag.value)} ${lane.model.unit}`.trim() : '';
  const count = drag.nodes.length > 1 ? ` · ${drag.nodes.length} nodes` : '';
  return `${value} · ${drag.time.toFixed(1)}s${count}`;
}
