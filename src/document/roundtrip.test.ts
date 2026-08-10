import { describe, expect, it } from 'vitest';
import { parseSchedule } from './parser';
import { serializeSchedule } from './serializer';
import { loadFixture } from './test-fixtures';
import type { Schedule } from './types';
import { VoiceType } from './types';

function checkFixedPoint(xml: string) {
  const parsed1 = parseSchedule(xml);
  const serialized1 = serializeSchedule(parsed1);
  const parsed2 = parseSchedule(serialized1);
  const serialized2 = serializeSchedule(parsed2);
  const parsed3 = parseSchedule(serialized2);

  // Model fixed point (PLAN.md §5.1): once normalised by one pass, further
  // parse -> serialize -> parse cycles do not change the model.
  expect(parsed3).toEqual(parsed2);
  // Byte-level stability on the second pass (PLAN.md §5.3): the first pass may normalise
  // (recomputed counts, canonical field order), but after that, serialization must not drift.
  expect(serialized2).toBe(serialized1);
}

describe('round-trip fixed point — bundled fixtures', () => {
  it('powernap.gnaural', () => {
    checkFixedPoint(loadFixture('powernap.gnaural'));
  });

  it('airplanetravelaid.gnaural', () => {
    checkFixedPoint(loadFixture('airplanetravelaid.gnaural'));
  });
});

describe('round-trip — hand-built Schedule', () => {
  const schedule: Schedule = {
    title: 'Hand-built',
    description: 'A synthetic schedule for testing.',
    author: 'test',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    preserved: {},
    voices: [
      {
        id: 0,
        description: 'voice 0',
        type: VoiceType.Binaural,
        muted: false,
        hidden: false,
        mono: false,
        preserved: {},
        entries: [
          { duration: 10, baseFreq: 200, beatFreq: 0, volumeLeft: 1, volumeRight: 1, preserved: {} },
          { duration: 10, baseFreq: 210, beatFreq: 4, volumeLeft: 1, volumeRight: 1, preserved: {} },
        ],
      },
      {
        id: 1,
        description: 'muted voice',
        type: VoiceType.Binaural,
        muted: true,
        hidden: false,
        mono: false,
        preserved: {},
        entries: [
          { duration: 20, baseFreq: 100, beatFreq: 5, volumeLeft: 0.5, volumeRight: 0.5, preserved: {} },
        ],
      },
    ],
  };

  it('survives a beatfreq=0 first entry and a muted voice', () => {
    const serialized = serializeSchedule(schedule);
    const reparsed = parseSchedule(serialized);

    expect(reparsed.voices[0].entries[0].beatFreq).toBe(0);
    expect(reparsed.voices[1].muted).toBe(true);
    expect(reparsed.voices).toHaveLength(2);
    expect(reparsed.voices[0].entries).toHaveLength(2);
  });

  it('is stable on a second serialize/parse pass', () => {
    const serialized1 = serializeSchedule(schedule);
    const serialized2 = serializeSchedule(parseSchedule(serialized1));
    expect(serialized2).toBe(serialized1);
  });
});

describe('round-trip — unrecognised data injected via raw XML', () => {
  const rawXml = `<?xml version="1.0"?>
<schedule>
<title>Synthetic</title>
<schedule_description>test</schedule_description>
<author>tester</author>
<loops>1</loops>
<overallvolume_left>1</overallvolume_left>
<overallvolume_right>1</overallvolume_right>
<stereoswap>0</stereoswap>
<custom_field>hello</custom_field>
<voice>
<description>voice 0</description>
<id>0</id>
<type>0</type>
<voice_state>2</voice_state>
<voice_hide>0</voice_hide>
<voice_mute>0</voice_mute>
<voice_mono>0</voice_mono>
<entries>
<entry parent="0" duration="5" volume_left="1" volume_right="1" beatfreq="0" basefreq="200" state="0" foo="bar"/>
</entries>
</voice>
</schedule>`;

  it('captures unrecognised elements and attributes in preserved', () => {
    const parsed = parseSchedule(rawXml);
    expect(parsed.preserved.custom_field).toBe('hello');
    expect(parsed.voices[0].preserved.voice_state).toBe('2');
    expect(parsed.voices[0].entries[0].preserved.foo).toBe('bar');
  });

  it('re-emits them on serialize and preserves them through another parse', () => {
    const parsed = parseSchedule(rawXml);
    const serialized = serializeSchedule(parsed);

    expect(serialized).toContain('<custom_field>hello</custom_field>');
    expect(serialized).toContain('foo="bar"');

    const reparsed = parseSchedule(serialized);
    expect(reparsed).toEqual(parsed);
  });
});
