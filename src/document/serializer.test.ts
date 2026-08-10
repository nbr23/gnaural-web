import { describe, expect, it } from 'vitest';
import { parseSchedule } from './parser';
import { serializeSchedule } from './serializer';
import { loadFixture } from './test-fixtures';

describe('serializeSchedule — powernap.gnaural', () => {
  const original = loadFixture('powernap.gnaural');
  const schedule = parseSchedule(original);
  const serialized = serializeSchedule(schedule);

  it('recomputes the header counts instead of trusting the stale declared ones', () => {
    // The source file declares voicecount=3, totalentrycount=14, totaltime=1200 — all stale.
    expect(serialized).toContain('<voicecount>1</voicecount>');
    expect(serialized).toContain('<totalentrycount>12</totalentrycount>');
    expect(serialized).not.toContain('<voicecount>3</voicecount>');
    expect(serialized).not.toContain('<totalentrycount>14</totalentrycount>');
  });

  it('recomputes totaltime as the sum of the (single) voice duration, not the stale header value', () => {
    const expectedDuration = schedule.voices[0].entries.reduce((sum, e) => sum + e.duration, 0);
    expect(serialized).toContain(`<totaltime>${expectedDuration}</totaltime>`);
  });

  it('re-emits preserved metadata fields', () => {
    expect(serialized).toContain('<gnauralfile_version>1.20101006</gnauralfile_version>');
    expect(serialized).toContain('<date>Mon Aug  8 08:12:51 2011\n</date>');
  });

  it('produces well-formed XML that re-parses cleanly', () => {
    expect(() => parseSchedule(serialized)).not.toThrow();
  });
});

describe('serializeSchedule — escaping', () => {
  it('escapes special XML characters in text content and attribute values', () => {
    const schedule = parseSchedule(loadFixture('powernap.gnaural'));
    schedule.title = 'A & B < C > D "quoted"';
    const serialized = serializeSchedule(schedule);
    expect(serialized).toContain('<title>A &amp; B &lt; C &gt; D "quoted"</title>');

    const reparsed = parseSchedule(serialized);
    expect(reparsed.title).toBe('A & B < C > D "quoted"');
  });
});
