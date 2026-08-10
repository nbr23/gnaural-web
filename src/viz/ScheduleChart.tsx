import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatClock, formatHz } from '../app/format';
import type { Schedule } from '../document/types';
import { VoiceType } from '../document/types';
import { EEG_BANDS } from './bands';
import type { BreakpointHit, ChartLayout, LaneId, LaneLayout, VoiceIdentity } from './geometry';
import {
  DEFAULT_LANES,
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
   */
  onSeek?: (time: number) => void;
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
  className,
}: ScheduleChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const model = useMemo(() => buildChartModel(schedule, lanes), [schedule, lanes]);
  const layout = useMemo(
    () => (width > 0 ? layoutChart(model, width, height) : null),
    [model, width, height],
  );

  const scrubbing = useRef(false);

  const pointerPosition = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg || !layout) return null;

      // Scale client coordinates into the SVG's own system, so hit-testing stays correct even if
      // CSS ever renders the element at a different size than its width attribute.
      const rect = svg.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (layout.width / rect.width),
        y: (event.clientY - rect.top) * (layout.height / rect.height),
      };
    },
    [layout],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const position = pointerPosition(event);
      if (!position || !layout) return;

      const time = timeAtPixel(layout, position.x);
      setHover({ time, pixelY: position.y });
      if (scrubbing.current) onSeek?.(time);
    },
    [layout, onSeek, pointerPosition],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const position = pointerPosition(event);
      if (!onSeek || !position || !layout) return;

      scrubbing.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      onSeek(timeAtPixel(layout, position.x));
    },
    [layout, onSeek, pointerPosition],
  );

  const endScrub = useCallback(() => {
    scrubbing.current = false;
  }, []);

  const stepHover = useCallback(
    (event: ReactKeyboardEvent<SVGSVGElement>) => {
      if (!layout) return;
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
    [layout, hover],
  );

  if (model.voices.length === 0) {
    return (
      <div className={containerClass(className)} ref={containerRef}>
        <p className="schedule-chart__empty">This schedule has no visible voices to plot.</p>
      </div>
    );
  }

  if (!layout) {
    // First paint, before the container has been measured. Reserve the height so nothing jumps.
    return <div className={containerClass(className)} ref={containerRef} style={{ height }} />;
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
  const xTicks = timeTicks(layout.model.duration, Math.max(3, Math.round(width / PX_PER_TIME_TICK)));

  return (
    <div className={containerClass(className)} ref={containerRef}>
      {model.voices.length > 1 && <Legend voices={model.voices} />}

      <svg
        ref={svgRef}
        className="schedule-chart__plot"
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={chartLabel(schedule, model.voices.length, model.duration)}
        tabIndex={0}
        style={onSeek ? { cursor: 'pointer' } : undefined}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={endScrub}
        onLostPointerCapture={endScrub}
        onPointerLeave={() => {
          endScrub();
          setHover(null);
        }}
        onKeyDown={stepHover}
        onBlur={() => setHover(null)}
      >
        {layout.lanes.map((lane) => (
          <Lane key={lane.model.id} lane={lane} layout={layout} xTicks={xTicks} />
        ))}

        <TimeAxis layout={layout} xTicks={xTicks} />

        {model.truncated && <TruncationMarker layout={layout} />}

        {hover && hoverX !== null && (
          <Crosshair
            layout={layout}
            time={hover.time}
            x={hoverX}
            hoveredLane={hoveredLane}
            breakpoint={hoveredBreakpoint}
          />
        )}

        {currentTime !== undefined && currentTime >= 0 && currentTime <= model.duration && (
          <Playhead layout={layout} x={layout.timeScale.toPixel(currentTime)} />
        )}
      </svg>

      {hover && hoverX !== null && <Tooltip layout={layout} time={hover.time} x={hoverX} />}
    </div>
  );
}

function containerClass(className: string | undefined): string {
  return className ? `schedule-chart ${className}` : 'schedule-chart';
}

function chartLabel(schedule: Schedule, voiceCount: number, duration: number): string {
  const name = schedule.title.trim() || 'Untitled schedule';
  const voices = `${voiceCount} voice${voiceCount === 1 ? '' : 's'}`;
  return `Beat and base frequency over time for ${name} — ${voices}, ${formatClock(duration)} long.`;
}

function Legend({ voices }: { voices: VoiceIdentity[] }) {
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
}

function Lane({ lane, layout, xTicks }: { lane: LaneLayout; layout: ChartLayout; xTicks: number[] }) {
  const right = lane.x + lane.width;
  const bottom = lane.y + lane.height;

  return (
    <g>
      <text className="schedule-chart__lane-title" x={lane.x} y={lane.y - 7}>
        {lane.model.title} ({lane.model.unit})
      </text>

      {lane.model.id === 'beat' && <BandLayer lane={lane} />}

      {laneTicks(lane).map((tick) => {
        const y = lane.valueScale.toPixel(tick);
        return (
          <g key={tick}>
            <line className="schedule-chart__grid" x1={lane.x} y1={y} x2={right} y2={y} />
            <text className="schedule-chart__tick" x={lane.x - 8} y={y + 4} textAnchor="end">
              {formatHz(tick)}
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
        <path
          key={series.voiceId}
          className="schedule-chart__series"
          d={polylinePath(series.points, layout.timeScale, lane.valueScale)}
          style={{ stroke: seriesColor(series.slot) }}
        />
      ))}
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
                  {value === null ? '—' : `${formatHz(value)} ${lane.model.unit}`}
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
