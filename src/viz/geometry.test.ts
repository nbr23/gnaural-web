import { describe, expect, it } from 'vitest';
import { parseSchedule } from '../document/parser';
import { loadFixture } from '../document/test-fixtures';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import {
  buildChartModel,
  layoutChart,
  nearestBreakpoint,
  polylinePath,
  seriesValueAt,
  timeAtPixel,
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
