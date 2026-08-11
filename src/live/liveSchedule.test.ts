import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import { parseSchedule } from '../document/parser';
import { serializeSchedule } from '../document/serializer';
import { scheduleDuration } from '../document/timing';
import { VoiceType } from '../document/types';
import { compileVoice, eventBaseFreq, eventBeatFreq } from '../engine/compiler';
import { playSchedule } from '../engine/engine';
import {
  BASE_RANGE,
  BEAT_RANGE,
  LIVE_SESSION_SECONDS,
  buildLiveSchedule,
  clampTo,
  describeLive,
} from './liveSchedule';

describe('buildLiveSchedule', () => {
  it('is one binaural voice with one entry, at unity volume', () => {
    const schedule = buildLiveSchedule({ baseFreq: 240, beatFreq: 6 });

    expect(schedule.voices).toHaveLength(1);
    expect(schedule.voices[0].type).toBe(VoiceType.Binaural);
    expect(schedule.voices[0].entries).toEqual([
      {
        duration: LIVE_SESSION_SECONDS,
        baseFreq: 240,
        beatFreq: 6,
        volumeLeft: 1,
        volumeRight: 1,
        preserved: {},
      },
    ]);
  });

  it('plays as a single pass, so `update()` never pays for a future it does not have', () => {
    // `rescheduleFrom` schedules every remaining pass up front. A repeating live schedule would
    // therefore cost its whole future on every slider tick — 720 passes for a 60-second entry.
    const schedule = buildLiveSchedule({ baseFreq: 200, beatFreq: 10 });

    expect(schedule.loops).toBe(1);
    expect(scheduleDuration(schedule)).toBe(LIVE_SESSION_SECONDS);
  });

  it('compiles to a constant hold, because §3.5 wraps the last entry to entry[0]', () => {
    const events = compileVoice(buildLiveSchedule({ baseFreq: 300, beatFreq: 8 }).voices[0]);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.time)).toEqual([0, LIVE_SESSION_SECONDS]);
    for (const event of events) {
      expect(eventBaseFreq(event)).toBeCloseTo(300, 6);
      expect(eventBeatFreq(event)).toBeCloseTo(8, 6);
      expect(event.leftGain).toBe(1);
      expect(event.rightGain).toBe(1);
    }
  });

  it('clamps and rounds to the sliders own precision, so stored and heard agree', () => {
    const low = buildLiveSchedule({ baseFreq: 5, beatFreq: 0 }).voices[0].entries[0];
    expect(low.baseFreq).toBe(BASE_RANGE.min);
    expect(low.beatFreq).toBe(BEAT_RANGE.min);

    const high = buildLiveSchedule({ baseFreq: 9000, beatFreq: 120 }).voices[0].entries[0];
    expect(high.baseFreq).toBe(BASE_RANGE.max);
    expect(high.beatFreq).toBe(BEAT_RANGE.max);

    // A log slider lands on values like 200.00000000000003, which would serialize verbatim.
    const rounded = buildLiveSchedule({ baseFreq: 200.00000000000003, beatFreq: 6.666666 });
    expect(rounded.voices[0].entries[0].baseFreq).toBe(200);
    expect(rounded.voices[0].entries[0].beatFreq).toBeCloseTo(6.67, 10);
  });

  it('round-trips through the serializer as a fixed point', () => {
    // A kept program is a real `.gnaural` file: one entry is a valid constant hold (§3.5), and
    // `BB_CalibrateVoice` wraps `nextEntry` to 0 for it, so Gnaural desktop reads it as one too.
    const schedule = buildLiveSchedule({ baseFreq: 174.5, beatFreq: 3.25 }, {
      title: 'Kept session',
      durationSeconds: 1200,
    });

    const xml = serializeSchedule(schedule);
    expect(serializeSchedule(parseSchedule(xml))).toBe(xml);

    // Not `toEqual(schedule)`: a real file carries `parent` on every entry, so the parser captures
    // one that the serializer derived from the voice id. The values are what has to survive.
    const reopened = parseSchedule(xml);
    expect(reopened.title).toBe('Kept session');
    expect(reopened.voices).toHaveLength(1);
    expect(reopened.voices[0].entries).toHaveLength(1);
    expect(reopened.voices[0].entries[0]).toMatchObject({
      duration: 1200,
      baseFreq: 174.5,
      beatFreq: 3.25,
      volumeLeft: 1,
      volumeRight: 1,
    });
  });

  it('declares counts that match what it contains (§3.4)', () => {
    const xml = serializeSchedule(buildLiveSchedule({ baseFreq: 200, beatFreq: 10 }, { durationSeconds: 600 }));

    expect(xml).toContain('<totaltime>600</totaltime>');
    expect(xml).toContain('<voicecount>1</voicecount>');
    expect(xml).toContain('<totalentrycount>1</totalentrycount>');
  });

  it('renders the beat frequency the sliders asked for', async () => {
    const sampleRate = 44100;
    const context = new OfflineAudioContext(2, sampleRate, sampleRate);

    playSchedule(context, buildLiveSchedule({ baseFreq: 300, beatFreq: 12 }));
    const buffer = await context.startRendering();

    const measure = (samples: Float32Array) => {
      let crossings = 0;
      for (let i = 1; i < samples.length; i++) {
        if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
      }
      return crossings / (samples.length / sampleRate);
    };

    const left = measure(buffer.getChannelData(0));
    const right = measure(buffer.getChannelData(1));

    // The difference is exact because the estimator's truncation error cancels across the two
    // channels; the absolute carries that error, hence the looser bound on the carrier.
    expect(left - right).toBeCloseTo(12, 0); // §3.6 — the left channel carries the higher tone
    expect((left + right) / 2).toBeCloseTo(300, -1);
  });

  it('describes itself factually, making no claim about what it does (§2)', () => {
    expect(describeLive({ baseFreq: 200, beatFreq: 10 })).toBe('10 Hz beat at 200 Hz base');
  });
});

describe('clampTo', () => {
  it('falls back to the range minimum for a value that is not a number', () => {
    // A number input can hand over NaN, and NaN would reach an AudioParam.
    expect(clampTo(BASE_RANGE, Number.NaN)).toBe(BASE_RANGE.min);
  });
});
