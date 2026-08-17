import { describe, expect, it } from 'vitest';
import { parseScheduleWithWarnings } from './parser';
import { CORPUS_TIMEOUT, fixtureNames, loadFixture, namesIn } from './test-fixtures';
import type { WarningKind } from './warnings';
import { entryWarnings, scheduleWarnings } from './warnings';

// Cases here are built as raw XML rather than fixture files, since a file under `fixtures/` would
// join the bundled library — not appropriate for a deliberately broken schedule.
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
      xml(voice({ type: 0, description: 'tone' }, entry(60)) + voice({ type: 9, description: 'odd' }, entry(60))),
    );

    const warnings = scheduleWarnings(schedule);
    expect(kindsOf(warnings)).toEqual(['unsupported-voice']);
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].message).toContain('odd');
    expect(warnings[0].message).toContain('type 9');
  });

  it('says nothing about the types that are rendered', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(
        voice({ type: 3, description: 'pulse' }, entry(60)) +
          voice({ type: 4, id: 1, description: 'alt' }, entry(60)) +
          voice({ type: 5, id: 2, description: 'drops' }, entry(60)) +
          voice({ type: 6, id: 3, description: 'rain' }, entry(60)),
      ),
    );

    expect(scheduleWarnings(schedule)).toEqual([]);
  });

  it('agrees the verb with the number of voices it is talking about', () => {
    const one = parseScheduleWithWarnings(xml(voice({ type: 0 }, entry(60)) + voice({ type: 9, id: 1, description: 'a' }, entry(60))));
    expect(scheduleWarnings(one.schedule)[0].message).toContain('Voice a uses a voice type');

    const many = parseScheduleWithWarnings(
      xml(
        voice({ type: 0 }, entry(60)) +
          voice({ type: 9, id: 1, description: 'a' }, entry(60)) +
          voice({ type: 10, id: 2, description: 'b' }, entry(60)),
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

  it('lowercases only the leading noun of a mid-sentence subject, never the voice names', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(
        voice({ description: 'Short one' }, entry(60)) +
          voice({ description: 'Every rule', id: 1 }, entry(300)) +
          voice({ description: 'Background noise', id: 2 }, entry(300)),
      ),
    );

    const message = scheduleWarnings(schedule)[0].message;
    expect(message).toContain('Voice Short one ends');
    expect(message).toContain('cuts voices Every rule and Background noise short');
    expect(message).not.toContain('every rule');
    expect(message).not.toContain('background noise');
  });

  it('ignores a difference small enough to be a rounding error', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(voice({}, entry(60)) + voice({}, entry(60.01))),
    );

    expect(scheduleWarnings(schedule)).toEqual([]);
  });

  it('reports a schedule with nothing renderable in it', () => {
    const { schedule } = parseScheduleWithWarnings(xml(voice({ type: 2 }, entry(60))));

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

  it('leaves a degenerate but legitimate value alone', () => {
    // beatfreq=0 is a pure centred tone and volume=0 is a silent lead-in; both are real.
    const { warnings } = parseScheduleWithWarnings(
      xml(voice({}, '<entry duration="60" volume_left="0" volume_right="0" beatfreq="0" basefreq="200"/>')),
    );

    expect(warnings).toEqual([]);
  });
});

describe('entryWarnings — values that are legal and wrong', () => {
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

  it('notices a beat above 40 Hz rather than warning about it', () => {
    expect(entryWarnings(one({ beatfreq: 40 }))).toEqual([]);

    const [warning] = entryWarnings(one({ beatfreq: 70 }));
    expect(warning.kind).toBe('beat-above-band');
    expect(warning.severity).toBe('notice');
    expect(warning.message).toContain('up to 70 Hz');
  });

  it('warns when the beat is wider than its carrier, which puts the right channel at or below zero', () => {
    const warnings = entryWarnings(one({ basefreq: 30, beatfreq: 80 }));
    expect(warnings.map((w) => [w.kind, w.severity])).toEqual([
      ['beat-above-band', 'notice'],
      ['beat-exceeds-base', 'warning'],
    ]);
    expect(warnings[1].message).toContain('-10 Hz');
  });

  it('warns about a volume outside 0–1, from either channel, and quotes the furthest', () => {
    const [warning] = entryWarnings(one({ volume_left: 2.5, volume_right: -0.2 }));
    expect(warning.kind).toBe('volume-out-of-range');
    expect(warning.message).toContain('2.5');

    expect(entryWarnings(one({ volume_right: 1.4 }))[0].kind).toBe('volume-out-of-range');
    expect(entryWarnings(one({ volume_left: 0, volume_right: 1 }))).toEqual([]);
  });

  it('says nothing about a zero duration', () => {
    expect(entryWarnings(one({ duration: 0 }))).toEqual([]);
  });

  it('leaves a noise voice alone — it reads neither frequency', () => {
    expect(entryWarnings(one({ basefreq: 0, beatfreq: 0 }, 1))).toEqual([]);
    expect(entryWarnings(one({ basefreq: 0, beatfreq: 0 }, 5))).toEqual([]);
  });

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

    expect(entryWarnings(schedule)[0].message).toContain('Voice a carries');
  });

  it('says nothing about an ordinary document', () => {
    const { schedule } = parseScheduleWithWarnings(xml(voice({}, entry(60)) + voice({ id: 1, type: 1 }, entry(60))));

    expect(entryWarnings(schedule)).toEqual([]);
  });
});

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
    expect(warning.nodes).toEqual([]);
  });

  it('reads the parent the serializer will actually write, not the one the file had', () => {
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
  it('trips two known header faults and nothing else, so a regression would show', { timeout: CORPUS_TIMEOUT }, () => {
    const offenders = fixtureNames()
      .map((name) => {
        const { schedule, warnings } = parseScheduleWithWarnings(loadFixture(name));
        return { name, kinds: kindsOf([...warnings, ...scheduleWarnings(schedule)]) };
      })
      .filter((result) => result.kinds.length > 0);

    expect(offenders).toEqual([
      // Android removed two voices from Gnaural's file and left the counts behind.
      { name: 'powernap.gnaural', kinds: ['stale-count', 'stale-count'] },
      // Declares 3 entries, has 31.
      { name: 'gnaural/academic-performance-enhancement.gnaural', kinds: ['stale-count'] },
    ]);
  });

  it('raises nothing but a beat notice on four gamma-band presets', () => {
    const offenders = ['powernap.gnaural', 'airplanetravelaid.gnaural', ...namesIn('presets')]
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

  it('raises the frequency rules only where a preset means them, and the regroup hazard once', { timeout: CORPUS_TIMEOUT }, () => {
    const offenders = namesIn('gnaural')
      .map((name) => ({ name, warnings: entryWarnings(parseScheduleWithWarnings(loadFixture(name)).schedule) }))
      .filter((result) => result.warnings.length > 0);

    expect(offenders.map((result) => [result.name, kindsOf(result.warnings)])).toEqual([
      ['gnaural/academic-performance-enhancement.gnaural', ['gnaural-regroup']],
      ['gnaural/breath-duration-increase.gnaural', ['base-too-low', 'beat-exceeds-base']],
      ['gnaural/dane-m-theta.gnaural', ['beat-above-band']],
      ['gnaural/hyperbolic-conciousness-sharpened.gnaural', ['base-too-low', 'beat-above-band', 'beat-exceeds-base']],
      ['gnaural/hyperbolic-conciousness.gnaural', ['base-too-low', 'beat-above-band', 'beat-exceeds-base']],
      ['gnaural/purr.gnaural', ['beat-above-band', 'beat-exceeds-base']],
      ['gnaural/tibetan-bowls.gnaural', ['base-too-low', 'beat-exceeds-base']],
    ]);
  });

  it('does not call Gnaural’s own floating-point zero an inverted channel', () => {
    const { schedule } = parseScheduleWithWarnings(
      xml(voice({}, entry(10, 'volume_left="-2.55352e-19" volume_right="0"'))),
    );

    expect(kindsOf(entryWarnings(schedule))).not.toContain('volume-out-of-range');
  });
});
