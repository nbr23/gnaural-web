import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatClock } from '../app/format';
import type { EntryLocation, Schedule } from '../document/types';
import { VoiceType } from '../document/types';
import { EEG_BANDS } from './bands';
import type {
  BreakpointHit,
  ChartLayout,
  ChartMark,
  ChartModel,
  LaneDomains,
  LaneId,
  LaneLayout,
  SeriesPoint,
  ViewWindow,
  VoiceSeries,
} from './geometry';
import {
  DEFAULT_LANES,
  DEFAULT_METRICS,
  DOMAIN_PADDING,
  buildChartModel,
  isVoicePlotted,
  layoutChart,
  nearestBreakpoint,
  polylinePath,
  seriesValueAt,
  timeAtPixel,
  visibleRange,
} from './geometry';
import { seriesColor } from './palette';
import type { Scale } from './scales';
import { gridLines, niceTicks, timeGridStep, timeTicksIn } from './scales';
import './ScheduleChart.css';

/** A pointer position, resolved into everything an editing caller needs to decide what it grabbed. */
export interface ChartPointer {
  layout: ChartLayout;
  /** In the layout's own pixel space, already scaled out of client coordinates. */
  x: number;
  y: number;
  time: number;
  lane: LaneLayout | null;
  /** The nearest authored entry within the hit radius, or null for a miss. Never the wrap point. */
  hit: BreakpointHit | null;
  event: ReactPointerEvent<SVGSVGElement>;
}

/**
 * Turns the read-only plot into an editing surface, without teaching it what a document edit is.
 *
 * The chart resolves pointer coordinates, hit-tests, and draws the nodes; the caller decides what a
 * grab means and draws the moving part into `overlay`. The caller must not push its in-flight
 * document back in through `schedule` — that would rebuild the memoised model on every
 * `pointermove`. During a gesture `schedule` holds still and the overlay is what moves.
 */
export interface ChartInteraction {
  /** Wider than the read-only default, so a value drag can reach past the data. */
  domainPadding?: number;
  /**
   * Drawn with a ring, one per node. Addressed by index rather than id. Must be identity-stable
   * between selection changes — a marquee can select every node in the document, and this layer is
   * `memo`'d so a drag doesn't rebuild them on every `pointermove`.
   */
  selected?: readonly EntryLocation[];
  /** A gesture is in flight: the static curves become a ghost and the crosshair gets out of the way. */
  dragging?: boolean;
  /** Draw the snap grid the caller is snapping to. Omit for no grid. */
  grid?: boolean;
  /**
   * Nodes to mark as needing attention. Must be identity-stable while a gesture runs — drawn by a
   * `memo`'d layer, so a fresh array per `pointermove` would rebuild them per move.
   */
  marks?: readonly ChartMark[];
  /** Rendered above the static plot in the layout's pixel space. Keep it O(1) — it runs per move. */
  overlay?(layout: ChartLayout): ReactNode;
  onPointerDown?(pointer: ChartPointer): void;
  onPointerMove?(pointer: ChartPointer): void;
  onPointerUp?(pointer: ChartPointer): void;
  /**
   * Zoom by `factor` about `anchor` seconds — a wheel with ctrl/⌘ held, or a two-finger pinch. The
   * chart recognises the gesture since only it has the layout and the element's rect; the caller
   * owns the window, so this component stays fully controlled.
   */
  onZoom?(factor: number, anchor: number): void;
  /** Pan by a number of seconds — a horizontal wheel, or a two-finger drag. */
  onPan?(seconds: number): void;
  /** A second finger landed, so the one-finger gesture in flight is dropped without committing;
   *  the pinch takes over until one finger is left. */
  onGestureCancel?(): void;
  /** Return true to claim the key; anything unclaimed falls through to the crosshair readout. */
  onKeyDown?(event: ReactKeyboardEvent<SVGSVGElement>, layout: ChartLayout): boolean;
}

export interface ScheduleChartProps {
  schedule: Schedule;
  /** Playhead position, in seconds from schedule start. Omit to hide the playhead. */
  currentTime?: number;
  /** Parameter lanes to draw, top to bottom. */
  lanes?: readonly LaneId[];
  /** Total height in px, including the time-axis band. Width is measured from the container. */
  height?: number;
  /** Supply this and the plot becomes editable. Absent, the component is exactly what it was. */
  interaction?: ChartInteraction;
  /**
   * The stretch of time to draw. Omit for the whole schedule, which is what the player wants.
   * A controlled prop, not internal state: it reaches `layoutChart` only, so the compiled model
   * above it is untouched by a zoom.
   */
  view?: ViewWindow;
  /** Manual y-axis bounds per lane (§6.1). A lane not named here is fitted to its data. */
  domains?: LaneDomains;
  className?: string;
}

/** Pointer radius within which an authored breakpoint is highlighted (a >= 24px hit target). */
const BREAKPOINT_HIT_RADIUS = 12;
/**
 * Zoom per pixel of wheel travel, exponentiated so the gesture is symmetric — the same scroll back
 * undoes the same scroll forward exactly. One notch of a mouse wheel (~100 px) is about 1.35×.
 */
const WHEEL_ZOOM_RATE = 0.003;
/** Below this much movement a two-finger gesture is a pan rather than a pinch. */
const PINCH_EPSILON = 0.5;
const DEFAULT_HEIGHT = 280;
/** Roughly one time label per this many pixels, so narrow phones don't collide their labels. */
const PX_PER_TIME_TICK = 110;

const VOICE_TYPE_LABELS: Partial<Record<VoiceType, string>> = {
  [VoiceType.PinkNoise]: 'noise',
  [VoiceType.Pcm]: 'external audio',
  [VoiceType.IsoPulse]: 'isochronic',
  [VoiceType.IsoPulseAlt]: 'isochronic (alternating)',
  [VoiceType.WaterDrops]: 'water drops',
  [VoiceType.Rain]: 'rain',
};

/**
 * Least vertical distance between two y-axis labels, measured rather than chosen: the tick text is
 * 11px in a 15px line box, so anything closer overprints. Deliberately not `MIN_GRID_PX`, which
 * governs the time grid — a grid line carries no label, so it can be far finer.
 */
const MIN_TICK_LABEL_PX = 15;

/**
 * Y-axis positions for a lane. The beat lane reads against the EEG bands it's shaded with rather
 * than arbitrary round numbers, since those boundaries are what the value means.
 *
 * The boundaries are geometric (0.5, 4, 8, 13, 30, 100) while the lane is linear, so a domain
 * reaching into Gamma crushes the low ones into the bottom few pixels — measured in a browser at
 * four of five labels overprinting into an illegible smear. They're thinned by pixel distance, and
 * a lane too short to carry two of them falls back to round numbers.
 */
function laneTicks(lane: LaneLayout): number[] {
  const [min, max] = lane.model.domain;
  if (lane.model.id === 'beat') {
    const edges = [...new Set(EEG_BANDS.flatMap((band) => [band.min, band.max]))].filter(
      (hz) => hz > min && hz < max,
    );
    const legible = legibleTicks(edges, lane.valueScale);
    if (legible.length >= 2) return legible;
  }
  return niceTicks(lane.model.domain, 4).filter((tick) => tick >= min && tick <= max);
}

/**
 * Drop the ticks a reader couldn't tell apart, keeping the higher values. Highest-first because
 * crowding is always at the bottom of a beat lane, so walking down from the top keeps the
 * widely-spaced ones and discards the cluster near zero.
 */
function legibleTicks(values: readonly number[], scale: Scale): number[] {
  const kept: number[] = [];
  let lastPixel = Infinity;

  for (const value of [...values].sort((a, b) => b - a)) {
    const pixel = scale.toPixel(value);
    if (Math.abs(pixel - lastPixel) < MIN_TICK_LABEL_PX) continue;
    kept.push(value);
    lastPixel = pixel;
  }

  return kept.reverse();
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

interface HoverState {
  time: number;
  /** Null for keyboard-driven hover, which has no vertical position. */
  pixelY: number | null;
}

/**
 * Read-only plot of a schedule's beat and base frequency curves against time, with a live
 * playhead.
 *
 * The pointer is never transport: hovering reads values out and, with `interaction`, edits the
 * document. Moving the playhead belongs to `Timeline`, which is a control rather than a plot nobody
 * can brush past by accident.
 *
 * Beat and base get their own lanes on a shared time axis rather than two y-scales on one plot —
 * a dual-axis chart implies a correlation that isn't in the data.
 *
 * The component owns no audio and no clock. `currentTime` is a plain number the caller polls from
 * `PlaybackEngine.getCurrentOffset()` itself. Geometry is memoised so a 60fps `currentTime` only
 * moves the playhead.
 */
export function ScheduleChart({
  schedule,
  currentTime,
  lanes = DEFAULT_LANES,
  height = DEFAULT_HEIGHT,
  interaction,
  view,
  domains,
  className,
}: ScheduleChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId();
  const [hover, setHover] = useState<HoverState | null>(null);

  const editing = interaction !== undefined;
  const padding = interaction?.domainPadding ?? DOMAIN_PADDING;
  const model = useMemo(
    () => buildChartModel(schedule, lanes, padding, domains),
    [schedule, lanes, padding, domains],
  );
  const layout = useMemo(
    () => (width > 0 ? layoutChart(model, width, height, DEFAULT_METRICS, view) : null),
    [model, width, height, view],
  );

  const xTicks = useMemo(
    () =>
      layout
        ? timeTicksIn(
            layout.view.start,
            layout.view.end,
            Math.max(3, Math.round(width / PX_PER_TIME_TICK)),
          )
        : [],
    [layout, width],
  );

  /** The snap grid, drawn only when the caller is snapping to it — snapping to something invisible
   *  would be a mystery rather than a feature. */
  const grid = useMemo(() => {
    if (!layout || !interaction?.grid) return [];
    const plot = layout.lanes[0]?.width ?? 0;
    const step = timeGridStep(layout.view.end - layout.view.start, plot);
    return gridLines(layout.view.start, layout.view.end, step);
  }, [interaction?.grid, layout]);

  const pointerPosition = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg || !layout) return null;

      // Scale client coordinates into the SVG's own system, so hit-testing stays correct even if
      // CSS renders the element at a different size than its width attribute. A rect with no
      // extent (detached/hidden element) scales 1:1 rather than dividing by zero.
      const rect = svg.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (rect.width > 0 ? layout.width / rect.width : 1),
        y: (event.clientY - rect.top) * (rect.height > 0 ? layout.height / rect.height : 1),
      };
    },
    [layout],
  );

  const resolvePointer = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>): ChartPointer | null => {
      const position = pointerPosition(event);
      if (!position || !layout) return null;

      const lane =
        layout.lanes.find((l) => position.y >= l.y && position.y <= l.y + l.height) ?? null;
      return {
        layout,
        x: position.x,
        y: position.y,
        time: timeAtPixel(layout, position.x),
        lane,
        hit: lane
          ? nearestBreakpoint(lane, layout.timeScale, position.x, position.y, BREAKPOINT_HIT_RADIUS, true)
          : null,
        event,
      };
    },
    [layout, pointerPosition],
  );

  /**
   * Fingers currently on the plot, by pointer id — a map rather than a count because a pinch needs
   * both positions. One finger is the editing gesture the caller owns; two are the chart's own,
   * since `touch-action: none` is set on the plot while editing.
   */
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; centre: number } | null>(null);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const position = pointerPosition(event);

      if (interaction) {
        if (position && touches.current.has(event.pointerId)) {
          touches.current.set(event.pointerId, position);
        }
        if (touches.current.size >= 2) {
          trackPinch(touches.current, pinch, layout, interaction);
          return;
        }

        const pointer = resolvePointer(event);
        if (pointer) interaction.onPointerMove?.(pointer);
        return;
      }

      if (!position || !layout) return;
      setHover({ time: timeAtPixel(layout, position.x), pixelY: position.y });
    },
    [interaction, layout, pointerPosition, resolvePointer],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (interaction) {
        const pointer = resolvePointer(event);
        if (!pointer) return;

        touches.current.set(event.pointerId, { x: pointer.x, y: pointer.y });
        if (touches.current.size >= 2) {
          // The one-finger gesture in flight is not what was meant — drop it rather than commit
          // half of it, and let the pinch run until a finger comes up.
          pinch.current = null;
          interaction.onGestureCancel?.();
          return;
        }

        // Captured unconditionally: a finger that leaves the plot mid-drag must still finish its
        // gesture, and a miss releases it on the pointerup that follows.
        event.currentTarget.setPointerCapture(event.pointerId);
        interaction.onPointerDown?.(pointer);
      }
    },
    [interaction, resolvePointer],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!interaction) return;

      const pinching = touches.current.size >= 2;
      touches.current.delete(event.pointerId);
      pinch.current = null;
      // The finger that ends a pinch must not also end a drag: there is no drag, the second
      // finger cancelled it, and a pointerup the caller acted on would commit an edit nobody made.
      if (pinching) return;

      const pointer = resolvePointer(event);
      if (pointer) interaction.onPointerUp?.(pointer);
    },
    [interaction, resolvePointer],
  );

  /**
   * Wheel: ctrl/⌘ zooms about the pointer, a horizontal wheel pans, a plain vertical wheel is the
   * page's business and is left alone. A native listener rather than React's `onWheel`, because
   * React attaches wheel at the root as passive and `preventDefault` there does nothing — and a
   * trackpad pinch arrives as ctrl+wheel, so without it the browser would zoom the page under the
   * gesture.
   */
  // Read through a ref rather than as a dependency: `interaction` is a fresh object on every
  // render of an editing caller, and depending on it would rebind a DOM listener on every drag move.
  const interactionRef = useRef(interaction);
  interactionRef.current = interaction;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !layout || !editing) return;

    const onWheel = (event: WheelEvent) => {
      const current = interactionRef.current;
      if (!current) return;

      const rect = svg.getBoundingClientRect();
      const x = (event.clientX - rect.left) * (rect.width > 0 ? layout.width / rect.width : 1);

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        current.onZoom?.(Math.exp(-event.deltaY * WHEEL_ZOOM_RATE), timeAtPixel(layout, x));
        return;
      }

      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        const span = layout.view.end - layout.view.start;
        const plot = layout.lanes[0]?.width ?? 1;
        current.onPan?.((event.deltaX * span) / plot);
      }
    };

    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [editing, layout]);

  const stepHover = useCallback(
    (event: ReactKeyboardEvent<SVGSVGElement>) => {
      if (!layout) return;
      // An editing caller gets first refusal on every key; only what it doesn't claim falls
      // through to the crosshair readout.
      if (interaction?.onKeyDown?.(event, layout)) return;

      const { duration } = layout.model;
      const current = hover?.time ?? 0;
      let next: number;

      switch (event.key) {
        case 'ArrowLeft':
          next = current - duration / 100;
          break;
        case 'ArrowRight':
          next = current + duration / 100;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = duration;
          break;
        case 'Escape':
          if (hover) {
            event.preventDefault();
            setHover(null);
          }
          return;
        default:
          return;
      }

      event.preventDefault();
      setHover({ time: Math.min(duration, Math.max(0, next)), pixelY: null });
    },
    [interaction, layout, hover],
  );

  if (model.voices.length === 0) {
    return (
      <div className={containerClass(className, editing, false)} ref={containerRef}>
        <p className="schedule-chart__empty">This schedule has no visible voices to plot.</p>
      </div>
    );
  }

  if (!layout) {
    // First paint, before the container has been measured — reserve the height so nothing jumps.
    return <div className={containerClass(className, editing, false)} ref={containerRef} style={{ height }} />;
  }

  const hoverX = hover ? layout.timeScale.toPixel(hover.time) : null;
  const pixelY = hover?.pixelY ?? null;
  const hoveredLane =
    pixelY === null
      ? undefined
      : layout.lanes.find((lane) => pixelY >= lane.y && pixelY <= lane.y + lane.height);
  const hoveredBreakpoint =
    hoveredLane && hoverX !== null && pixelY !== null
      ? nearestBreakpoint(hoveredLane, layout.timeScale, hoverX, pixelY, BREAKPOINT_HIT_RADIUS)
      : null;

  const dragging = interaction?.dragging ?? false;
  const showCrosshair = hover && hoverX !== null && !dragging;

  return (
    <div className={containerClass(className, editing, dragging)} ref={containerRef}>
      {model.voices.length > 1 && <Legend model={model} />}

      <svg
        ref={svgRef}
        className="schedule-chart__plot"
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={chartLabel(schedule, model.voices.length, model.duration)}
        tabIndex={0}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => setHover(null)}
        onKeyDown={stepHover}
        onBlur={() => setHover(null)}
      >
        <LaneClips layout={layout} id={clipId} />

        <StaticPlot layout={layout} xTicks={xTicks} grid={grid} nodes={editing} clipId={clipId} />

        {interaction?.marks && interaction.marks.length > 0 && (
          <IssueMarks layout={layout} marks={interaction.marks} clipId={clipId} />
        )}

        {interaction?.selected && interaction.selected.length > 0 && (
          <SelectionRing layout={layout} selected={interaction.selected} clipId={clipId} />
        )}

        {showCrosshair && (
          <Crosshair
            layout={layout}
            time={hover.time}
            x={hoverX}
            hoveredLane={hoveredLane}
            breakpoint={hoveredBreakpoint}
          />
        )}

        {interaction?.overlay?.(layout)}

        {currentTime !== undefined && currentTime >= layout.view.start && currentTime <= layout.view.end && (
          <Playhead layout={layout} x={layout.timeScale.toPixel(currentTime)} />
        )}
      </svg>

      {showCrosshair && <Tooltip layout={layout} time={hover.time} x={hoverX} />}
    </div>
  );
}

/**
 * Two fingers: the change in their separation is a zoom, the change in their midpoint is a pan.
 * Both are reported as deltas against the previous frame rather than as absolute state, so the
 * caller can rate-limit a redraw that's expensive at 60 Hz.
 */
function trackPinch(
  touches: Map<number, { x: number; y: number }>,
  previous: { current: { distance: number; centre: number } | null },
  layout: ChartLayout | null,
  interaction: ChartInteraction,
): void {
  if (!layout) return;

  const [a, b] = [...touches.values()];
  const distance = Math.abs(a.x - b.x);
  const centre = timeAtPixel(layout, (a.x + b.x) / 2);
  const last = previous.current;
  previous.current = { distance, centre };
  if (!last) return;

  if (last.distance > PINCH_EPSILON && Math.abs(distance - last.distance) > PINCH_EPSILON) {
    interaction.onZoom?.(distance / last.distance, last.centre);
  }
  // The anchor above is the *previous* midpoint: the instant between the fingers stays put, and
  // the pan below moves what's left.
  if (centre !== last.centre) interaction.onPan?.(last.centre - centre);
}

function containerClass(className: string | undefined, editing: boolean, dragging: boolean): string {
  const names = ['schedule-chart'];
  // `touch-action: none` hangs off this class: without it a phone pans the page instead of
  // delivering `pointermove`.
  if (editing) names.push('schedule-chart--editing');
  if (dragging) names.push('schedule-chart--dragging');
  if (className) names.push(className);
  return names.join(' ');
}

function chartLabel(schedule: Schedule, voiceCount: number, duration: number): string {
  const name = schedule.title.trim() || 'Untitled schedule';
  const voices = `${voiceCount} voice${voiceCount === 1 ? '' : 's'}`;
  return `Beat and base frequency over time for ${name} — ${voices}, ${formatClock(duration)} long.`;
}

/**
 * Everything in the plot that does not move: lanes, band shading, grid, curves, axis. Memoised on
 * the layout alone, so an advancing playhead doesn't rebuild it — without this every tick of the
 * clock re-ran `polylinePath` over every breakpoint of every voice, enough garbage per second on a
 * phone to make playback crackle.
 */
const StaticPlot = memo(function StaticPlot({
  layout,
  xTicks,
  grid,
  nodes,
  clipId,
}: {
  layout: ChartLayout;
  xTicks: number[];
  grid: number[];
  /** Draw a marker on every entry. Editing only — see the note on "deliberately not drawn" below. */
  nodes: boolean;
  clipId: string;
}) {
  const truncationVisible =
    layout.model.truncated &&
    layout.model.playbackDuration >= layout.view.start &&
    layout.model.playbackDuration <= layout.view.end;

  return (
    <>
      {layout.lanes.map((lane) => (
        <Lane
          key={lane.model.id}
          lane={lane}
          layout={layout}
          xTicks={xTicks}
          grid={grid}
          nodes={nodes}
          clipId={clipId}
        />
      ))}

      <TimeAxis layout={layout} xTicks={xTicks} />

      {truncationVisible && <TruncationMarker layout={layout} />}
    </>
  );
});

/**
 * One clip rectangle per lane, so a zoomed view cannot draw a curve or a node outside its own plot.
 * The points bracketing the window are deliberately kept so lines enter from off-screen, and
 * without this clip those would land on the y-axis labels.
 */
const LaneClips = memo(function LaneClips({ layout, id }: { layout: ChartLayout; id: string }) {
  return (
    <defs>
      {layout.lanes.map((lane) => (
        <clipPath key={lane.model.id} id={`${id}-${lane.model.id}`}>
          <rect x={lane.x} y={lane.y} width={lane.width} height={lane.height} />
        </clipPath>
      ))}
    </defs>
  );
});

/**
 * The keys, one per drawn voice. A voice whose values fall outside every lane's axis says so: the
 * domains are fitted to the tone voices, so a noise or water voice holds a key with no curve behind
 * it, and a legend that doesn't admit that is promising a line nobody can find.
 */
const Legend = memo(function Legend({ model }: { model: ChartModel }) {
  return (
    <ul className="schedule-chart__legend">
      {model.voices.map((voice) => {
        const type = VOICE_TYPE_LABELS[voice.type];
        const plotted = isVoicePlotted(model, voice.slot);
        return (
          <li
            key={voice.voiceId}
            className={plotted ? undefined : 'schedule-chart__legend-item--unplotted'}
            title={
              plotted
                ? undefined
                : 'Values fall outside the axes, which are fitted to the tone voices.'
            }
          >
            <span className="schedule-chart__key" style={{ color: seriesColor(voice.slot) }} />
            {voice.label}
            {type && <span className="schedule-chart__type">({type})</span>}
            {!plotted && <span className="schedule-chart__type">· not plotted</span>}
          </li>
        );
      })}
    </ul>
  );
});

function Lane({
  lane,
  layout,
  xTicks,
  grid,
  nodes,
  clipId,
}: {
  lane: LaneLayout;
  layout: ChartLayout;
  xTicks: number[];
  grid: number[];
  nodes: boolean;
  clipId: string;
}) {
  const right = lane.x + lane.width;
  const bottom = lane.y + lane.height;
  const clip = `url(#${clipId}-${lane.model.id})`;

  return (
    <g>
      <text className="schedule-chart__lane-title" x={lane.x} y={lane.y - 7}>
        {lane.model.unit ? `${lane.model.title} (${lane.model.unit})` : lane.model.title}
      </text>

      {lane.model.id === 'beat' && <BandLayer lane={lane} />}

      {grid.map((tick) => {
        const x = layout.timeScale.toPixel(tick);
        return (
          <line
            className="schedule-chart__snap-grid"
            key={tick}
            x1={x}
            y1={lane.y}
            x2={x}
            y2={bottom}
          />
        );
      })}

      {laneTicks(lane).map((tick) => {
        const y = lane.valueScale.toPixel(tick);
        return (
          <g key={tick}>
            <line className="schedule-chart__grid" x1={lane.x} y1={y} x2={right} y2={y} />
            <text className="schedule-chart__tick" x={lane.x - 8} y={y + 4} textAnchor="end">
              {lane.model.format(tick)}
            </text>
          </g>
        );
      })}

      {xTicks.map((tick) => {
        const x = layout.timeScale.toPixel(tick);
        return <line className="schedule-chart__grid" key={tick} x1={x} y1={lane.y} x2={x} y2={bottom} />;
      })}

      <line className="schedule-chart__axis" x1={lane.x} y1={bottom} x2={right} y2={bottom} />

      <g clipPath={clip}>
        {lane.model.series.map((series) => (
          <Series key={series.voiceId} series={series} lane={lane} layout={layout} split={nodes} />
        ))}

        {nodes && lane.model.series.map((series) => (
          <Nodes key={series.voiceId} series={series} lane={lane} layout={layout} />
        ))}
      </g>
    </g>
  );
}

/**
 * A voice's curve in one lane. `split` draws the final segment dashed, because it is not authored
 * — the last entry unconditionally glides back to entry[0]'s values, and the editor is where
 * somebody needs to be told that stretch is generated rather than editable.
 */
function Series({
  series,
  lane,
  layout,
  split,
}: {
  series: VoiceSeries;
  lane: LaneLayout;
  layout: ChartLayout;
  split: boolean;
}) {
  const colour = seriesColor(series.slot);
  const [from, to] = visibleRange(series.points, layout.view);
  const points = series.points.slice(from, to);

  if (!split || series.points.length < 2) {
    return (
      <path
        className="schedule-chart__series"
        d={polylinePath(points, layout.timeScale, lane.valueScale)}
        style={{ stroke: colour }}
      />
    );
  }

  // Where the generated final segment begins, in this slice's own coordinates. Off the end of a
  // window that stops short of the voice, in which case the whole slice is authored curve.
  const cut = series.points.length - 1 - from;
  return (
    <>
      {cut > 0 && (
        <path
          className="schedule-chart__series"
          d={polylinePath(points.slice(0, Math.min(cut, points.length)), layout.timeScale, lane.valueScale)}
          style={{ stroke: colour }}
        />
      )}
      {cut < points.length && (
        <path
          className="schedule-chart__series schedule-chart__series--wrap"
          d={polylinePath(points.slice(Math.max(0, cut - 1)), layout.timeScale, lane.valueScale)}
          style={{ stroke: colour }}
        />
      )}
    </>
  );
}

/**
 * One marker per entry, plus a hollow ring on the derived wrap point. The read-only chart marks
 * only the hovered breakpoint — noise when nodes can't be touched — while the editor draws them
 * all, since they're the thing being touched; the hollow ring distinguishes a derived point from
 * an authored entry.
 */
function Nodes({
  series,
  lane,
  layout,
}: {
  series: VoiceSeries;
  lane: LaneLayout;
  layout: ChartLayout;
}) {
  const colour = seriesColor(series.slot);
  const last = series.points.length - 1;
  const [from, to] = visibleRange(series.points, layout.view);

  return (
    <g>
      {series.points.slice(from, to).map((point, offset) => {
        // The slice keeps each point's own index, since that index is what addresses an entry.
        const index = from + offset;
        return index === last ? (
          <circle
            className="schedule-chart__wrap-node"
            key={index}
            cx={layout.timeScale.toPixel(point.time)}
            cy={lane.valueScale.toPixel(point.value)}
            r={3.5}
            style={{ stroke: colour }}
          >
            <title>Wraps back to the start of the voice — not editable</title>
          </circle>
        ) : (
          <circle
            className="schedule-chart__node"
            key={index}
            cx={layout.timeScale.toPixel(point.time)}
            cy={lane.valueScale.toPixel(point.value)}
            r={3.5}
            style={{ fill: colour }}
          />
        );
      })}
    </g>
  );
}

/**
 * Nodes validation has something to say about. Memoised for the same reason `StaticPlot` is: it's
 * derived from the committed document and must not rebuild on every `pointermove` of an
 * uncommitted drag. The ring is deliberately larger than `SelectionRing`'s and takes no voice
 * colour — a mark is a statement about the value, not the voice it's in.
 */
const IssueMarks = memo(function IssueMarks({
  layout,
  marks,
  clipId,
}: {
  layout: ChartLayout;
  marks: readonly ChartMark[];
  clipId: string;
}) {
  return (
    <g className="schedule-chart__marks">
      {marks.flatMap((mark, index) => {
        // Lanes are collapsible session state, and a warning that disappears because a lane is
        // closed is a warning nobody sees — so a mark with nowhere of its own to go is drawn in
        // every open lane, with the label saying which value is meant.
        const own = layout.lanes.filter((lane) => mark.lanes?.includes(lane.model.id) ?? false);
        const lanes = own.length > 0 ? own : layout.lanes;

        return lanes.flatMap((lane) => {
          const series = lane.model.series.find((s) => s.slot === mark.voice);
          const point: SeriesPoint | undefined = series?.points[mark.entry];
          if (!point) return [];

          return [
            <circle
              key={`${index}-${lane.model.id}`}
              className="schedule-chart__mark"
              clipPath={`url(#${clipId}-${lane.model.id})`}
              cx={layout.timeScale.toPixel(point.time)}
              cy={lane.valueScale.toPixel(point.value)}
              r={9.5}
            >
              <title>{mark.label}</title>
            </circle>,
          ];
        });
      })}
    </g>
  );
});

/**
 * The selection, ringed in every lane each node appears in — one entry, several parameters.
 * `memo`'d for a sharper reason than `IssueMarks`: a marquee can select every node in the document,
 * and this layer sits in the chart's body, which re-renders on every `pointermove` of a drag. The
 * selection can't change mid-gesture, so the memo holds for the whole of one.
 */
const SelectionRing = memo(function SelectionRing({
  layout,
  selected,
  clipId,
}: {
  layout: ChartLayout;
  selected: readonly EntryLocation[];
  clipId: string;
}) {
  return (
    <g className="schedule-chart__selection">
      {selected.flatMap((node) =>
        layout.lanes.flatMap((lane) => {
          const series = lane.model.series.find((s) => s.slot === node.voice);
          const point: SeriesPoint | undefined = series?.points[node.entry];
          if (!series || !point) return [];
          // Off-window nodes are still selected; they simply have nowhere to be drawn.
          if (point.time < layout.view.start || point.time > layout.view.end) return [];

          return [
            <circle
              key={`${node.voice}-${node.entry}-${lane.model.id}`}
              className="schedule-chart__selected"
              clipPath={`url(#${clipId}-${lane.model.id})`}
              cx={layout.timeScale.toPixel(point.time)}
              cy={lane.valueScale.toPixel(point.value)}
              r={7}
              style={{ stroke: seriesColor(series.slot) }}
            />,
          ];
        }),
      )}
    </g>
  );
});

/** EEG band shading behind the beat curve — a neutral alternating wash rather than a hue ramp, so
 *  it reads as context and never competes with the voice colours in front of it. */
function BandLayer({ lane }: { lane: LaneLayout }) {
  const [min, max] = lane.model.domain;

  return (
    <g>
      {EEG_BANDS.map((band, index) => {
        const top = Math.min(band.max, max);
        const bottom = Math.max(band.min, min);
        if (top <= bottom) return null;

        const y = lane.valueScale.toPixel(top);
        const bandHeight = lane.valueScale.toPixel(bottom) - y;

        return (
          <g key={band.name}>
            {index % 2 === 0 && (
              <rect
                className="schedule-chart__band"
                x={lane.x}
                y={y}
                width={lane.width}
                height={bandHeight}
              />
            )}
            {bandHeight >= 14 && (
              <text className="schedule-chart__band-label" x={lane.x + 6} y={y + bandHeight / 2 + 4}>
                {band.name}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function TimeAxis({ layout, xTicks }: { layout: ChartLayout; xTicks: number[] }) {
  const lastLane = layout.lanes[layout.lanes.length - 1];
  const y = lastLane.y + lastLane.height + 16;

  return (
    <g>
      {xTicks.map((tick) => (
        <text
          className="schedule-chart__tick"
          key={tick}
          x={layout.timeScale.toPixel(tick)}
          y={y}
          textAnchor="middle"
        >
          {formatClock(tick)}
        </text>
      ))}
    </g>
  );
}

/**
 * Where the shortest voice ends — the point at which Gnaural resets every voice and the schedule
 * effectively finishes, even though longer voices keep drawing past it.
 */
function TruncationMarker({ layout }: { layout: ChartLayout }) {
  const x = layout.timeScale.toPixel(layout.model.playbackDuration);
  const first = layout.lanes[0];
  const last = layout.lanes[layout.lanes.length - 1];
  // Near the right edge the label would overhang, so flip it to the other side of the rule.
  const flip = x > first.x + first.width - 70;

  return (
    <g>
      <line
        className="schedule-chart__truncation"
        x1={x}
        y1={first.y}
        x2={x}
        y2={last.y + last.height}
      />
      <text
        className="schedule-chart__marker-label"
        x={flip ? x - 5 : x + 5}
        y={first.y + 11}
        textAnchor={flip ? 'end' : 'start'}
      >
        ends {formatClock(layout.model.playbackDuration)}
      </text>
    </g>
  );
}

function Playhead({ layout, x }: { layout: ChartLayout; x: number }) {
  const first = layout.lanes[0];
  const last = layout.lanes[layout.lanes.length - 1];

  return (
    <g>
      <line className="schedule-chart__playhead" x1={x} y1={first.y} x2={x} y2={last.y + last.height} />
      {/* Cap hangs inside the first lane rather than above it, where at t=0 it'd sit on the lane
          title. */}
      <polygon
        className="schedule-chart__playhead-cap"
        points={`${x - 4},${first.y} ${x + 4},${first.y} ${x},${first.y + 7}`}
      />
    </g>
  );
}

function Crosshair({
  layout,
  time,
  x,
  hoveredLane,
  breakpoint,
}: {
  layout: ChartLayout;
  time: number;
  x: number;
  hoveredLane: LaneLayout | undefined;
  breakpoint: BreakpointHit | null;
}) {
  const first = layout.lanes[0];
  const last = layout.lanes[layout.lanes.length - 1];

  return (
    <g>
      <line
        className="schedule-chart__crosshair"
        x1={x}
        y1={first.y}
        x2={x}
        y2={last.y + last.height}
      />

      {layout.lanes.map((lane) =>
        lane.model.series.map((series) => {
          const value = seriesValueAt(series, time);
          if (value === null) return null;
          return (
            <circle
              className="schedule-chart__dot"
              key={`${lane.model.id}-${series.voiceId}`}
              cx={x}
              cy={lane.valueScale.toPixel(value)}
              r={4}
              style={{ fill: seriesColor(series.slot) }}
            />
          );
        }),
      )}

      {breakpoint && hoveredLane && (
        <circle
          className="schedule-chart__breakpoint"
          cx={layout.timeScale.toPixel(breakpoint.point.time)}
          cy={hoveredLane.valueScale.toPixel(breakpoint.point.value)}
          r={5}
          style={{ stroke: seriesColor(breakpoint.series.slot) }}
        />
      )}
    </g>
  );
}

function Tooltip({ layout, time, x }: { layout: ChartLayout; time: number; x: number }) {
  const single = layout.model.voices.length === 1;
  // Flip to the pointer's left near the right edge so the panel never overflows the container.
  const flip = x > layout.width / 2;

  return (
    <div
      className="schedule-chart__tooltip"
      style={flip ? { right: layout.width - x + 12 } : { left: x + 12 }}
    >
      <div className="schedule-chart__tooltip-time">{formatClock(time)}</div>
      {layout.lanes.map((lane) => (
        <div key={lane.model.id}>
          <div className="schedule-chart__tooltip-label">{lane.model.title}</div>
          {lane.model.series.map((series) => {
            const value = seriesValueAt(series, time);
            return (
              <div className="schedule-chart__tooltip-row" key={series.voiceId}>
                <span className="schedule-chart__tooltip-value">
                  {value === null ? '—' : `${lane.model.format(value)} ${lane.model.unit}`.trim()}
                </span>
                {!single && (
                  <>
                    <span
                      className="schedule-chart__key"
                      style={{ color: seriesColor(series.slot) }}
                    />
                    <span className="schedule-chart__tooltip-label">{series.label}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
