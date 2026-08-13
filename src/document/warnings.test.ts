import { describe, expect, it } from 'vitest';
import { parseScheduleWithWarnings } from './parser';
import { fixtureNames, loadFixture } from './test-fixtures';
import type { WarningKind } from './warnings';
import { entryWarnings, scheduleWarnings } from './warnings';

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
      xml(voice({ type: 0, description: 'tone' }, entry(60)) + voice({ type: 5, description: 'drops' }, entry(60))),
    );

    const warnings = scheduleWarnings(schedule);
    expect(kindsOf(warnings)).toEqual(['unsupported-voice']);
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].message).toContain('drops');
    expect(warnings[0].message).toContain('water drops');
  });

  /** Types 3 and 4 became renderable in step 10, so what is left to warn about is 5 and 6 — and
   *  type 2, which has its own permanent message. This is the assertion that says the warning
   *  surface and the engine agree; they read the same set (`isRenderableType`). */
  it('says nothing about isochronic voices, which are rendered', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(voice({ type: 3, description: 'pulse' }, entry(60)) + voice({ type: 4, id: 1, description: 'alt' }, entry(60))),
    );

    expect(scheduleWarnings(schedule)).toEqual([]);
  });

  it('agrees the verb with the number of voices it is talking about', () => {
    const one = parseScheduleWithWarnings(xml(voice({ type: 0 }, entry(60)) + voice({ type: 5, id: 1, description: 'a' }, entry(60))));
    expect(scheduleWarnings(one.schedule)[0].message).toContain('Voice a uses a voice type');

    const many = parseScheduleWithWarnings(
      xml(
        voice({ type: 0 }, entry(60)) +
          voice({ type: 5, id: 1, description: 'a' }, entry(60)) +
          voice({ type: 6, id: 2, description: 'b' }, entry(60)),
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

describe('entryWarnings — values that are legal and wrong (§6.1)', () => {
  /** An entry with ordinary values, overridden by whatever the case is about. */
  function node(overrides: Record<string, number> = {}): string {
    const attrs = { duration: 60, volume_left: 1, volume_right: 1, beatfreq: 10, basefreq: 200, ...overrides };
    return `<entry ${Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(' ')}/>`;
  }

  /** One voice of one entry — the smallest document a value rule can be asked about. */
  function one(overrides: Record<string, number>, type = 0) {
    return parseScheduleWithWarnings(xml(voice({ type, description: 'tone' }, node(overrides)))).schedule;
  }

  it('warns about a negative duration, which only an import can produce', () => {
    // The editor cannot make one — `moveEntry` clamps at zero and the panel does `Math.max(0, …)`
    // — but the parser has no clamp, which is the whole reason the rule exists.
    const schedule = one({ duration: -5 });
    expect(schedule.voices[0].entries[0].duration).toBe(-5);

    const [warning] = entryWarnings(schedule);
    expect(warning.kind).toBe('negative-duration');
    expect(warning.severity).toBe('warning');
    expect(warning.nodes).toEqual([{ voice: 0, entry: 0 }]);
  });

  it('warns below 20 Hz and only notices above 1500 Hz', () => {
    const low = entryWarnings(one({ basefreq: 5, beatfreq: 0 }));
    expect(low.map((w) => [w.kind, w.severity])).toEqual([['base-too-low', 'warning']]);
    expect(low[0].message).toContain('down to 5 Hz');

    const high = entryWarnings(one({ basefreq: 2000 }));
    // It plays exactly as written: the percept weakens, nothing is misheard.
    expect(high.map((w) => [w.kind, w.severity])).toEqual([['base-too-high', 'notice']]);
  });

  /**
   * §6.1's threshold, kept exactly as written *because* the severity split can carry it — four
   * bundled presets sit above it deliberately. See the corpus assertion below.
   */
  it('notices a beat above 40 Hz rather than warning about it', () => {
    expect(entryWarnings(one({ beatfreq: 40 }))).toEqual([]);

    const [warning] = entryWarnings(one({ beatfreq: 70 }));
    expect(warning.kind).toBe('beat-above-band');
    expect(warning.severity).toBe('notice');
    expect(warning.message).toContain('up to 70 Hz');
  });

  it('warns when the beat is wider than its carrier, which puts the right channel at or below zero', () => {
    // The two rules necessarily overlap: with the carrier inside its own range, a beat wide enough
    // to reach zero is always above 40 Hz too. Both are reported, at their own severities.
    const warnings = entryWarnings(one({ basefreq: 30, beatfreq: 80 }));
    expect(warnings.map((w) => [w.kind, w.severity])).toEqual([
      ['beat-above-band', 'notice'],
      ['beat-exceeds-base', 'warning'],
    ]);
    // §3.6: right = base − beat/2.
    expect(warnings[1].message).toContain('-10 Hz');
  });

  it('warns about a volume outside 0–1, from either channel, and quotes the furthest', () => {
    const [warning] = entryWarnings(one({ volume_left: 2.5, volume_right: -0.2 }));
    expect(warning.kind).toBe('volume-out-of-range');
    expect(warning.message).toContain('2.5');

    expect(entryWarnings(one({ volume_right: 1.4 }))[0].kind).toBe('volume-out-of-range');
    // Zero is a legitimate silent lead-in (§3.4), and one is full scale.
    expect(entryWarnings(one({ volume_left: 0, volume_right: 1 }))).toEqual([]);
  });

  /**
   * A zero-length segment is what step 5's squeeze clamp produces on purpose when a node is dragged
   * against its neighbour, so warning about it would be an alarm on the user's own gesture.
   */
  it('says nothing about a zero duration', () => {
    expect(entryWarnings(one({ duration: 0 }))).toEqual([]);
  });

  it('leaves a noise voice alone — it reads neither frequency', () => {
    // Every noise voice in the corpus carries base 100 and beat 0, and a rule applied to every type
    // would have to make an exception for exactly that.
    expect(entryWarnings(one({ basefreq: 0, beatfreq: 0 }, 1))).toEqual([]);
    expect(entryWarnings(one({ basefreq: 0, beatfreq: 0 }, 5))).toEqual([]);
  });

  /**
   * An isochronic voice reads both fields, so the range rules apply to it — but not
   * `beat-exceeds-base`, which describes §3.6's channel split failing. Types 3 and 4 have no split:
   * both ears get `basefreq` and `beatfreq` is the rate it is switched on and off at, so a beat
   * wider than the carrier is an ordinary fast pulse, and `beat-above-band` is what has something
   * to say about it.
   */
  it('applies the range rules to an isochronic voice, but not the channel-split rule', () => {
    for (const type of [3, 4]) {
      expect(entryWarnings(one({ basefreq: 5, beatfreq: 0 }, type))[0].kind).toBe('base-too-low');
      expect(entryWarnings(one({ beatfreq: 70 }, type))[0].kind).toBe('beat-above-band');

      expect(entryWarnings(one({ basefreq: 30, beatfreq: 80 }, type)).map((w) => w.kind)).toEqual([
        'beat-above-band',
      ]);
    }
  });

  it('gathers a rule into one warning that names every voice and node it found', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(
        voice({ description: 'a' }, `${node({ beatfreq: 50 })}${node()}${node({ beatfreq: 70 })}`) +
          voice({ id: 1, description: 'b' }, node({ beatfreq: 60 })),
      ),
    );

    const [warning] = entryWarnings(schedule);
    expect(warning.nodes).toEqual([
      { voice: 0, entry: 0 },
      { voice: 0, entry: 2 },
      { voice: 1, entry: 0 },
    ]);
    expect(warning.message).toContain('Voices a and b');
    expect(warning.message).toContain('3 nodes');
    expect(warning.message).toContain('up to 70 Hz');
  });

  it('agrees its verbs with a singular subject, whatever the verb is', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(voice({ description: 'a' }, node({ volume_left: 2 }))),
    );

    // A bare `+ s` used to be enough for "plays" and "uses" and would say "carrys" here.
    expect(entryWarnings(schedule)[0].message).toContain('Voice a carries');
  });

  it('says nothing about an ordinary document', () => {
    const { schedule } = parseScheduleWithWarnings(xml(voice({}, entry(60)) + voice({ id: 1, type: 1 }, entry(60))));

    expect(entryWarnings(schedule)).toEqual([]);
  });
});

/**
 * §6.3 makes reopening in Gnaural desktop a definition-of-done item, and `SG_RestoreBackupData`
 * (ScheduleGUI.c:2213) rebuilds the voices from the entries' `parent` attribute alone — it never
 * reads `<id>` back. None of this can arise from a clean document; §3.4's dirty imports and step 6's
 * reorder can produce all three.
 */
describe('entryWarnings — surviving a round trip through Gnaural', () => {
  it('warns that two adjacent voices sharing an owner will merge', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(
        voice({ id: 0, description: 'a' }, entry(60, 'parent="0"')) +
          voice({ id: 0, description: 'b' }, entry(60, 'parent="0"')),
      ),
    );

    const [warning] = entryWarnings(schedule);
    expect(warning.kind).toBe('gnaural-regroup');
    expect(warning.severity).toBe('warning');
    expect(warning.message).toContain('merge');
    expect(warning.nodes).toEqual([
      { voice: 0, entry: 0 },
      { voice: 1, entry: 0 },
    ]);
  });

  it('does not warn when the same ids are not adjacent', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(
        voice({ id: 0, description: 'a' }, entry(60, 'parent="0"')) +
          voice({ id: 1, description: 'b' }, entry(60, 'parent="1"')) +
          voice({ id: 0, description: 'c' }, entry(60, 'parent="0"')),
      ),
    );

    expect(entryWarnings(schedule)).toEqual([]);
  });

  it('warns that a voice whose entries disagree about their owner will split', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(voice({ id: 0, description: 'a' }, `${entry(60, 'parent="0"')}${entry(60, 'parent="7"')}`)),
    );

    expect(entryWarnings(schedule)[0].message).toContain('splits');
  });

  it('warns that a voice with no entries takes the next voice’s identity with it', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(voice({ id: 0, description: 'ghost' }, '') + voice({ id: 1 }, entry(60))),
    );

    const [warning] = entryWarnings(schedule);
    expect(warning.kind).toBe('gnaural-regroup');
    expect(warning.message).toContain('ghost');
    // Nothing to point at: the whole problem is that it has no node.
    expect(warning.nodes).toEqual([]);
  });

  it('reads the parent the serializer will actually write, not the one the file had', () => {
    // Two voices with different ids and no `parent` attribute anywhere — the serializer derives it
    // from the voice id, so they do not merge.
    const { schedule } = parseScheduleWithWarnings(
      xml(
        voice({ id: 4, description: 'a' }, '<entry duration="60" basefreq="200" beatfreq="10"/>') +
          voice({ id: 9, description: 'b' }, '<entry duration="60" basefreq="200" beatfreq="10"/>'),
      ),
    );

    expect(entryWarnings(schedule)).toEqual([]);
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

  /**
   * The measurement §6.1's thresholds were chosen against, pinned so a later rule cannot quietly
   * start alarming the library: across 354 entries the *only* thing validation may say is that four
   * gamma-band presets exceed 40 Hz, and it must say it as a notice.
   */
  it('raises nothing but a beat notice on four gamma-band presets', () => {
    const offenders = fixtureNames()
      .map((name) => ({ name, warnings: entryWarnings(parseScheduleWithWarnings(loadFixture(name)).schedule) }))
      .filter((result) => result.warnings.length > 0);

    expect(
      offenders.map((result) => [
        result.name,
        result.warnings.map((warning) => [warning.kind, warning.severity, warning.nodes.length]),
      ]),
    ).toEqual([
      ['presets/learning-learning.gnaural', [['beat-above-band', 'notice', 2]]],
      ['presets/stimulation-adhd.gnaural', [['beat-above-band', 'notice', 1]]],
      ['presets/stimulation-highest-mental-activity.gnaural', [['beat-above-band', 'notice', 4]]],
      ['presets/stimulation-hiit.gnaural', [['beat-above-band', 'notice', 8]]],
    ]);
  });
});
