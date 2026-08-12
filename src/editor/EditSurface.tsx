import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useThrottled } from '../app/useThrottled';
import type { MoveMode } from '../document/edit';
import { moveEntry, removeEntry, updateEntry } from '../document/edit';
import type { Schedule } from '../document/types';
import type { ChartInteraction, ChartPointer } from '../viz/ScheduleChart';
import { ScheduleChart } from '../viz/ScheduleChart';
import type { ChartLayout, ChartMark, LaneId } from '../viz/geometry';
import { EDITOR_DOMAIN_PADDING, laneField } from '../viz/geometry';
import { seriesColor } from '../viz/palette';
import type { DragAnchors } from './dragGeometry';
import { clamp, dragAnchors, dragOverlay } from './dragGeometry';
import type { NodeRef } from './history';

export interface EditSurfaceProps {
  /** The committed document. **Never an in-flight one** — see `ChartInteraction`. */
  schedule: Schedule;
  lanes: readonly LaneId[];
  height: number;
  currentTime?: number;
  selected: NodeRef | null;
  mode: MoveMode;
  /** Validation marks, derived from the committed document. Identity-stable between commits. */
  marks?: readonly ChartMark[];
  onSelect(node: NodeRef | null): void;
  /** One commit per gesture, at the end of it. */
  onCommit(schedule: Schedule, label: string): void;
  /** An edit that shifts the entry indices, so it says where the selection should land. */
  onCommitAt(schedule: Schedule, label: string, selection: NodeRef | null): void;
  /** The in-flight document, already rate-limited. Reaches the engine and nothing else. */
  onPreview(schedule: Schedule): void;
  /** A pointer that hit no node. Transport, not editing. */
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
  isLast: boolean;
  moved: boolean;
}

/**
 * §6.1's editing surface: the Phase 0 plot with nodes that can be selected and dragged.
 *
 * **This component is the only thing that re-renders while a finger is down.** The drag's in-flight
 * state lives here rather than in `EditorView`, for the reason Live mode put its slider values in
 * `LiveView`: everything above this — the readout, the timeline, the header fields, the node panel —
 * would otherwise re-render at pointer rate, and `Readout` alone recompiles a voice when its
 * schedule changes. Below it, `ScheduleChart` keeps the committed document for the whole gesture, so
 * its memoised model, layout and `StaticPlot` all hold; what moves is the overlay.
 *
 * The in-flight *document* therefore has exactly two consumers, neither of them a React tree: the
 * engine, reached through a throttled call that renders nothing, and — as pixels rather than as a
 * `Schedule` — the overlay. This is a deliberate departure from what step 4 recorded, which expected
 * `useEditor` to publish `preview ?? committed`; see PROGRESS.md.
 */
export function EditSurface({
  schedule,
  lanes,
  height,
  currentTime,
  selected,
  mode,
  marks,
  onSelect,
  onCommit,
  onCommitAt,
  onPreview,
  onSeek,
}: EditSurfaceProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // Mirrored in a ref so a move can read the gesture, push it at the engine and store it without
  // doing any of that inside a state updater, which React is free to run more than once.
  const dragRef = useRef<Drag | null>(null);
  const setGesture = useCallback((next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  // Read through a ref so the throttle's trailing edge cannot fire against a stale document, and so
  // that pushing to the engine never needs the drag in React state.
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  const documentFor = useCallback((current: Drag): Schedule => {
    const { anchors } = current;
    // Both axes at once: §6.1 asks for "drag to move in time and value", and the two transforms
    // compose because each reuses everything the other did not touch.
    const moved = moveEntry(scheduleRef.current, {
      voice: anchors.voice,
      entry: anchors.entry,
      time: current.time,
      mode: current.mode,
    });
    return updateEntry(moved, anchors.voice, anchors.entry, {
      [laneField(anchors.laneId)]: current.value,
    });
  }, []);

  // Built inside the throttled action rather than on every move: at 60 Hz a preview document is
  // ~1 kB of garbage per frame for a value nothing reads until the next push.
  const push = useThrottled((current: Drag) => onPreview(documentFor(current)));

  const begin = useCallback(
    (pointer: ChartPointer) => {
      const { hit, lane, layout } = pointer;
      if (!hit || !lane || hit.entry === null) {
        onSelect(null);
        onSeek(pointer.time);
        return;
      }

      const entries = schedule.voices[hit.voice]?.entries ?? [];
      // Alt inverts the mode for this gesture only. A phone has no modifier, which is why the
      // standing choice is a control in the editor rather than a chord.
      const gestureMode: MoveMode =
        pointer.event.altKey ? (mode === 'squeeze' ? 'ripple' : 'squeeze') : mode;
      const anchors = dragAnchors(
        schedule,
        layout,
        lane.model.id,
        hit.voice,
        hit.entry,
        gestureMode,
        seriesColor(hit.series.slot),
      );
      if (!anchors) return;

      onSelect({ voice: hit.voice, entry: hit.entry });
      setGesture({
        pointerId: pointer.event.pointerId,
        anchors,
        layout,
        grabX: pointer.x - anchors.lanes.find((l) => l.laneId === lane.model.id)!.node.x,
        grabY: pointer.y - anchors.lanes.find((l) => l.laneId === lane.model.id)!.node.y,
        time: anchors.time,
        value: anchors.value,
        mode: gestureMode,
        isLast: hit.entry === entries.length - 1,
        moved: false,
      });
    },
    [mode, onSeek, onSelect, schedule, setGesture],
  );

  const move = useCallback(
    (pointer: ChartPointer) => {
      const current = dragRef.current;
      if (!current || pointer.event.pointerId !== current.pointerId) return;

      const { anchors, layout } = current;
      const grabbed = layout.lanes.find((l) => l.model.id === anchors.laneId);
      if (!grabbed) return;

      const next: Drag = {
        ...current,
        time: clamp(
          layout.timeScale.toValue(pointer.x - current.grabX),
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
    [push, setGesture],
  );

  const end = useCallback(
    (pointer: ChartPointer) => {
      const current = dragRef.current;
      if (!current || pointer.event.pointerId !== current.pointerId) return;
      setGesture(null);
      if (!current.moved) return;

      // The same call that ends the gesture is the one that expands the engine's editing horizon
      // back to full, because it goes through the ordinary `player.update`.
      onCommit(documentFor(current), labelFor(current.anchors.laneId));
    },
    [documentFor, onCommit, setGesture],
  );

  /**
   * Keyboard operation of the surface: **navigation only, values in the panel.**
   *
   * Arrows walk the nodes — left and right within a voice, up and down between voices — and Escape
   * lets go. Nudging a *value* from here would have to pick one of up to four lanes to nudge, and
   * there is nothing in a selection that says which; the numeric panel is a set of ordinary form
   * fields that is already keyboard-operable and already the answer §6.1 gives for exact values.
   *
   * Delete and Backspace remove the selected node — §6.1's "select and delete" — and leave the
   * neighbour selected so a second press repeats rather than needing a re-select. There is no
   * keyboard shortcut for the inverse: `Insert` does not exist on a Mac or a phone, and the panel's
   * button is reachable everywhere.
   *
   * With nothing selected the arrows keep the read-only chart's crosshair readout, which is what a
   * caller with no interest in editing gets.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<SVGSVGElement>): boolean => {
      const voices = schedule.voices;
      if (event.key === 'Escape' && selected) {
        onSelect(null);
        return true;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
        event.preventDefault();
        // A refusal is silent here rather than disabled — there is no control to grey out — and the
        // panel says why on the node it applies to.
        const next = removeEntry(schedule, { voice: selected.voice, entry: selected.entry });
        if (next !== schedule) {
          onCommitAt(next, 'Delete node', {
            voice: selected.voice,
            entry: Math.max(0, selected.entry - 1),
          });
        }
        return true;
      }

      const step = KEY_STEPS[event.key];
      if (!step) return false;

      if (!selected) {
        // The first press is what gets a keyboard user onto the surface at all.
        const first = voices.findIndex((voice) => voice.entries.length > 0);
        if (first === -1) return false;
        event.preventDefault();
        onSelect({ voice: first, entry: 0 });
        return true;
      }

      const voice = clamp(selected.voice + step.voice, 0, voices.length - 1);
      const entries = voices[voice]?.entries.length ?? 0;
      if (entries === 0) return true;

      event.preventDefault();
      onSelect({ voice, entry: clamp(selected.entry + step.entry, 0, entries - 1) });
      return true;
    },
    [onCommitAt, onSelect, schedule, selected],
  );

  const interaction = useMemo<ChartInteraction>(
    () => ({
      domainPadding: EDITOR_DOMAIN_PADDING,
      selected,
      dragging: drag !== null && drag.moved,
      marks,
      onPointerDown: begin,
      onPointerMove: move,
      onPointerUp: end,
      onKeyDown,
      overlay: (layout) => (drag ? <DragOverlay drag={drag} layout={layout} /> : null),
    }),
    [begin, drag, end, marks, move, onKeyDown, selected],
  );

  return (
    <ScheduleChart
      schedule={schedule}
      lanes={lanes}
      height={height}
      currentTime={currentTime}
      interaction={interaction}
      className="editor__chart"
    />
  );
}

/** Which way each arrow walks the selection. */
const KEY_STEPS: Record<string, { voice: number; entry: number }> = {
  ArrowLeft: { voice: 0, entry: -1 },
  ArrowRight: { voice: 0, entry: 1 },
  ArrowUp: { voice: -1, entry: 0 },
  ArrowDown: { voice: 1, entry: 0 },
};

function labelFor(laneId: LaneId): string {
  return laneId === 'beat' || laneId === 'base' ? 'Move node' : 'Move volume node';
}

/** The moving part: two segments, a marker, and — under a ripple — a translated tail. */
function DragOverlay({ drag, layout }: { drag: Drag; layout: ChartLayout }) {
  const overlays = dragOverlay(drag.anchors, layout, drag.time, drag.value, drag.mode, drag.isLast);

  return (
    <g className="schedule-chart__overlay">
      {overlays.map((overlay) => (
        <g key={overlay.laneId}>
          {overlay.tail && (
            <g transform={`translate(${overlay.tail.dx.toFixed(2)} 0)`}>
              <path
                className="schedule-chart__overlay-series"
                d={overlay.tail.d}
                style={{ stroke: drag.anchors.colour }}
              />
            </g>
          )}
          {overlay.incoming && (
            <path
              className="schedule-chart__overlay-series"
              d={overlay.incoming}
              style={{ stroke: drag.anchors.colour }}
            />
          )}
          {overlay.outgoing && (
            <path
              className="schedule-chart__overlay-series"
              d={overlay.outgoing}
              style={{ stroke: drag.anchors.colour }}
            />
          )}
          <circle
            className="schedule-chart__overlay-node"
            cx={overlay.node.x}
            cy={overlay.node.y}
            r={5}
            style={{ fill: drag.anchors.colour }}
          />
        </g>
      ))}

      <DragLabel drag={drag} overlay={overlays.find((o) => o.laneId === drag.anchors.laneId)} />
    </g>
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
  return `${value} · ${drag.time.toFixed(1)}s`;
}
