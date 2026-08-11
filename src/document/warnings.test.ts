import { describe, expect, it } from 'vitest';
import { parseScheduleWithWarnings } from './parser';
import { fixtureNames, loadFixture } from './test-fixtures';
import type { WarningKind } from './warnings';
import { scheduleWarnings } from './warnings';

/**
 * The bundled corpus cannot exercise any of this: of the 19 programs, exactly one trips a single
 * notice and none trips a warning (asserted at the bottom of this file). So the cases are built
 * here as XML rather than as fixture files — a file in `fixtures/` would also join the bundled
 * library, which is not what a deliberately broken schedule should do.
 */
function xml(body: string): string {
  return `<?xml version="1.0"?><schedule>${body}</schedule>`;
}

function voice(attrs: { type?: number; id?: number; description?: string }, entries: string): string {
  return `<voice>
    <description>${attrs.description ?? ''}</description>
    <id>${attrs.id ?? 0}</id>
    <type>${attrs.type ?? 0}</type>
    <entries>${entries}</entries>
  </voice>`;
}

function entry(duration: number, extra = ''): string {
  return `<entry duration="${duration}" volume_left="1" volume_right="1" beatfreq="10" basefreq="200" ${extra}/>`;
}

function kindsOf(warnings: { kind: WarningKind }[]): WarningKind[] {
  return warnings.map((w) => w.kind);
}

describe('scheduleWarnings — what the program will do (§3.3, §3.7)', () => {
  it('warns that an unsupported voice type is silent, and names the type', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(voice({ type: 0, description: 'tone' }, entry(60)) + voice({ type: 3, description: 'pulse' }, entry(60))),
    );

    const warnings = scheduleWarnings(schedule);
    expect(kindsOf(warnings)).toEqual(['unsupported-voice']);
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].message).toContain('pulse');
    expect(warnings[0].message).toContain('isochronic');
  });

  it('agrees the verb with the number of voices it is talking about', () => {
    const one = parseScheduleWithWarnings(xml(voice({ type: 0 }, entry(60)) + voice({ type: 3, id: 1, description: 'a' }, entry(60))));
    expect(scheduleWarnings(one.schedule)[0].message).toContain('Voice a uses a voice type');

    const many = parseScheduleWithWarnings(
      xml(
        voice({ type: 0 }, entry(60)) +
          voice({ type: 3, id: 1, description: 'a' }, entry(60)) +
          voice({ type: 4, id: 2, description: 'b' }, entry(60)),
      ),
    );
    expect(scheduleWarnings(many.schedule)[0].message).toContain('Voices a and b use a voice type');
  });

  it('gives PCM its own message, because it can never be resolved from a schedule (§3.3)', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(voice({ type: 0 }, entry(60)) + voice({ type: 2, description: 'sample' }, entry(60))),
    );

    const warnings = scheduleWarnings(schedule);
    expect(kindsOf(warnings)).toEqual(['pcm-voice']);
    // The distinction that matters: not "not yet", but "never", and the reason why.
    expect(warnings[0].message).toContain('does not record where that file is');
    expect(warnings[0].message).not.toContain('yet');
  });

  it('names both sides when voices are unequal in length (§3.7)', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(voice({ description: 'short' }, entry(60)) + voice({ description: 'long' }, entry(300))),
    );

    const warnings = scheduleWarnings(schedule);
    expect(kindsOf(warnings)).toEqual(['unequal-durations']);
    expect(warnings[0].message).toContain('short');
    expect(warnings[0].message).toContain('long');
    expect(warnings[0].message).toContain('1:00');
  });

  it('ignores a difference small enough to be a rounding error', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(voice({}, entry(60)) + voice({}, entry(60.01))),
    );

    expect(scheduleWarnings(schedule)).toEqual([]);
  });

  it('reports a schedule with nothing renderable in it', () => {
    const { schedule } = parseScheduleWithWarnings(xml(voice({ type: 5 }, entry(60))));

    expect(kindsOf(scheduleWarnings(schedule))).toContain('nothing-to-play');
  });

  it('reports a schedule with no voices at all', () => {
    const { schedule } = parseScheduleWithWarnings(xml('<title>Empty</title>'));

    expect(kindsOf(scheduleWarnings(schedule))).toEqual(['nothing-to-play']);
  });

  it('says nothing about an ordinary file', () => {
    const { schedule } = parseScheduleWithWarnings(xml(voice({ type: 1 }, entry(60)) + voice({}, entry(60))));

    expect(scheduleWarnings(schedule)).toEqual([]);
  });
});

describe('parseScheduleWithWarnings — what the file contained (§3.4)', () => {
  it('notices declared counts that disagree with the actual contents', () => {
    const { warnings } = parseScheduleWithWarnings(
      xml(`<voicecount>3</voicecount><totalentrycount>14</totalentrycount>${voice({}, entry(60))}`),
    );

    expect(kindsOf(warnings)).toEqual(['stale-count', 'stale-count']);
    // A notice, not a warning: §3.4 says to ignore these and rewrite them on export, so nothing
    // about playback is affected and the file is not "wrong".
    expect(warnings.every((w) => w.severity === 'notice')).toBe(true);
    expect(warnings[0].message).toContain('3 voices');
    expect(warnings[1].message).toContain('14 entries');
  });

  it('says nothing when the declared counts are right', () => {
    const { warnings } = parseScheduleWithWarnings(
      xml(`<voicecount>1</voicecount><totalentrycount>1</totalentrycount>${voice({}, entry(60))}`),
    );

    expect(warnings).toEqual([]);
  });

  it('warns once about values that would not parse, however many there are', () => {
    const { schedule, warnings } = parseScheduleWithWarnings(
      xml(voice({}, `<entry duration="soon" volume_left="loud" beatfreq="10" basefreq="200"/>${entry(60)}`)),
    );

    expect(kindsOf(warnings)).toEqual(['unparseable-value']);
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].message).toContain('duration');
    expect(warnings[0].message).toContain('volume_left');
    // The documented fallbacks still apply — nothing is dropped (§3.4).
    expect(schedule.voices[0].entries).toHaveLength(2);
    expect(schedule.voices[0].entries[0].duration).toBe(0);
    expect(schedule.voices[0].entries[0].volumeLeft).toBe(1);
  });

  it('notices voices that reuse an id, without letting it matter', () => {
    const { warnings } = parseScheduleWithWarnings(
      xml(voice({ id: 0 }, entry(60)) + voice({ id: 0 }, entry(60))),
    );

    expect(kindsOf(warnings)).toEqual(['duplicate-voice-id']);
    expect(warnings[0].severity).toBe('notice');
  });

  it('notices a voice with no entries', () => {
    const { warnings } = parseScheduleWithWarnings(
      xml(voice({ id: 0, description: 'ghost' }, '') + voice({ id: 1 }, entry(60))),
    );

    expect(kindsOf(warnings)).toEqual(['empty-voice']);
    expect(warnings[0].message).toContain('ghost');
  });

  it('leaves a degenerate but legitimate value alone (§3.4)', () => {
    // beatfreq=0 is a pure centred tone and volume=0 is a silent lead-in; both are real.
    const { warnings } = parseScheduleWithWarnings(
      xml(voice({}, '<entry duration="60" volume_left="0" volume_right="0" beatfreq="0" basefreq="200"/>')),
    );

    expect(warnings).toEqual([]);
  });
});

describe('the bundled library', () => {
  it('trips nothing but powernap’s stale header, so a regression in it would show', () => {
    const offenders = fixtureNames()
      .map((name) => {
        const { schedule, warnings } = parseScheduleWithWarnings(loadFixture(name));
        return { name, kinds: kindsOf([...warnings, ...scheduleWarnings(schedule)]) };
      })
      .filter((result) => result.kinds.length > 0);

    expect(offenders).toEqual([{ name: 'powernap.gnaural', kinds: ['stale-count', 'stale-count'] }]);
  });
});
