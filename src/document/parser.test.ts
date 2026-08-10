import { describe, expect, it } from 'vitest';
import { parseSchedule } from './parser';
import { loadFixture } from './test-fixtures';
import { VoiceType } from './types';

describe('parseSchedule — powernap.gnaural', () => {
  const schedule = parseSchedule(loadFixture('powernap.gnaural'));

  it('ignores the stale declared voicecount/totalentrycount and derives from the DOM', () => {
    // The file declares voicecount=3 and totalentrycount=14, but actually contains 1 voice
    // with 12 entries (PLAN.md §3.4) — this is real, representative dirty data.
    expect(schedule.voices).toHaveLength(1);
    expect(schedule.voices[0].entries).toHaveLength(12);
  });

  it('parses schedule-level fields', () => {
    expect(schedule.title).toBe('Power Nap');
    expect(schedule.author).toBe('Gnaural');
    expect(schedule.loops).toBe(1);
    expect(schedule.masterVolume).toEqual({ left: 1, right: 1 });
    expect(schedule.stereoSwap).toBe(false);
  });

  it('preserves embedded newlines in free-text fields', () => {
    expect(schedule.description).toBe(
      'Around 20mn of rest to make it through the day\nPut on your headphones and relax!',
    );
  });

  it('preserves fields with no dedicated Schedule slot', () => {
    expect(schedule.preserved.gnauralfile_version).toBe('1.20101006');
    expect(schedule.preserved.gnaural_version).toBe('1.0.20110606');
    expect(schedule.preserved.date).toBe('Mon Aug  8 08:12:51 2011\n');
    expect(schedule.preserved.graphview).toBe('1');
  });

  it('never leaks the derived/recomputed counts into preserved', () => {
    expect(schedule.preserved).not.toHaveProperty('totaltime');
    expect(schedule.preserved).not.toHaveProperty('voicecount');
    expect(schedule.preserved).not.toHaveProperty('totalentrycount');
  });

  it('parses voice-level fields', () => {
    const voice = schedule.voices[0];
    expect(voice.id).toBe(0);
    expect(voice.description).toBe('164 to 110');
    expect(voice.type).toBe(VoiceType.Binaural);
    expect(voice.muted).toBe(false);
    expect(voice.hidden).toBe(false);
    expect(voice.mono).toBe(false);
    expect(voice.preserved.voice_state).toBe('0');
    expect(voice.preserved).not.toHaveProperty('entrycount');
  });

  it('parses entry fields as floats, never truncating duration', () => {
    const first = schedule.voices[0].entries[0];
    expect(first.duration).toBeCloseTo(13.1737, 5);
    expect(first.volumeLeft).toBeCloseTo(0.515339, 6);
    expect(first.volumeRight).toBeCloseTo(0.515339, 6);
    expect(first.beatFreq).toBeCloseTo(10.991, 5);
    expect(first.baseFreq).toBe(164);
    expect(first.preserved.state).toBe('0');
  });
});

describe('parseSchedule — airplanetravelaid.gnaural', () => {
  const schedule = parseSchedule(loadFixture('airplanetravelaid.gnaural'));

  it('parses the declared count correctly this time, but still derives it', () => {
    expect(schedule.voices).toHaveLength(1);
    expect(schedule.voices[0].entries).toHaveLength(45);
  });

  it('does not drop the zero-beatfreq first entry', () => {
    const first = schedule.voices[0].entries[0];
    expect(first.beatFreq).toBe(0);
    expect(first.baseFreq).toBe(280);
    expect(first.duration).toBe(9);
    expect(first.volumeLeft).toBe(0.85);
    expect(first.volumeRight).toBe(0.85);
  });
});
