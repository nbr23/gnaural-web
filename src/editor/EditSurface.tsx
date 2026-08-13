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
  /** The committed document. **Never an in-flight one** — see `ChartInteraction`. */
  schedule: Schedule;
  lanes: readonly LaneId[];
  height: number;
  currentTime?: number;
  selected: Selection;
  mode: MoveMode;
  /** Snap a time drag to the visible grid. Shift held at pointerdown inverts it for one gesture. */
  snap: boolean;
  /** Manual y-axis bounds per lane (§6.1). Identity-stable, since the chart memoises on it. */
  domains?: LaneDomains;
  /** Validation marks, derived from the committed document. Identity-stable between commits. */
  marks?: readonly ChartMark[];
  onSelect(selection: Selection): void;
  /** One commit per gesture, at the end of it. */
  onCommit(schedule: Schedule, label: string): void;
  /** An edit that shifts the entry indices, so it says where the selection should land. */
  onCommitAt(schedule: Schedule, label: string, selection: Selection): void;
  /** The in-flight document, already rate-limited. Reaches the engine and nothing else. */
  onPreview(schedule: Schedule): void;
  /** A pointer that hit no node and never moved. Transport, not editing. */
  onSeek(time: number): void;
}

interface Drag {
  pointerId: number;
  anchors: DragAnchors;
  layout: ChartLayout;
  /** Pointer position minus the node's, so the node does not jump under the finger on grab. */
  grabX: number;
  grabY: number;
  time: number;
  value: number;
  /**
   * Fixed when the pointer lands, from the current mode and whether Alt was held. Momentary rather
   * than sampled per move, so a modifier released mid-drag cannot change what the gesture meant.
   */
  mode: MoveMode;
  /** Likewise for snapping, which Shift inverts. Zero means no grid. */
  gridStep: number;
  /** The nodes this gesture moves — the whole selection when the grabbed node is part of it. */
  nodes: Selection;
  moved: boolean;
}

/** A marquee in flight: where it started, where the pointer is, and whether it adds or replaces. */
interface Marquee {
  pointerId: number;
  origin: { x: number; y: number };
  rect: PixelRect;
  additive: boolean;
  time: number;
  moved: boolean;
}

/** Movement past which a pointer that missed every node is a marquee rather than a tap. */
const MARQUEE_THRESHOLD_PX = 4;
/** One press of the zoom buttons, and one double of the wheel. */
const ZOOM_STEP = 2;

/**
 * §6.1's editing surface: the Phase 0 plot with nodes that can be selected, dragged, marquee'd and
 * moved as a group, over a time axis that zooms and pans.
 *
 * **This component is the only thing that re-renders while a finger is down.** The drag's in-flight
 * state lives here rather than in `EditorView`, for the reason Live mode put its slider values in
 * `LiveView`: everything above this — the readout, the timeline, the header fields, the node panel —
 * would otherwise re-render at pointer rate, and `Readout` alone recompiles a voice when its
 * schedule changes. Below it, `ScheduleChart` keeps the committed document for the whole gesture, so
 * its memoised model, layout and `StaticPlot` all hold; what moves is the overlay.
 *
 * **The view window lives here for the same reason, and is rate-limited for a sharper one.** A zoom
 * changes the layout, which is the one thing every memo below is keyed on, so a zoom frame really
 * does rebuild the whole picture: measured at 10.7 ms for the densest bundled document at four
 * lanes, against 0.34 ms for a frame that only moves the playhead. A pinch at 60 Hz would be two
 * thirds of the main thread. So continuous gestures — wheel, pinch, the pan rail — go through the
 * same 100 ms throttle the engine push uses, and only the buttons apply at once.
 *
 * The in-flight *document* has exactly two consumers, neither of them a React tree: the engine,
 * reached through a throttled call that renders nothing, and — as pixels rather than as a
 * `Schedule` — a drag overlay. This is a deliberate departure from what step 4 recorded, which
 * expected `useEditor` to publish `preview ?? committed`; see PROGRESS.md.
 */
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
  onSeek,
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
  const [view, setView] = useState<ViewWindow | null>(null);
  /**
   * The resolved window. Null state means "the whole thing", so a document that grows or shrinks
   * under an untouched view keeps showing all of itself rather than holding a window that was right
   * for a different document.
   *
   * **Memoised, and that is load-bearing rather than tidy.** This object is the chart's `view` prop
   * and therefore a dependency of its `layout` memo, which every memo below — `StaticPlot`,
   * `IssueMarks`, `SelectionRing` — is keyed on in turn. A fresh object per render would rebuild the
   * whole picture on every `pointermove` of a drag, which is the 1220 ms defect exactly. It was
   * written that way first and measured at 4.0 ms per move against 0.6 ms; see PROGRESS.md.
   */
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
    // Both axes at once: §6.1 asks for "drag to move in time and value", and the two transforms
    // compose because each reuses everything the other did not touch. A group is the same pair of
    // edits over more addresses — the time shift is one delta for every voice, and the value shift
    // is one delta for every node, which is what preserves the shape of what was selected.
    const moved = moveEntries(scheduleRef.current, {
      nodes: current.nodes,
      deltaTime: current.time - anchors.time,
      mode: current.mode,
    });
    // No clamp here: `anchors.minValue`/`maxValue` are already the bounds that keep *every* selected
    // node inside the lane, and `move` applied them to the grabbed node before this ran.
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
        // A pointer on empty space is not yet a decision: it arms a marquee, and becomes a seek on
        // pointerup only if it never moved. Step 5 reserved exactly this gesture.
        setBox({
          pointerId: pointer.event.pointerId,
          origin: { x: pointer.x, y: pointer.y },
          rect: { x0: pointer.x, y0: pointer.y, x1: pointer.x, y1: pointer.y },
          additive: pointer.event.shiftKey,
          time: pointer.time,
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
          // A tap on empty space is transport, exactly as it was before the marquee existed.
          onSelect([]);
          onSeek(box.time);
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
    [documentFor, onCommit, onSeek, onSelect, selected, setBox, setGesture],
  );

  /** A second finger landed: whatever one finger was doing is not what was meant. */
  const cancelGesture = useCallback(() => {
    setBox(null);
    setGesture(null);
  }, [setBox, setGesture]);

  /**
   * Keyboard operation of the surface: **navigation only, values in the panel.**
   *
   * Arrows walk the nodes — left and right within a voice, up and down between voices — and Escape
   * lets go. Nudging a *value* from here would have to pick one of up to four lanes to nudge, and
   * there is nothing in a selection that says which; the numeric panel is a set of ordinary form
   * fields that is already keyboard-operable and already the answer §6.1 gives for exact values.
   *
   * **Shift+Left/Right extends the selection**, which is the marquee's keyboard equivalent: without
   * it a group — and therefore the group panel, and therefore group scaling — would be reachable
   * only with a pointer.
   *
   * Delete and Backspace remove the selection — §6.1's "select and delete" — and leave the
   * neighbour selected so a second press repeats rather than needing a re-select. There is no
   * keyboard shortcut for the inverse: `Insert` does not exist on a Mac or a phone, and the panel's
   * button is reachable everywhere.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<SVGSVGElement>): boolean => {
      const voices = schedule.voices;
      const focus = selected[selected.length - 1] ?? null;

      if (event.key === 'Escape' && selected.length > 0) {
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

/**
 * Zoom and pan as controls, beside the gestures rather than instead of them.
 *
 * The rail is a real `<input type="range">` for the reason step 5 kept `Timeline` as one: it is
 * keyboard-operable and a native touch target for free, and a phone should not have to discover a
 * gesture to reach the second half of a programme. It appears only when there is something to pan.
 */
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

/** Which way each arrow walks the selection. */
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

/** The moving part: per voice and lane, two segments, a translated block, and a marker. */
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

/**
 * The live value, beside the finger.
 *
 * It is here rather than in the numeric panel deliberately: the panel is outside this component and
 * updating it per move would re-render the editor, which is the one thing this arrangement exists to
 * avoid. The panel catches up on pointerup, when the value becomes a decision.
 */
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
