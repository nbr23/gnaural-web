import { describe, expect, it } from 'vitest';
import { parseSchedule } from '../document/parser';
import { loadFixture } from '../document/test-fixtures';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import {
  MIN_VIEW_SECONDS,
  buildChartModel,
  clampView,
  drawnDuration,
  layoutChart,
  nearestBreakpoint,
  nodesInRect,
  panView,
  polylinePath,
  seriesValueAt,
  timeAtPixel,
  visibleRange,
  zoomFactor,
  zoomView,
} from './geometry';

function makeEntry(partial: Partial<Entry>): Entry {
  return { duration: 0, baseFreq: 0, beatFreq: 0, volumeLeft: 1, volumeRight: 1, preserved: {}, ...partial };
}

function makeVoice(partial: Partial<Voice>): Voice {
  return {
    id: 0,
    description: '',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries: [],
    preserved: {},
    ...partial,
  };
}

function makeSchedule(voices: Voice[]): Schedule {
  return {
    title: 'Test',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices,
    preserved: {},
  };
}

const twoEntryVoice = makeVoice({
  id: 0,
  description: 'Glide',
  entries: [
    makeEntry({ duration: 10, baseFreq: 200, beatFreq: 10 }),
    makeEntry({ duration: 10, baseFreq: 100, beatFreq: 4 }),
  ],
});

describe('buildChartModel', () => {
  it('recovers base and beat frequency from the compiled channel pair', () => {
    const { lanes } = buildChartModel(makeSchedule([twoEntryVoice]));
    const [beat, base] = lanes;

    expect(beat.series[0].points.slice(0, 2)).toEqual([
      { time: 0, value: 10 },
      { time: 10, value: 4 },
    ]);
    expect(base.series[0].points.slice(0, 2)).toEqual([
      { time: 0, value: 200 },
      { time: 10, value: 100 },
    ]);
  });

  it('plots the unconditional wrap back to entry[0] over the final segment (§3.5)', () => {
    const { lanes, duration } = buildChartModel(makeSchedule([twoEntryVoice]));
    const points = lanes[0].series[0].points;

    expect(duration).toBe(20);
    expect(points).toHaveLength(3);
    expect(points[2]).toEqual({ time: 20, value: 10 });
  });

  it('gives each voice its own true length rather than padding to a common one (§3.7)', () => {
    const short = makeVoice({ id: 1, entries: [makeEntry({ duration: 5, baseFreq: 150, beatFreq: 6 })] });
    const model = buildChartModel(makeSchedule([twoEntryVoice, short]));

    expect(model.voices.map((v) => v.duration)).toEqual([20, 5]);
    expect(model.duration).toBe(20);
    expect(model.playbackDuration).toBe(5);
    expect(model.truncated).toBe(true);
  });

  it('does not flag truncation when voices agree within a rounding error', () => {
    const other = makeVoice({
      id: 1,
      entries: [
        makeEntry({ duration: 10, baseFreq: 150, beatFreq: 6 }),
        makeEntry({ duration: 10.001, baseFreq: 150, beatFreq: 6 }),
      ],
    });
    expect(buildChartModel(makeSchedule([twoEntryVoice, other])).truncated).toBe(false);
  });

  it('omits hidden voices but keeps the palette slots of the ones that remain', () => {
    const hidden = makeVoice({ id: 1, hidden: true, entries: [makeEntry({ duration: 5, baseFreq: 100 })] });
    const third = makeVoice({ id: 2, entries: [makeEntry({ duration: 5, baseFreq: 100 })] });
    const model = buildChartModel(makeSchedule([twoEntryVoice, hidden, third]));

    expect(model.voices.map((v) => v.voiceId)).toEqual([0, 2]);
    // Slot follows position in the schedule, so hiding a voice never repaints the survivors.
    expect(model.voices.map((v) => v.slot)).toEqual([0, 2]);
  });

  it('keeps non-binaural voices, whose entries are still real document values', () => {
    const noise = makeVoice({ id: 1, type: VoiceType.PinkNoise, entries: [makeEntry({ duration: 20, baseFreq: 100 })] });
    const model = buildChartModel(makeSchedule([twoEntryVoice, noise]));

    expect(model.voices.map((v) => v.type)).toEqual([VoiceType.Binaural, VoiceType.PinkNoise]);
  });

  it('skips voices with no entries', () => {
    const model = buildChartModel(makeSchedule([twoEntryVoice, makeVoice({ id: 1 })]));
    expect(model.voices).toHaveLength(1);
  });

  it('labels an undescribed voice by id', () => {
    const model = buildChartModel(makeSchedule([makeVoice({ id: 7, entries: [makeEntry({ duration: 1 })] })]));
    expect(model.voices[0].label).toBe('Voice 7');
  });

  it('pads the value domain and never drops below zero', () => {
    const { lanes } = buildChartModel(makeSchedule([twoEntryVoice]));
    const [min, max] = lanes[0].domain;

    expect(min).toBeGreaterThanOrEqual(0);
    expect(min).toBeLessThan(4);
    expect(max).toBeGreaterThan(10);
  });

  it('honours the requested lane order', () => {
    const { lanes } = buildChartModel(makeSchedule([twoEntryVoice]), ['base', 'beat']);
    expect(lanes.map((lane) => lane.id)).toEqual(['base', 'beat']);
  });
});

describe('buildChartModel on the powernap fixture', () => {
  const schedule = parseSchedule(loadFixture('powernap.gnaural'));
  const model = buildChartModel(schedule);

  it('plots the one real voice, not the three the header declares (§3.4)', () => {
    expect(model.voices).toHaveLength(1);
    expect(model.truncated).toBe(false);
  });

  it('matches the fixture: 164 Hz base at both ends, 11 -> 4 Hz beat glide', () => {
    const [beat, base] = model.lanes;
    const beatValues = beat.series[0].points.map((p) => p.value);
    const baseValues = base.series[0].points.map((p) => p.value);

    // The voice's own description is "164 to 110"; PLAN.md §8's summary table says 164->153,
    // which is the shallowest point of the descent rather than its floor.
    expect(baseValues[0]).toBeCloseTo(164, 6);
    expect(baseValues[baseValues.length - 1]).toBeCloseTo(164, 6);
    expect(Math.min(...baseValues)).toBeCloseTo(110, 6);
    expect(Math.max(...beatValues)).toBeCloseTo(11, 0);
    expect(Math.min(...beatValues)).toBeCloseTo(4, 0);
    // PLAN.md §8 says these durations sum to 1200.02; they sum to exactly 1200.
    expect(model.duration).toBeCloseTo(1200, 6);
  });
});

describe('seriesValueAt', () => {
  const series = buildChartModel(makeSchedule([twoEntryVoice])).lanes[0].series[0];

  it('interpolates linearly between breakpoints (§3.5)', () => {
    expect(seriesValueAt(series, 5)).toBeCloseTo(7);
    expect(seriesValueAt(series, 15)).toBeCloseTo(7);
  });

  it('returns the breakpoint value exactly at a breakpoint', () => {
    expect(seriesValueAt(series, 10)).toBe(4);
  });

  it('returns null once the voice has ended, rather than clamping', () => {
    expect(seriesValueAt(series, 20.5)).toBeNull();
    expect(seriesValueAt(series, -1)).toBeNull();
  });
});

describe('layout and hit-testing', () => {
  const model = buildChartModel(makeSchedule([twoEntryVoice]));
  const layout = layoutChart(model, 640, 280);

  it('stacks the lanes without overlap and leaves room for the time axis', () => {
    const [beat, base] = layout.lanes;

    expect(beat.y + beat.height).toBeLessThanOrEqual(base.y);
    expect(base.y + base.height).toBeLessThan(280);
    expect(layout.lanes.every((lane) => lane.height > 0 && lane.width > 0)).toBe(true);
  });

  it('inverts the value scale so larger frequencies sit higher', () => {
    const beat = layout.lanes[0];
    expect(beat.valueScale.toPixel(10)).toBeLessThan(beat.valueScale.toPixel(4));
  });

  it('round-trips a schedule time through the shared time scale', () => {
    expect(timeAtPixel(layout, layout.timeScale.toPixel(12.5))).toBeCloseTo(12.5, 9);
  });

  it('clamps a pixel outside the plot to the drawn extent', () => {
    expect(timeAtPixel(layout, -500)).toBe(0);
    expect(timeAtPixel(layout, 5000)).toBe(20);
  });

  it('survives a container too small to lay out properly', () => {
    const tiny = layoutChart(model, 10, 10);
    expect(tiny.lanes.every((lane) => lane.height > 0 && lane.width > 0)).toBe(true);
    expect(tiny.lanes.every((lane) => Number.isFinite(lane.valueScale.toPixel(5)))).toBe(true);
  });

  it('finds the breakpoint nearest a pixel position', () => {
    const beat = layout.lanes[0];
    const x = layout.timeScale.toPixel(10);
    const y = beat.valueScale.toPixel(4);

    const hit = nearestBreakpoint(beat, layout.timeScale, x + 3, y + 3, 12);
    expect(hit?.index).toBe(1);
    expect(hit?.point).toEqual({ time: 10, value: 4 });
    expect(hit?.series.voiceId).toBe(0);
  });

  it('returns nothing when no breakpoint is within range', () => {
    const beat = layout.lanes[0];
    const x = layout.timeScale.toPixel(5);
    const y = beat.valueScale.toPixel(7);
    expect(nearestBreakpoint(beat, layout.timeScale, x, y, 4)).toBeNull();
  });
});

describe('polylinePath', () => {
  it('emits one move and one line per breakpoint', () => {
    const model = buildChartModel(makeSchedule([twoEntryVoice]));
    const layout = layoutChart(model, 640, 280);
    const beat = layout.lanes[0];
    const path = polylinePath(beat.model.series[0].points, layout.timeScale, beat.valueScale);

    expect(path.startsWith('M')).toBe(true);
    expect(path.match(/L/g)).toHaveLength(2);
    expect(path).not.toMatch(/NaN/);
  });

  it('produces an empty string for an empty series', () => {
    const model = buildChartModel(makeSchedule([twoEntryVoice]));
    const layout = layoutChart(model, 640, 280);
    expect(polylinePath([], layout.timeScale, layout.lanes[0].valueScale)).toBe('');
  });
});

describe('the volume lanes (§6.1)', () => {
  const voice = makeVoice({
    id: 0,
    entries: [
      makeEntry({ duration: 10, baseFreq: 200, beatFreq: 8, volumeLeft: 0.5, volumeRight: 0.2 }),
      makeEntry({ duration: 10, baseFreq: 200, beatFreq: 8, volumeLeft: 0.52, volumeRight: 0.2 }),
    ],
  });

  it('plots each channel separately, from the compiled gains', () => {
    const { lanes } = buildChartModel(makeSchedule([voice]), ['volumeLeft', 'volumeRight']);

    expect(lanes[0].series[0].points.slice(0, 2).map((p) => p.value)).toEqual([0.5, 0.52]);
    expect(lanes[1].series[0].points.slice(0, 2).map((p) => p.value)).toEqual([0.2, 0.2]);
  });

  /**
   * Volume is bounded and its endpoints mean something, unlike a frequency. Fitted to its data, the
   * 0.50–0.52 curve above would read as a dramatic swing and the 0.2 curve would look identical to
   * it — and across all 19 bundled programs, all 354 entries, volume left and right are equal, so
   * two fitted lanes would routinely disagree about a picture of the same numbers.
   */
  it('is a fixed 0-1 domain rather than one fitted to the data', () => {
    const { lanes } = buildChartModel(makeSchedule([voice]), ['volumeLeft', 'volumeRight']);
    expect(lanes[0].domain).toEqual([0, 1]);
    expect(lanes[1].domain).toEqual([0, 1]);
  });

  /** §3.4: real files are dirty, and an out-of-range volume has to be visibly out of range. */
  it('grows above 1 rather than clamping a value the file actually carries', () => {
    const loud = makeVoice({
      id: 0,
      entries: [makeEntry({ duration: 10, volumeLeft: 1.4, volumeRight: 1 })],
    });
    const { lanes } = buildChartModel(makeSchedule([loud]), ['volumeLeft']);

    expect(lanes[0].domain[0]).toBe(0);
    expect(lanes[0].domain[1]).toBeGreaterThan(1.4);
  });

  it('formats a fraction as a fraction and a frequency as Hz', () => {
    const { lanes } = buildChartModel(makeSchedule([voice]), ['beat', 'volumeLeft']);
    expect(lanes[0].format(8)).toBe('8');
    expect(lanes[0].unit).toBe('Hz');
    expect(lanes[1].format(0.5)).toBe('0.50');
    expect(lanes[1].unit).toBe('');
  });
});

describe('hit-testing for the editor', () => {
  const layout = layoutChart(buildChartModel(makeSchedule([twoEntryVoice])), 640, 280);
  const beat = layout.lanes[0];
  const points = beat.model.series[0].points;

  function hitAt(index: number, entriesOnly: boolean) {
    const point = points[index];
    return nearestBreakpoint(
      beat,
      layout.timeScale,
      layout.timeScale.toPixel(point.time),
      beat.valueScale.toPixel(point.value),
      12,
      entriesOnly,
    );
  }

  it('reports the voice and entry a document edit would address', () => {
    const hit = hitAt(1, true);
    // Keyed by index into `schedule.voices`, since §3.4's ids are not unique.
    expect(hit?.voice).toBe(0);
    expect(hit?.entry).toBe(1);
  });

  /**
   * `compileVoice` emits one event per entry plus §3.5's unconditional wrap, so the final point is
   * derived: its value is entry[0]'s and its time is the sum of the durations. The read-only chart
   * still highlights it on hover; the editor excludes it, so a pointer there is an ordinary miss
   * rather than a tap on something that cannot move.
   */
  it('marks the wrap point as no entry, and excludes it when asked', () => {
    const terminal = points.length - 1;
    expect(hitAt(terminal, false)?.entry).toBeNull();
    expect(hitAt(terminal, false)?.index).toBe(terminal);
    expect(hitAt(terminal, true)).toBeNull();
  });
});

/**
 * §6.1's zoom and pan, as arithmetic on a window rather than as a redraw.
 *
 * The window lives on the *layout*, so the compiled model above it is untouched by a zoom — which
 * is the whole reason a zoom does not recompile every voice. What it does still cost is a React
 * rebuild of the picture, measured at 10.7 ms for the densest bundled document at four lanes; see
 * PROGRESS.md for why that is what rate-limits the gesture.
 */
describe('the view window', () => {
  const model = buildChartModel(makeSchedule([twoEntryVoice]));

  it('draws the whole schedule when nobody has zoomed', () => {
    const layout = layoutChart(model, 640, 280);
    expect(layout.view).toEqual({ start: 0, end: 20 });
    expect(layout.timeScale.toPixel(0)).toBe(layout.lanes[0].x);
  });

  it('maps the window onto the plot, so a zoomed axis spreads the same pixels over less time', () => {
    const layout = layoutChart(model, 640, 280, undefined, { start: 5, end: 10 });
    const lane = layout.lanes[0];

    expect(layout.timeScale.toPixel(5)).toBeCloseTo(lane.x, 6);
    expect(layout.timeScale.toPixel(10)).toBeCloseTo(lane.x + lane.width, 6);
    expect(timeAtPixel(layout, lane.x + lane.width / 2)).toBeCloseTo(7.5, 6);
  });

  it('slides a window that runs off either end back inside the schedule', () => {
    expect(clampView({ start: -5, end: 5 }, 20)).toEqual({ start: 0, end: 10 });
    expect(clampView({ start: 18, end: 28 }, 20)).toEqual({ start: 10, end: 20 });
    expect(clampView({ start: 0, end: 100 }, 20)).toEqual({ start: 0, end: 20 });
  });

  /** The floor is what keeps the corpus's 0.001 s entries from being chased to infinity. */
  it('will not narrow past the minimum span', () => {
    const tight = clampView({ start: 10, end: 10 }, 20);
    expect(tight.end - tight.start).toBe(MIN_VIEW_SECONDS);
  });

  it('keeps the anchored instant under the pointer while zooming about it', () => {
    const zoomed = zoomView({ start: 0, end: 20 }, 20, 2, 5);
    expect(zoomed.end - zoomed.start).toBeCloseTo(10, 6);
    // 5 s was a quarter of the way across the old window, so it stays a quarter across the new one.
    expect(zoomed.start).toBeCloseTo(2.5, 6);
  });

  it('is reversible, so scrolling back undoes scrolling forward exactly', () => {
    const there = zoomView({ start: 0, end: 20 }, 20, 3, 7);
    const back = zoomView(there, 20, 1 / 3, 7);
    expect(back.start).toBeCloseTo(0, 6);
    expect(back.end).toBeCloseTo(20, 6);
  });

  it('pans without changing the span, and stops at the ends', () => {
    expect(panView({ start: 5, end: 10 }, 20, 3)).toEqual({ start: 8, end: 13 });
    expect(panView({ start: 5, end: 10 }, 20, 999)).toEqual({ start: 15, end: 20 });
    expect(panView({ start: 5, end: 10 }, 20, -999)).toEqual({ start: 0, end: 5 });
  });

  it('reports how far in it is, which is what the control shows', () => {
    expect(zoomFactor({ start: 0, end: 20 }, 20)).toBe(1);
    expect(zoomFactor({ start: 5, end: 10 }, 20)).toBe(4);
  });
});

/**
 * Culling. The saving that matters is elements not created: at 4x zoom only 6 of
 * `oobe-lucid-dreams-2`'s 80 points are inside the window.
 */
describe('visibleRange', () => {
  const points = [0, 10, 20, 30, 40, 50].map((time) => ({ time, value: time }));

  it('keeps the point either side of the window, so a line enters from off screen', () => {
    const [from, to] = visibleRange(points, { start: 22, end: 38 });
    expect(points.slice(from, to).map((p) => p.time)).toEqual([20, 30, 40]);
  });

  it('keeps everything when the window is the whole extent', () => {
    expect(visibleRange(points, { start: 0, end: 50 })).toEqual([0, points.length]);
  });

  it('keeps the bracketing pair for a window with no point inside it at all', () => {
    const [from, to] = visibleRange(points, { start: 12, end: 18 });
    expect(points.slice(from, to).map((p) => p.time)).toEqual([10, 20]);
  });

  it('survives an empty series', () => {
    expect(visibleRange([], { start: 0, end: 1 })).toEqual([0, 0]);
  });
});

/** §6.1's marquee: a rectangle, and every authored node under it. */
describe('nodesInRect', () => {
  const second = makeVoice({
    id: 1,
    description: 'Second',
    entries: [
      makeEntry({ duration: 10, baseFreq: 210, beatFreq: 9 }),
      makeEntry({ duration: 10, baseFreq: 110, beatFreq: 5 }),
    ],
  });
  const layout = layoutChart(
    buildChartModel(makeSchedule([twoEntryVoice, second]), ['beat', 'base']),
    640,
    280,
  );

  function rectOver(lanes: number[], times: [number, number]) {
    const first = layout.lanes[lanes[0]];
    const last = layout.lanes[lanes[lanes.length - 1]];
    return {
      x0: layout.timeScale.toPixel(times[0]),
      x1: layout.timeScale.toPixel(times[1]),
      y0: first.y,
      y1: last.y + last.height,
    };
  }

  it('spans voices, because empty space cannot name one', () => {
    const found = nodesInRect(layout, rectOver([0], [-1, 21]));
    expect(found).toEqual([
      { voice: 0, entry: 0 },
      { voice: 0, entry: 1 },
      { voice: 1, entry: 0 },
      { voice: 1, entry: 1 },
    ]);
  });

  it('takes the union across lanes, since a node is the same node in each', () => {
    // A rectangle over both lanes finds each entry once, not once per lane.
    const found = nodesInRect(layout, rectOver([0, 1], [-1, 21]));
    expect(found).toHaveLength(4);
  });

  it('excludes anything outside the rectangle in time', () => {
    const found = nodesInRect(layout, rectOver([0], [-1, 5]));
    expect(found).toEqual([
      { voice: 0, entry: 0 },
      { voice: 1, entry: 0 },
    ]);
  });

  /** §3.5's wrap point is derived rather than authored, so a selection cannot contain it. */
  it('never selects the terminal wrap point', () => {
    const found = nodesInRect(layout, rectOver([0, 1], [-1, 100]));
    expect(found.every((node) => node.entry < 2)).toBe(true);
  });

  it('finds nothing under a rectangle drawn over empty space', () => {
    const lane = layout.lanes[0];
    expect(nodesInRect(layout, { x0: 0, x1: 5, y0: lane.y, y1: lane.y + 5 })).toEqual([]);
  });
});

/** §6.1's manual axis override, which is what makes a value outside the data draggable at all. */
describe('lane domain overrides', () => {
  it('replaces the fitted domain for the lane it names, and leaves the others fitted', () => {
    const fitted = buildChartModel(makeSchedule([twoEntryVoice]), ['beat', 'base']);
    const forced = buildChartModel(makeSchedule([twoEntryVoice]), ['beat', 'base'], 0.1, {
      beat: [0, 40],
    });

    expect(forced.lanes[0].domain).toEqual([0, 40]);
    expect(forced.lanes[1].domain).toEqual(fitted.lanes[1].domain);
  });
});

describe('drawnDuration', () => {
  it('is the longest voice that is actually drawn', () => {
    const short = makeVoice({ id: 1, entries: [makeEntry({ duration: 5 })] });
    expect(drawnDuration(makeSchedule([twoEntryVoice, short]))).toBe(20);
  });

  it('ignores hidden and empty voices, exactly as the model does', () => {
    const hidden = makeVoice({ id: 1, hidden: true, entries: [makeEntry({ duration: 900 })] });
    const empty = makeVoice({ id: 2, entries: [] });
    expect(drawnDuration(makeSchedule([twoEntryVoice, hidden, empty]))).toBe(20);
  });
});
