import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatClock } from '../app/format';
import type { Schedule } from '../document/types';
import { VoiceType } from '../document/types';
import { EEG_BANDS } from './bands';
import type {
  BreakpointHit,
  ChartLayout,
  ChartMark,
  LaneId,
  LaneLayout,
  SeriesPoint,
  VoiceIdentity,
  VoiceSeries,
} from './geometry';
import {
  DEFAULT_LANES,
  DOMAIN_PADDING,
  buildChartModel,
  layoutChart,
  nearestBreakpoint,
  polylinePath,
  seriesValueAt,
  timeAtPixel,
} from './geometry';
import { seriesColor } from './palette';
import { niceTicks, timeTicks } from './scales';
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
 * Turns the read-only plot into §6.1's editing surface, without teaching it what a document edit is.
 *
 * The chart resolves pointer coordinates, hit-tests, and draws the nodes; the caller decides what a
 * grab means and draws the moving part into `overlay`. **The caller must not push its in-flight
 * document back in through `schedule`** — that would invalidate `buildChartModel`, `layoutChart`
 * and `StaticPlot` on every `pointermove`, which is the measured defect those memos exist to
 * prevent. During a gesture `schedule` holds still and the overlay is what moves.
 */
export interface ChartInteraction {
  /** Wider than the read-only default, so a value drag can reach past the data. */
  domainPadding?: number;
  /** Drawn with a ring. Addressed the way the document is (§3.4): indices, not ids. */
  selected?: { voice: number; entry: number } | null;
  /** A gesture is in flight: the static curves become a ghost and the crosshair gets out of the way. */
  dragging?: boolean;
  /**
   * Nodes to mark as needing attention. **Must be identity-stable while a gesture runs** — they are
   * drawn by a `memo`'d layer, exactly like `StaticPlot`, so a fresh array per `pointermove` would
   * rebuild them per move for a document that has not changed.
   */
  marks?: readonly ChartMark[];
  /** Rendered above the static plot in the layout's pixel space. Keep it O(1) — it runs per move. */
  overlay?(layout: ChartLayout): ReactNode;
  onPointerDown?(pointer: ChartPointer): void;
  onPointerMove?(pointer: ChartPointer): void;
  onPointerUp?(pointer: ChartPointer): void;
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
  /**
   * Seek handler. When supplied the plot becomes draggable to scrub — transport, not document
   * editing, so the component stays read-only in the sense Phase 1 cares about.
   *
   * Ignored when `interaction` is supplied: there the same pointer has to select and drag, and a
   * gesture cannot be both. See `EditSurface`, which seeks on a miss and reserves the drag.
   */
  onSeek?: (time: number) => void;
  /** Supply this and the plot becomes editable. Absent, the component is exactly what it was. */
  interaction?: ChartInteraction;
  className?: string;
}

/** Pointer radius within which an authored breakpoint is highlighted (a >= 24px hit target). */
const BREAKPOINT_HIT_RADIUS = 12;
const DEFAULT_HEIGHT = 280;
/** Roughly one time label per this many pixels, so narrow phones don't collide their labels. */
const PX_PER_TIME_TICK = 110;

const VOICE_TYPE_LABELS: Partial<Record<VoiceType, string>> = {
  [VoiceType.PinkNoise]: 'noise',
  [VoiceType.Pcm]: 'external audio',
  [VoiceType.IsoPulse]: 'isochronic',
  [VoiceType.IsoPulseAlt]: 'isochronic',
  [VoiceType.WaterDrops]: 'water drops',
  [VoiceType.Rain]: 'rain',
};

/**
 * Y-axis positions for a lane. The beat lane reads against the EEG bands it is shaded with
 * (PLAN.md §1) rather than arbitrary round numbers — those boundaries are what the value means.
 */
function laneTicks(lane: LaneLayout): number[] {
  const [min, max] = lane.model.domain;
  if (lane.model.id === 'beat') {
    const edges = [...new Set(EEG_BANDS.flatMap((band) => [band.min, band.max]))].filter(
      (hz) => hz > min && hz < max,
    );
    if (edges.length >= 2) return edges;
  }
  return niceTicks(lane.model.domain, 4).filter((tick) => tick >= min && tick <= max);
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
 * Beat (0.5-30 Hz) and base (100-400 Hz) get their own lanes on a shared time axis rather than
 * two y-scales on one plot: a dual-axis chart implies a correlation that isn't in the data, and
 * stacked lanes are already the shape PLAN.md §6.1 specifies for the editor.
 *
 * The component owns no audio and no clock. `currentTime` is a plain number supplied by the
 * caller, which polls `PlaybackEngine.getCurrentOffset()` itself — PLAN.md §4: the UI observes
 * the engine's clock and never drives it, and no component lifecycle hook touches audio
 * resources. Geometry is memoised so a 60fps `currentTime` only moves the playhead.
 *
 * Phase 1 makes this same view interactive; the geometry, scales, and hit-testing it will need
 * live in `geometry.ts` / `scales.ts` and are renderer-agnostic (§6.2).
 */
export function ScheduleChart({
  schedule,
  currentTime,
  lanes = DEFAULT_LANES,
  height = DEFAULT_HEIGHT,
  onSeek,
  interaction,
  className,
}: ScheduleChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const editing = interaction !== undefined;
  const padding = interaction?.domainPadding ?? DOMAIN_PADDING;
  const model = useMemo(
    () => buildChartModel(schedule, lanes, padding),
    [schedule, lanes, padding],
  );
  const layout = useMemo(
    () => (width > 0 ? layoutChart(model, width, height) : null),
    [model, width, height],
  );

  const xTicks = useMemo(
    () =>
      layout
        ? timeTicks(layout.model.duration, Math.max(3, Math.round(width / PX_PER_TIME_TICK)))
        : [],
    [layout, width],
  );

  const scrubbing = useRef(false);

  const pointerPosition = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg || !layout) return null;

      // Scale client coordinates into the SVG's own system, so hit-testing stays correct even if
      // CSS ever renders the element at a different size than its width attribute. A rect with no
      // extent — a detached or hidden element, and every element under a DOM with no layout engine
      // — scales 1:1 rather than dividing by zero.
      const rect = svg.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (rect.width > 0 ? layout.width / rect.width : 1),
        y: (event.clientY - rect.top) * (rect.height > 0 ? layout.height / rect.height : 1),
      };
    },
    [layout],
  );

  /** Resolve a raw pointer event into what the caller decides on: a lane, a time, and a node. */
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

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (interaction) {
        const pointer = resolvePointer(event);
        if (pointer) interaction.onPointerMove?.(pointer);
        return;
      }

      const position = pointerPosition(event);
      if (!position || !layout) return;

      const time = timeAtPixel(layout, position.x);
      setHover({ time, pixelY: position.y });
      if (scrubbing.current) onSeek?.(time);
    },
    [interaction, layout, onSeek, pointerPosition, resolvePointer],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (interaction) {
        const pointer = resolvePointer(event);
        if (!pointer) return;
        // Captured unconditionally: a finger that leaves the plot mid-drag must still finish its
        // gesture, and a miss releases it on the pointerup that follows.
        event.currentTarget.setPointerCapture(event.pointerId);
        interaction.onPointerDown?.(pointer);
        return;
      }

      const position = pointerPosition(event);
      if (!onSeek || !position || !layout) return;

      scrubbing.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      onSeek(timeAtPixel(layout, position.x));
    },
    [interaction, layout, onSeek, pointerPosition, resolvePointer],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (interaction) {
        const pointer = resolvePointer(event);
        if (pointer) interaction.onPointerUp?.(pointer);
        return;
      }
      scrubbing.current = false;
    },
    [interaction, resolvePointer],
  );

  const endScrub = useCallback(() => {
    scrubbing.current = false;
  }, []);

  const stepHover = useCallback(
    (event: ReactKeyboardEvent<SVGSVGElement>) => {
      if (!layout) return;
      // An editing caller gets first refusal on every key: with a node selected the arrows move
      // between nodes, and only what it does not claim falls through to the crosshair readout.
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
          setHover(null);
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
    // First paint, before the container has been measured. Reserve the height so nothing jumps.
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
      {model.voices.length > 1 && <Legend voices={model.voices} />}

      <svg
        ref={svgRef}
        className="schedule-chart__plot"
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={chartLabel(schedule, model.voices.length, model.duration)}
        tabIndex={0}
        style={onSeek && !editing ? { cursor: 'pointer' } : undefined}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={endScrub}
        onPointerLeave={() => {
          endScrub();
          setHover(null);
        }}
        onKeyDown={stepHover}
        onBlur={() => setHover(null)}
      >
        <StaticPlot layout={layout} xTicks={xTicks} nodes={editing} />

        {interaction?.marks && interaction.marks.length > 0 && (
          <IssueMarks layout={layout} marks={interaction.marks} />
        )}

        {interaction?.selected && <SelectionRing layout={layout} selected={interaction.selected} />}

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

        {currentTime !== undefined && currentTime >= 0 && currentTime <= model.duration && (
          <Playhead layout={layout} x={layout.timeScale.toPixel(currentTime)} />
        )}
      </svg>

      {showCrosshair && <Tooltip layout={layout} time={hover.time} x={hoverX} />}
    </div>
  );
}

function containerClass(className: string | undefined, editing: boolean, dragging: boolean): string {
  const names = ['schedule-chart'];
  // `touch-action: none` hangs off this one: without it a phone pans the page instead of
  // delivering `pointermove`, and the drag never happens at all.
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
 * Everything in the plot that does not move: lanes, band shading, grid, curves, axis.
 *
 * **Memoised on the layout alone**, which is what keeps an advancing playhead from rebuilding it.
 * Without this, every tick of the clock re-ran `polylinePath` over every breakpoint of every voice
 * — 77 of them per voice in `oobe-lucid-dreams-2` — and rebuilt two lanes of ticks and band
 * shading, on the same thread the audio graph is competing for. On a phone that is enough garbage
 * per second to make playback crackle; see PROGRESS.md.
 */
const StaticPlot = memo(function StaticPlot({
  layout,
  xTicks,
  nodes,
}: {
  layout: ChartLayout;
  xTicks: number[];
  /** Draw a marker on every entry. Editing only — see the note on "deliberately not drawn" below. */
  nodes: boolean;
}) {
  return (
    <>
      {layout.lanes.map((lane) => (
        <Lane key={lane.model.id} lane={lane} layout={layout} xTicks={xTicks} nodes={nodes} />
      ))}

      <TimeAxis layout={layout} xTicks={xTicks} />

      {layout.model.truncated && <TruncationMarker layout={layout} />}
    </>
  );
});

const Legend = memo(function Legend({ voices }: { voices: VoiceIdentity[] }) {
  return (
    <ul className="schedule-chart__legend">
      {voices.map((voice) => {
        const type = VOICE_TYPE_LABELS[voice.type];
        return (
          <li key={voice.voiceId}>
            <span className="schedule-chart__key" style={{ color: seriesColor(voice.slot) }} />
            {voice.label}
            {type && <span className="schedule-chart__type">({type})</span>}
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
  nodes,
}: {
  lane: LaneLayout;
  layout: ChartLayout;
  xTicks: number[];
  nodes: boolean;
}) {
  const right = lane.x + lane.width;
  const bottom = lane.y + lane.height;

  return (
    <g>
      <text className="schedule-chart__lane-title" x={lane.x} y={lane.y - 7}>
        {lane.model.unit ? `${lane.model.title} (${lane.model.unit})` : lane.model.title}
      </text>

      {lane.model.id === 'beat' && <BandLayer lane={lane} />}

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

      {lane.model.series.map((series) => (
        <Series key={series.voiceId} series={series} lane={lane} layout={layout} split={nodes} />
      ))}

      {nodes && lane.model.series.map((series) => (
        <Nodes key={series.voiceId} series={series} lane={lane} layout={layout} />
      ))}
    </g>
  );
}

/**
 * A voice's curve in one lane.
 *
 * `split` draws the final segment dashed, because it is not authored: §3.5's unconditional wrap
 * makes the last entry glide back to entry[0]'s values whether or not the schedule loops, and the
 * editor is where somebody needs to be told that the stretch they cannot edit is generated. The
 * read-only chart keeps drawing one continuous line, which is the truth about what is heard.
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
  if (!split || series.points.length < 2) {
    return (
      <path
        className="schedule-chart__series"
        d={polylinePath(series.points, layout.timeScale, lane.valueScale)}
        style={{ stroke: colour }}
      />
    );
  }

  const cut = series.points.length - 1;
  return (
    <>
      <path
        className="schedule-chart__series"
        d={polylinePath(series.points.slice(0, cut), layout.timeScale, lane.valueScale)}
        style={{ stroke: colour }}
      />
      <path
        className="schedule-chart__series schedule-chart__series--wrap"
        d={polylinePath(series.points.slice(cut - 1), layout.timeScale, lane.valueScale)}
        style={{ stroke: colour }}
      />
    </>
  );
}

/**
 * One marker per entry, plus a hollow ring on §3.5's wrap point.
 *
 * The read-only chart deliberately marks only the hovered breakpoint — `airplanetravelaid` has 45
 * entries in one voice and marking all of them is noise when none of them can be touched. In the
 * editor they are the thing being touched, so they are all drawn, and the difference between a
 * filled node and the hollow ring is the difference between an entry and a derived point.
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

  return (
    <g>
      {series.points.map((point, index) =>
        index === last ? (
          <circle
            className="schedule-chart__wrap-node"
            key={index}
            cx={layout.timeScale.toPixel(point.time)}
            cy={lane.valueScale.toPixel(point.value)}
            r={3.5}
            style={{ stroke: colour }}
          >
            <title>Wraps back to the start of the voice (§3.5) — not editable</title>
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
        ),
      )}
    </g>
  );
}

/**
 * Nodes §6.1's validation has something to say about.
 *
 * **Memoised for the same reason `StaticPlot` is**, and on the same terms: it is derived from the
 * committed document, so it must not be rebuilt on every `pointermove` of a drag that has not
 * committed anything. The ring is deliberately larger than `SelectionRing`'s and takes no voice
 * colour — a mark is a statement about the value, not another way of saying which voice it is in.
 */
const IssueMarks = memo(function IssueMarks({
  layout,
  marks,
}: {
  layout: ChartLayout;
  marks: readonly ChartMark[];
}) {
  return (
    <g className="schedule-chart__marks">
      {marks.flatMap((mark, index) => {
        // A mark belongs to the lane its rule is about — but lanes are collapsible session state,
        // and a warning that disappears because the volume lanes happen to be closed is a warning
        // nobody sees. So a mark with nowhere of its own to go is drawn in every open lane; the
        // node is the same node in all of them, and the label says which value is meant.
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

/** The selected node, marked in every lane it appears in — one entry, several parameters. */
function SelectionRing({
  layout,
  selected,
}: {
  layout: ChartLayout;
  selected: { voice: number; entry: number };
}) {
  return (
    <g className="schedule-chart__selection">
      {layout.lanes.map((lane) => {
        const series = lane.model.series.find((s) => s.slot === selected.voice);
        const point: SeriesPoint | undefined = series?.points[selected.entry];
        if (!series || !point) return null;
        return (
          <circle
            key={lane.model.id}
            className="schedule-chart__selected"
            cx={layout.timeScale.toPixel(point.time)}
            cy={lane.valueScale.toPixel(point.value)}
            r={7}
            style={{ stroke: seriesColor(series.slot) }}
          />
        );
      })}
    </g>
  );
}

/**
 * EEG band shading behind the beat curve. Deliberately a neutral alternating wash rather than a
 * hue ramp — it must read as context and never compete with the voice colours in front of it.
 */
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
 * effectively finishes, even though longer voices keep drawing past it (§3.7).
 */
function TruncationMarker({ layout }: { layout: ChartLayout }) {
  const x = layout.timeScale.toPixel(layout.model.playbackDuration);
  const first = layout.lanes[0];
  const last = layout.lanes[layout.lanes.length - 1];
  // Near the right edge the label would overhang, so hang it off the other side of the rule.
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
      {/* Cap hangs inside the first lane rather than above it, where at t=0 it would sit on the
          lane title. */}
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
